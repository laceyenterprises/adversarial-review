import { amaAllAuthoritativeReviewerLogins } from './reviewer-authority.mjs';
import { isTransientGhError } from '../gh-cli.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBlockingFindingsSection } from '../kernel/remediation-reply.mjs';
import { normalizeEffectiveReviewVerdict } from '../kernel/verdict.mjs';
import { hamAuditCommentAuthorMatches, parseCommitTrailers } from './ham-provenance.mjs';
// HAMINTENT-01: trusted GitHub history, never the hammer's claimed intent.
const SHA = /^[0-9a-f]{40}$/i;
const isHammer = (commit) => /^hammer(?:-corp|-claude)?$/i.test(
  parseCommitTrailers(commit?.commit?.message || '')['worker-class'] || '');
// Match the existing eligibility identity contract: committer takes precedence,
// with linked author as fallback only when GitHub has no linked committer.
const trustedHammerCommit = (commit) => hamAuditCommentAuthorMatches(
  commit?.committer?.login || commit?.author?.login);

export function primaryChangeRoot({ rootDir, env = process.env } = {}) {
  return resolve(rootDir || env.HAM_ROOT_DIR || fileURLToPath(new URL('../../', import.meta.url)));
}

// Dispatch records are daemon-owned evidence. The earliest launch protects
// untagged repairs too; a later launch must never narrow the author baseline.
export function readPrimaryChangeLaunchHead(rootDir, repo, prNumber) {
  const directory = join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-dispatches');
  let names;
  try { names = readdirSync(directory); } catch (error) {
    if (error.code === 'ENOENT') return null;
    error.primaryChangeReadFailed = true;
    throw error;
  }
  const prefix = `${repo.replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '-')}-pr-${Number(prNumber)}-`;
  const records = [];
  for (const name of names.filter((entry) => entry.startsWith(prefix) && entry.endsWith('.json'))) {
    let text;
    try { text = readFileSync(join(directory, name), 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') continue; // Atomic replacement raced the listing.
      error.primaryChangeReadFailed = true;
      throw error;
    }
    let record;
    try { record = JSON.parse(text); } catch { continue; }
    if (record?.repo === repo && Number(record.prNumber) === Number(prNumber)
      && /^hammer(?:-corp|-claude)?$/.test(record.workerClass || '')
      && record.dispatchedAt && SHA.test(record.targetRemediationSha || '')) records.push(record);
  }
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
    .map((path) => ({ path, primaryRegions: (primary.get(path)?.regions || []).map(({ start, end }) => ({ start, end })),
      finalRegions: (final.get(path)?.regions || []).map(({ start, end }) => ({ start, end })) }));
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
        if (!region) { region = { start: oldLine, end: oldLine, removed: new Map(), removedLines: [] }; regions.push(region); }
        if (line.startsWith('+')) additions += 1;
        else {
          const normalized = line.slice(1).trim().replace(/\s+/g, ' ');
          removed.set(normalized, (removed.get(normalized) || 0) + 1);
          region.removedLines.push({ text: normalized, position: oldLine });
          region.removed.set(normalized, (region.removed.get(normalized) || 0) + 1);
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

// Project a base-coordinate region into a reviewed/parent head. Missing or
// truncated diffs cannot authorize anything. Findings use inclusive head lines.
function projectRegion(files, path, region) {
  changes(files); // validate patch completeness before using hunk coordinates
  const file = files.find((entry) => (entry.previous_filename || entry.filename) === path);
  if (!file) return { ...region, filename: path };
  if (typeof file.patch !== 'string') throw new Error('opaque authorization');
  const segments = [];
  let old = 0;
  let next = 0;
  let segment = null;
  for (const line of file.patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      old = Number(hunk[1]) + (hunk[2] === '0' ? 1 : 0);
      next = Number(hunk[3]) + (hunk[4] === '0' ? 1 : 0);
      segment = null;
    } else if (line.startsWith('-') || line.startsWith('+')) {
      if (!segment) { segment = { old, next, oldEnd: old, nextEnd: next }; segments.push(segment); }
      if (line.startsWith('-')) old += 1;
      else next += 1;
      segment.oldEnd = old;
      segment.nextEnd = next;
    } else if (line.startsWith(' ')) { old += 1; next += 1; segment = null; }
  }
  const project = (line, end) => {
    let offset = 0;
    for (const segment of segments) {
      if (line < segment.old) break;
      if (line < segment.oldEnd || segment.old === segment.oldEnd && line === segment.old) {
        // Equal-length replacements have a positional line mapping. Unequal
        // replacements remain ambiguous: each base line maps to the full span,
        // which must be cited in full before any of it can be waived.
        if (segment.oldEnd - segment.old === segment.nextEnd - segment.next) {
          return segment.next + line - segment.old;
        }
        return end ? Math.max(segment.next, segment.nextEnd - 1) : segment.next;
      }
      offset = segment.nextEnd - segment.oldEnd;
    }
    return line + offset;
  };
  return { start: project(region.start, false), end: project(Math.max(region.start, region.end - 1), true), filename: file.filename };
}

const overlaps = (a, b) => a.start <= b.end && b.start <= a.end;

function regionUnits(region) {
  return region.start === region.end ? [region]
    : Array.from({ length: region.end - region.start }, (_, index) => ({
      start: region.start + index, end: region.start + index + 1,
    }));
}

function reversalAuthorized(evidence, path, region) {
  return (evidence.reversalAuthorizations || []).some((authorization) => {
    try {
      const { commit, review, reviewedFiles, parentFiles } = authorization;
      if (!isHammer(commit) || !trustedHammerCommit(commit) || !SHA.test(commit.sha || '') || !SHA.test(review.commit_id || '')
        || !['CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'APPROVED'].includes(review.state)
        || normalizeEffectiveReviewVerdict(review.body) !== 'request-changes'
        || !amaAllAuthoritativeReviewerLogins().includes(String(review.user?.login || '').replace(/\[bot\]$/, ''))) return false;
      const trailers = parseCommitTrailers(commit.commit.message);
      if (trailers['worker-ticket'] !== 'HAM' || trailers['reviewed-head'] !== review.commit_id) return false;
      const cite = /^(\S+) finding=([1-9]\d*)$/.exec(trailers['reversal-authorized-by'] || '');
      if (!cite || ![review.node_id, review.html_url].filter(Boolean).includes(cite[1])) return false;
      const finding = parseBlockingFindingsSection(review.body)?.[Number(cite[2]) - 1];
      if (!finding) return false;
      const lines = /^`?(\d+)(?:\s*[-–]\s*(\d+))?`?$/.exec(finding.lines || '');
      if (!lines) return false;
      const cited = { start: Number(lines[1]), end: Number(lines[2] || lines[1]) };
      if (cited.start < 1 || cited.end < cited.start) return false;
      const reviewed = projectRegion(reviewedFiles, path, region);
      if ((finding.file || '').replace(/^`|`$/g, '') !== reviewed.filename || !(cited.start <= reviewed.start && cited.end >= reviewed.end)) return false;
      const parent = projectRegion(parentFiles, path, region);
      const touched = changes(commit.files).get(parent.filename);
      return Boolean(touched?.regions.some((other) => overlaps({ start: other.start, end: Math.max(other.start, other.end - 1) }, parent)));
    } catch { return false; }
  });
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
      if ((change.renamed && actual?.filename === path) || (!actual
        && !(change.regions.length > 0 && !change.opaque && !change.renamed
          && change.regions.every((region) => regionUnits(region).every((unit) => reversalAuthorized(evidence, path, unit)))))) {
        return { ok: false, reason: 'primary-change-reverted', path, testRegionsChanged: testChanges };
      }
      if (!actual) continue;
      if (change.opaque) {
        if (actual.sha !== change.sha || actual.status !== change.status) {
          return { ok: false, reason: 'primary-change-unknown', path, testRegionsChanged: testChanges };
        }
        continue;
      }
      for (const [line, count] of change.removed) {
        const actualPositions = new Set(actual.regions.flatMap((region) => region.removedLines)
          .filter((entry) => entry.text === line).map((entry) => entry.position));
        const authorizedCount = change.regions.reduce((total, region) => total
          + region.removedLines.filter((entry) => entry.text === line && !actualPositions.has(entry.position)
            && reversalAuthorized(evidence, path, { start: entry.position, end: entry.position + 1 })).length, 0);
        if ((actual.removed.get(line) || 0) + authorizedCount < count) {
          return { ok: false, reason: 'primary-change-reverted', path, testRegionsChanged: testChanges };
        }
      }
      for (const region of change.regions) {
        for (const unit of regionUnits(region)) {
          if (!actual.regions.some((other) => unit.start === unit.end
            ? other.start <= unit.start && other.end >= unit.start
            : other.start < unit.end && other.end > unit.start)
            && !reversalAuthorized(evidence, path, unit)) {
            return { ok: false, reason: 'primary-change-reverted', path, testRegionsChanged: testChanges };
          }
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
  rootDir, env = process.env }) {
  rootDir = primaryChangeRoot({ rootDir, env });
  // Reuse only within this evaluation. The in-lease evaluation must re-read live state.
  const responses = new Map();
  const read = (path) => {
    if (!responses.has(path)) responses.set(path, Promise.resolve().then(() => get(path)));
    return responses.get(path);
  };
  const unknown = { headSha, hasHammerCommits: null };
  try {
    if (!SHA.test(headSha || '')) return unknown;
    const pr = await read(`repos/${repo}/pulls/${prNumber}`);
    if (pr.head?.sha !== headSha) return { ...unknown, headMismatch: true };
    if (!SHA.test(pr.base?.sha || '')) return unknown;
    const history = await read(`repos/${repo}/compare/${pr.base.sha}...${headSha}`);
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
      const baseParent = await read(`repos/${repo}/compare/${first.parents[1].sha}...${pr.base.sha}`);
      if (!['ahead', 'identical'].includes(baseParent.status)) return unknown;
    }
    // The actual first hammer parent includes every author commit, including
    // rebased author commits. A hammer-authored trailer cannot narrow it.
    let primaryHead = dispatchedHead || first.parents[0].sha;
    if (dispatchedHead) {
      const ancestry = await read(`repos/${repo}/compare/${dispatchedHead}...${headSha}`);
      if (!['ahead', 'identical'].includes(ancestry.status)) {
        if (!first) return unknown;
        primaryHead = first.parents[0].sha;
      }
    }
    let primary = await read(`repos/${repo}/compare/${pr.base.sha}...${primaryHead}`);
    const final = await read(`repos/${repo}/compare/${pr.base.sha}...${headSha}`);
    // A base merge can retain launch ancestry while advancing the merge base.
    // Use the same verified rebased HAM parent as the diverged-launch path.
    if (final.merge_base_commit?.sha !== primary.merge_base_commit?.sha
      && dispatchedHead && first && primaryHead !== first.parents[0].sha) {
      primaryHead = first.parents[0].sha;
      primary = await read(`repos/${repo}/compare/${pr.base.sha}...${primaryHead}`);
    }
    const mergeBase = primary.merge_base_commit?.sha;
    if (!SHA.test(mergeBase || '') || final.merge_base_commit?.sha !== mergeBase) return unknown;
    const reversalAuthorizations = [];
    const closure = history.commits.slice(history.commits.findIndex((commit) => commit.sha === primaryHead) + 1);
    const candidates = closure.filter((candidate) => isHammer(candidate)
      && parseCommitTrailers(candidate.commit.message)['reversal-authorized-by']);
    const reviewList = candidates.length ? await read(`repos/${repo}/pulls/${prNumber}/reviews?per_page=100`) : [];
    // An incomplete list cannot prove a citation is current. Refuse its waiver,
    // while retaining the independently readable primary-change evidence.
    const reviews = Array.isArray(reviewList) && reviewList.length < 100 ? reviewList : [];
    // If primaryHead is not listed (compare excludes its base), verify each
    // candidate's parent is descended from the protected author head.
    for (const candidate of candidates) {
      try {
        const trailers = parseCommitTrailers(candidate.commit.message);
        const cite = /^(\S+) finding=([1-9]\d*)$/.exec(trailers['reversal-authorized-by']);
        const review = reviews.find((entry) => cite && [entry.node_id, entry.html_url].filter(Boolean).includes(cite[1]));
        if (!review || review.commit_id !== trailers['reviewed-head']) continue;
        const commit = await read(`repos/${repo}/commits/${candidate.sha}`);
        if (commit.sha !== candidate.sha || commit.commit?.message !== candidate.commit.message
          || !trustedHammerCommit(commit)
          || commit.parents?.length !== 1 || !SHA.test(commit.parents[0].sha)) continue;
        const parentSha = commit.parents[0].sha;
        let latest;
        for (const entry of [...reviews].reverse()) {
          if (!['CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'APPROVED'].includes(entry.state)
            || !amaAllAuthoritativeReviewerLogins().includes(String(entry.user?.login || '').replace(/\[bot\]$/, ''))) continue;
          if (!SHA.test(entry.commit_id || '')) throw new Error('authoritative review has no valid head');
          const ancestry = await read(`repos/${repo}/compare/${entry.commit_id}...${parentSha}`);
          if (['behind', 'diverged'].includes(ancestry.status)) continue;
          if (!['ahead', 'identical'].includes(ancestry.status)) throw new Error('unknown review ancestry');
          latest = entry;
          break;
        }
        if (latest !== review) continue;
        const inClosure = await read(`repos/${repo}/compare/${primaryHead}...${parentSha}`);
        const reviewInClosure = await read(`repos/${repo}/compare/${primaryHead}...${review.commit_id}`);
        const reviewAncestry = await read(`repos/${repo}/compare/${review.commit_id}...${parentSha}`);
        if (![inClosure, reviewInClosure, reviewAncestry].every((entry) => ['ahead', 'identical'].includes(entry.status))) continue;
        const reviewed = await read(`repos/${repo}/compare/${mergeBase}...${review.commit_id}`);
        const parent = await read(`repos/${repo}/compare/${mergeBase}...${parentSha}`);
        if (reviewed.merge_base_commit?.sha !== mergeBase || parent.merge_base_commit?.sha !== mergeBase) continue;
        reversalAuthorizations.push({ commit, review, reviewedFiles: reviewed.files, parentFiles: parent.files });
      } catch (error) {
        if (error?.primaryChangeReadFailed === true || error?.authOutage === true
          || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || isTransientGhError(error)) throw error;
        // A stale/deleted citation refuses only this waiver, never the whole
        // protected author diff. Later candidates can still be evaluated.
      }
    }
    let testChanges = null;
    try {
      const primaryChanges = changes(primary.files);
      const aliases = new Map([...primaryChanges].map(([path, change]) => [change.filename, path]));
      const finalChanges = changes(final.files, evidencePaths(primaryChanges, final.files), aliases);
      testChanges = testRegionsChanged(primaryChanges, finalChanges);
    } catch { /* Retain raw evidence; the evaluator fails closed on unsupported patches. */ }
    return { headSha, hasHammerCommits: true, primaryHead, mergeBase,
      testRegionsChanged: testChanges,
      ...(reversalAuthorizations.length ? { reversalAuthorizations } : {}),
      primaryFiles: primary.files, finalFiles: final.files };
  } catch (error) { return error?.primaryChangeReadFailed === true || error?.authOutage === true || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR' || isTransientGhError(error)
    ? { ...unknown, readFailed: true } : unknown; }
}
