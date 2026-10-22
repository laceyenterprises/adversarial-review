import { findingLineRanges } from './kernel/finding-lines.mjs';
import { execFileSync } from 'node:child_process';

export function findingPath(value) {
  const path = String(value ?? '').trim().replace(/^`+|`+$/g, '');
  return path && !path.startsWith('/') && !path.split('/').includes('..') ? path : null;
}

function lineRanges(value, file) {
  const ranges = findingLineRanges(value, file);
  if (ranges.some(({ start, end }) => !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 1 || end < start)) return [];
  return ranges.map(({ start, end }) => [start, end]);
}

// Map the reviewed coordinates through each intervening diff. A preceding
// insertion shifts the range; it does not count as fixing that finding.
export function attributeFindingCommits({ findings, workspaceDir, startHead, publishedHead,
  exec = execFileSync, budgetMs = 2000, maxCommits = 128 } = {}) {
  const result = new Map(findings.map(f => [f.finding_id, { commitSha: null, reason: 'missing-history' }]));
  if (!workspaceDir || !/^[a-f0-9]{40}$/i.test(startHead || '')
    || !/^[a-f0-9]{40}$/i.test(publishedHead || '')) return result;
  const deadline = Date.now() + budgetMs;
  const git = args => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('attribution-budget');
    return exec('git', ['--no-pager', '-C', workspaceDir, ...args], {
      encoding: 'utf8', timeout: remaining, maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    });
  };
  try {
    git(['merge-base', '--is-ancestor', startHead, publishedHead]);
    // First-parent history gives each diff an unambiguous predecessor and
    // counts a merge's net changes once, rather than attributing side branches.
    const chain = String(git(['rev-list', '--first-parent', `--max-count=${maxCommits + 1}`,
      publishedHead, `^${startHead}`])).trim().split(/\s+/).filter(Boolean).reverse();
    if (chain.length > maxCommits) throw new Error('attribution-budget');
    let parent = startHead;
    const pending = findings.map(f => ({ f, file: findingPath(f.file), ranges: lineRanges(f.lines, f.file) }));
    for (const { f, file, ranges } of pending) {
      result.set(f.finding_id, { commitSha: null,
        reason: file && ranges.length ? 'no-overlapping-commit' : 'missing-location' });
    }
    for (const commit of chain) {
      // Refuse a base that is an ancestor through a side branch only.
      const actualParent = String(git(['rev-parse', `${commit}^1`])).trim();
      if (actualParent !== parent) throw new Error('nonlinear-history');
      const diffs = new Map();
      for (const item of pending) {
        const { f, file, ranges } = item;
        if (!file || !ranges.length || result.get(f.finding_id).commitSha) continue;
        if (!diffs.has(file)) diffs.set(file, String(git(['--literal-pathspecs', 'diff', '--no-ext-diff',
          '--no-textconv', '--no-color', '--no-renames', '--unified=0', parent, commit, '--', file])));
        const hunks = [...diffs.get(file).matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)]
          .map(m => ({ old: Number(m[1]), removed: Number(m[2] ?? 1), added: Number(m[4] ?? 1) }));
        // A zero-removal hunk is anchored after its old line. Include the
        // last cited line, including when the citation contains only one line.
        const overlaps = hunks.some(h => ranges.some(([a, b]) => h.removed
          ? h.old <= b && h.old + h.removed - 1 >= a
          : h.old >= a && h.old <= b));
        if (overlaps) result.set(f.finding_id, { commitSha: commit, reason: 'overlapping-diff' });
        else item.ranges = ranges.map(([a, b]) => {
          const shift = hunks.filter(h => h.removed ? h.old + h.removed - 1 < a : h.old < a)
            .reduce((n, h) => n + h.added - h.removed, 0);
          return [a + shift, b + shift];
        });
      }
      parent = commit;
    }
  } catch (error) {
    const reason = error.message === 'attribution-budget' || error.code === 'ETIMEDOUT'
      ? 'attribution-budget' : 'missing-history';
    // Partial traversals are not sufficient evidence for attribution.
    for (const f of findings) result.set(f.finding_id, { commitSha: null, reason });
  }
  return result;
}
