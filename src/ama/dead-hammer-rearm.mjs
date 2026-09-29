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
// The re-arm refunds the dead launch's charged dispatch in the retry-cap
// ledger. It uses HAMBG-02's refund (refundHammerRetryDispatch), which has the
// shape HAMGATE-01 gave the merge gate: `attemptCount` down, `retryable` up,
// once per launch, lifetime count untouched. It draws on the same one-refund
// budget per series. There is no second counter: past the budget a death stays
// charged, and the normal cap suppresses and pages.
//
// A failed launch is re-armed only when all of these hold:
//   - the dispatch was a hammer;
//   - the hammer pushed nothing: the PR head is still the head it was
//     dispatched on;
//   - the LRQ's failure class is an infrastructure cause:
//       oauth_access_token_revoked, adapter_boot_crash, or
//       process_exited_after_progress with the provider's API 429. agent-os
//       QUOTA429-01 reclassifies a claude-code worker's 429 stop to
//       worker_killed, so worker_killed with the same 429 counts too.
// The 429 must come from the harness: the LRQ's failure detail, the final
// `result` event of the worker's stream-json stdout, or a provider error line.
// A hammer's stream also carries every file it read, and this repo's own source
// quotes the 429 text, so a 429 inside any other event is not evidence.

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
  readWorkerOutputImpl = readDeadHammerWorkerOutput,
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
    const needsOutput = API_429_DEAD_HAMMER_FAILURE_CLASSES.includes(failureClass);
    const output = needsOutput ? readWorkerOutputImpl({ hqRoot: record.hqRoot || hqRoot, launchRequestId }) : {};
    const { infra, cause } = classifyDeadHammerCause({
      failureClass,
      failureDetail: probe.row?.failure_detail || '',
      stdout: output?.stdout || '',
      stderr: output?.stderr || '',
    });
    if (!infra) return { rearmed: false, reason: 'not-infrastructure', cause, failureClass };
    const refund = refundHammerRetryDispatch(rootDir, { repo, prNumber }, {
      jobKey: record.reviewedSha || jobKey,
      headSha: record.targetRemediationSha || record.headSha,
      launchRequestId,
      now,
    });
    return {
      rearmed: refund.refunded === true,
      reason: refund.refunded === true ? 'refunded' : refund.reason,
      cause,
      failureClass,
      retryable: refund.retryable,
    };
  } catch (err) {
    return { rearmed: false, reason: `rearm-failed:${err?.message || err}` };
  }
}
