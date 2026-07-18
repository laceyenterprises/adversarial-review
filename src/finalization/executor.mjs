// Merge Authority v2 leased executor (ARC-17; docs/SPEC-merge-authority-v2.md §4).
// The LAST piece of MA-v2: the single finalization worker per subject that turns
// the pure `eligible(...)` decision into an action. It is leased, idempotent, and
// fail-closed, and it SHIPS GATED OFF — until an operator promotes it on shadow
// evidence, `tick()` is inert (the master `enabled` gate; see the promotion
// runbook, docs/finalization-executor-promotion-runbook.md).
//
// Four invariants, all from §4:
//
//  1. ONE executor per subject. Every mutation runs under the app-store lease
//     (`executor-lease-store.mjs`, NOT GitHub labels). A contended subject is
//     deferred, never double-acted.
//  2. RE-FOLD GUARD. Before executing, the executor re-reads the ledger and folds
//     again; if the world moved since the decision was made (the ledger grew, or
//     the subject advanced past the decided revision), it DISCARDS the stale
//     decision and re-decides on the next tick rather than acting on stale state.
//  3. IDEMPOTENT by construction. A finalize whose `finalized` mark is already in
//     the ledger is `skipped`; the merge itself is guarded by `matchHeadCommit`
//     so a stale-revision merge cannot be issued; remediation dispatch dedupes on
//     its idempotency key.
//  4. KILL-SWITCH FAIL-CLOSED. Autonomous execution disabled ⇒ every mutating
//     decision (finalize-now / remediate / close) is intercepted BEFORE any
//     adapter call and written as a fail-closed `escalated` audit event; no
//     merge, close, or dispatch proceeds. (Defense in depth: `eligible()` also
//     gates, but the executor re-checks at the mutation boundary.)
//
// Escalate/halt are recorded terminal marks that do not re-page: an already
// `escalated`/`halted` subject is not re-appended on a later tick (§3).

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { fold } from './ledger-fold.mjs';
import { eligible } from './eligibility.mjs';
import { escalated, finalized, halted, closed, remediationDispatched, resolveSubjectKey } from './ledger-events.mjs';
import {
  resolveMergeSurface,
  checkIdentityAttestation,
  createGithubAdapterMergeSurface,
} from './execution-surfaces.mjs';

// The kill switch intercepts exactly the mutating decisions (finalize-now /
// remediate / close); each of those switch branches re-checks it at the mutation
// boundary before any adapter call (§4). wait/halt/escalate never mutate.
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

function isoAdd(iso, ms) {
  const base = Date.parse(iso ?? '');
  if (!Number.isFinite(base)) throw new TypeError('executor requires a valid observedAt ISO timestamp');
  return new Date(base + ms).toISOString();
}

function outcome(subjectKey, decision, { status, action, observedAt, reason, detail, killSwitch }) {
  /** @type {import('../kernel/contracts.js').FinalizationExecutionOutcome} */
  const record = { subjectKey, decision, status, action, observedAt };
  if (reason != null) record.reason = reason;
  if (detail != null) record.detail = detail;
  if (killSwitch) record.killSwitch = true;
  return record;
}

/**
 * Build the leased executor. All I/O is injected so the executor is unit-testable
 * against in-memory stores and fake surfaces.
 *
 * @param {{
 *   ledgerStore: { read(subject): any[], append(event): any },
 *   leaseStore: { acquire(args): any, release(args): boolean, read(subject): any },
 *   policy?: Partial<import('../kernel/contracts.js').EligibilityPolicy>,
 *   enabled?: boolean,
 *   adjudicateSurface?: object | null,
 *   mergeFallback?: object | null,
 *   identitySurface?: object | null,
 *   remediationSurface?: { dispatch(args): Promise<any> } | null,
 *   closeSurface?: { close(args): Promise<any> } | null,
 *   mergeMethod?: string,
 *   holder?: string,
 *   leaseTtlMs?: number,
 *   generateLeaseId?: () => string,
 * }} config
 */
export function createFinalizationExecutor({
  ledgerStore,
  leaseStore,
  policy,
  enabled = false,
  adjudicateSurface = null,
  mergeFallback = null,
  identitySurface = null,
  remediationSurface = null,
  closeSurface = null,
  mergeMethod = 'squash',
  holder,
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  generateLeaseId = randomUUID,
} = {}) {
  if (!ledgerStore || typeof ledgerStore.read !== 'function') {
    throw new TypeError('createFinalizationExecutor requires a ledgerStore with read/append');
  }
  if (!leaseStore || typeof leaseStore.acquire !== 'function') {
    throw new TypeError('createFinalizationExecutor requires a leaseStore');
  }
  const holderId = holder || `finalization-executor:${process.pid}@${safeHostname()}`;
  // Resolve the merge seam once: ARC-20 adjudicate surface, else the injected
  // local fallback, else a default github-adapter local surface (§4).
  const mergeSurface = resolveMergeSurface({
    adjudicateSurface,
    localFallback: mergeFallback,
    githubAdapter: createGithubAdapterMergeSurface({ mergeMethod }),
  });

  const killSwitchOn = () => normalizedPolicy(policy).autonomousExecutionDisabled === true;

  // Append the fail-closed kill-switch audit row: an `escalated` event naming the
  // intercepted decision. Idempotent + no re-page: skip if already terminal-escalated.
  function recordKillSwitchEscalation(subject, decision, state, at) {
    const reason = `kill switch: ${decision.kind} intercepted (autonomous execution disabled)`;
    if (state?.terminal?.kind !== 'escalated') {
      ledgerStore.append(escalated(subject, { at, reason }));
    }
    return outcome(resolveSubjectKey(subject), decision, {
      status: 'skipped', action: 'escalate', observedAt: at, reason, killSwitch: true,
    });
  }

  async function applyDecision(subject, decision, state, observedAt) {
    const subjectKey = resolveSubjectKey(subject);
    const rev = decision.revisionRef || state.currentRevision || '';

    // A finalized/closed subject is terminal — nothing to do (idempotency §4).
    if (state.finalized || state.terminal?.kind === 'closed') {
      return outcome(subjectKey, decision, {
        status: 'skipped', action: 'none', observedAt,
        reason: state.finalized ? 'already finalized' : 'already closed',
      });
    }

    switch (decision.kind) {
      case 'finalize-now': {
        if (killSwitchOn()) return recordKillSwitchEscalation(subject, decision, state, observedAt);
        // Identity/attestation read-through (ARC-22), fail-closed.
        const idv = await checkIdentityAttestation(identitySurface, { subjectKey, revisionRef: rev, decision });
        if (!idv.ok) {
          if (idv.surfaceError) {
            return outcome(subjectKey, decision, {
              status: 'failed', action: 'merge', observedAt, reason: idv.reason,
            });
          }
          ledgerStore.append(escalated(subject, { at: observedAt, reason: idv.reason }));
          return outcome(subjectKey, decision, {
            status: 'skipped', action: 'escalate', observedAt, reason: idv.reason,
          });
        }
        if (!mergeSurface) {
          const reason = 'no merge surface available (fail-closed)';
          ledgerStore.append(escalated(subject, { at: observedAt, reason }));
          return outcome(subjectKey, decision, { status: 'failed', action: 'merge', observedAt, reason });
        }
        let result;
        try {
          result = await mergeSurface.merge({
            subjectKey, subjectExternalId: subjectKey.subjectExternalId, revisionRef: rev, mergeMethod,
          });
        } catch (err) {
          return outcome(subjectKey, decision, {
            status: 'failed', action: 'merge', observedAt, reason: 'merge surface threw', detail: err?.message || String(err),
          });
        }
        if (!result?.ok) {
          if (result?.reason === 'adapter-unavailable') {
            const reason = 'no merge surface available (fail-closed)';
            ledgerStore.append(escalated(subject, { at: observedAt, reason }));
            return outcome(subjectKey, decision, {
              status: 'skipped', action: 'escalate', observedAt, reason, detail: result?.detail,
            });
          }
          // Fail-closed: a refused/failed merge does NOT append `finalized`; the
          // next tick re-folds and re-decides (a stale-head refusal self-heals).
          return outcome(subjectKey, decision, {
            status: 'failed', action: 'merge', observedAt,
            reason: result?.reason || 'merge failed', detail: result?.detail,
          });
        }
        ledgerStore.append(finalized(subject, {
          at: observedAt, revisionRef: rev, method: mergeMethod,
          sourceRef: mergeSurfaceName(result, mergeSurface),
        }));
        return outcome(subjectKey, decision, { status: 'executed', action: 'merge', observedAt });
      }

      case 'remediate': {
        if (killSwitchOn()) return recordKillSwitchEscalation(subject, decision, state, observedAt);
        const round = Number.isInteger(decision.round) ? decision.round : 1;
        // Same idempotency-key scheme as reviews: a replayed dispatch dedupes at
        // the ledger's partial-unique index (final rounds carry `final:true`).
        const idempotencyKey = `remediate:${rev}:${round}${decision.final ? ':final' : ''}`;
        // Already dispatched this exact round? Skip (idempotent).
        const already = (state.remediation?.dispatched ?? []).some(
          (d) => d.revisionRef === rev && d.round === round,
        );
        if (already) {
          return outcome(subjectKey, decision, {
            status: 'skipped', action: 'dispatch-remediation', observedAt, reason: 'round already dispatched',
          });
        }
        if (remediationSurface && typeof remediationSurface.dispatch === 'function') {
          try {
            await remediationSurface.dispatch({
              subjectKey, revisionRef: rev, round, stageId: decision.stageId, final: decision.final === true, idempotencyKey,
            });
          } catch (err) {
            return outcome(subjectKey, decision, {
              status: 'failed', action: 'dispatch-remediation', observedAt,
              reason: 'remediation surface threw', detail: err?.message || String(err),
            });
          }
        }
        ledgerStore.append(remediationDispatched(subject, {
          at: observedAt, revisionRef: rev, round, idempotencyKey,
          stageId: decision.stageId, final: decision.final === true,
        }));
        return outcome(subjectKey, decision, { status: 'executed', action: 'dispatch-remediation', observedAt });
      }

      case 'close': {
        if (killSwitchOn()) return recordKillSwitchEscalation(subject, decision, state, observedAt);
        if (closeSurface && typeof closeSurface.close === 'function') {
          try {
            await closeSurface.close({ subjectKey, revisionRef: rev, reason: decision.reason });
          } catch (err) {
            return outcome(subjectKey, decision, {
              status: 'failed', action: 'close', observedAt,
              reason: 'close surface threw', detail: err?.message || String(err),
            });
          }
        }
        ledgerStore.append(closed(subject, { at: observedAt, reason: decision.reason || 'operator close' }));
        return outcome(subjectKey, decision, { status: 'executed', action: 'close', observedAt });
      }

      case 'wait':
        // Poll again next tick — no mutation, bounded by the decision's deadline.
        return outcome(subjectKey, decision, {
          status: 'deferred', action: 'none', observedAt, reason: decision.reason, detail: decision.deadline,
        });

      case 'halt': {
        // Records a terminal mark and pages; no re-page once already halted (§3).
        if (state.terminal?.kind !== 'halted') {
          ledgerStore.append(halted(subject, { at: observedAt, reason: decision.reason || 'halt' }));
        }
        return outcome(subjectKey, decision, { status: 'skipped', action: 'halt', observedAt, reason: decision.reason });
      }

      case 'escalate': {
        // Fail-closed / patience-expiry / kill-switch-from-fold. Record once; the
        // terminal `escalated` mark does not re-page on later ticks (§3).
        if (state.terminal?.kind !== 'escalated') {
          ledgerStore.append(escalated(subject, { at: observedAt, reason: decision.reason || 'escalate' }));
        }
        return outcome(subjectKey, decision, {
          status: 'skipped', action: 'escalate', observedAt, reason: decision.reason,
          killSwitch: /kill switch/i.test(decision.reason || ''),
        });
      }

      default:
        return outcome(subjectKey, decision, {
          status: 'skipped', action: 'none', observedAt, reason: `unknown decision kind: ${decision.kind}`,
        });
    }
  }

  /**
   * Execute a PREVIOUSLY-COMPUTED decision, applying the re-fold guard first. The
   * decision is a hint; the ledger is authority. If the world moved since the
   * decision was folded (`basis.eventCount` no longer matches, or the subject
   * advanced past `decision.revisionRef`), the stale decision is DISCARDED and
   * the caller re-decides on the next tick.
   *
   * @param {import('../kernel/contracts.js').EligibilityDecision} decision
   * @param {{ subject: object, observedAt: string, basis?: { eventCount?: number } }} ctx
   */
  async function execute(decision, { subject, observedAt, basis } = {}) {
    const subjectKey = resolveSubjectKey(subject);
    const events = ledgerStore.read(subject);
    const state = fold(events);

    // Re-fold guard (§4): the world moved if the ledger grew since the decision
    // was folded, or the subject advanced past the decided revision.
    const ledgerGrew = basis && Number.isInteger(basis.eventCount) && state.eventCount !== basis.eventCount;
    const revMoved = decision.revisionRef
      && state.currentRevision
      && decision.revisionRef !== state.currentRevision;
    if (ledgerGrew || revMoved) {
      return outcome(subjectKey, decision, {
        status: 'deferred', action: 're-decide', observedAt,
        reason: revMoved
          ? `world moved: subject advanced ${decision.revisionRef} → ${state.currentRevision}; decision discarded`
          : 'world moved: ledger advanced since decision; decision discarded',
      });
    }
    return applyDecision(subject, decision, state, observedAt);
  }

  /**
   * The main loop entry: fold the subject's ledger, decide, and execute — all
   * under the subject's app-store lease. Inert when the executor is gated off.
   *
   * @param {object} subject SubjectRef / SubjectKey
   * @param {{ observedAt: string, leaseId?: string }} opts
   */
  async function tick(subject, { observedAt, leaseId } = {}) {
    const subjectKey = resolveSubjectKey(subject);
    if (!observedAt) throw new TypeError('executor tick requires an observedAt timestamp');

    // MASTER GATE — ships gated off. Inert until an operator promotes it: no
    // lease, no ledger write, no adapter call (the one-flag rollback boundary).
    if (!enabled) {
      return outcome(subjectKey, { kind: 'wait', subjectKey, revisionRef: '', observedAt }, {
        status: 'skipped', action: 'gated-off', observedAt,
        reason: 'finalization executor gated off (promotion pending)',
      });
    }

    const myLeaseId = leaseId || generateLeaseId();
    const deadline = isoAdd(observedAt, leaseTtlMs);
    const currentRev = fold(ledgerStore.read(subject)).currentRevision;
    const acq = leaseStore.acquire({
      subject, holder: holderId, leaseId: myLeaseId, revisionRef: currentRev, now: observedAt, deadline,
    });
    if (!acq.acquired) {
      // Another executor holds the subject — do NOT act (one writer per subject).
      return outcome(subjectKey, { kind: 'wait', subjectKey, revisionRef: currentRev || '', observedAt }, {
        status: 'deferred', action: 'lease-contended', observedAt,
        reason: `subject leased by ${acq.existing?.holder ?? 'another executor'}`,
      });
    }

    try {
      const events = ledgerStore.read(subject);
      const state = fold(events);
      const decision = eligible(state, policy, { observedAt });
      // decide → execute back-to-back under the lease; the re-fold guard still
      // runs (a concurrent observer may have appended between the two reads).
      return await execute(decision, { subject, observedAt, basis: { eventCount: state.eventCount } });
    } finally {
      leaseStore.release({ subject, leaseId: myLeaseId });
    }
  }

  return { tick, execute, holderId, mergeSurfaceName: mergeSurface?.name ?? null };
}

function safeHostname() {
  try {
    return hostname();
  } catch {
    return 'unknown-host';
  }
}

function mergeSurfaceName(result, surface) {
  return result?.via || surface?.name || 'merge-surface';
}

// Local, allocation-free policy normalization for the kill-switch read only. The
// full validation lives in `eligibility.normalizePolicy`; here we only need the
// one boolean, and we must not throw on a config that eligibility already vetted.
function normalizedPolicy(policy) {
  return { autonomousExecutionDisabled: policy?.autonomousExecutionDisabled === true };
}
