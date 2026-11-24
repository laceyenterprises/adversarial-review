import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { execFile } from 'node:child_process';
import { readHeadAttestationChainForPr, resolveDaemonWorkerIdentityFromHeadAttestation } from '../daemon-worker-identity.mjs';
import { PR_ROUND_KINDS, readPrRoundLedger } from '../pr-round-ledger.mjs';
import { REMEDIATION_WORKER_IDENTITY_DEFAULTS, remediationWorkerTrailerClass } from '../remediation-worker-provenance.mjs';
import {
  HAMMER_COMMENTS_CAPPED, hammerAttestationChain, hammerProvenanceCommentsCapped,
  readCompletedRemediationEvidence, readHammerProvenanceComments,
} from './hammer-head-validation.mjs';
import { hamCommitIdentityMatches, isHamWorkerTicket, parseCommitTrailers, parseCommitTrailerValues } from './ham-provenance.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const LIMIT = 256;

// No fetches: callers own checkout hydration. Missing objects are missing proof,
// never permission to assume that a rewritten review is still current.
export function currencyGit(args, input, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, timeout: loadAwareTimeoutMs(15000), maxBuffer: 16 * 1024 * 1024 },
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
    && ['exact-head', 'closer-rebase-provenance', 'reviewed-rebase-patch-id'].includes(currency.proof);
}

// Compare the PR's own ordered patch IDs, retaining empty commit positions.
// Preserve the existing HAM proof. Other lanes can only extend a strict prefix.
async function patchCurrency({ reviewedHead, currentHead, base, git, get, repo, laneCommit }) {
  const series = async head => {
    const fork = (await git(['merge-base', head, base])).trim();
    if (!SHA.test(fork)) throw new Error('missing merge base');
    const rows = (await git(['rev-list', '--parents', '--reverse', '--topo-order', `--max-count=${LIMIT + 1}`, `${fork}..${head}`]))
      .trim().split(/\r?\n/).filter(Boolean).map(line => line.split(/\s+/));
    if (!rows.length || rows.length > LIMIT || rows.some(row => row.length !== 2 || !row.every(sha => SHA.test(sha)))) {
      throw new Error('incomplete or nonlinear PR commit series');
    }
    return { fork, commits: rows.map(([sha]) => sha) };
  };
  const oldSeries = await series(reviewedHead), newSeries = await series(currentHead);
  // Equivalent patches on an older base are a reset, not a forward rebase.
  await git(['merge-base', '--is-ancestor', oldSeries.fork, newSeries.fork]);
  const patch = async sha => {
    const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', `${sha}^`, sha, '--', ':(top)']);
    if (!diff) return 'empty';
    const id = (await git(['patch-id', '--stable'], diff)).trim().split(/\s+/)[0];
    if (!SHA.test(id || '')) throw new Error('missing patch ID');
    return id;
  };
  const oldIds = [];
  for (const sha of oldSeries.commits) oldIds.push(await patch(sha));
  let index = 0;
  let hamExtra = false, laneExtra = false;
  for (const sha of newSeries.commits) {
    const id = await patch(sha);
    if (index < oldIds.length && id === oldIds[index]) { index++; continue; }
    const commit = await get(`repos/${repo}/commits/${sha}`);
    if (commit?.sha !== sha) return null;
    const trailers = parseCommitTrailers(commit?.commit?.message);
    if (!laneExtra && hamCommitIdentityMatches(commit)
      && /^hammer(?:-corp|-claude)?$/i.test(trailers['worker-class'] || '')
      && isHamWorkerTicket(trailers['worker-ticket']) && trailers['reviewed-head'] === reviewedHead
      && trailers['closed-by'] === 'hammer (adversarial-pipe-mode)') {
      hamExtra = true;
      continue;
    }
    if (hamExtra || index !== oldIds.length || !laneCommit || !await laneCommit(commit, trailers)) return null;
    laneExtra = true;
  }
  if (index !== oldIds.length) return null;
  return laneExtra ? 'reviewed-rebase-lane-suffix' : 'reviewed-rebase-patch-id';
}

// One evaluation-local reader for finding admission AND disposition admission.
// Only an exact current endpoint is covered; a later unrelated push cannot
// inherit a prior HAM audit edge. Cache reads only within this live evaluation.
export function createReviewCurrencyReader({ repo, prNumber, rootDir, get, comments = null, loadComments, cwd,
  git = (args, input) => currencyGit(args, input, { cwd }), pr = null,
  readHeadAttestations = readHeadAttestationChainForPr }) {
  const cache = new Map();
  let commentRead, roundRead, prRead, updateRounds, attestationRead;
  const readComments = () => commentRead ||= loadComments ? Promise.resolve().then(loadComments)
    : comments !== null ? Promise.resolve(comments)
    : readHammerProvenanceComments(page => get(
      `repos/${repo}/issues/${prNumber}/comments?per_page=100${page === 1 ? '' : `&page=${page}`}`));
  const laneCommitMatches = async (commit, trailers, publications, diagnostics) => {
    const { sha } = commit;
    const jobId = trailers['worker-job-id'];
    const worker = publications?.get(`${sha}:${jobId}`);
    const workerClass = worker?.workerClass || worker?.model;
    const matchedRemediation = Object.hasOwn(REMEDIATION_WORKER_IDENTITY_DEFAULTS, workerClass)
      && remediationWorkerTrailerClass(workerClass) === trailers['worker-class']
      && parseCommitTrailerValues(commit.commit.message)['worker-job-id']?.length === 1;
    if (matchedRemediation && !worker.dispatchId && !worker.requiresProducedAttestation
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
    if (!matchedRemediation && !updateRound) return false;
    const isPrUpdate = !matchedRemediation;
    if (isPrUpdate && !updateRound.launchRequestId) {
      diagnostics.push(`lane publication ${sha}: missing PR-update round launchRequestId`);
      return false;
    }
    const identity = await resolveDaemonWorkerIdentityFromHeadAttestation({
      rootDir, repo, prNumber, currentHeadSha: sha, requireExactSubject: true,
      readHeadAttestationChainForPrImpl: async args => {
        attestationRead ??= Promise.resolve().then(() => readHeadAttestations({ ...args, useDeployVerifier: true }));
        const rows = await attestationRead;
        return isPrUpdate ? rows.filter(row => row?.payload?.source === 'hq_branch_push') : rows;
      },
    });
    if (!identity.ok) {
      diagnostics.push(`lane publication ${sha}: ${identity.reason}${identity.transient ? ' (transient)' : ''}`);
      return false;
    }
    const matched = isPrUpdate ? identity.launchRequestId === updateRound.launchRequestId
      : worker.launchRequestId === identity.launchRequestId && workerClass === identity.workerClass;
    if (!matched) diagnostics.push(`lane publication ${sha}: launch or worker identity mismatch`);
    return matched;
  };
  const proveRebase = async (reviewedHead, currentHead, { rebaseOnly, limits, diagnostics }) => {
    const provenance = await readComments().catch(() => null);
    if (hammerProvenanceCommentsCapped(provenance, repo, prNumber)) limits.push(HAMMER_COMMENTS_CAPPED);
    if (hammerAttestationChain(provenance, reviewedHead, currentHead)) return 'closer-rebase-provenance';
    roundRead ??= readCompletedRemediationEvidence(rootDir, repo, prNumber);
    const { rounds, settledRounds, finalPublications, lanePublications, limitReached } = await roundRead;
    if (limitReached) limits.push(`completed-round proof scan hit the ${limitReached} limit`);
    if (hammerAttestationChain(provenance, reviewedHead, currentHead, settledRounds)) return 'closer-rebase-provenance';
    // The local final publication admits its source review as evidence. It
    // confers no head-match or disposition waiver in rebaseCurrencyCovers.
    if (!rebaseOnly && finalPublications.some(entry => entry.reviewedHead === reviewedHead && entry.head === currentHead)) {
      return 'comment-only-final-remediation-publication';
    }
    try {
      prRead ||= pr ? Promise.resolve(pr) : get(`repos/${repo}/pulls/${prNumber}`);
      const live = await prRead;
      if (live?.head?.sha === currentHead && SHA.test(live?.base?.sha || '')) {
        // Lane changes keep findings applicable for fresh adjudication at the
        // live head. They carry neither a prior withdrawal nor a head waiver.
        const laneCommit = rebaseOnly || !rootDir ? null
          : (commit, trailers) => laneCommitMatches(commit, trailers, lanePublications, diagnostics);
        const proof = await patchCurrency({ reviewedHead, currentHead, base: live.base.sha, git, get, repo, laneCommit });
        if (proof) return proof;
      }
    } catch (error) {
      diagnostics.push(error.message);
    }
    // Native rounds can keep findings and superseding reviews in scope.
    // A round awaiting review carries no head-match or disposition waiver.
    return !rebaseOnly && hammerAttestationChain(provenance, reviewedHead, currentHead, rounds)
      ? 'completed-remediation-hammer-finding-currency' : null;
  };
  return (reviewedHead, currentHead, { rebaseOnly = false } = {}) => {
    const key = JSON.stringify([reviewedHead, currentHead, rebaseOnly]);
    if (!cache.has(key)) cache.set(key, (async () => {
      const result = { reviewedHead, currentHead, current: false };
      if (!SHA.test(reviewedHead || '') || !SHA.test(currentHead || '')) return { ...result, missingProof: 'invalid reviewed or current head' };
      if (reviewedHead === currentHead) return { ...result, current: true, proof: 'exact-head' };
      const localReplay = rebaseOnly ? '' : ' or a recorded local final-remediation replay'
        + ' or a patch-equivalent prefix with a launch-attributed lane suffix';
      const missingProof = `HAM base/head provenance or patch-equivalent PR commits${localReplay} for ${reviewedHead} -> ${currentHead}`;
      const limits = [], diagnostics = [];
      let status;
      try {
        try { status = (await get(`repos/${repo}/compare/${reviewedHead}...${currentHead}`))?.status; }
        catch { /* A durable exact-endpoint edge can independently prove currency. */ }
        if (!rebaseOnly && ['ahead', 'identical'].includes(status)) return { ...result, current: true, proof: 'ancestry' };
        // A branch reset cannot borrow evidence from its discarded descendant.
        if (status === 'behind') return { ...result, missingProof: 'current head predates reviewed evidence' };
        const proof = await proveRebase(reviewedHead, currentHead, { rebaseOnly, limits, diagnostics });
        if (proof) return { ...result, current: true, proof };
      } catch (error) {
        diagnostics.push(error.message);
      }
      return { ...result, missingProof: [missingProof, ...limits, ...diagnostics].join(': '),
        ...(limits.length ? { proofLimit: limits.join(', ') } : {}) };
    })());
    return cache.get(key);
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
