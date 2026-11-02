// CLOSURERECOVERYEXEC-01: the executor for an R04 `closure-recovery` next
// action (ownership reconciliation). Before this, nothing ran that actor: the
// background hammer queue refused it as `closure-decision-mismatch`, the inline
// closer refused it as `ownership-unreadable`, and no path enforced its
// deadline, so the PR sat ownerless indefinitely.
//
// Execution reuses the existing custody readers: both the inline route and the
// background queue hand the decision to the closer, whose admission reconciles
// the recorded launch/lease (and dispatches when ownership resolves) before its
// shared-intent gate. This module owns what happens when it does not resolve:
// the closer's named refusal until the decision's deadline, then periodic
// escalation through closure-wait. It owns no merge or dispatch authority.
import { hasClosureRecoveryIntent, reviseClosureNextAction } from './closure-next-action.mjs';
import { observeClosureWait } from './closure-wait.mjs';
import { readAmaCloserLease, isCurrentAmaCloserLease } from './closer-lease.mjs';
import { launchRequestOwned } from './launch-request-status.mjs';
import { deriveNextActionSnapshot, nextAction } from '../pr-next-action.mjs';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const CLOSURE_RECOVERY_WAIT_CLASS = 'closure-recovery-deadline';
export const CLOSURE_RECOVERY_ESCALATED_REASON = 'closure-recovery-ownership-unresolved';
export const CLOSURE_RECOVERY_REPAGE_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 30_000;
// Closer outcomes that leave custody unresolved, besides its intent gate
// echoing the R04 reason itself. Any other refusal names its own owner.
const CUSTODY_REFUSALS = new Set(['existing-dispatch-unknown', 'dispatch-retry-chain-unreadable']);

const text = value => (typeof value === 'string' ? value.trim() : '');

// RECOVERYSTALL-01: refresh BOTH custody observations even when the dispatch
// receipt is absent. A terminal lease's launch is otherwise never probed by
// receipt reconciliation, leaving the adopted R04 snapshot stuck forever.
// This only supplies evidence. Retirement/reacquisition stays under the normal
// per-PR intent lock, followed by all existing dispatch and merge predicates.
export async function refreshClosureRecoveryCustody({ rootDir, repo, prNumber, headSha, shared,
  now = Date.now(), readLaunchImpl, readOptions = {}, logger = console }) {
  if (!hasClosureRecoveryIntent(shared, { repo, prNumber, headSha })) return { shared };
  const deadlineAt = shared.decision.deadline?.at;
  const due = Date.parse(deadlineAt);
  if (Number.isFinite(due) && now < due) return { shared };
  let lease;
  let launchRequestId = null;
  let probe = null;
  let fresh = shared;
  let evidence;
  try {
    lease = readAmaCloserLease(rootDir, { repo, prNumber, headSha });
    const recorded = shared.snapshot.observations?.launches?.value?.closer;
    launchRequestId = lease?.lrqId || (!recorded?.headSha || recorded.headSha === headSha ? recorded?.launchRequestId : null);
    if (launchRequestId) {
      probe = await readLaunchImpl({ ...readOptions, rootDir, launchRequestId, includeRetryChain: true });
      if (!Array.isArray(probe?.retryChain)) probe = { ...probe, retryChainUnreadable: true };
    }
    // A yielding ledger read cannot certify a replacement lease's custody.
    const current = lease ? isCurrentAmaCloserLease(rootDir, lease)
      : readAmaCloserLease(rootDir, { repo, prNumber, headSha }) === null;
    if (!current) throw new Error('lease-changed-during-recovery');
    const owned = launchRequestId ? launchRequestOwned(probe) : false;
    const readable = !launchRequestId || (probe?.ok === true && owned !== null
      && !probe.retryChainUnreadable);
    evidence = { leaseStatus: lease?.status || 'absent', launchRequestId,
      launchStatus: probe?.row?.status || null, owned, readable,
      reason: readable ? owned ? 'live-custody' : 'custody-resolved' : probe?.timedOut || probe?.reason === 'scan-snapshot-timeout'
        ? 'scan-snapshot-timeout' : 'ledger-unreadable' };
    fresh = reviseClosureNextAction(shared, {
      leases: { closer: lease },
      launches: { state: readable ? 'complete' : 'unknown', value: { closer: launchRequestId ? {
        headSha, launchRequestId, probe, outcome: owned === false ? 'no-merge' : null,
        retryable: recorded?.launchRequestId === launchRequestId ? recorded.retryable ?? true : true,
        attempt: recorded?.launchRequestId === launchRequestId ? recorded.attempt ?? null : null,
      } : null } },
    });
    // The original anchor remains fixed; only the observation clock advances.
    const snapshot = deriveNextActionSnapshot({ base: { ...fresh.snapshot, observedAt: new Date(now).toISOString() } });
    fresh = Object.freeze({ snapshot, decision: nextAction(snapshot) });
  } catch (error) {
    evidence = { leaseStatus: lease?.status || 'unknown', launchRequestId, readable: false,
      reason: text(error?.message) === 'lease-changed-during-recovery'
        ? 'lease-changed-during-recovery' : 'custody-read-failed' };
  }
  let attempts;
  try {
    const dir = join(rootDir, 'data', 'ama-closure-waits');
    mkdirSync(dir, { recursive: true });
    const key = createHash('sha256').update(`${repo}#${prNumber}`).digest('hex');
    const db = new Database(join(dir, `${key}.db`));
    try {
      db.exec('CREATE TABLE IF NOT EXISTS recovery_custody (head TEXT PRIMARY KEY, attempts INTEGER NOT NULL, deadline TEXT, observed INTEGER NOT NULL, evidence TEXT NOT NULL)');
      attempts = db.prepare(`INSERT INTO recovery_custody VALUES (?,1,?,?,?)
        ON CONFLICT(head) DO UPDATE SET attempts=attempts+1, deadline=excluded.deadline,
        observed=excluded.observed, evidence=excluded.evidence RETURNING attempts`)
        .get(headSha, deadlineAt || null, now, JSON.stringify(evidence)).attempts;
    } finally { db.close(); }
  } catch (error) {
    // Persistence is diagnostic only; retain the independently refreshed custody.
    logger?.warn?.(`[watcher] closure-recovery diagnostic persistence failed for ${repo}#${prNumber}: ${error.message}`);
    return { shared: fresh };
  }
  return { shared: fresh, closureRecovery: { deadlineAt: deadlineAt || null, attempts,
    lastAttemptAt: new Date(now).toISOString(), lastEvidence: evidence,
    outcome: evidence.readable ? 'reconciled' : 'unresolved' } };
}

function unresolvedEvidence(shared) {
  const { decision, snapshot } = shared;
  const launch = snapshot?.observations?.launches?.value?.closer;
  const lease = snapshot?.observations?.leases?.value?.closer;
  const launchRequestId = text(launch?.launchRequestId) || text(lease?.lrqId) || null;
  const refs = (decision.evidenceRefs || []).filter(ref => /^(lease|launch):/.test(ref));
  return { launchRequestId, unresolved: refs };
}

/**
 * Apply the R04 deadline to a closure result that did not dispatch.
 * @returns {Promise<object>} the result, unchanged unless `shared` is still an
 *   R04 reconciliation for this head and the closer left custody unresolved.
 */
export async function enforceClosureRecoveryDeadline({ rootDir, repo, prNumber, headSha, shared, result,
  now = Date.now(), env = process.env, observeWaitImpl = observeClosureWait, logger = console }) {
  if (!result || result.dispatched || !hasClosureRecoveryIntent(shared, { repo, prNumber, headSha })) return result;
  const decision = shared.decision;
  const dueMs = Date.parse(text(decision.deadline?.at));
  const ageMs = Number.isFinite(dueMs) ? now - dueMs : null;
  const { launchRequestId, unresolved } = unresolvedEvidence(shared);
  const closerReason = text(result.reason) || null;
  const detail = `action=${decision.action} actor=${decision.actor} reason=${decision.reason} head=${headSha} `
    + `deadline=${decision.deadline?.at || 'unknown'} ageMs=${ageMs ?? 'unknown'} `
    + `closer=${closerReason || 'none'} unresolved=${unresolved.join(',') || 'none'} `
    + `attempts=${result.closureRecovery?.attempts ?? 0} evidence=${result.closureRecovery?.lastEvidence?.reason || 'unavailable'}`;
  const closureRecovery = { ...result.closureRecovery, decisionKey: decision.decisionKey, reason: decision.reason,
    deadlineAt: decision.deadline?.at ?? null, ageMs, closerReason, launchRequestId, unresolved, detail };
  // The background closer is reconciling custody now; closure enforces its
  // settled refusal when it applies it on a later pass.
  if (result.backgroundDispatch) return { ...result, closureRecovery: { ...closureRecovery, outcome: 'executing' } };
  // Other named blockers (holds, stops, waits) keep their own owner and reason.
  if (result.boundedWait || !(closerReason === decision.reason || CUSTODY_REFUSALS.has(closerReason))) return result;
  const base = { ...result, dispatched: false, skipMergeAgent: true, recoveryWait: true, closerReason };
  // Before the deadline the closer's own refusal names the wait. A missing
  // deadline cannot defer escalation forever.
  if (ageMs !== null && ageMs < 0) {
    return { ...base, closureRecovery: { ...closureRecovery, outcome: 'pending' },
      retryAfterMs: Math.max(1000, Math.min(RETRY_MS, -ageMs)) };
  }
  const closureBlocker = `${CLOSURE_RECOVERY_ESCALATED_REASON}: ${detail}`;
  let boundedWait = null;
  let pageError = null;
  try {
    // Re-page unresolved custody on a bounded cadence, including across restart.
    boundedWait = await observeWaitImpl({ rootDir, repo, prNumber, headSha, env, now,
      reason: closureBlocker, immediate: true, waitClass: CLOSURE_RECOVERY_WAIT_CLASS,
      repeatAfterMs: CLOSURE_RECOVERY_REPAGE_MS });
  } catch (error) {
    pageError = text(error?.message) || String(error);
    logger?.warn?.(`[watcher] closure-recovery escalation delivery failed for ${repo}#${prNumber}: ${pageError}`);
  }
  return { ...base, reason: CLOSURE_RECOVERY_ESCALATED_REASON, namedReason: CLOSURE_RECOVERY_ESCALATED_REASON,
    closureBlocker, needsOperator: true,
    ...(boundedWait ? { boundedWait } : {}), retryAfterMs: RETRY_MS,
    closureRecovery: { ...closureRecovery, outcome: 'escalated', paged: boundedWait?.notify === true,
      ...(pageError ? { pageError } : {}) } };
}
