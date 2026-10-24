import { readExecutionVerdictsFromLedgerAsync } from '../session-ledger-read-adapter.mjs';
import { validNoWorkVerdict } from '../execution-verdict.mjs';
// CLOSERREUSE-01: re-arm the closer after a hammer that died of an
// infrastructure cause.
//
// A hammer that dies on a provider 429, a revoked OAuth grant or an adapter
// boot crash never ran its close. The per-PR retry cap still charged its
// dispatch, so two such deaths in one review series spent the series' budget
// and parked the PR for an operator, although no hammer had tried to close it.
// agent-os#7349 (SEV2 2026-09-29) lost both of its hammers to Claude 429s and
// stopped at `hammer-retry-cap-exhausted`.
//
// RCV-08: failure classes and provider diagnostics are diagnostic helpers only.
// Refund authority is the persisted RCV-07 ExecutionVerdict.export. Missing or
// work_started evidence stays charged; existing admission health/backoff still
// owns when another dispatch may run. No worker output is read by this consumer.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

import { refundHammerRetryDispatch } from './hammer-retry-cap.mjs';
import { isHammerWorkerClass } from './hammer-worker-class.mjs';

export const INFRA_DEAD_HAMMER_FAILURE_CLASSES = Object.freeze([
  'oauth_access_token_revoked',
  'adapter_boot_crash',
]);
// Failure classes that are an infrastructure death only with a provider 429.
export const API_429_DEAD_HAMMER_FAILURE_CLASSES = Object.freeze([
  'process_exited_after_progress',
  'worker_killed',
]);

const WORKER_OUTPUT_TAIL_BYTES = 64 * 1024;
const LAUNCH_REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Claude Code's error line, e.g. `API Error: Request rejected (429) · This
// request would exceed your account's rate limit.` or `API Error: 429 {...}`.
const PROVIDER_API_429_LINE_RE = /^API Error: (?:Request rejected \()?429\b/m;
// agent-os QUOTA429-01's failure detail for the same stop.
const QUOTA429_FAILURE_DETAIL_RE = /\brate limit rejected the request \(429\)/i;

function lastResultEvent(stdout) {
  const lines = String(stdout || '').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith('{') || !line.includes('"result"')) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'result') return event;
    } catch {
      // A line cut by the tail window, or not JSON: keep looking.
    }
  }
  return null;
}

/**
 * Whether the harness reported a provider API 429.
 *
 * @param {object} evidence
 * @param {string=} evidence.failureDetail  The LRQ's failure detail.
 * @param {string=} evidence.stdout  Tail of the worker's stdout.log.
 * @param {string=} evidence.stderr  Tail of the worker's stderr.log.
 * @returns {boolean}
 */
export function hasProviderApi429({ failureDetail = '', stdout = '', stderr = '' } = {}) {
  const detail = String(failureDetail || '');
  if (QUOTA429_FAILURE_DETAIL_RE.test(detail) || PROVIDER_API_429_LINE_RE.test(detail)) return true;
  const result = lastResultEvent(stdout);
  if (result) {
    return Number(result.api_error_status) === 429 || PROVIDER_API_429_LINE_RE.test(String(result.result || ''));
  }
  return PROVIDER_API_429_LINE_RE.test(String(stdout || '')) || PROVIDER_API_429_LINE_RE.test(String(stderr || ''));
}

/**
 * @returns {{ infra: boolean, cause: string|null }}
 */
export function classifyDeadHammerCause({ failureClass, failureDetail = '', stdout = '', stderr = '' } = {}) {
  const cls = String(failureClass || '').trim();
  if (INFRA_DEAD_HAMMER_FAILURE_CLASSES.includes(cls)) return { infra: true, cause: cls };
  if (API_429_DEAD_HAMMER_FAILURE_CLASSES.includes(cls) && hasProviderApi429({ failureDetail, stdout, stderr })) {
    return { infra: true, cause: `${cls}:api-429` };
  }
  return { infra: false, cause: cls || null };
}

// Only durable harness fields count; quoted worker output is not evidence.
export function unexecutedHammerReason(row = {}) {
  if (row.failure_class === 'codex-tool-host-unavailable'
    || row.failure_detail === 'codex-tool-host-unavailable') return 'codex-tool-host-unavailable';
  if (row.failure_class === 'worker_killed'
    && /\b(?:SIGTERM|SIGKILL)\b/.test(String(row.failure_detail || ''))) {
    return `worker_killed:${/\bSIGKILL\b/.test(String(row.failure_detail || '')) ? 'SIGKILL' : 'SIGTERM'}`;
  }
  return null;
}

function readFileTail(path, maxBytes = WORKER_OUTPUT_TAIL_BYTES) {
  let fd = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// The worker's durable output, where hq dispatch writes it:
// `<hqRoot>/dispatch/<launchRequestId>/{stdout,stderr}.log`.
export function readDeadHammerWorkerOutput({ hqRoot, launchRequestId } = {}) {
  const lrq = String(launchRequestId || '').trim();
  if (!hqRoot || !LAUNCH_REQUEST_ID_RE.test(lrq)) return { stdout: '', stderr: '' };
  const dir = join(String(hqRoot), 'dispatch', lrq);
  return { stdout: readFileTail(join(dir, 'stdout.log')), stderr: readFileTail(join(dir, 'stderr.log')) };
}

/**
 * Refund a failed hammer launch's dispatch when it died of an infrastructure
 * cause and pushed nothing. Best effort: never throws, and any doubt leaves
 * the dispatch charged.
 *
 * @param {object} args
 * @param {object} args.record  The dispatch record of the failed launch.
 * @param {string|null} args.currentHeadSha  The PR's live head.
 * @param {string} args.jobKey  The review series (reviewed head).
 * @param {object|null=} args.launchRequestProbe  The LRQ row the closer already read, if any.
 * @param {Function} args.readLaunchRequestStatusImpl  Ledger read of the LRQ row.
 * @param {Function|null=} args.nextDispatchDiffersImpl  Resolves true when the
 *   re-dispatch would run on a different harness than the dead launch. Gates
 *   the refund for causes a tick does not clear; absent, they stay charged.
 * @returns {Promise<{ rearmed: boolean, reason: string, cause?: string|null,
 *   failureClass?: string|null, retryable?: number }>}
 */
export async function maybeRearmInfraDeadHammer({
  rootDir,
  hqRoot,
  repo,
  prNumber,
  jobKey,
  record,
  workerClass = null,
  currentHeadSha,
  launchRequestProbe = null,
  readLaunchRequestStatusImpl,
  ledgerTarget = null,
  ledgerDbPath = null,
  env = process.env,
  now = null,
  readExecutionVerdictsImpl = readExecutionVerdictsFromLedgerAsync,
} = {}) {
  try {
    const launchRequestId = record?.launchRequestId || null;
    if (!launchRequestId) return { rearmed: false, reason: 'no-launch' };
    if (!isHammerWorkerClass(record?.workerClass || workerClass)) return { rearmed: false, reason: 'not-a-hammer' };
    if (!record?.headSha || !currentHeadSha || record.headSha !== currentHeadSha) {
      return { rearmed: false, reason: 'hammer-pushed-or-head-unknown' };
    }
    const probe = launchRequestProbe?.ok ? launchRequestProbe : await readLaunchRequestStatusImpl({
      launchRequestId,
      ledgerTarget,
      ledgerDbPath,
      env,
      hqRoot,
      rootDir,
    });
    if (!probe?.ok) return { rearmed: false, reason: `launch-request-unreadable:${probe?.reason || 'unknown'}` };
    const failureClass = String(probe.row?.failure_class || '').trim() || null;
    const verdictProbe = await readExecutionVerdictsImpl({ launchRequestId,
      rootDir, hqRoot, ledgerTarget, ledgerDbPath, env });
    const executionVerdict = verdictProbe?.ok ? verdictProbe.verdicts?.find(value =>
      validNoWorkVerdict(value, launchRequestId)) : null;
    if (!executionVerdict) return { rearmed: false, reason: 'execution-not-proven-no-work', failureClass };
    const cause = executionVerdict.reason;
    const refund = refundHammerRetryDispatch(rootDir, { repo, prNumber }, {
      jobKey: record.reviewedSha || jobKey,
      headSha: record.targetRemediationSha || record.headSha,
      launchRequestId, dispatchKey: record.dispatchIdempotencyKey, executionVerdict, now,
    });
    return {
      rearmed: refund.refunded === true,
      reason: refund.refunded === true ? 'refunded' : refund.reason,
      cause,
      failureClass,
      retryable: refund.retryable,
    };
  } catch {
    return { rearmed: false, reason: 'rearm-failed' };
  }
}
