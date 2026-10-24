// Strict queue derivation. patch-id normalizes whitespace and treats order as a
// multiset in rebase-authority; neither is publication evidence for this port.
import { proveReviewedRebase } from '../ama/reviewed-rebase.mjs';
import { createHash } from 'node:crypto';

export const QUEUE_REBASE_PROOF = 'queue-ordered-binary-v1';
export const isQueueSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export async function proveQueueRebase({ oldHead, candidate, exactBase, git }) {
  try {
    if (![oldHead, candidate, exactBase].every(isQueueSha)) return null;
    const bases = (await git(['merge-base', '--all', oldHead, exactBase])).trim().split('\n');
    if (bases.length !== 1 || !isQueueSha(bases[0])) return null;
    const fork = bases[0];
    const list = async (bottom, tip) => {
      const lines = (await git(['rev-list', '--parents', '--reverse', '--topo-order', '--max-count=257', `${bottom}..${tip}`])).trim().split('\n').filter(Boolean);
      if (!lines.length || lines.length > 256) throw new Error('unsupported-series');
      let parent = bottom;
      const commits = [];
      for (const line of lines) {
        const [sha, p, extra] = line.split(' ');
        if (!isQueueSha(sha) || p !== parent || extra) throw new Error('unsupported-topology');
        // Empty commits cannot silently disappear or be manufactured by rebase.
        const patch = await strictGit(['diff', `${sha}^`, sha]);
        if (!patch.length) throw new Error('empty-commit');
        const raw = await git(['cat-file', 'commit', sha]);
        commits.push({ sha, raw }); parent = sha;
      }
      return commits;
    };
    // Pin diff presentation and submodule handling instead of inheriting user
    // config. --binary is lossless; no textconv, rename heuristic or exclusion.
    const strictGit = args => args[0] === 'diff' ? git(['diff', '--no-color', '--no-ext-diff', '--no-textconv',
      '--no-renames', '--binary', '--full-index', '--ignore-submodules=none', '--no-relative',
      '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', '--diff-algorithm=myers', ...args.slice(1), '--', ':(top)']) : git(args);
    const original = await list(fork, oldHead);
    if (oldHead === candidate) {
      if (fork !== exactBase) return null;
      return { kind: QUEUE_REBASE_PROOF, noop: true, oldHead, candidate, exactBase, fork, sourceCommits: original,
        digest: digest(original) };
    }
    if ((await git(['merge-base', '--all', candidate, exactBase])).trim() !== exactBase) return null;
    const replay = await list(exactBase, candidate);
    // Author/message (including trailers) survive verbatim. Commit signatures
    // remain only in the original raw commits; never attribute them to new SHAs.
    const identity = raw => [raw.match(/^author (.*)$/m)?.[1], raw.slice(raw.indexOf('\n\n') + 2)];
    if (original.length !== replay.length || original.some((c, i) => JSON.stringify(identity(c.raw)) !== JSON.stringify(identity(replay[i].raw)))) return null;
    // Reuse the existing complete ordered proof, with no generated exceptions.
    const proof = await proveReviewedRebase({ reviewedHead: oldHead, head: candidate, base: exactBase,
      git: args => args[0] === 'diff' ? strictGit(['diff', ...args.slice(1).filter(a => a !== '--' && a !== ':(top)')]) : git(args) });
    if (!proof || proof.rebaseBase !== exactBase || proof.fork !== fork) return null;
    return { kind: QUEUE_REBASE_PROOF, noop: false, oldHead, candidate, exactBase, fork,
      sourceCommits: original, replayedCommits: replay.map(c => c.sha), digest: digest(proof) };
  } catch { return null; }
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
