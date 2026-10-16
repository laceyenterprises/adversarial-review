import { proveReviewedRebase } from './reviewed-rebase.mjs';
import { opendir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HAM_AUDIT_COMMENT_AUTHOR_LOGINS, hamAuditCommentAuthorMatches } from './ham-provenance.mjs';

const login = identity => String(typeof identity === 'object' ? identity?.login || '' : identity || '').toLowerCase().replace(/\[bot\]$/, '');
// Existing fleet App identities, shared by builders, remediators and conflict rebases.
// cfg-allowlist(github-account): compatibility identities for existing fleet installations.
const DEFAULT_FLEET_LOGINS = ['lacey-codex-agent', 'lacey-claude-agent', 'lacey-gemini-agent', 'lacey-clio-agent'];
export function fleetCommitIdentityMatches(commit, fleetLogins = DEFAULT_FLEET_LOGINS) {
  const trusted = new Set([...fleetLogins, ...HAM_AUDIT_COMMENT_AUTHOR_LOGINS].filter(identity => login(identity) !== 'clio-airlock').map(login));
  // Email-to-login mapping alone is forgeable; bind fleet identity to a verified signature.
  return commit?.commit?.verification?.verified === true
    && commit.commit.verification.reason === 'valid'
    && login(commit?.committer) === 'web-flow'
    && trusted.has(login(commit?.author));
}

export function exactHammerValidation(comment, headSha) {
  const author = comment?.author?.login || comment?.author || comment?.user?.login;
  const heads = String(comment?.body || '').split(/\r?\n/).map(line => line.trim())
    .filter(line => line.startsWith('HAM-Validated-Head:'));
  const terminalHeads = String(comment?.body || '').split(/\r?\n/).map(line => line.trim())
    .filter(line => line.startsWith('HAM-Terminal-Remediation-Head:'));
  return Boolean(headSha && login(author) !== 'clio-airlock' && hamAuditCommentAuthorMatches(author)
    && heads.length === 1 && heads[0] === `HAM-Validated-Head: ${headSha}`
    && (terminalHeads.length === 0 || (terminalHeads.length === 1
      && terminalHeads[0] === `HAM-Terminal-Remediation-Head: ${headSha}`)));
}

// Only GitHub's authenticated comment author binds these edges. Commit metadata
// and builder-authored copies of the same trailers confer no authority.
export function hammerAttestationChain(comments, reviewedHead, currentHead) {
  if (!reviewedHead || !currentHead || currentHead === reviewedHead) return null;
  const trusted = new Map([[reviewedHead, []]]);
  const edges = (Array.isArray(comments) ? comments : []).flatMap(comment => {
    const normalized = { ...comment, author: comment.author?.login || comment.author || comment.user?.login };
    const lines = String(comment.body || '').split(/\r?\n/).map(line => line.trim());
    const bases = lines.filter(line => line.startsWith('HAM-Base-Head: ')).map(line => line.slice(15));
    const heads = lines.filter(line => line.startsWith('HAM-Validated-Head: ')).map(line => line.slice(20));
    if (bases.length !== 1 || heads.length !== 1 || !exactHammerValidation(normalized, heads[0])) return [];
    return [{ base: bases[0], head: heads[0] }];
  });
  for (let pass = 0; pass < edges.length; pass++) {
    let changed = false;
    for (const edge of edges) {
      if (!trusted.has(edge.base) || trusted.has(edge.head)) continue;
      trusted.set(edge.head, [...trusted.get(edge.base), edge.head]);
      changed = true;
    }
    if (!changed) break;
  }
  const chain = trusted.get(currentHead);
  return chain?.length > 0 ? chain : null;
}

// Read only daemon-owned state under the supplied runtime root. Old rounds
// without a resulting head cannot establish an edge.
export async function readCompletedRemediationRounds(rootDir, repo, prNumber) {
  if (!rootDir || !repo || !prNumber) return [];
  const rounds = [];
  try {
    const dir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
    const prefix = `${String(repo).replace(/\//g, '__').replace(/[^a-zA-Z0-9_.-]/g, '-')}-pr-${prNumber}-`.toLowerCase();
    for await (const entry of await opendir(dir)) {
      const name = entry.name;
      if (!name.endsWith('.json') || !name.toLowerCase().startsWith(prefix)) continue;
      try {
        const job = JSON.parse(await readFile(join(dir, name), 'utf8'));
        if (String(job.repo).toLowerCase() !== String(repo).toLowerCase()
          || String(job.prNumber) !== String(prNumber) || job.status !== 'completed') continue;
        rounds.push(...(job.remediationPlan?.rounds || []).filter(round => round.state === 'completed'
          && round.startHeadSha && round.resultingHeadSha));
      } catch {
        // A damaged or concurrently removed record cannot invalidate other jobs.
      }
    }
  } catch {
    return [];
  }
  return rounds;
}

// A timeline read is all-or-nothing: incomplete pages cannot establish provenance.
const FORCE_PUSH_TIMELINE_MAX_PAGES = 10;
async function readForcePushEvents(loadTimelinePage) {
  if (!loadTimelinePage) return null;
  const events = [];
  const cursors = new Set();
  let cursor = null;
  try {
    for (let pageIndex = 0; pageIndex < FORCE_PUSH_TIMELINE_MAX_PAGES; pageIndex++) {
      const page = await loadTimelinePage(cursor);
      if (!Array.isArray(page?.nodes) || typeof page?.pageInfo?.hasNextPage !== 'boolean'
        || page.nodes.some(event => event?.__typename !== 'HeadRefForcePushedEvent')) return null;
      events.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) return events;
      cursor = page.pageInfo.endCursor;
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) return null;
      cursors.add(cursor);
    }
  } catch { return null; }
  return null;
}

function fleetBotIdentityMatches(actor, fleetLogins) {
  return actor?.__typename === 'Bot' && fleetLogins.map(login).includes(login(actor.login));
}

async function fleetForcePushProves(events, base, head, repo, get, fleetLogins) {
  if (!events) return false;
  let current = base;
  const visited = new Set([base]);
  for (let hop = 0; hop < 10; hop++) {
    // A reset can reuse a starting SHA; prefer the latest attempt in timeline order.
    const event = events.findLast(event => event.beforeCommit?.oid === current);
    if (!fleetBotIdentityMatches(event?.actor, fleetLogins)
      || typeof event.afterCommit?.oid !== 'string' || !event.afterCommit.oid) return false;
    current = event.afterCommit.oid;
    if (current === head) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    const comparison = await get(`repos/${repo}/compare/${encodeURIComponent(current)}...${encodeURIComponent(head)}`);
    if (comparison?.status === 'ahead') return true;
  }
  return false;
}

async function remediationChain(rounds, reviewedHead, target, repo, get, loadTimelinePage, fleetLogins) {
  if (!reviewedHead || !target || target === reviewedHead) return null;
  const trusted = new Map([[reviewedHead, []]]);
  const evaluated = new Set();
  let timeline;
  for (let pass = 0; pass < rounds.length; pass++) {
    let changed = false;
    for (const round of rounds) {
      const { startHeadSha: base, resultingHeadSha: head } = round;
      if (round.state !== 'completed' || !base || !head || !trusted.has(base) || trusted.has(head)) continue;
      const edge = JSON.stringify([base, head]);
      if (evaluated.has(edge)) continue;
      evaluated.add(edge);
      try {
        const comparison = await get(`repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
        let kind = 'ahead';
        if (comparison?.status === 'diverged') {
          timeline ??= readForcePushEvents(loadTimelinePage);
          if (!await fleetForcePushProves(await timeline, base, head, repo, get, fleetLogins)) continue;
          kind = 'fleet-force-push';
        } else if (comparison?.status !== 'ahead') continue;
        trusted.set(head, [...trusted.get(base), { head, kind }]);
      } catch { continue; }
      changed = true;
    }
    if (trusted.get(target)?.length > 0) return trusted.get(target);
    if (!changed) break;
  }
  return null;
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
async function fetchExistingHammerHeadRange({ repo, reviewedHead, currentHead, baseRef = 'main', get, env = process.env, comments = [], loadComments = null, hammerBaseHead = null, remediationRounds = [], loadTimelinePage = null }) {
  // HAMCLOSE-01: the worker may start from the exact reviewed head. This is
  // a starting-base proof, not an App attestation or a completed round edge.
  if (reviewedHead && hammerBaseHead === reviewedHead) return { verified: true, reviewedHead, currentHead,
    baseSha: reviewedHead, commits: currentHead === reviewedHead ? [] : [currentHead], proof: 'reviewed-starting-base' };
  const fleetLogins = await resolveFleetLogins(env);
  const rounds = await remediationChain(remediationRounds, reviewedHead, hammerBaseHead || currentHead, repo, get, loadTimelinePage, fleetLogins);
  const chain = rounds?.length > 0 ? null
    : hammerAttestationChain(loadComments ? await loadComments() : comments, reviewedHead, hammerBaseHead || currentHead);
  if (chain?.length > 0) return { verified: true, reviewedHead, currentHead, baseSha: reviewedHead,
    commits: [...chain, ...(hammerBaseHead && hammerBaseHead !== currentHead ? [currentHead] : [])],
    proof: 'hammer-app-attestation-chain' };
  if (rounds?.length > 0) return { verified: true, reviewedHead, currentHead, baseSha: reviewedHead,
    commits: [...rounds.map(link => link.head), ...(hammerBaseHead && hammerBaseHead !== currentHead ? [currentHead] : [])],
    proof: 'completed-remediation-round-chain', linkKinds: rounds.map(link => link.kind) };
  if (hammerBaseHead) return null;
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
    // Base-merge ancestry cannot waive signature verification either.
    if (commit?.commit?.verification?.verified !== true) return null;
    if (fleetCommitIdentityMatches(commit, fleetLogins)) continue;
    // Only GitHub-signed base updates may bypass fleet authorship. A locally
    // signed human merge can contain arbitrary edits despite valid ancestry.
    // Never permit a foreign side branch: the second parent must be on base.
    if (login(commit?.committer) !== 'web-flow'
      || commit.commit.verification.reason !== 'valid' || commit.parents?.length !== 2) return null;
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

async function resolveFleetLogins(env) {
  const { resolveGitHubAppBotLogin } = await import('../github-app-identity.mjs');
  const fleetLogins = [...DEFAULT_FLEET_LOGINS];
  for (const identity of ['codex-agent', 'claude-agent', 'gemini-agent', 'clio-agent']) {
    const configured = resolveGitHubAppBotLogin({ identity, env, log: { warn() {} } });
    if (configured) fleetLogins.push(configured);
  }
  return fleetLogins;
}

// An additive fallback only: preserve every existing proof and refusal first.
export async function fetchHammerHeadRange(options) {
  const existing = await fetchExistingHammerHeadRange(options);
  if (existing) return existing;
  const { repo, reviewedHead, currentHead, hammerBaseHead, get, loadActivityPage,
    prNumber, env = process.env } = options;
  const target = hammerBaseHead || currentHead;
  // A separate conflict owner can rewrite the reviewed series before HAM starts.
  // Identity trailers do not authorize that rewrite: independently compare content.
  if ((options.git || (hammerBaseHead && options.loadRebaseCoverage
    && /^[a-f0-9]{40}$/.test(reviewedHead) && /^[a-f0-9]{40}$/.test(target))) && reviewedHead && target && reviewedHead !== target) {
    try {
      const base = await get(`repos/${repo}/commits/${encodeURIComponent(options.baseRef || 'main')}`);
      const coverage = options.loadRebaseCoverage
        ? await options.loadRebaseCoverage({ head: target, base: base.sha })
        : await proveReviewedRebase({ ...options, head: target, base: base.sha });
      if (coverage) return { verified: true, reviewedHead, currentHead, baseSha: base.sha,
        commits: [...coverage.replayedCommits, ...(target !== currentHead ? [currentHead] : [])],
        proof: coverage.proof, rebaseCoverage: coverage };
    } catch { /* Missing objects or policy cannot authorize a rebased starting base. */ }
  }
  if (!reviewedHead || !target || reviewedHead === target || !loadActivityPage || !prNumber) return null;
  try {
    const pr = await get(`repos/${repo}/pulls/${prNumber}`);
    // Activity belongs to the head repository, including fork PRs.
    const headRepo = pr?.head?.repo?.full_name;
    const branch = pr?.head?.ref;
    if (!headRepo || !branch) return null;
    const ref = `refs/heads/${branch}`;
    let path = `repos/${headRepo}/activity?ref=${encodeURIComponent(ref)}&per_page=100&direction=desc`;
    const visitedPages = new Set();
    const events = [];
    let complete = false;
    for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
      if (visitedPages.has(path)) return null;
      visitedPages.add(path);
      const page = await loadActivityPage(path);
      if (!Array.isArray(page?.nodes) || !(page.next === null || typeof page.next === 'string')) return null;
      events.push(...page.nodes);
      if (page.next === null) { complete = true; break; }
      if (!page.next) return null;
      path = page.next;
    }
    if (!complete) return null;
    const fleetLogins = await resolveFleetLogins(env);
    // Walk chronological updates, never skipping an untrusted update or reset.
    // Choose the latest departure from the reviewed head, as the timeline proof does.
    const chronological = events.toReversed();
    const start = chronological.findLastIndex(event => event?.before === reviewedHead);
    if (start < 0) return null;
    let head = reviewedHead;
    const steps = [];
    for (const event of chronological.slice(start)) {
      if (event?.ref !== ref || event.before !== head
        || !['push', 'force_push'].includes(event.activity_type)
        || !fleetBotIdentityMatches({ ...event.actor, __typename: event.actor?.type }, fleetLogins)
        || typeof event.after !== 'string' || !event.after || !event.timestamp) return null;
      steps.push({ before: event.before, after: event.after, kind: event.activity_type,
        actor: event.actor.login, time: event.timestamp });
      head = event.after;
    }
    // Reaching the starting base is insufficient: every later ref mutation
    // must be trusted and the complete chain must end at the expected head.
    if (head === currentHead && steps.some(step => step.after === target)) {
      // Validate the entire structure before fetching content. Bound concurrency
      // so long activity histories cannot flood GitHub; settle every lookup
      // before refusing proof, including transport and identity failures.
      for (let offset = 0; offset < steps.length; offset += 4) {
        const batch = steps.slice(offset, offset + 4);
        const commits = await Promise.allSettled(batch.map(async step => get(`repos/${headRepo}/commits/${step.after}`)));
        if (commits.some((result, index) => result.status !== 'fulfilled'
          || result.value?.sha !== batch[index].after
          || !fleetCommitIdentityMatches(result.value, fleetLogins))) return null;
      }
      return { verified: true, reviewedHead, currentHead, baseSha: reviewedHead,
        commits: steps.map(step => step.after), proof: 'branch-activity', steps };
    }
  } catch { /* Unreadable activity contributes no new proof. */ }
  return null;
}
