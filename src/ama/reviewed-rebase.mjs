// REBASEPROV-01: content proof, independent of rebased commit identities.
// Full binary patches retain whitespace, modes, paths and intermediate edits.
const LIMIT = 256;
export async function proveReviewedRebase({ reviewedHead, head, base, git, generatedFiles = [], verifyGenerated = async () => false }) {
  try {
    const fork = (await git(['merge-base', reviewedHead, base])).trim();
    const onto = (await git(['merge-base', head, base])).trim();
    if (!fork || !onto) return null;
    const list = async (tip, bottom) => {
      const shas = (await git(['rev-list', '--reverse', '--topo-order', `--max-count=${LIMIT + 1}`, `${bottom}..${tip}`])).trim().split(/\s+/).filter(Boolean);
      if (shas.length > LIMIT) throw new Error('rebase-proof-limit');
      for (const sha of shas) {
        if ((await git(['rev-list', '--parents', '-n', '1', sha])).trim().split(/\s+/).length !== 2) throw new Error('nonlinear-rebase');
      }
      return shas;
    };
    if (generatedFiles.some(path => typeof path !== 'string' || !path || path.startsWith('/')
      || path.split('/').some(part => !part || part === '.' || part === '..') || /[\0\r\n]/.test(path))) return null;
    const exclusions = generatedFiles.map(path => `:(top,exclude,literal)${path}`);
    const patch = sha => git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index',
      `${sha}^`, sha, '--', '.', ...exclusions]);
    const oldSeries = await list(reviewedHead, fork);
    const newSeries = await list(head, onto);
    if (!oldSeries.length || !newSeries.length) return null;
    const reviewed = [];
    for (const sha of oldSeries) { const diff = await patch(sha); if (diff) reviewed.push(diff); }
    const replayed = [];
    for (const sha of newSeries) {
      const diff = await patch(sha);
      if (diff) replayed.push(diff);
      if (generatedFiles.length) {
        // Base outputs are already authoritative. Any rewritten output must be
        // regenerated from this commit's merged sources, including intermediate commits.
        const changed = (await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z',
          onto, sha, '--', ...generatedFiles.map(path => `:(top,literal)${path}`)])).split('\0').filter(Boolean);
        if (changed.length && !await verifyGenerated(sha, changed)) return null;
      }
    }
    if (!reviewed.length || reviewed.length !== replayed.length || reviewed.some((diff, i) => diff !== replayed[i])) return null;
    return { proof: 'reviewed-rebase-patch-equivalence', reviewedHead, rebasedHead: head,
      fork, rebaseBase: onto, reviewedCommits: oldSeries, replayedCommits: newSeries, generatedFiles };
  } catch { return null; }
}
