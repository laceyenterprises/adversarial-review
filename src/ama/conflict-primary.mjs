import { parseCommitTrailers } from './ham-provenance.mjs';

const sha = value => /^[a-f0-9]{40}$/.test(value || '');
const hammer = message => {
  const trailers = parseCommitTrailers(message);
  return /^hammer(?:-corp|-claude)?$/i.test(trailers['worker-class'] || '')
    || trailers['closed-by'] === 'hammer (adversarial-pipe-mode)';
};

// HAMEMPTYPRIMARY-01: conflict-only replay must retain the author boundary.
// The caller supplies the dispatch head and the fetched branch head separately;
// a commit trailer is never an anchor. This proof grants no merge authority.
// INCONCLUSIVERETRY-01b: `onRefusal` learns whether a refusal shows a real
// primary-line conflict (`conflict`) or only missing evidence (`unavailable`).
export async function proveConflictPrimary({ reviewedHead, sourceHead, head, base, git, onRefusal = () => {} }) {
  const refuse = kind => { onRefusal(kind); return null; };
  if (![reviewedHead, sourceHead, head, base].every(sha) || sourceHead !== reviewedHead) return refuse('unavailable');
  const fork = (await git(['merge-base', reviewedHead, base])).trim();
  if (!sha(fork)) return refuse('unavailable');
  const series = async (bottom, tip) => {
    const rows = (await git(['rev-list', '--parents', '--reverse', '--topo-order', '--max-count=257', `${bottom}..${tip}`]))
      .trim().split('\n').filter(Boolean).map(row => row.split(/\s+/));
    if (!rows.length || rows.length > 256) return null;
    let parent = bottom;
    for (const row of rows) {
      if (row.length !== 2 || !row.every(sha) || row[1] !== parent) return null;
      parent = row[0];
    }
    return rows.map(([commit]) => commit);
  };
  const reviewedCommits = await series(fork, reviewedHead), replayedCommits = await series(base, head);
  if (!reviewedCommits || !replayedCommits || reviewedCommits.length !== replayedCommits.length) return refuse('conflict');
  const metadata = async (bottom, tip) => {
    const fields = (await git(['log', '--no-decorate', '--no-notes', '--no-show-signature',
      '--format=%H%x00%an%x00%ae%x00%B', '-z', `${bottom}..${tip}`])).split('\0');
    if (fields.pop() !== '' || fields.length % 4 !== 0) throw new Error('malformed conflict metadata');
    const commits = new Map();
    for (let i = 0; i < fields.length; i += 4) {
      commits.set(fields[i], fields.slice(i + 1, i + 4).join('\0'));
    }
    return commits;
  };
  const reviewedMetadata = await metadata(fork, reviewedHead);
  const replayedMetadata = await metadata(base, head);
  const patch = async ref => {
    const text = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--full-index',
      '--unified=0', `${ref}^`, ref, '--']);
    // Only text patches: no missing/opaque/binary evidence. Preserve ordered
    // added/removed bytes, paths and mode headers, ignoring base context and
    // absolute hunk coordinates only. No patch-id/whitespace normalization.
    if (!text || /^(?:Binary files |GIT binary patch)/m.test(text) || !/^@@ /m.test(text)) return null;
    return text.split('\n').filter(line => !/^index [a-f0-9]+\.\.[a-f0-9]+(?: \d+)?$/.test(line))
      .map(line => line.replace(/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@.*$/, '@@ -$1 +$2 @@')).join('\n');
  };
  for (let i = 0; i < reviewedCommits.length; i++) {
    const original = reviewedCommits[i], replay = replayedCommits[i];
    // Rebase preserves author identity and message. In particular, do not
    // turn a reviewed author commit into the first HAM commit on main.
    const before = reviewedMetadata.get(original);
    if (!before || before !== replayedMetadata.get(replay)) return refuse('conflict');
    if (i === 0 && hammer(before.split('\0').slice(2).join('\0'))) return refuse('conflict');
    const originalPatch = await patch(original);
    if (!originalPatch || originalPatch !== await patch(replay)) return refuse('conflict');
  }
  return { proof: 'conflict-primary-preserved', reviewedHead, sourceHead, head, base, fork, reviewedCommits, replayedCommits };
}
