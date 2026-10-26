// HAMVALIDORPHAN-01: dispatch ownership only. This evidence never carries a
// verdict or certifies CI, findings remediation, or permission to merge.
export function hammerHeadOwnership(suppression, headSha) {
  if (!headSha || suppression?.suppressed !== true
    || !['hammer-validated-head', 'closer-commit-trailer'].includes(suppression.reason)
    || (suppression.headSha && suppression.headSha !== headSha)) return null;
  return { headSha, reason: suppression.reason };
}

export function isHammerOwnedHead(ownership, headSha) {
  return Boolean(ownership && hammerHeadOwnership({ ...ownership, suppressed: true }, headSha));
}
