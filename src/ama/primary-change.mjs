// HAMINTENT-01: trusted GitHub history, never the hammer's claimed intent.
const SHA = /^[0-9a-f]{40}$/i;
const isHammer = (commit) => /^Worker-Class:\s*hammer\s*$/im.test(commit?.commit?.message || '')
  || /^(?:the-hammer|hammer)(?:-|\[bot\]|$)/i.test(commit?.author?.login || '')
  || /^(?:the-hammer|hammer)(?:-|\[bot\]|$)/i.test(commit?.committer?.login || '');

function lineSets(files, paths = null) {
  if (!Array.isArray(files) || files.length >= 300) throw new Error('missing or capped file list');
  const result = new Map();
  for (const file of files) {
    if (paths && !paths.has(file.filename)) continue;
    if (!file.filename || typeof file.patch !== 'string' || file.status === 'renamed') {
      throw new Error('unsupported or missing patch');
    }
    const added = new Set();
    const removed = new Set();
    let additions = 0;
    let deletions = 0;
    for (const line of file.patch.split('\n')) {
      if (line.startsWith('+')) { added.add(line.slice(1)); additions += 1; }
      if (line.startsWith('-')) { removed.add(line.slice(1)); deletions += 1; }
    }
    if (additions !== file.additions || deletions !== file.deletions) throw new Error('truncated patch');
    result.set(file.filename, { added, removed });
  }
  return result;
}

export function checkPrimaryChange(evidence, headSha) {
  if (!evidence || evidence.headSha !== headSha) return { ok: false, reason: 'primary-change-unknown' };
  if (evidence.hasHammerCommits === false) return { ok: true, applicable: false };
  try {
    if (evidence.hasHammerCommits !== true || !SHA.test(evidence.primaryHead || '')
      || !SHA.test(evidence.mergeBase || '')) throw new Error('unknown primary change');
    const primary = lineSets(evidence.primaryFiles);
    const final = lineSets(evidence.finalFiles, new Set(primary.keys()));
    if (![...primary.values()].some(({ added, removed }) => added.size + removed.size > 0)) {
      throw new Error('empty primary change');
    }
    for (const [path, lines] of primary) {
      const actual = final.get(path);
      for (const kind of ['added', 'removed']) {
        for (const line of lines[kind]) {
          if (!actual?.[kind].has(line)) return { ok: false, reason: 'primary-change-reverted', path };
        }
      }
    }
    return { ok: true, applicable: true };
  } catch {
    return { ok: false, reason: 'primary-change-unknown' };
  }
}

// get is an injected bounded JSON API reader. Compare caps are errors, not empty diffs.
export async function fetchPrimaryChange({ repo, prNumber, headSha, get }) {
  const unknown = { headSha, hasHammerCommits: null };
  try {
    if (!SHA.test(headSha || '')) return unknown;
    const pr = await get(`repos/${repo}/pulls/${prNumber}`);
    if (pr.head?.sha !== headSha || !SHA.test(pr.base?.sha || '')) return unknown;
    const history = await get(`repos/${repo}/compare/${pr.base.sha}...${headSha}`);
    if (!Array.isArray(history.commits) || history.commits.length !== history.total_commits
      || history.commits.length >= 250
      || history.commits.some((commit) => !SHA.test(commit?.sha || '')
        || typeof commit?.commit?.message !== 'string')) return unknown;
    const first = history.commits.find(isHammer);
    if (!first) return { headSha, hasHammerCommits: false };
    if (first.parents?.length !== 1 || !SHA.test(first.parents[0].sha)) return unknown;
    // A mandatory rebase can rewrite the author parent. The first hammer's
    // Reviewed-Head retains the pre-hammer author SHA across that rewrite.
    const reviewedHead = /^Reviewed-Head:[ \t]*([0-9a-f]{40})[ \t]*$/im.exec(first.commit?.message || '')?.[1];
    const primaryHead = reviewedHead || first.parents[0].sha;
    if (reviewedHead) {
      const original = await get(`repos/${repo}/commits/${primaryHead}`);
      if (original.sha !== primaryHead || isHammer(original)) return unknown;
    }
    const primary = await get(`repos/${repo}/compare/${pr.base.sha}...${primaryHead}`);
    const mergeBase = primary.merge_base_commit?.sha;
    if (!SHA.test(mergeBase || '')) return unknown;
    const final = await get(`repos/${repo}/compare/${mergeBase}...${headSha}`);
    if (final.merge_base_commit?.sha !== mergeBase) return unknown;
    return { headSha, hasHammerCommits: true, primaryHead, mergeBase,
      primaryFiles: primary.files, finalFiles: final.files };
  } catch { return unknown; }
}
