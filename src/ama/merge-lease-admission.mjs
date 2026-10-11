import { isOperatorHeld } from '../operator-hold-labels.mjs';

// This is lane admission, not merge authority. The in-lease predicate still
// checks the exact head and every merge gate. Unreadable quota is unchanged.
// Historical hammer stops belong to evaluateHammerStopHold in the closer,
// which releases them on changed inputs, including conflicts on the same head.
export function mergeLeaseAdmissionReason(pr, headSha) {
  if (pr?.state === 'MERGED') return 'pr-merged';
  if (pr?.headRefOid !== headSha) return 'head-changed';
  if (pr?.state !== 'OPEN') return 'pr-not-open';
  if (pr?.isDraft === true) return 'pr-is-draft';
  if (isOperatorHeld(pr?.labels)) return 'operator-hold';
  return null;
}
