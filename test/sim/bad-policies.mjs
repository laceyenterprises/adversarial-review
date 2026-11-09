// Deliberately broken policies, kept OUT of the production fold. Starting from
// a valid observed state isolates each oracle failure (including missing pages,
// which a duplicate-only assertion would miss).
export function healthyObservation() {
  return { now: 10, bound: 100, head: 'revision-A', terminal: null,
    owners: [{ kind: 'agent', head: 'revision-A', verified: true, status: 'running' }],
    deadline: 50, merges: [], activation: true, causes: [], pages: [], transientCharges: 0, transientRefusals: 0 };
}
export const badPolicies = {
  'owner-deadline': s => { s.owners = []; },
  'bounded-terminal': s => { s.now = 100; s.deadline = 150; },
  'fresh-merge': s => { s.merges.push({ revision: 'obsolete', liveHead: s.head, blocking: 0, comments: 0 }); },
  'addressed-findings': s => { s.merges.push({ revision: s.head, liveHead: s.head, blocking: 1, comments: 0 }); },
  'page-once': s => { s.causes = ['cause-A']; s.pages = ['cause-A', 'cause-A']; },
  'transient-retry': s => { s.transientCharges = 1; },
  'live-custody': s => { s.owners[0].status = 'canceled'; },
};
