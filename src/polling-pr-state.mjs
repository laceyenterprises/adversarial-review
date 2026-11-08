import { fetchConditionalRestPage } from './conditional-request.mjs';

// Revalidate on every poll. Only an authenticated 304 permits reuse; a cached
// snapshot by itself never proves that a PR is still open or on the same head.
export async function fetchPollingPrState(octokit, rootDir, repo, prNumber) {
  const [owner, name] = repo.split('/');
  const { data: pr } = await fetchConditionalRestPage({
    rootDir, repo, prNumber, category: 'pr_head_state',
    endpoint: 'GET /repos/{owner}/{repo}/pulls/{pull_number}',
    params: { owner, repo: name, pull_number: prNumber },
    request: params => octokit.rest.pulls.get(params),
  });
  if (!pr?.head?.sha || !['open', 'closed'].includes(pr.state)) {
    throw new Error(`Incomplete polling state for ${repo}#${prNumber}`);
  }
  return {
    state: pr.merged_at ? 'MERGED' : pr.state.toUpperCase(),
    headRefOid: pr.head.sha, mergedAt: pr.merged_at || null,
    closedAt: pr.closed_at || null, author: pr.user,
    labels: pr.labels,
  };
}
