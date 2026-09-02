// ── AMA closure orchestration: dispatch decision + coexistence + audit ────────
//
// ARC-18: extracted from watcher.mjs. The AMA (autonomous-merge-authority)
// closure-dispatch decision core (`maybeDispatchAmaClosureFor`), its result
// wrapper (`withAmaDispatchMetadata`), the disabled-mode audit writer, and the
// merge-agent coexistence resolver moved here as a leaf. `resolveOrchestrationMode`
// is imported from ./pr-lifecycle-sync.mjs (extracted earlier this batch). ROOT,
// execFileAsync, and the cluster-exclusive merge-authority/mergeability consts are
// re-derived/moved verbatim (pure, derivable from the same inputs).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGateStatusContext } from './adversarial-gate-context.mjs';
import { buildAdversarialGateSnapshot } from './adversarial-gate-status.mjs';
import { writeAmaAuditEntry } from './ama/audit.mjs';
import {
  COEXISTENCE_ACTION,
  decideMergeAgentCoexistence,
  isMergeAgentRequestedScoped,
  mergeAgentDispatchEnvForAction,
} from './ama/coexistence.mjs';
import { DAEMON_MERGE_DISPOSITION, isDaemonMergeReviewAllowed } from './ama/daemon-merge.mjs';
import * as amaDispatchCloser from './ama/dispatch-closer.mjs';
import { isEligibleForAmaClosure, SETTLED_SUCCESS_VERDICTS } from './ama/eligibility.mjs';
import { evaluateMergeEligibility } from './ama/merge-eligibility.mjs';
import { recordAmaRetain } from './ama-retain-loop-cap.mjs';
import { amaRetainLoopCapFor } from './kernel/convergence-budget.mjs';
import { amaAuthoritativeReviewerLoginsForModel } from './ama/reviewer-authority.mjs';
import { loadConfigCached } from './config-loader.mjs';
import { loadDomainConfig } from './domain-config.mjs';
import { resolveMergeAuthorityConfigFromDomain } from './domain-policy.mjs';
import {
  AMA_LIVE_REVIEW_LOOKUP_RETRY_DELAYS_MS,
  fetchLatestHeadReviewBodiesWithRetry,
  runDaemonCleanMergeAttempt,
} from './daemon-clean-merge.mjs';
import {
  clearDaemonMergePark,
  recordDaemonMergePark,
} from './daemon-merge-park-log.mjs';
import {
  findLiveAmaCloserLease,
  rekeyAmaCloserLease,
} from './ama/closer-lease.mjs';
import { resolveRoundBudgetForJob, summarizePRRemediationLedger } from './follow-up-jobs.mjs';
import { isTransientGhError } from './gh-cli.mjs';
import { fetchPullRequestMergeability, fetchReviewBodiesForHead } from './github-api.mjs';
import { normalizeGithubMergeability, resolveMergeabilityWithSampling } from './github-mergeability.mjs';
import {
  buildNonReviewableHeadDeltaEvidence,
  fetchHeadCloserVerifiedCommit,
  getHeadCloserCommitSuppression,
} from './head-closer-commit-suppression.mjs';
import { isDismissStaleRequestChangesOnResolvedEnabled } from './merge-agent-dispatch-decision.mjs';
import { resolveOrchestrationMode } from './pr-lifecycle-sync.mjs';
import { dismissSupersededBlockingVerdictAtRemediatedHead } from './superseded-blocking-verdict-dismissal.mjs';
import {
  countCompletedReviewerRereviewRounds,
  reviewCycleExhaustedFromRounds,
} from './review-ceiling-metrics.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The adversarial-review config module. The node watcher normally reads config
// from env vars exported by the shell `agent_os_config_export`, but that shell
// exporter mis-resolves nested overrides (2026-07-16: it emits
// AGENT_OS_CFG_..._LHA_CONSUME_ATTESTATIONS=true even when this file sets it
// false, so the merge-authority daemon kept enforcing head-attestation
// consumption and parked every worker PR worker-identity-unresolved). Loading
// this file as a config MODULE makes the authoritative, reviewed config.yaml win
// for the keys it sets (verified: consume_attestations flips to false while
// env-sourced keys like `enabled` are preserved) — the right posture for the
// security-critical merge-authority read.
const WATCHER_MERGE_AUTHORITY_CONFIG_MODULES = Object.freeze([join(ROOT, 'config.yaml')]);
const {
  maybeDispatchAmaCloser,
  namedAmaNoDispatchReason,
} = amaDispatchCloser;

export function normalizeCompletedRoundCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// Transient mergeability sampling window (GitHub returns mergeable=UNKNOWN right
// after a push / base move while it recomputes). Re-sample so we don't park an
// otherwise-eligible PR as `pr-not-mergeable`. Env-overridable.
const MERGEABILITY_SAMPLE_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.ADVERSARIAL_MERGEABILITY_SAMPLE_ATTEMPTS || '', 10) || 3,
);
const MERGEABILITY_SAMPLE_DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.ADVERSARIAL_MERGEABILITY_SAMPLE_DELAY_MS || '', 10) || 2500,
);

// Deliverable 2 — daemon-fail-closed hammer fallback classification.
//
// When the daemon clean-path fails closed on a REMEDIABLE gate, a fleet-worker
// (identity-resolved) clean PR should be handed to the SAME capped hammer the
// `not-taken` path already uses — the hammer re-validates the required gate at
// the post-remediation head and merges under its own lease — instead of parking
// for manual close. NON-remediable gates still fail closed (no blind
// merge-clicker): worker-identity is Deliverable 1's operator-approval lane, and
// verdict/lease misses are not something a hammer can repair into a merge.
const DAEMON_HAMMER_REMEDIABLE_GATE_REASONS = new Set([
  'ci-not-green',
  'pr-not-mergeable',
  'stale-head',
]);
const DAEMON_HAMMER_NONREMEDIABLE_GATE_REASONS = new Set([
  'verdict-not-eligible',
  'lease-not-held',
]);

/**
 * Is this daemon `failed-closed` result one a single capped hammer can plausibly
 * remediate into a merge? True ONLY for a remediable gate on a PR that already
 * cleared the daemon's worker-identity gate (so it is an attributed fleet-worker
 * PR). Worker-identity, permanent/unclassified merge rejections, and transient
 * budget/read exhaustion are NOT hammer-remediable here.
 *
 * @param {object} daemonCleanMerge  The `runDaemonCleanMergeAttempt` result.
 * @returns {boolean}
 */
export function isDaemonFailClosedHammerRemediable(daemonCleanMerge) {
  if (!daemonCleanMerge || daemonCleanMerge.disposition !== DAEMON_MERGE_DISPOSITION.FAILED_CLOSED) {
    return false;
  }
  const reason = String(daemonCleanMerge.reason || '');
  // Worker-identity-unresolved is NOT hammer-remediable — that PR is un-attributed
  // and closes (if at all) via Deliverable 1's operator-approval lane on the
  // daemon path, never a spawned merge-clicker.
  if (reason === 'worker-identity-unresolved') return false;
  // The daemon's own stale-head terminal: the reviewed head moved, so a fresh
  // review head gets its own hammer under the per-PR cap.
  if (reason === 'stale-head') return true;
  // A `gate-not-eligible` terminal carries the exact failing eligibility gates.
  if (reason !== 'gate-not-eligible') return false;
  const reasons = Array.isArray(daemonCleanMerge.reasons)
    ? daemonCleanMerge.reasons.map((r) => String(r))
    : [];
  if (reasons.length === 0) return false;
  // Any non-remediable gate co-occurring → park (fail closed).
  if (reasons.some((r) => DAEMON_HAMMER_NONREMEDIABLE_GATE_REASONS.has(r))) return false;
  // EVERY gate must be hammer-remediable.
  return reasons.every((r) => DAEMON_HAMMER_REMEDIABLE_GATE_REASONS.has(r));
}

function withAmaDispatchMetadata(result, { amaEnabled }) {
  if (!result || typeof result !== 'object') return result;
  const wrapped = {
    ...result,
    amaEnabled: result.amaEnabled === undefined ? amaEnabled : result.amaEnabled,
  };
  if (wrapped.dispatched === false && !wrapped.namedReason) {
    wrapped.namedReason = namedAmaNoDispatchReason(
      wrapped.reason || 'unknown',
      wrapped.reasons,
    );
  }
  return wrapped;
}

export function writeAutonomousMergeDisabledAudit({
  hqRoot,
  repoPath,
  prNumber,
  headSha,
  path,
  eligibilityReasons = [],
  flagState = {},
  reviewStateRow = {},
  reviewState = {},
  writeAuditImpl = writeAmaAuditEntry,
  now = new Date().toISOString(),
  logger = console,
} = {}) {
  if (!hqRoot || !repoPath || !Number.isFinite(Number(prNumber)) || !headSha) {
    return { written: false, reason: 'audit-inputs-missing' };
  }
  const normalizedPath = path === 'hammer-merge' ? 'hammer-merge' : 'daemon-merge';
  const normalizedReasons = Array.isArray(eligibilityReasons) ? eligibilityReasons : [];
  const normalizedFlagState = {
    autonomousMergeExecutionEnabled: flagState.autonomousMergeExecutionEnabled === true,
    strictMode: flagState.strictMode !== false,
  };
  try {
    writeAuditImpl({
      hqRoot,
      repo: repoPath,
      prNumber: Number(prNumber),
      headSha,
      attempt: {
        outcome: 'failed-without-merge',
        path: normalizedPath,
        attemptPhase: 'autonomous-merge-disabled',
        reason: 'autonomous-merge-execution-disabled',
        eligibilityReasons: normalizedReasons,
        preMergeReasons: normalizedReasons,
        flagState: normalizedFlagState,
        validatedHead: headSha,
      },
      metadata: {
        closureAuthority: normalizedPath,
        reviewer: reviewStateRow?.reviewer || '',
        riskClass: reviewState?.riskClass || 'unknown',
        flagState: normalizedFlagState,
      },
      now,
    });
    return { written: true, reason: 'autonomous-merge-execution-disabled' };
  } catch (err) {
    logger?.warn?.(
      `[watcher] autonomous merge disabled audit failed for ${repoPath}#${prNumber}@${headSha}: ` +
        `${err?.message || err}`,
    );
    return { written: false, reason: 'audit-write-failed' };
  }
}

/**
 * Resolve the AMA cfg subtree, build (reviewState, prMetadata)
 * snapshots from the watcher's existing row + candidate data, and
 * call `maybeDispatchAmaCloser`. Returns the dispatch result; the
 * caller checks `.dispatched` and skips merge-agent on `true`.
 *
 * Cheap path: when `cfg.enabled === false` (the default), this
 * function short-circuits in `maybeDispatchAmaCloser` before doing
 * any I/O or fetches. The watcher's hot path pays only the cost of
 * `loadConfigCached().getMergeAuthorityConfig()`, which is cached
 * across ticks.
 *
 * Snapshot mapping is best-effort against the watcher's existing
 * shapes. Fields the watcher doesn't already have (e.g. branch
 * protection's resolved required contexts) are left empty, and the
 * eligibility predicate fails-closed on them — meaning AMA dispatch
 * won't fire in the watcher path until the operator wires those
 * fetches in. That's intentional: AMA-03 lands the dispatch *path*;
 * AMA-06A/06N wire in the full snapshot in the cutover ticket.
 */

export async function maybeDispatchAmaClosureFor({
  rootDir = ROOT,
  reviewStateRow,
  dispatchJob,
  candidate,
  labelNames,
  operatorApprovalEvent,
  mergeAgentRequestEvent,
  adversarialMergeRequestedEvent,
  repoPath,
  prNumber,
  currentRevisionRef,
  domainId = 'code-pr',
  logger,
  loadConfigImpl = loadConfigCached,
  maybeDispatchAmaCloserImpl = maybeDispatchAmaCloser,
  fetchLatestHeadReviewBodiesImpl = (repo, pr, head, options = {}) =>
    fetchReviewBodiesForHead(execFileAsync, repo, pr, head, options),
  liveReviewRetryDelaysMs = AMA_LIVE_REVIEW_LOOKUP_RETRY_DELAYS_MS,
  resolveReviewCycleExhaustionImpl = null,
  runDaemonCleanMergeAttemptImpl = runDaemonCleanMergeAttempt,
  resolveHeadCloserCommitSuppressionImpl = null,
  resolveHamTerminalRemediationEvidenceImpl =
    amaDispatchCloser.resolveHamTerminalRemediationEvidence || null,
  dismissSupersededBlockingVerdictAtRemediatedHeadImpl =
    dismissSupersededBlockingVerdictAtRemediatedHead,
  writeAutonomousMergeDisabledAuditImpl = writeAutonomousMergeDisabledAudit,
  env = process.env,
}) {
  let cfg;
  let orchestrationMode;
  try {
    // Load the adversarial config.yaml as a module so merge-authority values
    // (notably lha.consume_attestations, which gates autonomous merge) come from
    // the reviewed file, not the shell env export that mis-resolves nested keys.
    const loadedConfig = loadConfigImpl({ modulePaths: WATCHER_MERGE_AUTHORITY_CONFIG_MODULES });
    cfg = resolveMergeAuthorityConfigFromDomain(
      loadDomainConfig(rootDir, domainId || 'code-pr'),
      loadedConfig.getMergeAuthorityConfig(),
      { fallbackSources: loadedConfig.sources || {} },
    );
    orchestrationMode = resolveOrchestrationMode({
      loadedConfig,
      logger,
      context: 'AMA closure dispatch',
    });
  } catch (err) {
    // CFG load failure isn't an AMA problem; let the existing
    // merge-agent path handle the tick.
    logger?.warn?.(`[watcher] AMA cfg load failed: ${err?.message || err}`);
    return withAmaDispatchMetadata(
      { dispatched: false, reason: 'cfg-load-failed' },
      { amaEnabled: false },
    );
  }
  if (!cfg?.enabled) {
    // AMA-06N — surface `amaEnabled` so the watcher's coexistence
    // decision (the call site of this helper) can branch on it. With
    // AMA off, the default `merge-agent-default` action falls through
    // to the existing merge-agent dispatch without any override env.
    return withAmaDispatchMetadata(
      { dispatched: false, reason: 'ama-disabled' },
      { amaEnabled: false },
    );
  }

  // AMA "final hammer" signal: the review cycle is EXHAUSTED once the PR has
  // consumed its full remediation round budget. At that point the adversarial
  // verdict can loop on `Request changes` forever, so AMA must land the PR
  // (eligibility.mjs waives the soft convergence gates, keeps the hard ones).
  // Mirrors evaluateRoundBudgetForReview's budget resolution. Fail-safe: any
  // error leaves the signal false (AMA keeps its normal strict gates).
  let reviewCycleExhausted = false;
  let completedRemediationRoundsForPR = null;
  let completedRereviewRoundsForPR = null;
  let completedRemediationRevisionRefsForPR = [];
  // Resolve the PR's risk class from the remediation ledger (which defaults to
  // DEFAULT_RISK_CLASS) so AMA eligibility uses the SAME risk class the
  // round-budget path below already computes. Without this, the eligibility
  // riskClass fell back to 'unknown' for EVERY PR — fetchMergeAgentCandidate
  // does not populate candidate.riskClass and reviewed_prs has no risk_class
  // column — and 'unknown' is always-two-key, so AMA could never auto-close any
  // PR (closed 0 ever). Hoisted out of the try so it survives a round-budget
  // probe failure.
  let ledgerRiskClass = null;
  try {
    if (typeof resolveReviewCycleExhaustionImpl === 'function') {
      const resolved = resolveReviewCycleExhaustionImpl({
        rootDir,
        repoPath,
        prNumber,
      }) || {};
      reviewCycleExhausted = resolved.reviewCycleExhausted === true;
      ledgerRiskClass = resolved.ledgerRiskClass || resolved.riskClass || null;
      completedRemediationRevisionRefsForPR = Array.isArray(resolved.completedRemediationRevisionRefs)
        ? resolved.completedRemediationRevisionRefs
        : [];
    } else {
      const remLedger = summarizePRRemediationLedger(rootDir, { repo: repoPath, prNumber });
      ledgerRiskClass = remLedger?.latestRiskClass || null;
      const rbResolution = resolveRoundBudgetForJob(
        { riskClass: remLedger.latestRiskClass },
        { rootDir },
      );
      const latestMaxRounds = Number(remLedger.latestMaxRounds);
      const effectiveRoundBudget =
        Number.isInteger(latestMaxRounds) && latestMaxRounds > rbResolution.roundBudget
          ? latestMaxRounds
          : rbResolution.roundBudget;
      // Re-review rounds count toward the shared "cycle exhausted" signal so
      // comment-only clean PRs do not park after reviewers hit budget. The
      // closer also receives the raw remediation/rereview counters below so its
      // terminal Hammer arming gate can require evidence that Codex/remediator
      // had a turn.
      completedRemediationRoundsForPR = normalizeCompletedRoundCount(
        remLedger.completedRoundsForPR,
      );
      completedRemediationRevisionRefsForPR = Array.isArray(remLedger.completedRemediationRevisionRefs)
        ? remLedger.completedRemediationRevisionRefs
        : [];
      completedRereviewRoundsForPR = 0;
      try {
        completedRereviewRoundsForPR = normalizeCompletedRoundCount(
          countCompletedReviewerRereviewRounds({ rootDir, repoPath, prNumber }),
        );
      } catch (rereviewErr) {
        console.warn(
          `[watcher] AMA final-hammer re-review-round probe failed for ${repoPath}#${prNumber}; ` +
            `falling back to remediation-round exhaustion only: ${rereviewErr?.message || rereviewErr}`,
        );
      }
      reviewCycleExhausted = reviewCycleExhaustedFromRounds({
        effectiveRoundBudget,
        completedRemediationRounds: completedRemediationRoundsForPR,
        completedRereviewRounds: completedRereviewRoundsForPR,
      });
    }
  } catch (err) {
    console.warn(
      `[watcher] AMA final-hammer round-budget probe failed for ${repoPath}#${prNumber}; ` +
        `treating cycle as NOT exhausted: ${err?.message || err}`,
    );
  }

  const settledReviewHeadSha = candidate?.headSha || currentRevisionRef || null;
  // GitHub returns mergeable=UNKNOWN transiently right after a push or when the
  // base branch moves (a steady merge stream keeps `main` moving), and the
  // eligibility predicate maps a non-MERGEABLE state to `pr-not-mergeable`. Only
  // when the first read is NOT already terminal (MERGEABLE/CONFLICTING) do we
  // re-sample over a bounded window so we don't wrongly park an eligible PR.
  let mergeabilityForGate = candidate;
  const initialMergeability = normalizeGithubMergeability(candidate || {});
  if (initialMergeability !== 'MERGEABLE' && initialMergeability !== 'CONFLICTING') {
    const sampled = await resolveMergeabilityWithSampling(
      candidate || {},
      () => fetchPullRequestMergeability(repoPath, prNumber, { execFileImpl: execFileAsync }),
      { attempts: MERGEABILITY_SAMPLE_ATTEMPTS, delayMs: MERGEABILITY_SAMPLE_DELAY_MS },
    );
    mergeabilityForGate = {
      ...(candidate || {}),
      mergeable: sampled.mergeable,
      mergeStateStatus: sampled.mergeStateStatus,
    };
    if (!sampled.resolved) {
      console.warn(
        `[watcher] mergeability still UNKNOWN for ${repoPath}#${prNumber} after ` +
          `${sampled.samples} sample(s); treating as not-yet-mergeable this tick`,
      );
    }
  }
  let gateSnapshot = await buildAdversarialGateSnapshot(rootDir, {
    repo: repoPath,
    prNumber,
    reviewRow: reviewStateRow,
    headSha: settledReviewHeadSha,
    mergeability: mergeabilityForGate,
    labels: labelNames,
    prUpdatedAt: candidate?.prUpdatedAt || dispatchJob?.prUpdatedAt || null,
    prAuthor: candidate?.prAuthor || null,
    operatorApprovalEvent,
    includeSettledReview: true,
  });
  // FAIL-OPEN GUARD (#1824 / #1816): the stored follow-up-job / review-row body
  // resolved above can be STALE relative to a fresh review on the SAME head — a
  // completed remediation job's comment-only body is not updated when a later
  // adversarial pass posts `Request changes`, so the closer fail-open merged
  // PRs whose live verdict was `Request changes`. ONLY when the stored body
  // already reads settled-success (the sole case a stale body could cause a
  // fail-open merge) do we reconcile against the LIVE latest review on the head;
  // this bounds the extra GitHub call to apparently-mergeable PRs. A fresh
  // `Request changes` then wins, and a lookup failure fails closed.
  const authoritativeReviewerLogins = amaAuthoritativeReviewerLoginsForModel(reviewStateRow?.reviewer);
  if (
    settledReviewHeadSha &&
    gateSnapshot.settledReview?.remediationPending === false &&
    SETTLED_SUCCESS_VERDICTS.has(gateSnapshot.settledReview?.verdict)
  ) {
    let liveHeadReview;
    // Resolve the authoritative reviewer login(s) from the REAL `reviewer` model
    // field (e.g. 'codex'/'claude'), NOT a `reviewer_login` column — that column
    // does NOT exist on reviewed_prs, so the prior `reviewStateRow?.reviewer_login`
    // was ALWAYS empty and the reconcile fail-CLOSED on every legit settled-success
    // PR (#1834 stuck despite `Comment only`). We accept BOTH observed reviewer-bot
    // login forms (the live `lacey-<model>-reviewer` account AND the legacy
    // `<model>-reviewer-lacey` config form) so the anti-spoof filter is robust to
    // the known naming discrepancy without mutating the globally-used
    // REVIEWER_BOT_LOGINS map (which review-body-capture / closeout-scraper rely on).
    try {
      const bodies = authoritativeReviewerLogins.length
        ? await fetchLatestHeadReviewBodiesWithRetry({
            repoPath,
            prNumber,
            headSha: settledReviewHeadSha,
            authoritativeReviewerLogins,
            fetchLatestHeadReviewBodiesImpl,
            retryDelaysMs: liveReviewRetryDelaysMs,
            logger,
          })
        : [];
      if (!authoritativeReviewerLogins.length) {
        logger?.warn?.(
          `[watcher] AMA live-review reconcile could not resolve an authoritative reviewer ` +
            `login from reviewer='${reviewStateRow?.reviewer ?? ''}' for ` +
            `${repoPath}#${prNumber}@${settledReviewHeadSha}; failing closed`,
        );
      }
      liveHeadReview = { resolved: true, bodies: Array.isArray(bodies) ? bodies : [] };
    } catch (err) {
      logger?.warn?.(
        `[watcher] AMA live-review reconcile failed for ${repoPath}#${prNumber}@${settledReviewHeadSha}; ` +
          `failing closed: ${err?.message || err}`,
      );
      liveHeadReview = { resolved: false };
    }
    gateSnapshot = await buildAdversarialGateSnapshot(rootDir, {
      repo: repoPath,
      prNumber,
      reviewRow: reviewStateRow,
      headSha: settledReviewHeadSha,
      mergeability: mergeabilityForGate,
      labels: labelNames,
      prUpdatedAt: candidate?.prUpdatedAt || dispatchJob?.prUpdatedAt || null,
      prAuthor: candidate?.prAuthor || null,
      operatorApprovalEvent,
      includeSettledReview: true,
      liveHeadReview,
    });
  }
  const currentPrHeadSha = candidate?.headSha || currentRevisionRef || null;

  // CLR-01 — carry a live closer lease forward when the head it is keyed to is no
  // longer the PR head.
  //
  // The lease is keyed by `(repo, prNumber, headSha)`, so a head advanced by the
  // closer that owns the lease orphans that lease: the file remains under a SHA no
  // longer on the branch, nothing can finalize it, and `selectReleasableCloserLeases`
  // refuses to reap it while its `watcherPid` is the LIVE watcher — which it always
  // is, because the live watcher is what acquired it. The lease becomes immortal and
  // the PR spins `review-queued -> skip-re-review (terminal closer commit) -> release
  // claim` forever with CI green and the review clean.
  //
  // `rekeyAmaCloserLease` was written for exactly this on 2026-08-12 (#828, after
  // #825) and shipped with tests — but nothing ever called it. On 2026-08-23
  // laceyenterprises/foundry#35 reproduced the identical deadlock: the hammer
  // succeeded at 02:23:45Z, its lease stayed `dispatched` on the pre-remediation
  // head, and the PR sat unmergeable. This is the missing call site.
  //
  // Safety lives in the helper: it refuses when the source lease is absent, when an
  // UNRELATED lease already holds the destination head, and when the lease is already
  // terminal. It preserves `acquiredAt`/`lrqId`/`watcherPid`, so ownership stays one
  // continuous audited chain, and stamps `rekeyedFromHeadSha`/`supersededHeads`.
  if (currentPrHeadSha) {
    try {
      const liveLease = findLiveAmaCloserLease(rootDir, { repo: repoPath, prNumber });
      if (liveLease && liveLease.headSha && liveLease.headSha !== currentPrHeadSha) {
        const rekey = rekeyAmaCloserLease({
          rootDir,
          repo: repoPath,
          prNumber,
          fromHeadSha: liveLease.headSha,
          toHeadSha: currentPrHeadSha,
          now: new Date().toISOString(),
        });
        logger?.log?.(
          `[watcher] AMA closer lease ${rekey.rekeyed ? 'rekeyed' : 'rekey declined'} for `
            + `${repoPath}#${prNumber}: ${String(liveLease.headSha).slice(0, 12)} -> `
            + `${String(currentPrHeadSha).slice(0, 12)}`
            + (rekey.rekeyed ? '' : ` (${rekey.reason})`),
        );
      }
    } catch (err) {
      // Lease reconciliation is a repair, not a gate: a failure here must never
      // stop the closure evaluation that follows.
      logger?.warn?.(
        `[watcher] AMA closer lease rekey failed for ${repoPath}#${prNumber}: ${err?.message || err}`,
      );
    }
  }

  const reviewState = {
    verdict: gateSnapshot.settledReview?.verdict || '',
    // `headSha` is the head the adversarial reviewer actually reviewed. MSM-04
    // keeps it as the stable hammer dispatch key; a stale live head may be the
    // remediation target only when it proves to be an already-closer-authored
    // HAM continuation, never an unreviewed human push.
    headSha: gateSnapshot.reviewedHeadSha,
    riskClass: String(candidate?.riskClass || reviewStateRow?.risk_class || ledgerRiskClass || 'unknown').toLowerCase(),
    remediationPending: gateSnapshot.settledReview?.remediationPending,
    reviewCycleExhausted,
    completedRemediationRounds: Number.isFinite(completedRemediationRoundsForPR)
      ? completedRemediationRoundsForPR
      : null,
    completedRereviewRounds: Number.isFinite(completedRereviewRoundsForPR)
      ? completedRereviewRoundsForPR
      : null,
    completedRemediationRevisionRefs: completedRemediationRevisionRefsForPR,
    // Blocking/non-blocking findings classification MUST come from the same
    // authoritative current-head body that `gateSnapshot.settledReview` resolved
    // the verdict from (live head body when reconciled, else the stored job/row
    // body). Reading the dispatchJob body instead defaults to 'unknown' for a
    // clean `comment-only` review with no remediation job and makes the closer
    // fail `blocking-findings-unknown` and never merge (live on agent-os#1856).
    // `gateSnapshot.settledReview` always carries these keys; fall back to
    // 'unknown' only if absent (fail-closed). The non-blocking pair is the
    // HAM-STRICT strict-remediation gate input (read from the same source).
    blockingFindingCount: Number(gateSnapshot.settledReview?.blockingFindingCount ?? 0),
    blockingFindingState: String(gateSnapshot.settledReview?.blockingFindingState || 'unknown').trim().toLowerCase(),
    nonBlockingFindingCount: Number(gateSnapshot.settledReview?.nonBlockingFindingCount ?? 0),
    nonBlockingFindingState: String(gateSnapshot.settledReview?.nonBlockingFindingState || 'unknown').trim().toLowerCase(),
    // Per-finding non-blocking identities (normalized titles) from the same
    // authoritative body the verdict/counts came from. Drives the HAM
    // non-blocking waiver coverage gate: AMA waives non-blocking only when the
    // HAM addressed-findings cover EVERY current identity. `null`/absent →
    // identities unknown → fail closed (no waiver).
    nonBlockingFindingIdentities: Array.isArray(gateSnapshot.settledReview?.nonBlockingFindingIdentities)
      ? gateSnapshot.settledReview.nonBlockingFindingIdentities
      : null,
    operatorApprovedEvidence: operatorApprovalEvent
      ? {
          applied: true,
          observedRevisionRef: operatorApprovalEvent.headSha || operatorApprovalEvent.head_sha || null,
          actor: operatorApprovalEvent.actor || null,
          eventId: operatorApprovalEvent.id || operatorApprovalEvent.nodeId || null,
          observedAt: operatorApprovalEvent.createdAt || operatorApprovalEvent.created_at || null,
        }
      : null,
    prAuthor: candidate?.prAuthor || null,
  };
  const prMetadata = {
    prNumber,
    headSha: currentPrHeadSha,
    isOpen: String(candidate?.prState || 'open').toLowerCase() === 'open',
    isDraft: Boolean(candidate?.isDraft),
    mergeableState: gateSnapshot.mergeableState,
    labels: Array.isArray(labelNames) ? labelNames : [],
    statusCheckRollup: Array.isArray(candidate?.statusCheckRollup) ? candidate.statusCheckRollup : [],
    branchProtection: { requiredContexts: candidate?.branchProtection?.requiredContexts || [] },
    author: candidate?.prAuthor || null,
  };

  const strictMode = cfg?.strictMode !== false;
  const autonomousMergeExecutionEnabled = cfg?.autonomousMergeExecutionEnabled !== false;
  const branchProtectionRequired = cfg?.branchProtection?.required !== false;
  const requiredGateContext = resolveGateStatusContext(env);
  const branchProtectionRequiredContexts = Array.isArray(candidate?.branchProtection?.requiredContexts)
    ? candidate.branchProtection.requiredContexts
    : [];
  const autonomousFlagState = {
    autonomousMergeExecutionEnabled,
    strictMode,
  };
  const settledVerdict = SETTLED_SUCCESS_VERDICTS.has(gateSnapshot?.settledReview?.verdict)
    ? 'settled-success'
    : String(gateSnapshot?.settledReview?.verdict || '');
  const wouldUseDaemonPath = isDaemonMergeReviewAllowed(reviewState, { strictMode });
  const disabledEligibility = evaluateMergeEligibility({
    verdict: settledVerdict,
    leaseHeld: true,
    requiredChecks: prMetadata.statusCheckRollup,
    mergeable: mergeabilityForGate?.mergeable,
    mergeStateStatus: mergeabilityForGate?.mergeStateStatus,
    prState: String(candidate?.prState || 'open').toUpperCase(),
    branchProtectionRequired,
    requiredGateContext,
    branchProtectionRequiredContexts,
    candidateHead: currentPrHeadSha || candidate?.headSha || '',
    validatedHead: reviewState.headSha,
  });
  if (!autonomousMergeExecutionEnabled) {
    const hqRoot = env.HQ_ROOT || env.AGENT_OS_HQ_ROOT || join(homedir(), 'agent-os-hq');
    const disabledAudit = writeAutonomousMergeDisabledAuditImpl({
      hqRoot,
      repoPath,
      prNumber,
      headSha: reviewState.headSha,
      path: wouldUseDaemonPath ? 'daemon-merge' : 'hammer-merge',
      eligibilityReasons: disabledEligibility.reasons,
      flagState: autonomousFlagState,
      reviewStateRow,
      reviewState,
      logger,
    });
    logger?.warn?.(
      `[watcher] autonomous merge execution disabled for ${repoPath}#${prNumber}` +
        `@${String(reviewState.headSha || '').slice(0, 12)}; ` +
        `would_path=${wouldUseDaemonPath ? 'daemon-merge' : 'hammer-merge'} ` +
        `audit=${disabledAudit?.written ? 'written' : disabledAudit?.reason || 'not-written'}`,
    );
    return withAmaDispatchMetadata(
      {
        dispatched: false,
        skipMergeAgent: true,
        reason: 'autonomous-merge-execution-disabled',
        autonomousMergeDisabled: {
          path: wouldUseDaemonPath ? 'daemon-merge' : 'hammer-merge',
          eligibilityReasons: disabledEligibility.reasons,
          flagState: autonomousFlagState,
          auditWritten: Boolean(disabledAudit?.written),
        },
      },
      { amaEnabled: true },
    );
  }

  let allowStaleReviewHeadHammerResume = false;
  let hamTerminalRemediationEvidenceOptions = null;
  let hamTerminalRemediationValidated = false;
  let nonReviewableHeadDeltaEvidence = null;
  const reviewedHeadIsStale = Boolean(
    reviewState.headSha &&
      currentPrHeadSha &&
      reviewState.headSha !== currentPrHeadSha,
  );
  // FIX (stale-review-head spin, #5053): run the own-commit suppression proof for
  // ANY stale reviewed head, NOT only the review-cycle-exhausted case. A hammer
  // remediation on a comment-only / non-blocking (settled but non-exhausted)
  // review also advances the head -> `stale-review-head` -> the eligibility miss
  // was never self-certifiable, so the no-dispatch "retain" tick spun unbounded (a
  // live 50-min stall). Dropping the `reviewCycleExhausted &&` guard lets the
  // own-commit proof arm for that case too. The SAFETY INVARIANT is unchanged: an
  // external push is authored by a non-closer committer, so
  // `getHeadCloserCommitSuppression` returns `suppressed:false` and
  // `allowStaleReviewHeadHammerResume` stays false -- an unreviewed human push can
  // never self-certify past the stale-head block.
  if (reviewedHeadIsStale) {
    try {
      const closerCommitSuppression = typeof resolveHeadCloserCommitSuppressionImpl === 'function'
        ? await resolveHeadCloserCommitSuppressionImpl({
            repoPath,
            prNumber,
            headSha: currentPrHeadSha,
          })
        : await getHeadCloserCommitSuppression({
            repoPath,
            prNumber,
            headSha: currentPrHeadSha,
            logger,
          });
      allowStaleReviewHeadHammerResume = closerCommitSuppression?.suppressed === true;
      if (
        allowStaleReviewHeadHammerResume &&
        closerCommitSuppression?.reason === 'closer-commit-trailer'
      ) {
        const verifiedCommit = await fetchHeadCloserVerifiedCommit({
          repoPath,
          prNumber,
          headSha: currentPrHeadSha,
          execFileImpl: execFileAsync,
          logger,
        });
        nonReviewableHeadDeltaEvidence = buildNonReviewableHeadDeltaEvidence({
          reviewedHead: reviewState.headSha,
          currentHead: currentPrHeadSha,
          verifiedCommit,
          suppression: closerCommitSuppression,
        });
      }
      if (
        allowStaleReviewHeadHammerResume &&
        typeof resolveHamTerminalRemediationEvidenceImpl === 'function'
      ) {
        const resolvedHamEvidence = await resolveHamTerminalRemediationEvidenceImpl({
          reviewState,
          prMetadata,
          repoPath,
          prNumber,
          execFileImpl: execFileAsync,
          closerCommitSuppression,
          logger,
        });
        if (
          resolvedHamEvidence?.hamTerminalRemediation &&
          resolvedHamEvidence?.hamTerminalRemediationGroundTruth
        ) {
          hamTerminalRemediationEvidenceOptions = resolvedHamEvidence;
          const hamEligibility = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
            env,
            hamTerminalRemediation: resolvedHamEvidence.hamTerminalRemediation,
            hamTerminalRemediationGroundTruth:
              resolvedHamEvidence.hamTerminalRemediationGroundTruth,
          });
          hamTerminalRemediationValidated =
            hamEligibility?.trace?.hamTerminalRemediation?.ok === true;
        }
      }
    } catch (err) {
      if (isTransientGhError(err)) {
        throw err;
      }
      logger?.warn?.(
        `[watcher] HAM stale-head resume proof failed for ${repoPath}#${prNumber} ` +
          `head=${String(currentPrHeadSha || '').slice(0, 12)}; not allowing hammer resume: ` +
          `${err?.message || err}`,
      );
    }
  }

  // SVD-02 — THIRD stale-verdict dismissal trigger (SEV
  // `docs/postmortems/SEV-stale-blocking-verdict-is-structurally-undismissable-2026-08-26.md`).
  //
  // The other two dismissal paths are both gated on a state that a standing
  // blocking verdict itself prevents: the reviewer-side one needs a NEW clean
  // `comment-only` review (policy says the final HAM remediation is FINAL — none
  // follows), and the daemon-owned one lives INSIDE the clean-merge attempt below,
  // past its live eligibility gate. So a PR whose final remediation resolved the
  // blocking finding parked at `CHANGES_REQUESTED` against a head no reviewer ever
  // judged, until an operator dismissed it by hand (#5918: 4.5h at MERGEABLE/CLEAN
  // with every required check green; #5811 earlier).
  //
  // This fires BEFORE the daemon clean path, on the one signal present in exactly
  // that case: a VALIDATED HAM terminal remediation at the current head, proven by
  // the same already-trusted primitives the merge path uses
  // (`resolveHamTerminalRemediationEvidence` ground truth above, or the durable
  // per-head `ham_terminal_remediation_validated` AMA audit marker). It grants NO
  // merge authority — the daemon attempt below still enforces every one of its own
  // gates. It only clears an obsolete verdict so that existing authority can act.
  //
  // HARD INVARIANT: a verdict whose `commit_id` EQUALS `currentPrHeadSha` is a LIVE
  // finding and is NEVER dismissed. Only a STRICTLY superseded head qualifies.
  const dismissStaleRequestChangesOnResolved =
    isDismissStaleRequestChangesOnResolvedEnabled({ env, logger });
  const standingBlockingFindingCount = Number(
    dispatchJob?.blockingFindingCount ?? reviewState.blockingFindingCount,
  ) || 0;
  if (
    dismissStaleRequestChangesOnResolved &&
    standingBlockingFindingCount > 0
  ) {
    await dismissSupersededBlockingVerdictAtRemediatedHeadImpl({
      repo: repoPath,
      prNumber,
      currentHeadSha: currentPrHeadSha || candidate?.headSha || null,
      hamTerminalRemediationValidated,
      authoritativeReviewerLogins,
      env,
      logger,
    });
  }

  // CI-SETTLEMENT MODEL — read this before hunting for a wait loop; there is
  // no blocking wait for CI anywhere in this tick, by design. When required
  // checks are PENDING (or not yet registered) on the candidate head:
  //   - the eligibility predicate reads `ci-not-green` (SPEC §4.2 #5), and
  //   - the daemon clean-path below returns disposition `not-taken`
  //     (its shared MSM-02 predicate requires COMPLETED+SUCCESS checks),
  // and the tick simply ends for this PR. The "settle loop" IS the watcher
  // poll loop (`config.pollIntervalMs`, default 300000 ms in config.json):
  // each tick re-fetches the rollup and re-runs this same function until the
  // checks settle one way or the other. The one place that DOES wait on CI is
  // the hammer worker itself — `ci-not-green` is a hammer-remediable miss, so
  // a hammer may be dispatched while checks are still pending, and its prompt
  // (templates/hammer-prompt.md, HAM remote-CI window) owns the bounded
  // remote-CI wait on the exact post-remediation head. Do not add an inline
  // CI wait here: a single tick must stay bounded or one slow PR head-blocks
  // every other PR in the poll.
  //
  // MSM-03 — daemon clean-path merge ("Path B"). Before the hammer
  // dispatch, attempt an inline daemon merge for a FULLY-CLEAN settled review
  // (zero blocking AND zero non-blocking findings) that GitHub reports green +
  // mergeable. STRICT (default on): any finding — or an unknown finding
  // classification — declines this path so the tick falls through to the
  // hammer dispatch below (MSM-04). No agent is spawned here; the daemon
  // clicks the button through the shared bounded merge-subprocess runner under
  // its own lease. Anything but `not-taken` means the daemon owns this tick:
  //   - merged        → PR landed, `daemon-merge` audit written, lease released.
  //   - failed-closed → took the path, failed closed; audit written, lease
  //                     released; NO hammer spawned (retry path never hammers).
  //   - deferred      → lease contention / audit bootstrap failure; retry next
  //                     tick with no double-merge.
  const daemonCleanMerge = await runDaemonCleanMergeAttemptImpl({
    rootDir,
    cfg,
    repoPath,
    prNumber,
    candidate,
    gateSnapshot,
    mergeabilityForGate,
    reviewState,
    reviewStateRow,
    currentPrHeadSha,
    // Deliverable 1 — the head-scoped operator labels that substitute for an
    // unresolved worker identity so a clean un-attributed PR closes under an
    // operator-accountable lease instead of parking `worker-identity-unresolved`.
    operatorApprovalEvent,
    mergeAgentRequestEvent,
    logger,
    env,
    authoritativeReviewerLogins,
    dismissStaleRequestChangesOnResolved,
    hamTerminalRemediationValidated,
  });
  if (daemonCleanMerge?.disposition && daemonCleanMerge.disposition !== DAEMON_MERGE_DISPOSITION.NOT_TAKEN) {
    const daemonHeadShort = String(gateSnapshot?.reviewedHeadSha || '').slice(0, 12);
    logger?.log?.(
      `[watcher] AMA daemon clean-merge ${daemonCleanMerge.disposition} for ${repoPath}#${prNumber}` +
        `@${daemonHeadShort}: ${daemonCleanMerge.reason}` +
        (daemonCleanMerge.attempts ? ` (attempts=${daemonCleanMerge.attempts})` : ''),
    );

    // Persist the park reason so `review-pipeline-health` can name it. Without
    // this the reason lives only in watcher stdout, and a parked PR surfaces as
    // a generic `terminal_but_unmerged` that lists candidate causes instead of
    // the one that applied (foundry#35, 8.8h on `worker-identity-unresolved`).
    // Diagnostics only — nothing reads these records to decide a merge.
    if (daemonCleanMerge.disposition === DAEMON_MERGE_DISPOSITION.MERGED) {
      clearDaemonMergePark({ rootDir, repo: repoPath, prNumber });
    } else {
      recordDaemonMergePark({
        rootDir,
        repo: repoPath,
        prNumber,
        headSha: gateSnapshot?.reviewedHeadSha || null,
        reason: daemonCleanMerge.reason || 'failed-closed',
      });
    }
    // Deliverable 2 — daemon-fail-closed hammer fallback. When the daemon
    // clean-path fails closed on a REMEDIABLE gate (ci-not-green, pr-not-mergeable
    // conflict, or stale-head) for an attributed fleet-worker PR, DO NOT park:
    // fall through to the SAME capped `maybeDispatchAmaCloser` hammer dispatch the
    // `not-taken` path uses. That hammer re-validates the required gate at the
    // post-remediation head and merges under its own lease, and every hammer
    // dispatch is bounded by the per-PR hammer-retry-cap (loud GBI operator alert
    // at the ceiling — never an uncapped re-dispatch). NON-remediable gates
    // (worker-identity-unresolved, verdict-not-eligible, lease-not-held) and
    // permanent/transient merge failures still park below.
    const daemonFailedClosed =
      daemonCleanMerge.disposition === DAEMON_MERGE_DISPOSITION.FAILED_CLOSED;
    const hammerRemediableFallback =
      daemonFailedClosed && isDaemonFailClosedHammerRemediable(daemonCleanMerge);
    if (hammerRemediableFallback) {
      const fallbackReasons = Array.isArray(daemonCleanMerge.reasons) ? daemonCleanMerge.reasons : [];
      logger?.log?.(JSON.stringify({
        schemaVersion: 1,
        event: 'ama.daemon_clean_fail_closed.hammer_fallback',
        repo: repoPath,
        pr: prNumber,
        headSha: gateSnapshot?.reviewedHeadSha || null,
        reason: daemonCleanMerge.reason,
        reasons: fallbackReasons,
        attempts: daemonCleanMerge.attempts || 0,
        hammerFallback: true,
      }));
      logger?.log?.(
        `[watcher] AMA daemon clean-merge fail-closed on a hammer-remediable gate for ` +
          `${repoPath}#${prNumber}@${daemonHeadShort} (${daemonCleanMerge.reason}` +
          (fallbackReasons.length ? `; gates=${fallbackReasons.join(',')}` : '') +
          `); routing to the capped hammer (re-validates the gate at head + merges ` +
          `under its own lease) instead of parking for manual close`,
      );
      // Fall through to the hammer dispatch below. Do NOT return here.
    } else {
      // LAC-1559 Fix 2: the daemon parks a fully-clean PR that failed closed with
      // no hammer fallback. Emit a distinct, queryable operator signal so the
      // superproject observability layer (ARR-02) can page on it rather than the
      // park being silent. The durable record is the daemon audit doc
      // (`manualCloseRequired` on the terminal attempt); this is the pageable
      // event. The merge decision is unchanged.
      if (daemonFailedClosed && daemonCleanMerge.manualCloseRequired) {
        // Surface the exact eligibility gate(s) that tripped (a stable subset of
        // {verdict-not-eligible|ci-not-green|pr-not-mergeable|stale-head|
        // lease-not-held}) so the operator page names WHY the clean PR could not
        // land instead of only the generic terminal `reason`. The daemon threads
        // these up on the fail-closed result; default to [] when absent.
        const parkReasons = Array.isArray(daemonCleanMerge.reasons) ? daemonCleanMerge.reasons : [];
        logger?.log?.(JSON.stringify({
          schemaVersion: 1,
          event: 'ama.daemon_clean_park.manual_close_required',
          repo: repoPath,
          pr: prNumber,
          headSha: gateSnapshot?.reviewedHeadSha || null,
          reason: daemonCleanMerge.reason,
          reasons: parkReasons,
          attempts: daemonCleanMerge.attempts || 0,
          hammerFallback: false,
        }));
        logger?.warn?.(
          `[watcher] AMA daemon clean PR PARKED — manual close required for ` +
            `${repoPath}#${prNumber}@${daemonHeadShort}: a zero-finding clean review ` +
            `could not be landed (${daemonCleanMerge.reason}` +
            (parkReasons.length ? `; gates=${parkReasons.join(',')}` : '') +
            `) and this terminal is not hammer-remediable. Operator must close ` +
            `manually; see the daemon-merge audit record.`,
        );
      }
      // Daemon owns this tick — skip BOTH the hammer dispatch and the merge-agent
      // path. `skipMergeAgent` routes the coexistence decision to `ama-pending`
      // so the watcher returns without dispatching anything.
      return withAmaDispatchMetadata(
        {
          dispatched: false,
          skipMergeAgent: true,
          reason: `daemon-${daemonCleanMerge.disposition}`,
          daemonCleanMerge,
        },
        { amaEnabled: true },
      );
    }
  }

  const [owner, name] = repoPath.split('/');
  // HMR-01: how long has this PR been TERMINAL and still unmerged?
  //
  // A settled comment-only verdict spawns no remediation rounds, so
  // `reviewCycleExhausted` can never flip for it and the hammer is structurally
  // unreachable (see isHammerRemediableEligibilityMiss). The operator contract is
  // Codex-first / Hammer-last, so the hammer must not fire on a FRESH comment-only
  // verdict -- only once the PR has sat terminal past the same grace that
  // `review:terminal_but_unmerged` already tickets on.
  //
  // `posted_at` is when the settled review landed. Null/unparseable yields null,
  // which leaves the downstream branch inert and behaviour exactly as before.
  const settledCommentOnlyTerminalMs = (() => {
    const verdict = String(gateSnapshot?.settledReview?.verdict || '').trim();
    if (verdict !== 'comment-only') return null;
    const postedAt = Date.parse(String(reviewStateRow?.posted_at || ''));
    if (!Number.isFinite(postedAt)) return null;
    return Math.max(0, Date.now() - postedAt);
  })();

  const dispatchContext = {
    settledCommentOnlyTerminalMs,
    rootDir,
    repo: repoPath,
    prUrl: `https://github.com/${owner}/${name}/pull/${prNumber}`,
    reviewedSha: reviewState.headSha,
    targetRemediationSha: currentPrHeadSha || reviewState.headSha,
    dispatchRecordHeadSha: reviewState.headSha,
    dispatchReason: reviewCycleExhausted ? 'exhausted-final-hammer' : null,
    allowStaleReviewHeadHammerResume,
    baseBranch: candidate?.baseBranch || candidate?.baseRefName || null,
    riskClass: reviewState.riskClass,
    requiredGateContext,
    reviewedBy: reviewStateRow?.reviewer_login || '',
    reviewer: reviewStateRow?.reviewer || '',
    authoritativeReviewerLogins,
    dismissStaleRequestChangesOnResolved: isDismissStaleRequestChangesOnResolvedEnabled({ env, logger }),
    parentSession: process.env.HQ_PARENT_SESSION || 'session:unknown:airlock+watcher',
    dispatchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    orchestrationMode,
  };

  let result;
  try {
    result = await maybeDispatchAmaCloserImpl({
      reviewState,
      prMetadata,
      cfg,
      options: {
        env: process.env,
        ...(nonReviewableHeadDeltaEvidence
          ? { nonReviewableHeadDelta: nonReviewableHeadDeltaEvidence }
          : {}),
        ...(hamTerminalRemediationEvidenceOptions || {}),
        adversarialMergeRequested: adversarialMergeRequestedEvent
          ? {
              applied: true,
              observedRevisionRef:
                adversarialMergeRequestedEvent.headSha ||
                adversarialMergeRequestedEvent.head_sha ||
                null,
              actor: adversarialMergeRequestedEvent.actor || null,
              eventId:
                adversarialMergeRequestedEvent.id ||
                adversarialMergeRequestedEvent.nodeId ||
                null,
              observedAt:
                adversarialMergeRequestedEvent.createdAt ||
                adversarialMergeRequestedEvent.created_at ||
                null,
            }
          : null,
      },
      dispatchContext,
      logger,
    });
  } catch (err) {
    logger?.warn?.(`[watcher] AMA dispatch failed: ${err?.message || err}`);
    return withAmaDispatchMetadata(
      { dispatched: false, reason: 'ama-dispatch-failed' },
      { amaEnabled: Boolean(cfg?.enabled) },
    );
  }
  // AMA-06N — expose `amaEnabled` so the watcher's coexistence
  // decision (downstream of this helper) can branch on it. The
  // upstream code paths (`cfg-load-failed`, `ama-disabled`) already
  // include the flag; this wraps the maybeDispatchAmaCloser return.
  return withAmaDispatchMetadata(result, { amaEnabled: true });
}

export async function resolveMergeAgentCoexistenceForWatcher({
  rootDir = ROOT,
  reviewStateRow,
  dispatchJob,
  candidate,
  labelNames,
  operatorApprovalEvent,
  mergeAgentRequestEvent,
  adversarialMergeRequestedEvent,
  repoPath,
  prNumber,
  currentRevisionRef,
  domainId = 'code-pr',
  logger,
  maybeDispatchAmaClosureForImpl = maybeDispatchAmaClosureFor,
}) {
  // BUG-1 dispatch-time terminal guard. `candidate` is the live PR read for
  // this tick (fetchMergeAgentCandidate). An already-MERGED PR needs no
  // AMA/merge-agent action. Without this, it flows into maybeDispatchAmaClosureFor
  // → the daemon clean-merge attempt fails closed (cannot merge an already-merged
  // PR) → `skipMergeAgent` → outcome `ama-pending`, so the watcher logs
  // "AMA hammer route retained ownership ... daemon-failed-closed" every tick
  // forever (observed on merged #639/#640/#642/#643/#3945). Drop ownership.
  //
  // MERGED-ONLY, deliberately not `closed`: this mirrors the SEV1 review-claim
  // guard's hard-won precedent (#643/#3946) — a merged PR is permanently
  // terminal, but a `closed` PR can be REOPENED, so treating closed as terminal
  // risks dropping a PR that is about to come back. Merged is the observed
  // retention case; a closed PR stays on its existing eligibility path.
  const liveMerged =
    candidate?.merged === true || String(candidate?.prState || '').toLowerCase() === 'merged';
  if (liveMerged) {
    return { outcome: 'pr-terminal', terminalReason: 'merged' };
  }
  const amaClosureResult = await maybeDispatchAmaClosureForImpl({
    rootDir,
    reviewStateRow,
    dispatchJob,
    candidate,
    labelNames,
    operatorApprovalEvent,
    // Deliverable 1 — thread the operator merge-agent-requested label event into
    // the closure dispatch so the daemon path can substitute it for an unresolved
    // worker identity (head-scoped) instead of parking.
    mergeAgentRequestEvent,
    adversarialMergeRequestedEvent,
    repoPath,
    prNumber,
    currentRevisionRef,
    domainId,
    logger,
  });
  if (amaClosureResult?.dispatched) {
    return { outcome: 'ama-dispatched', amaClosureResult };
  }
  if (amaClosureResult?.skipMergeAgent) {
    // FIX (stale-review-head spin, #5053): the `not-eligible` retain shape is the
    // ONLY skipMergeAgent case that can spin unbounded — every other reason
    // (daemon-merged, hammer-retry-cap-exhausted, autonomous-merge-disabled, …) is
    // already terminal or operator-facing. Cap consecutive `not-eligible` retains
    // on the SAME head: after AMA_RETAIN_LOOP_CAP of them, stop returning
    // `ama-pending` (which the watcher re-polls forever) and route to
    // AWAIT_OPERATOR_ACTION so the escalation in `coexistence.mjs` becomes
    // reachable. A new head resets the counter (recordAmaRetain is head-keyed), so a
    // legitimately progressing PR is never falsely escalated.
    if (amaClosureResult?.reason === 'not-eligible') {
      const retainHead = currentRevisionRef || candidate?.headSha || dispatchJob?.headSha || null;
      // Cap this series against THIS job's resolved remediation budget rather
      // than the module default, so an operator who raises (or lowers) the round
      // budget moves the retain cap with it. `remediationPlan.maxRounds` is the
      // already-resolved effective budget for the job; when it is absent the
      // derivation falls back to the medium default, which is the value this
      // call site used before the budget was coupled.
      const retain = recordAmaRetain(rootDir, { repo: repoPath, prNumber }, {
        headSha: retainHead,
        cap: amaRetainLoopCapFor(dispatchJob?.remediationPlan?.maxRounds),
        now: new Date().toISOString(),
        logger,
      });
      if (retain.capExceeded) {
        logger?.warn?.(
          `[watcher] AMA retain-loop cap reached for ${repoPath}#${prNumber}` +
            `@${String(retainHead || 'unknown').slice(0, 12)}: ${retain.retainCount} ` +
            `consecutive not-eligible retains on the same head (cap ${retain.cap}). ` +
            `This PR cannot self-resolve — routing to AWAIT_OPERATOR_ACTION. Operator: ` +
            `apply the 'operator-approved' label to force past stale-review-head, or ` +
            `close/repair the PR. A new head resets the counter.`,
        );
        logger?.log?.(JSON.stringify({
          schemaVersion: 1,
          event: 'ama.retain_loop_cap_reached',
          repo: repoPath,
          pr: prNumber,
          headSha: retainHead,
          retainCount: retain.retainCount,
          cap: retain.cap,
          amaReason: amaClosureResult?.reason || null,
          amaReasons: Array.isArray(amaClosureResult?.reasons) ? amaClosureResult.reasons : [],
        }));
        return {
          outcome: 'await-operator',
          amaClosureResult,
          coexistence: { action: COEXISTENCE_ACTION.AWAIT_OPERATOR_ACTION },
          retainLoopCap: { retainCount: retain.retainCount, cap: retain.cap, headSha: retainHead },
        };
      }
    }
    return { outcome: 'ama-pending', amaClosureResult };
  }

  const amaEnabled = Boolean(amaClosureResult?.amaEnabled);
  const amaClosureEligibilityMiss = amaClosureResult?.reason === 'not-eligible';
  const amaClosureRecoverableFailure = amaEnabled
    && !amaClosureResult?.dispatched
    && !amaClosureResult?.skipMergeAgent
    && !amaClosureEligibilityMiss;
  const mergeAgentRequestedScoped = isMergeAgentRequestedScoped(
    mergeAgentRequestEvent,
    {
      headSha: currentRevisionRef || candidate?.headSha || dispatchJob?.headSha || null,
      prUpdatedAt: candidate?.prUpdatedAt || dispatchJob?.prUpdatedAt || null,
    },
  );
  const coexistence = decideMergeAgentCoexistence({
    amaEnabled,
    amaClosureDispatched: Boolean(amaClosureResult?.dispatched),
    amaClosurePending: Boolean(amaClosureResult?.skipMergeAgent),
    amaClosureEligibilityMiss,
    amaClosureRecoverableFailure,
    mergeAgentRequestedScoped,
  });

  if (coexistence.action === COEXISTENCE_ACTION.AWAIT_OPERATOR_ACTION) {
    return { outcome: 'await-operator', amaClosureResult, coexistence };
  }
  return {
    outcome: 'dispatch-merge-agent',
    amaClosureResult,
    coexistence,
    dispatchEnv: mergeAgentDispatchEnvForAction(coexistence.action),
  };
}
