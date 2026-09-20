export const DUPLICATE_FAMILY_LABEL = 'duplicate-family';
export const DUPLICATE_FAMILY_HOLD_LABEL = 'duplicate-family-hold';
export const DUPLICATE_FAMILY_UNRESOLVED_REASON = 'duplicate-family-unresolved';

function parseOverride(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function evaluateDuplicateFamilyCandidate(family = null, {
  prNumber = null,
  headSha = null,
} = {}) {
  if (!family) return { member: false, held: false, reason: null, release: null };

  const status = String(family.status || '').trim().toLowerCase();
  if (status === 'inactive' || status === 'resolved') {
    return { member: true, held: false, reason: null, release: status };
  }

  const override = parseOverride(family.operator_override_json);
  const ignored = Array.isArray(override.ignoredCandidates) ? override.ignoredCandidates : [];
  const currentIgnore = ignored.find((entry) => (
    Number(entry?.candidatePrNumber) === Number(prNumber)
    && String(entry?.candidateHeadSha || '') === String(headSha || '')
    && entry?.stale !== true
  ));
  if (currentIgnore) {
    return { member: true, held: false, reason: null, release: 'ignored-not-duplicate' };
  }

  const selection = override.selection || (
    override.transition === 'survivor-selected' ? override : null
  );
  if (
    status === 'survivor-selected'
    && Number(family.selected_survivor_pr_number) === Number(prNumber)
    && Number(selection?.candidatePrNumber) === Number(prNumber)
    && String(selection?.candidateHeadSha || '') === String(headSha || '')
    && String(selection?.reportVerifiedHeadSha || '') === String(headSha || '')
    && String(selection?.reportPath || family.report_path || '').trim()
    && selection?.stale !== true
  ) {
    return { member: true, held: false, reason: null, release: 'survivor-selected' };
  }

  return {
    member: true,
    held: true,
    reason: DUPLICATE_FAMILY_UNRESOLVED_REASON,
    release: null,
  };
}

export function labelsContainDuplicateFamilyHold(labels) {
  return (Array.isArray(labels) ? labels : []).some((label) => (
    String(typeof label === 'string' ? label : label?.name || '').trim().toLowerCase() ===
    DUPLICATE_FAMILY_HOLD_LABEL
  ));
}
