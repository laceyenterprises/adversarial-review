// CAPREHEAD-01: bounded branch maintenance; this grants no merge authority.
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsExt from 'fs-ext';
import { writeFileAtomic } from '../atomic-write.mjs';
import { classifyCheckRollup } from '../checks-summary.mjs';
import { probeOrphanOwnership } from './orphan-watchdog.mjs';
import { readWorkerObservation } from '../dispatch-read-client.mjs';
import { readLaunchRequestStatusFromLedgerAsync } from '../session-ledger-read-adapter.mjs';
import { launchRequestOwned } from './launch-request-status.mjs';
import { builderClassFromTitle, KNOWN_TAGS } from '../pr-title-tagging.mjs';
import { resolveHqBin } from '../remediation-hq-dispatch.mjs';
import { resolveHqRoot } from '../hq-root.mjs';
import { OPERATOR_HOLD_LABELS } from '../operator-hold-labels.mjs';
import { parseDispatchJsonOutput, readDispatchReceipt } from '../producer-contracts/dispatch-receipt.mjs';

const execFileAsync = promisify(execFile);
const PROMPT = fileURLToPath(new URL('../../templates/cap-rehead-prompt.md', import.meta.url));
const counts = { dispatched: 0, skipped: 0 };
export function capReheadCounters() { return { ...counts }; }
export function capReheadLedgerPath(rootDir, repo, prNumber) {
  const key = createHash('sha256').update(JSON.stringify([repo.toLowerCase(), Number(prNumber)])).digest('hex');
  return join(rootDir, 'data', 'follow-up-jobs', 'cap-rehead', `${key}.json`);
}

// Closer/remediator queues plus the public workspace inventory cover builders
// and independent PR-update launches. Unknown custody never proves absence.
export async function probeCapReheadOwnership(args, {
  probeImpl = probeOrphanOwnership, readWorkspacesImpl = readWorkerObservation,
  readLaunchImpl = readLaunchRequestStatusFromLedgerAsync,
} = {}) {
  const owner = await probeImpl(args);
  if (!owner || owner.owned !== false || owner.uncertain !== false) return { owned: true };
  if (!args.branch) return { uncertain: true };
  const observed = await readWorkspacesImpl({ observation: 'workspaces' }, args);
  if (!observed?.ok || !Array.isArray(observed.rows)) return { uncertain: true };
  const basename = args.repo.split('/').at(-1);
  for (const row of observed.rows) {
    if (row.present === false && !row.launch_request_id) continue;
    if (typeof row.repo === 'string' && row.repo
      && ![args.repo.toLowerCase(), basename.toLowerCase()].includes(row.repo.toLowerCase())) continue;
    if (typeof row.branch === 'string' && row.branch && row.branch !== args.branch) continue;
    // Old slots without manifests can remain in the inventory. Terminal
    // launch/retry evidence releases them even when their identity is missing.
    if (!row.launch_request_id) return { uncertain: true };
    const launch = await readLaunchImpl({ ...args, launchRequestId: row.launch_request_id, includeRetryChain: true });
    if (launchRequestOwned(launch) === false) continue;
    if (!row.repo || !row.branch || row.manifest_state !== 'available') return { uncertain: true };
    return { owned: true };
  }
  return { owned: false, uncertain: false };
}

export async function maybeDispatchCapRehead({ rootDir, repo, prNumber, headSha, branch, title,
  wake, reviewState, requiredChecks, requiredCheckContexts = [], mergeable,
  lifetimeExhausted = false, cfg = {}, defaultBuilder = 'codex', reviewStateRow,
  env = process.env, signal, logger = console,
  readCurrentPrImpl = null, probeOwnershipImpl = probeCapReheadOwnership, execFileImpl = execFileAsync,
  readLaunchImpl = readLaunchRequestStatusFromLedgerAsync,
  now = () => new Date().toISOString(),
} = {}) {
  if (wake?.outcome !== 'skipped' || !['retry-exhausted', 'hammer-retry-cap-exhausted'].includes(wake.reason)) return null;
  const report = (dispatched, reason, extra = {}) => {
    counts[dispatched ? 'dispatched' : 'skipped']++;
    const result = { dispatched, reason, ...extra };
    try { (logger.info || logger.log)?.call(logger, JSON.stringify({
      event: `ama.cap_rehead.${dispatched ? 'dispatched' : 'skipped'}`, repo, prNumber, headSha, ...result,
    })); } catch { /* Observability cannot change dispatch authority. */ }
    return result;
  };
  if (cfg.capReheadEnabled === false) return report(false, 'disabled');
  if (reviewState?.reviewCycleExhausted !== false) return report(false, 'cycle-exhausted');
  if (!['clean', 'comment-only'].includes(reviewState.verdict)
    || reviewState.blockingFindingState !== 'known' || reviewState.blockingFindingCount !== 0) return report(false, 'blocking-findings');
  if (classifyCheckRollup(requiredChecks, { requiredContexts: requiredCheckContexts }) !== 'SUCCESS') return report(false, 'checks-red');
  if (!['MERGEABLE', 'CONFLICTING'].includes(mergeable)) return report(false, 'mergeability-unknown');
  if (lifetimeExhausted) return report(false, 'lifetime-cap');
  const cap = cfg.capReheadLifetimeCap ?? 2;
  if (!Number.isInteger(cap) || cap < 0) return report(false, 'lifetime-cap');
  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0 || !headSha || !branch) return report(false, 'identity-unavailable');
  const workerClass = builderClassFromTitle(title) || defaultBuilder;
  if (!KNOWN_TAGS.includes(workerClass) && workerClass !== 'codex-corp') return report(false, 'builder-unavailable');
  if (process.env.NODE_TEST_CONTEXT && execFileImpl === execFileAsync) {
    return report(false, 'offline-transport-required');
  }
  const file = capReheadLedgerPath(rootDir, repo, prNumber);
  mkdirSync(join(rootDir, 'data', 'follow-up-jobs', 'cap-rehead'), { recursive: true });
  const fd = openSync(`${file}.lock`, 'a', 0o600);
  try {
    try { fsExt.flockSync(fd, 'exnb'); } catch (error) {
      if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) return report(false, 'live-owner');
      throw error;
    }
    let ledger;
    try { ledger = JSON.parse(readFileSync(file, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') return report(false, 'ledger-unreadable');
      ledger = { schemaVersion: 1, repo, prNumber, attempts: [] };
    }
    if (ledger.schemaVersion !== 1 || ledger.repo !== repo || ledger.prNumber !== prNumber
      || !Array.isArray(ledger.attempts) || ledger.attempts.some(a => typeof a?.headSha !== 'string' || !a.headSha
        || !['reserved', 'dispatched', 'unacknowledged'].includes(a.status)
        || typeof a.workerClass !== 'string' || !Number.isFinite(Date.parse(a.recordedAt))
        || (a.status === 'dispatched' && (typeof a.launchRequestId !== 'string' || !a.launchRequestId)))) return report(false, 'ledger-unreadable');
    if (ledger.attempts.some(a => a.headSha === headSha)) return report(false, 'already-attempted');
    if (ledger.attempts.length >= cap) return report(false, 'lifetime-cap');
    const args = { rootDir, repo, prNumber, headSha, branch, reviewStateRow, env, signal, timeoutMs: 8000 };
    // A previous dispatch owns the PR across head moves. A crash before its
    // acknowledgement stays uncertain; do not infer that no worker launched.
    for (const attempt of ledger.attempts) {
      if (!attempt.launchRequestId) return report(false, 'live-owner');
      const launch = await readLaunchImpl({ ...args, launchRequestId: attempt.launchRequestId, includeRetryChain: true });
      if (launchRequestOwned(launch) !== false) return report(false, 'live-owner');
    }
    let owner;
    try { owner = await probeOwnershipImpl(args); }
    catch { return report(false, 'live-owner'); }
    if (!owner || owner.owned !== false || owner.uncertain !== false) return report(false, 'live-owner');
    // Ownership reads can yield while a builder pushes or an operator holds
    // the PR. Reserve only against a fresh, still eligible current head.
    let live;
    try { live = await readCurrentPrImpl?.({ repo, prNumber, signal, logger }); }
    catch { return report(false, 'preflight-unavailable'); }
    if (!live || !Array.isArray(live.labels)) return report(false, 'preflight-unavailable');
    if (live.headSha !== headSha || live.state !== 'OPEN' || live.isDraft !== false) return report(false, 'head-changed');
    if (live.labels.some(label => [...OPERATOR_HOLD_LABELS, 'duplicate-family-hold',
      'adversarial-merge-blocked'].includes(label))) return report(false, 'operator-hold');
    if (classifyCheckRollup(live.statusCheckRollup, { requiredContexts: requiredCheckContexts }) !== 'SUCCESS') return report(false, 'checks-red');
    if (!['MERGEABLE', 'CONFLICTING'].includes(live.mergeable)) return report(false, 'mergeability-unknown');
    if (signal?.aborted) return report(false, 'aborted');
    const attempt = { headSha, workerClass, status: 'reserved', recordedAt: now() };
    ledger.attempts.push(attempt);
    const save = () => writeFileAtomic(file, JSON.stringify(ledger, null, 2) + '\n');
    save(); // fsynced before calling hq; failures/refusals spend this attempt.
    const idempotencyKey = `cap-rehead:${createHash('sha256').update(JSON.stringify([repo, prNumber, headSha])).digest('hex')}`;
    const argv = ['dispatch', '--idempotency-key', idempotencyKey,
      '--worker-class', workerClass, '--task-kind', 'coding',
      '--completion-shape', 'branch-push', '--required-outcome', 'push',
      '--fleet-retry-policy', 'origin-owned',
      '--project', 'adversarial-merge-authority', '--repo', repo.split('/').at(-1),
      '--pr', String(prNumber), '--ticket', `CAPREHEAD-PR-${prNumber}`,
      '--parent-session', env.HQ_PARENT_SESSION || 'session:unknown:watcher',
      '--prompt', PROMPT, '--root', resolveHqRoot(env)];
    if (live.mergeable === 'CONFLICTING') argv.push('--allow-conflicted-base');
    let receipt;
    try {
      const { stdout } = await execFileImpl(resolveHqBin(env), argv, { env, signal, timeout: 120000, maxBuffer: 1024 * 1024 });
      receipt = readDispatchReceipt(parseDispatchJsonOutput(stdout));
      if (receipt.status.terminal && !receipt.status.succeeded) throw new Error('dispatch refused');
      if (!receipt.launchRequestId) throw new Error('missing dispatch acknowledgement');
    } catch {
      // A failed command may have launched before losing its response. Preserve
      // uncertain custody across heads as well as the permanent head charge.
      attempt.status = 'unacknowledged';
      if (receipt?.launchRequestId) attempt.launchRequestId = receipt.launchRequestId;
      save();
      return report(false, 'dispatch-refused');
    }
    attempt.status = 'dispatched';
    attempt.launchRequestId = receipt.launchRequestId;
    save();
    return report(true, 'retry-exhausted', { workerClass, launchRequestId: receipt.launchRequestId });
  } finally { closeSync(fd); }
}
