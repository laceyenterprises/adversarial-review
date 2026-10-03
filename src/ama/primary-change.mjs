// HAMINTENT-01: trusted GitHub history, never the hammer's claimed intent.
const SHA = /^[0-9a-f]{40}$/i;
const isHammer = (commit) => /^Worker-Class:\s*hammer\s*$/im.test(commit?.commit?.message || '')
  || /^(?:the-hammer|hammer)(?:-|\[bot\]|$)/i.test(commit?.author?.login || '')
  || /^(?:the-hammer|hammer)(?:-|\[bot\]|$)/i.test(commit?.committer?.login || '');

// Compare changed regions in merge-base coordinates, rather than requiring the
// author's added text to survive verbatim. Repairs may replace that text; a
// region which disappears from the final diff has returned to the base.
function changes(files, paths = null) {
  if (!Array.isArray(files) || files.length >= 300) throw new Error('missing or capped file list');
  const result = new Map();
  for (const file of files) {
    const path = file.previous_filename || file.filename;
    if (paths && !paths.has(path) && !paths.has(file.filename)) continue;
    if (!file.filename || typeof file.patch !== 'string') {
      // GitHub omits the patch for a content-preserving rename.
      if (file.status !== 'renamed' || file.additions !== 0 || file.deletions !== 0) {
        throw new Error('unsupported or missing patch');
      }
    }
    const regions = [];
    const removed = new Map();
    let additions = 0;
    let deletions = 0;
    let oldLine = null;
    let region = null;
    for (const line of (file.patch || '').split('\n')) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        // A zero-context insertion names the preceding base line.
        if (hunk[2] === '0' && oldLine > 0) oldLine += 1;
        region = null;
        continue;
      }
      if (line.startsWith('+') || line.startsWith('-')) {
        if (oldLine === null) throw new Error('missing hunk header');
        if (!region) { region = { start: oldLine, end: oldLine }; regions.push(region); }
        if (line.startsWith('+')) additions += 1;
        else {
          const normalized = line.slice(1).trim().replace(/\s+/g, ' ');
          removed.set(normalized, (removed.get(normalized) || 0) + 1);
          deletions += 1;
          oldLine += 1;
          region.end = oldLine;
        }
      } else if (line.startsWith(' ')) { oldLine += 1; region = null; }
    }
    if (additions !== file.additions || deletions !== file.deletions) throw new Error('truncated patch');
    result.set(path, { filename: file.filename, renamed: file.status === 'renamed', regions, removed });
  }
  return result;
}

export function checkPrimaryChange(evidence, headSha) {
  if (!evidence || evidence.headSha !== headSha) return { ok: false, reason: 'primary-change-unknown' };
  if (evidence.readFailed === true) return { ok: false, reason: 'primary-change-read-failed' };
  if (evidence.hasHammerCommits === false) return { ok: true, applicable: false };
  try {
    if (evidence.hasHammerCommits !== true || !SHA.test(evidence.primaryHead || '')
      || !SHA.test(evidence.mergeBase || '')) throw new Error('unknown primary change');
    const primary = changes(evidence.primaryFiles);
    const final = changes(evidence.finalFiles, new Set(primary.keys()));
    if (![...primary.values()].some(({ regions, renamed }) => regions.length > 0 || renamed)) {
      throw new Error('empty primary change');
    }
    for (const [path, change] of primary) {
      const actual = final.get(path);
      if (!actual || (change.renamed && actual.filename === path)) {
        return { ok: false, reason: 'primary-change-reverted', path };
      }
      for (const [line, count] of change.removed) {
        if ((actual.removed.get(line) || 0) < count) return { ok: false, reason: 'primary-change-reverted', path };
      }
      for (const region of change.regions) {
        if (!actual.regions.some((other) => region.start === region.end
          ? other.start <= region.start && other.end >= region.start
          : other.start < region.end && other.end > region.start)) {
          return { ok: false, reason: 'primary-change-reverted', path };
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
    // The actual first hammer parent includes every author commit, including
    // rebased author commits. A hammer-authored trailer cannot narrow it.
    const primaryHead = first.parents[0].sha;
    const primary = await get(`repos/${repo}/compare/${pr.base.sha}...${primaryHead}`);
    const mergeBase = primary.merge_base_commit?.sha;
    if (!SHA.test(mergeBase || '')) return unknown;
    const final = await get(`repos/${repo}/compare/${pr.base.sha}...${headSha}`);
    if (final.merge_base_commit?.sha !== mergeBase) return unknown;
    return { headSha, hasHammerCommits: true, primaryHead, mergeBase,
      primaryFiles: primary.files, finalFiles: final.files };
  } catch { return { ...unknown, readFailed: true }; }
}
