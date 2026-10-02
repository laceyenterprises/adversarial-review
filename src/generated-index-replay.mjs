// PMSC-14: a versioned exception to whole-commit replay, never an endpoint diff.
// Policy authority: agent-os scripts/check-generated-index-pr-diff.py. Pin its
// blob so a changed/unknown policy cannot silently widen closer authority.
const POLICY_BLOB = '462196ad56aa0506c671411b41746d24fe765815';
const INDEX = 'docs/INDEX.md';
const LIMIT = 256;

export async function proveGeneratedIndexReplay({ repo, baseBranch, base, head, reviewedHead, git, workerOwns }) {
  if (repo !== 'laceyenterprises/agent-os' || baseBranch !== 'main') return null;
  if ((await git(['rev-parse', `${base}:scripts/check-generated-index-pr-diff.py`])).trim() !== POLICY_BLOB) return null;
  for (const path of ['scripts/check-generated-index-pr-diff.py', '.gitattributes']) {
    const baseEntry = (await git(['ls-tree', base, '--', path])).trim();
    if (!/^100(?:644|755) blob /u.test(baseEntry) ||
        (await git(['ls-tree', head, '--', path])).trim() !== baseEntry) return null;
  }
  if (!(await git(['show', `${base}:.gitattributes`])).split(/\r?\n/u).includes(`${INDEX} merge=agentos-docs-index`)) return null;
  // A delayed native recovery may observe unrelated main movement after the
  // worker's original mandatory rebase. Anchor its actual replay base, but only
  // accept newer authoritative main when its index/governance bytes still match
  // and no intervening trunk path overlaps any reviewed or pushed patch.
  const rebaseBase = (await git(['merge-base', base, head])).trim();
  const fork = (await git(['merge-base', rebaseBase, reviewedHead])).trim();
  const list = async (tip, bottom) => {
    const entries = (await git(['rev-list', '--reverse', '--topo-order', `--max-count=${LIMIT + 1}`, tip, `^${bottom}`])).trim().split(/\s+/u).filter(Boolean);
    if (entries.length > LIMIT) throw new Error('generated-index-replay-commit-limit');
    for (const sha of entries) {
      if ((await git(['rev-list', '--parents', '-n', '1', sha])).trim().split(/\s+/u).length !== 2) {
        throw new Error('generated-index-replay-nonlinear-history');
      }
    }
    return entries;
  };
  const indexEntry = async (sha) => {
    const entry = (await git(['ls-tree', sha, '--', INDEX])).trim();
    if (!/^100644 blob [0-9a-f]{40}\tdocs\/INDEX\.md$/u.test(entry)) throw new Error('generated-index-not-regular-file');
    return entry;
  };
  const authoritativeIndex = await indexEntry(base);
  if (await indexEntry(head) !== authoritativeIndex) return null;
  // --no-renames prevents a rename crossing the excluded path from hiding the
  // other half. Full blob IDs + binary patches preserve bytes, modes and paths;
  // exact patch comparison is deliberately stricter than whitespace-free IDs.
  const patch = (sha) => git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index',
    `${sha}^`, sha, '--', '.', `:(top,exclude,literal)${INDEX}`]);
  const reviewed = [];
  const reviewedSeries = await list(reviewedHead, fork);
  const pushedSeries = await list(head, rebaseBase);
  if (rebaseBase !== base) {
    const changes = (args) => git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z',
      ...args, '--', '.', `:(top,exclude,literal)${INDEX}`]);
    const trunkPaths = (await changes([rebaseBase, base])).split('\0').filter(Boolean);
    const touched = new Set();
    for (const sha of [...reviewedSeries, ...pushedSeries]) {
      for (const path of (await changes([`${sha}^`, sha])).split('\0').filter(Boolean)) touched.add(path);
    }
    if (trunkPaths.some((path) => [...touched].some((other) => path === other ||
        path.startsWith(`${other}/`) || other.startsWith(`${path}/`)))) return null;
    for (const path of ['scripts/check-generated-index-pr-diff.py', '.gitattributes', INDEX]) {
      if ((await git(['ls-tree', rebaseBase, '--', path])).trim() !==
          (await git(['ls-tree', base, '--', path])).trim()) return null;
    }
  }
  for (const sha of reviewedSeries) {
    await indexEntry(sha);
    const diff = await patch(sha);
    if (diff) reviewed.push({ sha, diff });
  }
  if (!reviewed.length) return null;
  let replayed = 0;
  let workers = 0;
  for (const sha of pushedSeries) {
    // This policy only supports dropping index hunks, not substituting any new
    // index payload (even one later cancelled by another commit).
    if (await indexEntry(sha) !== authoritativeIndex) return null;
    const diff = await patch(sha);
    if (replayed < reviewed.length && diff === reviewed[replayed].diff) replayed += 1;
    else if (replayed === reviewed.length && await workerOwns(sha)) workers += 1;
    else return null;
  }
  if (replayed !== reviewed.length || !workers) return null;
  return { generatedIndexPolicy: 'agent-os-main-index-v1', authoritativeBase: base, rebaseBase,
    authoritativeIndexBlob: authoritativeIndex.split(/\s+/u)[2],
    reviewedCommitsReplayed: replayed, workerCommits: workers };
}
