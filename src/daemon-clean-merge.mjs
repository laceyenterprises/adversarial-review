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
import {
  MERGE_AGENT_REQUESTED_LABEL,
  OPERATOR_APPROVED_LABEL,
} from './adapters/operator/github-pr-label-controls/index.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const AMA_LIVE_REVIEW_LOOKUP_RETRY_DELAYS_MS = [250, 1_000];

// Deliverable 1 (operator-approval auto-close lane) — the operator labels whose
// explicit, head-scoped application substitutes for hq-dispatched worker
// identity on an un-attributed PR. Order is preference order: `operator-approved`
// is the canonical operator override; `merge-agent-requested` is the documented
// operator-fallback signal. Both are operator-controlled GitHub labels observed
// with an attributable timeline actor (same trust model as the verdict-gate
// `operator-approved` override in `src/ama/eligibility.mjs`).
export const OPERATOR_MERGE_ACCOUNTABILITY_LABELS = Object.freeze([
  OPERATOR_APPROVED_LABEL,
  MERGE_AGENT_REQUESTED_LABEL,
]);

/**
 * Deliverable 1 — resolve the operator accountability that substitutes for an
 * unresolved hq-dispatched worker identity on an un-attributed PR.
 *
 * The daemon clean-merge path fails closed with `worker-identity-unresolved`
 * when a PR carries no launch-provenance (operator/agent infra-fix PRs on
 * `claude-code/*` branches, e.g. agent-os #4022/#4023/#4024). An operator's
 * explicit, head-scoped label IS the accountability that stands in for the
 * missing worker identity: the operator vouches for the merge on the record. It
 * NEVER relaxes any other daemon gate — `attemptDaemonCleanMerge` still requires
 * a settled-success verdict, a zero-finding (strict) review, green required
 * checks, and a live head that matches the validated head, and merges only under
 * the merge lease.
 *
 * HEAD-SCOPING (hard invariant): the label event MUST be pinned to the EXACT
 * head the daemon is about to merge (`mergeHeadSha`). A label applied at an
 * older head is a stale approval and is refused — there is no stale-approval
 * carryover. Attributability + audit provenance (actor + event id + observed-at)
 * are mandatory, mirroring `hasValidScopedOverrideEvidence` in eligibility.mjs.
 *
 * @param {object} args
 * @param {object|null} [args.operatorApprovalEvent]  Legacy label-event for `operator-approved`.
 * @param {object|null} [args.mergeAgentRequestEvent]  Legacy label-event for `merge-agent-requested`.
 * @param {string} args.mergeHeadSha  The exact head the daemon will merge (live head).
 * @returns {{label:string, actor:string, eventId:string, observedAt:string, headSha:string}|null}
 */
export function resolveOperatorMergeAccountability({
  operatorApprovalEvent = null,
  mergeAgentRequestEvent = null,
  mergeHeadSha,
} = {}) {
  const head = String(mergeHeadSha || '').trim();
  if (!head) return null;
  const candidates = [
    { label: OPERATOR_APPROVED_LABEL, event: operatorApprovalEvent },
    { label: MERGE_AGENT_REQUESTED_LABEL, event: mergeAgentRequestEvent },
  ];
  for (const { label, event } of candidates) {
    if (!event || typeof event !== 'object') continue;
    const eventHead = String(
      event.headSha || event.head_sha || event.observedRevisionRef || '',
    ).trim();
    // HEAD-SCOPED: exact-match the head being merged. No stale carryover.
    if (!eventHead || eventHead !== head) continue;
    const actor = String(event.actor || '').trim();
    if (!actor || actor.toLowerCase() === 'unknown') continue;
    const eventId =
      event.id || event.nodeId || event.eventId || event.labelEventId || event.labelEventNodeId || null;
    const observedAt = event.createdAt || event.created_at || event.observedAt || null;
    // Audit provenance is mandatory — an approval with no event id / timestamp
    // cannot be attributed on the record, so it fails closed.
    if (!eventId || !observedAt) continue;
    return {
      label,
      actor,
      eventId: String(eventId),
      observedAt: String(observedAt),
      headSha: head,
    };
  }
  return null;
}

/**
 * Resolve the required-checks array from a `fetchPullRequestRollup` result.
 *
 * `fetchPullRequestRollup` (src/github-api.mjs) normalizes the head commit's
 * status-check rollup onto the `checks` field — NOT `statusCheckRollup`, and the
 * head SHA onto `headRefOid` — NOT `headSha`. Reading the wrong key silently
 * yielded `undefined` → an empty required-checks array → `requiredChecksGreen([])`
 * → a spurious `ci-not-green`, so EVERY zero-finding clean PR fail-closed parked
 * on the in-loop re-fetch. The pre-lease gate only escaped it because it falls
 * back to the watcher `candidate.statusCheckRollup` snapshot (which carries the
 * raw `gh pr view --json statusCheckRollup` array), while the in-loop re-fetch
 * had no such fallback and hardcoded `[]`.
 *
 * Prefer the normalized `checks` field; fall back to `statusCheckRollup` for any
 * snapshot/mock source that still uses the raw name. Returns `null` only when
 * NEITHER field is present, so the caller can apply its own default (e.g. the
 * watcher candidate snapshot) — an EMPTY `checks` array is returned as-is so a
 * live head with no reported checks still reads NOT green (LAC-1559 invariant),
 * never masked by a stale candidate.
 */
function resolveRollupRequiredChecks(rollup) {
  if (Array.isArray(rollup?.checks)) return rollup.checks;
  if (Array.isArray(rollup?.statusCheckRollup)) return rollup.statusCheckRollup;
  return null;
}

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
  operatorApprovalEvent = null,
  mergeAgentRequestEvent = null,
  logger,
  execFileImpl = execFileAsync,
  execGhWithRetryImpl = execGhWithRetry,
  attemptDaemonCleanMergeImpl = attemptDaemonCleanMerge,
  fetchRollupImpl = fetchPullRequestRollup,
  acquireMergeLeaseImpl = acquireMergeLease,
  releaseMergeLeaseImpl = releaseMergeLease,
  readBuildCompletionSignalForPrImpl = readBuildCompletionSignalForPr,
  readHeadAttestationChainForPrImpl = readHeadAttestationChainForPr,
  resolveOperatorMergeAccountabilityImpl = resolveOperatorMergeAccountability,
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
  // Deliverable 1 — operator-approval auto-close lane. When no hq-dispatched
  // worker identity resolves (un-attributed operator/agent infra-fix PRs), an
  // explicit, head-scoped operator label IS the accountability that stands in
  // for worker identity so the clean daemon merge can proceed under an
  // operator-accountable lease instead of parking `worker-identity-unresolved`.
  // Every other gate is UNCHANGED: `attemptDaemonCleanMerge` still requires a
  // settled-success verdict, a strict zero-finding review, green required
  // checks + a mergeable PR, and a live head that matches the validated head.
  // The label must be pinned to the EXACT head being merged (`liveHead`).
  let operatorMergeAccountability = null;
  if (!workerIdentity.ok) {
    operatorMergeAccountability = resolveOperatorMergeAccountabilityImpl({
      operatorApprovalEvent,
      mergeAgentRequestEvent,
      mergeHeadSha: liveHead,
    });
    if (!operatorMergeAccountability) {
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
    logger?.log?.(JSON.stringify({
      schemaVersion: 1,
      event: 'ama.daemon_clean_merge.operator_accountability_substituted',
      repo: repoPath,
      pr: prNumber,
      headSha: liveHead,
      label: operatorMergeAccountability.label,
      actor: operatorMergeAccountability.actor,
      eventId: operatorMergeAccountability.eventId,
      workerIdentityReason: workerIdentity.reason || 'worker-identity-unresolved',
    }));
    logger?.warn?.(
      `[watcher] AMA daemon clean-merge: worker identity unresolved for ${repoPath}#${prNumber}` +
        `@${String(liveHead).slice(0, 12)} (${workerIdentity.reason || 'worker-identity-unresolved'}) ` +
        `but operator '${operatorMergeAccountability.actor}' applied '${operatorMergeAccountability.label}' ` +
        `at this exact head — substituting operator accountability for the clean daemon merge under lease`,
    );
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
      requiredChecks: resolveRollupRequiredChecks(liveRollup)
        ?? (Array.isArray(candidate?.statusCheckRollup) ? candidate.statusCheckRollup : []),
      mergeable: liveRollup?.mergeable ?? mergeabilityForGate?.mergeable,
      mergeStateStatus: liveRollup?.mergeStateStatus ?? mergeabilityForGate?.mergeStateStatus,
      prState: String(liveRollup?.state || candidate?.prState || 'open').toUpperCase(),
    },
    mergeMethod,
    hqRoot,
    auditMetadata: {
      reviewer: reviewStateRow?.reviewer || '',
      riskClass: reviewState?.riskClass || 'unknown',
      // Record which accountability authorized the merge: hq-dispatched worker
      // identity (the normal path) or an explicit head-scoped operator label
      // (Deliverable 1 substitution). The audit doc thus always names WHO the
      // merge authority rests on.
      mergeAccountability: operatorMergeAccountability ? 'operator-approval' : 'worker-identity',
      ...(operatorMergeAccountability ? { operatorApproval: operatorMergeAccountability } : {}),
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
        requiredChecks: resolveRollupRequiredChecks(rollup) ?? [],
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

// Internal helpers exposed for unit tests.
export const __testables__ = Object.freeze({
  resolveRollupRequiredChecks,
});
