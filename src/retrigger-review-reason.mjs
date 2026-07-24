export const RETRIGGER_REVIEW_REASON_MARKER = 'retrigger-review';

export function normalizeOperatorRetriggerReason(reason) {
  const trimmed = String(reason || '').trim();
  const markerPrefix = `${RETRIGGER_REVIEW_REASON_MARKER}:`;
  if (trimmed.toLowerCase().startsWith(markerPrefix)) {
    const suffix = trimmed.slice(markerPrefix.length).trim();
    return `${markerPrefix} ${suffix || 'operator requested re-review'}`;
  }
  return `${markerPrefix} ${trimmed || 'operator requested re-review'}`;
}

export function isExplicitOperatorRetriggerReason(reason) {
  return String(reason || '')
    .trim()
    .toLowerCase()
    .startsWith(`${RETRIGGER_REVIEW_REASON_MARKER}:`);
}
