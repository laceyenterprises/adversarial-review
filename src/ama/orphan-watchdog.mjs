import { isPreReceiptIntent } from './dispatch-record-read.mjs';
import { isClosureRecoveryDecision } from '../pr-next-action.mjs';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { isOperatorHeld } from '../operator-hold-labels.mjs';
// REMORPHAN-01: dispatch admission only. HAM retains all live merge predicates.
import Database from 'better-sqlite3';
import fsExt from 'fs-ext';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readLaunchRequestStatusFromLedgerAsync } from '../session-ledger-read-adapter.mjs';
import { launchRequestOwned, launchRequestMeaning } from './launch-request-status.mjs';
import { readAmaCloserLease, amaCloserPendingLeaseExpiryMs } from './closer-lease.mjs';
import { listSettledJsonNames } from './dispatch-dir-names.mjs';
import { requestBoundedOrphanReview } from './orphan-review-request.mjs';

// Only immutable terminal ledger results are cached; bound fleet memory usage.
const terminalLaunches = new Map();

export const OWNERLESS_BOUND_MS = 15 * 60 * 1000;
export function ownerlessBoundMs(env = process.env) {
  const value = Number(env.OWNERPROOF_IDLE_MINUTES);
  return loadAwareTimeoutMs(Number.isFinite(value) && value > 0 ? value * 60 * 1000 : OWNERLESS_BOUND_MS, { maxMs: Infinity });
}
const text = value => String(value || '').slice(0, 300);

// This clock is shared with ordinary ownerless recovery. Route observations
// and fresh request timestamps cannot renew an overdue action's ownership.
export function overdueNextAction(nextAction, headSha, now = new Date().toISOString(), env = process.env) {
  const deadline = Date.parse(nextAction?.deadline?.at);
  return nextAction?.head === headSha && Number.isFinite(deadline)
    && Date.parse(now) - deadline >= (isClosureRecoveryDecision(nextAction) ? 0 : ownerlessBoundMs(env));
}

// A proven publication chain can still lack a settled live verdict. Preserve
// that rejection while executing the separately selected, head-bound owner.
export function hasExactHeadReviewDecision(result, headSha) {
  const selected = result?.nextAction;
  return Boolean(headSha && selected?.head === headSha && selected.action === 'review'
    && selected.actor === 'reviewer' && selected.queue?.intent === 'dispatch' && !selected.queue.deferredBy);
}

// Unknown evidence holds dispatch, but is distinct from a proven live owner.
export async function probeOrphanOwnership({ rootDir, repo, prNumber, headSha, reviewStateRow, labels = [],
  readStatusImpl = readLaunchRequestStatusFromLedgerAsync, timeoutMs = loadAwareTimeoutMs(5000), signal = null, reservationStartedAt = null,
  now = new Date().toISOString(), processKillImpl = process.kill, logger = console, reservationRecordHead = null,
  excludeWatcherPid = null, env = process.env, includeOwnerEvidence = false, nextAction = null }) {
  const overdue = overdueNextAction(nextAction, headSha, now, env);
  const alive = (pid, group = false) => {
    if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
    try { processKillImpl(group ? -Number(pid) : Number(pid), 0); return true; } catch (error) { return error.code === 'EPERM'; }
  };
  // A terminal receipt can belong to the previous attempt while its replacement
  // is provisioning. The pending lease owns this head before an LRQ exists.
  // Recovery's post-acquisition probe must exclude its own reservation only.
  const pendingLease = readAmaCloserLease(rootDir, { repo, prNumber, headSha });
  const pendingAge = Date.parse(now) - Date.parse(pendingLease?.acquiredAt);
  const heartbeatAge = Date.parse(now) - Date.parse(pendingLease?.heartbeatAt);
  if (pendingLease?.status === 'dispatched' && Number.isFinite(heartbeatAge)
    && heartbeatAge >= 0 && heartbeatAge < ownerlessBoundMs(env)) {
    return { owned: true, proof: 'fresh-closer-heartbeat',
      ...(includeOwnerEvidence ? { actor: 'hammer', lease: pendingLease } : {}) };
  }
  if (pendingLease?.status === 'pending' && alive(pendingLease.watcherPid)
    && Number(pendingLease.watcherPid) !== Number(excludeWatcherPid)
    && Number.isFinite(pendingAge) && pendingAge >= 0
    && pendingAge < amaCloserPendingLeaseExpiryMs(pendingLease.dispatchTimeoutMs)) {
    return { owned: true, proof: 'pending-closer-lease',
      ...(includeOwnerEvidence ? { actor: 'hammer', lease: pendingLease } : {}) };
  }
  const rowHead = reviewStateRow?.revision_ref || reviewStateRow?.head_sha || reviewStateRow?.reviewer_head_sha;
  if (reviewStateRow?.reviewer_head_sha === headSha && alive(reviewStateRow?.reviewer_pgid, true)) {
    return { owned: true, proof: 'live-reviewer', ...(includeOwnerEvidence ? { actor: 'reviewer' } : {}) };
  }
  const requested = Date.parse(reviewStateRow?.reviewer_started_at || reviewStateRow?.rereview_requested_at || reviewStateRow?.reviewed_at);
  const age = Date.parse(now) - requested;
  if (!overdue && rowHead === headSha && ['pending', 'pending-upstream', 'reviewing'].includes(reviewStateRow?.review_status)
    && Number.isFinite(age) && age >= 0 && age < ownerlessBoundMs(env)) {
    return { owned: true, proof: 'bounded-review-request', ...(includeOwnerEvidence ? { actor: 'reviewer' } : {}) };
  }
  const prefix = `${String(repo).replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '-')}-pr-${Number(prNumber)}-`;
  const deadline = Date.now() + (Number(timeoutMs) > 0 ? Number(timeoutMs) : loadAwareTimeoutMs(5000));
  const result = { owned: false, uncertain: false, reservationDispatched: false, reasons: [], launchIds: [] };
  const uncertain = reason => { result.uncertain = true; if (result.reasons.length < 5) result.reasons.push(text(reason)); };
  const namesFor = dir => {
    let error;
    const names = listSettledJsonNames(dir, { fsImpl: {
      statSync: (...args) => { try { return statSync(...args); } catch (err) { error = err; throw err; } },
      readdirSync: (...args) => { try { return readdirSync(...args); } catch (err) { error = err; throw err; } },
    } });
    if (error && error.code !== 'ENOENT') uncertain('dispatch-directory-unreadable');
    return names;
  };
  const matchesName = name => name.toLowerCase().startsWith(prefix.toLowerCase());
  const sameRepo = value => String(value || '').toLowerCase() === String(repo).toLowerCase();
  const readRecord = (path, relevant = true) => {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (err) {
      if (err.code === 'ENOENT') return null;
      if (relevant) uncertain('dispatch-record-unreadable');
      else logger?.warn?.(`Skipping unreadable foreign dispatch record: ${path}`);
      return undefined;
    }
  };
  // A lease can outlive or lose its dispatch projection. Its LRQ remains the
  // ownership authority; status=dispatched alone proves no live owner.
  const leaseProbes = new Map();
  if (pendingLease?.lrqId && pendingLease.status === 'dispatched') {
    let probe;
    try {
      probe = await readStatusImpl({ launchRequestId: pendingLease.lrqId, rootDir, env,
        signal, includeRetryChain: true, timeoutMs: Math.max(1, deadline - Date.now()) });
    } catch { probe = null; }
    leaseProbes.set(pendingLease.lrqId, probe);
    result.launchIds.push(text(pendingLease.lrqId));
    const owned = launchRequestOwned(probe);
    if (owned === null) uncertain('closer-lease-launch-unreadable');
    else if (owned) {
      result.owned = true;
      if (includeOwnerEvidence) Object.assign(result, { actor: 'hammer',
        launchProbe: probe, launchRequestId: pendingLease.lrqId });
    }
  }
  let mergeRecordSeen = false;
  for (const bucket of ['pending', 'in-progress', 'ama-closer-dispatches', 'merge-agent-dispatches']) {
    const dir = join(rootDir, 'data', 'follow-up-jobs', bucket);
    const queue = ['pending', 'in-progress'].includes(bucket);
    for (const name of namesFor(dir).filter(name => queue || matchesName(name))) {
      if (signal?.aborted || Date.now() >= deadline) { uncertain('ownership-probe-timeout'); return result; }
      const record = readRecord(join(dir, name), !queue || matchesName(name));
      if (!record || !sameRepo(record.repo) || Number(record.prNumber) !== Number(prNumber)) continue;
      if (overdue && ![record.targetRemediationSha, record.headSha, record.reviewedSha].includes(headSha)) continue;
      if (bucket === 'merge-agent-dispatches') mergeRecordSeen = true;
      if (queue && alive(record.remediationWorker?.processId)) return { ...result, owned: true, proof: 'live-remediator', ...(includeOwnerEvidence ? { actor: 'remediator' } : {}) };
      const launchRequestId = record.remediationWorker?.launchRequestId || record.launchRequestId || record.dispatchId;
      if (isPreReceiptIntent(record) && !launchRequestId) {
        uncertain('dispatching-without-launch-id');
        continue;
      }
      if (!launchRequestId) {
        if (record.state === 'dispatched') uncertain('missing-launch-request-id');
        continue;
      }
      if (result.launchIds.length < 5 && !result.launchIds.includes(text(launchRequestId))) result.launchIds.push(text(launchRequestId));
      const cacheKey = JSON.stringify([rootDir, record.hqRoot || '', launchRequestId]);
      let probe = leaseProbes.get(launchRequestId) || (includeOwnerEvidence ? null : terminalLaunches.get(cacheKey));
      try {
        probe ||= await readStatusImpl({ launchRequestId, rootDir, env, hqRoot: record.hqRoot, signal,
          includeRetryChain: true,
          // Retain the remaining SDK ownership-observation budget.
          timeoutMs: Math.max(1, deadline - Date.now()) });
      } catch { uncertain('ledger-read-failed'); continue; }
      if (launchRequestMeaning(record.lastObservedStatus).parked
        && (!probe?.ok || launchRequestOwned(probe) === null || probe.retryChainUnreadable)) {
        if (overdue) uncertain('parked-launch-unreadable');
        else result.owned = true;
        continue;
      }
      if (!probe?.ok) {
        uncertain(probe?.reason || 'ledger-read-failed'); continue;
      }
      const inFlight = launchRequestOwned(probe);
      if (inFlight === false && !includeOwnerEvidence) {
        if (terminalLaunches.size >= 1000) terminalLaunches.delete(terminalLaunches.keys().next().value);
        terminalLaunches.set(cacheKey, probe);
      }
      // Closer receipts truncate milliseconds and later no-dispatch writes can
      // retain their launch id/timestamps. Either receipt stamp proves launch.
      if (reservationStartedAt && (record.headSha === headSha || (reservationRecordHead && [record.headSha, record.targetRemediationSha, record.reviewedSha].includes(reservationRecordHead)))
        && [record.dispatchedAt, record.lastAttemptedAt].some(stamp =>
          Date.parse(stamp) >= Math.floor(Date.parse(reservationStartedAt) / 1000) * 1000)) {
        result.reservationDispatched = true;
      }
      if (inFlight === null) uncertain('missing-launch-status');
      else if (inFlight) {
        result.owned = true;
        if (includeOwnerEvidence) Object.assign(result, {
          actor: queue ? 'remediator' : bucket === 'ama-closer-dispatches' ? 'hammer' : null,
          launchProbe: probe, launchRequestId,
        });
      }
    }
  }
  if (labels.includes('merge-agent-dispatched') && !mergeRecordSeen) uncertain('missing-merge-agent-dispatch-record');
  return result;
}

export async function hasOrphanOwner(options) {
  const ownership = await probeOrphanOwnership(options);
  return ownership.owned || ownership.uncertain;
}

async function defaultPage(text, options) {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('offline tests must inject pageImpl');
  const { deliverAlert } = await import('../alert-delivery.mjs');
  return deliverAlert(text, options);
}
async function defaultRereview(options) {
  const { requestReviewRereview } = await import('../review-state.mjs');
  return requestReviewRereview(options);
}
export function isOrphanRecoveryWait(result) {
  const reason = String(result?.reason || result?.code || result?.message || '');
  const holdReason = result?.holdReason || (reason.startsWith('harness-hold:') ? reason.slice('harness-hold:'.length) : null);
  const transientHarnessHold = ['fleet-quota-status-unavailable', 'fleet-quota-status-unreadable'].includes(holdReason);
  return result?.recoveryWait === true || [
    'ama-coexistence-operation-timeout', 'ama-closer-dispatch-backgrounded',
    'operator-label-classification-pending', 'AMA_COEXISTENCE_OPERATION_TIMEOUT',
    'stacked-base-read-failed',
  ].includes(reason) || transientHarnessHold || result?.code === 'AMA_COEXISTENCE_OPERATION_TIMEOUT' || result?.status === 429 || result?.statusCode === 429
    || /rate[-_ ]limit|secondary limit|HTTP 429/i.test(reason);
}

function attemptSummary(retry) {
  const reason = text(retry?.reason);
  const holdReason = retry?.holdReason || (reason.startsWith('harness-hold:') ? reason.slice('harness-hold:'.length) : null);
  return { dispatched: retry?.dispatched === true, reason,
    ...(holdReason ? { holdReason: text(holdReason) } : {}),
    launchRequestId: text(retry?.launchRequestId || retry?.dispatchId) };
}

function readEvidence(value) {
  if (value == null) return null;
  try {
    const evidence = JSON.parse(value);
    if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) return evidence;
  } catch { /* Invalid evidence must hold the budget, never imply no launch. */ }
  throw new Error('orphan watchdog evidence is malformed');
}

export async function recoverOrphan(options) {
  try { return await recoverOrphanWithStore(options); }
  catch (error) {
    if (options.signal?.aborted) throw error;
    const detail = text(error.message || error);
    const logger = options.logger || console;
    logger?.warn?.(`Orphan recovery failed for ${options.repo}#${options.prNumber}: ${detail}`);
    try {
      await (options.pageImpl || defaultPage)(`SEV1 orphan recovery store error: ${options.repo}#${options.prNumber}`, {
        event: 'ama.orphan_recovery.store-error',
        payload: { severity: 'SEV1', repo: options.repo, prNumber: options.prNumber, headSha: options.headSha, error: detail },
      });
    } catch (pageError) {
      logger?.warn?.(`Orphan recovery error page enqueue failed: ${text(pageError.message || pageError)}`);
    }
    return { outcome: 'ama-pending', amaClosureResult: { ...options.result, skipMergeAgent: true } };
  }
}

async function recoverOrphanWithStore({ rootDir, repo, prNumber, headSha, candidate,
  labels = candidate?.labels || [], result, reviewStateRow, dispatchHammer,
  dispatchRemediation = null,
  hasOwnerImpl = probeOrphanOwnership, pageImpl = defaultPage, requestRereviewImpl = defaultRereview,
  ownershipOperation = fn => fn({}), ownershipTimeoutMs = loadAwareTimeoutMs(5000),
  onOwnershipObserved = null,
  logger = console, signal = null, now = new Date().toISOString(), env = process.env,
  fsImpl = { existsSync, mkdirSync, openSync, closeSync }, DatabaseImpl = Database, flockSyncImpl = fsExt.flockSync }) {
  const held = isOperatorHeld(labels);
  if (!headSha || candidate?.merged === true || String(candidate?.prState || '').toLowerCase() !== 'open'
    || candidate?.isDraft || (held && !isClosureRecoveryDecision(result?.nextAction)) || !result?.amaEnabled) return null;
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'orphan-watchdog');
  const key = createHash('sha256').update(`${repo}#${prNumber}`).digest('hex');
  fsImpl.mkdirSync(dir, { recursive: true });
  const fd = fsImpl.openSync(join(dir, `${key}.lock`), 'a', 0o600);
  let db;
  try {
    try { flockSyncImpl(fd, 'exnb'); }
    catch (err) { if (['EAGAIN', 'EWOULDBLOCK'].includes(err.code)) return { outcome: 'ama-pending', amaClosureResult: { ...result, skipMergeAgent: true } }; throw err; }
    db = new DatabaseImpl(join(dir, `${key}.db`));
    db.exec('CREATE TABLE IF NOT EXISTS heads (head TEXT PRIMARY KEY, ticks INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, paged INTEGER DEFAULT 0, rereview INTEGER DEFAULT 0, evidence TEXT)');
    const columns = new Set(db.prepare('PRAGMA table_info(heads)').all().map(column => column.name));
    for (const [name, type] of Object.entries({ idleSince: 'TEXT', outcomes: "TEXT DEFAULT '[]'", reserved: 'INTEGER DEFAULT 0' })) {
      if (!columns.has(name)) db.exec(`ALTER TABLE heads ADD COLUMN ${name} ${type}`);
    }
    db.exec('CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY CHECK (id=1), idleSince TEXT)');
    db.exec('CREATE TABLE IF NOT EXISTS transition_pages (head TEXT, transition TEXT, PRIMARY KEY(head,transition))');
    db.prepare('INSERT OR IGNORE INTO ownership(id,idleSince) SELECT 1,MIN(idleSince) FROM heads').run();
    db.prepare('INSERT OR IGNORE INTO heads(head) VALUES (?)').run(headSha);
    const state = db.prepare('SELECT * FROM heads WHERE head=?').get(headSha);
    const storedIdleSince = db.prepare('SELECT idleSince FROM ownership WHERE id=1').get().idleSince;
    let selected = result?.nextAction;
    const overdue = overdueNextAction(selected, headSha, now, env);
    const recoveryExpired = overdue && isClosureRecoveryDecision(selected);
    const expiredAction = overdue ? selected : null;
    const idleSince = overdue && (!storedIdleSince || Date.parse(selected.deadline.at) < Date.parse(storedIdleSince))
      ? selected.deadline.at : storedIdleSince;
    let ownership;
    const exactHeadReview = hasExactHeadReviewDecision(result, headSha, reviewStateRow);
    if (isOrphanRecoveryWait(result) && !exactHeadReview && !overdue) {
      // A proof timeout must return at its serial deadline. Observing this
      // wait only needs the clock; no ownership probe or recovery can run.
      ownership = { owned: false };
    } else {
      try {
        const probe = await ownershipOperation(({ signal: childSignal }) => hasOwnerImpl({ rootDir, repo, prNumber,
          headSha, reviewStateRow, labels, now, env, nextAction: selected, includeOwnerEvidence: Boolean(onOwnershipObserved), signal: childSignal || signal, timeoutMs: ownershipTimeoutMs, logger }));
        ownership = typeof probe === 'boolean' ? { owned: probe } : probe;
      } catch { ownership = { uncertain: true }; }
    }
    try { onOwnershipObserved?.(ownership); }
    catch (error) { logger?.warn?.(`Closure ownership observation failed: ${text(error.message)}`); }
    // Observation may replace the shared generation. Never dispatch its predecessor.
    selected = result?.nextAction;
    if (ownership?.owned) {
      db.prepare('UPDATE ownership SET idleSince=NULL WHERE id=1').run();
      db.prepare('UPDATE heads SET idleSince=NULL WHERE head=?').run(headSha);
      return null;
    }
    const pending = { outcome: 'ama-pending', amaClosureResult: { ...result, skipMergeAgent: true } };
    if (idleSince !== storedIdleSince || !idleSince) {
      db.prepare('UPDATE ownership SET idleSince=? WHERE id=1').run(idleSince || now);
    }
    if (!state.idleSince) db.prepare('UPDATE heads SET idleSince=? WHERE head=?').run(idleSince || now, headSha);
    const idleMs = Date.parse(now) - Date.parse(idleSince || now);
    if (!Number.isFinite(idleMs)) throw new Error('orphan watchdog ownership clock is malformed');
    pending.amaClosureResult = { ...pending.amaClosureResult, ownerlessIdleMs: idleMs,
      ownerlessSince: idleSince || now };
    // HAMATTEST-02: execute the shared decision on this pass, before historical
    // hammer ownership or the idle timer can leave an unprovable head actorless.
    // Unknown ownership is a read wait, never permission to race a live closer.
    if (hasExactHeadReviewDecision(result, headSha)) {
      if (ownership?.uncertain && !overdue) return pending;
      if (idleMs < ownerlessBoundMs(env)) {
        const reviewRequest = await requestBoundedOrphanReview({ rootDir, repo, prNumber, headSha,
          reviewStateRow, requestRereviewImpl, logger, db,
          decisionReasons: [result?.nextAction?.reason].filter(Boolean) });
        return { ...pending, amaClosureResult: { ...pending.amaClosureResult, reviewRequest } };
      }
    }
    // The route already owns a proof/read/dispatch wait. Keep the ownerless
    // clock, but neither spend recovery nor page an exhausted launch budget.
    if ((!overdue && isOrphanRecoveryWait(result)) || (!recoveryExpired && idleMs < ownerlessBoundMs(env))) return pending;
    const pageTransition = async missingTransition => {
      const transition = JSON.stringify([expiredAction.row, expiredAction.action, expiredAction.actor, expiredAction.reason]);
      if (!db.prepare('SELECT 1 FROM transition_pages WHERE head=? AND transition=?').get(headSha, transition)) {
        try {
          const receipt = await pageImpl(`SEV1 ownerless PR: ${repo} PR ${prNumber} head ${headSha}; missing transition ${missingTransition}; ${text(expiredAction.row)} ${text(expiredAction.action)} owner=${text(expiredAction.actor)} reason=${text(expiredAction.reason)} deadline=${text(expiredAction.deadline?.at)}; evidence=${(expiredAction.evidenceRefs || []).map(text).join(', ')}`, {
            event: 'ama.orphan_recovery.missing-transition', payload: { severity: 'SEV1', repo, prNumber, headSha,
              missingTransition, nextAction: expiredAction, routeReason: text(result.reason), attempts: state.attempts } });
          if (receipt?.status === 'dead-letter') logger?.warn?.('Orphan transition page is dead-lettered; operator action required');
          if (receipt?.queued !== false || ['delivered', 'dead-letter'].includes(receipt?.status)) {
            db.prepare('INSERT OR IGNORE INTO transition_pages(head,transition) VALUES (?,?)').run(headSha, transition);
          }
        } catch (error) { logger?.warn?.(`Orphan transition page enqueue failed: ${text(error.message || error)}`); }
      }
      return { ...pending, outcome: 'recovery-exhausted' };
    };
    const executor = selected?.action === 'review' && selected.actor === 'reviewer' ? requestRereviewImpl
      : selected?.action === 'hammer' && selected.actor === 'hammer' ? dispatchHammer
      : selected?.action === 'remediate' && selected.actor === 'remediator' ? dispatchRemediation : null;
    const canDispatch = !held && selected?.head === headSha && selected.queue?.intent === 'dispatch'
      && !selected.queue?.deferredBy && typeof executor === 'function';
    if (overdue && (ownership?.uncertain || !canDispatch || isOrphanRecoveryWait(result))) {
      return await pageTransition(ownership?.uncertain ? 'ownership-proof-unavailable'
        : isOrphanRecoveryWait(result) ? 'recovery-wait-expired'
        : held ? 'hold-label' : selected?.queue?.deferredBy || 'selected-owner-executor-unavailable');
    }
    const previous = readEvidence(state.evidence);
    const outcomes = JSON.parse(state.outcomes || '[]');
    if (!Array.isArray(outcomes)) throw new Error('orphan watchdog outcomes are malformed');
    while (outcomes.length < Math.min(state.attempts, 2)) {
      outcomes.push(outcomes.length === state.attempts - 1 && previous
        ? previous : { reason: 'legacy-outcome-unknown' });
    }
    if (state.attempts >= 2) {
      if (overdue) return await pageTransition('recovery-attempts-exhausted');
      if (!state.paged) {
        try {
          const reasons = outcomes.slice(0, 2).map((outcome, index) =>
            `attempt ${index + 1}: ${text(outcome?.reason) || 'outcome-unknown'}${outcome?.holdReason ? ` (${text(outcome.holdReason)})` : ''}`).join('; ');
          const pageResult = await pageImpl(`Ownerless PR recovery exhausted: ${repo} PR ${prNumber} head ${headSha}; ${reasons}`, {
            event: 'ama.orphan_recovery.exhausted', payload: { repo, prNumber, headSha, attempts: state.attempts, outcomes,
              lastAttempt: previous } });
          if (pageResult?.status === 'dead-letter') {
            // Transport retries are exhausted; sink health remains degraded
            // for operator action, but duplicate enqueue cannot revive it.
            logger?.warn?.('Orphan recovery page is dead-lettered; operator action required');
            db.prepare('UPDATE heads SET paged=1 WHERE head=?').run(headSha);
          } else if (pageResult?.queued === false && pageResult?.status !== 'delivered') {
            logger?.warn?.('Orphan recovery page was not queued; retrying next pass');
          } else {
            db.prepare('UPDATE heads SET paged=1 WHERE head=?').run(headSha);
          }
        } catch (error) {
          logger?.warn?.(`Orphan recovery page enqueue failed: ${text(error.message || error)}`);
        }
      }
      return { ...pending, outcome: 'recovery-exhausted' };
    }
    // Reserve and record an unknown outcome before any external call. A crash or
    // unknown outcome spends the attempt. A proven wait below refunds the
    // reservation; a missing receipt never implies that no launch happened.
    // Ownership probes and durable retry reservations remain physical fences.
    // The successor itself is always the generation selected by nextAction.
    if (ownership?.uncertain || !canDispatch) return pending;
    const action = selected.action;
    const attempt = { action, reason: 'outcome-unknown', at: now };
    outcomes.push(attempt);
    db.prepare('UPDATE heads SET attempts=attempts+1, outcomes=?, evidence=? WHERE head=?')
      .run(JSON.stringify(outcomes), JSON.stringify(attempt), headSha);
    logger?.log?.(`[watcher] ownerless-recovery repo=${repo} pr=${prNumber} head=${headSha} idle_minutes=${Math.floor(idleMs / 60000)} last_reason=${text(result?.reason || 'unknown').replace(/\s+/g, '_')} action=${action}`);
    logger?.info?.(`OWNERPROOF-01 executing shared decision ${selected.decisionKey} for ${repo} PR ${prNumber}@${headSha}`);
    let retry;
    try {
      if (signal?.aborted) throw signal.reason || new Error('orphan recovery aborted');
      retry = action === 'review'
        ? await requestBoundedOrphanReview({ rootDir, repo, prNumber, headSha,
          reviewStateRow, requestRereviewImpl, logger, db,
          decisionReasons: [selected.reason].filter(Boolean) })
        : await executor({ ownerProof: true, headSha, nextAction: selected });
      Object.assign(attempt, attemptSummary(retry), { triggered: retry?.triggered === true });
    } catch (error) {
      attempt.reason = text(error.message || error);
      retry = { ...attempt, code: error.code, status: error.status || error.statusCode };
      if (signal?.aborted) throw error;
    } finally {
      if (isOrphanRecoveryWait(retry || attempt)) {
        outcomes.pop();
        db.prepare('UPDATE heads SET attempts=attempts-1, outcomes=?, evidence=? WHERE head=?')
          .run(JSON.stringify(outcomes), JSON.stringify(attempt), headSha);
      } else {
        db.prepare('UPDATE heads SET outcomes=?, evidence=? WHERE head=?')
          .run(JSON.stringify(outcomes), JSON.stringify(attempt), headSha);
      }
    }
    if (action === 'review') {
      return { ...pending, amaClosureResult: { ...pending.amaClosureResult, reviewRequest: retry } };
    }
    if (retry?.dispatched) return { outcome: 'ama-dispatched', amaClosureResult: retry };
    if (recoveryExpired) return await pageTransition(`dispatch-refused:${text(retry?.reason || 'no-receipt')}`);
    return pending;
  } finally { try { db?.close(); } finally { fsImpl.closeSync(fd); } }
}
