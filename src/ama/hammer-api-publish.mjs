import { filterGitHubBody } from '../github-outbound-body.mjs';
// Child-process messages can embed the complete stderr (including repeated
// finding text). Keep only the first line of each diagnostic, with a fixed cap.
// Never walk .error/.cause/.output or serialize the child error graph.
export function hammerPublicationFailureReason(error) {
  const line = value => String(value || '').split(/\r?\n/, 1)[0];
  const parts = [...new Set([typeof error === 'string' ? line(error) : '',
    line(error?.code), line(error?.message), line(error?.stderr)].filter(Boolean))];
  const reason = parts.join(': ') || 'publication failed';
  return reason.length > 512 ? `${reason.slice(0, 496)} ... [truncated]` : reason;
}

// Only a pre-mutation incompatibility can authorize trying another transport.
export async function publishHammerTree({ repo, branch, expectedHead, localTree, message, changes, api }) {
  message = filterGitHubBody(message, { repo, reviewerHeadSha: expectedHead });
  let publishedHead;
  try {
    const additions = [], deletions = [];
    for (const change of changes) {
      if ((change.oldMode && change.oldMode !== '100644') || (change.mode && change.mode !== '100644')) {
        return { route: 'git-fallback' };
      }
      if (change.mode) additions.push({ path: change.path, contents: change.contents });
      else deletions.push({ path: change.path });
    }
    if (!changes.length) return { route: 'git-fallback' };
    const result = await api('graphql', { query: 'mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}',
      variables: { input: { branch: { repositoryNameWithOwner: repo, branchName: branch }, expectedHeadOid: expectedHead,
        message: { headline: message.split('\n')[0], body: message.split('\n').slice(1).join('\n') },
        fileChanges: { additions, deletions } } } });
    const head = result?.data?.createCommitOnBranch?.commit?.oid;
    if (!/^[a-f0-9]{40}$/.test(head || '') || result.errors?.length) throw new Error('API commit creation failed');
    publishedHead = head;
    const commit = await api(`repos/${repo}/commits/${head}`);
    if (commit?.commit?.tree?.sha !== localTree) throw new Error('published tree mismatch');
    return { route: 'published', head, tree: localTree };
  } catch (error) {
    let phaseOutcome = 'source-publication-refused';
    // A rejected expectedHeadOid is a world-side race. Re-read rather than
    // trusting transport-specific error text. A known created commit must keep
    // its verification failure and custody; never adopt a foreign tip as ours.
    if (!publishedHead) {
      try {
        const live = await api(`repos/${repo}/branches/${encodeURIComponent(branch)}`);
        const head = live?.commit?.sha;
        if (/^[a-f0-9]{40}$/.test(head || '') && head !== expectedHead) phaseOutcome = 'head-changed';
      } catch { /* Unavailable evidence retains the original refusal. */ }
    }
    return { route: 'refused', phaseOutcome, reason: hammerPublicationFailureReason(error),
      // A moved ref alone cannot prove a timed-out mutation had no effect.
      mutationUncertain: true, observedHead: publishedHead };
  }
}
