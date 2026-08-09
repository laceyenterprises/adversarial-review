import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  attemptDaemonCleanMerge,
  DAEMON_MERGE_SUBPROCESS_TIMEOUT_MS,
  DAEMON_MERGE_DISPOSITION,
  isDaemonMergeReviewAllowed,
  resolveDaemonMergeUncleanReason,
} from './ama/daemon-merge.mjs';
import { SETTLED_SUCCESS_VERDICTS } from './ama/eligibility.mjs';
import { readAmaAuditEntry } from './ama/audit.mjs';
import { getHeadCloserCommitSuppression } from './head-closer-commit-suppression.mjs';
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
import { resolveGateStatusContext } from './adversarial-gate-context.mjs';

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

export function resolveAutonomousCloserCommitAccountability({
  enabled = true,
  reviewedHeadSha,
  mergeHeadSha,
  suppression = null,
  workerIdentityReason = 'worker-identity-unresolved',
} = {}) {
  if (enabled === false) return null;
  const reviewedHead = String(reviewedHeadSha || '').trim();
  const mergeHead = String(mergeHeadSha || '').trim();
  if (!reviewedHead || !mergeHead || reviewedHead === mergeHead) return null;
  if (suppression?.suppressed !== true) return null;
  return {
    label: 'autonomous-closer-commit-clean',
    actor: 'merge-agent',
    eventId: `closer-commit-clean:${mergeHead}`,
    observedAt: new Date().toISOString(),
    headSha: mergeHead,
    reviewedHeadSha: reviewedHead,
    reason: suppression.reason || 'closer-commit-identity',
    matched: suppression.matched || null,
    workerIdentityReason,
  };
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
 * Does a single durable AMA audit attempt prove that an entitled hammer
 * validated a HAM terminal-remediation for `headSha` under the merge lease?
 *
 * The hammer writes its pre-merge / terminal audit attempts (see
 * `templates/hammer-prompt.md`) only AFTER `bin/ama-check.mjs` validated the
 * exact post-remediation head: the attempt carries the
 * `ham_terminal_remediation_validated` head-match marker, its embedded
 * eligibility trace shows `hamTerminalRemediation.ok`, and `validatedHead` is
 * this head. The check is deliberately CI-INDEPENDENT — the GitHub required-check
 * gate is re-verified LIVE by `attemptDaemonCleanMerge` before any merge — so it
 * still recognizes the attempt the hammer recorded when it gave up waiting for
 * pending required CI.
 */
function isHamTerminalRemediationValidatedAttempt(attempt, headSha) {
  if (!attempt || typeof attempt !== 'object') return false;
  if (attempt.headMatchEvidence !== 'ham_terminal_remediation_validated') return false;
  if (String(attempt.validatedHead || '') !== String(headSha || '')) return false;
  return attempt.eligibilityTrace?.trace?.hamTerminalRemediation?.ok === true;
}

/**
 * Has an entitled hammer already remediated the findings on `headSha` and
 * validated this exact head under the merge lease, per the durable AMA audit?
 *
 * This is the trust anchor for the daemon re-merge of a remediated (non-clean)
 * PR whose live hammer exited before GitHub required checks went green: the
 * hammer did the expensive remediation + provenance validation ONCE and recorded
 * it; the cheap daemon lands the PR on a later tick once CI settles, with no live
 * worker and without burning the per-head hammer retry cap. Fails closed (returns
 * false) on any read error or missing marker, so the caller simply falls through
 * to the existing capped-hammer path.
 *
 * `headSha` is a real, required argument of `readAmaAuditEntry(hqRoot, repo,
 * prNumber, headSha)` — AMA audit entries are stored PER HEAD, not per PR
 * (`amaAuditFilePath` builds `<repo>-pr-<n>-<headSha>.json` and throws when
 * `headSha` is missing), so the read is already scoped to this exact head. The
 * per-attempt `validatedHead` re-check below is belt-and-braces against an
 * injected/relocated reader that is not head-scoped.
 */
export function headHasValidatedHamTerminalRemediation({
  hqRoot,
  repo,
  prNumber,
  headSha,
  readAmaAuditEntryImpl = readAmaAuditEntry,
} = {}) {
  if (!hqRoot || !headSha) return false;
  let entry;
  try {
    entry = readAmaAuditEntryImpl(hqRoot, repo, prNumber, headSha);
  } catch {
    return false;
  }
  const attempts = Array.isArray(entry?.attempts) ? entry.attempts : [];
  return attempts.some((attempt) => isHamTerminalRemediationValidatedAttempt(attempt, headSha));
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
  readAmaAuditEntryImpl = readAmaAuditEntry,
  headHasValidatedHamTerminalRemediationImpl = headHasValidatedHamTerminalRemediation,
  resolveHeadCloserCommitSuppressionImpl = getHeadCloserCommitSuppression,
  resolveAutonomousCloserCommitAccountabilityImpl = resolveAutonomousCloserCommitAccountability,
  env = process.env,
} = {}) {
  const base = candidate?.baseBranch;
  const validatedHead = gateSnapshot?.reviewedHeadSha || reviewState?.headSha || null;
  const NOT_TAKEN = (reason) => ({ disposition: DAEMON_MERGE_DISPOSITION.NOT_TAKEN, reason });
  if (!base || !validatedHead) {
    return NOT_TAKEN('daemon-inputs-missing');
  }
  const strictMode = cfg?.strictMode !== false;
  const branchProtectionRequired = cfg?.branchProtection?.required !== false;
  const requiredGateContext = resolveGateStatusContext(env);
  const branchProtectionRequiredContexts = Array.isArray(candidate?.branchProtection?.requiredContexts)
    ? candidate.branchProtection.requiredContexts
    : [];
  const hqRoot = env.HQ_ROOT || env.AGENT_OS_HQ_ROOT || join(homedir(), 'agent-os-hq');
  // The daemon path is a strict clean-merge shortcut. If the current review is
  // not daemon-clean, it must decline before spending any worker-identity reads:
  // the caller will fall through to the capped hammer, which owns final
  // remediation/merge for findings-present PRs. Resolving identity first made a
  // transient/opaque identity miss park HAM entirely even when the daemon would
  // have returned not-taken for findings.
  //
  // EXCEPTION — the daemon HAM terminal-remediation re-merge. A findings-present
  // review whose CURRENT head an entitled hammer already remediated AND validated
  // under the merge lease (durable AMA audit marker), but could not land because
  // GitHub required checks had not gone green inside the hammer's bounded
  // remote-CI wait window. With no live worker left to retry, the remediated +
  // eligible PR would otherwise strand until an operator merges it (or the
  // per-head hammer retry cap re-dispatches a worker just to wait on CI again).
  // The daemon lands it here once CI settles — the "settled review + green +
  // mergeable, no live worker → daemon merges" path. `attemptDaemonCleanMerge`
  // still re-verifies green CI + mergeable + head-match LIVE, so a still-pending
  // head simply declines and falls through unchanged.
  //
  // `hamAuditHead` is the EXACT head the AMA audit marker is checked against, and
  // it is the only head this lane may ever merge. Keep it in a variable and pass
  // that same value on to `attemptDaemonCleanMerge` as `validatedHead`: reading
  // the freshly-fetched `liveHead` there instead would make the callee's
  // head-match assertion compare `liveHead` to itself, so a head that advanced
  // after this audit check would be merged unvalidated.
  const hamAuditHead = currentPrHeadSha || candidate?.headSha || null;
  let hamTerminalRemediationHead = false;
  // FIX (stale-review-head spin, #5053): a SECOND head-match certification for the
  // daemon re-merge lane. A settled-success (comment-only / approved) review whose
  // ONLY standing findings are non-blocking, and whose live head is the terminal
  // closer's OWN commit (proven via `getHeadCloserCommitSuppression` -- an external
  // push cannot forge the closer committer identity), self-certifies as a
  // merge-eligible head. This lets the daemon LAND the certified head inline (no
  // fresh hammer, no per-head retry-cap burn) instead of the closer re-dispatching
  // or spinning `not-eligible`. Blocking findings stay a HARD STOP: the guard
  // requires `resolveDaemonMergeUncleanReason` === 'non-blocking-findings-present'
  // (blocking count 0, known), and the daemon-merge Gate-1 bypass keyed on this
  // flag ALSO re-checks blocking==0 via strictMode:false, so a blocking finding or
  // an unknown classification is never merged over.
  let headCloserCertifiedNonBlocking = false;
  let cleanCloserCommitAccountability = null;
  let cleanCloserCommitSuppression = null;
  if (!isDaemonMergeReviewAllowed(reviewState, { strictMode })) {
    const uncleanReason =
      resolveDaemonMergeUncleanReason(reviewState, { strictMode }) || 'findings-unknown';
    hamTerminalRemediationHead = headHasValidatedHamTerminalRemediationImpl({
      hqRoot,
      repo: repoPath,
      prNumber,
      headSha: hamAuditHead,
      readAmaAuditEntryImpl,
    });
    if (
      !hamTerminalRemediationHead &&
      uncleanReason === 'non-blocking-findings-present' &&
      SETTLED_SUCCESS_VERDICTS.has(gateSnapshot?.settledReview?.verdict) &&
      String(hamAuditHead || '').trim()
    ) {
      try {
        const suppression = await resolveHeadCloserCommitSuppressionImpl({
          repoPath,
          prNumber,
          headSha: hamAuditHead,
          logger,
        });
        headCloserCertifiedNonBlocking = suppression?.suppressed === true;
      } catch (err) {
        // Fail closed: an unresolved / errored proof never certifies. The lane
        // falls through to the capped hammer (never a park, never a merge).
        logger?.warn?.(
          `[watcher] AMA daemon head-closer self-cert proof failed for ` +
            `${repoPath}#${prNumber}@${String(hamAuditHead || '').slice(0, 12)}; ` +
            `not certifying: ${err?.message || err}`,
        );
      }
    }
    // Fail closed if NEITHER certification holds, or the marker resolved without a
    // concrete head to pin it to: this lane merges `hamAuditHead` verbatim, so an
    // empty one would have no validated head at all. Falls through to the capped
    // hammer, never a merge.
    if (
      (!hamTerminalRemediationHead && !headCloserCertifiedNonBlocking) ||
      !String(hamAuditHead || '').trim()
    ) {
      return NOT_TAKEN(uncleanReason);
    }
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
  const snapshotHead = String(hamAuditHead || '').trim();
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
  if (
    cfg?.autonomousCloserCommitCleanMergeEnabled !== false &&
    String(validatedHead || '').trim() &&
    String(validatedHead || '').trim() !== liveHead &&
    SETTLED_SUCCESS_VERDICTS.has(gateSnapshot?.settledReview?.verdict)
  ) {
    try {
      cleanCloserCommitSuppression = await resolveHeadCloserCommitSuppressionImpl({
        repoPath,
        prNumber,
        headSha: liveHead,
        logger,
      });
    } catch (err) {
      logger?.warn?.(
        `[watcher] AMA daemon clean closer-commit proof failed for ` +
          `${repoPath}#${prNumber}@${liveHead.slice(0, 12)}; ` +
          `not certifying stale clean review: ${err?.message || err}`,
      );
      cleanCloserCommitSuppression = null;
    }
  }
  // The MSM-02 predicate clears the verdict gate only for the normalized
  // `settled-success` token; a settled-success review verdict maps to it, and
  // anything else stays raw so the predicate refuses it.
  const settledVerdict = SETTLED_SUCCESS_VERDICTS.has(gateSnapshot?.settledReview?.verdict)
    ? 'settled-success'
    : String(gateSnapshot?.settledReview?.verdict || '');
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
      cleanCloserCommitAccountability = resolveAutonomousCloserCommitAccountabilityImpl({
        enabled: cfg?.autonomousCloserCommitCleanMergeEnabled,
        reviewedHeadSha: validatedHead,
        mergeHeadSha: liveHead,
        suppression: cleanCloserCommitSuppression,
        workerIdentityReason: workerIdentity.reason || 'worker-identity-unresolved',
      });
      if (cleanCloserCommitAccountability) {
        operatorMergeAccountability = cleanCloserCommitAccountability;
      } else if (hamTerminalRemediationHead || headCloserCertifiedNonBlocking) {
        // The HAM terminal-remediation audit / head-closer self-cert IS the merge
        // accountability, but the daemon re-merge is a best-effort shortcut — never
        // a NEW park path. If head provenance cannot resolve a worker identity this
        // tick, fall through to the existing capped hammer instead of failing closed.
        return NOT_TAKEN(
          hamTerminalRemediationHead
            ? 'ham-terminal-remediation-worker-identity-unresolved'
            : 'head-closer-certified-worker-identity-unresolved',
        );
      }
      if (!operatorMergeAccountability) return {
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
    const accountabilityEvent = cleanCloserCommitAccountability
      ? 'ama.daemon_clean_merge.autonomous_closer_commit_accountability_substituted'
      : 'ama.daemon_clean_merge.operator_accountability_substituted';
    logger?.log?.(JSON.stringify({
      schemaVersion: 1,
      event: accountabilityEvent,
      repo: repoPath,
      pr: prNumber,
      headSha: liveHead,
      reviewedHeadSha: cleanCloserCommitAccountability?.reviewedHeadSha || null,
      label: operatorMergeAccountability.label,
      actor: operatorMergeAccountability.actor,
      eventId: operatorMergeAccountability.eventId,
      workerIdentityReason: workerIdentity.reason || 'worker-identity-unresolved',
      autonomousCloserCommitClean: Boolean(cleanCloserCommitAccountability),
    }));
    if (cleanCloserCommitAccountability) {
      logger?.warn?.(
        `[watcher] AMA daemon clean-merge: worker identity unresolved for ${repoPath}#${prNumber}` +
          `@${String(liveHead).slice(0, 12)} (${workerIdentity.reason || 'worker-identity-unresolved'}) ` +
          `but the stale clean review head ${String(validatedHead || '').slice(0, 12)} advanced only via ` +
          `trusted closer commit identity — substituting merge-agent accountability for the clean daemon merge under lease`,
      );
    } else {
      logger?.warn?.(
        `[watcher] AMA daemon clean-merge: worker identity unresolved for ${repoPath}#${prNumber}` +
          `@${String(liveHead).slice(0, 12)} (${workerIdentity.reason || 'worker-identity-unresolved'}) ` +
          `but operator '${operatorMergeAccountability.actor}' applied '${operatorMergeAccountability.label}' ` +
          `at this exact head — substituting operator accountability for the clean daemon merge under lease`,
      );
    }
  }
  // HAM / non-blocking head-closer certifications merge the audit-checked
  // snapshot head. The autonomous clean closer lane is proven against the
  // refreshed live head above, after the same head-moved guard has ruled out a
  // snapshot mismatch, so it must pass that proven closer head to the merge
  // executor rather than a HAM audit head that may be absent or stale.
  const certifiedNonCleanHead = hamTerminalRemediationHead || headCloserCertifiedNonBlocking;
  const autonomousCloserCommitCleanHead = Boolean(cleanCloserCommitAccountability);
  const daemonValidatedHead = autonomousCloserCommitCleanHead
    ? liveHead
    : certifiedNonCleanHead
      ? hamAuditHead
      : validatedHead;
  const daemonVerdict = hamTerminalRemediationHead
    ? 'ham_terminal_remediation_validated'
    : settledVerdict;
  const daemonResult = await attemptDaemonCleanMergeImpl({
    repo: repoPath,
    prNumber,
    base,
    validatedHead: daemonValidatedHead,
    verdict: daemonVerdict,
    allowHamTerminalRemediation: hamTerminalRemediationHead,
    allowHeadCloserCertifiedNonBlocking: headCloserCertifiedNonBlocking,
    reviewState: {
      blockingFindingCount: reviewState?.blockingFindingCount,
      blockingFindingState: reviewState?.blockingFindingState,
      nonBlockingFindingCount: reviewState?.nonBlockingFindingCount,
      nonBlockingFindingState: reviewState?.nonBlockingFindingState,
    },
    branchProtectionRequired,
    requiredGateContext,
    branchProtectionRequiredContexts,
    // Initial (pre-lease) GitHub gate snapshot from the live fetch this tick.
    liveGate: {
      candidateHead: liveHead,
      requiredChecks: resolveRollupRequiredChecks(liveRollup)
        ?? (Array.isArray(candidate?.statusCheckRollup) ? candidate.statusCheckRollup : []),
      mergeable: liveRollup?.mergeable ?? mergeabilityForGate?.mergeable,
      mergeStateStatus: liveRollup?.mergeStateStatus ?? mergeabilityForGate?.mergeStateStatus,
      prState: String(liveRollup?.state || candidate?.prState || 'open').toUpperCase(),
      branchProtectionRequiredContexts,
    },
    mergeMethod,
    hqRoot,
    auditMetadata: {
      reviewer: reviewStateRow?.reviewer || '',
      riskClass: reviewState?.riskClass || 'unknown',
      // Distinguish a HAM terminal-remediation daemon re-merge from a normal
      // zero-finding clean daemon merge in the audit doc's closure authority.
      ...(hamTerminalRemediationHead
        ? { closureAuthority: 'daemon-ham-terminal-remediation' }
        : autonomousCloserCommitCleanHead
          ? { closureAuthority: 'daemon-autonomous-closer-commit-clean' }
          : headCloserCertifiedNonBlocking
            ? { closureAuthority: 'daemon-head-closer-certified-non-blocking' }
            : {}),
      // Record which accountability authorized the merge: hq-dispatched worker
      // identity (the normal path) or an explicit head-scoped operator label
      // (Deliverable 1 substitution). The audit doc thus always names WHO the
      // merge authority rests on.
      mergeAccountability: cleanCloserCommitAccountability
        ? 'autonomous-closer-commit'
        : operatorMergeAccountability
          ? 'operator-approval'
          : 'worker-identity',
      ...(operatorMergeAccountability && !cleanCloserCommitAccountability
        ? { operatorApproval: operatorMergeAccountability }
        : {}),
      ...(cleanCloserCommitAccountability
        ? {
            autonomousCloserCommitClean: {
              ...cleanCloserCommitAccountability,
              reviewedHeadSha: validatedHead,
              currentHeadSha: liveHead,
            },
          }
        : {}),
    },
    workerIdentity,
    flags: {
      autonomousMergeExecutionEnabled: cfg?.autonomousMergeExecutionEnabled !== false,
      strictMode,
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
        branchProtectionRequiredContexts,
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
        holderHead: daemonValidatedHead,
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
  if (
    (hamTerminalRemediationHead || headCloserCertifiedNonBlocking) &&
    daemonResult?.disposition === DAEMON_MERGE_DISPOSITION.FAILED_CLOSED
  ) {
    // Best-effort shortcut only: a HAM / head-closer daemon re-merge that fails
    // closed must NOT park the PR. Fall through to the existing capped hammer, which
    // can rebase, re-validate, and retry. (A NOT_TAKEN 'not-eligible' from a
    // still-pending or not-yet-mergeable gate already falls through; MERGED /
    // DEFERRED pass as-is.)
    const failedClosedLane = hamTerminalRemediationHead
      ? 'ham-terminal-remediation'
      : 'head-closer-certified';
    return NOT_TAKEN(`${failedClosedLane}-daemon-${daemonResult.reason || 'failed-closed'}`);
  }
  return daemonResult;
}

// Internal helpers exposed for unit tests.
export const __testables__ = Object.freeze({
  resolveRollupRequiredChecks,
});
