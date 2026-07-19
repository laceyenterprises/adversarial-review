import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  attemptDaemonCleanMerge,
  DAEMON_MERGE_SUBPROCESS_TIMEOUT_MS,
  DAEMON_MERGE_DISPOSITION,
} from './ama/daemon-merge.mjs';
import { SETTLED_SUCCESS_VERDICTS } from './ama/eligibility.mjs';
import { acquireMergeLease, releaseMergeLease } from './ama/merge-lease.mjs';
import { readBuildCompletionSignalForPr } from './session-ledger-read-adapter.mjs';
import { fetchPullRequestRollup } from './github-api.mjs';
import { execGhWithRetry } from './gh-cli.mjs';
import {
  resolveDaemonWorkerIdentityForPr,
  readHeadAttestationChainForPr,
} from './daemon-worker-identity.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const AMA_LIVE_REVIEW_LOOKUP_RETRY_DELAYS_MS = [250, 1_000];

// ── MSM-04: daemon-or-hammer merge route ─────────────────────────────────────

function isTransientAmaLiveReviewLookupError(err) {
  const haystack = [
    err?.code,
    err?.name,
    err?.message,
    err?.stderr,
    err?.stdout,
    err?.status,
    err?.statusCode,
    err?.response?.status,
    err?.response?.statusCode,
  ]
    .filter((part) => part !== undefined && part !== null)
    .map((part) => String(part))
    .join('\n')
    .toLowerCase();

  if (!haystack) return false;
  if (/\b(401|403|404|422)\b/.test(haystack)) return false;
  if (/\b(econnreset|etimedout|eai_again|enotfound|econnrefused|socket hang up)\b/.test(haystack)) {
    return true;
  }
  return (
    /\b(429|502|503|504)\b/.test(haystack) ||
    /timed?\s*out|timeout|tls handshake|temporary failure|temporarily unavailable/.test(haystack) ||
    /rate limit|rate-limit|secondary rate limit|abuse detection/.test(haystack)
  );
}

export async function fetchLatestHeadReviewBodiesWithRetry({
  repoPath,
  prNumber,
  headSha,
  authoritativeReviewerLogins,
  fetchLatestHeadReviewBodiesImpl,
  retryDelaysMs = AMA_LIVE_REVIEW_LOOKUP_RETRY_DELAYS_MS,
  logger,
}) {
  const delays = Array.isArray(retryDelaysMs) ? retryDelaysMs : [];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await fetchLatestHeadReviewBodiesImpl(repoPath, prNumber, headSha, {
        authoritativeReviewerLogins,
      });
    } catch (err) {
      const canRetry = attempt < delays.length && isTransientAmaLiveReviewLookupError(err);
      if (!canRetry) throw err;
      const delayMs = Math.max(0, Number(delays[attempt]) || 0);
      logger?.warn?.(
        `[watcher] AMA live-review reconcile transient lookup failure for ` +
          `${repoPath}#${prNumber}@${headSha}; retrying in ${delayMs}ms: ${err?.message || err}`,
      );
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  return [];
}

/**
 * MSM-03 — attempt the daemon clean-path merge for a settled review.
 *
 * Builds the injected GitHub/lease/audit collaborators from the watcher's live
 * `candidate` + `gateSnapshot` and delegates the decision + bounded merge loop
 * to `attemptDaemonCleanMerge`. The daemon uses GitHub required checks +
 * `mergeable` ONLY — it has NO local environment and NEVER runs local CI (the
 * original merge-agent state machine's fatal flaw). The merge lease shares the
 * SAME `(repo, base)` namespace under the submodule `ROOT` that the MSM-01
 * hammer's `bin/merge-lease.mjs` uses, so daemon and hammer cannot double-merge.
 *
 * Returns the `attemptDaemonCleanMerge` result. The caller short-circuits the
 * closer/merge-agent dispatch on any disposition other than `not-taken`.
 */
export async function runDaemonCleanMergeAttempt({
  rootDir = ROOT,
  cfg,
  repoPath,
  prNumber,
  candidate,
  gateSnapshot,
  mergeabilityForGate,
  reviewState,
  reviewStateRow,
  currentPrHeadSha,
  logger,
  execFileImpl = execFileAsync,
  execGhWithRetryImpl = execGhWithRetry,
  attemptDaemonCleanMergeImpl = attemptDaemonCleanMerge,
  fetchRollupImpl = fetchPullRequestRollup,
  acquireMergeLeaseImpl = acquireMergeLease,
  releaseMergeLeaseImpl = releaseMergeLease,
  readBuildCompletionSignalForPrImpl = readBuildCompletionSignalForPr,
  readHeadAttestationChainForPrImpl = readHeadAttestationChainForPr,
  env = process.env,
} = {}) {
  const base = candidate?.baseBranch;
  const validatedHead = gateSnapshot?.reviewedHeadSha || reviewState?.headSha || null;
  const NOT_TAKEN = (reason) => ({ disposition: DAEMON_MERGE_DISPOSITION.NOT_TAKEN, reason });
  if (!base || !validatedHead) {
    return NOT_TAKEN('daemon-inputs-missing');
  }
  let liveRollup = null;
  try {
    liveRollup = await fetchRollupImpl(repoPath, prNumber, { execFileImpl });
  } catch (err) {
    logger?.warn?.(
      `[watcher] AMA daemon clean-merge live-head refresh failed for ${repoPath}#${prNumber}; ` +
        `deferring this tick: ${err?.message || err}`,
    );
    return {
      disposition: DAEMON_MERGE_DISPOSITION.DEFERRED,
      reason: 'live-head-refresh-failed',
      merged: false,
      attempts: 0,
      leaseAcquired: false,
      auditWritten: false,
      error: String(err?.message || err),
    };
  }
  const snapshotHead = String(currentPrHeadSha || candidate?.headSha || '').trim();
  const liveHead = String(liveRollup?.headSha || liveRollup?.headRefOid || '').trim();
  if (!liveHead) {
    return {
      disposition: DAEMON_MERGE_DISPOSITION.DEFERRED,
      reason: 'live-head-unresolved',
      merged: false,
      attempts: 0,
      leaseAcquired: false,
      auditWritten: false,
    };
  }
  if (snapshotHead && liveHead !== snapshotHead) {
    logger?.warn?.(
      `[watcher] AMA daemon clean-merge head moved for ${repoPath}#${prNumber}: ` +
        `snapshot=${snapshotHead.slice(0, 12)} live=${liveHead.slice(0, 12)}; deferring to re-queue`,
    );
    return {
      disposition: DAEMON_MERGE_DISPOSITION.DEFERRED,
      reason: 'pr-head-moved',
      merged: false,
      attempts: 0,
      leaseAcquired: false,
      auditWritten: false,
      snapshotHead,
      liveHead,
    };
  }
  // The MSM-02 predicate clears the verdict gate only for the normalized
  // `settled-success` token; a settled-success review verdict maps to it, and
  // anything else stays raw so the predicate refuses it.
  const settledVerdict = SETTLED_SUCCESS_VERDICTS.has(gateSnapshot?.settledReview?.verdict)
    ? 'settled-success'
    : String(gateSnapshot?.settledReview?.verdict || '');
  const hqRoot = env.HQ_ROOT || env.AGENT_OS_HQ_ROOT || join(homedir(), 'agent-os-hq');
  const mergeMethod = cfg?.mergeMethod === 'merge' ? 'merge' : 'squash';
  const workerIdentity = await resolveDaemonWorkerIdentityForPr({
    repo: repoPath,
    prNumber,
    currentHeadSha: liveHead,
    currentBranch: liveRollup?.headRefName || candidate?.headRefName || candidate?.branch || '',
    hqRoot,
    rootDir,
    env,
    readBuildCompletionSignalForPrImpl,
    readHeadAttestationChainForPrImpl,
    consumeHeadAttestations: cfg?.lha?.consumeAttestations === true,
    logger,
  });
  if (!workerIdentity.ok) {
    return {
      disposition: DAEMON_MERGE_DISPOSITION.FAILED_CLOSED,
      reason: 'worker-identity-unresolved',
      merged: false,
      attempts: 0,
      leaseAcquired: false,
      auditWritten: false,
      reasons: [workerIdentity.reason || 'worker-identity-unresolved'],
      workerIdentity,
    };
  }
  return attemptDaemonCleanMergeImpl({
    repo: repoPath,
    prNumber,
    base,
    validatedHead,
    verdict: settledVerdict,
    reviewState: {
      blockingFindingCount: reviewState?.blockingFindingCount,
      blockingFindingState: reviewState?.blockingFindingState,
      nonBlockingFindingCount: reviewState?.nonBlockingFindingCount,
      nonBlockingFindingState: reviewState?.nonBlockingFindingState,
    },
    // Initial (pre-lease) GitHub gate snapshot from the live fetch this tick.
    liveGate: {
      candidateHead: liveHead,
      requiredChecks: Array.isArray(liveRollup?.statusCheckRollup)
        ? liveRollup.statusCheckRollup
        : (Array.isArray(candidate?.statusCheckRollup) ? candidate.statusCheckRollup : []),
      mergeable: liveRollup?.mergeable ?? mergeabilityForGate?.mergeable,
      mergeStateStatus: liveRollup?.mergeStateStatus ?? mergeabilityForGate?.mergeStateStatus,
      prState: String(liveRollup?.state || candidate?.prState || 'open').toUpperCase(),
    },
    mergeMethod,
    hqRoot,
    auditMetadata: {
      reviewer: reviewStateRow?.reviewer || '',
      riskClass: reviewState?.riskClass || 'unknown',
    },
    workerIdentity,
    flags: {
      autonomousMergeExecutionEnabled: cfg?.autonomousMergeExecutionEnabled !== false,
      strictMode: cfg?.strictMode !== false,
    },
    // Re-read the LIVE head + gate before each merge attempt (retry included).
    fetchLiveGateImpl: async () => {
      const rollup = await fetchRollupImpl(repoPath, prNumber, { execFileImpl });
      const state = String(rollup?.state || '');
      return {
        candidateHead: rollup?.headSha || rollup?.headRefOid || '',
        requiredChecks: Array.isArray(rollup?.statusCheckRollup) ? rollup.statusCheckRollup : [],
        mergeable: rollup?.mergeable,
        mergeStateStatus: rollup?.mergeStateStatus,
        prState: state,
        merged: state.toUpperCase() === 'MERGED',
      };
    },
    // Non-blocking single-shot acquire: contention defers this tick (the watcher
    // must not block its poll loop waiting on a lease).
    acquireLeaseImpl: () => {
      const res = acquireMergeLeaseImpl({
        rootDir,
        repo: repoPath,
        base,
        holderPr: prNumber,
        holderHead: validatedHead,
        holderPid: process.pid,
        holderHost: hostname(),
        now: new Date().toISOString(),
      });
      return { acquired: Boolean(res?.acquired), lease: res?.lease, existingLease: res?.existingLease };
    },
    releaseLeaseImpl: (lease) => {
      releaseMergeLeaseImpl({
        rootDir,
        repo: lease.repo,
        base: lease.base,
        leaseId: lease.leaseId,
        holderPr: lease.holderPr,
        holderHead: lease.holderHead,
        acquiredAt: lease.acquiredAt,
      });
    },
    // Click the button: `gh pr merge --squash --match-head-commit <head>`.
    runMergeImpl: async ({ repo, prNumber: pr, head, mergeMethod: method }) => {
      const methodFlag = method === 'merge' ? '--merge' : '--squash';
      try {
        const { stdout, stderr } = await execGhWithRetryImpl({
          execFileImpl,
          args: ['pr', 'merge', String(pr), '--repo', repo, methodFlag, '--match-head-commit', head],
          timeoutMs: DAEMON_MERGE_SUBPROCESS_TIMEOUT_MS,
        });
        return { exitCode: 0, stdout: String(stdout || ''), stderr: String(stderr || '') };
      } catch (err) {
        return {
          exitCode: Number.isInteger(err?.code) ? err.code : 1,
          stdout: String(err?.stdout || ''),
          stderr: String(err?.stderr || err?.message || ''),
        };
      }
    },
    logger,
  });
}
