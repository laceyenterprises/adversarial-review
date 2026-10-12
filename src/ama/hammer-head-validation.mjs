import { HAM_AUDIT_COMMENT_AUTHOR_LOGINS, hamAuditCommentAuthorMatches } from './ham-provenance.mjs';

const login = identity => String(typeof identity === 'object' ? identity?.login || '' : identity || '').toLowerCase().replace(/\[bot\]$/, '');
// Existing fleet App identities, shared by builders, remediators and conflict rebases.
// cfg-allowlist(github-account): compatibility identities for existing fleet installations.
const DEFAULT_FLEET_LOGINS = ['lacey-codex-agent', 'lacey-claude-agent', 'lacey-gemini-agent', 'lacey-clio-agent'];
export function fleetCommitIdentityMatches(commit, fleetLogins = DEFAULT_FLEET_LOGINS) {
  const trusted = new Set([...fleetLogins, ...HAM_AUDIT_COMMENT_AUTHOR_LOGINS].filter(identity => login(identity) !== 'clio-airlock').map(login));
  // Email-to-login mapping alone is forgeable; require signed fleet provenance.
  return commit?.commit?.verification?.verified === true && trusted.has(login(commit?.committer))
    && (!login(commit?.author) || trusted.has(login(commit.author)));
}

export function exactHammerValidation(comment, headSha) {
  return Boolean(headSha && login(comment?.author) !== 'clio-airlock' && hamAuditCommentAuthorMatches(comment)
    && String(comment?.body || '').split(/\r?\n/).some(line => line.trim() === `HAM-Validated-Head: ${headSha}`));
}

export const HAMMER_RANGE_MAX_COMMITS = 10000;
async function readComparison(path, get, limit) {
  const first = await get(path);
  const total = first?.total_commits;
  if (!Number.isSafeInteger(total) || total < 0 || total > limit || !Array.isArray(first.commits)) return null;
  if (first.commits.length === total) return first;
  const commits = [];
  const seen = new Set();
  for (let page = 1; commits.length < total; page++) {
    const next = await get(`${path}?per_page=100&page=${page}`);
    if (next.total_commits !== total || !Array.isArray(next.commits) || next.commits.length === 0) return null;
    for (const commit of next.commits) {
      if (!commit.sha || seen.has(commit.sha)) return null;
      seen.add(commit.sha);
      commits.push(commit);
    }
    if (commits.length > total) return null;
  }
  return { ...first, commits };
}

// Read the complete head-only DAG, including side parents. The comparison with
// the base excludes base history; foreign PR commits cannot hide behind a merge.
export async function fetchHammerHeadRange({ repo, reviewedHead, currentHead, baseRef = 'main', get, env = process.env }) {
  const { resolveGitHubAppBotLogin } = await import('../github-app-identity.mjs');
  const fleetLogins = [...DEFAULT_FLEET_LOGINS];
  for (const identity of ['codex-agent', 'claude-agent', 'gemini-agent', 'clio-agent']) {
    const configured = resolveGitHubAppBotLogin({ identity, env, log: { warn() {} } });
    if (configured) fleetLogins.push(configured);
  }
  const requestedLimit = Number(env.AMA_HAMMER_RANGE_MAX_COMMITS);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : HAMMER_RANGE_MAX_COMMITS;
  const base = await get(`repos/${repo}/commits/${encodeURIComponent(baseRef)}`);
  const compare = await readComparison(`repos/${repo}/compare/${base.sha}...${currentHead}`, get, limit);
  const reviewedRange = await readComparison(`repos/${repo}/compare/${reviewedHead}...${currentHead}`, get, limit);
  if (!compare || !reviewedRange) return null;
  const selected = ['ahead', 'identical'].includes(reviewedRange.status) ? reviewedRange : compare;
  const headOnly = new Set((compare.commits || []).map(commit => commit.sha));
  const commits = selected?.commits;
  if (!base.sha || !Array.isArray(compare.commits) || compare.total_commits !== compare.commits.length
    || !Array.isArray(commits) || selected.total_commits !== commits.length
    || (commits.length && commits.at(-1)?.sha !== currentHead)) return null;
  for (const commit of commits.filter(commit => headOnly.has(commit.sha))) {
    // Base ancestry cannot authenticate changes made during an unsigned merge.
    if (commit?.commit?.verification?.verified !== true) return null;
    if (fleetCommitIdentityMatches(commit, fleetLogins)) continue;
    // A merge of the base branch is permitted, but never a foreign
    // side branch: its second parent must already be reachable from the base.
    if (commit.parents?.length !== 2) return null;
    const ancestry = await get(`repos/${repo}/compare/${commit.parents[1].sha}...${base.sha}`);
    if (!['ahead', 'identical'].includes(ancestry.status)) return null;
  }
  return { verified: true, reviewedHead, currentHead, baseSha: base.sha,
    commits: commits.map(commit => commit.sha) };
}

export function hammerRangeMatches(range, reviewedHead, currentHead) {
  return range?.verified === true && range.reviewedHead === reviewedHead
    && range.currentHead === currentHead && Boolean(range.baseSha) && Array.isArray(range.commits);
}
