// REMCONFLICT-01 (SEV1, 2026-10-10) — remediation can start on a CONFLICTING PR.
//
// Operator, 2026-10-10: "How is it possible that retriever remediation doesn't
// rebase a dirty PR? What am I supposed to do with PRs that have merge
// conflicts?"
//
// The remediation prompt tells the worker to rebase onto a freshly fetched
// `origin/<base>` and resolve conflicts in-band. But a coding `hq dispatch`
// rebases the PR branch onto trunk while it provisions the workspace, and when
// that rebase conflicts provisioning dies before the worker exists. Since
// agent-os c9bd763ff8 (2026-09-25), `hq dispatch --allow-conflicted-base`
// provisions such a branch at its original tip with a deferred-conflict
// receipt, so the worker that is told to resolve the conflict gets to run.
//
// Just before the hq dispatch, this leaf reads the live PR's mergeability:
//   - MERGEABLE: the dispatch argv is unchanged.
//   - CONFLICTING (or mergeStateStatus DIRTY): the dispatch carries
//     `--allow-conflicted-base` when `hq dispatch --help` names it (the probe
//     agent-os's merge-agent rescue uses for the same flag). When the
//     installed hq lacks it, the job stops `hq-conflicted-base-unsupported`,
//     which an operator can retrigger after upgrading hq.
//   - UNKNOWN, or an unreadable PR: GitHub is still computing. The read is
//     re-sampled over a bounded window (MERGEABILITY_READ_ATTEMPTS). UNKNOWN is
//     never read as clean. A read that never resolves dispatches with the flag
//     when hq supports it: provisioning only defers a rebase that actually
//     conflicts, so the flag is harmless on a clean branch. Without hq support
//     it dispatches exactly as before this change. The claim is not requeued to
//     read again later, because a requeue would drop the one-shot operator
//     override a `retrigger-remediation` claim carries.
//
// Every decision is written to the job as `conflictedBaseGate`.

import { readFollowUpJob, writeFollowUpJob } from './follow-up-jobs.mjs';
import {
  closureGateMergeability,
  isGithubMergeConflict,
  resolveMergeabilityWithSampling,
} from './github-mergeability.mjs';
import { resolveHqBin } from './remediation-hq-dispatch.mjs';

export const CONFLICTED_BASE_FLAG = '--allow-conflicted-base';
export const CONFLICTED_BASE_UNSUPPORTED_STOP_CODE = 'hq-conflicted-base-unsupported';
export const MERGEABILITY_READ_ATTEMPTS = 6;
const MERGEABILITY_READ_DELAY_MS = 5_000;
const PR_READ_TIMEOUT_MS = 15_000;
const HELP_PROBE_TIMEOUT_MS = 10_000;
// A probe answer is reused for this long per hq binary, so an hq upgrade is
// picked up without a daemon restart.
const SUPPORT_CACHE_TTL_MS = 10 * 60_000;
const supportCache = new Map();

export function _resetConflictedBaseSupportCacheForTests() {
  supportCache.clear();
}

function classifyRemediationMergeability(reading) {
  if (isGithubMergeConflict(reading || {})) return 'CONFLICTING';
  // Raw `mergeable=UNKNOWN` stays UNKNOWN whatever mergeStateStatus says.
  return closureGateMergeability(reading || {}) === 'MERGEABLE' ? 'MERGEABLE' : 'UNKNOWN';
}

async function readLivePrMergeability({ repo, prNumber, execFileImpl }) {
  const { stdout } = await execFileImpl('gh', [
    'pr', 'view', String(prNumber), '--repo', repo, '--json', 'mergeable,mergeStateStatus',
  ], { maxBuffer: 1024 * 1024, timeout: PR_READ_TIMEOUT_MS });
  const parsed = JSON.parse(String(stdout || '').trim() || '{}');
  return { mergeable: parsed.mergeable ?? null, mergeStateStatus: parsed.mergeStateStatus ?? null };
}

/**
 * Whether the installed `hq dispatch` accepts `--allow-conflicted-base`.
 * Returns null when the probe itself failed (unknown, not unsupported).
 */
export async function hqDispatchSupportsConflictedBase({ hqBin, execFileImpl, nowMs = Date.now() }) {
  const cached = supportCache.get(hqBin);
  if (cached && nowMs - cached.checkedAtMs < SUPPORT_CACHE_TTL_MS) return cached.supported;
  let output;
  try {
    const result = await execFileImpl(hqBin, ['dispatch', '--help'], {
      maxBuffer: 1024 * 1024,
      timeout: HELP_PROBE_TIMEOUT_MS,
    });
    output = `${result?.stdout || ''}${result?.stderr || ''}`;
  } catch {
    return null;
  }
  const supported = output.includes(CONFLICTED_BASE_FLAG);
  supportCache.set(hqBin, { supported, checkedAtMs: nowMs });
  return supported;
}

/**
 * Decide how the remediation for `job` is dispatched. Pure apart from the two
 * reads (live PR mergeability, `hq dispatch --help`).
 *
 * @returns {Promise<
 *   { action: 'dispatch', allowConflictedBase: boolean, mergeability: string, basis: string, samples: number }
 *   | { action: 'stop', mergeability: string, stopCode: string, stopReason: string }>}
 */
export async function resolveRemediationConflictedBase({
  job,
  env = process.env,
  execFileImpl,
  sleepImpl,
  nowMs = Date.now(),
} = {}) {
  const read = () => readLivePrMergeability({ repo: job.repo, prNumber: job.prNumber, execFileImpl });
  const initial = await read().catch(() => ({}));
  const sampled = await resolveMergeabilityWithSampling(initial, read, {
    classify: classifyRemediationMergeability,
    attempts: MERGEABILITY_READ_ATTEMPTS,
    delayMs: MERGEABILITY_READ_DELAY_MS,
    ...(sleepImpl ? { sleepImpl } : {}),
  });
  const mergeability = sampled.normalized;
  const samples = sampled.samples;
  if (mergeability === 'MERGEABLE') {
    return { action: 'dispatch', allowConflictedBase: false, mergeability, basis: 'mergeable', samples };
  }
  const hqBin = resolveHqBin(env);
  let supported = await hqDispatchSupportsConflictedBase({ hqBin, execFileImpl, nowMs });
  if (supported === null) supported = await hqDispatchSupportsConflictedBase({ hqBin, execFileImpl, nowMs });
  if (supported === true) {
    const basis = mergeability === 'CONFLICTING' ? 'conflicting' : 'mergeability-unresolved';
    return { action: 'dispatch', allowConflictedBase: true, mergeability, basis, samples };
  }
  if (mergeability !== 'CONFLICTING') {
    // The read never resolved and the flag is unavailable: dispatch exactly as
    // before REMCONFLICT-01 rather than strand the job on this gate.
    return { action: 'dispatch', allowConflictedBase: false, mergeability, basis: 'mergeability-unresolved', samples };
  }
  const cause = supported === false
    ? `the installed hq dispatch does not support ${CONFLICTED_BASE_FLAG}`
    : `hq dispatch --help failed, so support for ${CONFLICTED_BASE_FLAG} could not be confirmed`;
  return {
    action: 'stop',
    mergeability,
    stopCode: CONFLICTED_BASE_UNSUPPORTED_STOP_CODE,
    stopReason: `PR has merge conflicts and ${cause} (agent-os c9bd763ff8 or later is required), so worker `
      + 'provisioning would fail its trunk rebase before the remediation worker starts. Check or upgrade hq, '
      + 'then apply retrigger-remediation.',
  };
}

/**
 * The consume-side effects of the decision, run just before the hq dispatch.
 * Returns `{ allowConflictedBase }` to dispatch, or `{ result }` (the consume
 * return value) when the job was stopped instead.
 */
export async function gateRemediationConflictedBase({
  rootDir,
  job,
  jobPath,
  env = process.env,
  execFileImpl,
  sleepImpl,
  now = () => new Date().toISOString(),
  stopJobImpl,
  log = console,
} = {}) {
  const at = now();
  const atMs = Date.parse(at);
  const decision = await resolveRemediationConflictedBase({
    job, env, execFileImpl, sleepImpl, nowMs: Number.isFinite(atMs) ? atMs : Date.now(),
  });
  const tag = `${job.repo}#${job.prNumber}`;
  if (decision.action === 'dispatch') {
    let current = job;
    try {
      current = readFollowUpJob(jobPath);
    } catch {
      // Fall back to the claimed copy; the spawn record re-reads the file.
    }
    writeFollowUpJob(jobPath, {
      ...current,
      conflictedBaseGate: {
        decision: decision.allowConflictedBase ? 'allow-conflicted-base' : 'unchanged-argv',
        basis: decision.basis,
        mergeability: decision.mergeability,
        samples: decision.samples,
        decidedAt: at,
      },
    });
    if (decision.allowConflictedBase) {
      log.log?.(`[follow-up-remediation] ${tag} is ${decision.mergeability}; dispatching with ${CONFLICTED_BASE_FLAG} (${decision.basis})`);
    }
    return { allowConflictedBase: decision.allowConflictedBase };
  }
  log.warn?.(`[follow-up-remediation] ${tag} stopped ${decision.stopCode}: ${decision.stopReason}`);
  const stopped = await stopJobImpl({
    rootDir,
    job,
    jobPath,
    stoppedAt: at,
    stopCode: decision.stopCode,
    stopReason: decision.stopReason,
    sourceStatus: job.status,
    remediationWorker: { state: 'never-spawned', reconciledAt: at },
  });
  return { result: { consumed: false, reason: decision.stopCode, job: stopped.job, jobPath: stopped.jobPath } };
}
