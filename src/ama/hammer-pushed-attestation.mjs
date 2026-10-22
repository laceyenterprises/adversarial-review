import { hammerProvenanceEdge } from './hammer-head-validation.mjs';
import { filterGitHubBody } from '../github-outbound-body.mjs';

export const HAM_PUSHED_ATTESTATION_MARKER = '<!-- hq:ham-pushed-head -->';

// Publication provenance is independent of CI and the merge lease. The caller
// supplies only the exact successful push result, never a later branch tip.
export async function publishPushedHammerAttestation({ repo, prNumber, baseHead, pushedHead, api }) {
  if (![baseHead, pushedHead].every(value => /^[a-f0-9]{40}$/.test(value || '')))
    throw new Error('invalid pushed hammer edge');
  if (baseHead === pushedHead) return { published: false, reason: 'unchanged' };
  const body = filterGitHubBody(`${HAM_PUSHED_ATTESTATION_MARKER}\n`
    + 'Hammer publication provenance; CI not validated. Exact-head checks are still required before merge.\n'
    + `HAM-Base-Head: ${baseHead}\nHAM-Pushed-Head: ${pushedHead}\nHAM-CI-Validated: false\n`,
  { repo, reviewerHeadSha: pushedHead });
  const identity = await api('graphql', { query: '{ viewer { login } }' });
  if (!hammerProvenanceEdge({ author: identity?.data?.viewer?.login, body }))
    throw new Error('pushed hammer edge requires the entitled hammer App');
  const path = `repos/${repo}/issues/${prNumber}/comments`;
  for (let page = 1; ; page++) {
    const comments = await api(`${path}?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) throw new Error('invalid hammer comment page');
    const existing = comments.find(comment => {
      const edge = hammerProvenanceEdge(comment);
      return edge?.base === baseHead && edge.head === pushedHead
        && String(comment.body || '').includes(HAM_PUSHED_ATTESTATION_MARKER);
    });
    if (existing) return { published: true, duplicate: true, commentId: existing.id };
    if (comments.length < 100) break;
  }
  const comment = await api(path, { body });
  return { published: true, commentId: comment.id };
}
