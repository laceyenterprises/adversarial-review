import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execGhWithRetry } from './gh-cli.mjs';
import { fetchMergeAgentCandidateSnapshot } from './merge-agent-candidate-snapshot.mjs';
import { amaAllAuthoritativeReviewerLogins, amaReviewerFamilyForLogin,
  latestAuthoritativeReviewInAncestry } from './ama/reviewer-authority.mjs';
import { REVIEWER_PASS_GENUINE_POSTED_REVIEW_WHERE_SQL,
  REVIEWER_PASS_NORMALIZED_POSTED_AT_SQL } from './reviewer-pass-posted-review-sql.mjs';
import { readLaunchRequestObservationFromLedgerAsync } from './session-ledger-read-adapter.mjs';
import { launchSource } from './pr-next-action-consumer.mjs';
import { launchRequestOwned } from './ama/launch-request-status.mjs';
import { amaCloserDispatchDir, isPreReceiptIntent } from './ama/dispatch-record-read.mjs';
import { followUpJobFileFilter } from './follow-up-job-names.mjs';
import { repositoryNames } from './repository-names.mjs';
import { loadGuardForbiddenPaths } from './guard-forbidden-paths.mjs';
import { proveCloserAuthoredStaleHead, closerAuthoredStaleEligible } from './closer-authored-stale.mjs';
import { summarizeExternalChecks } from './remediation-ci-regression.mjs';
import { enrichCiInfrastructureEvidence } from './ci-infrastructure.mjs';
import { buildPrBlocker, makePrBlockersReport, reviewFacts } from './pr-blockers.mjs';

const exec = promisify(execFile);
const unknown = () => ({ state: 'unknown', value: null });
const complete = value => ({ state: 'complete', value });
const sha = value => /^[a-f0-9]{40}$/i.test(value || '');
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const DEFAULT_PR_LIMIT = 25;
export function validatePrLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('PR limit must be an integer from 1 to 100');
  return limit;
}
export function validateRepo(repo) {
  if (!repositoryPattern.test(repo || '') || repo.split('/').some(part => ['.', '..'].includes(part))) {
    throw new Error('repository must have owner/name form');
  }
  return repo;
}

// Same retrying GitHub transport as the closure readers, GET requests only.
export async function githubGet(path) {
  return JSON.parse((await execGhWithRetry({ args: ['api', path], timeoutMs: 15000, retries: 2,
    totalTimeoutMs: 60000 })).stdout);
}

export async function readPages(get, path, limit = Infinity) {
  const rows = [];
  for (let page = 1; ; page++) {
    const batch = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('expected a paginated list');
    rows.push(...batch.slice(0, limit - rows.length));
    if (batch.length < 100 || rows.length >= limit) return rows;
  }
}

// No schema bootstrap or write-capable singleton imports. Opening a missing
// deployment store must never create a new database that looks like no review.
export function readReviewStore(root, repo, number) {
  const db = new Database(join(root, 'data', 'reviews.db'), { readonly: true, fileMustExist: true });
  try {
    const names = repositoryNames(root, repo);
    const placeholders = names.map(() => '?').join(',');
    const row = db.prepare(`SELECT * FROM reviewed_prs WHERE repo IN (${placeholders}) AND pr_number = ?`)
      .get(...names, number) || null;
    const pass = db.prepare(`SELECT head_sha, body_md, gh_comment_id,
      ${REVIEWER_PASS_NORMALIZED_POSTED_AT_SQL} AS posted_at
      FROM reviewer_passes WHERE repo IN (${placeholders}) AND pr_number = ?
      AND pass_kind IN ('first-pass', 'rereview') AND ${REVIEWER_PASS_GENUINE_POSTED_REVIEW_WHERE_SQL}
      ORDER BY julianday(COALESCE(body_captured_at, ended_at)) DESC, pass_id DESC LIMIT 1`).get(...names, number) || null;
    return { row, pass };
  } finally { db.close(); }
}

async function directoryEntries(path) {
  try { return await readdir(path); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

// Lease APIs also acquire/create migration lock files. This diagnostic reads
// the existing JSON records directly and never creates a lock or probes a PID.
async function readPrRecords(root, repo, number, dir) {
  const names = repositoryNames(root, repo);
  const matches = followUpJobFileFilter({ rootDir: root, repo, prNumber: number });
  const rows = [];
  for (const name of (await directoryEntries(dir)).filter(matches)) {
    const row = JSON.parse(await readFile(join(dir, name), 'utf8'));
    if (!sha(row?.headSha)) throw new Error(`malformed ownership record: ${name}`);
    if (names.includes(row.repo) && Number(row.prNumber) === number) rows.push(row);
  }
  return rows;
}

export async function readCloserLeases(root, repo, number) {
  const leases = await readPrRecords(root, repo, number, join(root, 'data', 'ama-closer-leases'));
  if (leases.some(lease => !['pending', 'dispatched', 'terminal', 'handed-to-review'].includes(lease.status))) {
    throw new Error('unknown closer lease status');
  }
  return leases;
}
export const readCloserReceipts = (root, repo, number) =>
  readPrRecords(root, repo, number, amaCloserDispatchDir(root));

export async function readRemediation(root, repo, number) {
  const matches = followUpJobFileFilter({ rootDir: root, repo, prNumber: number });
  const names = repositoryNames(root, repo);
  const jobs = [];
  for (const bucket of ['pending', 'in-progress', 'completed', 'failed', 'stopped']) {
    const dir = join(root, 'data', 'follow-up-jobs', bucket);
    for (const name of (await directoryEntries(dir)).filter(matches)) {
      const job = JSON.parse(await readFile(join(dir, name), 'utf8'));
      if (names.includes(job.repo) && Number(job.prNumber) === number) jobs.push(job);
    }
  }
  jobs.sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt));
  const active = jobs.find(job => ['pending', 'in_progress'].includes(job.status));
  const latest = active || jobs[0];
  const plan = latest?.remediationPlan;
  // Do not infer liveness from a process listing. Durable dispatch evidence is
  // resolved by the caller through the same ownership observation as closers.
  return { job: latest ? { status: latest.status, headSha: latest.headSha || latest.revisionRef,
    createdAt: latest.createdAt, deadlineAt: latest.deadlineAt,
    heartbeatDeadlineAt: latest.heartbeatDeadlineAt, live: false } : null,
  roundsLeft: Number.isFinite(plan?.currentRound) && Number.isFinite(plan?.maxRounds)
    ? plan.currentRound < plan.maxRounds : null,
  launchRequestId: active?.remediationWorker?.launchRequestId || active?.remediationWorker?.launchRequestID
    || active?.remediationWorker?.lrq || null,
  ownershipUnknown: Boolean(active) };
}

// Work entirely from existing objects. merge-tree writes trees, so redirect its
// object store to a disposable directory with the checkout's objects read-only
// as alternates. Never fetch, checkout, merge or update the user's repository.
export async function readConflictFiles({ checkout, base, head, generatedPaths = [], execImpl = exec }) {
  const unavailable = { state: 'unavailable', files: [], generatedOnly: false };
  if (!checkout || !sha(base) || !sha(head)) return unavailable;
  let scratch;
  try {
    const options = { cwd: checkout, timeout: 15000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' } };
    const objects = resolve(checkout, (await execImpl('git', ['rev-parse', '--git-path', 'objects'], options)).stdout.trim());
    await execImpl('git', ['cat-file', '-e', `${base}^{commit}`], options);
    await execImpl('git', ['cat-file', '-e', `${head}^{commit}`], options);
    scratch = await mkdtemp(join(tmpdir(), 'pr-blockers-'));
    let output;
    try {
      output = (await execImpl('git', ['merge-tree', '--write-tree', '--name-only', '-z', base, head],
        { ...options, env: { ...options.env, GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects } })).stdout;
    } catch (error) {
      if (error.code !== 1 || typeof error.stdout !== 'string') throw error;
      output = error.stdout;
    }
    // -z format: result tree, conflicted paths, empty record, messages.
    const records = output.split('\0');
    if (!sha(records.shift())) return unavailable;
    const end = records.indexOf('');
    if (end < 0) return unavailable;
    const files = records.slice(0, end).map(path => ({ path, generated: generatedPaths.includes(path) }));
    return { state: 'complete', files, generatedOnly: files.length > 0 && files.every(file => file.generated) };
  } catch { return unavailable; }
  finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
}

export async function collectPrBlockers({ repos, root, checkouts = {}, cfg, now = Date.now(), limit = DEFAULT_PR_LIMIT,
  get = githubGet, fetchPr = fetchMergeAgentCandidateSnapshot, readStore = readReviewStore,
  leasesRead = readCloserLeases, receiptsRead = readCloserReceipts, remediationRead = readRemediation,
  launchRead = readLaunchRequestObservationFromLedgerAsync, conflictRead = readConflictFiles,
  guardsRead = loadGuardForbiddenPaths, authoritativeLogins = amaAllAuthoritativeReviewerLogins(),
  enrichChecks = args => enrichCiInfrastructureEvidence({ ...args, execFileImpl: exec }) } = {}) {
  repos.forEach(validateRepo);
  validatePrLimit(limit);
  const transportGet = get;
  let reads = 0;
  get = async path => {
    if (reads >= 200) throw new Error('report REST read budget exhausted');
    reads++;
    return transportGet(path);
  };
  const policy = cfg.getMergeAuthorityConfig();
  const checksCfg = { requiredCheckContexts: policy.requiredCheckContexts || [] };
  const rows = [], errors = [];
  try {
    const rate = (await get('rate_limit'))?.resources?.core;
    if (!Number.isFinite(rate?.remaining) || rate.remaining < 1000) {
      throw new Error('insufficient core rate budget');
    }
  } catch {
    return makePrBlockersReport([], new Date(now).toISOString(),
      ['GitHub core rate budget unavailable or below 1000 remaining; report refused']);
  }
  let inspected = 0;
  for (const repo of [...new Set(repos)]) {
    if (inspected >= limit) { errors.push(`PR limit ${limit} reached; remaining repositories omitted`); break; }
    let pulls;
    try { pulls = await readPages(get, `repos/${repo}/pulls?state=open`, limit - inspected + 1); }
    catch { errors.push(`${repo}: open PR list unavailable`); continue; }
    if (pulls.length > limit - inspected) errors.push(`${repo}: PR limit ${limit} reached; additional PRs omitted`);
    for (const listed of pulls.slice(0, limit - inspected)) {
      inspected++;
      const number = listed.number;
      const rowErrors = [];
      const attempt = async (name, read, fallback) => {
        try { return await read(); }
        catch { rowErrors.push(`${name} unavailable`); return fallback; }
      };
      // Independent reads settle together; no read dispatches work or writes
      // lease/state records. The final PR read below fences moving heads.
      const [prRaw, store, reviews, leases, receipts, remediation] = await Promise.all([
        attempt('PR', () => fetchPr(repo, number), null),
        attempt('review store', () => readStore(root, repo, number), null),
        attempt('submitted reviews', () => readPages(get, `repos/${repo}/pulls/${number}/reviews`), null),
        attempt('closer leases', () => leasesRead(root, repo, number), null),
        attempt('closer receipts', () => receiptsRead(root, repo, number), null),
        attempt('remediation', () => remediationRead(root, repo, number), null),
      ]);
      if (remediation?.ownershipUnknown && !remediation.launchRequestId) {
        rowErrors.push('active remediation has no launch-request ID; ownership unknown');
      }
      const pr = { ...listed, ...prRaw, number, createdAt: listed.created_at,
        state: prRaw?.mergedAt ? 'MERGED' : prRaw?.state || 'UNKNOWN' };
      if (prRaw && pr.state === 'OPEN') {
        pr.statusCheckRollup = await attempt('CI job evidence', () => enrichChecks({
          rollup: pr.statusCheckRollup, repo, headSha: pr.headRefOid,
        }), pr.statusCheckRollup);
      }
      const trusted = new Set(authoritativeLogins);
      const compareCache = new Map();
      const compare = (base, head) => {
        const path = `repos/${repo}/compare/${base}...${head}`;
        if (!compareCache.has(path)) compareCache.set(path, get(`${path}?per_page=100&page=1`));
        return compareCache.get(path);
      };
      const trustedReviews = reviews?.filter(review =>
        trusted.has(String(review.user?.login || '').replace(/\[bot\]$/, ''))) || [];
      const authoritative = reviews && await attempt('review authority',
        () => latestAuthoritativeReviewInAncestry(trustedReviews, pr.headRefOid, compare), null);
      const families = new Set(trustedReviews.filter(entry => entry.commit_id === authoritative?.commit_id
        && ['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(entry.state))
        .map(entry => amaReviewerFamilyForLogin(entry.user?.login)).filter(Boolean));
      const ambiguousReview = families.size > 1;
      if (ambiguousReview) rowErrors.push('multiple authoritative review families on selected head; review authority unknown');
      const review = authoritative ? { body: authoritative.body, headSha: authoritative.commit_id,
        postedAt: authoritative.submitted_at } : null;
      // A delivered store artifact absent from the live review list can be a
      // comment-only delivery. Show it, but keep authority explicitly unknown.
      const storedReview = !review && store?.pass ? { body: store.pass.body_md, headSha: store.pass.head_sha,
        postedAt: store.pass.posted_at } : null;
      if (storedReview) rowErrors.push('stored review not confirmed by submitted reviews');
      const stale = review && review.headSha !== pr.headRefOid;
      const [comparison, comments] = stale ? await Promise.all([
        attempt('review ancestry', async () => {
          if (!sha(review.headSha) || !sha(pr.headRefOid)) throw new Error('missing SHA');
          const path = `repos/${repo}/compare/${review.headSha}...${pr.headRefOid}`;
          const first = await compare(review.headSha, pr.headRefOid);
          const commits = [...(first.commits || [])];
          for (let page = 2; commits.length < first.total_commits; page++) {
            const batch = await get(`${path}?per_page=100&page=${page}`);
            if (!batch.commits?.length) throw new Error('incomplete comparison');
            commits.push(...batch.commits);
          }
          return { ...first, commits };
        }, null),
        attempt('closer attestations', () => readPages(get, `repos/${repo}/issues/${number}/comments`), null),
      ]) : [null, []];
      const exactLease = leases?.find(lease => lease.headSha === pr.headRefOid);
      const lease = exactLease || leases?.filter(lease => ['pending', 'dispatched'].includes(lease.status))
        .sort((a, b) => Date.parse(b.updatedAt || b.acquiredAt) - Date.parse(a.updatedAt || a.acquiredAt))[0] || null;
      const receipt = receipts?.filter(record => record.headSha === pr.headRefOid && record.launchRequestId)
        .sort((a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt))[0];
      const launchOwner = lease?.lrqId ? lease : receipt
        ? { lrqId: receipt.launchRequestId, headSha: receipt.headSha } : null;
      const launchObservation = launchOwner
        ? await attempt('closer launch', () => launchRead({ rootDir: root, launchRequestId: launchOwner.lrqId }), unknown()) : null;
      const launches = launchOwner ? launchSource(launchObservation, launchOwner, {})
        : leases && receipts ? complete({ closer: null }) : unknown();
      if (remediation?.launchRequestId) {
        const owner = await attempt('remediation launch',
          () => launchRead({ rootDir: root, launchRequestId: remediation.launchRequestId }), unknown());
        const owned = owner.state === 'complete' ? launchRequestOwned({
          ok: true, row: owner.value?.launch, retryChain: owner.value?.retryChain,
          retryChainUnreadable: owner.value?.retryChainUnreadable,
        }) : null;
        if (owned === null) {
          rowErrors.push('remediation ownership unknown');
          remediation.ownershipUnknown = true;
        } else {
          remediation.job.live = owned;
          remediation.ownershipUnknown = false;
        }
      }
      const earlierHeadOwner = lease && lease.headSha !== pr.headRefOid
        && ['pending', 'dispatched'].includes(lease.status);
      if (earlierHeadOwner) rowErrors.push('closer lease references an earlier head; ownership requires reconciliation');
      const observations = {
        leases: leases && receipts && !remediation?.ownershipUnknown
          && !earlierHeadOwner
          && !receipts.some(record => record.headSha === pr.headRefOid && isPreReceiptIntent(record))
          ? complete({ closer: lease }) : { state: 'unknown', value: { closer: lease } }, launches,
        remediation: remediation && !remediation.ownershipUnknown ? complete(remediation) : unknown(),
      };
      let currencyKnown = true;
      if (stale && comments !== null) {
        const facts = reviewFacts(review);
        const proof = await attempt('closer provenance', () => proveCloserAuthoredStaleHead({
          repoPath: repo, rootDir: root, prNumber: number, reviewedHead: review.headSha,
          currentHead: pr.headRefOid, comments }), null);
        currencyKnown = proof !== null;
        observations.progress = { closerAuthoredStale: closerAuthoredStaleEligible({
          headProof: proof, verdict: ['approved', 'comment-only'].includes(facts.verdict) ? 'settled-success' : facts.verdict,
          blockingFindingState: facts.blockingFindingState, blockingFindingCount: facts.blockingFindingCount,
          checksConclusion: summarizeExternalChecks(pr.statusCheckRollup, { cfg: checksCfg }).conclusion,
          mergeability: pr.mergeable,
        }) };
      } else if (stale) currencyKnown = false;
      let conflicts;
      if (pr.mergeStateStatus === 'DIRTY') {
        const guards = await attempt('generated paths', () => guardsRead({ repo, baseRef: pr.baseRefOid, log: null }), []);
        conflicts = await attempt('conflict detail', () => conflictRead({
          checkout: checkouts[repo], base: pr.baseRefOid, head: pr.headRefOid,
          generatedPaths: guards.map(guard => guard.path),
        }), { state: 'unavailable', files: [], generatedOnly: false });
      }
      const final = await attempt('head verification', () => get(`repos/${repo}/pulls/${number}`), null);
      if (final && (final.state !== 'open' || final.merged_at)) continue;
      if (!final || final.head?.sha !== pr.headRefOid) {
        rowErrors.push('head changed or could not be verified; refresh report');
        pr.statusCheckRollup = null;
        pr.mergeable = 'UNKNOWN';
      }
      const row = buildPrBlocker({ repo, pr, review: ambiguousReview ? null : review || storedReview, comparison, comments,
        conflicts, observations, policy, cfg: checksCfg, now, errors: rowErrors,
        reviewKnown: reviews !== null && !storedReview && !ambiguousReview
          && !rowErrors.includes('review authority unavailable'), currencyKnown });
      rows.push(row);
    }
  }
  if (reads >= 200) errors.push('report REST read budget reached (200); some evidence may be unavailable');
  return makePrBlockersReport(rows, new Date(now).toISOString(), errors);
}
