// Watcher seam for the ARC-13 sequential review pipeline. This is the thin
// integration layer between the watcher's frozen review-drive loop and the pure
// pipeline driver (`review-pipeline-driver.mjs`).
//
// The watcher calls `runGatedReviewPipeline` in place of a single `spawnReviewer`
// ONLY when `domains/<id>.json` enables the pipeline (default off). It:
//   1. drives each stage's review through the SAME `spawnReviewer` the v1 path
//      uses, selecting the stage's prompt set by mapping the stage's registry
//      role → its `promptSet`-named domain (`code-quality` → `code-pr`,
//      `security` → `code-pr-security`), so the live cli-direct runtime assembles
//      the right rubric with no new spawn family;
//   2. folds the stage verdicts through the kernel pipeline (later stages gate on
//      earlier ones; a stage-2 remediation re-runs stage 2 only — see the
//      driver);
//   3. posts the Win 2 rollup through the comms adapter; and
//   4. returns a `spawnReviewer`-shaped result (the deciding stage's review body
//      + aggregate `ok`) so the watcher's unchanged settle/round-budget/hammer
//      accounting treats the pipeline pass exactly like a single review.
//
// Everything here is injectable (spawnReviewer, comms, verdict parsers) so the
// enabled path is unit-tested without booting the watcher. When the gate is off
// the watcher never calls this module and the v1 path is byte-identical.

import {
  classifyStructuredBlockingIssues,
  extractReviewVerdict,
  normalizeReviewVerdict,
  sanitizeReviewPayloadBestEffort,
} from './kernel/verdict.mjs';
import { runReviewPipeline } from './review-pipeline-driver.mjs';

// Best-effort so a stage whose review body is missing a canonical section does
// not throw and crash the whole pass — it degrades to an `unknown` verdict,
// which the kernel treats as indeterminate (the stage gate stays closed).
function defaultParseVerdict(reviewBody) {
  const sanitized = sanitizeReviewPayloadBestEffort(reviewBody);
  const kind = normalizeReviewVerdict(extractReviewVerdict(sanitized));
  const blocking = classifyStructuredBlockingIssues(sanitized);
  return { kind, blocking };
}

// A stage's prompt set is owned by its registry role; the live reviewer selects
// the prompt set by domain id, and every prompt set is published as a domain of
// the same id (code-pr, code-pr-security), so the role's `promptSet` IS the
// domain id to review under. Overridable for tests / future divergence.
function defaultStageDomainId(role) {
  return role?.promptSet;
}

/**
 * Drive one gated pipeline review pass. Returns a `spawnReviewer`-shaped result.
 *
 * @param {{
 *   resolvedPipeline: { pipeline: object[], rolesById: Record<string, object> },
 *   stageStates?: readonly object[],
 *   currentRevisionRef: string,
 *   riskClass?: string,
 *   budgetOverride?: number | null,
 *   observedAt?: string,
 *   spawnReviewer: (args: object) => Promise<{ ok: boolean, reviewBody: string|null, failureClass?: string|null }>,
 *   spawnReviewerArgs: object,
 *   comms?: { postPipelineRollup?: Function } | null,
 *   rollupDeliveryKey?: object | null,
 *   parseVerdict?: (body: string) => { kind: string, blocking: { count: number } },
 *   resolveStageDomainId?: (role: object) => string,
 *   logger?: Console,
 * }} params
 */
export async function runGatedReviewPipeline({
  resolvedPipeline,
  stageStates = [],
  currentRevisionRef,
  riskClass,
  budgetOverride = null,
  observedAt,
  spawnReviewer,
  spawnReviewerArgs = {},
  comms = null,
  rollupDeliveryKey = null,
  parseVerdict = defaultParseVerdict,
  resolveStageDomainId = defaultStageDomainId,
  logger = console,
} = {}) {
  if (typeof spawnReviewer !== 'function') {
    throw new TypeError('runGatedReviewPipeline requires a spawnReviewer function');
  }
  const rolesById = resolvedPipeline?.rolesById || {};
  const baseSessionUuid = String(spawnReviewerArgs?.reviewerSessionUuid || 'pipeline');

  // Fresh review bodies per stage run this pass, keyed by stage id — used to
  // pick the deciding stage's body for the drop-in result.
  const stageBodies = new Map();
  let stageFailureClass = null;

  const runStageReview = async ({ stage, roleId, model, revisionRef, round }) => {
    const role = rolesById[roleId] || {};
    const stageDomainId = resolveStageDomainId(role) || spawnReviewerArgs.domainId;
    logger?.log?.(
      `[watcher] pipeline stage "${stage.id}" review (role=${roleId}, domain=${stageDomainId}, ` +
      `round=${round}) for ${spawnReviewerArgs.repo}#${spawnReviewerArgs.prNumber}`,
    );
    const result = await spawnReviewer({
      ...spawnReviewerArgs,
      reviewerModel: model || spawnReviewerArgs.reviewerModel,
      domainId: stageDomainId,
      reviewerHeadSha: revisionRef,
      // Distinct session uuid per stage+round so the reviewer-run claim table
      // does not collide across the stages of one pass.
      reviewerSessionUuid: `${baseSessionUuid}:${stage.id}:r${round}`,
    });
    if (!result || !result.ok || !result.reviewBody) {
      stageFailureClass = result?.failureClass || 'reviewer-output';
      return null; // reviewer failure / no body → stage pending (gate closes)
    }
    const body = String(result.reviewBody);
    stageBodies.set(stage.id, body);
    const { kind, blocking } = parseVerdict(body);
    const findingCount = kind === 'request-changes'
      ? Math.max(1, blocking?.count || 0)
      : Math.max(0, blocking?.count || 0);
    const blockingFindings = Array.from({ length: findingCount }, () => ({}));
    return { kind, body, blockingFindings };
  };

  const postRollup = (comms && typeof comms.postPipelineRollup === 'function' && rollupDeliveryKey)
    ? async ({ body }) => comms.postPipelineRollup({ body }, rollupDeliveryKey)
    : null;

  const pipelineResult = await runReviewPipeline({
    resolvedPipeline,
    stageStates,
    currentRevisionRef,
    riskClass,
    budgetOverride,
    observedAt,
    runStageReview,
    postRollup,
  });

  const {
    disposition, blockingStageId, ranStageIds, rollupBody,
  } = pipelineResult;

  // The drop-in review body the watcher's settle path extracts the aggregate
  // verdict from: the blocking stage's body when blocked (carries "Request
  // changes"); otherwise the last stage that ran this pass (a clean verdict).
  let decidingBody = null;
  if (disposition === 'blocking' && blockingStageId) {
    decidingBody = stageBodies.get(blockingStageId) ?? null;
  } else if (ranStageIds.length > 0) {
    decidingBody = stageBodies.get(ranStageIds[ranStageIds.length - 1]) ?? null;
  } else if (disposition === 'clean') {
    // A fully carried-forward pass has no ephemeral stage body. Use the newest
    // persisted verdict body from the final stage as the deciding clean review.
    const finalState = pipelineResult.stageStates[pipelineResult.stageStates.length - 1];
    const currentVerdicts = finalState
      ? finalState.panelVerdicts.filter((verdict) => verdict?.revisionRef === currentRevisionRef)
      : [];
    decidingBody = newestBody(currentVerdicts);
  }

  const ok = disposition !== 'pending' && decidingBody != null;
  const result = {
    ok,
    reviewBody: ok ? decidingBody : null,
    failureClass: ok ? null : (stageFailureClass || 'reviewer-output'),
    stderrTail: ok ? null : 'review pipeline produced no deciding verdict this pass',
    stdoutTail: null,
    exitCode: ok ? 0 : null,
    signal: null,
    pgid: null,
    spawnedAt: observedAt || new Date().toISOString(),
    reattachToken: null,
    // Pipeline provenance for callers/tests that want the structured outcome.
    pipeline: pipelineResult,
    rollupBody,
  };
  return result;
}

function newestBody(verdicts) {
  for (let index = verdicts.length - 1; index >= 0; index -= 1) {
    if (typeof verdicts[index]?.body === 'string' && verdicts[index].body.length > 0) {
      return verdicts[index].body;
    }
  }
  return null;
}

export { defaultStageDomainId, defaultParseVerdict };
