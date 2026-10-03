import { isTransientGhError } from '../gh-cli.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCommitTrailers } from './ham-provenance.mjs';
// HAMINTENT-01: trusted GitHub history, never the hammer's claimed intent.
const SHA = /^[0-9a-f]{40}$/i;
const isHammer = (commit) => /^hammer(?:-corp|-claude)?$/i.test(
  parseCommitTrailers(commit?.commit?.message || '')['worker-class'] || '');

// Dispatch records are daemon-owned evidence. The earliest launch protects
// untagged repairs too; a later launch must never narrow the author baseline.
export function readPrimaryChangeLaunchHead(rootDir, repo, prNumber) {
  const directory = join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-dispatches');
  let names;
  try { names = readdirSync(directory); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const prefix = `${repo.replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '-')}-pr-${Number(prNumber)}-`;
  const records = names.filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')))
    .filter((record) => record.repo === repo && Number(record.prNumber) === Number(prNumber)
      && /^hammer(?:-corp|-claude)?$/.test(record.workerClass || '') && record.dispatchedAt);
  records.sort((a, b) => String(a.dispatchedAt).localeCompare(String(b.dispatchedAt)));
  return records[0]?.targetRemediationSha || null;
}

// Test fixtures are covered by their enclosing test directory. Root fixtures
// and production files merely containing 'test' remain intent-carrying.
export function isTestPath(path) {
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(path)
    || /\.test\.(?:mjs|js)$/.test(path);
}

function evidencePaths(primary, files) {
  return new Set([...primary.keys(), ...(files || [])
    .filter((file) => isTestPath(file.filename)).map((file) => file.filename)]);
}

function testRegionsChanged(primary, final) {
  return [...new Set([...primary.keys(), ...final.keys()])]
    .filter((path) => isTestPath(path)
      && (!primary.has(path) || isTestPath(primary.get(path).filename))
      && (!final.has(path) || isTestPath(final.get(path).filename)))
    .map((path) => ({ path, primaryRegions: primary.get(path)?.regions || [],
      finalRegions: final.get(path)?.regions || [] }));
}

// Compare changed regions in merge-base coordinates, rather than requiring the
// author's added text to survive verbatim. Repairs may replace that text; a
// region which disappears from the final diff has returned to the base.
function changes(files, paths = null, aliases = new Map()) {
  if (!Array.isArray(files) || files.length >= 300) throw new Error('missing or capped file list');
  const result = new Map();
  for (const file of files) {
    const original = file.previous_filename || file.filename;
    const path = aliases.get(original) || original;
    if (paths && !paths.has(path) && !paths.has(file.filename)) continue;
    if (!file.filename) throw new Error('missing filename');
    if (typeof file.patch !== 'string') {
      // Identical trusted blobs also prove preservation when GitHub omits patches.
      if (SHA.test(file.sha || '') && ['added', 'modified', 'removed', 'renamed'].includes(file.status)) {
        result.set(path, { filename: file.filename, renamed: file.status === 'renamed',
          opaque: true, sha: file.sha, status: file.status, regions: [], removed: new Map() });
        continue;
      }
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
    result.set(path, { filename: file.filename, sha: file.sha, status: file.status,
      renamed: file.status === 'renamed', regions, removed });
  }
  return result;
}

export function checkPrimaryChange(evidence, headSha) {
  if (!evidence) return { ok: false, reason: 'primary-change-unknown' };
  if (evidence.headSha !== headSha || evidence.headMismatch) return { ok: false, reason: 'primary-change-read-failed' };
  if (evidence.readFailed === true) return { ok: false, reason: 'primary-change-read-failed' };
  if (evidence.hasHammerCommits === false) return { ok: true, applicable: false };
  try {
    if (evidence.hasHammerCommits !== true || !SHA.test(evidence.primaryHead || '')
      || !SHA.test(evidence.mergeBase || '')) throw new Error('unknown primary change');
    const primary = changes(evidence.primaryFiles);
    const aliases = new Map([...primary].map(([path, change]) => [change.filename, path]));
    const final = changes(evidence.finalFiles, evidencePaths(primary, evidence.finalFiles), aliases);
    if (![...primary.values()].some(({ regions, renamed, opaque }) => regions.length > 0 || renamed || opaque)) {
      throw new Error('empty primary change');
    }
    const testChanges = testRegionsChanged(primary, final);
    for (const [path, change] of primary) {
      const actual = final.get(path);
      if (isTestPath(path) && isTestPath(change.filename)
        && (!actual || isTestPath(actual.filename))) continue;
      if (!actual || (change.renamed && actual.filename === path)) {
        return { ok: false, reason: 'primary-change-reverted', path, testRegionsChanged: testChanges };
      }
      if (change.opaque) {
        if (actual.sha !== change.sha || actual.status !== change.status) {
          return { ok: false, reason: 'primary-change-unknown', path, testRegionsChanged: testChanges };
        }
        continue;
      }
      for (const [line, count] of change.removed) {
        if ((actual.removed.get(line) || 0) < count) return { ok: false, reason: 'primary-change-reverted', path, testRegionsChanged: testChanges };
      }
      for (const region of change.regions) {
        if (!actual.regions.some((other) => region.start === region.end
          ? other.start <= region.start && other.end >= region.start
          : other.start < region.end && other.end > region.start)) {
          return { ok: false, reason: 'primary-change-reverted', path, testRegionsChanged: testChanges };
        }
      }
    }
    return { ok: true, applicable: true, testRegionsChanged: testChanges };
  } catch {
    return { ok: false, reason: 'primary-change-unknown' };
  }
}

// get is an injected bounded JSON API reader. Compare caps are errors, not empty diffs.
export async function fetchPrimaryChange({ repo, prNumber, headSha, get, dispatchedHead = null,
  rootDir = fileURLToPath(new URL('../../', import.meta.url)) }) {
  const unknown = { headSha, hasHammerCommits: null };
  try {
    if (!SHA.test(headSha || '')) return unknown;
    const pr = await get(`repos/${repo}/pulls/${prNumber}`);
    if (pr.head?.sha !== headSha) return { ...unknown, headMismatch: true };
    if (!SHA.test(pr.base?.sha || '')) return unknown;
    const history = await get(`repos/${repo}/compare/${pr.base.sha}...${headSha}`);
    if (!Array.isArray(history.commits) || history.commits.length !== history.total_commits
      || history.commits.length >= 250
      || history.commits.some((commit) => !SHA.test(commit?.sha || '')
        || typeof commit?.commit?.message !== 'string')) return unknown;
    const first = history.commits.find(isHammer);
    dispatchedHead ||= readPrimaryChangeLaunchHead(rootDir, repo, prNumber);
    // A trusted dispatch launch SHA covers untagged CI/conflict repairs before
    // the first tagged HAM commit. Never accept this value from a HAM claim.
    if (dispatchedHead && !SHA.test(dispatchedHead)) return unknown;
    if (!first && !dispatchedHead) return { headSha, hasHammerCommits: false };
    if (first && (!first.parents?.length || first.parents.length > 2
      || !SHA.test(first.parents[0].sha))) return unknown;
    if (first && first.parents.length === 2) {
      const baseParent = await get(`repos/${repo}/compare/${first.parents[1].sha}...${pr.base.sha}`);
      if (!['ahead', 'identical'].includes(baseParent.status)) return unknown;
    }
    // The actual first hammer parent includes every author commit, including
    // rebased author commits. A hammer-authored trailer cannot narrow it.
    let primaryHead = dispatchedHead || first.parents[0].sha;
    if (dispatchedHead) {
      const ancestry = await get(`repos/${repo}/compare/${dispatchedHead}...${headSha}`);
      if (!['ahead', 'identical'].includes(ancestry.status)) {
        if (!first) return unknown;
        primaryHead = first.parents[0].sha;
      }
    }
    let primary = await get(`repos/${repo}/compare/${pr.base.sha}...${primaryHead}`);
    const final = await get(`repos/${repo}/compare/${pr.base.sha}...${headSha}`);
    // A base merge can retain launch ancestry while advancing the merge base.
    // Use the same verified rebased HAM parent as the diverged-launch path.
    if (final.merge_base_commit?.sha !== primary.merge_base_commit?.sha
      && dispatchedHead && first && primaryHead !== first.parents[0].sha) {
      primaryHead = first.parents[0].sha;
      primary = await get(`repos/${repo}/compare/${pr.base.sha}...${primaryHead}`);
    }
    const mergeBase = primary.merge_base_commit?.sha;
    if (!SHA.test(mergeBase || '') || final.merge_base_commit?.sha !== mergeBase) return unknown;
    let testChanges = null;
    try {
      const primaryChanges = changes(primary.files);
      const aliases = new Map([...primaryChanges].map(([path, change]) => [change.filename, path]));
      const finalChanges = changes(final.files, evidencePaths(primaryChanges, final.files), aliases);
      testChanges = testRegionsChanged(primaryChanges, finalChanges);
    } catch { /* Retain raw evidence; the evaluator fails closed on unsupported patches. */ }
    return { headSha, hasHammerCommits: true, primaryHead, mergeBase,
      testRegionsChanged: testChanges,
      primaryFiles: primary.files, finalFiles: final.files };
  } catch (error) { return error?.authOutage === true || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR' || isTransientGhError(error)
    ? { ...unknown, readFailed: true } : unknown; }
}
