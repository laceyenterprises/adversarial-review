// ARC-18: extracted per-PR processing phase of pollOnce (watcher.mjs).
//
// `processReviewSubject` is the body of the per-PR loop that pollOnce runs for
// every discovered subject: route + fast-merge-skip evaluation, claim CAS,
// reviewer dispatch/spawn, and settle. It is called once per subject entry from
// pollOnce's per-domain/per-repo loop. The behavior is byte-for-byte the former
// inline loop body; the only control-flow change is that the loop's `continue`
// statements became `return` (each invocation processes exactly one subject, so
// `return` ends this subject the way `continue` advanced the loop).
//
// State the phase reads and mutates is threaded through `ctx` (queues, counters,
// per-tick config, the octokit handle, operator surface, and watcher-owned
// helpers/constants). Leaf helpers and prepared statements are imported directly
// from their owning modules — this module never imports watcher.mjs (no cycle).

import { randomUUID } from 'node:crypto';
import {
  MERGE_AGENT_DISPATCHED_LABEL,
  OPERATOR_APPROVED_LABEL,
  legacyLabelEventFromControlResult,
} from './adapters/operator/github-pr-label-controls/index.mjs';
import {
  FAST_MERGE_CATEGORY_BY_LABEL,
  buildFastMergeAuditEntry,
  evaluateFastMergeDiffShape,
  fastMergeDecisionFromLabels,
  fetchFastMergeAuthorizationFromTimeline,
  fetchFastMergeChangedFiles,
  fetchLivePRHeadSha,
  fetchLivePRLabels,
  writeFastMergeAuditEntry,
  writeFastMergeAuditPayload,
} from './adapters/subject/github-pr/fast-merge.mjs';
import {
  applyEffectiveReviewerRoute,
  describeCrossModelReviewWaiver,
  REVIEWER_ROUTE_BY_MODEL,

  routeSubject,
} from './adapters/subject/github-pr/routing.mjs';
import { projectAdversarialGateStatus } from './adversarial-gate-status.mjs';
import { amaAuthoritativeReviewerLoginsForModel } from './ama/reviewer-authority.mjs';
import {
  ARGUS_SECURITY_QUEUED_STATUS,
  LEGACY_UNROUTABLE_BOT_STATUS,
  isArgusSecurityRouteEnabled,
  routeSecuritySurfaceToArgus,
} from './argus-security-route.mjs';
import { isUnroutableBotAuthor } from './bot-author.mjs';
import { loadConfigCached } from './config-loader.mjs';
import { isPipelineEnabled } from './domain-pipeline.mjs';
import {
  markFastMergeAuditError,
  markFastMergeAuditWritten,
} from './fast-merge-audit-recovery.mjs';
import { maybeInlineFinalHammerAfterReview } from './final-to-hammer-handoff.mjs';
import {
  applyReviewerWorkerClassFallbackToRoute,
  resolveReviewerWorkerClassWithFallback,
  reviewWorkerClassFallback,
} from './review-worker-class-fallback.mjs';
import {
  fetchReviewsForHeadForDedup,
  getStalePostedReviewBudgetSuppression,
  isExplicitOperatorReviewRetrigger,
  resolveFirstPassReviewBudgetSuppression,
} from './first-pass-review-suppression.mjs';
import {
  resolveRoundBudgetForJob,
  summarizePRRemediationLedger,
} from './follow-up-jobs.mjs';
import {
  RETRIGGER_REMEDIATION_LABEL,
  tryRetriggerRemediationFromLabel,
} from './follow-up-retrigger-label.mjs';
import {
  RETRIGGER_REVIEW_LABEL,
  tryRetriggerReviewFromLabel,
} from './follow-up-retrigger-review-label.mjs';
import { fetchPullRequestHeadAndState } from './github-api.mjs';
import {
  createHeadCloserCommitSuppressionResolver,
  getHeadCloserCommitSuppressionWithBoundedRetry,
} from './head-closer-commit-suppression.mjs';
import { handlePostedReviewRow } from './posted-review-row.mjs';
import {
  QUOTA_EXHAUSTED_FAILURE_CLASS,
  quotaHoldDecision,
} from './quota-exhaustion.mjs';
import {
  countReviewCeilingAttempts,
  countReviewCeilingUnits,
} from './review-ceiling-metrics.mjs';
import {
  addLabelToPRBestEffort,
  clearReviewCycleCapForOverride,
  isAutomaticReviewCycleCapPause,
  isReviewCycleCapFailedRow,
  postReviewCycleCapEscalation,
  shouldClearReviewCycleCapForOverride,
  subjectRefWithLinearTicket,
} from './review-cycle-cap-actions.mjs';
import {
  PAUSED_FOR_REDESIGN_LABEL,
  REVIEWER_CYCLE_CAP_REACHED_LABEL,
  buildReviewCycleCapEscalationComment,
  markReviewCycleEscalated,
  recentReviewCycleVerdicts,
  resolveReviewCycleCapConfig,
  shouldEscalateReviewCycle,
} from './review-cycle-cap.mjs';
import {
  db,
  stmtCreateFastMergeSkippedReviewRow,
  stmtCreateReviewRow,
  stmtFinalizePendingTerminalFailure,
  stmtGetReviewRow,
  stmtMarkAttemptStarted,
  stmtMarkClosed,
  stmtMarkInfraAutoRecoveryAttemptStarted,
  stmtMarkArgusSecurityQueued,
  stmtMarkMalformed,
  stmtMarkUnroutableBot,
  stmtRecordArgusClassifiedHead,
  stmtMarkMerged,
  stmtMarkMergedPendingReviewSkipped,
  stmtMarkReviewCycleCapPaused,
  stmtMarkReviewPopulationRetryAttemptStarted,
  stmtMarkReviewerCommandFailedRecoveredPosted,
  stmtMarkUnknownFailureRetryAttemptStarted,
  stmtReleaseReviewerClaim,
  stmtRestoreReviewedHeadDedupSuppressedReviewPosted,
  stmtRestoreSameHeadSuppressedReviewPosted,
  stmtUpdateReviewLabels,
  stmtUpdateReviewRouting,
} from './review-state-db.mjs';
import { requestReviewRereview } from './review-state.mjs';
import {
  buildDuplicateReviewSkipAudit,
  headDispatchLeaseKey,
  resolveAlreadyReviewedHeadDedup,
  restorePendingReviewedHeadDedupRow,
} from './reviewed-head-dispatch-gate.mjs';
import {
  markCascadeCapExhaustedAlerted,
  recordCascadeFailure,
  shouldBackoffReviewerSpawn,
} from './reviewer-cascade.mjs';
import { reconcileReviewerCommandFailedBeforeRetry } from './reviewer-command-failed-recovery.mjs';
import {
  infraRecoverableFailureClass,
  unknownReviewerCommandFailureClass,
} from './reviewer-failure-classification.mjs';
import { nextReviewerPassAttemptNumber } from './reviewer-pass-tokens.mjs';
import { computeReviewerLeaseExpiryAt } from './reviewer-lease.mjs';
import {
  persistReviewerPgid,
  settleDurableReviewerRunState,
} from './reviewer-orphan-reconcile.mjs';
import { reviewerBotLogin } from './reviewer-reattach.mjs';
import {
  applyAfhReviewerRouteForAttempt,
  primaryReviewerQuotaCappedForRow,
  resolveGeminiReviewerModeForWatcher,
  reviewPopulationRetryDecision,
  selectReviewerRouteForAttempt,
  shouldBypassPrimaryReviewerQuotaHold,
} from './reviewer-route-selection.mjs';
import {
  createAfhReviewerGroundingCache,
  describeAfhReviewerFallback,
} from './afh-reviewer-fallback.mjs';
import {
  evaluateRoundBudgetForReview,
  parsePipelineStageStates,
  runWatcherGatedReviewPipeline,
  settleReviewerAttempt,
  spawnReviewer,
} from './reviewer-spawn-settle.mjs';
import { maybeDispatchReviewerTimeoutExhaustedMergeAgent } from './reviewer-timeout-exhausted-dispatch.mjs';
import { resolveReviewerTimeoutMs } from './reviewer-timeout.mjs';
import { resolveReviewPopulationRetryConfig } from './role-config.mjs';
import { shouldSkipReviewerForStaleDrift } from './stale-drift.mjs';
import { getStalePostedReviewAutoRereviewSuppression } from './stale-posted-review-rereview.mjs';
import { computeVocabularyFatigueFindingForPR } from './vocabulary-fatigue.mjs';
import { signalMalformedTitleFailure } from './watcher-fail-loud.mjs';
import { reserveReviewerMemoryAdmission } from './watcher-reviewer-pool.mjs';

// MAL-01: a PR that carries no worker prefix is not necessarily MALFORMED.
//
// `routeSubject` returns no route when the title has no creation-time worker
// prefix, and every such PR was then recorded `review_status='malformed'` with
// the message "Malformed PR title: <title>". For a fleet worker that skipped
// `hq pr open`, that is accurate and actionable: fix the title.
//
// For a bot it is a category error. Dependabot owns its own titles
// (`chore(deps): bump X from A to B`) and can never carry a worker prefix, so
// the finding is unfixable by construction, and retitling would break
// Dependabot's own update flow.
//
// Measured 2026-08-24: of 51 malformed rows in reviews.db, 33 (65%) were
// `chore(deps...` bot PRs. Every Dependabot PR is silently excluded from review
// AND generates a permanent `review:malformed_pr_title` ticket that no operator
// action can clear.
//
// This records them under a distinct status so they stop asserting a defect that
// does not exist. It deliberately did NOT decide what SHOULD review a dependency
// PR — that is ASR-04, below.
// The predicate itself moved to the pure leaf `bot-author.mjs` (ASR-02) so the
// security-surface classifier can share this exact login set without importing
// this module, which opens `reviews.db` at module scope. Re-exported here
// because the semantics remain part of this module's malformed-vs-bot decision
// and callers/tests already import it from here.
export { isUnroutableBotAuthor };

/**
 * ASR-04 — record that Argus owns this PR.
 *
 * Shared by the two writers (first classification in the unroutable branch, and
 * recovery of a legacy row in the dispatch loop) so the row shape cannot drift
 * between them.
 */
export function markArgusSecurityQueuedRow({
  repoPath,
  prNumber,
  reasonSummary = '',
  at = new Date().toISOString(),
  statement = stmtMarkArgusSecurityQueued,
} = {}) {
  statement.run(
    `Routed to the Argus security queue (${reasonSummary || 'no trigger'}).`,
    at,
    repoPath,
    prNumber
  );
  return ARGUS_SECURITY_QUEUED_STATUS;
}

// ASR-04 — the disposition for a PR whose title carries no worker prefix.
//
// Renamed from `markMalformedTitleTerminalState`, because it no longer always
// writes terminal state and a name that says it does would hide the exact
// property this ticket exists to establish: a bot PR is now ROUTED, and routed
// rows stay live.
//
// Three outcomes, and the boundary between them is the whole ticket:
//
//   malformed              A HUMAN PR with a bad title prefix. Unchanged, and
//                          deliberately so — that finding is accurate and
//                          actionable ("fix your title"), and blurring it into
//                          the bot branch would destroy the distinction the bot
//                          branch was created to make.
//   argus-security-queued  A bot PR whose security review is ON THE QUEUE. Not
//                          terminal.
//   deferred               A bot PR the enqueue could not confirm this tick (no
//                          head yet, or the queue write failed). Writes NOTHING.
//                          Writing terminal here is the bug: the row keeps its
//                          non-terminal status and the next tick retries. A PR
//                          the route could not process is a PR the route has not
//                          finished with, not a PR it has refused.
//
// The `unroutableBot && !argusRouteEnabled` case is the kill switch, and it is
// the ONLY remaining writer of the terminal bot status. It logs every time.
export function markUnroutableTitleDisposition({
  prTitle,
  failureAt,
  repoPath,
  prNumber,
  unroutableBot = false,
  argusRouteEnabled = true,
  argusSecurityQueued = false,
  argusReasonSummary = '',
  markMalformedStatement = stmtMarkMalformed,
  markUnroutableBotStatement = stmtMarkUnroutableBot,
  markArgusSecurityQueuedStatement = stmtMarkArgusSecurityQueued,
  logger = console,
} = {}) {
  if (unroutableBot) {
    if (argusSecurityQueued) {
      return markArgusSecurityQueuedRow({
        repoPath,
        prNumber,
        reasonSummary: argusReasonSummary,
        at: failureAt,
        statement: markArgusSecurityQueuedStatement,
      });
    }
    if (!argusRouteEnabled) {
      logger.warn?.(
        `[watcher] ARGUS_ROUTE_DISABLED ${repoPath}#${prNumber}: ` +
          'ADVERSARIAL_ARGUS_SECURITY_ROUTE is off, so this bot-authored PR is going ' +
          'terminal `unroutable-bot-author` and no security review will be queued for it'
      );
      markUnroutableBotStatement.run(
        `Unroutable bot-authored PR (no worker prefix is possible): ${prTitle}`,
        failureAt,
        failureAt,
        repoPath,
        prNumber
      );
      return LEGACY_UNROUTABLE_BOT_STATUS;
    }
    return 'deferred';
  }
  markMalformedStatement.run(
    `Malformed PR title: ${prTitle}`,
    failureAt,
    failureAt,
    repoPath,
    prNumber
  );
  return 'malformed';
}


// AFH-04 — one bounded `hq fleet quota status --json` read per TTL window (not
// one per PR) feeding the ordered reviewer fallback. Constructing the cache is
// pure (a closure; no I/O until first call), so it lives at module scope rather
// than growing watcher.mjs, which is under a hard ARC-18 line ratchet. Tests and
// alternate schedulers override it by passing `getAfhReviewerGroundingForTick`
// in ctx. Disable the whole hop with ADVERSARIAL_AFH_REVIEWER_FALLBACK=0.
const defaultAfhReviewerGroundingForTick = createAfhReviewerGroundingCache();

// A terminal reviewer failure does NOT always land as review_status='failed'.
//
// When reviewer lease recovery is enabled, settleReviewerFailure writes
// stmtReleaseReviewLease instead of stmtMarkFailed, and the two differ in
// exactly the field every retry cap below keys on:
//
//   stmtMarkFailed          SET review_status = 'failed' , review_attempts += 1
//   stmtReleaseReviewLease  SET review_status = 'pending', review_attempts += 1
//
// Both set failed_at and failure_message; only the status differs. So with lease
// recovery on, review_attempts kept incrementing while NO gate ever read it,
// because each gate required review_status === 'failed'. The attempt counter
// became decorative and the reviewer respawned forever on an input that could
// never succeed.
//
// agent-os#5486: 138 consecutive spawns, all on the same head dbc9e5b3b1bf, all
// failure-class=unknown, zero verdicts ever posted, and zero "retry cap
// exhausted" lines despite a cap of 3.
//
// The head check is what keeps this narrow: a lease-released row whose head has
// MOVED is a legitimate fresh review and must not inherit the old attempt count.
// Only a released row still pointing at the same head it already failed on is a
// crash loop.
export function reviewRowInTerminalFailureState(row, currentHeadSha) {
  if (!row) return false;
  if (row.review_status === 'failed') return true;
  if (row.review_status !== 'pending') return false;
  if (!row.failed_at) return false;
  if (!(Number(row.review_attempts || 0) > 0)) return false;
  const rowHead = row.reviewer_head_sha || null;
  if (!rowHead || !currentHeadSha) return false;
  return String(rowHead) === String(currentHeadSha);
}

export function finalizePendingTerminalFailureState(row, {
  markTerminalPendingFailure = stmtFinalizePendingTerminalFailure,
} = {}) {
  if (!row || row.review_status !== 'pending') return 0;
  if (!row.repo || row.pr_number === undefined || row.pr_number === null) return 0;
  if (!row.failed_at || !row.reviewer_head_sha) return 0;
  return markTerminalPendingFailure.run(
    row.repo,
    row.pr_number,
    row.failed_at,
    row.failure_message ?? null,
    row.reviewer_head_sha,
  ).changes;
}

const REVIEWER_WORKER_CLASS_BY_MODEL = Object.freeze({
  claude: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  gemini: 'gemini',
});

function reviewerWorkerClassForRoute(route) {
  const explicit = String(route?.reviewerWorkerClass || route?.workerClass || '').trim().toLowerCase();
  if (explicit) return explicit;
  const reviewerModel = String(route?.reviewerModel || '').trim().toLowerCase();
  return REVIEWER_WORKER_CLASS_BY_MODEL[reviewerModel] || reviewerModel;
}


export async function processReviewSubject(entry, ctx) {
  const { subject, prNumber, current: cachedCurrent } = entry;
  const {
    octokit,
    operatorSurface,
    healthProbe,
    healthTick,
    afterClaim,
    watcherDrain,
    reviewerPoolConfig,
    reviewerMemoryPressureConfig,
    reviewerDispatchCandidates,
    postedReviewHandlers,
    reviewerMemoryReservationState,
    reviewerMemoryAdmissionSampleForTick,
    getRoutingTierReadinessForTick,
    getAfhReviewerGroundingForTick,
    reviewerCommandFailedReviewProbe,
    domainId,
    domainReviewerRuntimeAdapter,
    domainAdapterSet,
    owner,
    repo,
    repoPath,
    activeMergeAgentPRs,
    currentRepoPRs,
    ROOT,
    execFileAsync,
    WATCHER_PRIMARY_DOMAIN_ID,
    reviewerHeadDispatchLease,
    INFRA_AUTO_RECOVER_CAP,
    REVIEW_UNKNOWN_FAILURE_MAX_RETRIES,
    QUOTA_EXHAUSTED_BACKOFF_MS,
    withApiTelemetry,
    handlePollError,
    markWatcherReviewHeartbeat,
    markWatcherSpawnDecision = () => {},
    deliverAlertFn,
    resolveHardReviewCeiling,
    resolveHardReviewAttemptCeiling,
    reconcilePendingDraftsBeforeSpawn,
    resolvePendingDraftRespawnAgeSeconds,
    isFastMergeSkipEnabled,
    normalizeReviewPopulationRetryConfig,
    shouldDeferReviewForActiveFollowUp,
  } = ctx;

      const prTitle = subject.title || '';
      const linearTicketId = operatorSurface.extractLinearTicketId(prTitle);
      const staleDriftSkip = shouldSkipReviewerForStaleDrift({
        number: prNumber,
        labels: subject.labels,
      });
      const prLabelNames = (Array.isArray(subject.labels) ? subject.labels : [])
        .map((l) => (typeof l === 'string' ? l : l?.name || ''))
        .filter(Boolean);
      if (subject.headSha) {
        currentRepoPRs.push({
          repo: repoPath,
          prNumber,
          headSha: subject.headSha,
          labels: subject.labels,
        });
      }
      if (prLabelNames.includes(MERGE_AGENT_DISPATCHED_LABEL)) {
        activeMergeAgentPRs.push({ repo: repoPath, prNumber, headSha: subject.headSha || null });
      }
      if (staleDriftSkip) {
        console.log(staleDriftSkip.message);
        return;
      }
      let existing = cachedCurrent ?? stmtGetReviewRow.get(repoPath, prNumber);
      // ARC-03 review finding: review rows are keyed (repo, pr) but carry a
      // domain identity. Only the owning domain may process a row — without
      // this guard, a second github-pr domain would drive another domain's
      // record through its own handlers (gate/identity corruption, duplicate
      // downstream actions). A non-owning domain skips the PR this tick.
      if (
        existing &&
        String(existing.domain_id || WATCHER_PRIMARY_DOMAIN_ID) !== String(domainId)
      ) {
        return;
      }
      async function projectGateStatusSafe(reviewRow) {
        if (!subject.headSha) return null;
        try {
          const operatorApproval = prLabelNames.includes(OPERATOR_APPROVED_LABEL)
            ? await operatorSurface.observeOperatorApproved(
              subject.ref,
              subject.ref.revisionRef
            )
            : null;
          const operatorApprovalEvent = legacyLabelEventFromControlResult(
            operatorApproval,
            OPERATOR_APPROVED_LABEL
          );
          const projected = await projectAdversarialGateStatus(ROOT, {
            repo: repoPath,
            prNumber,
            headSha: subject.headSha,
            labels: subject.labels,
            prUpdatedAt: subject.updatedAt || null,
            prAuthor: subject.authorRef || null,
            reviewRow,
            execFileImpl: execFileAsync,
            operatorApprovalEvent,
            domainId,
          });
          // The suffix is load-bearing, not decoration. `success (remediation-stopped)`
          // reads as convergence in a log skim, but it means the pipeline gave up with
          // findings still standing. Anyone (human or agent) grepping this line for
          // "success" must see that the merge is theirs to justify.
          console.log(
            `[watcher] adversarial gate for ${repoPath}#${prNumber}: ${projected.decision.state}` +
              ` (${projected.decision.reason})` +
              (projected.decision.operatorDecisionRequired
                ? ' — NOT CONVERGED: findings unresolved, operator decision required'
                : '')
          );
          return projected;
        } catch (err) {
          console.error(
            `[watcher] adversarial gate projection failed for ${repoPath}#${prNumber}:`,
            err?.message || err
          );
          return null;
        }
      }

      if (
        existing?.pr_state === 'merged' &&
        (
          existing.review_status === 'pending' ||
          existing.review_status === 'pending-upstream' ||
          existing.review_status === 'reviewing'
        )
      ) {
        const settledAt = existing.merged_at || new Date().toISOString();
        const result = stmtMarkMergedPendingReviewSkipped.run(
          'Skipped reviewer spawn because PR is already merged.',
          settledAt,
          repoPath,
          prNumber
        );
        if (result.changes === 1) {
          console.log(
            `[watcher] merged pending review for ${repoPath}#${prNumber} marked skipped; no reviewer spawn needed`
          );
          existing = stmtGetReviewRow.get(repoPath, prNumber);
        }
      }

      if (existing?.pr_state === 'merged') {
        await projectGateStatusSafe(existing);
        return;
      }

      // ASR-04 — classify this head's security surface and enqueue an Argus
      // review if any trigger fires. Never throws, never changes control flow,
      // never writes a terminal row.
      //
      // The drain and terminal guards live here rather than at the call sites so
      // both callers get them: a draining watcher starts no new work, and a
      // merged/closed PR is not work at all (the pipeline has been burned before
      // by daemons acting on already-terminal PRs).
      const argusRouteEnabled = isArgusSecurityRouteEnabled(process.env);
      async function routeSecuritySurfaceSafe(reviewRow) {
        if (!argusRouteEnabled) return null;
        if (subject.terminal || watcherDrain.active) return null;
        if (reviewRow?.pr_state === 'merged' || reviewRow?.pr_state === 'closed') return null;
        try {
          const routed = await routeSecuritySurfaceToArgus({
            rootDir: ROOT,
            repoPath,
            prNumber,
            headSha: subject.headSha || subject.ref?.revisionRef || null,
            authorRef: subject.authorRef || null,
            lastClassifiedHeadSha: reviewRow?.argus_classified_head_sha || null,
            // A `null` return means the fetch FAILED; the route keeps that
            // distinct from an empty diff. The adapter's own warning is
            // suppressed because its text names the fast-merge path, which is
            // not why we are reading the file list here.
            fetchChangedFiles: () => fetchFastMergeChangedFiles(octokit, {
              owner,
              repo,
              prNumber,
              withApiTelemetry,
              logger: { warn: () => {} },
            }),
          });
          // The memo only sticks if the row exists yet. When it does not (first
          // tick of a brand-new PR), this is a no-op and the next tick
          // re-classifies — one extra file-list read, never a skipped review.
          if (routed.recordClassifiedHead && routed.headSha) {
            stmtRecordArgusClassifiedHead.run(routed.headSha, repoPath, prNumber);
          }
          return routed;
        } catch (err) {
          // Belt and braces on top of the route's own internal handling: an
          // additive security hop must not be able to abort the review tick.
          console.error(
            `[watcher] argus security route threw for ${repoPath}#${prNumber}: ${err?.message || err}`
          );
          return null;
        }
      }

      // ASR-04 — a PR the Argus security route owns.
      //
      // This is NOT the terminal early-return below it. The row is live, and its
      // per-tick job is to keep the queue bound to the CURRENT head: a security
      // review is a statement about the exact tree it read, so a new head has to
      // re-enqueue. The dispatch loop still has nothing to do — no worker prefix
      // still means no adversarial reviewer — so it projects the gate and returns
      // exactly as the terminal statuses do.
      //
      // The legacy status is folded into the same branch on purpose: that fold IS
      // the recovery. #909 and #910 are rows stuck in it, and self-healing them
      // here means the fix reaches every stranding on the next tick after deploy —
      // including one a reopened PR drags back into the open set months from now,
      // which a one-shot backfill would miss. `npm run argus:backfill` is the
      // immediate operator lever; this branch is the durable guarantee.
      if (
        existing?.review_status === ARGUS_SECURITY_QUEUED_STATUS ||
        (argusRouteEnabled && existing?.review_status === LEGACY_UNROUTABLE_BOT_STATUS)
      ) {
        const routed = await routeSecuritySurfaceSafe(existing);
        // Re-stamp the row when it is still carrying the legacy status, and when
        // a genuinely new job was created so `last_attempted_at` and the note
        // describe the head actually queued. A duplicate on an unchanged head
        // writes nothing.
        if (
          routed?.queued
          && (existing.review_status !== ARGUS_SECURITY_QUEUED_STATUS || routed.outcome === 'enqueued')
        ) {
          markArgusSecurityQueuedRow({
            repoPath,
            prNumber,
            reasonSummary: routed.summary,
          });
          existing = stmtGetReviewRow.get(repoPath, prNumber);
        }
        await projectGateStatusSafe(existing);
        return;
      }

      // 'failed-orphan' is only eligible through the guarded auto-reclaim pass
      // at the top of the tick (expired lease + no live reviewer process) or
      // the explicit operator reset path. The generic PR dispatch loop must
      // still skip any failed-orphan row that reaches this point.
      //
      // `unroutable-bot-author` stays listed for the kill-switch case only: with
      // ADVERSARIAL_ARGUS_SECURITY_ROUTE off, the branch above declines the row
      // and it must keep the pre-ASR-04 terminal behaviour it was written under.
      if (
        existing?.review_status === 'malformed' ||
        existing?.review_status === 'unroutable-bot-author' ||
        existing?.review_status === 'failed-orphan'
      ) {
        await projectGateStatusSafe(existing);
        return;
      }

      if (subject.terminal) {
        return;
      }

      // ASR-04 — ADDITIVE, and this is the half of the ticket that is easiest to
      // lose. A HUMAN PR that bumps a dependency carries the same supply-chain
      // risk as a bot one, so the manifest trigger routes on the FILE, not the
      // author: this runs for every open, routable PR too.
      //
      // The result is deliberately unused except by the unroutable branch far
      // below. Argus reviews the dependency surface; it does not divert or
      // replace the code review, and a manifest-touching human PR gets BOTH.
      //
      // Placed here — before the label-control and posted-review hops, each of
      // which can return early — so no PR loses its security classification to a
      // branch taken for an unrelated reason. Cost is one file-list read per new
      // head, memoized in `argus_classified_head_sha`; a steady-state tick spends
      // no GitHub calls here at all.
      const argusOutcome = await routeSecuritySurfaceSafe(existing);

      // PR-side `retrigger-remediation` label (post-2026-05-06):
      // mobile-friendly operator surface that mirrors
      // `npm run retrigger-remediation`. Operator applies the label
      // on a halted PR; watcher detects it here, bumps maxRounds,
      // requeues the latest follow-up job, and removes the label.
      // Active jobs leave the label in place for the next tick.
      if (prLabelNames.includes(RETRIGGER_REMEDIATION_LABEL)) {
        try {
          const labelControl = await operatorSurface.observeLabelControl(
            subject.ref,
            subject.ref.revisionRef,
            RETRIGGER_REMEDIATION_LABEL
          );
          const labelEvent = legacyLabelEventFromControlResult(
            labelControl,
            RETRIGGER_REMEDIATION_LABEL
          );
          const result = await tryRetriggerRemediationFromLabel({
            rootDir: ROOT,
            repo: repoPath,
            prNumber,
            labelActor: labelEvent?.actor || 'unknown',
            labelEvent,
            revisionRef: subject.ref.revisionRef,
            execFileImpl: execFileAsync,
          });
          console.log(
            `[watcher] retrigger-remediation label on ${repoPath}#${prNumber}: ${result.outcome}` +
              (result.detail ? ` (${result.detail})` : '')
          );
        } catch (err) {
          console.error(
            `[watcher] retrigger-remediation label processing failed for ${repoPath}#${prNumber}:`,
            err?.message || err
          );
        }
      }

      // PR-side `retrigger-review` label (post-2026-05-16 refactor):
      // any actor with PR-label permission (operator, merge-agent,
      // codex/claude-code worker) can request a one-shot fresh
      // adversarial review on the current HEAD by applying the label.
      // The watcher resets the review row to 'pending' (so the next
      // tick re-reviews), removes the label, and posts an ack comment.
      // No remediation budget bump; no follow-up-job requeue. The
      // fresh review verdict drives the downstream merge-agent vs
      // remediation decision normally.
      //
      // Before this refactor, `retrigger-review` was a write-only marker
      // applied by merge-agent.sh with no consumer — the label add was
      // a noop and the merge-agent's `apply_retrigger_review_label`
      // failing silently caused the 10-min poll_checks_green hang
      // bug observed 2026-05-16T18Z.
      if (prLabelNames.includes(RETRIGGER_REVIEW_LABEL)) {
        try {
          const labelControl = await operatorSurface.observeLabelControl(
            subject.ref,
            subject.ref.revisionRef,
            RETRIGGER_REVIEW_LABEL
          );
          const labelEvent = legacyLabelEventFromControlResult(
            labelControl,
            RETRIGGER_REVIEW_LABEL
          );
          const result = await tryRetriggerReviewFromLabel({
            rootDir: ROOT,
            repo: repoPath,
            prNumber,
            labelActor: labelEvent?.actor || 'unknown',
            labelEvent,
            revisionRef: subject.ref.revisionRef,
            execFileImpl: execFileAsync,
          });
          console.log(
            `[watcher] retrigger-review label on ${repoPath}#${prNumber}: ${result.outcome}` +
              (result.detail ? ` (${result.detail})` : '')
          );
        } catch (err) {
          console.error(
            `[watcher] retrigger-review label processing failed for ${repoPath}#${prNumber}:`,
            err?.message || err
          );
        }
      }

      if (
        isAutomaticReviewCycleCapPause(existing) &&
        !prLabelNames.includes(REVIEWER_CYCLE_CAP_REACHED_LABEL)
      ) {
        const labelAdd = await addLabelToPRBestEffort(octokit, {
          repoPath,
          prNumber,
          label: REVIEWER_CYCLE_CAP_REACHED_LABEL,
          logger: console,
        });
        if (labelAdd.added) {
          prLabelNames.push(REVIEWER_CYCLE_CAP_REACHED_LABEL);
        }
      }

      if (shouldClearReviewCycleCapForOverride({ reviewRow: existing, labelNames: prLabelNames })) {
        try {
          await clearReviewCycleCapForOverride({
            db,
            octokit,
            repoPath,
            prNumber,
            headSha: subject.headSha || subject.ref?.revisionRef || null,
            labelNames: prLabelNames,
            logger: console,
          });
          prLabelNames.splice(0, prLabelNames.length, ...prLabelNames.filter(
            (label) => label !== REVIEWER_CYCLE_CAP_REACHED_LABEL
          ));
          existing = stmtGetReviewRow.get(repoPath, prNumber);
        } catch (err) {
          console.error(
            `[watcher] review-cycle-cap override cleanup failed for ${repoPath}#${prNumber}:`,
            err?.message || err
          );
        }
      }

      // Auto-refresh stale posted reviews when the PR HEAD has moved.
      //
      // Without this, a `posted` review row sits forever even when the
      // PR has been updated — D3 (downstream gate) sees the posted
      // review is on an older head SHA and reports `stale review`,
      // which blocks D4 from reaching `ready_to_merge`. Before this
      // change the only recovery was operator-applied `retrigger-review`
      // label, which doesn't scale to a backlog of PRs after a deploy.
      //
      // Confirmed root cause of the 20/23 D4 pending records observed
      // at 2026-05-16T22:37Z that cited "stale review(s) on prior
      // commits": 4 of 9 sampled PRs had `posted` rows with
      // `reviewer_head_sha` != current PR head. The CAS in
      // `stmtMarkAttemptStarted` reclaims only `pending` and
      // `pending-upstream`, never `posted` or generic `failed` — so
      // those rows stay stale until manual `retrigger-review`.
      //
      // This auto-refresh calls `requestReviewRereview`, whose own CAS
      // refuses to flip `reviewing` (the watcher already has an active
      // reviewer) — so a head change mid-tick can't race a duplicate
      // spawn. The retrigger only fires when `reviewer_head_sha` is
      // strictly different from the current `subject.headSha` and the
      // PR is non-terminal, so we don't thrash a PR whose head matches.
      // ...UNLESS the merge-agent is provably still converging for THIS head.
      // That suppression is state-aware rather than raw-label-based so stale
      // labels and `awaiting-rereview` handoffs still re-arm review.
      const postedReviewHeadMoved =
        existing?.review_status === 'posted' &&
        existing.reviewer_head_sha &&
        subject.headSha &&
        existing.reviewer_head_sha !== subject.headSha &&
        !subject.terminal;
      const resolveHeadCloserCommitSuppression = createHeadCloserCommitSuppressionResolver({
        repoPath,
        prNumber,
        headSha: subject.headSha,
        execFileImpl: execFileAsync,
        logger: console,
      });
      const stalePostedReviewSuppression = postedReviewHeadMoved
        ? await getStalePostedReviewAutoRereviewSuppression({
          rootDir: ROOT,
          repoPath,
          prNumber,
          subjectRef: subject.ref,
          currentRevisionRef: subject.ref.revisionRef,
          currentHeadSha: subject.headSha,
          labelNames: prLabelNames,
          operatorSurface,
          domainId,
          execFileImpl: execFileAsync,
          logger: console,
        })
        : { suppressed: false, reason: null };
      const stalePostedReviewCloserSuppression =
        postedReviewHeadMoved && !stalePostedReviewSuppression.suppressed
          ? await resolveHeadCloserCommitSuppression()
          : { suppressed: false, reason: null };
      const stalePostedReviewBudgetSuppression =
        postedReviewHeadMoved &&
          !stalePostedReviewSuppression.suppressed &&
          !stalePostedReviewCloserSuppression.suppressed
          ? getStalePostedReviewBudgetSuppression({
            rootDir: ROOT,
            domainId,
            repoPath,
            prNumber,
            linearTicketId,
            reviewRow: existing,
            currentHeadSha: subject.headSha,
            labelNames: prLabelNames,
            logger: console,
            db,
          })
          : { suppressed: false, reason: null };
      if (postedReviewHeadMoved && stalePostedReviewSuppression.suppressed) {
        console.log(
          `[watcher] auto-refresh SUPPRESSED for ${repoPath}#${prNumber}: ` +
            `head moved ${existing.reviewer_head_sha.slice(0, 12)} → ${subject.headSha.slice(0, 12)} ` +
            `because ${stalePostedReviewSuppression.reason}; leaving posted review to the merge-agent`
        );
      } else if (postedReviewHeadMoved && stalePostedReviewCloserSuppression.suppressed) {
        console.log(
          `[watcher] auto-refresh SUPPRESSED for ${repoPath}#${prNumber}: ` +
            `head moved ${existing.reviewer_head_sha.slice(0, 12)} → ${subject.headSha.slice(0, 12)} ` +
            `because ${stalePostedReviewCloserSuppression.reason}; leaving posted review intact`
        );
      } else if (postedReviewHeadMoved && stalePostedReviewBudgetSuppression.suppressed) {
        const budgetDetail =
          stalePostedReviewBudgetSuppression.reason === 'remediation-round-budget-exhausted'
            ? ` (${stalePostedReviewBudgetSuppression.completedRoundsForPR}/${stalePostedReviewBudgetSuppression.roundBudget} rounds, ` +
              `risk=${stalePostedReviewBudgetSuppression.riskClass || 'unknown'})`
            : '';
        console.log(
          `[watcher] auto-refresh SUPPRESSED for ${repoPath}#${prNumber}: ` +
            `head moved ${existing.reviewer_head_sha.slice(0, 12)} → ${subject.headSha.slice(0, 12)} ` +
            `because ${stalePostedReviewBudgetSuppression.reason}${budgetDetail}; ` +
            `leaving posted review intact and routing exhausted close through AMA/HAM`
        );
      } else if (postedReviewHeadMoved) {
        try {
          const refreshResult = requestReviewRereview({
            rootDir: ROOT,
            repo: repoPath,
            prNumber,
            reason: `auto-refresh: posted review on stale head ${existing.reviewer_head_sha.slice(0, 12)}; current head is ${subject.headSha.slice(0, 12)}`,
          });
          if (refreshResult.triggered) {
            console.log(
              `[watcher] auto-refresh stale posted review for ${repoPath}#${prNumber}: ` +
                `${existing.reviewer_head_sha.slice(0, 12)} → ${subject.headSha.slice(0, 12)}`
            );
            // Re-read the row so the rest of the iteration sees the
            // reset state; fall through to the spawn path below
            // (status is now 'pending' and the CAS will claim it).
            existing = stmtGetReviewRow.get(repoPath, prNumber);
          }
        } catch (err) {
          console.error(
            `[watcher] auto-refresh for ${repoPath}#${prNumber} failed:`,
            err?.message || err
          );
        }
      }

      if (existing?.review_status === 'posted') {
        const runPostedReviewHandler = () => handlePostedReviewRow({
          rootDir: ROOT,
          repoPath,
          prNumber,
          existing,
          subjectRef: subject.ref,
          currentRevisionRef: subject.ref.revisionRef,
          labelNames: prLabelNames,
          projectGateStatusSafe,
          execFileImpl: execFileAsync,
          operatorSurface,
          domainId,
        });
        postedReviewHandlers.push({
          repoPath,
          prNumber,
          // WPS-01: the head this handoff was queued against. The no-progress
          // lane keys its series on (repo, pr, head) so a new push always resets
          // the series and a PR that starts moving is never held back.
          //
          // `subject.headSha`, NOT `entry.headSha`. `entry` is the subjectEntry
          // built in watcher.mjs as `{ subjectRef, subject, prNumber }` (+ a
          // later `current`) -- it carries no `headSha`, so `entry.headSha` is
          // always undefined and this collapses to `null`. That is not inert:
          // `recordNoProgressLaneRun` skips the ledger write on a null head, so
          // the whole no-progress lane silently stops demoting anything and
          // every unadvanceable PR is re-walked at full speed -- the exact
          // starvation this ticket exists to remove. The file uses
          // `subject.headSha` in 29 other places, including the adjacent
          // handoff-context blocks.
          headSha: subject.headSha || null,
          run: runPostedReviewHandler,
        });
        return;
      }

      if (watcherDrain.active) {
        if (existing) {
          await projectGateStatusSafe(existing);
        }
        return;
      }

      let crossModelWaiverReason = null;
      const baseRoute = routeSubject(subject, {
        domainId,
        geminiReviewerMode: 'off',
      });
      // CFG-02 round-1 review B3 fix (2026-05-30): routeSubject can now
      // return a tagged `configBroken: true` sentinel when a runtime
      // edit to config.yaml violates the strict schema (instead of
      // throwing and aborting the whole tick). Skip this PR with a
      // loud log so the operator sees the bad config and fixes it;
      // the boot-time validator (validateDefaultReviewerRouteConfig)
      // would have caught the same edit at daemon restart, so this
      // path is the runtime-edit-during-tick fallback.
      if (baseRoute && baseRoute.configBroken) {
        console.warn(
          `[watcher] routeSubject returned config-broken for ${repoPath}#${prNumber}: ` +
          `${baseRoute.error?.message || baseRoute.error || 'unknown config error'} — ` +
          `skipping this PR for the tick; fix the config and restart the watcher to recover`
        );
        return;
      }
      if (!baseRoute) {
        if (!existing) {
          stmtCreateReviewRow.run(
            repoPath,
            prNumber,
            domainId,
            subject.ref.subjectExternalId,
            subject.ref.revisionRef || subject.headSha || null,
            new Date().toISOString(),
            'malformed-title',
            'open',
            null,
            'pending',
            JSON.stringify(Array.isArray(subject.labels) ? subject.labels : [])
          );
        }

        const unroutableBot = isUnroutableBotAuthor(subject.authorRef);

        // ASR-04: the "fix your title" notice is for an author who CAN fix it.
        // Dependabot owns its own titles and retitling would break its update
        // flow, so posting the notice — and raising the MALFORMED_PR_TITLE
        // signal behind it — asserts a defect that does not exist and pages on
        // it. That was already the category error MAL-01 named; now that the bot
        // PR has somewhere real to go, the false alarm goes with it.
        //
        // Kill-switch case excepted: with the route off, a bot PR really is
        // stuck, and suppressing the only signal that says so would make the
        // rollback lever silent.
        if (!unroutableBot || !argusRouteEnabled) {
          await signalMalformedTitleFailure(octokit, {
            repoPath,
            owner,
            repo,
            prNumber,
            prTitle,
            revisionRef: subject.ref.revisionRef,
            rootDir: ROOT,
          });
        }

        // Malformed titles are terminal in watcher state to avoid ambiguous
        // retitle retries. A bot PR is NOT: `argusOutcome.queued` means a
        // security review for this exact head is on the queue, so the row is
        // recorded as routed, not as finished. When the enqueue could not be
        // confirmed this tick the disposition writes nothing at all and the row
        // stays live for the next one — never terminal, which is the bug.
        const failureAt = new Date().toISOString();
        const disposition = markUnroutableTitleDisposition({
          prTitle,
          failureAt,
          repoPath,
          prNumber,
          unroutableBot,
          argusRouteEnabled,
          argusSecurityQueued: argusOutcome?.queued === true,
          argusReasonSummary: argusOutcome?.summary || '',
        });
        if (disposition === 'deferred') {
          console.warn(
            `[watcher] argus security route has not confirmed a queued review for ` +
              `${repoPath}#${prNumber} (${argusOutcome?.outcome || 'no-result'}); ` +
              'leaving the row non-terminal and retrying on the next tick'
          );
        }
        // Store normalized label names in reviewed_prs.labels_json. Readers
        // still accept the older GitHub label-object shape for historical rows.
        stmtUpdateReviewLabels.run(JSON.stringify(Array.isArray(subject.labels) ? subject.labels : []), repoPath, prNumber);
        await projectGateStatusSafe(stmtGetReviewRow.get(repoPath, prNumber));
        return;
      }
      // GMW-02 — layer the gemini always-on / fallback third-reviewer selection
      // on top of the resolved cross-model baseRoute using the same effective
      // route helper exported to operator surfaces, then let the existing
      // reviewer-timeout fallback apply on the (possibly gemini-pinned) result.
      // The integrity hard guard inside the effective helper also strips any
      // gemini-on-gemini route that an operator `roles.reviewer=gemini` pin
      // could otherwise produce.
      const geminiModeResolution = resolveGeminiReviewerModeForWatcher({ env: process.env });
      const geminiReviewerMode = geminiModeResolution.mode;
      console.log(
        `[watcher] gemini-mode resolved=${geminiReviewerMode} ` +
          `source=${geminiModeResolution.source || 'unknown'} ` +
          `topPath=${geminiModeResolution.topPath || '<unknown>'}`
      );
      if (geminiModeResolution.error) {
        console.error(
          `[watcher] gemini reviewer-mode resolve failed for ${repoPath}#${prNumber}: ` +
            `${geminiModeResolution.error?.message || geminiModeResolution.error}; ` +
            `fail-closed to reviewer.gemini.mode=off`
        );
      }
      const geminiBaseRoute = applyEffectiveReviewerRoute({
        builderClass: baseRoute.builderClass,
        baseRoute,
        mode: geminiReviewerMode,
        primaryReviewerQuotaCapped:
          geminiReviewerMode === 'fallback'
            ? primaryReviewerQuotaCappedForRow(existing, {
                expectedReviewerModel: baseRoute.reviewerModel,
              })
            : false,
        routeTable: baseRoute.routeTable,
      });
      if (geminiBaseRoute.geminiReviewerSelection) {
        console.log(
          `[watcher] reviewer-selection ${repoPath}#${prNumber} → gemini ` +
            `(${geminiBaseRoute.geminiReviewerSelection.reason}; mode=${geminiReviewerMode}; ` +
            `mode-source=${geminiModeResolution.source || 'unknown'}; ` +
            `replaced reviewer=${geminiBaseRoute.geminiReviewerSelection.replacedReviewerModel})`
        );
      } else if (geminiBaseRoute.geminiIntegrityGuard) {
        console.warn(
          `[watcher] reviewer-integrity-guard ${repoPath}#${prNumber}: blocked gemini from ` +
            `reviewing a ${geminiBaseRoute.geminiIntegrityGuard.builderClass}-built PR; ` +
            `fell back to reviewer=${geminiBaseRoute.geminiIntegrityGuard.fellBackTo}`
        );
      }
      // AFH-04 — ordered reviewer fallback (codex → gemini → claude LAST RESORT)
      // on the AFH-02 soft/hard provider-grounding signal. The read is memoized
      // per tick and fail-open: an unavailable/unreadable `hq fleet quota status
      // --json` yields a snapshot with `available: false`, which leaves the
      // configured primary/gemini route untouched. It can never throw here.
      let afhGrounding = null;
      {
        const readAfhGrounding = typeof getAfhReviewerGroundingForTick === 'function'
          ? getAfhReviewerGroundingForTick
          : defaultAfhReviewerGroundingForTick;
        try {
          afhGrounding = await readAfhGrounding();
        } catch (err) {
          afhGrounding = null;
          console.warn(
            `[watcher] afh-reviewer-grounding read failed for ${repoPath}#${prNumber}: ` +
              `${err?.message || err}; failing open to the configured reviewer route`
          );
        }
      }
      const afhSelection = applyAfhReviewerRouteForAttempt({
        subject,
        baseRoute: geminiBaseRoute,
        grounding: afhGrounding,
        geminiReviewerMode,
        routeTable: baseRoute.routeTable,
      });
      const afhBaseRoute = afhSelection.route;
      if (afhSelection.decision.applied) {
        console.warn(
          `[watcher] reviewer-selection ${repoPath}#${prNumber} ` +
            `${describeAfhReviewerFallback(afhSelection.decision)}`
        );
      } else if (afhSelection.decision.reason === 'all-candidates-grounded') {
        console.warn(
          `[watcher] afh-reviewer-fallback found no ungrounded reviewer for ${repoPath}#${prNumber}; ` +
            `keeping reviewer=${geminiBaseRoute.reviewerModel} (auto-reverts on provider recovery)`
        );
      }
      let route = selectReviewerRouteForAttempt({
        subject,
        baseRoute: afhBaseRoute,
        rootDir: ROOT,
        repoPath,
        prNumber,
        currentRow: existing,
        headSha: subject.headSha || subject.ref.revisionRef || null,
        afhGrounding,
      });

      // RWF-01: review-dispatch worker-class fallback
      const primaryReviewerWorkerClass = reviewerWorkerClassForRoute(route);
      const rwfDecision = await resolveReviewerWorkerClassWithFallback({
        authorClass: subject.builderClass || route.builderClass,
        primary: primaryReviewerWorkerClass,
        fallbackWorkerClasses: reviewWorkerClassFallback(process.env),
        execFileImpl: execFileAsync,
      });

      if (rwfDecision.fellBack) {
        const appliedFallback = applyReviewerWorkerClassFallbackToRoute({
          route,
          decision: rwfDecision,
          reviewerRouteByModel: REVIEWER_ROUTE_BY_MODEL,
        });
        if (appliedFallback.applied) {
          route = appliedFallback.route;
          console.warn(
            `[watcher] review-worker-class-fallback repo=${repoPath} pr=${prNumber} ` +
            `from=${rwfDecision.from} to=${rwfDecision.to} reason=${rwfDecision.reason} ` +
            `primaryState=${rwfDecision.primaryState}`
          );
        } else {
          console.warn(
            `[watcher] review-worker-class-fallback-skipped repo=${repoPath} pr=${prNumber} ` +
            `workerClass=${rwfDecision.workerClass} reason=${appliedFallback.reason}`
          );
        }
      }

      if (route.reviewerModelFallback) {
        console.warn(
          `[watcher] reviewer-model-fallback repo=${repoPath} pr=${prNumber} ` +
            `head=${route.reviewerModelFallback.headSha || '<unknown>'} ` +
            `from=${route.reviewerModelFallback.fromReviewerModel} ` +
            `to=${route.reviewerModelFallback.toReviewerModel} ` +
            `class=${route.reviewerModelFallback.failureClass} ` +
            `count=${route.reviewerModelFallback.failureCount}/${route.reviewerModelFallback.threshold} ` +
            `reason=${route.reviewerModelFallback.reason}`
        );
      } else if (route.reviewerModelFallbackSkipped) {
        console.warn(
          `[watcher] reviewer-model-fallback-skipped repo=${repoPath} pr=${prNumber} ` +
            `head=${route.reviewerModelFallbackSkipped.headSha || '<unknown>'} ` +
            `model=${route.reviewerModelFallbackSkipped.fromReviewerModel} ` +
            `class=${route.reviewerModelFallbackSkipped.failureClass} ` +
            `count=${route.reviewerModelFallbackSkipped.failureCount}/${route.reviewerModelFallbackSkipped.threshold} ` +
            `reason=${route.reviewerModelFallbackSkipped.reason}`
        );
      }

      crossModelWaiverReason = route.afhReviewerFallback?.lastResort
        ? (
            `AFH last-resort reviewer fallback switched reviewer=${route.afhReviewerFallback.fromReviewerModel} ` +
            `to reviewer=${route.afhReviewerFallback.toReviewerModel} because every cross-model reviewer ` +
            `(including gemini) is grounded (${route.afhReviewerFallback.reason}); ` +
            `reviewer=${route.afhReviewerFallback.toReviewerModel} matches builder=${route.builderClass}, ` +
            'so the cross-model guarantee is waived until a provider recovers.'
          )
        : route.timeoutFallback
        ? (
            `reviewer-timeout fallback switched reviewer=${route.timeoutFallback.fromReviewerModel} ` +
            `to reviewer=${route.timeoutFallback.toReviewerModel} after ` +
            `${route.timeoutFallback.timeoutFailures} timeout failures; ` +
            (route.timeoutFallback.sameModelAsBuilder
              ? `reviewer=${route.timeoutFallback.toReviewerModel} matches builder=${route.timeoutFallback.builderClass}, so cross-model guarantee is waived for this recovery pass.`
              : 'cross-model guarantee remains intact for this recovery pass.')
          )
        : describeCrossModelReviewWaiver(
            route.builderClass,
            route.reviewerModel,
            process.env
          );
      if (crossModelWaiverReason) {
        console.warn(
          `[watcher] cross-model-review-waived repo=${repoPath} pr=${prNumber} ${crossModelWaiverReason}`
        );
      }

      // (stale-drift check already ran at the top of the per-PR loop;
      // duplicate block removed — caused SyntaxError on import per LAC-439.)

      let liveLabels = null;
      const preRoutingUpdateRow = existing;
      if (!existing) {
        liveLabels = await fetchLivePRLabels(octokit, {
          owner,
          repo,
          prNumber,
        });
        if (liveLabels) {
          const fastMergeDecision = fastMergeDecisionFromLabels(liveLabels);
          if (fastMergeDecision.hasFastMergeLabel && !fastMergeDecision.hasVeto) {
            const authorizedHeadSha = await fetchLivePRHeadSha({
              owner,
              repo,
              prNumber,
              fallbackHeadSha: subject.headSha || null,
            });
            const timelineAuthorization = authorizedHeadSha
              ? await fetchFastMergeAuthorizationFromTimeline(octokit, {
                owner,
                repo,
                prNumber,
                liveHeadSha: authorizedHeadSha,
                allowedLabelNames: fastMergeDecision.labelNames.filter(
                  (name) => Object.prototype.hasOwnProperty.call(FAST_MERGE_CATEGORY_BY_LABEL, name)
                ),
              })
              : null;
            const changedFiles = authorizedHeadSha && timelineAuthorization
              && timelineAuthorization.authorizedHeadSha === authorizedHeadSha
              ? await fetchFastMergeChangedFiles(octokit, {
                owner,
                repo,
                prNumber,
                withApiTelemetry,
              })
              : null;
            const shapeCheck = changedFiles
              ? evaluateFastMergeDiffShape(changedFiles, fastMergeDecision.categories)
              : null;
            if (
              authorizedHeadSha
              && timelineAuthorization
              && timelineAuthorization.authorizedHeadSha === authorizedHeadSha
              && shapeCheck
              && !shapeCheck.ok
            ) {
              const authorizedAt = timelineAuthorization.authorizedAt;
              writeFastMergeAuditEntry(ROOT, {
                action: 'would-have-skipped-shape-mismatch',
                repo: repoPath,
                prNumber,
                categories: fastMergeDecision.categories,
                labels: liveLabels,
                changedFiles: shapeCheck.files,
                shapeCheck,
                authorizedHeadSha,
                authorizedAt,
                skippedAt: null,
              });
              console.log(
                `[watcher] Fast-merge labels present for ${repoPath}#${prNumber} but diff shape failed (${shapeCheck.reason}); using normal review path`
              );
            } else if (
              authorizedHeadSha
              && timelineAuthorization
              && timelineAuthorization.authorizedHeadSha === authorizedHeadSha
              && shapeCheck?.ok
              && isFastMergeSkipEnabled()
            ) {
              const authorizedAt = timelineAuthorization.authorizedAt;
              const skippedAt = new Date().toISOString();
              const auditEntry = buildFastMergeAuditEntry({
                action: 'skipped',
                repo: repoPath,
                prNumber,
                categories: fastMergeDecision.categories,
                labels: liveLabels,
                changedFiles: shapeCheck.files,
                shapeCheck,
                authorizedHeadSha,
                authorizedAt,
                skippedAt,
              });
              stmtCreateFastMergeSkippedReviewRow.run(
                repoPath,
                prNumber,
                domainId,
                subject.ref.subjectExternalId,
                authorizedHeadSha || subject.ref.revisionRef || subject.headSha || null,
                skippedAt,
                route.reviewerModel,
                linearTicketId,
                JSON.stringify(liveLabels),
                authorizedHeadSha,
                'pending',
                JSON.stringify(auditEntry),
                null
              );
              try {
                writeFastMergeAuditPayload(ROOT, auditEntry);
                markFastMergeAuditWritten({ repo: repoPath, prNumber });
              } catch (err) {
                markFastMergeAuditError({ repo: repoPath, prNumber, err });
                console.error(
                  `[watcher] fast-merge skip audit write failed for ${repoPath}#${prNumber}: ${err?.message || err}`
                );
              }
              console.log(
                `[watcher] Fast-merge skip for ${repoPath}#${prNumber}: ` +
                  `${fastMergeDecision.categories.join(',')} @ ${authorizedHeadSha.slice(0, 12)}`
              );
              await projectGateStatusSafe(stmtGetReviewRow.get(repoPath, prNumber));
              return;
            } else if (
              authorizedHeadSha
              && timelineAuthorization
              && timelineAuthorization.authorizedHeadSha === authorizedHeadSha
              && shapeCheck?.ok
              && !isFastMergeSkipEnabled()
            ) {
              const authorizedAt = timelineAuthorization.authorizedAt;
              writeFastMergeAuditEntry(ROOT, {
                action: 'would-have-skipped',
                repo: repoPath,
                prNumber,
                categories: fastMergeDecision.categories,
                labels: liveLabels,
                changedFiles: shapeCheck.files,
                shapeCheck,
                authorizedHeadSha,
                authorizedAt,
                skippedAt: null,
              });
              console.log(
                `[watcher] Fast-merge audit-only for ${repoPath}#${prNumber}: ` +
                  `would have skipped ${fastMergeDecision.categories.join(',')} @ ${authorizedHeadSha.slice(0, 12)}`
              );
            } else if (authorizedHeadSha) {
              console.log(
                `[watcher] Fast-merge labels present for ${repoPath}#${prNumber} but authorization or diff shape cannot corroborate the current head; using normal review path`
              );
            }
          }
        }
      }
      if (!existing) {
        stmtCreateReviewRow.run(
          repoPath,
          prNumber,
          domainId,
          subject.ref.subjectExternalId,
          subject.ref.revisionRef || subject.headSha || null,
          new Date().toISOString(),
          route.reviewerModel,
          'open',
          linearTicketId,
          'pending',
          JSON.stringify(Array.isArray(liveLabels) ? liveLabels : (Array.isArray(subject.labels) ? subject.labels : []))
        );
      }

      const current = stmtGetReviewRow.get(repoPath, prNumber);
      await projectGateStatusSafe(current);
      const activeFollowUp = shouldDeferReviewForActiveFollowUp({
        rootDir: ROOT,
        repo: repoPath,
        prNumber,
        currentRevisionRef: subject.ref?.revisionRef || subject.headSha || null,
      });
      if (activeFollowUp.defer) {
        console.log(
          `[watcher] Deferring reviewer for ${repoPath}#${prNumber}: active follow-up job` +
            (activeFollowUp.jobId ? ` ${activeFollowUp.jobId}` : '') +
            ` is ${activeFollowUp.latestJobStatus}`
        );
        return;
      }
      const cascadeGate = shouldBackoffReviewerSpawn(ROOT, {
        repo: repoPath,
        prNumber,
      });
      if (cascadeGate.shouldBackoff) {
        markWatcherSpawnDecision({
          repo: repoPath,
          pr_number: prNumber,
          decision: 'cascade-backoff-hold',
          failure_class: cascadeGate.state?.lastFailureClass || null,
          next_retry_after: cascadeGate.state?.nextRetryAfter || null,
        });
        return;
      }
      const cascadeRetryDue = Boolean(cascadeGate.state?.nextRetryAfter);
      const timeoutExhaustionHandoff = await maybeDispatchReviewerTimeoutExhaustedMergeAgent({
        rootDir: ROOT,
        repoPath,
        prNumber,
        existing: current,
        subjectRef: subject.ref,
        currentRevisionRef: subject.ref.revisionRef,
        labelNames: prLabelNames,
        execFileImpl: execFileAsync,
        operatorSurface,
        domainId,
      });
      if (timeoutExhaustionHandoff.handled) {
        return;
      }

      const inTerminalFailure = reviewRowInTerminalFailureState(current, subject?.headSha || null);
      const infraRecoveryClass = inTerminalFailure
        ? infraRecoverableFailureClass(current)
        : null;
      const unknownFailureClass = inTerminalFailure && !infraRecoveryClass
        ? unknownReviewerCommandFailureClass(current)
        : null;
      const reviewPopulationRetryConfig = normalizeReviewPopulationRetryConfig(resolveReviewPopulationRetryConfig());
      const populationRetry = inTerminalFailure && !infraRecoveryClass && !unknownFailureClass
        ? reviewPopulationRetryDecision(current, {
          config: reviewPopulationRetryConfig,
          headSha: subject?.headSha || null,
        })
        : { matched: false, retryable: false };
      const unknownFailureAttempts = Number(current?.review_attempts || 0);
      const unknownFailureRetryable = Boolean(
        unknownFailureClass && unknownFailureAttempts < REVIEW_UNKNOWN_FAILURE_MAX_RETRIES
      );
      if (populationRetry.matched && populationRetry.action === 'wait') {
        console.log(
          `[watcher] Holding review-population retry for ${repoPath}#${prNumber}: ` +
            `class=${populationRetry.failureClass} attempts=${populationRetry.attempts}/${populationRetry.maxAttempts}; ` +
            `waiting until ${new Date(populationRetry.waitUntilMs).toISOString()}`
        );
        return;
      }
      const reviewPopulationRetryable = Boolean(
        populationRetry.matched && populationRetry.action === 'retry'
      );
      if (inTerminalFailure && !infraRecoveryClass && !unknownFailureRetryable && !reviewPopulationRetryable) {
        if (unknownFailureClass) {
          finalizePendingTerminalFailureState(current);
          console.log(
            `[watcher] Unknown reviewer failure retry cap exhausted for ${repoPath}#${prNumber}: ` +
              `attempts=${unknownFailureAttempts}/${REVIEW_UNKNOWN_FAILURE_MAX_RETRIES}; ` +
              `leaving evidence intact`
          );
          return;
        }
        if (populationRetry.matched && populationRetry.action === 'exhausted') {
          finalizePendingTerminalFailureState(current);
          console.log(
            `[watcher] Review-population retry cap exhausted for ${repoPath}#${prNumber}: ` +
              `class=${populationRetry.failureClass} attempts=${populationRetry.attempts}/${populationRetry.maxAttempts}; ` +
              `leaving evidence intact`
          );
          return;
        }
        finalizePendingTerminalFailureState(current);
        console.log(
          `[watcher] Skipping failed review ${repoPath}#${prNumber}: ` +
            `failure is not infrastructure-recoverable; leaving evidence intact`
        );
        return;
      }
      if (infraRecoveryClass === 'reviewer-command-failed') {
        const reconciliation = await reconcileReviewerCommandFailedBeforeRetry({
          row: current,
          findPostedReview: reviewerCommandFailedReviewProbe,
          markPosted: ({ postedAt, row }) => {
            const changes = stmtMarkReviewerCommandFailedRecoveredPosted.run(
              postedAt,
              row.repo,
              row.pr_number,
              row.reviewer_session_uuid,
              row.reviewer_started_at,
            ).changes;
            if (changes === 1) {
              markWatcherReviewHeartbeat({ repo: row.repo, pr_number: row.pr_number, posted_at: postedAt });
            }
            return changes;
          },
          settleRunRecord: ({ sessionUuid, state, settledAt, reason }) => settleDurableReviewerRunState({
            sessionUuid,
            state,
            settledAt,
            reason,
          }),
          resolveReviewerLogin: reviewerBotLogin,
          log: console,
        });
        if (reconciliation.handled) {
          return;
        }
      }
      // HRR graceful-degradation for hard provider usage caps. A quota-exhausted
      // reviewer cannot succeed until the provider's cap window lifts, so retrying
      // before then would only burn the bounded infra auto-recover budget against a
      // wall. Hold the row until the provider-reported reset (or a fixed fallback
      // window since the last failure) elapses — WITHOUT consuming an attempt — then
      // let normal bounded recovery resume. Applies to both harnesses we know the
      // shape for (codex / claude), since the failure_message tag carries the cap.
      if (infraRecoveryClass === QUOTA_EXHAUSTED_FAILURE_CLASS) {
        const quotaHold = quotaHoldDecision(current, {
          fallbackBackoffMs: QUOTA_EXHAUSTED_BACKOFF_MS,
        });
        if (quotaHold.hold) {
          if (shouldBypassPrimaryReviewerQuotaHold(route, preRoutingUpdateRow)) {
            console.log(
              `[watcher] Bypassing quota hold for ${repoPath}#${prNumber}: ` +
                `reviewer.gemini.mode=${route.geminiReviewerSelection?.mode || geminiReviewerMode} ` +
                `selected gemini while replaced reviewer is capped`
            );
          } else {
            console.log(
              `[watcher] Holding quota-exhausted review ${repoPath}#${prNumber}: ` +
                `provider usage cap not yet cleared (waiting until ` +
                `${new Date(quotaHold.waitUntilMs).toISOString()} [${quotaHold.source}]); ` +
                `not consuming infra auto-recover attempt`
            );
            return;
          }
        }
      }
      const infraRecoveryAttempts = Number(current?.infra_auto_recover_attempts || 0);
      if (infraRecoveryClass && infraRecoveryAttempts >= INFRA_AUTO_RECOVER_CAP) {
        const alertedAt = new Date().toISOString();
        const alertMark = markCascadeCapExhaustedAlerted(ROOT, {
          repo: repoPath,
          prNumber,
          alertedAt,
          failureClass: infraRecoveryClass,
          attempts: infraRecoveryAttempts,
          cap: INFRA_AUTO_RECOVER_CAP,
          reason: current?.failure_message || cascadeGate.state?.lastFailureReason || null,
        });
        if (alertMark.marked && typeof deliverAlertFn === 'function') {
          try {
            await deliverAlertFn(
              `Adversarial reviewer infra auto-recovery cap exhausted for ` +
              `${repoPath}#${prNumber}: class=${infraRecoveryClass} ` +
              `attempts=${infraRecoveryAttempts}/${INFRA_AUTO_RECOVER_CAP}. ` +
              `Retry backoff remains active; inspect cascade-state for the persisted reason.`,
              {
                event: 'adversarial_review.cascade_cap_exhausted',
                payload: {
                  repo: repoPath,
                  pr_number: prNumber,
                  failure_class: infraRecoveryClass,
                  attempts: infraRecoveryAttempts,
                  cap: INFRA_AUTO_RECOVER_CAP,
                  next_retry_after: cascadeGate.state?.nextRetryAfter || null,
                  last_failure_reason: cascadeGate.state?.lastFailureReason || current?.failure_message || null,
                },
              },
            );
          } catch (err) {
            console.error(
              `[watcher] cascade-cap alert delivery failed for ${repoPath}#${prNumber}: ` +
                `${err?.message || err}`
            );
          }
        }
        if (!cascadeRetryDue) {
          finalizePendingTerminalFailureState(current);
          markWatcherSpawnDecision({
            repo: repoPath,
            pr_number: prNumber,
            decision: 'infra-cap-exhausted',
            failure_class: infraRecoveryClass,
            attempts: infraRecoveryAttempts,
            cap: INFRA_AUTO_RECOVER_CAP,
          });
          console.log(
            `[watcher] Infra auto-recovery cap exhausted for ${repoPath}#${prNumber}: ` +
              `class=${infraRecoveryClass} attempts=${infraRecoveryAttempts}/${INFRA_AUTO_RECOVER_CAP}; ` +
              `leaving failure evidence for operator inspection`
          );
          return;
        }
        console.warn(
          `[watcher] Infra auto-recovery cap exhausted for ${repoPath}#${prNumber}: ` +
            `class=${infraRecoveryClass} attempts=${infraRecoveryAttempts}/${INFRA_AUTO_RECOVER_CAP}; ` +
            `scheduled cascade retry is due, so retrying instead of parking`
        );
      }
      if (infraRecoveryClass) {
        const infraRecoveryReadiness = await getRoutingTierReadinessForTick();
        if (!infraRecoveryReadiness.ready) {
          const failedAt = new Date().toISOString();
          const failureMessage = infraRecoveryReadiness.failureMessage
            || `Routing-tier readiness probe reported ${infraRecoveryReadiness.reason}.`;
          const cascadeState = recordCascadeFailure(ROOT, {
            repo: repoPath,
            prNumber,
            failedAt,
            failureClass: infraRecoveryReadiness.failureClass || infraRecoveryClass,
            failureReason: failureMessage,
          });
          markWatcherSpawnDecision({
            repo: repoPath,
            pr_number: prNumber,
            decision: 'infra-retry-routing-tier-not-ready',
            failure_class: cascadeState.lastFailureClass,
            next_retry_after: cascadeState.nextRetryAfter,
            reason: cascadeState.lastFailureReason,
          });
          console.log(
            `[watcher] Skipping infra auto-recovery for ${repoPath}#${prNumber}: ` +
              `routing tier not ready (${infraRecoveryReadiness.reason}); ` +
              `advanced transient backoff to ${cascadeState.nextRetryAfter}; ` +
              `leaving review_status='failed' evidence intact`
          );
          return;
        }
      }

      if (!existing) {
        console.log(
          `[watcher] New PR ${repoPath}#${prNumber}: "${prTitle}" → ${route.reviewerModel}` +
            (linearTicketId ? ` (${linearTicketId})` : '')
        );
      } else {
        console.log(
          `[watcher] Retrying PR ${repoPath}#${prNumber}: "${prTitle}" → ${route.reviewerModel}` +
            (linearTicketId ? ` (${linearTicketId})` : '') +
            ` | previous status=${current?.review_status || existing.review_status}`
        );
      }
      // Store normalized label names in reviewed_prs.labels_json. Readers
      // still accept the older GitHub label-object shape for historical rows.
      stmtUpdateReviewLabels.run(JSON.stringify(Array.isArray(subject.labels) ? subject.labels : []), repoPath, prNumber);

      const roundBudgetDecision = evaluateRoundBudgetForReview({
        rootDir: ROOT,
        repo: repoPath,
        prNumber,
        linearTicketId,
        reviewStatus: existing?.review_status || 'pending',
        reviewAttempts: existing?.review_attempts || 0,
      });
      if (roundBudgetDecision.skip) {
        return;
      }

      if (!isExplicitOperatorReviewRetrigger(existing)) {
        const closerSpawnSuppression = await resolveHeadCloserCommitSuppression();
        if (closerSpawnSuppression.suppressed) {
          console.log(
            `[watcher] reviewer spawn SUPPRESSED for ${repoPath}#${prNumber}: ` +
              `${closerSpawnSuppression.reason} on head ${String(subject.headSha || '').slice(0, 12) || 'unknown'}`
          );
          return;
        }

        const firstPassBudgetSuppression = resolveFirstPassReviewBudgetSuppression({
          rootDir: ROOT,
          domainId,
          repoPath,
          prNumber,
          linearTicketId,
          reviewRow: existing,
          currentHeadSha: subject.headSha,
          labelNames: prLabelNames,
          logger: console,
          db,
        });
        if (firstPassBudgetSuppression.suppressed) {
          const budgetDetail =
            firstPassBudgetSuppression.reason === 'remediation-round-budget-exhausted'
              ? ` (${firstPassBudgetSuppression.completedRoundsForPR}/${firstPassBudgetSuppression.roundBudget} rounds, ` +
                `risk=${firstPassBudgetSuppression.riskClass || 'unknown'})`
              : '';
          let rowActionDetail = 'leaving existing review row intact';
          if (firstPassBudgetSuppression.reason === 'same-head-already-reviewed') {
            const restored = stmtRestoreSameHeadSuppressedReviewPosted.run(
              new Date().toISOString(),
              repoPath,
              prNumber,
              subject.headSha
            );
            rowActionDetail = restored.changes === 1
              ? "restored review_status='posted'"
              : "same-head restore skipped by CAS";
          }
          console.log(
            `[watcher] reviewer spawn SUPPRESSED for ${repoPath}#${prNumber}: ` +
              `${firstPassBudgetSuppression.reason}${budgetDetail}; ${rowActionDetail}`
          );
          return;
        }
      }

      const cycleCapConfig = resolveReviewCycleCapConfig({
        loadConfigImpl: loadConfigCached,
        logger: console,
      });
      const cycleCapDecision = shouldEscalateReviewCycle(db, {
        repo: repoPath,
        prNumber,
        headSha: subject.headSha || null,
        cap: cycleCapConfig.cap,
        windowHours: cycleCapConfig.windowHours,
        now: new Date().toISOString(),
      });
      if (cycleCapDecision.escalate) {
        const escalatedAt = new Date().toISOString();
        const recentVerdicts = recentReviewCycleVerdicts(db, {
          repo: repoPath,
          prNumber,
          limit: cycleCapConfig.cap,
        });
        const body = buildReviewCycleCapEscalationComment({
          cap: cycleCapConfig.cap,
          recentVerdicts,
        });
        if (!cycleCapDecision.alreadyEscalated) {
          try {
            await postReviewCycleCapEscalation(octokit, {
              repoPath,
              prNumber,
              body,
            });
            // Persist the dedupe marker the instant the comment posts,
            // before the label add, so a transient label-add failure cannot
            // re-post the escalation comment on the next tick.
            const escalationMark = markReviewCycleEscalated(db, {
              repo: repoPath,
              prNumber,
              headSha: subject.headSha || null,
              escalatedAt,
            });
            if (!escalationMark?.marked && escalationMark?.reason === 'missing-head-sha') {
              // Loud so the silent no-op is observable: with no head SHA the
              // escalation dedupe never engages, so the comment can re-post
              // every tick.
              console.warn(
                `[watcher] review-cycle-cap escalation marker NOT persisted for ${repoPath}#${prNumber}: ` +
                  'missing head SHA (escalation dedupe disabled; comment may re-post)'
              );
            }
            await addLabelToPRBestEffort(octokit, {
              repoPath,
              prNumber,
              label: REVIEWER_CYCLE_CAP_REACHED_LABEL,
              logger: console,
            });
            console.warn(
              `[watcher] review-cycle-cap reached for ${repoPath}#${prNumber}: ` +
                `next_count=${cycleCapDecision.count} cap=${cycleCapConfig.cap}; ` +
                `posted escalation and added ${REVIEWER_CYCLE_CAP_REACHED_LABEL}`
            );
          } catch (err) {
            console.error(
              `[watcher] review-cycle-cap escalation failed for ${repoPath}#${prNumber}:`,
              err?.message || err
            );
            return;
          }
        } else {
          console.log(
            `[watcher] review-cycle-cap already escalated for ${repoPath}#${prNumber}; ` +
              `automatic review remains paused`
          );
        }
        const alreadyCapPaused = isReviewCycleCapFailedRow(current);
        if (!alreadyCapPaused) {
          stmtMarkReviewCycleCapPaused.run(
            escalatedAt,
            `[review-cycle-cap] automatic remediation budget exhausted after ${cycleCapConfig.cap} successive review/remediation cycles; dispatching final hammer close unless blocked by structural gates, explicit operator labels, or ${PAUSED_FOR_REDESIGN_LABEL}`,
            repoPath,
            prNumber,
          );
        }
        return;
      }

      const dispatchCandidate = {
        repoPath,
        prNumber,
        subject,
        current,
        enqueuedAtMs: Date.now(),
        async run() {
          // REVIEW-DEDUP (idempotency lease): one (pr, head) dispatch per
          // window. A second pool worker racing the same head is turned away
          // here before it can fetch, claim, or spawn.
          const dispatchLeaseKey = headDispatchLeaseKey({
            repoPath,
            prNumber,
            headSha: subject?.headSha,
          });
          if (!reviewerHeadDispatchLease.tryAcquire(dispatchLeaseKey)) {
            console.log(
              `[watcher] reviewer dispatch SKIPPED for ${repoPath}#${prNumber}: ` +
                `(pr, head) dispatch lease already held this window (${dispatchLeaseKey}); ` +
                `another pool worker owns this head`
            );
            return;
          }

          let reservation = null;
          try {
            // REVIEW-DEDUP (authoritative reviewed-head gate): never dispatch a
            // review for a head that already has a completed review (GitHub
            // per-review commit_id === head). This composes WITH — never replaces
            // — attestation consumption, and runs before any claim/spawn so a
            // duplicate consumes no attempt budget and no re-review ceiling.
            const reviewedHeadDedup = await resolveAlreadyReviewedHeadDedup({
              repoPath,
              prNumber,
              headSha: subject?.headSha || null,
              reviewerLogins: amaAuthoritativeReviewerLoginsForModel(route.reviewerModel),
              fetchReviewsForHeadImpl: fetchReviewsForHeadForDedup,
              logger: console,
            });
            if (reviewedHeadDedup.alreadyReviewed) {
              console.log(buildDuplicateReviewSkipAudit({
                repoPath,
                prNumber,
                headSha: subject?.headSha || null,
                reviewId: reviewedHeadDedup.reviewId,
              }));
              const restore = restorePendingReviewedHeadDedupRow({
                restoreStatement: stmtRestoreReviewedHeadDedupSuppressedReviewPosted,
                repoPath,
                prNumber,
                headSha: subject?.headSha || null,
                reviewSubmittedAt: reviewedHeadDedup.reviewSubmittedAt,
              });
              if (restore.attempted) {
                console.log(
                  `[watcher] reviewed-head dedup row repair for ${repoPath}#${prNumber}: ` +
                    (restore.restored
                      ? `restored review_status='posted' posted_at=${restore.postedAt}`
                      : 'restore skipped by CAS')
                );
              }
              return;
            }

            reservation = await reserveReviewerMemoryAdmission({
              reviewerModel: route.reviewerModel,
              reservationState: reviewerMemoryReservationState,
              getMemoryPressureSample: reviewerMemoryAdmissionSampleForTick,
              memoryPressureConfig: reviewerMemoryPressureConfig,
              logger: console,
            });
            const { estimatedReviewerRssMb, memoryDecision, reservedMbBeforeAdmission } = reservation;
            if (!memoryDecision.admit) {
              console.log(
                `[watcher] Deferring reviewer for ${repoPath}#${prNumber}: ${memoryDecision.reason} ` +
                  `available=${memoryDecision.availableMb ?? 'unknown'}MB ` +
                  `reserved=${memoryDecision.reservedMb ?? reservedMbBeforeAdmission}MB ` +
                  `estimated=${memoryDecision.estimatedReviewerRssMb ?? estimatedReviewerRssMb}MB ` +
                  `projected=${memoryDecision.projectedHeadroomMb ?? 'unknown'}MB`
              );
              return;
            }

            const respawnAgeSeconds = resolvePendingDraftRespawnAgeSeconds();
            const attemptAt = new Date().toISOString();
            const reviewerSessionUuid = randomUUID();
            // After ARA-06's operator-surface carve, the per-PR loop iterates
            // typed `subject` (SubjectState) values from the subject adapter
            // — there is no `pr` GitHub-PR object in scope here. The handle
            // we need to persist is the head SHA we observed at claim time,
            // which is `subject.headSha`. (Was: `pr?.head?.sha`, which raised
            // `ReferenceError: pr is not defined` on every poll cycle for any
            // PR that reached the claim site, silently blocking review spawns.)
            const reviewerHeadSha = subject?.headSha || null;
            const reviewerTimeoutMs = resolveReviewerTimeoutMs();
            const reviewerLeaseExpiresAt = computeReviewerLeaseExpiryAt(attemptAt, reviewerTimeoutMs);
            const claim = infraRecoveryClass
              ? stmtMarkInfraAutoRecoveryAttemptStarted.run(
                attemptAt,
                reviewerSessionUuid,
                reviewerHeadSha,
                reviewerTimeoutMs,
                reviewerLeaseExpiresAt,
                repoPath,
                prNumber,
                current?.failed_at || null,
                current?.reviewer_head_sha || null,
                INFRA_AUTO_RECOVER_CAP,
                cascadeRetryDue ? 1 : 0,
                infraRecoveryClass
              )
              : reviewPopulationRetryable
                ? stmtMarkReviewPopulationRetryAttemptStarted.run(
                  attemptAt,
                  reviewerSessionUuid,
                  reviewerHeadSha,
                  reviewerTimeoutMs,
                  reviewerLeaseExpiresAt,
                  reviewerHeadSha,
                  attemptAt,
                  reviewerHeadSha,
                  repoPath,
                  prNumber,
                  reviewerHeadSha,
                  reviewPopulationRetryConfig.maxAttempts
                )
              : unknownFailureRetryable
                ? stmtMarkUnknownFailureRetryAttemptStarted.run(
                  attemptAt,
                  reviewerSessionUuid,
                  reviewerHeadSha,
                  reviewerTimeoutMs,
                  reviewerLeaseExpiresAt,
                  repoPath,
                  prNumber,
                  REVIEW_UNKNOWN_FAILURE_MAX_RETRIES
                )
              : stmtMarkAttemptStarted.run(
                attemptAt,
                reviewerSessionUuid,
                reviewerHeadSha,
                reviewerTimeoutMs,
                reviewerLeaseExpiresAt,
                reviewerHeadSha,
                repoPath,
                prNumber
              );
            if (claim.changes === 0) {
              // Lost the cross-process compare-and-swap. Either another
              // watcher just claimed this row, or the row's status moved to
              // a non-claimable state (`reviewing`, `failed-orphan`, terminal)
              // between the readback above and the UPDATE here. Either way,
              // do NOT spawn a reviewer; the next poll will see fresh state.
              console.log(
                `[watcher] Lost claim race on ${repoPath}#${prNumber} — another watcher is handling this PR (or its row is now in a non-claimable state). Skipping.`
              );
              return;
            }
            if (existing) {
              stmtUpdateReviewRouting.run(route.reviewerModel, linearTicketId, repoPath, prNumber);
            }
            markWatcherSpawnDecision({
              repo: repoPath,
              pr_number: prNumber,
              decision: 'claimed',
              reviewer_model: route.reviewerModel,
              failure_class: infraRecoveryClass || populationRetry.failureClass || unknownFailureClass || null,
              previous_status: current?.review_status || existing?.review_status || null,
            });
            if (infraRecoveryClass) {
              console.log(
                `[watcher] Claimed infra-failed review ${repoPath}#${prNumber} ` +
                  `(class=${infraRecoveryClass}, infra attempt ${infraRecoveryAttempts + 1}/${INFRA_AUTO_RECOVER_CAP})`
              );
            }
            if (unknownFailureRetryable) {
              console.log(
                `[watcher] Claimed unknown-failed review ${repoPath}#${prNumber} ` +
                  `(attempt ${unknownFailureAttempts + 1}/${REVIEW_UNKNOWN_FAILURE_MAX_RETRIES})`
              );
            }
            if (reviewPopulationRetryable) {
              console.log(
                `[watcher] Claimed review-population retry ${repoPath}#${prNumber} ` +
                  `(class=${populationRetry.failureClass}, attempt ${populationRetry.attempts + 1}/${reviewPopulationRetryConfig.maxAttempts})`
              );
            }
            if (afterClaim) {
              try {
                await afterClaim({
                  repoPath,
                  prNumber,
                  reviewerHeadSha,
                  reviewerSessionUuid,
                });
              } catch (err) {
                console.warn(
                  `[watcher] afterClaim observer failed for ${repoPath}#${prNumber}; continuing reviewer spawn:`,
                  err?.message || err
                );
              }
            }
            await operatorSurface.syncTriageStatus(
              subjectRefWithLinearTicket(subject.ref, linearTicketId, subject.labels),
              'in-review'
            );

            // Freshness re-check (2026-05-18): `subject` was populated from the
            // per-adapter snapshot cache that `discoverSubjects` warmed at the
            // START of the tick. Long ticks (5-min reviewer timeouts × multiple
            // PRs) can take 30+ min, by which time a PR may have been closed,
            // merged, or admin-resolved by the operator. Spawning a reviewer
            // for a PR that's no longer open is wasted work that also delays
            // the next PR's spawn in the serial loop. Re-fetch state directly
            // from GitHub right before the spawn and skip if no longer open.
            try {
              const freshPR = await fetchPullRequestHeadAndState(repoPath, prNumber, {
                execFileImpl: execFileAsync,
              });
              if (freshPR.mergedAt) {
                console.log(
                  `[watcher] PR ${repoPath}#${prNumber} was merged since tick-start snapshot — marking row + skipping reviewer spawn`
                );
                stmtMarkMerged.run(freshPR.mergedAt, repoPath, prNumber);
                return;
              }
              if (freshPR.state !== 'open') {
                console.log(
                  `[watcher] PR ${repoPath}#${prNumber} was closed since tick-start snapshot (state=${freshPR.state}) — marking row + skipping reviewer spawn`
                );
                stmtMarkClosed.run(new Date().toISOString(), repoPath, prNumber);
                return;
              }
              const freshHeadSha = freshPR.headRefOid || null;
              if (
                reviewerHeadSha &&
                freshHeadSha &&
                String(freshHeadSha) !== String(reviewerHeadSha)
              ) {
                console.log(
                  `[watcher] PR ${repoPath}#${prNumber} head moved since reviewer claim ` +
                  `${String(reviewerHeadSha).slice(0, 12)} → ${String(freshHeadSha).slice(0, 12)} — ` +
                  'releasing claim and skipping stale reviewer spawn'
                );
                stmtReleaseReviewerClaim.run(reviewerSessionUuid, repoPath, prNumber);
                return;
              }
            } catch (err) {
              // Non-fatal — proceed with spawn rather than block. A failed
              // freshness check is no worse than not having one at all.
              console.warn(
                `[watcher] freshness re-check failed for ${repoPath}#${prNumber}; proceeding with spawn:`,
                err?.message || err
              );
            }
            const preSpawnReconciliation = await reconcilePendingDraftsBeforeSpawn({
              repoPath,
              prNumber,
              botTokenEnv: route.botTokenEnv,
              currentHeadSha: reviewerHeadSha,
              respawnAgeSeconds,
              now: new Date(attemptAt),
            });
            if (preSpawnReconciliation.skipSpawn) {
              console.log(
                `[watcher] Skipping reviewer spawn for ${repoPath}#${prNumber}: ` +
                `fresh pending draft retained for ${preSpawnReconciliation.selfLogin} ` +
                `until ${preSpawnReconciliation.respawnDeadlineUtc || 'unknown deadline'}`
              );
              stmtReleaseReviewerClaim.run(reviewerSessionUuid, repoPath, prNumber);
              return;
            }

            // Final-round inputs come from the durable per-PR follow-up ledger,
            // not from `reviewed_prs.review_attempts`. Two reasons (reviewer
            // blocking issues #1 and #2):
            //
            //   1. `review_attempts` is incremented for failed posts / OAuth
            //      crashes / reviewer timeouts as well as successful posts. A
            //      transient post failure should not count as a remediation
            //      cycle and must not silently trip the lenient threshold.
            //
            //   2. An elevated legacy/operator cap must continue to describe
            //      the active PR cycle when it is higher than the current
            //      risk-class tier. Otherwise a PR that already consumed more
            //      rounds than the new tier allows would be silently cut off.
            //
            // `summarizePRRemediationLedger` reads currentRound from terminal
            // follow-up jobs (the only place a remediation cycle is actually
            // recorded as completed) and the latest job's persisted maxRounds.
            const ledger = summarizePRRemediationLedger(ROOT, {
              repo: repoPath,
              prNumber,
            });
            const roundBudget = resolveRoundBudgetForJob({
              linearTicketId,
              riskClass: ledger.latestRiskClass,
            }, { rootDir: ROOT });
            const latestMaxRounds = Number(ledger.latestMaxRounds);
            const reviewAttemptNumber = ledger.completedRoundsForPR + 1;
            const maxRemediationRounds = Number.isInteger(latestMaxRounds) && latestMaxRounds > roundBudget.roundBudget
              ? latestMaxRounds
              : roundBudget.roundBudget;
            const completedRemediationRounds = Number.isFinite(Number(ledger.completedRoundsForPR))
              ? Math.max(0, Math.floor(Number(ledger.completedRoundsForPR)))
              : 0;
            const passKind = reviewAttemptNumber > 1 || current?.rereview_requested_at
              ? 'rereview'
              : 'first-pass';
            const reviewDbAttemptNumber = nextReviewerPassAttemptNumber(ROOT, {
              repo: repoPath,
              prNumber,
              passKind,
              fallbackReviewAttempts: current?.review_attempts || 0,
            });
            const vocabularyFatigueFinding = passKind === 'rereview'
              ? await computeVocabularyFatigueFindingForPR({
                repoPath,
                prNumber,
              })
              : null;
            if (vocabularyFatigueFinding) {
              console.log(
                `[watcher] vocabulary fatigue ${repoPath}#${prNumber}: ` +
                  `stem=${vocabularyFatigueFinding.stem} ` +
                  `count=${vocabularyFatigueFinding.count}/${vocabularyFatigueFinding.window}`
              );
            }

            // Pre-spawn routing-tier readiness probe. Successful probes are
            // cached for the rest of the tick; failed probes get bounded
            // retries plus a very short cache so later PRs can re-check after
            // a brief proxy bounce instead of inheriting a whole-tick outage.
            const routingTierReadiness = await getRoutingTierReadinessForTick();
            if (!routingTierReadiness.ready) {
              console.log(
                `[watcher] Skipping reviewer spawn for ${repoPath}#${prNumber}: ` +
                `routing tier (LiteLLM proxy) not ready (${routingTierReadiness.reason}). ` +
                `Deferring via transient-failure backoff; no attempt budget consumed.`
              );
              settleReviewerAttempt({
                rootDir: ROOT,
                repoPath,
                prNumber,
                result: {
                  ok: false,
                  failureClass: routingTierReadiness.failureClass || 'cascade',
                  error: routingTierReadiness.failureMessage
                    || `Routing-tier readiness probe reported ${routingTierReadiness.reason}.`,
                },
                failureAt: attemptAt,
                maxRemediationRounds,
              });
              return;
            }

            // Standing policy: the hammer ALWAYS closes on exhaustion and must
            // NEVER trigger a re-review. Two gates before spawning a reviewer on
            // a re-review pass:
            //
            // (1) Terminal closer head — when the current PR head is a terminal
            //     closer commit (Closed-By: hammer / closer identity), the
            //     hammer's remediation IS terminal; do NOT re-review it.
            //     Re-reviewing resets the remediation round counter, so
            //     reviewState.reviewCycleExhausted never trips and the terminal
            //     close (ham_terminal_remediation_validated, dispatch-closer.mjs)
            //     never fires — the runaway remediate->review->remediate loop.
            //     Skip the spawn (no attempt budget consumed); the tick falls
            //     through to the merge/close path.
            //
            // (2) Hard review ceiling — independently, never land more than
            //     (round budget + 1) reviews for one PR, so the adversarial
            //     review count is bounded even if (1) is bypassed.
            //
            // (3) Hard attempt ceiling — failed/running attempts are not
            //     reviews and must not spend (2), but they still need their own
            //     larger fuse so a broken reviewer path cannot retry forever.
            let skipReviewerSpawnReason = null;
            if (passKind === 'rereview') {
              const closerHead = await getHeadCloserCommitSuppressionWithBoundedRetry({
                repoPath,
                prNumber,
                headSha: reviewerHeadSha,
                logger: console,
              });
              if (closerHead?.suppressed) {
                console.log(
                  `[watcher] Skipping re-review for ${repoPath}#${prNumber}: head ` +
                  `${String(reviewerHeadSha || '').slice(0, 12)} is a terminal closer commit ` +
                  `(${closerHead.reason}); hammer remediation is terminal — deferring to the ` +
                  `close path. No attempt budget consumed.`,
                );
                skipReviewerSpawnReason = 'terminal-closer-head';
              }

              const hardReviewCeiling = resolveHardReviewCeiling(maxRemediationRounds);
              const hardReviewAttemptCeiling = resolveHardReviewAttemptCeiling(maxRemediationRounds);
              const explicitOperatorReviewRetrigger = isExplicitOperatorReviewRetrigger(current);
              // REVIEW-DEDUP: both fuses apply to the current proposed head.
              // A completed or failed review of a stale head is audit history,
              // not a reason to deny the required exact-head review after
              // remediation. Same-head passes remain bounded by both fuses.
              const priorReviewCount = countReviewCeilingUnits({
                db,
                rootDir: ROOT,
                repoPath,
                prNumber,
                headSha: reviewerHeadSha,
                fallbackReviewAttempts: Number(current?.review_attempts || 0),
              });
              if (
                !skipReviewerSpawnReason &&
                priorReviewCount >= hardReviewCeiling &&
                !explicitOperatorReviewRetrigger
              ) {
                console.log(
                  `[watcher] Skipping re-review for ${repoPath}#${prNumber}: hard review ` +
                  `ceiling reached (${priorReviewCount} review ceiling units >= ${hardReviewCeiling}); ` +
                  `adversarial reviews are capped per PR — deferring to the close path. ` +
                  `No attempt budget consumed.`,
                );
                skipReviewerSpawnReason = 'hard-review-ceiling';
              } else if (!skipReviewerSpawnReason && priorReviewCount >= hardReviewCeiling) {
                console.log(
                  `[watcher] Allowing explicit operator re-review for ${repoPath}#${prNumber}: ` +
                  `hard review ceiling reached (${priorReviewCount} review ceiling units >= ` +
                  `${hardReviewCeiling}), but rereview_reason is an operator retrigger marker.`
                );
              }
              const priorReviewAttemptCount = countReviewCeilingAttempts({
                db,
                rootDir: ROOT,
                repoPath,
                prNumber,
                headSha: reviewerHeadSha,
                fallbackReviewAttempts: Number(current?.review_attempts || 0),
              });
              if (
                !skipReviewerSpawnReason
                && priorReviewAttemptCount >= hardReviewAttemptCeiling
                && !explicitOperatorReviewRetrigger
              ) {
                console.log(
                  `[watcher] Skipping re-review for ${repoPath}#${prNumber}: hard review ` +
                  `attempt ceiling reached (${priorReviewAttemptCount} reviewer attempts >= ` +
                  `${hardReviewAttemptCeiling}); failed/running attempts are capped separately ` +
                  `from landed reviews — deferring to the close path. No attempt budget consumed.`,
                );
                skipReviewerSpawnReason = 'hard-review-attempt-ceiling';
              } else if (!skipReviewerSpawnReason && priorReviewAttemptCount >= hardReviewAttemptCeiling) {
                console.log(
                  `[watcher] Allowing explicit operator re-review for ${repoPath}#${prNumber}: ` +
                  `hard review attempt ceiling reached (${priorReviewAttemptCount} reviewer attempts >= ` +
                  `${hardReviewAttemptCeiling}), but rereview_reason is an operator retrigger marker.`
                );
              }
            }

            if (skipReviewerSpawnReason) {
              stmtReleaseReviewerClaim.run(reviewerSessionUuid, repoPath, prNumber);
              console.log(
                `[watcher] Released reviewer claim for ${repoPath}#${prNumber} after ` +
                `${skipReviewerSpawnReason}; continuing to watcher close/maintenance path.`
              );
            } else {
              // Count only work that made it through defer, budget, dedupe,
              // claim, freshness, and routing checks and is about to enter the
              // actual spawn path.  Pending rows held by an active follow-up,
              // a backoff, or a terminal closer are not a watcher no-progress
              // incident.
              healthProbe?.recordOpenPending?.(healthTick, {
                repo: repoPath,
                prNumber,
              });
              const spawnReviewerArgs = {
                repo: repoPath,
                prNumber,
                reviewerModel: route.reviewerModel,
                botTokenEnv: route.botTokenEnv,
                linearTicketId,
                labels: Array.isArray(subject.labels) ? subject.labels : [],
                builderTag: route.tag,
                crossModelReviewWaived: Boolean(crossModelWaiverReason),
                crossModelReviewWaiverReason: crossModelWaiverReason,
                reviewerHeadSha,
                reviewAttemptNumber,
                reviewDbAttemptNumber,
                completedRemediationRounds,
                passKind,
                maxRemediationRounds,
                advisoryFindings: vocabularyFatigueFinding ? [vocabularyFatigueFinding] : [],
                reviewerSessionUuid,
                reviewerTimeoutMs,
                workspacePath: null,
                domainId,
                reviewerRuntimeAdapterOverride: domainReviewerRuntimeAdapter,
                onReviewerPgid: ({ pgid, spawnedAt }) => {
                  persistReviewerPgid({
                    pgid,
                    reviewerSessionUuid,
                    repoPath,
                    prNumber,
                    startedAt: spawnedAt,
                    reviewerTimeoutMs,
                    handlePollErrorImpl: handlePollError,
                  });
                },
              };
              // ARC-13: when the domain enables the sequential review pipeline
              // (default OFF), drive the two-stage pipeline instead of a single
              // review and post the Win 2 rollup. Gate-off is byte-identical:
              // the else-branch is the unchanged v1 single `spawnReviewer` call.
              const result = isPipelineEnabled(domainAdapterSet.domainConfig)
                ? await runWatcherGatedReviewPipeline({
                  domainConfig: domainAdapterSet.domainConfig,
                  domainId,
                  repoPath,
                  prNumber,
                  reviewerHeadSha,
                  riskClass: ledger.latestRiskClass,
                  reviewAttemptNumber,
                  spawnReviewerArgs,
                  stageStates: parsePipelineStageStates(ledger.pipeline_stage_states_json),
                })
                : await spawnReviewer(spawnReviewerArgs);
              if (result.ok) {
                healthProbe?.recordSpawn?.(healthTick, { at: attemptAt });
              }

              settleReviewerAttempt({
                rootDir: ROOT,
                repoPath,
                prNumber,
                result,
                maxRemediationRounds,
                // ARC-18: watcher owns the heartbeat singleton; thread it in.
                markReviewHeartbeat: markWatcherReviewHeartbeat,
              });
              await maybeInlineFinalHammerAfterReview({
                rootDir: ROOT,
                repoPath,
                prNumber,
                result,
                passKind,
                completedRemediationRounds,
                maxRemediationRounds,
                subjectRef: subject.ref,
                currentRevisionRef: subject.ref.revisionRef,
                labelNames: prLabelNames,
                projectGateStatusSafe,
                execFileImpl: execFileAsync,
                operatorSurface,
                logger: console,
                handlePostedReviewRowImpl: handlePostedReviewRow,
              });
            }
          } finally {
            if (reservation) reservation.release();
            reviewerHeadDispatchLease.release(dispatchLeaseKey);
          }
        },
      };
      if (reviewerPoolConfig.enabled) {
        reviewerDispatchCandidates.push(dispatchCandidate);
      } else {
        await dispatchCandidate.run();
      }
}
