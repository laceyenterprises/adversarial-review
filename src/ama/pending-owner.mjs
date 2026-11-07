// CLOSERREVIVE-01: name who owns an AMA-pending PR. The watcher used to log
// "retained ownership ... lrq=unknown workerClass=unknown" for a PR whose only
// owner was a non-launch actor (a remediation job, a reviewer) or no one.
const text = value => (typeof value === 'string' || typeof value === 'number') ? String(value).trim() : '';

export function describeAmaPendingOwner(result, { launching = false, leaseWait = false } = {}) {
  const lrq = text(result?.launchRequestId) || text(result?.dispatchId);
  if (lrq) return { owned: true, label: `lrq=${lrq}`, workerClass: text(result?.workerClass) || 'unknown' };
  const next = result?.nextAction;
  const actor = text(next?.actor);
  if (actor && actor !== 'none') {
    const detail = [text(next.action), text(next.reason)].filter(Boolean).join(':');
    return { owned: true, label: `owner=${actor}${detail ? `(${detail})` : ''}`,
      workerClass: text(result?.workerClass) || actor };
  }
  const reason = text(result?.reason);
  if (result?.backgroundDispatch || reason.startsWith('ama-closer-dispatch')
    || reason.startsWith('in-flight')) launching = true;
  // A closer launch still being recorded, or a lease wait, is an owner without an id yet.
  if (launching) return { owned: true, label: 'owner=closer(launching)', workerClass: text(result?.workerClass) || 'closer' };
  if (leaseWait) return { owned: true, label: 'owner=closer(lease-wait)', workerClass: text(result?.workerClass) || 'closer' };
  return { owned: false, label: 'owner=none', workerClass: text(result?.workerClass) || 'none' };
}
