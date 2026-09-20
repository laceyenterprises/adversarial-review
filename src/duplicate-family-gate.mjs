export const DUPLICATE_FAMILY_LABEL = 'duplicate-family';
export const DUPLICATE_FAMILY_HOLD_LABEL = 'duplicate-family-hold';
export const DUPLICATE_FAMILY_UNRESOLVED_REASON = 'duplicate-family-unresolved';

export function evaluateDuplicateFamilyCandidate(family = null, {
  prNumber: _prNumber = null,
  headSha: _headSha = null,
} = {}) {
  if (!family) return { member: false, held: false, reason: null, release: null };

  const status = String(family.status || '').trim().toLowerCase();
  if (status === 'inactive') {
    return { member: true, held: false, reason: null, release: status };
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
