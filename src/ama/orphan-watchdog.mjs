// REMORPHAN-01: dispatch admission only. HAM retains all live merge predicates.
import Database from 'better-sqlite3';
import fsExt from 'fs-ext';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readLaunchRequestStatusFromLedger } from '../session-ledger-read-adapter.mjs';
import { getHeadCloserCommitSuppression } from '../head-closer-commit-suppression.mjs';

const TERMINAL = new Set(['succeeded', 'completed', 'failed', 'cancelled', 'canceled', 'superseded', 'rejected']);
const REPAIR_REASONS = new Set(['primary-change-reverted', 'primary-change-unknown']);
const ALLOWED = new Set(['blocking-findings-present', 'verdict-not-settled-success', 'verdict-not-eligible',
  'ci-not-green', 'pr-not-mergeable', 'stale-review-head', 'non-blocking-findings-present', ...REPAIR_REASONS]);
export function orphanDispatchReasonsCovered(reasons) {
  return reasons.length > 0 && reasons.every(reason => ALLOWED.has(reason));
}

// Scan across heads: an owner that pushed still owns the PR. Missing/unreadable
// ledger evidence is ownership uncertainty, never proof that a launch died.
export async function hasOrphanOwner({ rootDir, repo, prNumber, reviewStateRow, labels = [],
  readStatusImpl = readLaunchRequestStatusFromLedger }) {
  if (['pending', 'reviewing', 'pending-upstream'].includes(reviewStateRow?.review_status)
    || reviewStateRow?.remediation_pending) return true;
  let mergeRecordSeen = false;
  for (const bucket of ['pending', 'in-progress', 'ama-closer-dispatches', 'merge-agent-dispatches']) {
    const dir = join(rootDir, 'data', 'follow-up-jobs', bucket);
    let names;
    try { names = readdirSync(dir); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (record.repo !== repo || Number(record.prNumber) !== Number(prNumber)) continue;
      if (bucket === 'merge-agent-dispatches') mergeRecordSeen = true;
      if (['pending', 'in-progress'].includes(bucket)) return true;
      if (record.state === 'dispatching') return true;
      const launchRequestId = record.launchRequestId || record.dispatchId;
      if (!launchRequestId) {
        if (record.state === 'dispatched') return true;
        continue;
      }
      const probe = await readStatusImpl({ launchRequestId, rootDir });
      if (!probe?.ok || !TERMINAL.has(String(probe.row?.status || '').toLowerCase())) return true;
    }
  }
  return labels.includes('merge-agent-dispatched') && !mergeRecordSeen;
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

export async function recoverOrphan({ rootDir, repo, prNumber, headSha, candidate, labels = [],
  result, reviewStateRow, dispatchJob, dispatchHammer, ticks = 6, maxAttempts = 2,
  hasOwnerImpl = hasOrphanOwner, pageImpl = defaultPage, requestRereviewImpl = defaultRereview,
  closerHeadImpl = getHeadCloserCommitSuppression, logger = console, signal = null }) {
  const reasons = result?.reasons || result?.daemonCleanMerge?.reasons || [];
  const primary = ['primary-change-repair-required', 'primary-change-needs-operator'].includes(result?.reason);
  const blocking = reasons.includes('blocking-findings-present');
  const stale = reasons.includes('stale-review-head');
  const stopped = dispatchJob?.remediationStopCode || dispatchJob?.remediationPlan?.stop?.code;
  const belowMax = Number(dispatchJob?.remediationPlan?.currentRound || dispatchJob?.remediationPlan?.round || dispatchJob?.remediationRound || 0)
    < Number(dispatchJob?.remediationPlan?.maxRounds || 2);
  const candidateAllowed = Boolean(headSha && candidate?.merged !== true && String(candidate?.prState || '').toLowerCase() === 'open'
    && !candidate?.isDraft && !labels.some(label => ['do-not-merge', 'no-merge-hold', 'merge-agent-skip'].includes(label))
    && result?.amaEnabled);
  const eligible = candidateAllowed && orphanDispatchReasonsCovered(reasons)
    && (primary || stale || (blocking && (stopped === 'no-progress' || stopped === 'remediation-stopped' || belowMax)));
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'orphan-watchdog');
  const key = createHash('sha256').update(`${repo}#${prNumber}`).digest('hex');
  if (!eligible && !existsSync(join(dir, `${key}.db`))) return null;
  mkdirSync(dir, { recursive: true });
  const fd = openSync(join(dir, `${key}.lock`), 'a', 0o600);
  let db;
  try {
    try { fsExt.flockSync(fd, 'exnb'); }
    catch (err) { if (['EAGAIN', 'EWOULDBLOCK'].includes(err.code)) return { outcome: 'ama-pending', amaClosureResult: result }; throw err; }
    db = new Database(join(dir, `${key}.db`));
    db.exec('CREATE TABLE IF NOT EXISTS heads (head TEXT PRIMARY KEY, ticks INTEGER DEFAULT 0, attempts INTEGER DEFAULT 0, paged INTEGER DEFAULT 0, rereview INTEGER DEFAULT 0, evidence TEXT)');
    db.prepare('INSERT OR IGNORE INTO heads(head) VALUES (?)').run(headSha);
    // A head change interrupts consecutive observations, but never refunds attempts.
    db.prepare('UPDATE heads SET ticks=0 WHERE head<>?').run(headSha);
    const reset = () => { db.prepare('UPDATE heads SET ticks=0 WHERE head=?').run(headSha); return null; };
    const retainedBudget = candidateAllowed && /(?:retry.*exhausted|lifetime.*(?:ceiling|exhausted))/.test(result?.reason || '')
      && db.prepare('SELECT attempts FROM heads WHERE head=?').get(headSha).attempts >= maxAttempts;
    if (!eligible && !retainedBudget) return reset();
    if (await hasOwnerImpl({ rootDir, repo, prNumber, reviewStateRow, labels })) return reset();
    let closerHead = false;
    if (stale) {
      const proof = await closerHeadImpl({ repoPath: repo, prNumber, headSha, logger });
      closerHead = proof?.suppressed === true && proof?.reason === 'closer-commit-trailer';
      if (!closerHead) return reset();
    }
    db.prepare('UPDATE heads SET ticks=ticks+1 WHERE head=?').run(headSha);
    const state = db.prepare('SELECT * FROM heads WHERE head=?').get(headSha);
    const pending = { outcome: 'ama-pending', amaClosureResult: result, orphan: state };
    if (state.attempts >= maxAttempts) {
      if (!state.paged) {
        const payload = { severity: 'SEV1', repo, prNumber, headSha, reasons, result, reviewStateRow, dispatchJob,
          attempts: state.attempts, lastAttempt: JSON.parse(state.evidence || 'null') };
        await pageImpl(`SEV1 orphan recovery exhausted: ${repo}#${prNumber}@${headSha}`, {
          event: 'ama.orphan_recovery.exhausted', payload });
        db.prepare('UPDATE heads SET paged=1 WHERE head=?').run(headSha);
      }
      return { ...pending, outcome: 'recovery-exhausted' };
    }
    if (state.ticks < ticks) return pending;
    if (closerHead && state.attempts > 0 && !state.rereview && JSON.parse(state.evidence || 'null')?.dispatched) {
      const review = await requestRereviewImpl({ rootDir, repo, prNumber, targetRevisionRef: headSha,
        reason: `system-orphan-head-review:${headSha}`, logger });
      if (review?.triggered || review?.reason === 'already-pending') {
        db.prepare('UPDATE heads SET rereview=1, ticks=0 WHERE head=?').run(headSha);
      }
      return pending;
    }
    // Reserve before dispatch; a crash cannot start an unaccounted third HAM.
    db.prepare('UPDATE heads SET attempts=attempts+1, ticks=0 WHERE head=?').run(headSha);
    let retry;
    try {
      if (signal?.aborted) throw signal.reason || new Error('orphan recovery aborted');
      retry = await dispatchHammer({ primaryRepair: primary, closerHead });
    } catch (error) {
      if (signal?.aborted) throw error;
      retry = { dispatched: false, reason: String(error.message || error) };
    }
    db.prepare('UPDATE heads SET evidence=? WHERE head=?').run(JSON.stringify(retry), headSha);
    if (['active-remediation-job', 'lease-held', 'live-run-in-flight', 'hammer-closer-in-flight',
      'ama-closer-launch-in-progress', 'dispatch-status-unknown', 'dispatch-deferred-transient'].includes(retry?.reason)) {
      db.prepare('UPDATE heads SET attempts=attempts-1 WHERE head=?').run(headSha);
      return pending;
    }
    if (retry?.dispatched) return { outcome: 'ama-dispatched', amaClosureResult: retry };
    if (closerHead && !state.rereview) {
      const review = await requestRereviewImpl({ rootDir, repo, prNumber, targetRevisionRef: headSha,
        reason: `system-orphan-head-review:${headSha}`, logger });
      if (review?.triggered || review?.reason === 'already-pending') {
        db.prepare('UPDATE heads SET rereview=1 WHERE head=?').run(headSha);
      }
    }
    return pending;
  } finally { db?.close(); closeSync(fd); }
}
