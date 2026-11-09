// Independent safety/liveness oracle. Inspect effects and verified evidence,
// never infer successful merge, custody or paging from a decision name.
export const invariants = ['owner-deadline', 'bounded-terminal', 'fresh-merge', 'addressed-findings',
  'page-once', 'transient-retry', 'live-custody'];

export function violations(s) {
  const failures = new Set();
  const live = !s.terminal;
  if (live && (s.owners.length !== 1 || !Number.isFinite(s.deadline) || s.deadline < s.now
    || s.owners[0]?.head !== s.head)) failures.add('owner-deadline');
  if (s.now >= s.bound && !['finalized', 'escalated', 'operator-hold'].includes(s.terminal)) failures.add('bounded-terminal');
  if (s.terminal === 'escalated' && !s.causes.length) failures.add('bounded-terminal');
  if (s.terminal === 'finalized' && (!s.merges.length || !s.activation)) failures.add('bounded-terminal');
  for (const merge of s.merges) {
    if (merge.revision !== merge.liveHead) failures.add('fresh-merge');
    if (merge.blocking > 0 || merge.comments > 0) failures.add('addressed-findings');
  }
  for (const cause of s.causes) {
    const pages = s.pages.filter(p => p === cause).length;
    if (pages !== 1) failures.add('page-once');
    if (pages === 0 && s.terminal === 'escalated') failures.add('bounded-terminal');
  }
  for (const page of s.pages) if (!s.causes.includes(page)) failures.add('page-once');
  if (s.transientRefusals > 0 || s.transientCharges > 0) failures.add('transient-retry');
  for (const owner of s.owners) {
    if (owner.kind === 'agent' && (!owner.verified || owner.status !== 'running' || owner.dirtyTerminal)) failures.add('live-custody');
  }
  return [...failures].sort();
}
