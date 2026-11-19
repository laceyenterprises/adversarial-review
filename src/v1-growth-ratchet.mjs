// V1RATCHET-01: the V1 growth ratchet in the reviewer simplicity check.
// Audited, not gated (11-11 review §10.1-10.2, 11-18 audit §8 item 7): it
// reports net non-test lines per V1 subsystem and, when a fix grows a
// pack-owned subsystem, asks the simplicity advisory for the matching deletion.
// Subsystem paths and owners are tunables in `domains/code-pr.json`.
import { parseDiffFiles } from './reviewer-util.mjs';

const TEST_PATH = /(^|\/)(tests?|__tests__|fixtures)\/|\.test\.|(^|\/)test_[^/]*$|_test\.[^/.]+$/;

function countLines(patch) {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of String(patch).split('\n')) {
    if (line.startsWith('@@')) inHunk = true;
    else if (line.startsWith('diff --git ')) inHunk = false;
    else if (inHunk && line.startsWith('+')) added += 1;
    else if (inHunk && line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

export function measureV1Growth(diff, repo, ratchet) {
  const subsystems = (ratchet?.subsystems || []).filter((entry) => entry?.repo === repo);
  if (subsystems.length === 0) return [];
  const totals = new Map();
  for (const file of parseDiffFiles(diff)) {
    if (!file.path || TEST_PATH.test(file.path)) continue;
    const owner = subsystems.find((entry) => (entry.paths || []).some((prefix) => file.path.startsWith(prefix)));
    if (!owner) continue;
    const row = totals.get(owner.id) || { id: owner.id, pack: owner.pack || null, added: 0, removed: 0 };
    const { added, removed } = countLines(file.patch);
    row.added += added;
    row.removed += removed;
    totals.set(owner.id, row);
  }
  return [...totals.values()].map((row) => ({ ...row, net: row.added - row.removed }));
}

export function isFixTitle(title) {
  return /\((?:fix|bugfix|hotfix)\)|^\s*(?:fix|hotfix)\b/i.test(String(title || ''));
}

export function formatV1GrowthContext({ diff, repo, title, ratchet }) {
  const rows = measureV1Growth(diff, repo, ratchet);
  if (rows.length === 0) return '';
  const signed = (value) => (value > 0 ? `+${value}` : String(value));
  const lines = rows.map((row) => `- \`${row.id}\`${row.pack ? ` (owned by pack ${row.pack})` : ' (no owning pack)'}: +${row.added}/-${row.removed}, net ${signed(row.net)}`);
  const grown = rows.filter((row) => row.pack && row.net > 0);
  const ask = isFixTitle(title) && grown.length > 0
    ? `\n\nThis fix grows a pack-owned V1 subsystem (${grown.map((row) => `${row.id} ${signed(row.net)} for ${row.pack}`).join('; ')}). Write the optional \`## Simplicity and cost (advisory)\` section and ask for the matching deletion: name existing code in that subsystem this fix could delete or replace so its net is zero or below, or say the fix belongs in a ${[...new Set(grown.map((row) => row.pack))].join('/')} ticket. This is advice only: never a finding and never a verdict change.`
    : '';
  return `\n\n## V1 growth (audited, not gated)\nNet non-test lines this diff adds to frozen V1 subsystems:\n${lines.join('\n')}${ask}`;
}
