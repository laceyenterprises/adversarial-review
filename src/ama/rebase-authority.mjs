export const DEFAULT_REBASE_ATTEMPT_CAP = 3;

const BEHIND_MERGE_STATES = new Set(['BEHIND']);

function normalizeSha(value) {
  return String(value || '').trim();
}

function normalizePatchIds(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map(value => String(value || '').trim())
    .filter(Boolean);
}

function multiset(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

export function compareReviewedPatchIds(reviewedPatchIds, rebasedPatchIds) {
  const reviewed = normalizePatchIds(reviewedPatchIds);
  const rebased = normalizePatchIds(rebasedPatchIds);
  const reviewedCounts = multiset(reviewed);
  const rebasedCounts = multiset(rebased);
  const dropped = [];
  const added = [];

  for (const [patchId, count] of reviewedCounts.entries()) {
    const rebasedCount = rebasedCounts.get(patchId) || 0;
    for (let index = rebasedCount; index < count; index += 1) dropped.push(patchId);
  }
  for (const [patchId, count] of rebasedCounts.entries()) {
    const reviewedCount = reviewedCounts.get(patchId) || 0;
    for (let index = reviewedCount; index < count; index += 1) added.push(patchId);
  }

  return {
    equivalent: dropped.length === 0 && added.length === 0,
    reviewedCount: reviewed.length,
    rebasedCount: rebased.length,
    dropped,
    added,
  };
}

export function requiresRebaseRecovery({
  reviewedHead,
  currentHead,
  mergeStateStatus = null,
  baseBehind = false,
} = {}) {
  const reviewed = normalizeSha(reviewedHead);
  const current = normalizeSha(currentHead);
  const mergeState = String(mergeStateStatus || '').trim().toUpperCase();
  return Boolean(
    (reviewed && current && reviewed !== current)
      || BEHIND_MERGE_STATES.has(mergeState)
      || baseBehind === true,
  );
}

export function assessRebaseRecovery({
  reviewedHead,
  currentHead,
  mergeStateStatus = null,
  baseBehind = false,
  attempts = 0,
  cap = DEFAULT_REBASE_ATTEMPT_CAP,
  conflict = false,
  reviewedPatchIds = [],
  rebasedPatchIds = [],
  reverifyEligible = false,
  reverifyReasons = [],
  hamRemediationCommit = false,
  hamTerminalRemediationValidated = false,
} = {}) {
  const rebaseNeeded = requiresRebaseRecovery({
    reviewedHead,
    currentHead,
    mergeStateStatus,
    baseBehind,
  });
  if (!rebaseNeeded) {
    return {
      action: 'no-rebase-needed',
      hardBlocker: false,
      rebaseNeeded: false,
      attempts,
      cap,
      evidence: 'head_sha_matches_review',
    };
  }

  if (Number(attempts) >= Number(cap || DEFAULT_REBASE_ATTEMPT_CAP)) {
    return {
      action: 'hard-blocker',
      hardBlocker: true,
      rebaseNeeded: true,
      reason: 'rebase-attempt-cap-exceeded',
      attempts,
      cap,
    };
  }

  if (conflict === true) {
    return {
      action: 'hard-blocker',
      hardBlocker: true,
      rebaseNeeded: true,
      reason: 'unresolvable-rebase-conflict',
      attempts,
      cap,
    };
  }

  if (hamRemediationCommit === true) {
    if (hamTerminalRemediationValidated !== true) {
      return {
        action: 'exact-head-validation-required',
        hardBlocker: false,
        rebaseNeeded: true,
        reason: 'ham-remediation-requires-terminal-validation',
        attempts,
        cap,
      };
    }
    if (reverifyEligible !== true) {
      return {
        action: 'hard-blocker',
        hardBlocker: true,
        rebaseNeeded: true,
        reason: 'post-rebase-verdict-not-settled-success',
        reverifyReasons,
        attempts,
        cap,
      };
    }
    return {
      action: 'merge',
      hardBlocker: false,
      rebaseNeeded: true,
      attempts,
      cap,
      evidence: 'ham_terminal_remediation_validated',
    };
  }

  const contentEquivalence = compareReviewedPatchIds(reviewedPatchIds, rebasedPatchIds);
  if (!contentEquivalence.equivalent) {
    return {
      action: 'exact-head-validation-required',
      hardBlocker: false,
      rebaseNeeded: true,
      reason: 'rebased-content-not-review-equivalent',
      contentEquivalence,
      attempts,
      cap,
    };
  }

  if (reverifyEligible !== true) {
    return {
      action: 'hard-blocker',
      hardBlocker: true,
      rebaseNeeded: true,
      reason: 'post-rebase-verdict-not-settled-success',
      reverifyReasons,
      contentEquivalence,
      attempts,
      cap,
    };
  }

  return {
    action: 'merge',
    hardBlocker: false,
    rebaseNeeded: true,
    attempts,
    cap,
    evidence: 'content_equivalent_rebased_head',
    contentEquivalence,
  };
}
