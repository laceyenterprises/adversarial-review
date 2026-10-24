// An asynchronous update-branch acknowledgement can still contain the old SHA.
// Bind a later candidate to the CAS input and the base captured BEFORE issuing
// that mutation. Replay every commit's full tree, including modes/binary files,
// without changing refs, the index or the checkout. This grants no CI authority.
export async function proveRebaseResult({ oldHead, head, base, git }) {
  if (![oldHead, head, base].every(sha => /^[a-f0-9]{40}$/.test(sha || '')) || head === oldHead) return null;
  try {
    const fork = (await git(['merge-base', oldHead, base])).trim();
    const series = async (bottom, tip) => {
      const rows = (await git(['rev-list', '--parents', '--reverse', '--topo-order', '--max-count=257', `${bottom}..${tip}`]))
        .trim().split(/\r?\n/).filter(Boolean).map(row => row.split(/\s+/));
      if (!rows.length || rows.length > 256) throw new Error('rebase-result-limit');
      let parent = bottom;
      for (const row of rows) {
        if (row.length !== 2 || row[1] !== parent) throw new Error('nonlinear-rebase-result');
        parent = row[0];
      }
      return rows;
    };
    const oldSeries = await series(fork, oldHead), newSeries = await series(base, head);
    if (oldSeries.length !== newSeries.length) return null;
    for (let i = 0; i < oldSeries.length; i++) {
      const [oldCommit, oldParent] = oldSeries[i], [newCommit, newParent] = newSeries[i];
      // A conflict exits nonzero; never attest an operator/author resolution as
      // the result of our clean server-side mutation.
      const tree = (await git(['merge-tree', '--write-tree', `--merge-base=${oldParent}`, newParent, oldCommit])).trim();
      if (tree !== (await git(['rev-parse', `${newCommit}^{tree}`])).trim()) return null;
    }
    return { proof: 'exact-rebase-tree-replay', oldHead, head, base, commits: newSeries.map(([sha]) => sha) };
  } catch { return null; }
}
