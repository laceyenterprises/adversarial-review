import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseReviewFindings } from '../kernel/review-findings.mjs';
import { normalizeEffectiveReviewVerdict } from '../kernel/verdict.mjs';
import { readHeadAttestationChainForPr } from '../daemon-worker-identity.mjs';
import { PR_ROUND_KINDS, readPrRoundLedger } from '../pr-round-ledger.mjs';
import { REMEDIATION_WORKER_IDENTITY_DEFAULTS, remediationWorkerTrailerClass } from '../remediation-worker-provenance.mjs';
import { resolveRepoCheckoutDir } from '../reviewer-repo-checkout.mjs';
import {
  HAMMER_COMMENTS_CAPPED, hammerAttestationChain, hammerProvenanceCommentsCapped, hammerProvenanceEdge,
  readCompletedRemediationEvidence, readHammerProvenanceComments,
} from './hammer-head-validation.mjs';
import { hamCommitIdentityMatches, isHamWorkerTicket, parseCommitTrailers, parseCommitTrailerValues } from './ham-provenance.mjs';
import { readHammerRetryCapLedger } from './hammer-retry-cap.mjs';
import { readLaneReversalIdentity } from './lane-reversal.mjs';
import { proveNativeStoppedFindingLineage, proveStoppedRemediationPublication } from './stopped-remediation-publication.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const LIMIT = 256;
const EMPTY_OID = '0'.repeat(40);
const REGULAR_FILE_MODE = /^100(?:644|755)$/;
const RETAINED_REPAIR_INSPECTION = 'review-service owner inspection required for retained repair currency'
  + ' (RUNBOOK-ama-closure.md#retained-repair-publication-followed-by-main-integration)';
const isAbort = error => ['AbortError', 'TimeoutError'].includes(error?.name)
  || ['ABORT_ERR', 'ETIMEDOUT'].includes(error?.code)
  || ['SIGTERM', 'SIGKILL'].includes(error?.signal);

function memoizedRead(cache, key, read) {
  if (!cache.has(key)) {
    const pending = Promise.resolve().then(read).catch(error => {
      if (cache.get(key) === pending) cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
  }
  return cache.get(key);
}

// No fetches: callers own checkout hydration. Missing objects are missing proof,
// never permission to assume that a rewritten review is still current.
export function currencyGit(args, input, { cwd, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, encoding,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' },
      timeout: loadAwareTimeoutMs(15000), maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function reviewCurrencyCovers(currency, reviewedHead, currentHead) {
  return currency?.current === true && currency.reviewedHead === reviewedHead && currency.currentHead === currentHead;
}

// Ancestry admits the review's findings, but grants no new head-match waiver.
export function rebaseCurrencyCovers(currency, reviewedHead, currentHead) {
  return reviewCurrencyCovers(currency, reviewedHead, currentHead)
    && ['exact-head', 'closer-rebase-provenance', 'reviewed-rebase-patch-id', 'reviewed-rebase-replay'].includes(currency.proof);
}

async function treeDelta(git, from, to) {
  const raw = await git(['diff-tree', '-r', '--no-commit-id', '--raw', '--no-abbrev', '-z',
    '--no-renames', '--no-relative', '--ignore-submodules=none', from, to]);
  const fields = raw.split('\0');
  if (fields.pop() !== '' || fields.length % 2 !== 0) throw new Error('incomplete PR commit delta');
  const changes = new Map(), blobs = new Set();
  for (let i = 0; i < fields.length; i += 2) {
    const entry = /^:([0-7]{6}) ([0-7]{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) [ADMT]$/.exec(fields[i]);
    const path = fields[i + 1];
    if (!entry || !path || path.includes('\uFFFD') || changes.has(path)) throw new Error('invalid PR commit delta');
    const [, beforeMode, afterMode, before, after] = entry;
    changes.set(path, { beforeMode, afterMode, before, after });
    if (before !== EMPTY_OID && beforeMode !== '160000') blobs.add(before);
    if (after !== EMPTY_OID && afterMode !== '160000') blobs.add(after);
  }
  if (blobs.size) {
    // Raw deltas can name missing blobs. Check them even on the exact-match path.
    const objects = await git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], [...blobs].join('\n') + '\n');
    if (objects !== [...blobs].map(oid => `${oid} blob\n`).join('')) throw new Error('missing PR commit blob');
  }
  return changes;
}

async function replaysBlob(git, ours, base, theirs, expected) {
  // merge-file uses Git's text merge directly, without repository merge
  // drivers, rename heuristics, an index, or writes to the object store.
  let bytes;
  try {
    bytes = await git(['merge-file', '--object-id', '--stdout', ours, base, theirs],
      undefined, { encoding: 'buffer' });
  } catch (error) {
    if (error.code === 129) throw new Error('git merge-file --object-id unsupported (requires Git 2.43+)', { cause: error });
    if (Number.isInteger(error.code) && error.code > 0 && error.code <= 127) return false;
    throw error;
  }
  if (!Buffer.isBuffer(bytes)) throw new Error('missing PR commit replay bytes');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === expected;
}

async function integrationSeries(git, publication, currentHead, base) {
  const rows = (await git(['rev-list', '--first-parent', '--parents', `--max-count=${LIMIT + 1}`,
    currentHead, `^${publication}`])).trim().split('\n').filter(Boolean).map(row => row.split(' '));
  if (!rows.length || rows.length > LIMIT || rows[0][0] !== currentHead || rows.at(-1)[1] !== publication
    || rows.some((row, i) => row.length < 2 || row.length > 3 || !row.every(sha => SHA.test(sha))
      || (i + 1 < rows.length && row[1] !== rows[i + 1][0]))) return null;
  const merges = rows.filter(row => row.length === 3);
  if (merges.length !== 1) return null;
  const [, , main] = merges[0];
  const mainLine = (await git(['rev-list', '--first-parent', `--max-count=${LIMIT}`, base])).trim().split('\n');
  if (!mainLine.includes(main)) return null;
  return { merge: merges[0], rows: rows.reverse() };
}

// Reconstruct a conservative three-way tree merge from Git objects. No merge
// drivers, rename heuristics, checkout, or writes to the repository are used.
async function replaysMainIntegration(git, readTreeDelta, [sha, first, main]) {
  const fork = (await git(['merge-base', '--all', first, main])).trim();
  if (!SHA.test(fork) || fork === first || fork === main) return false;
  const [ours, theirs, actual] = await Promise.all([first, main, sha].map(to => readTreeDelta(fork, to)));
  const paths = new Set([...ours.keys(), ...theirs.keys()]);
  if ([...actual.keys()].some(path => !paths.has(path))) return false;
  let replayCount = 0;
  for (const path of paths) {
    const a = ours.get(path), b = theirs.get(path), merged = actual.get(path);
    if (!a || !b || (a.after === b.after && a.afterMode === b.afterMode)) {
      const expected = a || b;
      if (merged?.after !== expected.after || merged?.afterMode !== expected.afterMode) return false;
      continue;
    }
    if (!merged || !REGULAR_FILE_MODE.test(a.beforeMode) || a.beforeMode !== a.afterMode
      || a.beforeMode !== b.afterMode || a.beforeMode !== merged.afterMode || ++replayCount > LIMIT
      || !await replaysBlob(git, a.after, a.before, b.after, merged.after)) return false;
  }
  return true;
}

// Compare commits in order, including empty commit positions. Matching paths,
// modes and exact before/after blobs cover the fast path. When upstream changed
// a file, replay in both directions so absorbed or additional edits fail.
// Preserve the existing HAM proof. Other lanes can only extend a strict prefix.
async function replayCurrency({ reviewedHead, currentHead, base, git, readDelta, readCommit, laneCommit, nativeSuffix }) {
  const series = async head => {
    const fork = (await git(['merge-base', head, base])).trim();
    if (!SHA.test(fork)) throw new Error('missing merge base');
    const rows = (await git(['rev-list', '--parents', '--reverse', '--topo-order', `--max-count=${LIMIT + 1}`, `${fork}..${head}`]))
      .trim().split(/\r?\n/).filter(Boolean).map(line => line.split(/\s+/));
    if (!rows.length || rows.length > LIMIT || rows.at(-1)[0] !== head
      || rows.some((row, index) => row.length !== 2 || !row.every(sha => SHA.test(sha))
        || row[1] !== (index === 0 ? fork : rows[index - 1][0]))) {
      throw new Error('incomplete or nonlinear PR commit series');
    }
    return { fork, commits: rows.map(([sha]) => sha) };
  };
  const oldSeries = await series(reviewedHead), newSeries = await series(currentHead);
  // Equivalent patches on an older base are a reset, not a forward rebase.
  await git(['merge-base', '--is-ancestor', oldSeries.fork, newSeries.fork]);
  let replayCount = 0;
  const equivalent = async (source, target) => {
    if (source.size !== target.size) return false;
    for (const [path, old] of source) {
      const next = target.get(path);
      if (!next || old.beforeMode !== next.beforeMode || old.afterMode !== next.afterMode) return false;
      if (old.before === next.before) {
        if (old.after !== next.after) return false;
        continue;
      }
      if (!REGULAR_FILE_MODE.test(old.beforeMode) || !REGULAR_FILE_MODE.test(old.afterMode)) return false;
      if (++replayCount > LIMIT) throw new Error(`PR commit replay exceeded ${LIMIT} file comparisons`);
      if (!await replaysBlob(git, next.before, old.before, old.after, next.after)
        || !await replaysBlob(git, old.before, next.before, next.after, old.after)) return false;
    }
    return true;
  };
  let index = 0;
  let expected = await readDelta(oldSeries.commits[index]);
  let hamExtra = false, laneExtra = false;
  const suffix = [];
  for (const sha of newSeries.commits) {
    const delta = await readDelta(sha);
    if (expected && await equivalent(expected, delta)) {
      const next = oldSeries.commits[++index];
      expected = next ? await readDelta(next) : null;
      continue;
    }
    if (nativeSuffix) {
      if (expected) return null;
      suffix.push(sha);
      continue;
    }
    const commit = await readCommit?.(sha);
    if (!commit) return null;
    const trailers = parseCommitTrailers(commit?.commit?.message);
    if (!laneExtra && hamCommitIdentityMatches(commit)
      && /^hammer(?:-corp|-claude)?$/i.test(trailers['worker-class'] || '')
      && isHamWorkerTicket(trailers['worker-ticket']) && trailers['reviewed-head'] === reviewedHead
      && trailers['closed-by'] === 'hammer (adversarial-pipe-mode)') {
      hamExtra = true;
      continue;
    }
    if (hamExtra || expected || !laneCommit || !await laneCommit(commit)) return null;
    laneExtra = true;
  }
  if (expected) return null;
  if (nativeSuffix) return suffix.length && await nativeSuffix(suffix, oldSeries.commits.length) ? 'reviewed-rebase-lane-suffix' : null;
  return laneExtra ? 'reviewed-rebase-lane-suffix' : 'reviewed-rebase-replay';
}

// The HQ CLI reference is regenerated on main integration. It can sit
// outside this lineage projection only when the authenticated closer changed
// it and it was absent from the reviewed and worker-published source delta.
const HQ_CLI_REFERENCE = 'docs/reference/hq-cli-reference.md';

async function replayStoppedSource({ reviewedHead, currentHead, base, git, readDelta, readTreeDelta,
  published, closer, spec, reviewedCommits }) {
  if (!SHA.test(closer || '') || !Number.isSafeInteger(reviewedCommits) || reviewedCommits < 1) return false;
  const publication = await replayCurrency({ reviewedHead, currentHead: published, base, git, readDelta,
    nativeSuffix: (suffix, count) => count === reviewedCommits && suffix.length === 1 && suffix[0] === published });
  if (!publication) return false;
  const parents = async sha => (await git(['rev-list', '--parents', '-n1', sha])).trim().split(' ');
  const closureParents = await parents(closer);
  if (closureParents.length !== 2 || closureParents[0] !== closer || closureParents[1] !== published) return false;
  const closure = await readDelta(closer);
  const amendment = closure.get(spec);
  const cliReference = closure.get(HQ_CLI_REFERENCE);
  if (amendment?.beforeMode !== '100644' || amendment.afterMode !== '100644'
    || (cliReference && (cliReference.beforeMode !== '100644' || cliReference.afterMode !== '100644'))
    || [...closure.keys()].some(path => path !== spec && path !== HQ_CLI_REFERENCE)) return false;
  const fork = (await git(['merge-base', '--all', published, base])).trim();
  if (!SHA.test(fork)) return false;
  const workerSource = await readTreeDelta(fork, published);
  if (workerSource.has(spec)) return false;
  if (currentHead === closer) return true;

  const [tip, first, main, ...extra] = await parents(currentHead);
  if (extra.length || tip !== currentHead || !SHA.test(main || '') || !SHA.test(first || '')) return false;
  if (main !== base) {
    const mainLine = (await git(['rev-list', '--first-parent', `--max-count=${LIMIT}`, base])).trim().split('\n');
    if (!mainLine.includes(main)) return false;
  }
  const containsCloser = await git(['merge-base', '--is-ancestor', closer, first]).then(() => true, error => {
    if (error.code === 1) return false;
    throw error;
  });
  if (!containsCloser) return false;
  const regenerate = cliReference && !workerSource.has(HQ_CLI_REFERENCE) && !(await readDelta(published)).has(HQ_CLI_REFERENCE);
  const projectedDelta = async (from, to) => {
    const delta = await readTreeDelta(from, to);
    const reference = delta.get(HQ_CLI_REFERENCE);
    if (!regenerate || reference?.beforeMode !== '100644' || reference.afterMode !== '100644') return delta;
    return new Map([...delta].filter(([path]) => path !== HQ_CLI_REFERENCE));
  };
  return replaysMainIntegration(git, projectedDelta, [currentHead, closer, main]);
}

function remediationPublicationWorker(commit, publications) {
  const trailers = parseCommitTrailers(commit.commit?.message);
  const worker = publications.get(`${commit.sha}:${trailers['worker-job-id']}`);
  const workerClass = worker?.workerClass || worker?.model;
  return Object.hasOwn(REMEDIATION_WORKER_IDENTITY_DEFAULTS, workerClass)
    && remediationWorkerTrailerClass(workerClass) === trailers['worker-class']
    && parseCommitTrailerValues(commit.commit?.message)['worker-job-id']?.length === 1 ? worker : null;
}

async function hasPublishedSource({ reviewedHead, sourceHead, base, git, readDelta, readCommit, rounds, publications, laneCommit }) {
  if (sourceHead === reviewedHead) return true;
  // A completed round may have rebased before publishing its own commit.
  // Attribute that exact publication and independently prove its parent.
  const [sha, parent, ...other] = (await git(['rev-list', '--parents', '-n1', sourceHead])).trim().split(/\s+/);
  if (sha !== sourceHead || !SHA.test(parent || '') || other.length) return false;
  const commit = await readCommit(sourceHead);
  const worker = commit && remediationPublicationWorker(commit, publications);
  const round = worker && rounds.find(round => round.worker === worker
    && round.startHeadSha === reviewedHead && round.resultingHeadSha === sourceHead);
  // Both indexes come from the same read. Require the worker receipt from
  // this exact round so a different round ending at the same SHA cannot lend it.
  if (!round || !await laneCommit(commit)) return false;
  return parent === reviewedHead || Boolean(await replayCurrency({ reviewedHead, currentHead: parent, base, git, readDelta }));
}

// One evaluation-local reader for finding admission AND disposition admission.
// Only an exact current endpoint is covered; a later unrelated push cannot
// inherit a prior HAM audit edge. Cache reads only within this live evaluation.
export function createReviewCurrencyReader({ repo, prNumber, rootDir, get, comments = null, loadComments, cwd,
  git: suppliedGit, pr = null,
  readHeadAttestations = readHeadAttestationChainForPr }) {
  const git = suppliedGit || ((args, input, options) => currencyGit(args, input, { cwd, ...options }));
  const cache = new Map();
  const sharedReads = new Map();
  const readTreeDelta = (from, to) => memoizedRead(sharedReads, `delta:${from}:${to}`, () => treeDelta(git, from, to));
  const readDelta = sha => readTreeDelta(`${sha}^`, sha);
  const stoppedSource = async ({ reviewedHead, currentHead, base, ...input }) => {
    const result = (proofGit, delta) => replayStoppedSource({ reviewedHead, currentHead, base, git: proofGit,
      readTreeDelta: delta, readDelta: sha => delta(`${sha}^`, sha), ...input });
    if (suppliedGit) return result(git, readTreeDelta);
    const heads = [reviewedHead, currentHead, base, input.published, input.closer];
    const hasObjects = proofGit => proofGit(['cat-file', '--batch-check=%(objectname) %(objecttype)'], heads.join('\n') + '\n')
      .then(value => value === heads.map(head => `${head} commit\n`).join(''), error => {
        if (isAbort(error)) throw error;
        return false;
      });
    if (await hasObjects(git)) return result(git, readTreeDelta);
    // The daemon can evaluate a different repository from its service cwd.
    // Resolve an existing origin-bound checkout without fetching.
    const checkout = await memoizedRead(sharedReads, 'stopped-source-checkout', () => resolveRepoCheckoutDir({ repo, rootDir }));
    if (!checkout) return false;
    const checkoutGit = (args, stdin, options) => currencyGit(args, stdin, { cwd: checkout, ...options });
    if (!await hasObjects(checkoutGit)) return false;
    return result(checkoutGit, (from, to) => memoizedRead(sharedReads, `stopped-delta:${from}:${to}`,
      () => treeDelta(checkoutGit, from, to)));
  };
  let updateRounds;
  const readCommit = async sha => {
    const commit = await memoizedRead(sharedReads, `commit:${sha}`, () => get(`repos/${repo}/commits/${sha}`));
    return commit?.sha === sha ? commit : null;
  };
  const readIdentity = (sha, filter = () => true) => readLaneReversalIdentity({
    rootDir, repo, prNumber, currentHeadSha: sha,
    readHeadAttestationChainForPrImpl: async args => {
      const rows = await memoizedRead(sharedReads, 'attestations', () => readHeadAttestations(args));
      return rows.filter(filter);
    },
  });
  const readComments = () => memoizedRead(sharedReads, 'comments', () => loadComments ? loadComments()
    : comments !== null ? Promise.resolve(comments)
    : readHammerProvenanceComments(page => get(
      `repos/${repo}/issues/${prNumber}/comments?per_page=100${page === 1 ? '' : `&page=${page}`}`)));
  const laneCommitMatches = async (commit, publications, diagnostics, branch) => {
    const { sha } = commit;
    const worker = remediationPublicationWorker(commit, publications);
    const workerClass = worker?.workerClass || worker?.model;
    if (worker && !worker.dispatchId && !worker.requiresProducedAttestation
      && (worker.dispatchMode === undefined || worker.dispatchMode === 'local')) {
      // The evidence reader already bound the local launch to the job's
      // resolved reply key, which can differ from its provenance job ID.
      return true;
    }
    // An exact HCP in-place publication round identifies the PR-update lane.
    // The signed production record supplies its launch and worker identity.
    updateRounds ??= new Map(readPrRoundLedger(rootDir, { repo, prNumber }).filter(entry =>
      entry.kind === PR_ROUND_KINDS.HQ_PR_UPDATE && !entry.voided
      && typeof entry.repo === 'string' && entry.repo.toLowerCase() === repo.toLowerCase()
      && entry.prNumber === Number(prNumber) && entry.roundId === `hq-pr-update:${entry.headSha}`)
      .map(entry => [entry.headSha, entry]));
    const updateRound = updateRounds.get(sha);
    if (!worker && !updateRound) return false;
    const isPrUpdate = !worker;
    if (isPrUpdate && !updateRound.launchRequestId) {
      diagnostics.push(`lane publication ${sha}: missing PR-update round launchRequestId`);
      return false;
    }
    const identity = await readIdentity(sha, row => (!isPrUpdate || row?.payload?.source === 'hq_branch_push')
      && (!branch || row?.payload?.branch === branch));
    if (!identity.ok) {
      diagnostics.push(`lane publication ${sha}: ${identity.reason}${identity.transient ? ' (transient)' : ''}`);
      return false;
    }
    const matched = isPrUpdate ? identity.launchRequestId === updateRound.launchRequestId
      : worker.launchRequestId === identity.launchRequestId && workerClass === identity.workerClass;
    if (!matched) diagnostics.push(`lane publication ${sha}: launch or worker identity mismatch`);
    return matched;
  };
  const nativeSuffixMatches = async (suffix, epoch, branch, diagnostics) => {
    if (!suffix.includes(epoch.publicationHead)) {
      diagnostics.push(`native repair suffix is missing its bound publication ${epoch.publicationHead}`);
      return false;
    }
    let worker;
    for (const sha of suffix) {
      const commit = await readCommit(sha);
      const trailers = parseCommitTrailerValues(commit?.commit?.message);
      const [job] = trailers['worker-job-id'] || [];
      if (!job || trailers['worker-job-id'].length !== 1 || trailers['worker-class']?.length !== 1
        || `ffa-${createHash('sha256').update(job).digest('hex')}` !== epoch.ownerKey) {
        diagnostics.push(`native repair publication ${sha}: original job identity mismatch`);
        return false;
      }
      const identity = await readIdentity(sha, row => row?.payload?.source === 'hq_branch_push'
        && row.payload.branch === branch);
      if (!identity.ok) {
        diagnostics.push(`native repair publication ${sha}: ${identity.reason}${identity.transient ? ' (transient)' : ''}`);
        return false;
      }
      if (identity.launchRequestId !== epoch.publicationLaunch || !identity.producerIdentity
        || (worker && (worker.producerIdentity !== identity.producerIdentity || worker.workerClass !== identity.workerClass))
        || !Object.hasOwn(REMEDIATION_WORKER_IDENTITY_DEFAULTS, identity.workerClass)
        || remediationWorkerTrailerClass(identity.workerClass) !== trailers['worker-class'][0]) {
        diagnostics.push(`native repair publication ${sha}: launch or worker identity mismatch`);
        return false;
      }
      worker = identity;
    }
    return true;
  };
  const proveNativeIntegration = async ({ epoch, currentHead, live, provenance, diagnostics, laneCommit }) => {
    if (live.state !== 'open' || live.base.ref !== 'main' || live.base.repo?.full_name?.toLowerCase() !== repo.toLowerCase()
      || epoch.publicationHead === currentHead) return null;
    const series = await integrationSeries(git, epoch.publicationHead, currentHead, live.base.sha);
    if (!series) return null;
    const [mergeHead, , main] = series.merge;
    const branch = live.head.ref;
    // A receipt binds the publication, and ordered replay separately binds its
    // source. Neither an epoch nor a later PR-update receipt covers both.
    const published = await nativeSuffixMatches([epoch.publicationHead], epoch, branch, diagnostics);
    let publicationSuffix;
    const prefix = await replayCurrency({ reviewedHead: epoch.baseHead, currentHead: epoch.publicationHead, base: main, git, readDelta,
      nativeSuffix: suffix => {
        publicationSuffix = suffix;
        return suffix.at(-1) === epoch.publicationHead;
      } });
    if (!prefix) diagnostics.push(`retained publication ${epoch.publicationHead}: ordered source replay unproven`);
    const publicationCovered = published && prefix && (publicationSuffix.length === 1
      || await nativeSuffixMatches(publicationSuffix, epoch, branch, diagnostics));
    const integrated = await replaysMainIntegration(git, readTreeDelta, series.merge);
    if (!integrated) diagnostics.push(`main integration ${mergeHead}: exact tree replay unproven`);
    const hammerEdges = Array.isArray(provenance) && !hammerProvenanceCommentsCapped(provenance)
      ? provenance.filter(comment => !comment?.event || comment.event === 'commented').map(hammerProvenanceEdge).filter(Boolean) : [];
    let attributed = true;
    for (const [sha, parent] of series.rows) {
      if (sha === mergeHead || hammerEdges.some(edge => edge.base === parent && edge.head === sha)) continue;
      const commit = await readCommit(sha);
      if (commit && await laneCommit(commit)) continue;
      diagnostics.push(`integration successor ${sha}: exact publication authority unproven`);
      attributed = false;
      break;
    }
    if (publicationCovered && integrated && attributed) return 'reviewed-native-publication-main-integration';
    diagnostics.push(RETAINED_REPAIR_INSPECTION);
    return null;
  };
  const proveRebase = async (reviewedHead, currentHead, { rebaseOnly, status, review, limits, diagnostics }) => {
    const provenance = await readComments().catch(error => {
      if (isAbort(error)) throw error;
      return null;
    });
    if (hammerProvenanceCommentsCapped(provenance, repo, prNumber)) limits.push(HAMMER_COMMENTS_CAPPED);
    if (hammerAttestationChain(provenance, reviewedHead, currentHead)) return 'closer-rebase-provenance';
    const { rounds, settledRounds, finalPublications, lanePublications, limitReached } = await memoizedRead(
      sharedReads, 'rounds', () => readCompletedRemediationEvidence(rootDir, repo, prNumber));
    if (limitReached) limits.push(`completed-round proof scan hit the ${limitReached} limit`);
    if (hammerAttestationChain(provenance, reviewedHead, currentHead, settledRounds)) return 'closer-rebase-provenance';
    // The local final publication admits its source review as evidence. It
    // confers no head-match or disposition waiver in rebaseCurrencyCovers.
    if (!rebaseOnly && finalPublications.some(entry => entry.reviewedHead === reviewedHead && entry.head === currentHead)) {
      return 'comment-only-final-remediation-publication';
    }
    let live;
    try {
      live = await memoizedRead(sharedReads, 'pr', () => pr || get(`repos/${repo}/pulls/${prNumber}`));
      if (live?.head?.sha === currentHead && SHA.test(live?.base?.sha || '')) {
        // Lane changes keep findings applicable for fresh adjudication at the
        // live head. They carry neither a prior withdrawal nor a head waiver.
        const laneCommit = rebaseOnly || !rootDir ? null
          : commit => laneCommitMatches(commit, lanePublications, diagnostics);
        try {
          const proof = await replayCurrency({ reviewedHead, currentHead, base: live.base.sha, git, readDelta, readCommit, laneCommit });
          if (proof) return proof;
        } catch (error) {
          if (isAbort(error)) throw error;
          diagnostics.push(error.message);
        }
        if (laneCommit && live.head.ref && live.head.repo?.full_name?.toLowerCase() === repo.toLowerCase()) {
          const ledger = await memoizedRead(sharedReads, 'repair-epochs', () => readHammerRetryCapLedger(rootDir, { repo, prNumber }));
          const epochs = ledger?.repairEpochs;
          if (ledger?.repo?.toLowerCase() === repo.toLowerCase() && Number(ledger.prNumber) === Number(prNumber)
            && Array.isArray(epochs) && epochs.length <= LIMIT) {
            for (const epoch of epochs) {
              if (!SHA.test(epoch?.baseHead || '') || !SHA.test(epoch.publicationHead || '')
                || !/^ffa-[a-f0-9]{64}$/.test(epoch.ownerKey || '') || !epoch.boundAt
                || !/^lrq_[a-z0-9-]+$/i.test(epoch.publicationLaunch || '')
                || epoch.ownerLaunch !== epoch.publicationLaunch || epoch.terminalAt) continue;
              try {
                if (!await hasPublishedSource({ reviewedHead, sourceHead: epoch.baseHead, base: live.base.sha, git, readDelta, readCommit,
                  rounds, publications: lanePublications, laneCommit })) {
                  diagnostics.push(`native repair source ${epoch.baseHead}: completed worker publication unproven`);
                  continue;
                }
                const beforeReplay = diagnostics.length;
                let native;
                try {
                  native = await replayCurrency({ reviewedHead: epoch.baseHead, currentHead, base: live.base.sha, git, readDelta,
                    nativeSuffix: suffix => nativeSuffixMatches(suffix, epoch, live.head.ref, diagnostics) });
                } catch (error) {
                  if (isAbort(error)) throw error;
                  diagnostics.push(`native repair source ${epoch.baseHead}: ${error.message}`);
                }
                if (native) return native;
                if (diagnostics.length === beforeReplay) diagnostics.push(`native repair source ${epoch.baseHead}: ordered prefix replay unproven`);
                if (status === 'diverged') {
                  const integration = await proveNativeIntegration({ epoch, currentHead, live, provenance, diagnostics,
                    laneCommit: commit => laneCommitMatches(commit, lanePublications, diagnostics, live.head.ref) });
                  if (integration) return integration;
                }
              } catch (error) {
                if (isAbort(error)) throw error;
                diagnostics.push(`native repair source ${epoch.baseHead}: ${error.message}`);
              }
            }
          }
        }
      }
    } catch (error) {
      if (isAbort(error)) throw error;
      diagnostics.push(error.message);
    }
    // Native rounds can keep findings and superseding reviews in scope.
    // A round awaiting review carries no head-match or disposition waiver.
    if (rebaseOnly) return null;
    if (hammerAttestationChain(provenance, reviewedHead, currentHead, rounds)) {
      return { proof: 'completed-remediation-hammer-finding-currency', ...(diagnostics.length ? { patchProofError: diagnostics.at(-1) } : {}) };
    }
    if (status === 'diverged' && review
      && await proveStoppedRemediationPublication({ rootDir, repo, prNumber, reviewedHead, currentHead, review, live, get, readCommit })) {
      return 'verified-stopped-remediation-finding-currency';
    }
    const findings = review?.state === 'COMMENTED' && normalizeEffectiveReviewVerdict(review.body) === 'comment-only'
      ? parseReviewFindings(review.body) : null;
    if (status === 'diverged' && live && SHA.test(live.base?.sha || '')
      && Array.isArray(provenance) && !hammerProvenanceCommentsCapped(provenance)
      && findings?.blocking.state === 'known' && findings.blocking.count === 0
      && findings.nonBlocking.state === 'known' && findings.nonBlocking.count > 0) {
      const edges = provenance.filter(comment => !comment?.event || comment.event === 'commented').flatMap(comment => {
        const edge = hammerProvenanceEdge(comment);
        const login = comment?.user?.login || comment?.author?.login || comment?.author;
        return edge && !edge.validated && typeof login === 'string' ? [{ ...edge, login }] : [];
      });
      if (edges.length && await proveNativeStoppedFindingLineage({ rootDir, repo, prNumber, reviewedHead, currentHead,
        review, live, get: path => memoizedRead(sharedReads, path, () => get(path)).catch(error => {
          if (isAbort(error)) throw error;
          throw new Error('stopped advisory lineage: live review/activity unreadable', { cause: error });
        }), readCommit, provenance: edges,
        verifySource: input => stoppedSource({ reviewedHead, currentHead, base: live.base.sha, ...input }) })) {
        return 'verified-stopped-advisory-finding-lineage';
      }
    }
    return null;
  };
  return (reviewedHead, currentHead, { rebaseOnly = false, review = null } = {}) => {
    const source = !rebaseOnly && typeof review?.body === 'string' ? review : null;
    const key = JSON.stringify([reviewedHead, currentHead, rebaseOnly, source?.id, source?.state, source?.commit_id,
      source?.user?.login, source?.submitted_at, source && createHash('sha256').update(source.body).digest('hex')]);
    return memoizedRead(cache, key, async () => {
      const result = { reviewedHead, currentHead, current: false };
      if (!SHA.test(reviewedHead || '') || !SHA.test(currentHead || '')) return { ...result, missingProof: 'invalid reviewed or current head' };
      if (reviewedHead === currentHead) return { ...result, current: true, proof: 'exact-head' };
      const localReplay = rebaseOnly ? '' : ' or a recorded local final-remediation replay'
        + ' or an ordered replay prefix with a launch-attributed lane suffix'
        + (rootDir ? ' or an attributed native repair suffix with ordered replay and, if needed, exact main integration'
          + ' or a verified stopped remediation publication' : '');
      const missingProof = `HAM base/head provenance or ordered replay of PR commits${localReplay} for ${reviewedHead} -> ${currentHead}`;
      const limits = [], diagnostics = [];
      let status;
      try {
        const comparePath = `repos/${repo}/compare/${reviewedHead}...${currentHead}`;
        try { status = (await memoizedRead(sharedReads, comparePath, () => get.metadata ? get.metadata(comparePath) : get(comparePath)))?.status; }
        catch (error) {
          if (isAbort(error)) throw error;
          // A durable exact-endpoint edge can independently prove currency.
        }
        if (!rebaseOnly && ['ahead', 'identical'].includes(status)) return { ...result, current: true, proof: 'ancestry' };
        // A branch reset cannot borrow evidence from its discarded descendant.
        if (status === 'behind') return { ...result, missingProof: 'current head predates reviewed evidence' };
        const proof = await proveRebase(reviewedHead, currentHead, { rebaseOnly, status, review: source, limits, diagnostics });
        if (proof) return { ...result, current: true, ...(typeof proof === 'string' ? { proof } : proof) };
      } catch (error) {
        if (isAbort(error)) throw error;
        diagnostics.push(error.message);
      }
      return { ...result, missingProof: [missingProof, ...limits, ...diagnostics].join(': '),
        ...(diagnostics.includes(RETAINED_REPAIR_INSPECTION) ? { recovery: 'review-service-owner' } : {}),
        ...(limits.length ? { proofLimit: limits.join(', ') } : {}) };
    });
  };
}

// Keep the original evidence identity intact. Cross-head coverage is separate
// read-only evidence, never a rewritten durable withdrawal or comment.
export async function carryHammerWithdrawals(withdrawals, currentHead, currency) {
  const result = [];
  for (const entry of withdrawals) {
    if (entry.resolution === 'withdrawn-by-remediator' && entry.headSha !== currentHead) continue;
    const reviewCurrency = await currency(entry.findingReviewedHead, currentHead);
    const evidenceCurrency = await currency(entry.headSha, currentHead, { rebaseOnly: true });
    result.push({ ...entry, reviewCurrency, evidenceCurrency });
  }
  return result;
}
