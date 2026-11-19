// V1RATCHET-01: the V1 growth ratchet in the reviewer simplicity check.
// Audited, not gated (11-11 review §10.1-10.2, 11-18 audit §8 item 7): it
// reports net non-test lines per V1 subsystem and, when a fix grows a
// pack-owned subsystem, asks the simplicity advisory for the matching deletion.
// Subsystem paths and owners are tunables in `domains/code-pr.json`.
import { parseDiffFiles } from './reviewer-util.mjs';
import { isTestPath } from './slim-review-eligibility.mjs';
import { fetchRepoFileAtRef } from './pack-lockhash.mjs';

const FIXTURE_PATH = /(^|\/)fixtures\//;

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

export async function measureV1Growth(diff, repo, ratchet, {
  headSha,
  fetchFileAtRefImpl = fetchRepoFileAtRef,
} = {}) {
  const subsystems = (ratchet?.subsystems || []).filter((entry) => entry?.repo === repo);
  if (subsystems.length === 0) return [];
  const ownerFor = (path) => path && !isTestPath(path) && !FIXTURE_PATH.test(path)
    ? subsystems.find((entry) => (entry.paths || []).some((prefix) => path.startsWith(prefix)))
    : undefined;
  const totals = new Map();
  const accumulate = (owner, added, removed, unmeasured = false) => {
    if (!owner) return;
    const row = totals.get(owner.id) || { id: owner.id, pack: owner.pack || null, added: 0, removed: 0 };
    row.added += added;
    row.removed += removed;
    if (unmeasured) row.unmeasured = true;
    totals.set(owner.id, row);
  };
  for (const file of parseDiffFiles(diff)) {
    const oldOwner = ownerFor(file.oldPath);
    const newOwner = ownerFor(file.newPath);
    if (!oldOwner && !newOwner) continue;
    const { added, removed } = countLines(file.patch);
    const copied = /^copy from /m.test(file.patch);
    if (file.oldPath === file.newPath || (oldOwner === newOwner && !copied)) {
      accumulate(newOwner, added, removed);
      continue;
    }
    // Rename hunks omit unchanged lines. Read the immutable destination, then
    // reconstruct the source's line count from the hunk delta. Copies retain it.
    try {
      if (!/^[a-f0-9]{40}$/i.test(headSha || '')) throw new Error('missing reviewed head');
      const content = await fetchFileAtRefImpl(repo, file.newPath, headSha);
      if (typeof content !== 'string' || /[\0\ufffd]/.test(content)) throw new Error('non-text content');
      const newLines = content === '' ? 0 : content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
      const oldLines = newLines - added + removed;
      if (oldLines < 0) throw new Error('incomplete content');
      if (!copied) accumulate(oldOwner, 0, oldLines);
      accumulate(newOwner, newLines, 0);
    } catch {
      // An advisory must not call an unreadable cross-boundary move zero growth.
      if (!copied) accumulate(oldOwner, 0, 0, true);
      accumulate(newOwner, 0, 0, true);
    }
  }
  return [...totals.values()].map((row) => ({ ...row, net: row.unmeasured ? null : row.added - row.removed }));
}

export function isFixTitle(title) {
  const untagged = String(title || '').replace(/^\s*(?:\[[^\]\r\n]+\]\s*)+/, '');
  return /\((?:fix|bugfix|hotfix)\)/i.test(untagged)
    || /^\s*(?:fix|bugfix|hotfix)(?:\([^)\r\n]+\))?(?=\s|:|$)/i.test(untagged);
}

export async function formatV1GrowthContext({ diff, repo, title, ratchet, headSha, fetchFileAtRefImpl }) {
  const rows = await measureV1Growth(diff, repo, ratchet, { headSha, fetchFileAtRefImpl });
  if (rows.length === 0) return '';
  const signed = (value) => (value > 0 ? `+${value}` : String(value));
  const growth = (row) => row.unmeasured ? 'unknown (cross-boundary content unavailable)' : signed(row.net);
  const lines = rows.map((row) => `- \`${row.id}\`${row.pack ? ` (owned by pack ${row.pack})` : ' (no owning pack)'}: ${row.unmeasured ? `net ${growth(row)}` : `+${row.added}/-${row.removed}, net ${growth(row)}`}`);
  const grown = rows.filter((row) => row.pack && (row.unmeasured || row.net > 0));
  const ask = isFixTitle(title) && grown.length > 0
    ? `\n\nThis fix ${grown.some((row) => row.unmeasured) ? 'grows or may grow' : 'grows'} a pack-owned V1 subsystem (${grown.map((row) => `${row.id} ${growth(row)} for ${row.pack}`).join('; ')}). Write the optional \`## Simplicity and cost (advisory)\` section and ask for the matching deletion: name existing code in that subsystem this fix could delete or replace so its net is zero or below, or say the fix belongs in a ${[...new Set(grown.map((row) => row.pack))].join('/')} ticket. This is advice only: never a finding and never a verdict change.`
    : '';
  return `\n\n## V1 growth (audited, not gated)\nNet non-test lines this diff adds to frozen V1 subsystems:\n${lines.join('\n')}${ask}`;
}
