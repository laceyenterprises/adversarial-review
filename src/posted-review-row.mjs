// ── Posted-review row: per-row post-review dispatch hub ───────────────────────
//
// ARC-18: extracted from watcher.mjs. `handlePostedReviewRow` is the per-row
// dispatch hub run once per queued posted-review handoff; its two private
// helpers (`extractReviewBodyFromRow`, `findLatestPostedReviewBody`, used only
// here) move with it. `runQueuedReviewAdoptionPhase` — the once-per-tick phase
// that runs posted-review merge/autowalk/closeout maintenance before launching
// the next reviewer wave — also lives here; `pollOnce` stays in watcher and
// imports both back. ROOT/execFileAsync are re-derived; WATCHER_PRIMARY_DOMAIN_ID
// is threaded (see the `domainId`/`primaryDomainId` defaults).
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MERGE_AGENT_REQUESTED_LABEL,
  OPERATOR_APPROVED_LABEL,
  legacyLabelEventFromControlResult,
} from './adapters/operator/github-pr-label-controls/index.mjs';
import { reviewBodyHasScopeViolationFinding } from './additive-only-scope.mjs';
import { deliverAlert as defaultDeliverAlert } from './alert-delivery.mjs';
import { resolveMergeAgentCoexistenceForWatcher } from './ama-closure-orchestration.mjs';
import { createLogChangeGate } from './log-change-gate.mjs';
import { COEXISTENCE_ACTION } from './ama/coexistence.mjs';
import { namedAmaNoDispatchReason } from './ama/dispatch-closer.mjs';
import { ADVERSARIAL_MERGE_REQUESTED_LABEL } from './ama/labels.mjs';
import { maybeFireFleetWideFalseDeferralAlert } from './fleet-wide-false-deferral-detector.mjs';
import {
  buildMergeAgentDispatchJob,
  dispatchMergeAgentForPR,
  fetchMergeAgentCandidate,
} from './follow-up-merge-agent.mjs';
import { maybeFireMergeAgentStuckAlert } from './merge-agent-stuck-alert.mjs';
import { findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';
import {
  resolveOrchestrationMode,
  retryPendingMergeCloseouts,
  syncPRLifecycle,
  buildTriageSubjectRef,
} from './pr-lifecycle-sync.mjs';
import { retryPendingMergeAgentLifecycleCleanups } from './merge-agent-lifecycle-cleanup.mjs';
import { retryPendingDagAutowalkOnMerge } from './dag-autowalk-on-merge.mjs';
import { retryPendingTriageSyncs } from './pending-triage-sync.mjs';
import { retryPendingRetriggerAckComments } from './follow-up-retrigger-label.mjs';
import { retryPendingRetriggerReviewAckComments } from './follow-up-retrigger-review-label.mjs';
import { db, stmtGetLatestPostedReviewBody, stmtGetReviewRow } from './review-state-db.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from './review-state.mjs';
import {
  evaluateNoProgressLane,
  markNoProgressStalledEventEmitted,
  maybeFireOperatorDecisionRequiredAlert,
  maybeMarkNoProgressStalledEvent,
  readNoProgressLane,
  clearNoProgressLane,
  PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED,
  PROGRESS_CLASS_SELF_RESOLVING,
  chooseNoProgressMissingInput,
  recordNoProgressLaneRun,
  recordNoProgressLaneSkip,
  resolveNoProgressProducerState,
  subjectProgressFingerprint,
} from './watcher-no-progress-lane.mjs';
import {
  createPostedReviewFairnessState,
  derivePostedReviewHandlerStartBudgetMs,
  derivePostedReviewStepDeadlineMs,
  resolvePostedReviewHandlerHeadroomMs,
  resolvePostedReviewHandlerTimeoutMs,
  resolvePostedReviewPhaseBudgetMs,
  resolvePostedReviewReviewerPressurePhaseBudgetMs,
  runPostedReviewHandlersFairly,
} from './watcher-poll-fairness.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function extractReviewBodyFromRow(reviewRow) {
  return reviewRow?.reviewBody ?? reviewRow?.review_body ?? reviewRow?.review_text ?? null;
}

function findLatestPostedReviewBody(rootDir = ROOT, { repo, prNumber } = {}) {
  if (rootDir === ROOT) {
    return stmtGetLatestPostedReviewBody.get(repo, prNumber)?.body_md || null;
  }
  const localDb = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(localDb);
    return localDb.prepare(
      `SELECT body_md
         FROM reviewer_passes
        WHERE repo = ?
          AND pr_number = ?
          AND pass_kind IN ('first-pass', 'rereview')
          AND body_md IS NOT NULL
        ORDER BY attempt_number DESC, pass_id DESC
        LIMIT 1`
    ).get(repo, prNumber)?.body_md || null;
  } finally {
    localDb.close();
  }
}

const postedReviewRowLogGate = createLogChangeGate();

function isTerminalReviewRow(row) {
  const prState = String(row?.pr_state || row?.prState || '').trim().toLowerCase();
  if (['merged', 'closed'].includes(prState)) return true;
  return Boolean(row?.merged_at || row?.mergedAt || row?.closed_at || row?.closedAt);
}

// RVHAND-03: an abandoned handler cannot report its own timing.
//
// `runWithDeadline` in the fairness loop stops WAITING on a slow handler and lets
// the tick continue; the handler is never told, so any breakdown it would emit at
// the end is never reached. RVHAND-02 established that these timeouts are always a
// single slow handler (13/13 samples start with the phase idle, 2-233ms in) and
// never phase saturation — but it cannot say WHICH step inside the handler is slow,
// precisely because the handler dies before reporting.
//
// So arm a pending-step warning before each await, then clear it when the step
// finishes. A handler that hangs now names the step it is still waiting on; a
// slow step that eventually completes also records the monotonic elapsed time.
const POSTED_REVIEW_STEP_LOG_THRESHOLD_MS = 5000;

export class PostedReviewStepDeadlineError extends Error {
  constructor(label, key, deadlineMs) {
    super(`posted-review step ${label} exceeded ${deadlineMs}ms for ${key}`);
    this.name = 'PostedReviewStepDeadlineError';
    this.code = 'POSTED_REVIEW_STEP_DEADLINE_EXCEEDED';
    this.label = label;
    this.key = key;
    this.deadlineMs = deadlineMs;
  }
}

function parsePositiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveMergeAgentCoexistenceStepDeadlineMs(
  env = process.env,
) {
  const derivedDeadlineMs = derivePostedReviewStepDeadlineMs('resolveMergeAgentCoexistence');
  const overrideDeadlineMs = parsePositiveMs(
    env?.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS,
    derivedDeadlineMs,
  );
  return Math.min(overrideDeadlineMs, derivedDeadlineMs);
}

export function resolveFetchMergeAgentCandidateStepDeadlineMs(env = process.env) {
  const derivedDeadlineMs = derivePostedReviewStepDeadlineMs('fetchMergeAgentCandidate');
  const overrideDeadlineMs = parsePositiveMs(
    env?.ADVERSARIAL_WATCHER_FETCH_MERGE_AGENT_CANDIDATE_DEADLINE_MS,
    derivedDeadlineMs,
  );
  return Math.min(overrideDeadlineMs, derivedDeadlineMs);
}

export function resolveMergeAgentCoexistenceRetryDeadlineMs(env = process.env) {
  const firstDeadlineMs = resolveMergeAgentCoexistenceStepDeadlineMs(env);
  const derivedRetryDeadlineMs = derivePostedReviewStepDeadlineMs('resolveMergeAgentCoexistenceRetry');
  const overrideDeadlineMs = parsePositiveMs(
    env?.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_RETRY_DEADLINE_MS,
    derivedRetryDeadlineMs,
  );
  return Math.max(firstDeadlineMs + 1, overrideDeadlineMs);
}

export async function timePostedReviewStep(
  label,
  key,
  logger,
  fn,
  thresholdMs = POSTED_REVIEW_STEP_LOG_THRESHOLD_MS,
  {
    deadlineMs = null,
    abortOnDeadline = true,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {},
) {
  const startedMs = performance.now();
  let warned = false;
  let timedOut = false;
  const controller = deadlineMs ? new AbortController() : null;
  const timer = setTimeoutFn(() => {
    warned = true;
    logger?.warn?.(
      `[watcher] posted-review step still running for ${key}: ${label} exceeded ${thresholdMs}ms`,
    );
  }, thresholdMs);
  timer.unref?.();
  let deadlineTimer = null;
  const effectiveDeadlineMs = deadlineMs === null || deadlineMs === undefined
    ? null
    : parsePositiveMs(deadlineMs, null);
  const deadline = effectiveDeadlineMs
    ? new Promise((_, reject) => {
        deadlineTimer = setTimeoutFn(() => {
          timedOut = true;
          const err = new PostedReviewStepDeadlineError(label, key, effectiveDeadlineMs);
          if (abortOnDeadline) controller?.abort(err);
          reject(err);
        }, effectiveDeadlineMs);
      })
    : null;
  const work = Promise.resolve()
    .then(() => fn({ signal: controller?.signal || null }))
    .catch((err) => {
      if (timedOut) {
        const detail = `${label} stopped with ${err?.message || err}`;
        if (abortOnDeadline) {
          logger?.warn?.(
            `[watcher] posted-review step aborted after deadline for ${key}: ${detail}`,
          );
        } else {
          logger?.error?.(
            `[watcher] posted-review step failed in background after deadline for ${key}: ${detail}`,
          );
        }
      }
      throw err;
    });
  try {
    return await (deadline ? Promise.race([work, deadline]) : work);
  } finally {
    clearTimeoutFn(timer);
    if (deadlineTimer !== null) clearTimeoutFn(deadlineTimer);
    if (warned && !timedOut) {
      const elapsedMs = Math.round(performance.now() - startedMs);
      logger?.warn?.(
        `[watcher] posted-review step completed for ${key}: ${label} took ${elapsedMs}ms`,
      );
    }
    if (timedOut) {
      const elapsedMs = Math.round(performance.now() - startedMs);
      logger?.error?.(
        `[watcher] posted-review step deadline exceeded for ${key}: ` +
          `${label} deadline_ms=${effectiveDeadlineMs} elapsed_ms=${elapsedMs}`,
      );
    }
  }
}

export async function handlePostedReviewRow({
  rootDir = ROOT,
  repoPath,
  prNumber,
  existing,
  subjectRef,
  currentRevisionRef,
  labelNames = [],
  projectGateStatusSafe,
  execFileImpl = execFileAsync,
  fetchMergeAgentCandidateImpl = fetchMergeAgentCandidate,
  buildMergeAgentDispatchJobImpl = buildMergeAgentDispatchJob,
  dispatchMergeAgentForPRImpl = dispatchMergeAgentForPR,
  resolveMergeAgentCoexistenceForWatcherImpl = resolveMergeAgentCoexistenceForWatcher,
  latestFollowUpJobFinder = findLatestFollowUpJob,
  latestPostedReviewBodyFinder = findLatestPostedReviewBody,
  reviewBodyHasScopeViolationFindingImpl = reviewBodyHasScopeViolationFinding,
  operatorSurface = null,
  domainId = null, // ARC-18: WATCHER_PRIMARY_DOMAIN_ID stays in watcher; threaded by callers (pollOnce passes domainId). Default is never read (only used when operatorSurface is set, and every such caller passes domainId).
  logGate = postedReviewRowLogGate,
  logger = console,
} = {}) {
  const stepKey = `${repoPath}#${prNumber}`;
  const gateProjection = await timePostedReviewStep(
    'projectGateStatusSafe', stepKey, logger, () => projectGateStatusSafe(existing),
  );

  try {
    const latestPostedReviewBody = latestPostedReviewBodyFinder(rootDir, { repo: repoPath, prNumber });
    const latestFollowUp = latestFollowUpJobFinder(rootDir, { repo: repoPath, prNumber });
    const reviewBodiesToCheck = [
      latestPostedReviewBody,
      extractReviewBodyFromRow(existing),
      latestFollowUp?.job?.reviewBody,
    ];
    if (reviewBodiesToCheck.some((body) => reviewBodyHasScopeViolationFindingImpl(body))) {
      logger.log(
        `[watcher] automated dispatch suppressed for ${repoPath}#${prNumber}: scope-violation finding present`
      );
      return { handled: true, outcome: 'scope-violation', gateDecision: gateProjection?.decision || null };
    }

    let operatorApprovalEvent;
    let mergeAgentRequestEvent;
    let adversarialMergeRequestedEvent;
    if (operatorSurface) {
      const controlSubjectRef = subjectRef || {
        domainId,
        subjectExternalId: `${repoPath}#${prNumber}`,
        revisionRef: currentRevisionRef || null,
      };
      const revisionRef = currentRevisionRef || controlSubjectRef.revisionRef || null;
      const [operatorApproval, mergeAgentRequest, adversarialMergeRequest] = await Promise.all([
        labelNames.includes(OPERATOR_APPROVED_LABEL)
          ? operatorSurface.observeOperatorApproved(controlSubjectRef, revisionRef)
          : null,
        labelNames.includes(MERGE_AGENT_REQUESTED_LABEL)
          ? operatorSurface.observeMergeAgentOverride(controlSubjectRef, revisionRef)
          : null,
        labelNames.includes(ADVERSARIAL_MERGE_REQUESTED_LABEL) &&
          typeof operatorSurface.observeLabelControl === 'function'
          ? operatorSurface.observeLabelControl(
              controlSubjectRef,
              revisionRef,
              ADVERSARIAL_MERGE_REQUESTED_LABEL,
            )
          : null,
      ]);
      operatorApprovalEvent = legacyLabelEventFromControlResult(operatorApproval, OPERATOR_APPROVED_LABEL);
      mergeAgentRequestEvent = legacyLabelEventFromControlResult(mergeAgentRequest, MERGE_AGENT_REQUESTED_LABEL);
      adversarialMergeRequestedEvent = legacyLabelEventFromControlResult(
        adversarialMergeRequest,
        ADVERSARIAL_MERGE_REQUESTED_LABEL,
      );
    }
    // Lifecycle sync now follows posted-review handling so reviewer adoption can
    // drain first. This live fetch is therefore the dispatch-time guard: it
    // re-reads PR state/mergeability/head before AMA or merge-agent selection
    // instead of trusting the previous tick's lifecycle mirror.
    const candidateDeadlineMs = resolveFetchMergeAgentCandidateStepDeadlineMs();
    let candidate;
    try {
      candidate = await timePostedReviewStep(
        'fetchMergeAgentCandidate', stepKey, logger, ({ signal }) =>
          fetchMergeAgentCandidateImpl(repoPath, prNumber, {
            execFileImpl,
            operatorApprovalEvent,
            mergeAgentRequestEvent,
            signal,
          }),
        undefined,
        { deadlineMs: candidateDeadlineMs },
      );
    } catch (err) {
      if (err?.code !== 'POSTED_REVIEW_STEP_DEADLINE_EXCEEDED') throw err;
      const reason = 'fetch-merge-agent-candidate-deadline-exceeded';
      logger?.error?.(
        `[watcher] merge-agent candidate fetch deadline exceeded for ${repoPath}#${prNumber}; ` +
          `reason=${reason} deadline_ms=${candidateDeadlineMs}. ` +
          'Skipping merge action for this PR on this tick so the posted-review phase can continue.',
      );
      return {
        handled: true,
        outcome: 'candidate-fetch-deadline',
        gateDecision: gateProjection?.decision || null,
        amaClosureResult: {
          dispatched: false,
          skipMergeAgent: true,
          reason,
          namedReason: reason,
          deadlineMs: candidateDeadlineMs,
        },
      };
    }
    const dispatchJob = buildMergeAgentDispatchJobImpl(rootDir, candidate, { reviewStateDb: db });

    // MSM-04: AMA-enabled posted-review rows have one autonomous merge route:
    // clean PRs are handled by the daemon, and dirty/conflicted/red-CI PRs are
    // handled by one hammer under the launch lease. A separate merge-clicking
    // agent is no longer a valid outcome.
    const coexistenceDeadlineMs = resolveMergeAgentCoexistenceStepDeadlineMs();
    let coexistenceDecision;
    try {
      coexistenceDecision = await timePostedReviewStep(
        'resolveMergeAgentCoexistence', stepKey, logger, ({ signal }) =>
          resolveMergeAgentCoexistenceForWatcherImpl({
            rootDir,
            reviewStateRow: existing,
            dispatchJob,
            candidate,
            labelNames,
            operatorApprovalEvent,
            mergeAgentRequestEvent,
            adversarialMergeRequestedEvent,
            repoPath,
            prNumber,
            currentRevisionRef,
            domainId,
            logger,
            signal,
          }),
        undefined,
        { deadlineMs: coexistenceDeadlineMs, abortOnDeadline: false },
      );
    } catch (err) {
      if (err?.code !== 'POSTED_REVIEW_STEP_DEADLINE_EXCEEDED') throw err;
      const reason = 'resolve-merge-agent-coexistence-deadline-exceeded';
      logger?.error?.(
        `[watcher] AMA/merge-agent coexistence deadline exceeded for ${repoPath}#${prNumber}; ` +
          `reason=${reason} deadline_ms=${coexistenceDeadlineMs}. ` +
          'Retrying once with the extended coexistence budget before yielding this merge opportunity.',
      );
      const retryDeadlineMs = resolveMergeAgentCoexistenceRetryDeadlineMs();
      try {
        coexistenceDecision = await timePostedReviewStep(
          'resolveMergeAgentCoexistenceRetry', stepKey, logger, ({ signal }) =>
            resolveMergeAgentCoexistenceForWatcherImpl({
              rootDir,
              reviewStateRow: existing,
              dispatchJob,
              candidate,
              labelNames,
              operatorApprovalEvent,
              mergeAgentRequestEvent,
              adversarialMergeRequestedEvent,
              repoPath,
              prNumber,
              currentRevisionRef,
              domainId,
              logger,
              signal,
            }),
          undefined,
          { deadlineMs: retryDeadlineMs, abortOnDeadline: false },
        );
      } catch (retryErr) {
        if (retryErr?.code !== 'POSTED_REVIEW_STEP_DEADLINE_EXCEEDED') throw retryErr;
        logger?.error?.(
          `[watcher] AMA/merge-agent coexistence retry deadline exceeded for ${repoPath}#${prNumber}; ` +
            `reason=${reason} first_deadline_ms=${coexistenceDeadlineMs} retry_deadline_ms=${retryDeadlineMs}. ` +
            'Leaving any in-flight HAM launch to settle under its own lease and dispatch timeout; ' +
            'skipping merge action for this PR on this tick so the posted-review phase can continue.',
        );
        return {
          handled: true,
          outcome: 'coexistence-deadline',
          gateDecision: gateProjection?.decision || null,
          amaClosureResult: {
            dispatched: false,
            skipMergeAgent: true,
            reason,
            namedReason: reason,
            deadlineMs: coexistenceDeadlineMs,
            retryDeadlineMs,
          },
        };
      }
    }
    if (coexistenceDecision.outcome === 'pr-terminal') {
      // BUG-1: the live candidate read shows the PR already merged. No
      // AMA/merge-agent action is possible — drop ownership instead of retaining
      // it and re-evaluating (and re-failing the daemon merge) every tick.
      logger.log(
        `[watcher] AMA/merge-agent skipped for ${repoPath}#${prNumber}: PR already ` +
        `${coexistenceDecision.terminalReason} — dropping ownership`
      );
      clearNoProgressLane(rootDir, { repo: repoPath, prNumber }, { logger });
      return { handled: true, dispatchJob, prTerminal: true, gateDecision: gateProjection?.decision || null };
    }
    if (coexistenceDecision.outcome === 'ama-dispatched') {
      const { amaClosureResult } = coexistenceDecision;
      logger.log(
        `[watcher] AMA hammer dispatched for ${repoPath}#${prNumber}: ` +
        `lrq=${amaClosureResult.dispatchId || 'unknown'} workerClass=${amaClosureResult.workerClass}`
      );
      return { handled: true, outcome: 'ama-dispatched', gateDecision: gateProjection?.decision || null };
    }
    if (coexistenceDecision.outcome === 'ama-pending') {
      const { amaClosureResult } = coexistenceDecision;
      // Log-feed noise control: this route retains ownership and re-polls a
      // stuck PR every tick. Log once per retained-worker state transition
      // instead of every poll; a new head/reason/worker identity still logs.
      const retainGateKey = `${repoPath}#${prNumber}`;
      const retainSignature =
        `${currentRevisionRef || ''}#${amaClosureResult.reason || 'ama-dispatch-pending'}` +
        `#${amaClosureResult.launchRequestId || ''}#${amaClosureResult.dispatchId || ''}` +
        `#${amaClosureResult.workerClass || ''}`;
      const retainDecision = logGate.note(retainGateKey, retainSignature);
      if (retainDecision.changed) {
        const suppressedNote = retainDecision.suppressedSincePrevious > 0
          ? ` (after ${retainDecision.suppressedSincePrevious} suppressed identical polls)`
          : '';
        logger.log(
          `[watcher] AMA hammer route retained ownership for ${repoPath}#${prNumber}: ` +
          `${amaClosureResult.reason || 'ama-dispatch-pending'} ` +
          `lrq=${amaClosureResult.launchRequestId || amaClosureResult.dispatchId || 'unknown'} ` +
          `workerClass=${amaClosureResult.workerClass || 'unknown'}${suppressedNote}`
        );
      }
      return { handled: true, outcome: 'ama-pending', gateDecision: gateProjection?.decision || null };
    }

    // AMA-06N — coexistence decision per SPEC §4.8. When AMA is
    // enabled and the hammer route didn't fire (not eligible, dispatch
    // failed, etc.), the watcher must NOT auto-fall-through to merge-
    // agent. The operator either fixes eligibility (apply
    // operator-approved / adversarial-merge-requested) OR explicitly
    // applies `merge-agent-requested` on the current head to invoke
    // the operator-fallback lane.
    //
    // Operator-fallback dispatches merge-agent WITH the
    // `AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true` env so the AMA-06A
    // admit gate (agent-os side) lets it through.
    //
    // When AMA is disabled, the action is `merge-agent-default` and
    // the existing dispatch runs unchanged (no override env, no
    // logging change).
    if (coexistenceDecision.outcome === 'await-operator') {
      const { amaClosureResult } = coexistenceDecision;
      const reasonsHint = Array.isArray(amaClosureResult?.reasons)
        ? amaClosureResult.reasons.slice(0, 8).join(',')
        : amaClosureResult?.reason || 'unknown';
      const namedReason = amaClosureResult?.namedReason || namedAmaNoDispatchReason(
        amaClosureResult?.reason || 'unknown',
        amaClosureResult?.reasons,
      );
      logger.log(
        `[watcher] AMA enabled but not eligible for ${repoPath}#${prNumber} ` +
        `(${namedReason}; reasons: ${reasonsHint}); awaiting operator action ` +
        `(apply 'operator-approved'/'adversarial-merge-requested' to make AMA-eligible ` +
        `OR 'merge-agent-requested' for the operator-fallback lane)`
      );
      return {
        handled: true,
        outcome: 'await-operator',
        gateDecision: gateProjection?.decision || null,
        amaClosureResult,
      };
    }

    const orchestrationMode = resolveOrchestrationMode({
      logger,
      context: 'merge-agent dispatch',
    });
    const { coexistence, dispatchEnv } = coexistenceDecision;
    // AMA-06N: when the operator-fallback lane is selected, override
    // the dispatch trigger to 'merge-agent-requested' so the critical-
    // lane priority + consumed-label cleanup at
    // follow-up-merge-agent.mjs:3768-3783 + :3060-3069 fire correctly.
    // An env overlay alone leaves the trigger on the normal lane,
    // recreating the memory-pressure outage class this label exists
    // to bypass.
    const operatorFallbackTriggerOverride =
      coexistence?.action === COEXISTENCE_ACTION.MERGE_AGENT_OPERATOR_FALLBACK
        ? 'merge-agent-requested'
        : null;
    if (coexistence?.action === COEXISTENCE_ACTION.MERGE_AGENT_OPERATOR_FALLBACK) {
      logger.log(
        `[watcher] merge-agent operator-fallback lane for ${repoPath}#${prNumber}: ` +
        `setting AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true + trigger=merge-agent-requested (AMA-06N → AMA-06A admit-gate bypass)`
      );
    } else if (coexistence?.action === COEXISTENCE_ACTION.MERGE_AGENT_RECOVERY_FALLBACK) {
      logger.log(
        `[watcher] AMA hammer recovery fallback for ${repoPath}#${prNumber}: ` +
        `${coexistenceDecision?.amaClosureResult?.reason || 'ama-dispatch-failure'}; ` +
        `dispatching merge-agent with AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true`
      );
    }
    const dispatched = await dispatchMergeAgentForPRImpl({
      rootDir,
      ...dispatchJob,
      // AMA validated the hammer's terminal remediation from ground truth but
      // could not dispatch its own closer. Hand that proof to the merge-agent so it
      // can close on the certification instead of waiting for a verdict that
      // closer-commit suppression guarantees will never be posted.
      hamTerminalRemediationValidated:
        coexistenceDecision?.amaClosureResult?.hamTerminalRemediationValidated === true,
      orchestrationMode,
      ...(dispatchEnv ? { env: { ...process.env, ...dispatchEnv } } : {}),
      ...(operatorFallbackTriggerOverride ? { triggerOverride: operatorFallbackTriggerOverride } : {}),
    });
    // Enrich the decision log line when the dispatch is stuck pre-spawn
    // (recorded, daemon refusing admission). Surfaces what
    // `skip-already-dispatched` alone hides — see PR #649 for the on-
    // demand diagnostic of the same gap. Fails closed: when the helper
    // returns null (OSS standalone, hqRoot missing, audit dir empty,
    // dispatch still booting) the message is unchanged.
    const stuck = dispatched?.stuckDetail || null;
    const stuckSuffix = stuck
      ? ` BLOCKED stuck=${stuck.stuckForMinutes}min refusals=${stuck.refusalCount} primary=${stuck.primaryReason || 'unknown'}`
      : '';
    logger.log(
      `[watcher] merge-agent decision for ${repoPath}#${prNumber}: ${dispatched.decision}${stuckSuffix}`
    );
    // Escalate to a Sentinel alert at the operator-confirmed 30-min
    // threshold. Debounced: don't refire the same alert within an hour.
    // Wrapped in try/catch so missing ALERT_TO / unreachable hooks
    // endpoint never crashes the watcher loop (matches the OSS-friendly
    // shape of health-probe.mjs::sendTransitionAlert).
    if (stuck && stuck.stuckForMinutes >= 30) {
      try {
        await maybeFireMergeAgentStuckAlert({
          rootDir,
          repoPath,
          prNumber,
          dispatched,
          deliverAlertFn: defaultDeliverAlert,
          logger,
        });
      } catch (alertErr) {
        logger?.error?.(
          `[watcher] stuck-dispatch alert delivery failed: ${alertErr?.message || alertErr}`
        );
      }
    }
    // Fleet-wide false-deferral alert — defense-in-depth against the
    // 2026-05-18 session-ledger DB-path bug class. See helper above.
    try {
      await maybeFireFleetWideFalseDeferralAlert({
        dispatched,
        repoPath,
        prNumber,
        deliverAlertFn: defaultDeliverAlert,
        logger,
      });
    } catch (alertErr) {
      logger?.error?.(
        `[watcher] fleet-wide false-deferral detector failed: ${alertErr?.message || alertErr}`
      );
    }
  } catch (err) {
    // The augmented error from `dispatchMergeAgentForPR` already
    // inlines stderr+stdout into `err.message`, so just dumping
    // `err.message` here surfaces the full diagnostic chain (rather
    // than the bare "Command failed: hq dispatch …" the watcher used
    // to log). For non-augmented errors (anything throwing from the
    // outer try block that doesn't pass through the augment shim),
    // also try `.stderr` / `.stdout` as a defense-in-depth fallback.
    const errMessage = err?.message || String(err);
    const errStderr = err?.stderr ? String(err.stderr).trim() : '';
    const errStdout = err?.stdout ? String(err.stdout).trim() : '';
    let detail = errMessage;
    if (errStderr && !errMessage.includes('stderr:')) {
      detail += `\n  stderr:\n${errStderr.split('\n').map(l => `    ${l}`).join('\n')}`;
    }
    if (errStdout && !errMessage.includes('stdout:')) {
      detail += `\n  stdout:\n${errStdout.split('\n').map(l => `    ${l}`).join('\n')}`;
    }
    logger.error(
      `[watcher] merge-agent dispatch check failed for ${repoPath}#${prNumber}:\n${detail}`
    );
  }
}

// ── Poll loop: once-per-tick post-review adoption + maintenance phase ─────────

// WPS-01: cross-tick fairness state for the posted-review phase. Process-scoped
// so a handler the per-tick budget cut off is promoted to the front of the NEXT
// tick instead of being cut off in the same position forever.
const postedReviewFairnessState = createPostedReviewFairnessState();

/**
 * Bind the no-progress lane to real review-state rows.
 *
 * `evaluate` decides whether a queued posted-review handler runs this tick;
 * `record` compares the post-run state fingerprint with the previous tick's to
 * decide whether the tick achieved anything for that PR. Both are kept here (and
 * out of the scheduler) so `runPostedReviewHandlersFairly` stays a pure,
 * SQLite-free ordering/budget decision.
 *
 * A handler that TIMED OUT is recorded as no-progress on purpose: an abandoned
 * handler is the strongest possible evidence that this PR cannot be advanced by
 * re-walking it, and it is the single most expensive thing the tick can carry.
 */
export function createNoProgressLaneGate({
  rootDir = ROOT,
  readReviewRow = (repo, prNumber) => stmtGetReviewRow.get(repo, prNumber),
  now = () => new Date().toISOString(),
  deliverAlertFn = defaultDeliverAlert,
  emitStalledEventFn = null,
  logger = console,
} = {}) {
  return {
    evaluate(handler) {
      const identity = { repo: handler.repoPath, prNumber: handler.prNumber };
      const ledger = readNoProgressLane(rootDir, identity, { logger });
      const decision = evaluateNoProgressLane(ledger, { headSha: handler.headSha || null });
      if (!decision.due) {
        recordNoProgressLaneSkip(rootDir, identity, {
          headSha: handler.headSha || null,
          now: now(),
          logger,
        });
      }
      return { run: decision.due, ...decision };
    },
    async record(handler, { timedOut = false, value = null } = {}) {
      // Without a head there is no series to key on; skip the row read too.
      if (!handler.headSha) return null;
      const identity = { repo: handler.repoPath, prNumber: handler.prNumber };
      let row = null;
      if (!timedOut) {
        try {
          row = readReviewRow(handler.repoPath, handler.prNumber) || null;
        } catch (err) {
          logger?.warn?.(
            `[watcher] no-progress lane: review-row read failed for ` +
              `${handler.repoPath}#${handler.prNumber} (${err?.message || err})`,
          );
          // Unknown post-state is not evidence of no progress; leave the series
          // alone rather than demoting on a read fault.
          return null;
        }
      }
      const fingerprint = timedOut
        ? 'timed-out'
        : subjectProgressFingerprint(row, { headSha: handler.headSha || null });
      const progressClass = value?.gateDecision?.operatorDecisionRequired === true
        ? PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED
        : PROGRESS_CLASS_SELF_RESOLVING;
      const observedAt = now();
      const outcome = recordNoProgressLaneRun(rootDir, identity, {
        headSha: handler.headSha || null,
        fingerprint,
        progressClass,
        now: observedAt,
        logger,
      });
      if (outcome?.demoted) {
        logger?.warn?.(
          `[watcher] no-progress lane: ${handler.repoPath}#${handler.prNumber} demoted to the ` +
            `slow lane after ${outcome.noProgressTicks} consecutive ticks with no state change ` +
            `on head ${(handler.headSha || 'unknown').slice(0, 12)}; it will now be re-walked ` +
            `every ${outcome.backoffTicks} tick(s) instead of every tick. It is NOT dropped — ` +
            'nothing about its eligibility, findings, or merge gating has changed.',
        );
      }
      if (outcome?.progressed === false && !isTerminalReviewRow(row)) {
        const missingInput = chooseNoProgressMissingInput({
          value,
        });
        const producer = resolveNoProgressProducerState({
          missingInput,
          producerHints: handler.stalledProducerHints || null,
        });
        const stalledEvent = maybeMarkNoProgressStalledEvent(rootDir, identity, {
          headSha: handler.headSha || null,
          fingerprint,
          noProgressTicks: outcome.noProgressTicks,
          firstNoProgressAt: outcome.firstNoProgressAt || null,
          missingInput,
          producer,
          now: observedAt,
          logger,
        });
        if (stalledEvent) {
          logger?.warn?.(
            `[watcher] STALLED ${handler.repoPath}#${handler.prNumber} for ` +
              `${stalledEvent.noProgressTicks} ticks: needs ${stalledEvent.missingInput} ` +
              `at head ${(handler.headSha || 'unknown').slice(0, 12)}. ` +
              `Producer exists: ${stalledEvent.producer.exists === true ? 'yes' : stalledEvent.producer.exists === false ? 'no' : 'unknown'}` +
              (stalledEvent.producer.reason ? ` (${stalledEvent.producer.reason})` : ''),
          );
          logger?.log?.(JSON.stringify(stalledEvent));
          try {
            if (typeof emitStalledEventFn === 'function') {
              await emitStalledEventFn(stalledEvent);
            }
            markNoProgressStalledEventEmitted(rootDir, identity, stalledEvent, {
              emittedAt: now(),
              fingerprint,
              logger,
            });
          } catch (err) {
            logger?.warn?.(
              `[watcher] no-progress lane: stalled-event delivery failed for ` +
                `${handler.repoPath}#${handler.prNumber} (${err?.message || err})`,
            );
          }
        }
      }
      if (outcome?.progressClass === PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED) {
        try {
          const alerted = await maybeFireOperatorDecisionRequiredAlert({
            rootDir,
            identity,
            headSha: handler.headSha || null,
            fingerprint,
            noProgressTicks: outcome.noProgressTicks,
            firstNoProgressAt: outcome.firstNoProgressAt || null,
            deliverAlertFn,
            logger,
            now: Date.parse(observedAt),
          });
          if (alerted) {
            logger?.warn?.(
              `[watcher] no-progress lane: operator decision alert fired for ` +
                `${handler.repoPath}#${handler.prNumber} after ${outcome.noProgressTicks} ` +
                `unchanged tick(s) on head ${(handler.headSha || 'unknown').slice(0, 12)}`,
            );
          }
        } catch (err) {
          logger?.error?.(
            `[watcher] no-progress lane: operator decision alert delivery failed for ` +
              `${handler.repoPath}#${handler.prNumber} (${err?.message || err})`,
          );
        }
      }
      return outcome;
    },
  };
}

export async function runQueuedReviewAdoptionPhase({
  drainReviewerDispatchCandidates,
  postedReviewHandlers = [],
  postReviewMaintenanceHandlers = [],
  octokit,
  operatorSurface,
  // ARC-18: WATCHER_PRIMARY_DOMAIN_ID stays in watcher; threaded through to
  // syncPRLifecycle as the domain fallback. pollOnce passes it; the `null`
  // default is only reached by a caller that omits it (e.g. a test overriding
  // syncPRLifecycleImpl) and is not exercised in production.
  primaryDomainId = null,
  retryPendingMergeAgentLifecycleCleanupsImpl = retryPendingMergeAgentLifecycleCleanups,
  syncPRLifecycleImpl = syncPRLifecycle,
  retryPendingDagAutowalkOnMergeImpl = retryPendingDagAutowalkOnMerge,
  retryPendingTriageSyncsImpl = retryPendingTriageSyncs,
  retryPendingMergeCloseoutsImpl = retryPendingMergeCloseouts,
  retryPendingRetriggerAckCommentsImpl = retryPendingRetriggerAckComments,
  retryPendingRetriggerReviewAckCommentsImpl = retryPendingRetriggerReviewAckComments,
  rootDir = ROOT,
  execFileImpl = execFileAsync,
  logger = console,
  // WPS-01 seams. Defaults reproduce production wiring; tests override them to
  // drive the budget/lane without a clock or a database.
  postedReviewFairness = postedReviewFairnessState,
  postedReviewPhaseBudgetMs = resolvePostedReviewPhaseBudgetMs(),
  postedReviewReviewerPressurePhaseBudgetMs = resolvePostedReviewReviewerPressurePhaseBudgetMs(),
  postedReviewHandlerTimeoutMs = resolvePostedReviewHandlerTimeoutMs(),
  minimumHandlerStartBudgetMs = derivePostedReviewHandlerStartBudgetMs({
    headroomMs: resolvePostedReviewHandlerHeadroomMs(),
  }),
  noProgressLaneGate = createNoProgressLaneGate({ rootDir, logger }),
  runPostedReviewHandlersFairlyImpl = runPostedReviewHandlersFairly,
} = {}) {
  if (typeof drainReviewerDispatchCandidates !== 'function') {
    throw new TypeError('runQueuedReviewAdoptionPhase requires drainReviewerDispatchCandidates');
  }

  await retryPendingMergeAgentLifecycleCleanupsImpl();

  // Lifecycle sync is the authoritative "is this PR still open?" guard for the
  // health surface. It must not sit behind a single slow posted-review handler:
  // one 300s handler timeout was enough to leave the mirror stale for hours and
  // make queue-starvation/terminal-but-unmerged findings untrustworthy.
  await syncPRLifecycleImpl(octokit, operatorSurface, primaryDomainId);

  // Reviewer candidates were collected during the PR discovery sweep. Launch
  // them before the posted-review/hammer lane so a slow closer cannot hold every
  // first-pass or re-review claim until the tail of the tick.
  const reviewerDrainResult = await drainReviewerDispatchCandidates('posted-review handlers');
  const reviewerDispatchCount = Number(reviewerDrainResult?.dispatched || 0);
  const reviewerDeferredCount = Number(reviewerDrainResult?.deferred || 0);
  const reviewerPressure = reviewerDispatchCount > 0 || reviewerDeferredCount > 0;
  const reviewerPressurePhaseBudgetMs = Number(postedReviewReviewerPressurePhaseBudgetMs);
  const boundedReviewerPressurePhaseBudgetMs =
    Number.isFinite(reviewerPressurePhaseBudgetMs) && reviewerPressurePhaseBudgetMs > 0
      ? reviewerPressurePhaseBudgetMs
      : postedReviewPhaseBudgetMs;
  const effectivePostedReviewPhaseBudgetMs = reviewerPressure
    ? Math.min(postedReviewPhaseBudgetMs, boundedReviewerPressurePhaseBudgetMs)
    : postedReviewPhaseBudgetMs;
  if (reviewerPressure && effectivePostedReviewPhaseBudgetMs < postedReviewPhaseBudgetMs) {
    logger?.warn?.(
      `[watcher] posted-review phase budget capped under reviewer pressure: ` +
        `dispatched=${reviewerDispatchCount} deferred=${reviewerDeferredCount} ` +
        `budget_ms=${effectivePostedReviewPhaseBudgetMs} ` +
        `normal_budget_ms=${postedReviewPhaseBudgetMs}`,
    );
  }

  // WPS-01/RVHAND-01: this loop used to be unbounded — every queued handler, to
  // completion, every tick. When the queue filled with PRs that could not
  // advance, the tick stopped finishing and pollOnce never returned to phase 1,
  // so brand-new PRs were never discovered at all. The scheduler bounds the
  // phase (wall-clock budget + per-handler deadline) and consults the
  // no-progress lane, which is what stops the same unadvanceable set from
  // re-consuming the budget on every tick. It now runs after lifecycle sync, so
  // stale terminal rows are cleaned before any per-PR hammer path can wait.
  await runPostedReviewHandlersFairlyImpl({
    handlers: postedReviewHandlers,
    state: postedReviewFairness,
    budgetMs: effectivePostedReviewPhaseBudgetMs,
    handlerTimeoutMs: postedReviewHandlerTimeoutMs,
    minimumHandlerStartBudgetMs,
    laneGate: noProgressLaneGate,
    logger,
  });

  // TREC-01: drains the Linear triage syncs owed by terminal transitions. This
  // is what lets syncPRLifecycle record a merge/close immediately instead of
  // holding the row `pr_state=open` as the retry vehicle -- the behaviour that
  // made review:queue_starvation and review:terminal_but_unmerged fire forever
  // on already-terminal PRs.
  try {
    const triageDrain = await retryPendingTriageSyncsImpl({
      rootDir,
      operatorSurface,
      buildSubjectRef: buildTriageSubjectRef,
      logger,
    });
    if (triageDrain.attempted > 0) {
      logger.log(
        `[watcher] triage sync retry: attempted=${triageDrain.attempted} `
        + `synced=${triageDrain.synced} pending=${triageDrain.pending}`
      );
    }
  } catch (err) {
    logger.error('[watcher] triage sync retry failed:', err?.message || err);
  }
  await retryPendingDagAutowalkOnMergeImpl();
  await retryPendingMergeCloseoutsImpl({ octokit });

  try {
    const ackRetry = await retryPendingRetriggerAckCommentsImpl({
      rootDir,
      execFileImpl,
    });
    if (ackRetry.attempted > 0) {
      logger.log(
        `[watcher] retrigger-remediation ack retry: attempted=${ackRetry.attempted} posted=${ackRetry.posted}`
      );
    }
  } catch (err) {
    logger.error('[watcher] retrigger-remediation ack retry failed:', err?.message || err);
  }

  try {
    const reviewAckRetry = await retryPendingRetriggerReviewAckCommentsImpl({
      rootDir,
      execFileImpl,
    });
    if (reviewAckRetry.attempted > 0) {
      logger.log(
        `[watcher] retrigger-review ack retry: attempted=${reviewAckRetry.attempted} posted=${reviewAckRetry.posted}`
      );
    }
  } catch (err) {
    logger.error('[watcher] retrigger-review ack retry failed:', err?.message || err);
  }

  for (const postReviewMaintenanceHandler of postReviewMaintenanceHandlers) {
    try {
      await postReviewMaintenanceHandler.run();
    } catch (err) {
      logger.error(
        `[watcher] post-review maintenance failed for ${postReviewMaintenanceHandler.repoPath}:`,
        err?.message || err
      );
    }
  }

}
