import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
// REST equivalent of the hammer's PR/head/check reads. Keep the shared check
// classifier in charge; retain run timestamps and pending latest-run status.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { meteredExecFile } from './metered-gh.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

// Conditional reads (ETag, 304). A 304 returns the body stored with the exact
// ETag that was sent; GitHub does not charge it to the primary rate limit. A
// head change drops the old head's check pages, and any read answered with
// neither 200 nor 304 drops its entry. The hammer reads from a new process per
// poll, so it keeps entries in its private run directory; other callers keep
// them for the life of their process.
const ETAG = /^(?:W\/)?"[\x21\x23-\x7e]{1,256}"$/;
const MEMORY_PRS = 64;
const memory = new Map();

function conditionalState(repo, prNumber, env) {
  const key = `${repo}#${prNumber}`;
  const fresh = () => ({ head: null, entries: {} });
  if (!env.HAM_RUN_DIR) {
    const state = memory.get(key) || fresh();
    memory.delete(key); memory.set(key, state);
    while (memory.size > MEMORY_PRS) memory.delete(memory.keys().next().value);
    return { state, save() {} };
  }
  const file = join(env.HAM_RUN_DIR, `pr-read-etags-${createHash('sha256').update(key).digest('hex').slice(0, 16)}.json`);
  let state;
  try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { state = null; }
  if (!state || typeof state !== 'object' || !state.entries || typeof state.entries !== 'object') state = fresh();
  // A cache write failure costs only a full read on the next poll.
  return { state, save() { try { writeFileAtomic(file, JSON.stringify(state), { mode: 0o600 }); } catch { /* unconditional next time */ } } };
}

function httpEnvelope(stdout) {
  const text = String(stdout || '');
  const status = text.match(/^HTTP\/\S+ (\d{3})\b/)?.[1];
  // A reader without -i output is an unconditional 200 with no reusable ETag.
  if (!status) return { status: 200, etag: null, bodyText: text };
  const end = text.search(/\r?\n\r?\n/);
  const head = end < 0 ? text : text.slice(0, end);
  const bodyText = end < 0 ? '' : text.slice(end).replace(/^\r?\n\r?\n/, '');
  const etag = head.split(/\r?\n/).slice(1).find(line => /^etag:/i.test(line))?.replace(/^etag:\s*/i, '').trim();
  return { status: Number(status), etag: ETAG.test(etag || '') ? etag : null, bodyText };
}

function conditionalReader(cache, execImpl) {
  return async path => {
    const cached = Object.hasOwn(cache.state.entries, path) ? cache.state.entries[path] : null;
    const reusable = ETAG.test(cached?.etag || '') && cached.body !== undefined && cached.body !== null;
    const drop = () => { if (Object.hasOwn(cache.state.entries, path)) { delete cache.state.entries[path]; cache.dirty = true; } };
    let stdout;
    try {
      ({ stdout } = await execImpl(['api', path, '-i', ...(reusable ? ['-H', `If-None-Match: ${cached.etag}`] : [])]));
    } catch (error) {
      // gh reports a 304 as a non-2xx exit; its headers are still on stdout.
      if (reusable && httpEnvelope(error?.stdout).status === 304) return cached.body;
      drop();
      throw error;
    }
    const response = httpEnvelope(stdout);
    if (response.status === 304 && reusable) return cached.body;
    if (response.status < 200 || response.status > 299) { drop(); throw new Error(`Unexpected GitHub response ${response.status} for ${path}`); }
    const body = JSON.parse(response.bodyText);
    if (response.status === 200 && response.etag) { cache.state.entries[path] = { etag: response.etag, body }; cache.dirty = true; }
    else drop();
    return body;
  };
}

// The PR head names the commit whose checks are read; a new head retires them.
function retireStaleHead(cache, head) {
  if (cache.state.head === head) return;
  for (const path of Object.keys(cache.state.entries)) if (path.includes('/commits/')) delete cache.state.entries[path];
  cache.state.head = head;
  cache.dirty = true;
}

async function fetchHammerPr(repo, prNumber, { withChecks = true, withReviews = false, read = null,
  env = process.env, execImpl = null } = {}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo) || !/^[1-9]\d*$/.test(String(prNumber))) {
    throw new TypeError('Invalid GitHub PR reference');
  }
  const cache = read ? null : conditionalState(repo, prNumber, env);
  const get = read || conditionalReader(cache, execImpl || (args => meteredExecFile(promisify(execFile), 'gh', args,
    { hammerToken: true, timeout: loadAwareTimeoutMs(30_000), killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024, env })));
  try { return await readHammerPr(repo, prNumber, { withChecks, withReviews, get, cache }); }
  finally { if (cache?.dirty) cache.save(); }
}

async function readHammerPr(repo, prNumber, { withChecks, withReviews, get, cache }) {
  const pr = await get(`repos/${repo}/pulls/${prNumber}`);
  if (cache) retireStaleHead(cache, pr.head?.sha ?? null);
  const snapshot = {
    id: pr.node_id, number: pr.number, title: pr.title, body: pr.body,
    state: pr.merged_at ? 'MERGED' : String(pr.state || '').toUpperCase(),
    mergedAt: pr.merged_at, closedAt: pr.closed_at, isDraft: pr.draft,
    headRefOid: pr.head?.sha, headSha: pr.head?.sha, headRefName: pr.head?.ref,
    baseRefName: pr.base?.ref, author: pr.user,
    mergeable: pr.mergeable === true ? 'MERGEABLE' : pr.mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
    mergeStateStatus: String(pr.mergeable_state || '').toUpperCase(),
    labels: Array.isArray(pr.labels) ? pr.labels.map(label => ({ id: label.node_id, name: label.name, color: label.color })) : null,
    mergeCommit: pr.merged_at && pr.merge_commit_sha ? { oid: pr.merge_commit_sha } : null,
  };
  if (withChecks && snapshot.headRefOid) {
    const checks = [];
    for (const kind of ['check-runs', 'statuses']) {
      for (let page = 1; ; page += 1) {
        const payload = await get(`repos/${repo}/commits/${snapshot.headRefOid}/${kind}?per_page=100&page=${page}${kind === 'check-runs' ? '&filter=all' : ''}`);
        const rows = kind === 'check-runs' ? payload.check_runs : payload;
        if (!Array.isArray(rows)) throw new Error('Invalid check response');
        checks.push(...rows.map(item => kind === 'check-runs' ? {
          __typename: 'CheckRun', name: item.name, status: item.status ? String(item.status).toUpperCase() : null,
          conclusion: item.conclusion ? String(item.conclusion).toUpperCase() : null, detailsUrl: item.details_url,
          createdAt: item.created_at, startedAt: item.started_at, completedAt: item.completed_at,
          output: item.output,
        } : {
          __typename: 'StatusContext', context: item.context, state: item.state ? String(item.state).toUpperCase() : null,
          createdAt: item.created_at, updatedAt: item.updated_at,
        }));
        if (rows.length < 100) break;
      }
    }
    snapshot.statusCheckRollup = checks;
    snapshot.checks = checks;
  }
  if (withReviews) {
    snapshot.reviews = [];
    for (let page = 1; ; page++) {
      const reviews = await get(`repos/${repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`);
      if (!Array.isArray(reviews)) throw new Error('Invalid review response');
      snapshot.reviews.push(...reviews.map(review => ({ ...review,
        author: review.user, submittedAt: review.submitted_at, commit: { oid: review.commit_id },
      })));
      if (reviews.length < 100) break;
    }
  }
  return snapshot;
}

export { fetchHammerPr };
