import { followUpJobFileFilter } from '../follow-up-job-names.mjs';
import { isTransientGhError } from '../gh-cli.mjs';
import { proveReviewedRebase } from './reviewed-rebase.mjs';
import { constants } from 'node:fs';
import { open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { HAM_AUDIT_COMMENT_AUTHOR_LOGINS, hamAuditCommentAuthorMatches } from './ham-provenance.mjs';
import { completedCommentOnlyHandoff, completedLocalCommentOnlyReplay } from '../comment-only-final-round.mjs';
import { resolveReplyStorageKey } from '../remediation-reply-paths.mjs';

const isAbort = error => error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
const isHistoryReadFailure = error => error?.hammerHistoryReadFailed || error?.primaryChangeReadFailed
  || error?.code === 'HISTORY_READ_INVALID' || error?.authOutage === true || isTransientGhError(error);
function rethrowReadFailure(error) {
  if (isHistoryReadFailure(error) || isAbort(error)) throw error;
}

const login = identity => String(typeof identity === 'object' ? identity?.login || '' : identity || '').toLowerCase().replace(/\[bot\]$/, '');
const FULL_SHA = /^[0-9a-f]{40}$/i;
const HAMMER_COMMENT_MAX_PAGES = 10;
const HAMMER_COMMENT_PAGE_SIZE = 100;
const MAX_COMPLETED_RECORDS = 256;
const MAX_COMPLETED_ENTRIES = 125_000;
const MAX_COMPLETED_RECORD_BYTES = 1024 * 1024;
const MAX_COMPLETED_ROUND_EDGES = 256;
const BRANCH_RESET = Symbol('branch reset');
export const HAMMER_COMMENTS_CAPPED = 'hammer-provenance-comments-capped';
const LIMIT_LOG_INTERVAL_MS = 60 * 60 * 1000;
const LIMIT_LOG_KEYS = 4096;
const reportedProofLimits = new Map();

function reportProofLimit(kind, limit, repo, prNumber) {
  const key = `${String(repo).toLowerCase()}#${Number(prNumber)}:${kind}`;
  const now = performance.now();
  if (now - (reportedProofLimits.get(key) ?? -Infinity) < LIMIT_LOG_INTERVAL_MS) return;
  reportedProofLimits.delete(key);
  if (reportedProofLimits.size >= LIMIT_LOG_KEYS) reportedProofLimits.delete(reportedProofLimits.keys().next().value);
  reportedProofLimits.set(key, now);
  console.warn(`[ama] ${kind} (${limit}) for ${repo}#${prNumber}`);
}

// A full last page can be truncated. Partial pages may not attest a chain.
export async function readHammerProvenanceComments(loadPage) {
  const comments = [];
  for (let page = 1; page <= HAMMER_COMMENT_MAX_PAGES; page++) {
    const batch = await loadPage(page);
    if (!Array.isArray(batch) || batch.length > HAMMER_COMMENT_PAGE_SIZE) return null;
    comments.push(...batch);
    if (batch.length < HAMMER_COMMENT_PAGE_SIZE) return comments;
  }
  return HAMMER_COMMENTS_CAPPED;
}

const isProvenanceComment = comment => !comment?.event || comment.event === 'commented';

export function hammerProvenanceCommentsCapped(comments, repo, prNumber) {
  const limit = HAMMER_COMMENT_MAX_PAGES * HAMMER_COMMENT_PAGE_SIZE;
  let count = 0;
  const capped = comments === HAMMER_COMMENTS_CAPPED
    || (Array.isArray(comments) && comments.length >= limit
      && comments.some(comment => isProvenanceComment(comment) && ++count >= limit));
  if (capped && repo && prNumber) reportProofLimit(HAMMER_COMMENTS_CAPPED, limit, repo, prNumber);
  return capped;
}
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

export function exactHammerCommentAuthorMatches(author) {
  return login(author) !== 'clio-airlock' && hamAuditCommentAuthorMatches(author);
}

export function exactHammerValidation(comment, headSha) {
  const author = comment?.author?.login || comment?.author || comment?.user?.login;
  const heads = String(comment?.body || '').split(/\r?\n/).map(line => line.trim())
    .filter(line => line.startsWith('HAM-Validated-Head:'));
  const terminalHeads = String(comment?.body || '').split(/\r?\n/).map(line => line.trim())
    .filter(line => line.startsWith('HAM-Terminal-Remediation-Head:'));
  return Boolean(headSha && exactHammerCommentAuthorMatches(author)
    && heads.length === 1 && heads[0] === `HAM-Validated-Head: ${headSha}`
    && (terminalHeads.length === 0 || (terminalHeads.length === 1
      && terminalHeads[0] === `HAM-Terminal-Remediation-Head: ${headSha}`)));
}

// Only GitHub's authenticated comment author binds these edges. Commit metadata
// and builder-authored copies of the same trailers confer no authority.
export function hammerProvenanceEdge(comment) {
  const author = comment?.author?.login || comment?.author || comment?.user?.login;
  if (comment?.user && comment?.author && login(comment.user) !== login(comment.author)) return null;
  if (!exactHammerCommentAuthorMatches(author)) return null;
  const lines = String(comment?.body || '').split(/\r?\n/).map(line => line.trim());
  const values = key => lines.filter(line => line.startsWith(`${key}:`))
    .map(line => line.slice(key.length + 1).trim());
  const bases = values('HAM-Base-Head');
  const validated = values('HAM-Validated-Head');
  const pushed = values('HAM-Pushed-Head');
  if (bases.length !== 1 || !bases[0] || validated.length + pushed.length !== 1) return null;
  const head = validated[0] || pushed[0];
  if (!head || (validated.length && !exactHammerValidation(comment, head))) return null;
  if (pushed.length && values('HAM-Terminal-Remediation-Head').length) return null;
  return { base: bases[0], head, validated: validated.length === 1 };
}

// Round inputs must come from daemon-owned records, never PR text. They may
// bridge to a hammer base; the exact current head still needs a hammer edge.
export function hammerAttestationChain(comments, reviewedHead, currentHead, remediationRounds = []) {
  if (!reviewedHead || !currentHead || currentHead === reviewedHead) return null;
  if (!Array.isArray(comments)) return null;
  // The Hammer CLI supplies the full issue timeline; only comment events
  // consume the comment completeness budget or carry App attestations.
  if (hammerProvenanceCommentsCapped(comments)) return null;
  const outgoing = new Map();
  const addEdge = (base, head) => {
    if (!outgoing.has(base)) outgoing.set(base, []);
    outgoing.get(base).push(head);
  };
  for (const comment of comments) {
    if (!isProvenanceComment(comment)) continue;
    const edge = hammerProvenanceEdge(comment);
    if (edge) addEdge(edge.base, edge.head);
  }
  if (Array.isArray(remediationRounds) && remediationRounds.length <= MAX_COMPLETED_ROUND_EDGES) {
    for (const round of remediationRounds) {
      if (round?.state === 'completed' && round.startHeadSha && round.resultingHeadSha
        && round.resultingHeadSha !== currentHead) addEdge(round.startHeadSha, round.resultingHeadSha);
    }
  }
  const parents = new Map([[reviewedHead, null]]);
  // Map iteration includes subsequently inserted nodes. Each SHA is visited once.
  for (const [base] of parents) {
    for (const head of outgoing.get(base) || []) {
      if (parents.has(head)) continue;
      parents.set(head, base);
      if (head === currentHead) {
        const chain = [];
        for (let node = head; node !== reviewedHead; node = parents.get(node)) chain.push(node);
        return chain.reverse();
      }
    }
  }
  return null;
}

async function readCompletedJob(path, onOversize) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    if (stat.size > MAX_COMPLETED_RECORD_BYTES) {
      onOversize();
      return null;
    }
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead !== stat.size) return null;
    return JSON.parse(buffer.toString('utf8', 0, bytesRead));
  } finally {
    await file.close();
  }
}

// Read only daemon-owned state under the supplied runtime root. Old rounds
// without a resulting head cannot establish an edge.
export async function readCompletedRemediationEvidence(rootDir, repo, prNumber, { sourceParent } = {}) {
  const lanePublications = new Map();
  const sourceJobs = [];
  const unavailable = { rounds: [], settledRounds: [], finalPublications: [], lanePublications: new Map() };
  if (typeof rootDir !== 'string' || !rootDir || typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)
    || !['number', 'string'].includes(typeof prNumber)
    || !Number.isSafeInteger(Number(prNumber)) || Number(prNumber) < 1) return unavailable;
  const rounds = new Map();
  const settledRounds = new Map();
  const finalPublications = [];
  let records = 0;
  let entries = 0;
  let lanePublicationsCapped = false;
  let sourceJobsDamaged = false;
  const capped = (kind, limit) => {
    reportProofLimit(`completed-round proof scan hit the ${kind} limit`, limit, repo, prNumber);
    return { ...unavailable, limitReached: kind };
  };
  const reportOversize = () => reportProofLimit('completed-round proof scan hit the record bytes limit',
    MAX_COMPLETED_RECORD_BYTES, repo, prNumber);
  try {
    const dir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
    const matches = followUpJobFileFilter({ rootDir, repo, prNumber, caseInsensitiveRepo: true });
    for await (const entry of await opendir(dir)) {
      if (++entries > MAX_COMPLETED_ENTRIES) return capped('directory entries', MAX_COMPLETED_ENTRIES);
      if (!matches(entry.name)) continue;
      if (!entry.isFile()) {
        sourceJobsDamaged = true;
        continue;
      }
      if (++records > MAX_COMPLETED_RECORDS) {
        return capped('matching records', MAX_COMPLETED_RECORDS);
      }
      try {
        const job = await readCompletedJob(join(dir, entry.name), reportOversize);
        if (!job || !Array.isArray(job.remediationPlan?.rounds)) sourceJobsDamaged = true;
        if (typeof job?.repo !== 'string' || job.repo.toLowerCase() !== repo.toLowerCase()
          || !['number', 'string'].includes(typeof job.prNumber)
          || String(job.prNumber) !== String(prNumber) || job.status !== 'completed'
          || !Array.isArray(job.remediationPlan?.rounds)) continue;
        if (sourceParent && sourceJobs.length < 2 && job.remediationPlan.rounds.some(round =>
          [round?.resultingHeadSha, round?.publishedHeadSha, round?.completion?.workerPushedHeadSha].includes(sourceParent))) {
          sourceJobs.push(job);
        }
        for (const round of job.remediationPlan.rounds) {
          const { startHeadSha: base, resultingHeadSha: head } = round || {};
          if (round?.state !== 'completed' || typeof base !== 'string' || typeof head !== 'string'
            || !FULL_SHA.test(base) || !FULL_SHA.test(head)) continue;
          // Keep each job's round so an identical edge from another job
          // cannot replace the publication worker's source evidence.
          rounds.set(`${base}:${head}:${entry.name}`, round);
          if (rounds.size > MAX_COMPLETED_ROUND_EDGES) {
            return capped('round edges', MAX_COMPLETED_ROUND_EDGES);
          }
          // The completion writer can observe a moved PR even when the worker
          // did not publish. Only its explicit worker-push receipt binds a lane.
          const { worker, completion } = round;
          if (!lanePublicationsCapped && job.kind === 'adversarial-review-follow-up'
            && typeof job.jobId === 'string' && job.jobId
            && head !== base && completion?.workerPushedHeadSha === head && !completion.pendingCiOnly
            && worker?.state === 'completed' && typeof worker.launchRequestId === 'string' && worker.launchRequestId.trim()) {
            const local = !worker.dispatchId && !worker.requiresProducedAttestation
              && (worker.dispatchMode === undefined || worker.dispatchMode === 'local');
            if (local && worker.launchRequestId !== resolveReplyStorageKey(job)) continue;
            lanePublications.set(`${head}:${job.jobId}`, worker);
            if (lanePublications.size > MAX_COMPLETED_ROUND_EDGES) {
              lanePublications.clear();
              lanePublicationsCapped = true;
              reportProofLimit('completed-round proof scan hit the lane publications limit',
                MAX_COMPLETED_ROUND_EDGES, repo, prNumber);
            }
          }
        }
        const settled = completedCommentOnlyHandoff(job);
        if (settled && settled.reReview?.requested !== true) settledRounds.set(`${settled.startHeadSha}:${settled.resultingHeadSha}`, settled);
        const publication = completedLocalCommentOnlyReplay(job);
        if (publication) finalPublications.push(publication);
      } catch {
        // Preserve other jobs' round proofs, but uniqueness cannot be proved
        // for a source parent when any matching record is unreadable.
        sourceJobsDamaged = true;
      }
    }
  } catch {
    return unavailable;
  }
  return { rounds: [...rounds.values()], settledRounds: [...settledRounds.values()], finalPublications, lanePublications,
    ...(sourceParent && !sourceJobsDamaged ? { sourceJobs } : {}) };
}

export async function readCompletedRemediationRounds(rootDir, repo, prNumber) {
  return (await readCompletedRemediationEvidence(rootDir, repo, prNumber)).rounds;
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
      if (!Array.isArray(page?.nodes) || page.nodes.length > 100 || typeof page?.pageInfo?.hasNextPage !== 'boolean'
        || page.nodes.some(event => event?.__typename !== 'HeadRefForcePushedEvent')) return null;
      events.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) return events;
      cursor = page.pageInfo.endCursor;
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) return null;
      cursors.add(cursor);
    }
  } catch (error) { rethrowReadFailure(error); return null; }
  return null;
}

function fleetBotIdentityMatches(actor, fleetLogins) {
  return actor?.__typename === 'Bot' && fleetLogins.map(login).includes(login(actor.login));
}

export async function exactRemediationForcePush(loadPage, review, head, appIdentity, env = process.env) {
  const events = await readForcePushEvents(loadPage);
  const event = events?.findLast(entry => entry.beforeCommit?.oid === review.commit_id);
  return event?.afterCommit?.oid === head && Date.parse(event.createdAt) >= Date.parse(review.submitted_at)
    && fleetBotIdentityMatches(event.actor, await resolveFleetLogins(env, [appIdentity]));
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
  let timeline, readFailure;
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
      } catch (error) {
        if (isAbort(error)) throw error;
        if (isHistoryReadFailure(error)) readFailure ??= error;
        continue;
      }
      changed = true;
    }
    if (trusted.get(target)?.length > 0) return trusted.get(target);
    if (!changed) break;
  }
  if (readFailure) throw readFailure;
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
async function fetchExistingHammerHeadRange({ repo, prNumber, rootDir, reviewedHead, currentHead, baseRef = 'main', get,
  env = process.env, comments = [], loadComments = null, hammerBaseHead = null, loadTimelinePage = null }) {
  // HAMCLOSE-01: the worker may start from the exact reviewed head. This is
  // a starting-base proof, not an App attestation or a completed round edge.
  if (reviewedHead && hammerBaseHead === reviewedHead) return { verified: true, reviewedHead, currentHead,
    baseSha: reviewedHead, commits: currentHead === reviewedHead ? [] : [currentHead], proof: 'reviewed-starting-base' };
  const target = hammerBaseHead || currentHead;
  const appRange = provenance => {
    if (hammerProvenanceCommentsCapped(provenance, repo, prNumber)) return null;
    const chain = hammerAttestationChain(provenance, reviewedHead, target);
    return chain && { verified: true, reviewedHead, currentHead, baseSha: reviewedHead,
      commits: [...chain, ...(target !== currentHead ? [currentHead] : [])], proof: 'hammer-app-attestation-chain' };
  };
  // Daemon snapshots already have comments. Their pure App proof needs no
  // disk scan. A worker's round-only starting-base proof still avoids API pagination.
  const snapshotRange = !loadComments && appRange(comments);
  if (snapshotRange) return snapshotRange;
  const { rounds: remediationRounds, finalPublications } = await readCompletedRemediationEvidence(rootDir, repo, prNumber);
  const readEndpointComparison = targetHead => get(`repos/${repo}/compare/${reviewedHead}...${targetHead}`).catch(error => {
    if (isAbort(error)) throw error;
    // A reported reset refuses custody. The completed record can independently
    // supply publication evidence when comparison is unavailable.
    return null;
  });
  if (target === currentHead && finalPublications.some(entry => entry.reviewedHead === reviewedHead && entry.head === target)) {
    if ((await readEndpointComparison(target))?.status === 'behind') return BRANCH_RESET;
    return { verified: true, reviewedHead, currentHead, baseSha: reviewedHead,
      commits: [target], proof: 'comment-only-final-remediation-publication' };
  }
  const fleetLogins = await resolveFleetLogins(env);
  let rounds, roundReadFailure;
  try {
    rounds = await remediationChain(remediationRounds, reviewedHead, target, repo, get, loadTimelinePage, fleetLogins);
  } catch (error) {
    if (isAbort(error)) throw error;
    roundReadFailure = error;
  }
  if (rounds?.length > 0) return { verified: true, reviewedHead, currentHead, baseSha: reviewedHead,
    commits: [...rounds.map(link => link.head), ...(target !== currentHead ? [currentHead] : [])],
    proof: 'completed-remediation-round-chain', linkKinds: rounds.map(link => link.kind) };
  const provenanceComments = loadComments ? await loadComments() : comments;
  const loadedRange = loadComments && appRange(provenanceComments);
  if (loadedRange) return loadedRange;
  // A mixed proof uses the daemon's recorded endpoints as intermediate custody.
  // The authenticated final Hammer edge supplies the publication proof that a
  // round-only starting-base proof must establish through GitHub comparisons.
  const mixed = remediationRounds.length && FULL_SHA.test(reviewedHead) && FULL_SHA.test(currentHead)
    ? hammerAttestationChain(provenanceComments, reviewedHead, currentHead, remediationRounds) : null;
  if (mixed && (target === currentHead || mixed.includes(target))) {
    const comparison = await readEndpointComparison(currentHead);
    if (comparison?.status === 'behind') return BRANCH_RESET;
    return { verified: true, reviewedHead, currentHead, baseSha: reviewedHead, commits: mixed,
      proof: 'hammer-app-attestation-chain' };
  }
  if (roundReadFailure) throw roundReadFailure;
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

async function resolveFleetLogins(env, identities = ['codex-agent', 'claude-agent', 'gemini-agent', 'clio-agent']) {
  const { resolveGitHubAppBotLogin } = await import('../github-app-identity.mjs');
  const fleetLogins = DEFAULT_FLEET_LOGINS.filter(entry =>
    identities.some(identity => login(entry) === login(`lacey-${identity}`)));
  for (const identity of identities) {
    const configured = resolveGitHubAppBotLogin({ identity, env, log: { warn() {} } });
    if (configured) fleetLogins.push(configured);
  }
  return fleetLogins;
}

// An additive fallback only: preserve every existing proof and refusal first.
export async function fetchHammerHeadRange(options) {
  options = { ...options };
  for (const key of ['get', 'loadComments', 'loadTimelinePage', 'loadActivityPage', 'loadRebaseBase']) {
    const read = options[key];
    if (read) options[key] = async (...args) => {
      try { return await read(...args); }
      catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        error.hammerHistoryReadFailed = true;
        throw error;
      }
    };
  }
  let existing, readFailure;
  try { existing = await fetchExistingHammerHeadRange(options); }
  catch (error) {
    if (!isHistoryReadFailure(error) || isAbort(error)) throw error;
    readFailure = error;
  }
  if (existing === BRANCH_RESET) return null;
  if (existing) return existing;
  const fallback = await fetchRebasedHammerHeadRange(options);
  if (!fallback && readFailure) throw readFailure;
  return fallback;
}

async function fetchRebasedHammerHeadRange(options) {
  const { repo, reviewedHead, currentHead, hammerBaseHead, get, loadActivityPage,
    prNumber, env = process.env } = options;
  const target = hammerBaseHead || currentHead;
  // A separate conflict owner can rewrite the reviewed series before HAM starts.
  // Identity trailers do not authorize that rewrite: independently compare content.
  if ((options.git || (hammerBaseHead && options.loadRebaseCoverage
    && /^[a-f0-9]{40}$/.test(reviewedHead) && /^[a-f0-9]{40}$/.test(target))) && reviewedHead && target && reviewedHead !== target) {
    try {
      const base = options.loadRebaseBase ? await options.loadRebaseBase()
        : await get(`repos/${repo}/commits/${encodeURIComponent(options.baseRef || 'main')}`);
      if (!base?.sha) return null;
      const coverage = options.loadRebaseCoverage
        ? await options.loadRebaseCoverage({ head: target, base: base.sha })
        : await proveReviewedRebase({ ...options, head: target, base: base.sha });
      if (coverage) return { verified: true, reviewedHead, currentHead, baseSha: base.sha,
        commits: [...coverage.replayedCommits, ...(target !== currentHead ? [currentHead] : [])],
        proof: coverage.proof, rebaseCoverage: coverage };
      // A failed content proof for a rewritten starting base cannot be rescued
      // by a fleet actor alone: conflict ownership is not review authority.
      const comparison = await get(`repos/${repo}/compare/${reviewedHead}...${target}`);
      if (!['ahead', 'identical'].includes(comparison?.status)) return null;
    } catch (error) { rethrowReadFailure(error); return null; }
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
        for (const result of commits) if (result.status === 'rejected') rethrowReadFailure(result.reason);
        if (commits.some((result, index) => result.status !== 'fulfilled'
          || result.value?.sha !== batch[index].after
          || !fleetCommitIdentityMatches(result.value, fleetLogins))) return null;
      }
      return { verified: true, reviewedHead, currentHead, baseSha: reviewedHead,
        commits: steps.map(step => step.after), proof: 'branch-activity', steps };
    }
  } catch (error) { rethrowReadFailure(error); /* Unreadable structure contributes no proof. */ }
  return null;
}
