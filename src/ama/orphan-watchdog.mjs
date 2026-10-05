// REMORPHAN-01: dispatch admission only. HAM retains all live merge predicates.
import Database from 'better-sqlite3';
import fsExt from 'fs-ext';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readLaunchRequestStatusFromLedger } from '../session-ledger-read-adapter.mjs';
import { getHeadCloserCommitSuppression } from '../head-closer-commit-suppression.mjs';
import { isTerminalLaunchRequestStatus } from './launch-request-status.mjs';
import { listSettledJsonNames } from './dispatch-dir-names.mjs';
import { amaCloserLeaseFilePath, amaCloserPendingLeaseExpiryMs } from './closer-lease.mjs';
import { isTransientGhError } from '../gh-cli.mjs';

// Only immutable terminal ledger results are cached; bound fleet memory usage.
const terminalLaunches = new Map();

const REPAIR_REASONS = new Set(['primary-change-reverted']);
const ALLOWED = new Set(['blocking-findings-present', 'verdict-not-settled-success', 'verdict-not-eligible',
  'ci-not-green', 'pr-not-mergeable', 'stale-review-head', 'non-blocking-findings-present', ...REPAIR_REASONS]);
const REFUND_REASONS = new Set(['active-remediation-job', 'lease-held', 'live-run-in-flight', 'hammer-closer-in-flight',
  'ama-closer-launch-in-progress', 'dispatch-status-unknown', 'dispatch-deferred-transient', 'gate-read-failed',
]);
const text = value => String(value || '').slice(0, 300);
export function orphanDispatchReasonsCovered(reasons, { closerHead = false } = {}) {
  return reasons.length > 0 && reasons.every(reason => ALLOWED.has(reason)
    || (closerHead && reasons.includes('stale-review-head') && reason === 'blocking-findings-unknown'));
}

// Unknown evidence holds dispatch, but is distinct from a proven live owner.
export async function probeOrphanOwnership({ rootDir, repo, prNumber, headSha, reviewStateRow, labels = [],
  readStatusImpl = readLaunchRequestStatusFromLedger, timeoutMs = 5000, signal = null, reservationStartedAt = null,
  now = new Date().toISOString(), processKillImpl = process.kill, logger = console, reservationRecordHead = null }) {
  if (['pending', 'reviewing', 'pending-upstream'].includes(reviewStateRow?.review_status)
    || reviewStateRow?.remediation_pending) return { owned: true };
  const prefix = `${String(repo).replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '-')}-pr-${Number(prNumber)}-`;
  const deadline = Date.now() + (Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000);
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
  // A terminal rekey destination is proof that its historical source heads no
  // longer own the PR, even if their old dispatch/ledger rows were never repaired.
  const superseded = new Set();
  const leaseDir = join(rootDir, 'data', 'ama-closer-leases');
  for (const name of namesFor(leaseDir).filter(name => matchesName(name))) {
    const lease = readRecord(join(leaseDir, name));
    if (!sameRepo(lease?.repo) || Number(lease.prNumber) !== Number(prNumber) || lease.status !== 'terminal') continue;
    for (const head of [lease.rekeyedFromHeadSha, ...(lease.supersededHeads || [])]) if (head) superseded.add(head);
  }
  let mergeRecordSeen = false;
  for (const bucket of ['pending', 'in-progress', 'ama-closer-dispatches', 'merge-agent-dispatches']) {
    const dir = join(rootDir, 'data', 'follow-up-jobs', bucket);
    const queue = ['pending', 'in-progress'].includes(bucket);
    for (const name of namesFor(dir).filter(name => queue || matchesName(name))) {
      if (signal?.aborted || Date.now() >= deadline) { uncertain('ownership-probe-timeout'); return result; }
      const record = readRecord(join(dir, name), !queue || matchesName(name));
      if (!record || !sameRepo(record.repo) || Number(record.prNumber) !== Number(prNumber)) continue;
      if (bucket === 'merge-agent-dispatches') mergeRecordSeen = true;
      if (queue) return { ...result, owned: true };
      if (bucket === 'ama-closer-dispatches' && superseded.has(record.headSha)) continue;
      const launchRequestId = record.launchRequestId || record.dispatchId;
      if (bucket === 'ama-closer-dispatches' && record.state === 'dispatching' && !launchRequestId) {
        if (!record.headSha) { uncertain('missing-closer-head'); continue; }
        const lease = readRecord(amaCloserLeaseFilePath(rootDir, record));
        if (lease === undefined) continue;
        // The dispatcher imports our admission predicate; load its liveness
        // helper lazily to avoid a static module cycle.
        const { isAmaCloserLaunchInProgress } = await import('./dispatch-closer.mjs');
        if (isAmaCloserLaunchInProgress(record, { lease, now, processKillImpl })) result.owned = true;
        else uncertain('interrupted-closer-launch');
        continue;
      }
      if (record.state === 'dispatching' && !launchRequestId) {
        uncertain('dispatching-without-launch-id');
        continue;
      }
      if (!launchRequestId) {
        if (record.state === 'dispatched') uncertain('missing-launch-request-id');
        continue;
      }
      if (result.launchIds.length < 5) result.launchIds.push(text(launchRequestId));
      const cacheKey = JSON.stringify([rootDir, record.hqRoot || '', launchRequestId]);
      let probe = terminalLaunches.get(cacheKey);
      try {
        probe ||= await readStatusImpl({ launchRequestId, rootDir, hqRoot: record.hqRoot, signal,
          // The adapter uses synchronous psql: a Promise timeout alone cannot
          // interrupt it. Bound the subprocess by the remaining probe budget.
          spawnSyncImpl: (cmd, args, options) => spawnSync(cmd, args, {
            ...options, timeout: Math.max(1, Math.min(options?.timeout || 30000, deadline - Date.now())),
          }) });
      } catch { uncertain('ledger-read-failed'); continue; }
      if (!probe?.ok) {
        const stamp = record.lastObservedAt || record.lastAttemptedAt || record.dispatchedAt;
        const age = Date.parse(now) - Date.parse(stamp);
        if (probe?.reason === 'missing-launch-request-row' && record.headSha !== headSha
          && !reservationStartedAt && Number.isFinite(age) && age >= amaCloserPendingLeaseExpiryMs(record.dispatchTimeoutMs)) continue;
        uncertain(probe?.reason || 'ledger-read-failed'); continue;
      }
      if (isTerminalLaunchRequestStatus(probe.row?.status)) {
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
      if (!isTerminalLaunchRequestStatus(probe.row?.status)) result.owned = true;
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
function attemptSummary(retry) {
  return { dispatched: retry?.dispatched === true, reason: text(retry?.reason),
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

async function recoverOrphanWithStore({ rootDir, repo, prNumber, headSha, candidate, labels = [],
  result, reviewStateRow, dispatchJob, dispatchHammer, ticks = 6, maxAttempts = 2,
  hasOwnerImpl = probeOrphanOwnership, pageImpl = defaultPage, requestRereviewImpl = defaultRereview,
  ownershipOperation = fn => fn({}), ownershipTimeoutMs = 5000,
  closerHeadImpl = getHeadCloserCommitSuppression, logger = console, signal = null,
  fsImpl = { existsSync, mkdirSync, openSync, closeSync }, DatabaseImpl = Database, flockSyncImpl = fsExt.flockSync }) {
  if (!headSha) return null;
  // A queued/running background gate has no settled observation yet.
  if (result?.reason === 'ama-closer-dispatch-backgrounded') return null;
  const reasons = result?.reasons || result?.daemonCleanMerge?.reasons || [];
  const primary = ['primary-change-repair-required', 'primary-change-needs-operator'].includes(result?.reason);
  const blocking = reasons.includes('blocking-findings-present');
  const stale = reasons.includes('stale-review-head');
  const stopped = dispatchJob?.remediationStopCode || dispatchJob?.remediationPlan?.stop?.code;
  const round = dispatchJob?.remediationPlan?.currentRound ?? dispatchJob?.remediationPlan?.round ?? dispatchJob?.remediationRound;
  const maxRounds = dispatchJob?.remediationPlan?.maxRounds;
  const validRound = value => (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))
    && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
  const belowMax = validRound(round) && validRound(maxRounds) && Number(round) < Number(maxRounds);
  const stopAllowed = !stopped || ['no-progress', 'remediation-stopped'].includes(stopped);
  const candidateAllowed = Boolean(headSha && candidate?.merged !== true && String(candidate?.prState || '').toLowerCase() === 'open'
    && !candidate?.isDraft && !labels.some(label => ['do-not-merge', 'no-merge-hold', 'merge-agent-skip'].includes(label))
    && result?.amaEnabled && stopAllowed);
  let closerHead = false;
  if (candidateAllowed && stale && reasons.includes('blocking-findings-unknown')) {
    try {
      const proof = await closerHeadImpl({ repoPath: repo, prNumber, headSha, logger });
      closerHead = proof?.suppressed === true && proof.reason === 'closer-commit-trailer';
    } catch (error) {
      if (signal?.aborted) throw error;
      logger?.warn?.(`Orphan identity probe failed: ${text(error.message || error)}`);
      return { outcome: 'ama-pending', amaClosureResult: { ...result, skipMergeAgent: true } };
    }
  }
  const eligible = candidateAllowed && orphanDispatchReasonsCovered(reasons, { closerHead })
    && (primary || stale || (blocking && (stopped === 'no-progress' || stopped === 'remediation-stopped' || belowMax)));
  const primaryUnknown = candidateAllowed && primary && !eligible;
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'orphan-watchdog');
  const key = createHash('sha256').update(`${repo}#${prNumber}`).digest('hex');
  if (!eligible && !primaryUnknown && !fsImpl.existsSync(join(dir, `${key}.db`))) return null;
  fsImpl.mkdirSync(dir, { recursive: true });
  const fd = fsImpl.openSync(join(dir, `${key}.lock`), 'a', 0o600);
  let db;
  try {
    try { flockSyncImpl(fd, 'exnb'); }
    catch (err) { if (['EAGAIN', 'EWOULDBLOCK'].includes(err.code)) return { outcome: 'ama-pending', amaClosureResult: { ...result, skipMergeAgent: true } }; throw err; }
    db = new DatabaseImpl(join(dir, `${key}.db`));
    db.exec('CREATE TABLE IF NOT EXISTS heads (head TEXT PRIMARY KEY, ticks INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, paged INTEGER DEFAULT 0, rereview INTEGER DEFAULT 0, evidence TEXT)');
    const columns = new Set(db.prepare('PRAGMA table_info(heads)').all().map(column => column.name));
    for (const [name, type] of Object.entries({ reserved: 'INTEGER DEFAULT 0', uncertaintyTicks: 'INTEGER DEFAULT 0', uncertaintyPaged: 'INTEGER DEFAULT 0', pageError: 'TEXT' })) {
      if (!columns.has(name)) db.exec(`ALTER TABLE heads ADD COLUMN ${name} ${type}`);
    }
    db.prepare('INSERT OR IGNORE INTO heads(head) VALUES (?)').run(headSha);
    db.prepare('UPDATE heads SET ticks=0, uncertaintyTicks=0 WHERE head<>?').run(headSha);
    const reset = () => { db.prepare('UPDATE heads SET ticks=0, uncertaintyTicks=0 WHERE head=?').run(headSha); return null; };
    const retainedBudget = candidateAllowed && /(?:retry.*exhausted|lifetime.*(?:ceiling|exhausted))/.test(result?.reason || '')
      && db.prepare('SELECT attempts FROM heads WHERE head=?').get(headSha).attempts >= maxAttempts;
    if (!eligible && !primaryUnknown && !retainedBudget) return reset();
    let state = db.prepare('SELECT * FROM heads WHERE head=?').get(headSha);
    const evidence = readEvidence(state.evidence);
    if (state.reserved && !Number.isFinite(Date.parse(evidence?.reservationStartedAt))) {
      throw new Error('orphan watchdog reservation timestamp is malformed');
    }
    const holdExternalError = (error, operation) => {
      logger?.warn?.(`Orphan ${operation} ${isTransientGhError(error) ? 'transient' : 'failed'}: ${text(error.message || error)}`);
      return { outcome: 'ama-pending', amaClosureResult: { ...result, skipMergeAgent: true } };
    };
    if (stale && !closerHead) {
      let proof;
      try { proof = await closerHeadImpl({ repoPath: repo, prNumber, headSha, logger }); }
      catch (error) { return holdExternalError(error, 'identity-probe'); }
      closerHead = proof?.suppressed === true && proof?.reason === 'closer-commit-trailer';
      if (!closerHead && !primary && !blocking) return reset();
    }
    let ownership;
    try {
      const probe = await ownershipOperation(({ signal: childSignal }) => hasOwnerImpl({ rootDir, repo, prNumber,
        headSha, reviewStateRow, labels, signal: childSignal || signal, timeoutMs: ownershipTimeoutMs,
        reservationStartedAt: state.reserved ? evidence?.reservationStartedAt : null,
        reservationRecordHead: state.reserved ? evidence?.recordHeadSha : null, logger }));
      ownership = typeof probe === 'boolean' ? { owned: probe } : probe;
    } catch { ownership = { uncertain: true, reasons: ['ownership-probe-failed'] }; }
    const page = async (event, guard, payload) => {
      try {
        await pageImpl(`SEV1 orphan recovery ${event}: ${repo}#${prNumber}@${headSha}`, {
          event: `ama.orphan_recovery.${event}`, payload: { severity: 'SEV1', repo, prNumber, headSha,
            reasons: reasons.slice(0, 10).map(text), stopCode: text(stopped), round, maxRounds, ...payload } });
        db.prepare(`UPDATE heads SET ${guard}=1, pageError=NULL WHERE head=?`).run(headSha);
      } catch (error) {
        db.prepare('UPDATE heads SET pageError=? WHERE head=?').run(text(error.message || error), headSha);
        logger?.warn?.(`Orphan recovery page enqueue failed: ${text(error.message || error)}`);
      }
    };
    if (state.reserved && ownership?.reservationDispatched) {
      db.prepare('UPDATE heads SET reserved=0, evidence=? WHERE head=?').run(JSON.stringify({ dispatched: true, reason: 'reservation-reconciled' }), headSha);
      state.reserved = 0;
    }
    if (ownership?.owned && !primary) return reset();
    if (ownership?.owned && primary) ownership = { ...ownership, uncertain: true,
      reasons: [...(ownership.reasons || []), 'primary-refusal-owned'] };
    if (primaryUnknown) ownership = { ...ownership, uncertain: true,
      reasons: [...(ownership?.reasons || []), ...(reasons.includes('primary-change-unknown') ? ['primary-change-unknown'] : ['primary-refusal-uncovered'])] };
    if (!ownership || ownership.uncertain) {
      db.prepare('UPDATE heads SET ticks=0, uncertaintyTicks=uncertaintyTicks+1 WHERE head=?').run(headSha);
      state = db.prepare('SELECT * FROM heads WHERE head=?').get(headSha);
      if (state.uncertaintyTicks >= ticks && !state.uncertaintyPaged) {
        await page('ownership-uncertain', 'uncertaintyPaged', { ownershipReasons: ownership?.reasons || [], launchIds: ownership?.launchIds || [] });
      }
      return { outcome: 'ama-pending', amaClosureResult: { ...result, skipMergeAgent: true }, orphan: state };
    }
    db.prepare('UPDATE heads SET uncertaintyTicks=0 WHERE head=?').run(headSha);
    if (state.reserved) {
      // No launch evidence and no owner: interrupted pre-launch reservation.
      db.prepare('UPDATE heads SET attempts=MAX(0,attempts-1), reserved=0, ticks=0, evidence=? WHERE head=?')
        .run(JSON.stringify({ dispatched: false, reason: 'reservation-refunded' }), headSha);
    }
    db.prepare('UPDATE heads SET ticks=ticks+1 WHERE head=?').run(headSha);
    state = db.prepare('SELECT * FROM heads WHERE head=?').get(headSha);
    const pending = { outcome: 'ama-pending', amaClosureResult: { ...result, skipMergeAgent: true }, orphan: state };
    if (state.attempts >= maxAttempts) {
      if (!state.paged) await page('exhausted', 'paged', { attempts: state.attempts, lastAttempt: readEvidence(state.evidence) });
      return { ...pending, outcome: 'recovery-exhausted' };
    }
    if (state.ticks < ticks) return pending;
    const rereview = async () => {
      try { return await requestRereviewImpl({ rootDir, repo, prNumber, targetRevisionRef: headSha,
        reason: `system-orphan-head-review:${headSha}`, logger }); }
      catch (error) { holdExternalError(error, 're-review'); return null; }
    };
    if (closerHead && state.attempts > 0 && !state.rereview && readEvidence(state.evidence)?.dispatched) {
      const review = await rereview();
      if (review?.triggered || review?.reason === 'already-pending') db.prepare('UPDATE heads SET rereview=1, ticks=0 WHERE head=?').run(headSha);
      return pending;
    }
    const reservation = JSON.stringify({ reservationStartedAt: new Date().toISOString(), recordHeadSha: result?.targetRemediationSha || reviewStateRow?.head_sha || headSha, reason: 'reserved-outcome-unknown' });
    db.prepare('UPDATE heads SET attempts=attempts+1, reserved=1, ticks=0, evidence=? WHERE head=?').run(reservation, headSha);
    let retry;
    let refund = false;
    let abortedError;
    let dispatchStarted = false;
    try {
      if (signal?.aborted) throw signal.reason || new Error('orphan recovery aborted');
      dispatchStarted = true;
      retry = await dispatchHammer({ primaryRepair: primary, closerHead });
      refund = !retry?.dispatched && REFUND_REASONS.has(retry?.reason);
    } catch (error) {
      // A thrown error can follow HQ admission. Preserve the reservation until
      // the ownership probe reconciles it against durable launch evidence.
      refund = !dispatchStarted;
      retry = { dispatched: false, reason: text(error.message || error) };
      if (signal?.aborted) abortedError = error;
      if (dispatchStarted) {
        if (abortedError) throw abortedError;
        return pending;
      }
    }
    db.prepare('UPDATE heads SET evidence=?, reserved=0, attempts=MAX(0,attempts-?), ticks=0 WHERE head=?')
      .run(JSON.stringify(attemptSummary(retry)), refund ? 1 : 0, headSha);
    if (abortedError) throw abortedError;
    if (refund) return pending;
    if (retry?.dispatched) return { outcome: 'ama-dispatched', amaClosureResult: retry };
    if (closerHead && !state.rereview) {
      const review = await rereview();
      if (review?.triggered || review?.reason === 'already-pending') db.prepare('UPDATE heads SET rereview=1 WHERE head=?').run(headSha);
    }
    return pending;
  } finally { try { db?.close(); } finally { fsImpl.closeSync(fd); } }
}
