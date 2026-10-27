import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { execFile } from 'node:child_process';
import { hammerAttestationChain } from './hammer-head-validation.mjs';
import { hamCommitIdentityMatches, isHamWorkerTicket, parseCommitTrailers } from './ham-provenance.mjs';

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
// Extra commits must independently carry HAM identity and reviewed-head
// provenance from GitHub; a local trailer or a fleet push actor is insufficient.
async function patchEquivalent({ reviewedHead, currentHead, base, git, get, repo }) {
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
  for (const sha of newSeries.commits) {
    const id = await patch(sha);
    if (index < oldIds.length && id === oldIds[index]) { index++; continue; }
    const commit = await get(`repos/${repo}/commits/${sha}`);
    const trailers = parseCommitTrailers(commit?.commit?.message);
    if (commit?.sha !== sha || !hamCommitIdentityMatches(commit)
      || !/^hammer(?:-corp|-claude)?$/i.test(trailers['worker-class'] || '')
      || !isHamWorkerTicket(trailers['worker-ticket']) || trailers['reviewed-head'] !== reviewedHead
      || trailers['closed-by'] !== 'hammer (adversarial-pipe-mode)') return false;
  }
  return index === oldIds.length;
}

// One evaluation-local reader for finding admission AND disposition admission.
// Only an exact current endpoint is covered; a later unrelated push cannot
// inherit a prior HAM audit edge. Cache reads only within this live evaluation.
export function createReviewCurrencyReader({ repo, prNumber, get, comments = null, cwd,
  git = (args, input) => currencyGit(args, input, { cwd }), pr = null }) {
  const cache = new Map();
  let commentRead, prRead;
  const readComments = () => commentRead ||= comments !== null ? Promise.resolve(comments)
    : Promise.resolve(get(`repos/${repo}/issues/${prNumber}/comments?per_page=100`)).then(rows => {
      if (!Array.isArray(rows) || rows.length >= 100) throw new Error('missing or capped HAM provenance comments');
      return rows;
    });
  const proveRebase = async (reviewedHead, currentHead) => {
    try {
      if (hammerAttestationChain(await readComments(), reviewedHead, currentHead)) return 'closer-rebase-provenance';
    } catch { /* Independent patch proof may still succeed. */ }
    prRead ||= pr ? Promise.resolve(pr) : get(`repos/${repo}/pulls/${prNumber}`);
    const live = await prRead;
    if (live?.head?.sha !== currentHead || !SHA.test(live?.base?.sha || '')) return null;
    return await patchEquivalent({ reviewedHead, currentHead, base: live.base.sha, git, get, repo })
      ? 'reviewed-rebase-patch-id' : null;
  };
  return (reviewedHead, currentHead, { rebaseOnly = false } = {}) => {
    const key = JSON.stringify([reviewedHead, currentHead, rebaseOnly]);
    if (!cache.has(key)) cache.set(key, (async () => {
      const result = { reviewedHead, currentHead, current: false };
      if (!SHA.test(reviewedHead || '') || !SHA.test(currentHead || '')) return { ...result, missingProof: 'invalid reviewed or current head' };
      if (reviewedHead === currentHead) return { ...result, current: true, proof: 'exact-head' };
      let status;
      try {
        try { status = (await get(`repos/${repo}/compare/${reviewedHead}...${currentHead}`))?.status; }
        catch { /* A durable exact-endpoint edge can independently prove currency. */ }
        if (!rebaseOnly && ['ahead', 'identical'].includes(status)) return { ...result, current: true, proof: 'ancestry' };
        // A branch reset cannot borrow evidence from its discarded descendant.
        if (status === 'behind') return { ...result, missingProof: 'current head predates reviewed evidence' };
        const proof = await proveRebase(reviewedHead, currentHead);
        if (proof) return { ...result, current: true, proof };
      } catch (error) {
        return { ...result, missingProof: `HAM base/head provenance or patch-equivalent PR commits for ${reviewedHead} -> ${currentHead}: ${error.message}` };
      }
      return { ...result, missingProof: `HAM base/head provenance or patch-equivalent PR commits for ${reviewedHead} -> ${currentHead}` };
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
