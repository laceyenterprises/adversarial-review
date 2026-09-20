export const DUPLICATE_FAMILY_LABEL = 'duplicate-family';
export const DUPLICATE_FAMILY_HOLD_LABEL = 'duplicate-family-hold';
export const DUPLICATE_FAMILY_UNRESOLVED_REASON = 'duplicate-family-unresolved';

function parseOverride(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
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
  if (status === 'abandoned') {
    return { member: true, held: true, reason: DUPLICATE_FAMILY_UNRESOLVED_REASON, release: null };
  }

  const candidatePrNumber = Number(prNumber ?? family.pr_number);
  const candidateHeadSha = String(headSha ?? family.candidate_head_sha ?? '').trim();
  const override = parseOverride(family.operator_override_json ?? family.operatorOverride);
  const overridePrNumber = Number(override?.candidatePrNumber ?? override?.prNumber);
  const overrideHeadSha = String(override?.candidateHeadSha ?? override?.headSha ?? '').trim();
  const currentCandidateOverride = Boolean(
    override && override.stale !== true &&
    Number.isInteger(candidatePrNumber) && candidatePrNumber === overridePrNumber &&
    candidateHeadSha && candidateHeadSha === overrideHeadSha
  );

  if (String(override?.disposition || '').toLowerCase() === 'ignored-not-duplicate' && currentCandidateOverride) {
    return { member: true, held: false, reason: null, release: 'ignored-not-duplicate' };
  }

  const selectedSurvivor = Number(
    family.selected_survivor_pr_number ?? family.selectedSurvivorPrNumber,
  );
  const reportPath = String(family.report_path ?? family.reportPath ?? '').trim();
  const survivorSelected = String(override?.disposition || '').toLowerCase() === 'survivor-selected';
  if (
    survivorSelected && reportPath && Number.isInteger(selectedSurvivor) &&
    candidatePrNumber === selectedSurvivor &&
    (!overrideHeadSha || currentCandidateOverride)
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
