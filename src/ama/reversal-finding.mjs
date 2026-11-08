import { findingLocations } from '../kernel/finding-lines.mjs';

// Shared by the pre-edit planner and the primary-change gate. Commit provenance,
// ancestry and actual patch coverage still belong to the final merge predicate.
export function checkReversalFinding(parsedReview, kind, findingNumber, strictNonBlockingRemediation) {
  if (!['blocking', 'non-blocking'].includes(kind)
    || (kind === 'non-blocking' ? strictNonBlockingRemediation !== true
      : parsedReview.verdict !== 'request-changes')) {
    return { ok: false, reason: 'finding-kind-not-authorizing' };
  }
  const finding = Number.isSafeInteger(findingNumber) && findingNumber > 0
    ? parsedReview.findings[kind]?.[findingNumber - 1] : null;
  if (!finding) return { ok: false, reason: 'finding-not-found' };
  const locations = finding.citedLocations ??= findingLocations(finding.file, finding.lines);
  if (locations.length === 0) {
    return { ok: false, reason: `finding-lines-unreadable: ${JSON.stringify(String(finding.lines || '').slice(0, 200))}` };
  }
  if (locations.some(location => location.ranges.some(({ start, end }) => !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end) || start < 1 || end < start))) {
    return { ok: false, reason: 'finding-lines-invalid' };
  }
  return { ok: true, finding, locations };
}
