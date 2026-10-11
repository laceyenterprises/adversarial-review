import { isOperatorHeld } from '../operator-hold-labels.mjs';

// This is lane admission, not merge authority. The in-lease predicate still
// checks the exact head and every merge gate. Unreadable quota is unchanged.
export function mergeLeaseAdmissionReason(pr, headSha, stop = null) {
  if (pr?.headRefOid !== headSha) return 'head-changed';
  if (pr?.state !== 'OPEN') return 'pr-not-open';
  if (pr?.isDraft === true) return 'pr-is-draft';
  if (isOperatorHeld(pr?.labels)) return 'operator-hold';
  if (/operator.*decision|decision.*operator|needs-operator|awaiting-operator/i.test(stop?.predicate || '')) return 'operator-decision';
  return null;
}
