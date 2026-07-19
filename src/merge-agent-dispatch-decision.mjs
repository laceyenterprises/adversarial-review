// Merge-agent dispatch-decision policy.
//
// Pure decision helpers extracted verbatim from follow-up-merge-agent.mjs
// (ARC-19 wave 3): the pick/gate functions that decide whether — and with which
// trigger — a merge-agent is dispatched for a PR, the operator-approval and
// merge-agent-request scope validators, and the two feature-flag gate readers
// those decisions default to.
//
// This is a leaf module: it imports only from sibling modules and never from
// follow-up-merge-agent.mjs, keeping the import graph acyclic. `normalizeLabelNames`
// and `normalizeFollowUpJobStatus` are kept here as behavior-preserving private
// copies of the monolith's trivial primitives (same precedent as
// fast-merge-processing.mjs / remediation-git-pr-io.mjs) instead of imported
// back, so the monolith can import this leaf without a cycle.

import {
  MERGE_AGENT_REQUESTED_LABEL,
  MERGE_AGENT_STUCK_LABEL,
  NO_MERGE_HOLD_LABEL,
  OPERATOR_APPROVED_LABEL,
} from './adapters/operator/github-pr-label-controls/index.mjs';
import { MODULE_CONFIG_PATH } from './role-config.mjs';
import { loadConfigCached } from './config-loader.mjs';
import { normalizeReviewVerdict } from './review-verdict.mjs';
import {
  FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER,
  FINAL_PASS_BLOCKER_REMEDIATION_TRIGGER,
  REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER,
} from './merge-agent-prompt.mjs';


// Final-pass-on-request-changes is the opt-in escape valve for the
// convergence-loop deadlock observed on 2026-05-14: when the reviewer
// keeps returning Request changes and the round budget exhausts before
// any verdict turns clean, every PR halts and waits for the operator.
// With this flag enabled, the merge-agent is dispatched anyway once
// remediationCurrentRound >= remediationMaxRounds, on the explicit
// design assumption that the merge-agent's own comment_only_followups
// sub-worker is the right place to triage final reviewer findings
// (apply if trivial, defer if non-trivial, refuse to merge if a
// blocker-class issue is still standing).
//
// DEFAULT: ON. The legacy "halt at max-rounds-reached + Request changes"
// behavior strands every PR at the operator's desk and grinds the
// pipeline to a halt — see operator reports on PRs #426 (2026-05-14) and
// #504 (2026-05-16). The remediation worker's job is to remediate, not
// to be the gate that decides whether a PR can merge; the merge-agent +
// comment_only_followups sub-worker are the right place for the final
// substance triage, with the universal hard gates (failing CI,
// non-mergeable state, blocker-class findings, hard-skip labels) still
// applying as the safety floor.
//
// The env var stays as an explicit off-switch for operators who want
// the legacy halt behavior (e.g., OSS deployments without a configured
// merge-agent backend). Set MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES=0
// to disable.
const FINAL_PASS_ON_REQUEST_CHANGES_ENV = 'MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES';
const DETERMINISTIC_CONVERGENCE_TERMINAL_ENV = 'MERGE_AGENT_DETERMINISTIC_CONVERGENCE_TERMINAL';
const DETERMINISTIC_CONVERGENCE_TERMINAL_CANONICAL_ENV =
  'AGENT_OS_FEATURE_FLAGS_MERGE_AGENT_DETERMINISTIC_CONVERGENCE_TERMINAL';

const _FINAL_PASS_CONFIG_WARNED_PATHS = new Set();

// Behavior-preserving private copies of the monolith's trivial normalizers,
// kept local to avoid a follow-up-merge-agent.mjs <-> leaf import cycle.
function normalizeLabelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === 'string') return label.trim().toLowerCase();
      if (typeof label?.name === 'string') return label.name.trim().toLowerCase();
      return '';
    })
    .filter(Boolean);
}

function normalizeFollowUpJobStatus(status) {
  const text = String(status ?? '').trim().toLowerCase();
  if (text === 'in_progress') return 'in-progress';
  return text;
}

function isFinalPassOnRequestChangesEnabled({
  env = process.env,
  logger = console,
  topPath,
  modulePaths,
} = {}) {
  const raw = env?.[FINAL_PASS_ON_REQUEST_CHANGES_ENV];
  let effectiveRaw = raw;
  if (effectiveRaw == null) {
    const configEnv = env?.AGENT_OS_CONFIG_PATH == null
      ? {}
      : { AGENT_OS_CONFIG_PATH: env.AGENT_OS_CONFIG_PATH };
    try {
      effectiveRaw = loadConfigCached({
        env: configEnv,
        topPath,
        modulePaths: modulePaths || [MODULE_CONFIG_PATH],
      }).get('feature_flags.merge_agent_final_pass_on_request_changes')
        ? 'true'
        : 'false';
    } catch (err) {
      const warnKey = `${topPath || configEnv.AGENT_OS_CONFIG_PATH || '<default>'}|${(modulePaths || [MODULE_CONFIG_PATH]).join(':')}`;
      if (!_FINAL_PASS_CONFIG_WARNED_PATHS.has(warnKey)) {
        _FINAL_PASS_CONFIG_WARNED_PATHS.add(warnKey);
        if (logger && typeof logger.warn === 'function') {
          logger.warn(
            '[merge-agent] failed to load feature_flags.merge_agent_final_pass_on_request_changes; '
            + `falling back to default ON. ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      return true;
    }
  }
  const normalized = String(effectiveRaw).trim().toLowerCase();
  if (normalized === '') return true; // empty → default ON
  if (normalized === '0' || normalized === 'false' || normalized === 'no') {
    return false;
  }
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
    return true;
  }
  // Unknown value: fail-CLOSED. A typo'd env should not silently broaden
  // merge authority. Operators see a hard-log line they can grep for
  // when triaging unexpected halt behavior.
  if (logger && typeof logger.warn === 'function') {
    logger.warn(
      `[merge-agent] ${FINAL_PASS_ON_REQUEST_CHANGES_ENV}=${JSON.stringify(effectiveRaw)} `
      + 'is not a recognized boolean (use 1/true/yes or 0/false/no); '
      + 'falling back to OFF (legacy halt-at-max-rounds-reached behavior). '
      + 'Unset the env var to use the default-ON behavior.'
    );
  }
  return false;
}

function isDeterministicConvergenceTerminalEnabled({
  env = process.env,
  logger = console,
  topPath,
  modulePaths,
} = {}) {
  const raw = env?.[DETERMINISTIC_CONVERGENCE_TERMINAL_ENV]
    ?? env?.[DETERMINISTIC_CONVERGENCE_TERMINAL_CANONICAL_ENV];
  let effectiveRaw = raw;
  if (effectiveRaw == null) {
    const configEnv = env?.AGENT_OS_CONFIG_PATH == null
      ? {}
      : { AGENT_OS_CONFIG_PATH: env.AGENT_OS_CONFIG_PATH };
    try {
      effectiveRaw = loadConfigCached({
        env: configEnv,
        topPath,
        modulePaths: modulePaths || [MODULE_CONFIG_PATH],
      }).get('feature_flags.merge_agent_deterministic_convergence_terminal')
        ? 'true'
        : 'false';
    } catch (err) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn(
          '[merge-agent] failed to load feature_flags.merge_agent_deterministic_convergence_terminal; '
          + `falling back to default OFF. ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return false;
    }
  }
  const normalized = String(effectiveRaw).trim().toLowerCase();
  if (normalized === '') return false;
  if (normalized === '0' || normalized === 'false' || normalized === 'no') {
    return false;
  }
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
    return true;
  }
  if (logger && typeof logger.warn === 'function') {
    logger.warn(
      `[merge-agent] ${DETERMINISTIC_CONVERGENCE_TERMINAL_ENV}=${JSON.stringify(effectiveRaw)} `
      + 'is not a recognized boolean (use 1/true/yes or 0/false/no); falling back to OFF.'
    );
  }
  return false;
}


function pickMergeAgentDispatch(job, {
  recentDispatches = [],
  finalPassOnRequestChangesEnabled = isFinalPassOnRequestChangesEnabled(),
  deterministicConvergenceTerminalEnabled = isDeterministicConvergenceTerminalEnabled(),
  blockingFinalPassAttempted = false,
} = {}) {
  return pickMergeAgentDispatchDetail(job, {
    recentDispatches,
    finalPassOnRequestChangesEnabled,
    deterministicConvergenceTerminalEnabled,
    blockingFinalPassAttempted,
  }).decision;
}

function pickMergeAgentDispatchDetail(job, {
  recentDispatches = [],
  finalPassOnRequestChangesEnabled = isFinalPassOnRequestChangesEnabled(),
  deterministicConvergenceTerminalEnabled = isDeterministicConvergenceTerminalEnabled(),
  blockingFinalPassAttempted = false,
} = {}) {
  const normalizedVerdict = normalizeReviewVerdict(job?.lastVerdict);
  const labels = new Set(normalizeLabelNames(job?.labels));
  const hasMergeAgentRequestedLabel = labels.has(MERGE_AGENT_REQUESTED_LABEL);
  const mergeAgentRequested = hasMergeAgentRequestedLabel && isScopedMergeAgentRequest(job);
  const hasOperatorApprovedLabel = labels.has(OPERATOR_APPROVED_LABEL);
  const operatorApproved = hasOperatorApprovedLabel && isScopedOperatorApproval(job);
  const alreadyDispatched = recentDispatches.some((entry) => (
    String(entry?.repo ?? '') === String(job?.repo ?? '')
    && Number(entry?.prNumber) === Number(job?.prNumber)
    && String(entry?.headSha ?? '') === String(job?.headSha ?? '')
  ));

  // Hard skips that even an operator override does NOT bypass include
  // closed/merged PRs and explicit do-not-merge labels.
  // `operator-approved` also keeps mergeability/checks as hard gates,
  // but bypasses review/remediation-state gates for the current head.
  // `merge-agent-requested` is different: it asks the merge-agent to
  // clean/rebase the branch, so it can bypass current
  // mergeability/check/verdict gates, the terminal `merge-agent-stuck`
  // handoff marker for the current head, but not closed PRs, active
  // remediation, other hard stop labels, or duplicate-dispatch
  // protection.
  if (String(job?.prState ?? '').trim().toLowerCase() !== 'open' || Boolean(job?.merged)) {
    return { decision: 'skip-pr-not-open', trigger: null };
  }

  const hasUnbypassableSkipLabel = labels.has('merge-agent-skip')
    || labels.has('do-not-merge')
    || labels.has(NO_MERGE_HOLD_LABEL);
  if (hasUnbypassableSkipLabel) {
    return { decision: 'skip-operator-skip', trigger: null };
  }
  const hasMergeAgentStuckLabel = labels.has(MERGE_AGENT_STUCK_LABEL);
  if (hasMergeAgentStuckLabel && hasMergeAgentRequestedLabel && !mergeAgentRequested) {
    return { decision: 'skip-merge-agent-requested-stale', trigger: null };
  }
  if (hasMergeAgentStuckLabel && !mergeAgentRequested) {
    return { decision: 'skip-operator-skip', trigger: null };
  }

  if (operatorApproved) {
    const hardGateDecision = pickOperatorApprovedMergeGate(job);
    if (hardGateDecision.decision !== 'dispatch') {
      return hardGateDecision;
    }
    return alreadyDispatched
      ? { decision: 'skip-already-dispatched', trigger: null }
      : { decision: 'dispatch', trigger: OPERATOR_APPROVED_LABEL };
  }

  const latestFollowUpJobStatus = normalizeFollowUpJobStatus(job?.latestFollowUpJobStatus);
  if (
    latestFollowUpJobStatus === 'in-progress'
    || latestFollowUpJobStatus === 'pending'
  ) {
    return { decision: 'skip-remediation-active', trigger: null };
  }

  const normalDecision = pickNormalMergeAgentDispatchDetail({
    job,
    normalizedVerdict,
    operatorApproved,
    hasOperatorApprovedLabel,
    finalPassOnRequestChangesEnabled,
    deterministicConvergenceTerminalEnabled,
    blockingFinalPassAttempted,
  });
  if (normalDecision.decision === 'dispatch') {
    const dispatchDecision = !normalDecision.trigger && mergeAgentRequested
      ? { decision: 'dispatch', trigger: MERGE_AGENT_REQUESTED_LABEL }
      : normalDecision;
    return alreadyDispatched
      ? { decision: 'skip-already-dispatched', trigger: null }
      : dispatchDecision;
  }

  if (hasMergeAgentRequestedLabel) {
    if (!mergeAgentRequested) {
      return { decision: 'skip-merge-agent-requested-stale', trigger: null };
    }
    return alreadyDispatched
      ? { decision: 'skip-already-dispatched', trigger: null }
      : { decision: 'dispatch', trigger: MERGE_AGENT_REQUESTED_LABEL };
  }

  if (hasOperatorApprovedLabel && !operatorApproved) {
    return { decision: 'skip-operator-approval-stale', trigger: null };
  }

  return normalDecision;
}

function pickOperatorApprovedMergeGate(job) {
  if (String(job?.mergeable ?? '').trim().toUpperCase() !== 'MERGEABLE') {
    return { decision: 'skip-not-mergeable', trigger: null };
  }

  const checksConclusion = job?.checksConclusion == null
    ? null
    : String(job.checksConclusion).trim().toUpperCase();
  if (checksConclusion === null) {
    return { decision: 'skip-checks-unknown', trigger: null };
  }
  if (checksConclusion === 'PENDING') {
    return { decision: 'skip-checks-pending', trigger: null };
  }
  if (checksConclusion !== 'SUCCESS') {
    return { decision: 'skip-checks-failed', trigger: null };
  }

  return { decision: 'dispatch', trigger: OPERATOR_APPROVED_LABEL };
}

function pickReviewerTimeoutExhaustedMergeGate(job, { operatorApproved = false } = {}) {
  if (String(job?.mergeable ?? '').trim().toUpperCase() !== 'MERGEABLE') {
    return { decision: 'skip-not-mergeable', trigger: REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER };
  }

  const checksConclusion = job?.checksConclusion == null
    ? null
    : String(job.checksConclusion).trim().toUpperCase();
  if (checksConclusion === null || checksConclusion === '') {
    return { decision: 'skip-checks-unknown', trigger: REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER };
  }
  if (checksConclusion === 'PENDING') {
    return { decision: 'skip-checks-pending', trigger: REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER };
  }
  if (checksConclusion !== 'SUCCESS') {
    return { decision: 'skip-checks-failed', trigger: REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER };
  }

  if (!operatorApproved && (Number(job?.blockingFindingCount) || 0) > 0) {
    return { decision: 'skip-blockers-present', trigger: REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER };
  }
  const blockingFindingState = String(job?.blockingFindingState || 'known').trim().toLowerCase();
  if (!operatorApproved && blockingFindingState === 'unknown') {
    return { decision: 'skip-blocking-findings-unknown', trigger: REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER };
  }

  return { decision: 'dispatch', trigger: REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER };
}

function shouldUseReviewerTimeoutExhaustedMergeGate(job) {
  return (
    job?.reviewFailureClass === 'reviewer-timeout'
    && job?.reviewFailureExhausted === true
    && normalizeFollowUpJobStatus(job?.latestFollowUpJobStatus) === 'completed'
    && job?.latestFollowUpReReviewRequested === true
  );
}

function pickNormalMergeAgentDispatchDetail({
  job,
  normalizedVerdict,
  operatorApproved,
  hasOperatorApprovedLabel,
  finalPassOnRequestChangesEnabled = false,
  deterministicConvergenceTerminalEnabled = false,
  blockingFinalPassAttempted = false,
}) {
  if (shouldUseReviewerTimeoutExhaustedMergeGate(job)) {
    return pickReviewerTimeoutExhaustedMergeGate(job, { operatorApproved });
  }

  if (normalizedVerdict === null) {
    return { decision: 'skip-no-verdict', trigger: null };
  }
  if (normalizedVerdict === 'unknown') {
    return { decision: 'skip-unknown-verdict', trigger: null };
  }

  if (String(job?.mergeable ?? '').trim().toUpperCase() !== 'MERGEABLE') {
    return { decision: 'skip-not-mergeable', trigger: null };
  }

  const checksConclusion = job?.checksConclusion == null
    ? null
    : String(job.checksConclusion).trim().toUpperCase();
  if (checksConclusion === null) {
    return { decision: 'skip-checks-unknown', trigger: null };
  }
  if (checksConclusion === 'PENDING') {
    return { decision: 'skip-checks-pending', trigger: null };
  }
  if (checksConclusion !== 'SUCCESS') {
    return { decision: 'skip-checks-failed', trigger: null };
  }

  const remediationCurrentRound = Number(job?.remediationCurrentRound);
  const remediationMaxRounds = Number(job?.remediationMaxRounds);
  if (!Number.isFinite(remediationCurrentRound) || !Number.isFinite(remediationMaxRounds) || remediationMaxRounds <= 0) {
    return { decision: 'skip-remediation-state-unknown', trigger: null };
  } else if (
    remediationCurrentRound < remediationMaxRounds
    && normalizedVerdict === 'request-changes'
  ) {
    // request-changes verdict with budget left → let the remediation
    // loop continue. Merge-agent racing an in-flight remediation cycle
    // would either fight the remediation worker or merge a state the
    // reviewer asked to change.
    //
    // For a comment-only verdict we DO NOT wait for the round cap to
    // exhaust. Clean verdict = nothing to remediate = the pipeline has
    // reached its natural end and merge-agent should pick up now.
    // Previously this gate fired regardless of verdict, which forced
    // unnecessary review passes when round 1 was already clean and
    // contributed to PR #90's stuck state.
    return { decision: 'skip-remediation-claimable', trigger: null };
  }

  const blockingFindingCount = Number(job?.blockingFindingCount) || 0;
  const blockingFindingState = String(job?.blockingFindingState || 'known').trim().toLowerCase();
  const finalPassRequestChangesCandidate = (
    normalizedVerdict === 'request-changes'
    && !operatorApproved
    && finalPassOnRequestChangesEnabled
  );
  const deterministicTerminalCandidate = (
    deterministicConvergenceTerminalEnabled
    && !operatorApproved
    && remediationCurrentRound >= remediationMaxRounds
  );

  if (!operatorApproved && blockingFindingCount > 0 && !finalPassRequestChangesCandidate && !deterministicTerminalCandidate) {
    return { decision: 'skip-blockers-present', trigger: null };
  }

  // Reaching this point means remediationCurrentRound >= remediationMaxRounds.
  // Verdict is one of: 'comment-only', 'request-changes', plus any normalized
  // verdict the kernel knows about. The legacy behavior was: refuse to
  // dispatch on Request changes once the budget is exhausted unless an
  // operator-approved label was applied. In practice the reviewer almost
  // always returns Request changes on the final round (see follow-up-jobs.mjs
  // notes near LEGACY_DEFAULT_MAX_REMEDIATION_ROUNDS), which means every PR
  // converged to "operator must admin-merge" — the daemon never auto-merged
  // a single PR in the observed window leading up to 2026-05-14.
  //
  // With FINAL_PASS_ON_BUDGET_EXHAUSTED enabled, the terminal worker owns the
  // final pass: remediate every final blocking/non-blocking finding, get the
  // rebased head green, and close. The trigger value lets the dispatch record
  // and the merge-agent prompt distinguish this from an operator-approved
  // override.
  // Stale or unverifiable operator-approved label always hard-stops,
  // BEFORE the final-pass branch can fire. The label's presence is an
  // operator signal that this PR needed manual review; we will not
  // override that with automation just because the budget is
  // exhausted. The label must be removed/reapplied with valid
  // current-head scope to clear this state. Distinct from
  // skip-request-changes (no label at all) so operators can tell the
  // two failure modes apart in logs.
  if (
    normalizedVerdict === 'request-changes'
    && !operatorApproved
    && hasOperatorApprovedLabel
  ) {
    return { decision: 'skip-operator-approval-stale', trigger: null };
  }

  if (
    !operatorApproved
    && (finalPassRequestChangesCandidate || deterministicTerminalCandidate)
  ) {
    // TERMINAL AUTONOMOUS CLOSE (supersedes the old PR #901 gate): a
    // budget-exhausted Request changes review may dispatch once even with
    // standing blockers. That terminal worker remediates every final finding
    // under strict mode, gets the rebased head green, pushes, and hands off via
    // reReview.requested=true as the technical daemon signal (NOT a fresh
    // reviewer pass) — the AMA daemon then validates the HAM evidence and MERGES
    // the remediated head. It hard-stops only if a genuinely unfixable structural
    // blocker remains. If a repeated dispatch sees blockers after that one
    // automatic blocker-remediation pass was already consumed, hand off instead
    // of looping.
    if (blockingFindingState === 'unknown') {
      return { decision: 'skip-blocking-findings-unknown', trigger: null };
    }
    if (blockingFindingCount > 0 && blockingFinalPassAttempted) {
      return {
        decision: 'skip-blockers-present',
        trigger: null,
        handoffRequired: true,
        blockingFinalPassAttempted: true,
      };
    }
    return {
      decision: 'dispatch',
      trigger: blockingFindingCount > 0
        ? FINAL_PASS_BLOCKER_REMEDIATION_TRIGGER
        : FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER,
    };
  }

  if (normalizedVerdict === 'request-changes' && !operatorApproved) {
    return {
      decision: 'skip-request-changes',
      trigger: null,
    };
  }

  return {
    decision: 'dispatch',
    trigger: normalizedVerdict === 'request-changes' && operatorApproved
      ? OPERATOR_APPROVED_LABEL
      : null,
  };
}

function isScopedOperatorApproval(job) {
  const approval = job?.operatorApproval;
  if (!approval) return false;
  if (!approval.actor || String(approval.actor).trim().toLowerCase() === 'unknown') return false;
  // Self-approval check intentionally removed at single-operator scale; see
  // buildScopedOperatorApproval for the design note. Re-introduce the
  // distinct-actor rule when there is a second human reviewer.
  if (!approval.labelEventId && !approval.labelEventNodeId) return false;
  if (!approval.createdAt) return false;
  if (String(approval.headSha || '') !== String(job?.headSha || '')) return false;
  return true;
}

function isScopedMergeAgentRequest(job) {
  const request = job?.mergeAgentRequest;
  if (!request) return false;
  if (!request.actor || String(request.actor).trim().toLowerCase() === 'unknown') return false;
  if (!request.labelEventId && !request.labelEventNodeId) return false;
  if (!request.createdAt) return false;
  if (String(request.headSha || '') !== String(job?.headSha || '')) return false;
  const prUpdatedAt = request.prUpdatedAt || job?.prUpdatedAt || null;
  if (prUpdatedAt && !isoAtOrAfter(request.createdAt, prUpdatedAt)) return false;
  return true;
}

function isoAtOrAfter(candidate, floor) {
  if (!candidate || !floor) return false;
  const candidateEpoch = Date.parse(candidate);
  const floorEpoch = Date.parse(floor);
  if (Number.isNaN(candidateEpoch) || Number.isNaN(floorEpoch)) return false;
  return candidateEpoch >= floorEpoch;
}

function buildScopedOperatorApproval(candidate, latestJob) {
  const event = candidate?.operatorApprovalEvent;
  if (!event) return null;
  if (!candidate?.headSha) return null;
  // Self-approval check intentionally removed at single-operator scale: every
  // PR is authored by the operator's gh CLI identity (workers push under the
  // operator's GitHub account), so requiring a distinct actor was a 100%
  // false-positive rule and made `operator-approved` non-functional. The
  // headSha + codeScopedAt + commit-timing checks below remain as the real
  // freshness gates. Re-introduce a distinct-actor check when there is a
  // second human reviewer.
  if (String(event.headSha || '') !== String(candidate.headSha || '')) return null;
  if (!event.codeScopedAt || !isoAtOrAfter(event.createdAt, event.codeScopedAt)) return null;
  return {
    actor: event.actor || null,
    createdAt: event.createdAt || null,
    labelEventId: event.id || null,
    labelEventNodeId: event.nodeId || null,
    headSha: event.headSha || null,
    codeScopedAt: event.codeScopedAt || null,
    codeScopeEventId: event.codeScopeEventId || null,
    codeScopeEventKind: event.codeScopeEventKind || null,
  };
}

function buildScopedMergeAgentRequest(candidate) {
  const event = candidate?.mergeAgentRequestEvent;
  if (!event) return null;
  if (!candidate?.headSha) return null;
  if (candidate?.prUpdatedAt && !isoAtOrAfter(event.createdAt, candidate.prUpdatedAt)) return null;
  return {
    actor: event.actor || null,
    createdAt: event.createdAt || null,
    labelEventId: event.id || null,
    labelEventNodeId: event.nodeId || null,
    headSha: candidate.headSha,
    prUpdatedAt: candidate.prUpdatedAt || null,
  };
}


export {
  FINAL_PASS_ON_REQUEST_CHANGES_ENV,
  DETERMINISTIC_CONVERGENCE_TERMINAL_ENV,
  isFinalPassOnRequestChangesEnabled,
  isDeterministicConvergenceTerminalEnabled,
  pickMergeAgentDispatch,
  pickMergeAgentDispatchDetail,
  shouldUseReviewerTimeoutExhaustedMergeGate,
  isScopedOperatorApproval,
  isScopedMergeAgentRequest,
  buildScopedOperatorApproval,
  buildScopedMergeAgentRequest,
};
