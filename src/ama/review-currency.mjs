import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readHeadAttestationChainForPr } from '../daemon-worker-identity.mjs';
import { PR_ROUND_KINDS, readPrRoundLedger } from '../pr-round-ledger.mjs';
import { REMEDIATION_WORKER_IDENTITY_DEFAULTS, remediationWorkerTrailerClass } from '../remediation-worker-provenance.mjs';
import {
  HAMMER_COMMENTS_CAPPED, hammerAttestationChain, hammerProvenanceCommentsCapped,
  readCompletedRemediationEvidence, readHammerProvenanceComments,
} from './hammer-head-validation.mjs';
import { hamCommitIdentityMatches, isHamWorkerTicket, parseCommitTrailers, parseCommitTrailerValues } from './ham-provenance.mjs';
import { readHammerRetryCapLedger } from './hammer-retry-cap.mjs';
import { readLaneReversalIdentity } from './lane-reversal.mjs';
import { proveStoppedRemediationPublication } from './stopped-remediation-publication.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const LIMIT = 256;
const EMPTY_OID = '0'.repeat(40);
const REGULAR_FILE_MODE = /^100(?:644|755)$/;
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

async function commitDelta(git, sha) {
  const raw = await git(['diff-tree', '-r', '--no-commit-id', '--raw', '--no-abbrev', '-z',
    '--no-renames', '--no-relative', '--ignore-submodules=none', `${sha}^`, sha]);
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

async function replaysBlob(git, target, source) {
  // merge-file uses Git's text merge directly, without repository merge
  // drivers, rename heuristics, an index, or writes to the object store.
  let bytes;
  try {
    bytes = await git(['merge-file', '--object-id', '--stdout', target.before, source.before, source.after],
      undefined, { encoding: 'buffer' });
  } catch (error) {
    if (error.code === 129) throw new Error('git merge-file --object-id unsupported (requires Git 2.43+)', { cause: error });
    if (Number.isInteger(error.code) && error.code > 0 && error.code <= 127) return false;
    throw error;
  }
  if (!Buffer.isBuffer(bytes)) throw new Error('missing PR commit replay bytes');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === target.after;
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
      if (!await replaysBlob(git, next, old) || !await replaysBlob(git, old, next)) return false;
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
  if (nativeSuffix) return suffix.length && await nativeSuffix(suffix) ? 'reviewed-rebase-lane-suffix' : null;
  return laneExtra ? 'reviewed-rebase-lane-suffix' : 'reviewed-rebase-replay';
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
  git = (args, input, options) => currencyGit(args, input, { cwd, ...options }), pr = null,
  readHeadAttestations = readHeadAttestationChainForPr }) {
  const cache = new Map();
  const sharedReads = new Map();
  const readDelta = sha => memoizedRead(sharedReads, `delta:${sha}`, () => commitDelta(git, sha));
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
  const laneCommitMatches = async (commit, publications, diagnostics) => {
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
    const identity = await readIdentity(sha, row => !isPrUpdate || row?.payload?.source === 'hq_branch_push');
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
                const native = await replayCurrency({ reviewedHead: epoch.baseHead, currentHead, base: live.base.sha, git, readDelta,
                  nativeSuffix: suffix => nativeSuffixMatches(suffix, epoch, live.head.ref, diagnostics) });
                if (native) return native;
                if (diagnostics.length === beforeReplay) diagnostics.push(`native repair source ${epoch.baseHead}: ordered prefix replay unproven`);
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
    return null;
  };
  return (reviewedHead, currentHead, { rebaseOnly = false, review = null } = {}) => {
    // Only the historical stopped-publication proof uses review identity.
    const source = !rebaseOnly && typeof review?.body === 'string' && /\[live_pack_cross_edit\]/i.test(review.body) ? review : null;
    const key = JSON.stringify([reviewedHead, currentHead, rebaseOnly, source?.commit_id,
      source?.user?.login, source?.submitted_at, source && createHash('sha256').update(source.body).digest('hex')]);
    return memoizedRead(cache, key, async () => {
      const result = { reviewedHead, currentHead, current: false };
      if (!SHA.test(reviewedHead || '') || !SHA.test(currentHead || '')) return { ...result, missingProof: 'invalid reviewed or current head' };
      if (reviewedHead === currentHead) return { ...result, current: true, proof: 'exact-head' };
      const localReplay = rebaseOnly ? '' : ' or a recorded local final-remediation replay'
        + ' or an ordered replay prefix with a launch-attributed lane suffix'
        + (rootDir ? ' or an attributed native repair suffix from a verified repair-epoch source or a verified stopped remediation publication' : '');
      const missingProof = `HAM base/head provenance or ordered replay of PR commits${localReplay} for ${reviewedHead} -> ${currentHead}`;
      const limits = [], diagnostics = [];
      let status;
      try {
        const comparePath = `repos/${repo}/compare/${reviewedHead}...${currentHead}`;
        try { status = (await memoizedRead(sharedReads, comparePath, () => get(comparePath)))?.status; }
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
