import { readCompletedRemediationRounds, exactHammerValidation } from './hammer-head-validation.mjs';
import { createHash } from 'node:crypto';
import { storedPrimaryChange, primaryChangeStoreOwned } from './primary-change-store.mjs';
import { createHistoryReader } from './history-reader.mjs';
import { fetchCiCost, checkCiCost } from './ci-cost.mjs';
import { fetchGuardReversals, verifiedGuardReversals } from './guard-reversal.mjs';
import { amaAllAuthoritativeReviewerLogins, amaReviewerFamilyForLogin, isCurrentAuthoritativeFamilyReview } from './reviewer-authority.mjs';
import { isTransientGhError } from '../gh-cli.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBlockingFindingsSection, parseNonBlockingFindingsSection } from '../kernel/review-findings.mjs';
import { normalizeEffectiveReviewVerdict } from '../kernel/verdict.mjs';
import { hamCommitIdentityMatches, isHamWorkerTicket, parseCommitTrailers, parseCommitTrailerValues } from './ham-provenance.mjs';
// HAMINTENT-01: trusted GitHub history, never the hammer's claimed intent.
const SHA = /^[0-9a-f]{40}$/i;
const isHammer = (commit) => /^hammer(?:-corp|-claude)?$/i.test(
  parseCommitTrailers(commit?.commit?.message || '')['worker-class'] || '');
// REVERSALPROV-01: a linked HAM author may survive a pipeline rebase, but
// clearing the committer is only a shape check, never authorization by itself.
// Keep duplicate identity claims and unsigned web-flow commits fail-closed.
const isRecommittedHammer = commit => Boolean(commit?.author?.login && commit?.committer?.login)
  && commit.committer.login.trim().toLowerCase() !== 'web-flow'
  && !hamCommitIdentityMatches(commit)
  && hamCommitIdentityMatches({ ...commit, committer: null });

function reversalCommitIdentityMatches(authorization, cache) {
  if (cache?.has(authorization)) return cache.get(authorization);
  const { commit, rebased, originalAuthorization } = authorization;
  if (hamCommitIdentityMatches(commit)) return true;
  if (!rebased || !isRecommittedHammer(commit)) return false;
  if (commit.reversalAppAttested === true) return true;
  const original = originalAuthorization?.commit;
  const matches = Boolean(original && isHammer(original) && hamCommitIdentityMatches(original)
    && reversalTrailerIdentity(original) === reversalTrailerIdentity(commit)
    && reversalPatchIdentity(original.files) === reversalPatchIdentity(commit.files));
  cache?.set(authorization, matches);
  return matches;
}

function reversalTrailerIdentity(commit) {
  return JSON.stringify(Object.entries(parseCommitTrailerValues(commit?.commit?.message || ''))
    .map(([key, values]) => [key, [...values].sort()]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
const isHammerCommit = (commit, loginProvenance = false) => {
  const trailers = parseCommitTrailers(commit?.commit?.message || '');
  // A comment-author login alone cannot distinguish a builder from a hammer.
  // Reversal authorization still requires the stricter worker-class provenance.
  if (trailers['worker-class'] && !isHammer(commit)) return false;
  return isHammer(commit) || (loginProvenance && hamCommitIdentityMatches(commit))
    || trailers['closed-by'] === 'hammer (adversarial-pipe-mode)';
};

export function primaryChangeRoot({ rootDir, env = process.env } = {}) {
  return resolve(rootDir || env.HAM_ROOT_DIR || fileURLToPath(new URL('../../', import.meta.url)));
}

// Trusted dispatcher records establish the pre-push boundary, never commit trailers.
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

// A missing compare entry proves absence only for an added primary file. For
// a modified or renamed file it means restoration to the base, unless a
// removal/rename explicitly proves that the base name is gone.
function primaryPathAbsent(file, finalFiles) {
  if (!['added', 'modified', 'renamed'].includes(file.status)) return false;
  const old = finalFiles.find(entry => entry.filename === file.filename);
  if (old && old.status !== 'removed') return false;
  if (file.status === 'renamed') return !!file.previous_filename && finalFiles.some(entry =>
    entry.status === 'removed' && entry.filename === file.previous_filename
    || entry.status === 'renamed' && entry.previous_filename === file.previous_filename);
  if (!old && file.status !== 'added' && !finalFiles.some(entry =>
    entry.status === 'renamed' && entry.previous_filename === file.filename)) return false;
  return true;
}

function renameDestinations(file, finalFiles) {
  if (!primaryPathAbsent(file, finalFiles) || !SHA.test(file.sha || '')) return [];
  return finalFiles.filter(entry => entry.filename !== file.filename && entry.sha === file.sha
    && (!isTestPath(entry.filename) || isTestPath(file.filename))
    && ['added', 'renamed'].includes(entry.status));
}

function commitRenamesBlob(commit, source, destination, blob) {
  if (!Array.isArray(commit.files) || (commit.files.length >= 300 && commit.filesComplete !== true)) return false;
  const introduced = commit.files.find(file => file.filename === destination && file.sha === blob);
  if (introduced?.status === 'renamed') {
    return introduced.previous_filename === source && introduced.additions === 0 && introduced.deletions === 0;
  }
  return introduced?.status === 'added' && commit.files.some(file =>
    file.filename === source && file.status === 'removed' && file.sha === blob);
}

function identicalHammerRename(evidence, file) {
  if (!evidence.renameProofs?.length) return false;
  const destinations = renameDestinations(file, evidence.finalFiles);
  return (evidence.renameProofs || []).some(({ source, destination, commit, baseParentProof }) => {
    const range = evidence.diagnosticCommitRange || [];
    const index = range.findIndex(entry => entry.sha === commit?.sha);
    const parent = commit?.parents?.[0]?.sha;
    return source === file.filename && destinations.some(entry => entry.filename === destination)
      && SHA.test(commit?.sha || '') && isHammerCommit(commit, true) && hamCommitIdentityMatches(commit)
      && [1, 2].includes(commit.parents?.length) && SHA.test(parent || '') && index >= 0
      && (parent === evidence.primaryHead || range.slice(0, index).some(entry => entry.sha === parent))
      && (commit.parents.length === 1 || baseParentProof?.parentSha === commit.parents[1].sha
        && SHA.test(commit.parents[1].sha || '') && SHA.test(baseParentProof.baseSha || '')
        && ['ahead', 'identical'].includes(baseParentProof.status))
      && commitRenamesBlob(commit, source, destination, file.sha);
  });
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
  if (!Array.isArray(files)) throw new Error('missing or capped file list');
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

// Patch segments are maximal -/+ runs in base (old) and head (next) lines.
// Each keeps its patch lines so a rebase can match the same protected change.
function patchSegments(files, path, cache) {
  if (!cache.has(files)) cache.set(files, { changes: changes(files), paths: new Map() });
  const parsed = cache.get(files);
  // Completeness is checked once per comparison in this evaluation.

  const file = files.find((entry) => (entry.previous_filename || entry.filename) === path);
  if (!file) return { file: null, segments: [] };
  if (typeof file.patch !== 'string') throw new Error('opaque authorization');
  let segments = parsed.paths.get(path);
  if (!segments) {
    segments = [];
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
        if (!segment) { segment = { old, next, oldEnd: old, nextEnd: next, lines: [] }; segments.push(segment); }
        if (line.startsWith('-')) old += 1;
        else next += 1;
        segment.oldEnd = old;
        segment.nextEnd = next;
        segment.lines.push(line);
      } else if (line.startsWith(' ')) { old += 1; next += 1; segment = null; }
    }
    parsed.paths.set(path, segments);
  }
  return { file, segments };
}

// Project a base-coordinate region into a reviewed/parent head. Missing or
// truncated diffs cannot authorize anything. Findings use inclusive head lines.
function projectRegion(files, path, region, cache) {
  const { file, segments } = patchSegments(files, path, cache);
  if (!file) return { ...region, filename: path };
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

// REVERSALPROV-02: context, hunk boundaries and offsets are not authority.
// Match the protected removed content, retaining multiplicity and uniqueness.
function lineMultiset(lines) {
  const counts = new Map();
  for (const line of lines) counts.set(line, (counts.get(line) || 0) + 1);
  return counts;
}

function contentIdentity(lines) {
  return JSON.stringify([...lineMultiset(lines)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function protectedSegment(files, path, region, cache) {
  return patchSegments(files, path, cache).segments.find(entry =>
    entry.old <= region.start && region.end <= entry.oldEnd && entry.old < entry.oldEnd);
}

function rebasedRegion(primaryFiles, reviewedFiles, path, region, cache) {
  const primarySegments = patchSegments(primaryFiles, path, cache).segments;
  const segment = protectedSegment(primaryFiles, path, region, cache);
  if (!segment) throw new Error('protected region outside the primary patch');
  const removed = entry => entry.removals ??= entry.lines.filter(line => line.startsWith('-'));
  const identity = entry => entry.removedIdentity ??= contentIdentity(removed(entry));
  const sameContent = entry => identity(entry) === identity(segment);
  const matches = patchSegments(reviewedFiles, path, cache).segments.filter(sameContent);
  if (matches.length !== 1 || primarySegments.filter(sameContent).length !== 1) {
    throw new Error('rebased protected region patch differs or is ambiguous');
  }
  // Map each removed occurrence, even when equal-content lines were reordered.
  segment.rebasedPositions ??= new Map();
  if (!segment.rebasedPositions.has(matches[0])) {
    const targets = new Map();
    removed(matches[0]).forEach((line, index) => {
      if (!targets.has(line)) targets.set(line, []);
      targets.get(line).push(matches[0].old + index);
    });
    const occurrences = new Map();
    segment.rebasedPositions.set(matches[0], removed(segment).map(line => {
      const occurrence = occurrences.get(line) || 0;
      occurrences.set(line, occurrence + 1);
      return targets.get(line)[occurrence];
    }));
  }
  const positions = segment.rebasedPositions.get(matches[0])
    .slice(region.start - segment.old, region.end - segment.old);
  return { start: Math.min(...positions), end: Math.max(...positions) + 1 };
}

function projectRebasedRegion(primaryFiles, reviewedFiles, path, region, cache) {
  return projectRegion(reviewedFiles, path, rebasedRegion(primaryFiles, reviewedFiles, path, region, cache), cache);
}

function regionUnits(region) {
  return region.removedLines.length === 0 ? []
    : Array.from({ length: region.end - region.start }, (_, index) => ({
      start: region.start + index, end: region.start + index + 1,
    }));
}

function reversalCitations(message) {
  return (parseCommitTrailerValues(message)['reversal-authorized-by'] || [])
    .map((value) => /^(\S+) finding=([1-9]\d*)(?: kind=(blocking|non-blocking))?$/.exec(value))
    .filter(Boolean);
}

// Review order is GitHub evidence; author and committer dates are worker input.
function firstSupersedingReview(review, reviews) {
  const family = amaReviewerFamilyForLogin(review?.user?.login);
  const index = reviews.indexOf(review);
  if (!family || index < 0) throw new Error('unknown review family');
  return reviews.slice(index + 1).find((entry) => {
    const other = amaReviewerFamilyForLogin(entry.user?.login);
    return other && ['CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'APPROVED'].includes(entry.state)
      && (other === family || entry.commit_id !== review.commit_id);
  });
}

function reversalAuthorized(evidence, path, region, cache, strictNonBlockingRemediation) {
  return (evidence.reversalAuthorizations || []).some((authorization) => {
    let citation;
    const reject = (reason) => {
      if (!cache.has('rejectedReversals')) cache.set('rejectedReversals', new Map());
      if (citation) {
        const entry = { commit: authorization.commit.sha, review: citation[1], finding: Number(citation[2]),
          kind: citation[3] || 'blocking', reason };
        cache.get('rejectedReversals').set(JSON.stringify(entry), entry);
      }
      return false;
    };
    try {
      const { commit, review, reviewedFiles, parentFiles, rebased } = authorization;
      if (authorization.completeFileLists !== true && [reviewedFiles, parentFiles, commit?.files]
        .some(files => files?.length >= 300)) return reject('capped-file-list');
      if (!cache.has(review)) cache.set(review, {
        verdict: normalizeEffectiveReviewVerdict(review.body),
        findings: { blocking: parseBlockingFindingsSection(review.body),
          'non-blocking': parseNonBlockingFindingsSection(review.body) },
      });
      const parsedReview = cache.get(review);
      if (!isHammer(commit) || !reversalCommitIdentityMatches(authorization, cache) || (rebased && !commit.author?.login && commit.reversalAppAttested !== true) || !SHA.test(commit.sha || '') || !SHA.test(review.commit_id || '')
        || !['CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'APPROVED'].includes(review.state)
        || !['request-changes', 'approved', 'comment-only'].includes(parsedReview.verdict)
        || !amaAllAuthoritativeReviewerLogins().includes(String(review.user?.login || '').replace(/\[bot\]$/, ''))) return false;
      if (!cache.has(commit)) cache.set(commit, {
        trailers: parseCommitTrailers(commit.commit.message), citations: reversalCitations(commit.commit.message),
      });
      const { trailers, citations } = cache.get(commit);
      if (!isHamWorkerTicket(trailers['worker-ticket']) || trailers['reviewed-head'] !== review.commit_id) return false;
      return citations.some((cite) => {
        if (![review.node_id, review.html_url].filter(Boolean).includes(cite[1])) return false;
        citation = cite;
        // Unqualified legacy citations retain their blocking-section meaning.
        const kind = cite[3] || 'blocking';
        if (kind === 'non-blocking' ? strictNonBlockingRemediation !== true
          : parsedReview.verdict !== 'request-changes') return reject('finding-kind-not-authorizing');
        const finding = parsedReview.findings[kind]?.[Number(cite[2]) - 1];
        if (!finding) return reject('finding-not-found');
        const lines = /^`?(\d+)(?:\s*[-–]\s*(\d+))?`?$/.exec(finding.lines || '');
        if (!lines) return reject('finding-lines-unreadable');
        const cited = { start: Number(lines[1]), end: Number(lines[2] || lines[1]) };
        if (cited.start < 1 || cited.end < cited.start) return reject('finding-lines-invalid');
        if (rebased && reversalPatchIdentity(reviewedFiles, cache) !== reversalPatchIdentity(parentFiles, cache)) return reject('rebased protected region patch differs or is ambiguous');
        const reviewed = rebased === true
          ? projectRebasedRegion(evidence.primaryFiles, reviewedFiles, path, region, cache)
          : projectRegion(reviewedFiles, path, region, cache);
        if ((finding.file || '').replace(/^`|`$/g, '') !== reviewed.filename || !(cited.start <= reviewed.start && cited.end >= reviewed.end)) {
          return reject('finding-does-not-cover-region');
        }
        if (authorization.originalAuthorization) {
          // Evaluate the same unit against the immutable original HAM patch,
          // in the reviewed merge-base coordinates, with the ordinary guards.
          const originalFiles = authorization.originalAuthorization.rebased
            ? authorization.originalAuthorization.parentFiles : reviewedFiles;
          const originalRegion = rebasedRegion(evidence.primaryFiles, originalFiles, path, region, cache);
          if (!reversalAuthorized({ primaryFiles: originalFiles, reversalAuthorizations: [authorization.originalAuthorization] },
            path, originalRegion, new Map(), strictNonBlockingRemediation)) {
            return reject('original-authorization-does-not-cover-region');
          }
        }
        const parent = projectRegion(parentFiles, path, region, cache);
        const segment = protectedSegment(evidence.primaryFiles, path, region, cache);
        const added = segment.addedLines ??= segment.lines.filter(line => line.startsWith('+')).map(line => line.slice(1));
        // A primary deletion is restored by additions, so preserve that
        // existing authorization path using its content as well.
        const restoringDeletion = added.length === 0;
        const content = restoringDeletion
          ? segment.lines.filter(line => line.startsWith('-')).map(line => line.slice(1)) : added;
        // Equal-length replacements can authorize a single base unit. An
        // expansion maps each unit to the complete introduced span, as above.
        const key = content.length === segment.oldEnd - segment.old ? `${region.start}:${region.end}` : segment;
        segment.protectedContent ??= new Map();
        if (!segment.protectedContent.has(key)) segment.protectedContent.set(key, lineMultiset(
          key === segment ? content : content.slice(region.start - segment.old, region.end - segment.old)));
        const protectedLines = segment.protectedContent.get(key);
        const { segments } = patchSegments(commit.files, parent.filename, cache);
        const prefix = restoringDeletion ? '+' : '-';
        segments.authorizingContent ??= new Map();
        if (!segments.authorizingContent.has(prefix)) segments.authorizingContent.set(prefix, lineMultiset(segments.flatMap(entry => entry.lines)
          .filter(line => line.startsWith(prefix)).map(line => line.slice(1))));
        const removed = segments.authorizingContent.get(prefix);
        if (!cache.has('reversalContentCoverage')) cache.set('reversalContentCoverage', new Map());
        const coverageByCommit = cache.get('reversalContentCoverage');
        const coverageKey = `${commit.sha}:${parent.filename}:${prefix}`;
        if (!coverageByCommit.has(coverageKey)) coverageByCommit.set(coverageKey, { units: new Set(), used: new Map() });
        const coverage = coverageByCommit.get(coverageKey);
        const alreadyCovered = coverage.units.has(protectedLines);
        if (!protectedLines.size || [...protectedLines].some(([line, count]) =>
          (removed.get(line) || 0) < (coverage.used.get(line) || 0) + (alreadyCovered ? 0 : count))) {
          return reject('hammer-patch-does-not-touch-region');
        }
        if (!alreadyCovered) {
          coverage.units.add(protectedLines);
          for (const [line, count] of protectedLines) coverage.used.set(line, (coverage.used.get(line) || 0) + count);
        }
        if (!cache.has('verifiedReversals')) cache.set('verifiedReversals', new Set());
        cache.get('verifiedReversals').add(`${commit.sha}:${cite[1]}:${cite[2]}:${kind}`);
        return true;
      });
    } catch (error) { return reject(error.message); }
  });
}

// A replacement hunk can delete/re-add unchanged base lines (GitHub's
// three-line clone command is one such hunk). Exact context at the same base
// coordinate in the final patch proves those lines were never reversed. Do
// not infer preservation from text elsewhere or from omitted context.
function hasRebasedReversalProof(evidence, path) {
  return (evidence.reversalAuthorizations || []).some(authorization => {
    const { commit, review, reviewedFiles, parentFiles, rebased } = authorization;
    try {
      if (!rebased || !isHammer(commit) || !reversalCommitIdentityMatches(authorization) || (rebased && !commit.author?.login && commit.reversalAppAttested !== true)
        || commit.parents?.length !== 1
        || !amaAllAuthoritativeReviewerLogins().includes(String(review.user?.login || '').replace(/\[bot\]$/, ''))
        || parseCommitTrailers(commit.commit.message)['reviewed-head'] !== review.commit_id
        || reversalPatchIdentity(reviewedFiles) !== reversalPatchIdentity(parentFiles)) return false;
      return reversalCitations(commit.commit.message).some(cite => {
        if (![review.node_id, review.html_url].includes(cite[1])) return false;
        const findings = cite[3] === 'non-blocking' ? parseNonBlockingFindingsSection(review.body) : parseBlockingFindingsSection(review.body);
        return findings[Number(cite[2]) - 1]?.file?.replace(/^`|`$/g, '') === path;
      });
    } catch { return false; }
  });
}

function unchangedReplacementPositions(primaryFiles, finalFiles, path) {
  const primary = primaryFiles.find(file => (file.previous_filename || file.filename) === path);
  const final = finalFiles.find(file => (file.previous_filename || file.filename) === path);
  const positions = new Set();
  if (!primary?.patch || !final?.patch) return positions;
  const normalize = text => text.trim().replace(/\s+/g, ' ');
  const segments = patchSegments(primaryFiles, path, new Map()).segments;
  const contexts = new Map();
  let old = 0;
  for (const line of final.patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+/.exec(line);
    if (hunk) old = Number(hunk[1]);
    else if (line.startsWith(' ')) { contexts.set(old++, normalize(line.slice(1))); }
    else if (line.startsWith('-')) old++;
  }
  for (const line of primary.patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+/.exec(line);
    if (hunk) old = Number(hunk[1]);
    else if (line.startsWith('-')) {
      const text = normalize(line.slice(1));
      const readdedInReplacement = segments.some(segment => segment.old <= old && old < segment.oldEnd
        && segment.lines.some(added => added.startsWith('+') && normalize(added.slice(1)) === text));
      if (readdedInReplacement && contexts.get(old) === text) positions.add(old);
      old++;
    } else if (line.startsWith(' ')) old++;
  }
  return positions;
}

// Diagnostic coordinates use the same base and units as the refusal. This
// describes missing regions without granting any additional authorization.
function refusedRegions(primary, final, authorized) {
  const result = [];
  for (const region of primary.regions) {
    for (const unit of regionUnits(region)) {
      const overlaps = final?.regions.some(other => unit.start === unit.end
        ? other.start <= unit.start && other.end >= unit.start
        : other.start < unit.end && other.end > unit.start);
      const lostRemoval = region.removedLines.some(line => line.position === unit.start
        && (final?.removed.get(line.text) || 0) < primary.removed.get(line.text));
      if (overlaps && !lostRemoval) continue;
      try { if (!authorized(unit)) result.push(unit); }
      catch { result.push(unit); } // Diagnostic uncertainty cannot change the verdict.
    }
  }
  return result;
}

// REVERSALREBASE-01: a refusal names the one piece of evidence it lacks, and
// every trailer citation the collector found but could not verify.
function missingReversalEvidence(evidence, path, missing, cache, regions) {
  const rejected = [...(evidence.rejectedReversalAuthorizations || []),
    ...(cache.get('rejectedReversals')?.values() || [])].slice(0, 10);
  const accepted = cache.get('verifiedReversals')?.size || 0;
  const diagnosticTimeout = evidence.revertedRegionDiagnostics?.some(entry => entry.path === path
    && entry.error?.includes('diagnostic time budget exhausted'));
  let summary = missing === 'reversal-authorization'
    ? `no verified Reversal-Authorized-By covers the reverted ${path} region (${accepted} verified`
      + `${diagnosticTimeout ? '; region diagnostic time budget exhausted' : ''}`
      + `${rejected.length ? `; rejected: ${rejected.map((entry) => `${entry.review} finding=${entry.finding} kind=${entry.kind} on ${String(entry.commit).slice(0, 12)} (${entry.reason}${entry.detail ? `: ${entry.detail}` : ''})`).join(', ')}` : ''})`
    : `the reverted ${path} change cannot be authorized by a finding (${missing})`
      + `${diagnosticTimeout ? '; region diagnostic time budget exhausted' : ''}`;
  const regionDiagnostics = [...(evidence.revertedRegionDiagnostics || []), ...(evidence.primaryPathChanges || [])]
    .filter(entry => entry.path === path);
  if (regionDiagnostics.length) summary += '; region history: ' + regionDiagnostics.map(entry =>
    `${entry.start === null ? 'file-level' : `${entry.start}-${entry.end}`}: ${entry.commits.map(commit =>
      `${commit.sha} author=${commit.author || 'unlinked'} pipeline-repair=${commit.pipelineRepair === true ? 'yes' : commit.pipelineRepair === false ? 'no' : 'unknown'}${commit.repairKind ? ` (${commit.repairKind})` : ''}`).join(', ') || 'unavailable'}${entry.error ? ` (${entry.error})` : ''}`).join('; ');
  return { evidence: missing, path, accepted, rejected, summary: boundedReversalText(summary, 4096), regions, regionDiagnostics };
}

// The exact-head re-review is the one automatic action that can supply a
// missing finding citation: it is requested only for a HAM head whose own
// exact-head self-certification failed on nothing but that authorization.
export function primaryChangeExactReviewEvidence(trace) {
  const missing = trace?.primaryChange?.missingEvidence;
  const ham = trace?.hamTerminalRemediation;
  if (trace?.primaryChange?.reason !== 'primary-change-reverted' || missing?.evidence !== 'reversal-authorization'
    || ham?.active !== true || ham.checks?.primaryChange !== false) return null;
  return ['workerClass', 'head', 'parent', 'commitIdentity', 'nonEmptyCommit']
    .every((name) => ham.checks[name] === true) ? missing : null;
}

// Non-blocking waivers require an explicit effective strict-mode policy.
export function checkPrimaryChange(evidence, headSha, { strictNonBlockingRemediation = false } = {}) {
  if (evidence && [true, false].includes(evidence.hasHammerCommits)) {
    const cost = checkCiCost(evidence.ciCost, headSha);
    if (!cost.ok) return cost;
  }
  if (!evidence) return { ok: false, reason: 'primary-change-unknown', detail: 'missing primary-change evidence' };
  if (evidence.headSha !== headSha || evidence.headMismatch) return { ok: false, reason: 'primary-change-read-failed' };
  if (evidence.historyReadFailed === true) return { ok: false, reason: 'history-read-failed', detail: evidence.reason };
  if (evidence.readFailed === true) return { ok: false, reason: 'primary-change-read-failed', detail: evidence.reason };
  if (evidence.hasHammerCommits === false) return { ok: true, applicable: false };
  try {
    if (evidence.hasHammerCommits !== true || !SHA.test(evidence.primaryHead || '')
      || !SHA.test(evidence.mergeBase || '')) throw new Error('unknown primary change');
    if (evidence.completeFileLists !== true && [evidence.primaryFiles, evidence.finalFiles]
      .some(files => files?.length >= 300)) throw new Error('missing or capped file list');
    const authorizationCache = new Map();
    const guardReversals = verifiedGuardReversals(evidence, headSha);
    const primary = changes(evidence.primaryFiles);
    const aliases = new Map([...primary].map(([path, change]) => [change.filename, path]));
    const final = changes(evidence.finalFiles, evidencePaths(primary, evidence.finalFiles), aliases);
    if (![...primary.values()].some(({ regions, renamed, opaque }) => regions.length > 0 || renamed || opaque)) {
      throw new Error('empty primary change');
    }
    const testChanges = testRegionsChanged(primary, final);
    const reverted = (path, missing = 'reversal-authorization') => {
      const diagnosticCache = new Map();
      return { ok: false, reason: 'primary-change-reverted', path,
        testRegionsChanged: testChanges, missingEvidence: missingReversalEvidence(evidence, path, missing, authorizationCache,
          refusedRegions(primary.get(path), final.get(path), (unit) =>
            reversalAuthorized(evidence, path, unit, diagnosticCache, strictNonBlockingRemediation))) };
    };
    for (const [path, change] of primary) {
      if (guardReversals.some(proof => proof.path === path)) continue;
      const actual = final.get(path);
      if (isTestPath(path) && isTestPath(change.filename)
        && (!actual || isTestPath(actual.filename))) continue;
      if (!isTestPath(change.filename) && actual && isTestPath(actual.filename)) {
        return reverted(path, 'rename-preservation');
      }
      const file = evidence.primaryFiles.find(entry => (entry.previous_filename || entry.filename) === path);
      if (identicalHammerRename(evidence, file)) continue;
      if ((change.renamed && actual?.filename === path)
        || (change.status === 'added' && actual && !actual.opaque && actual.regions.length === 0) || (!actual
        && !(change.regions.length > 0 && !change.opaque && !change.renamed
          && (change.status !== 'added' || change.removed.size > 0)
          && change.regions.every((region) => regionUnits(region).every((unit) => reversalAuthorized(evidence, path, unit, authorizationCache, strictNonBlockingRemediation)))))) {
        return reverted(path, change.renamed ? 'rename-preservation' : change.opaque ? 'opaque-file-preservation' : 'reversal-authorization');
      }
      if (!actual) continue;
      if (change.opaque) {
        if (actual.sha !== change.sha || actual.status !== change.status) {
          return { ok: false, reason: 'primary-change-unknown', detail: 'opaque file changed without readable patch', path, testRegionsChanged: testChanges };
        }
        continue;
      }
      const unchanged = hasRebasedReversalProof(evidence, path)
        ? unchangedReplacementPositions(evidence.primaryFiles, evidence.finalFiles, path) : new Set();
      const actualPositionsByText = new Map();
      for (const entry of actual.regions.flatMap((region) => region.removedLines)) {
        if (!actualPositionsByText.has(entry.text)) actualPositionsByText.set(entry.text, new Set());
        actualPositionsByText.get(entry.text).add(entry.position);
      }
      const authorizedByText = new Map();
      for (const entry of change.regions.flatMap((region) => region.removedLines)) {
        if (unchanged.has(entry.position) || (!actualPositionsByText.get(entry.text)?.has(entry.position)
          && reversalAuthorized(evidence, path, { start: entry.position, end: entry.position + 1 }, authorizationCache, strictNonBlockingRemediation))) {
          authorizedByText.set(entry.text, (authorizedByText.get(entry.text) || 0) + 1);
        }
      }
      for (const [line, count] of change.removed) {
        const authorizedCount = authorizedByText.get(line) || 0;
        if ((actual.removed.get(line) || 0) + authorizedCount < count) {
          return reverted(path);
        }
      }
      for (const region of change.regions) {
        for (const unit of regionUnits(region)) {
          if (!unchanged.has(unit.start) && !actual.regions.some((other) => unit.start === unit.end
            ? other.start <= unit.start && other.end >= unit.start
            : other.start < unit.end && other.end > unit.start)
            && !reversalAuthorized(evidence, path, unit, authorizationCache, strictNonBlockingRemediation)) {
            return reverted(path);
          }
        }
      }
    }
    return { ok: true, applicable: true, testRegionsChanged: testChanges,
      ...(guardReversals.length ? { guardReversals: guardReversals.map(({ authorization, path, failedRun, passingRun }) => ({
        authorization, paths: [path], failedCheckRun: failedRun.id, passingCheckRun: passingRun.id,
        failedHead: failedRun.head_sha, passingHead: passingRun.head_sha,
      })) } : {}) };
  } catch (error) {
    return { ok: false, reason: 'primary-change-unknown', detail: evidence.reason || error.message };
  }
}

// Bind changed content with multiplicity per path. Rebase context, positions,
// ordering and hunk partitioning do not change the removal authorization.
function reversalPatchIdentity(files, cache) {
  if (cache?.get(files)?.reversalIdentity) return cache.get(files).reversalIdentity;
  const parsed = cache?.get(files) || { changes: changes(files), paths: new Map() };
  const identity = JSON.stringify(files.map(file => {
    if (typeof file.patch !== 'string') throw new Error('opaque original reversal');
    return [file.filename, file.previous_filename || '', file.status,
      contentIdentity(file.patch.split('\n').filter(line => /^[+\\-]/.test(line)))];
  }).sort((a, b) => a[0].localeCompare(b[0])));
  parsed.reversalIdentity = identity;
  cache?.set(files, parsed);
  return identity;
}

function boundedReversalText(text, limit = 1200) {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function reversalMismatchPaths(expected, actual) {
  const byPath = identity => new Map(JSON.parse(identity).map(file => [file[0], JSON.stringify(file)]));
  const left = byPath(expected), right = byPath(actual);
  return [...new Set([...left.keys(), ...right.keys()])].sort()
    .filter(path => left.get(path) !== right.get(path));
}

function normalizedRebaseHunks(patch) {
  let firstOld, firstNew;
  return patch.split('\n').map(line => {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (!hunk) return line;
    firstOld ??= Number(hunk[1]); firstNew ??= Number(hunk[3]);
    return [Number(hunk[1]) - firstOld, Number(hunk[2] ?? 1), Number(hunk[3]) - firstNew, Number(hunk[4] ?? 1), hunk[5]];
  });
}

function rebasePatchIdentity(files) {
  changes(files);
  return JSON.stringify(files.map(file => {
    if (typeof file.patch !== 'string') throw new Error('opaque rebase proof');
    return [file.filename, file.previous_filename || '', file.status, file.additions, file.deletions,
      normalizedRebaseHunks(file.patch)];
  }).sort((a, b) => a[0].localeCompare(b[0])));
}

// Carry an approval only over the same reviewed patch, modulo a base rebase
// and whole-path reversals independently authorized by live required guards.
export function guardRepairReviewCoverage(evidence, reviewedHead, currentHead) {
  const proofs = verifiedGuardReversals(evidence, currentHead);
  if (!reviewedHead || !proofs.length || !checkPrimaryChange(evidence, currentHead).ok) return false;
  const direct = reviewedHead === evidence.primaryHead;
  const snapshot = evidence.guardReviewSnapshots?.find(snapshot => snapshot.headSha === reviewedHead);
  const reviewed = direct ? evidence.primaryFiles : snapshot?.files;
  if (!Array.isArray(reviewed)) return false;
  if (!direct && (snapshot.reviewToPrimary !== 'diverged' || snapshot.baseAncestry !== 'ahead'
    || snapshot.fromBase === evidence.mergeBase)) return false;
  const paths = new Set(proofs.map(proof => proof.path));
  const remaining = files => files.filter(file => !paths.has(file.filename) && !paths.has(file.previous_filename));
  try {
    if (direct) {
      const identity = files => JSON.stringify(remaining(files).map(file => [file.filename, file.previous_filename,
        file.status, file.sha, file.patch]).sort((a, b) => a[0].localeCompare(b[0])));
      return identity(reviewed) === identity(evidence.finalFiles);
    }
    return rebasePatchIdentity(remaining(reviewed)) === rebasePatchIdentity(remaining(evidence.finalFiles));
  } catch { return false; }
}

async function fetchGuardReviewSnapshots(args, evidence) {
  if (!verifiedGuardReversals(evidence, args.headSha).length) return {};
  try {
    const reviews = await args.get(`repos/${args.repo}/pulls/${args.prNumber}/reviews?per_page=100`);
    if (!Array.isArray(reviews) || reviews.length >= 100) return {};
    // Later notes by the same family must not erase an earlier approval head.
    const reviewedCommits = new Set();
    for (const review of reviews) {
      const family = amaReviewerFamilyForLogin(review.user?.login);
      if (family && SHA.test(review.commit_id || '')) reviewedCommits.add(review.commit_id);
    }
    const guardReviewSnapshots = [];
    for (const reviewedHead of reviewedCommits) {
      if (reviewedHead === evidence.primaryHead) continue;
      const snapshot = await args.get(`repos/${args.repo}/compare/${evidence.baseSha}...${reviewedHead}`);
      if (Array.isArray(snapshot.files) && (snapshot.filesComplete === true || snapshot.files.length < 300)
        && SHA.test(snapshot.merge_base_commit?.sha || '')) {
        const metadata = args.get.metadata || args.get;
        const reviewToPrimary = await metadata(`repos/${args.repo}/compare/${reviewedHead}...${evidence.primaryHead}`);
        const baseAncestry = await metadata(`repos/${args.repo}/compare/${snapshot.merge_base_commit.sha}...${evidence.mergeBase}`);
        guardReviewSnapshots.push({ headSha: reviewedHead, files: snapshot.files,
          fromBase: snapshot.merge_base_commit.sha, toBase: evidence.mergeBase,
          reviewToPrimary: reviewToPrimary.status, baseAncestry: baseAncestry.status });
      }
    }
    return { guardReviewSnapshots };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
    return {}; // Missing coverage leaves exact-head review mandatory.
  }
}

async function attestedReversal(commit, repo, read, prNumber) {
  const comments = await read(`repos/${repo}/issues/${prNumber}/comments?per_page=100`);
  return Array.isArray(comments) && comments.length < 100 && comments.some(comment => exactHammerValidation(comment, commit.sha));
}

async function originalReversalAuthorization({ repo, review, reviews, superseding, commit, reviewed, mergeBase, read, readCommit, metadata, prNumber, matchTrailers = false }) {
  if (!SHA.test(superseding.commit_id || '')) return { detail: 'invalid superseding review head' };
  const snapshot = await read(`repos/${repo}/compare/${review.commit_id}...${superseding.commit_id}`);
  if (!['ahead', 'diverged'].includes(snapshot.status) || !Array.isArray(snapshot.commits)
    || snapshot.commits.length !== snapshot.total_commits) return { detail: 'incomplete or unsupported superseding snapshot' };
  const identity = reversalPatchIdentity(commit.files);
  const sameMessage = snapshot.commits.filter(entry => matchTrailers
    ? reversalTrailerIdentity(entry) === reversalTrailerIdentity(commit)
    : entry.commit?.message === commit.commit.message);
  if (!sameMessage.length) return { detail: matchTrailers ? 'no candidate with the same trailer set' : 'no candidate with the same commit message' };
  const candidates = sameMessage.filter(entry => isHammer(entry) && SHA.test(entry.sha || ''));
  if (!candidates.length) return { detail: 'commit-provenance: no valid same-message candidate identity' };
  const failures = [];
  for (const candidate of candidates) {
    const reject = detail => {
      if (failures.length < 10) failures.push(`${candidate.sha}: ${detail}`);
    };
    const original = await readCommit(`repos/${repo}/commits/${candidate.sha}`);
    if (original.sha !== candidate.sha || original.commit?.message !== candidate.commit.message
      || !hamCommitIdentityMatches(original) || original.parents?.length !== 1
      || !SHA.test(original.parents[0].sha || '')) { reject('commit-provenance'); continue; }
    let originalIdentity;
    try {
      originalIdentity = reversalPatchIdentity(original.files);
    } catch {
      reject('opaque or malformed original patch');
      continue;
    }
    if (originalIdentity !== identity) {
      const paths = reversalMismatchPaths(identity, originalIdentity);
      reject(`change-line mismatch on paths: ${paths.slice(0, 5).map(path => boundedReversalText(path, 160)).join(', ')}${paths.length > 5 ? ` (+${paths.length - 5} more)` : ''}`);
      continue;
    }
    const parentSha = original.parents[0].sha;
    const current = await isCurrentAuthoritativeFamilyReview(review, reviews.slice(0, reviews.indexOf(superseding)), parentSha,
      (from, to) => metadata(`repos/${repo}/compare/${from}...${to}`));
    const rebased = !current;
    if (rebased && !original.author?.login) {
      if (!await attestedReversal(original, repo, read, prNumber)) { reject('commit-provenance: missing App attestation'); continue; }
      original.reversalAppAttested = true;
    }
    if (rebased && (await metadata(`repos/${repo}/compare/${review.commit_id}...${parentSha}`)).status !== 'diverged') {
      reject('review-not-current'); continue;
    }
    // An immutable later review pins the original App commit even when that
    // commit's parent is a rebase of the cited head. Use the same region proof
    // as the unsuperseded path; dates and ancestry to later heads prove nothing.
    const parent = await read(`repos/${repo}/compare/${rebased ? mergeBase : reviewed.merge_base_commit.sha}...${parentSha}`);
    if (parent.merge_base_commit?.sha !== (rebased ? mergeBase : reviewed.merge_base_commit.sha)) {
      reject('merge-base-mismatch'); continue;
    }
    try {
      changes(parent.files);
      if (rebased && reversalPatchIdentity(reviewed.files) !== reversalPatchIdentity(parent.files)) {
        reject('parent-is-not-reviewed-head-rebase'); continue;
      }
    } catch {
      // Opaque or malformed patches decline this snapshot, not later candidates.
      reject('opaque or malformed parent patch');
      continue;
    }
    return { authorization: { commit: original, review, reviewedFiles: reviewed.files, parentFiles: parent.files,
      ...(rebased ? { rebased: true } : {}),
      completeFileLists: original.filesComplete === true && reviewed.filesComplete === true && parent.filesComplete === true } };
  }
  return { detail: boundedReversalText(failures.join('; ')) };
}

// get is an injected bounded JSON API reader. Compare caps are errors, not empty diffs.
async function fetchPrimaryChangeHistory({ repo, prNumber, headSha, get, rootDir, builderHead }) {
  // Reuse only within this evaluation. The in-lease evaluation must re-read live state.
  const responses = new Map();
  const read = (path) => {
    if (!responses.has(path)) responses.set(path, Promise.resolve().then(() => get(path)).then(result => {
      if (Array.isArray(result?.files) && result.files.length >= 300 && result.filesComplete !== true) {
        throw new Error(`incomplete file list: ${path}`);
      }
      return result;
    }));
    return responses.get(path);
  };
  // Bounded history reads omit signature payloads. Hydrate verification only
  // for web-flow provenance, binding it to the immutable commit in every proof.
  // Share successes and failures across proof scans without mutating raw reads.
  const commits = new Map();
  const readCommit = path => {
    if (!commits.has(path)) commits.set(path, read(path).then(async commit => {
      if (commit.committer?.login === 'web-flow' && get.commitVerification) {
        const verification = await get.commitVerification(path);
        if (verification.sha !== commit.sha) throw Object.assign(new Error('commit verification SHA mismatch'),
          { code: 'COMMIT_VERIFICATION_SHA_MISMATCH' });
        return { ...commit, commit: { ...commit.commit, verification: verification.verification } };
      }
      return commit;
    }));
    return commits.get(path);
  };
  const metadata = path => get.metadata ? get.metadata(path) : read(path);
  const unknown = (reason, extra = {}) => ({ headSha, hasHammerCommits: null, reason, ...extra });
  try {
    if (!SHA.test(headSha || '')) return unknown('invalid head SHA');
    const pr = await read(`repos/${repo}/pulls/${prNumber}`);
    if (pr.head?.sha !== headSha) return unknown('live head changed during history read', { headMismatch: true });
    if (!SHA.test(pr.base?.sha || '')) return unknown('missing base SHA');
    const history = await read(`repos/${repo}/compare/${pr.base.sha}...${headSha}`);
    if (!Array.isArray(history.commits) || history.commits.length !== history.total_commits
      || history.commits.some((commit) => !SHA.test(commit?.sha || '')
        || typeof commit?.commit?.message !== 'string')) return unknown('missing, malformed or capped commit history');
    let launchIndex = -1;
    let builderBoundary = null;
    const untagged = history.commits.some((commit) => !isHammerCommit(commit)
      && hamCommitIdentityMatches(commit));
    if (untagged) {
      const launchHead = readPrimaryChangeLaunchHead(primaryChangeRoot({ rootDir }), repo, prNumber);
      if (launchHead) {
        // The opening identity is pinned by the build-completion ledger. CLI /
        // sibling callers fall back to the earliest GitHub review, not a head
        // named by a hammer-authored commit trailer or a later review.
        let boundary = builderHead;
        if (!SHA.test(boundary || '')) {
          const reviews = await read(`repos/${repo}/pulls/${prNumber}/reviews?per_page=100`);
          if (!Array.isArray(reviews) || reviews.length >= 100) return unknown('missing or capped builder review history');
          boundary = reviews.filter((review) => amaAllAuthoritativeReviewerLogins().includes(
            String(review.user?.login || '').replace(/\[bot\]$/, ''))).sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))[0]?.commit_id;
        }
        if (!SHA.test(boundary || '')) return unknown('missing builder head for untagged hammer provenance');
        const ancestry = boundary === launchHead ? { status: 'identical' }
          : await metadata(`repos/${repo}/compare/${boundary}...${launchHead}`);
        launchIndex = history.commits.findIndex((commit) => commit.sha === launchHead);
        if (!['ahead', 'identical'].includes(ancestry.status) || launchIndex < 0) {
          return unknown('untagged hammer launch is outside builder history');
        }
        builderBoundary = boundary;
      }
    }
    const first = history.commits.find((commit, index) => isHammerCommit(commit,
      launchIndex >= 0 && index > launchIndex));
    if (!first) return { headSha, hasHammerCommits: false };
    if (first && (!first.parents?.length || first.parents.length > 2
      || !SHA.test(first.parents[0].sha))) return unknown('missing or unsupported first hammer parents');
    if (first && first.parents.length === 2) {
      const baseParent = await metadata(`repos/${repo}/compare/${first.parents[1].sha}...${pr.base.sha}`);
      if (!['ahead', 'identical'].includes(baseParent.status)) return unknown('hammer merge second parent is not in base ancestry');
    }
    // The actual first hammer parent includes every author commit, including
    // rebased author commits. A hammer-authored trailer cannot narrow it.
    const primaryHead = first.parents[0].sha;
    const primary = await read(`repos/${repo}/compare/${pr.base.sha}...${primaryHead}`);
    const final = history;
    const mergeBase = primary.merge_base_commit?.sha;
    if (!SHA.test(mergeBase || '') || final.merge_base_commit?.sha !== mergeBase) return unknown('primary and final merge bases are missing or differ');
    const renameProofs = [];
    const primaryPathChanges = [];
    let renameProofReadFailed = false;
    // Missing paths need commit-level removal/rename evidence. A base-to-head
    // content match alone cannot attribute a rename to the hammer.
    for (const file of primary.files || []) {
      if (isTestPath(file.filename) || !primaryPathAbsent(file, final.files || [])) continue;
      const destinations = renameDestinations(file, final.files || []);
      const attribution = { path: file.filename, start: null, end: null, commits: [] };
      let candidateReadFailed = false;
      // Refusal details reuse commit-file metadata, without snapshot or
      // comment-history scans. Attribution never grants authority.
      const fullRange = history.commits.slice(history.commits.indexOf(first));
      // No destination can prove preservation: bound reads used only for
      // removal diagnostics, while keeping the full range for rename proof.
      const range = destinations.length ? fullRange : fullRange.slice(0, 20);
      if (range.length < fullRange.length) attribution.error = `diagnostic commit range truncated after 20 of ${fullRange.length} commits`;
      for (const candidate of range) {
        try {
          const commitPath = `repos/${repo}/commits/${candidate.sha}`;
          let commit = await read(commitPath);
          if (commit.sha !== candidate.sha || commit.commit?.message !== candidate.commit.message) continue;
          if (Array.isArray(commit.files) && (commit.files.length < 300 || commit.filesComplete === true)
            && commit.files.some(entry => entry.filename === file.filename && entry.status === 'removed'
              || entry.previous_filename === file.filename && entry.status === 'renamed')) {
            attribution.commits.push({ sha: commit.sha, author: commit.author?.login || commit.commit?.author?.name || null,
              pipelineRepair: null, repairKind: null });
          }
          if (!destinations.length) continue;
          commit = await readCommit(commitPath);
          if (!isHammerCommit(commit, true) || !hamCommitIdentityMatches(commit)
            || ![1, 2].includes(commit.parents?.length) || !SHA.test(commit.parents[0].sha || '')) continue;
          const destination = destinations.find(entry => commitRenamesBlob(commit, file.filename, entry.filename, file.sha));
          if (!destination) continue;
          const ancestry = commit.parents[0].sha === primaryHead ? { status: 'identical' }
            : await metadata(`repos/${repo}/compare/${primaryHead}...${commit.parents[0].sha}`);
          if (!['ahead', 'identical'].includes(ancestry.status)) continue;
          let baseParentProof;
          if (commit.parents.length === 2) {
            const parentSha = commit.parents[1].sha;
            if (!SHA.test(parentSha || '')) continue;
            const baseParent = await metadata(`repos/${repo}/compare/${parentSha}...${pr.base.sha}`);
            if (!['ahead', 'identical'].includes(baseParent.status)) continue;
            baseParentProof = { parentSha, baseSha: pr.base.sha, status: baseParent.status };
          }
          renameProofs.push({ source: file.filename, destination: destination.filename, commit,
            ...(baseParentProof ? { baseParentProof } : {}) });
          candidateReadFailed = false;
          break;
        } catch (error) {
          // Unavailable optional proof retains today's refusal; it must not
          // turn an existing decision into a new fail-closed condition.
          if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') throw error;
          if (destinations.length) candidateReadFailed = true;
        }
      }
      // Successful proof resolves earlier candidate failures for this path
      // only. Another path's unresolved proof must still prevent caching.
      renameProofReadFailed ||= candidateReadFailed;
      if (attribution.commits.length || attribution.error) primaryPathChanges.push(attribution);
    }
    const reversalAuthorizations = [];
    const rejectedReversalAuthorizations = [];
    const authorizedPairs = new Set();
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
      const trailers = parseCommitTrailers(candidate.commit.message);
      for (const cite of reversalCitations(candidate.commit.message)) {
        const reject = (reason, detail) => {
          if (rejectedReversalAuthorizations.length < 10) rejectedReversalAuthorizations.push({
            commit: candidate.sha, review: cite[1], finding: Number(cite[2]), kind: cite[3] || 'blocking', reason,
            ...(detail ? { detail } : {}) });
        };
        try {
          const review = reviews.find((entry) => cite && [entry.node_id, entry.html_url].filter(Boolean).includes(cite[1]));
          if (!review) { reject(reviews === reviewList ? 'review-not-on-this-pull-request' : 'review-list-unreadable'); continue; }
          if (review.commit_id !== trailers['reviewed-head']) { reject('reviewed-head-mismatch'); continue; }
          const pair = `${candidate.sha}:${review.node_id || review.html_url}`;
          if (authorizedPairs.has(pair)) continue;
          authorizedPairs.add(pair);
          const commit = await readCommit(`repos/${repo}/commits/${candidate.sha}`);
          const recommitted = isRecommittedHammer(commit);
          if (commit.sha !== candidate.sha || commit.commit?.message !== candidate.commit.message
            || (!hamCommitIdentityMatches(commit) && !recommitted)
            || commit.parents?.length !== 1 || !SHA.test(commit.parents[0].sha)) { reject('commit-provenance'); continue; }
          const parentSha = commit.parents[0].sha;
          let rebased = false;
          let superseding;
          if (!await isCurrentAuthoritativeFamilyReview(review, reviews, parentSha,
            (from, to) => metadata(`repos/${repo}/compare/${from}...${to}`))) {
            // REVERSALREBASE-01: a rebase rewrites the HAM commit, so its parent
            // no longer descends from the cited review head. Only that diverged
            // shape may use the rebase path. A superseded citation additionally
            // needs its original reversal pinned by a GitHub review snapshot.
            const ancestry = await metadata(`repos/${repo}/compare/${review.commit_id}...${parentSha}`);
            if (ancestry.status !== 'diverged') { reject('review-not-current'); continue; }
            superseding = firstSupersedingReview(review, reviews);
            rebased = true;
          }
          if (recommitted) {
            if (!rebased) { reject('rebased-commit-unproven', 'review head did not diverge from the HAM parent'); continue; }
            if (await attestedReversal(commit, repo, read, prNumber)) commit.reversalAppAttested = true;
            else if (!superseding) { reject('rebased-commit-unproven', 'missing App attestation or immutable original reversal'); continue; }
          }
          if (rebased && !commit.author?.login) {
            if (!await attestedReversal(commit, repo, read, prNumber)) { reject('commit-provenance'); continue; }
            commit.reversalAppAttested = true;
          }
          // The HAM parent stays inside the protected closure either way.
          const chain = [await metadata(`repos/${repo}/compare/${primaryHead}...${parentSha}`)];
          if (!rebased) chain.push(await metadata(`repos/${repo}/compare/${primaryHead}...${review.commit_id}`),
            await metadata(`repos/${repo}/compare/${review.commit_id}...${parentSha}`));
          if (!chain.every((entry) => ['ahead', 'identical'].includes(entry.status))) {
            reject('review-outside-closure');
            continue;
          }
          // The rebased review head keeps its own (older) merge base with the current base.
          let reviewed = await read(`repos/${repo}/compare/${rebased ? pr.base.sha : mergeBase}...${review.commit_id}`);
          if (rebased && SHA.test(reviewed.merge_base_commit?.sha || '')) reviewed = await read(`repos/${repo}/compare/${reviewed.merge_base_commit.sha}...${review.commit_id}`);
          const parent = await read(`repos/${repo}/compare/${mergeBase}...${parentSha}`);
          if ((rebased ? !SHA.test(reviewed.merge_base_commit?.sha || '') : reviewed.merge_base_commit?.sha !== mergeBase)
            || parent.merge_base_commit?.sha !== mergeBase) { reject('merge-base-mismatch'); continue; }
          if (!Array.isArray(reviewed.files)
            || !Array.isArray(parent.files)) { reject('capped-file-list'); continue; }
          let originalAuthorization;
          if (superseding) {
            const proof = await originalReversalAuthorization({ repo, review, reviews, superseding, commit, reviewed, mergeBase, read, readCommit, metadata, prNumber,
              matchTrailers: recommitted });
            originalAuthorization = proof.authorization;
            if (!originalAuthorization) { reject(recommitted && !commit.reversalAppAttested
              ? 'rebased-commit-unproven' : 'original-reversal-not-proven-before-supersession', proof.detail); continue; }
            if (originalAuthorization.rebased && reversalPatchIdentity(reviewed.files) !== reversalPatchIdentity(parent.files)) {
              reject('parent-is-not-reviewed-head-rebase'); continue;
            }
          }
          reversalAuthorizations.push({ commit, review, reviewedFiles: reviewed.files, parentFiles: parent.files,
            completeFileLists: reviewed.filesComplete === true && parent.filesComplete === true && commit.filesComplete === true,
            ...(originalAuthorization ? { originalAuthorization } : {}),
            ...(rebased ? { rebased: true } : {}) });
        } catch (error) {
          if (error?.primaryChangeReadFailed === true || error?.authOutage === true
            || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || isTransientGhError(error)) throw error;
          reject(error?.code === 'COMMIT_VERIFICATION_SHA_MISMATCH' ? 'commit-provenance' : 'unverifiable');
          // A stale/deleted citation refuses only this waiver, never the whole
          // protected author diff. Later candidates can still be evaluated.
        }
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
      ...(pr.base.ref ? { baseSha: pr.base.sha, baseRef: pr.base.ref } : {}),
      ...(builderBoundary ? { builderBoundary } : {}),
      // Retain the trusted range for rename proof and refusal attribution.
      diagnosticCommitRange: history.commits.slice(history.commits.indexOf(first)).map(commit => ({ sha: commit.sha })),
      testRegionsChanged: testChanges,
      ...(renameProofs.length ? { renameProofs } : {}),
      ...(primaryPathChanges.length ? { primaryPathChanges } : {}),
      ...(renameProofReadFailed ? { renameProofReadFailed: true } : {}),
      ...(reversalAuthorizations.length ? { reversalAuthorizations } : {}),
      ...(rejectedReversalAuthorizations.length ? { rejectedReversalAuthorizations } : {}),
      completeFileLists: primary.filesComplete === true && final.filesComplete === true,
      primaryFiles: primary.files, finalFiles: final.files };
  } catch (error) {
    const message = String(error.message || error);
    return unknown(message.startsWith('history read failed:') ? message : `history read failed: ${message}`,
      { readFailed: true, historyReadFailed: true });
  }
}

// HAMPREDICATE-01: attribute a refusal after evaluation, so an unavailable
// diagnostic never becomes a new merge gate. Compare snapshots in merge-base
// coordinates: a later commit which leaves the region alone gets no attribution.
async function describeRevertedRegions(args, evidence, refusal) {
  const { repo, prNumber, get, signal } = args;
  const regions = refusal.missingEvidence.regions || [];
  const diagnostics = regions.map(region => ({ path: refusal.path, ...region, commits: [] }));
  if (!diagnostics.length) diagnostics.push({ path: refusal.path, start: null, end: null, commits: [] });
  const cache = new Map();
  const bounded = operation => {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); })
        .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  };
  const read = path => {
    signal.throwIfAborted();
    if (!cache.has(path)) cache.set(path, bounded(() => get(path)).then(result => {
      signal.throwIfAborted();
      if (Array.isArray(result?.files) && result.files.length >= 300 && result.filesComplete !== true) {
        throw new Error('diagnostic snapshot capped');
      }
      return result;
    }));
    return cache.get(path);
  };
  const signature = (files, region) => {
    if (region.start === null) return JSON.stringify(files.filter(file =>
      (file.previous_filename || file.filename) === region.path));
    return JSON.stringify(patchSegments(files, region.path, new Map()).segments
      .filter(segment => region.start === region.end
        ? segment.old <= region.start && segment.oldEnd >= region.start
          // Added files use coordinate zero in changes(), while patchSegments
          // projects their first insertion to head line one.
          || region.start === 0 && segment.old === 1 && segment.oldEnd === 1
        : segment.old < region.end && segment.oldEnd > region.start)
      .map(segment => [segment.old, segment.oldEnd, segment.lines]));
  };
  let previous = evidence.primaryFiles;
  try {
    let range = evidence.diagnosticCommitRange;
    if (!Array.isArray(range)) {
      // Older stored evidence remains valid. Fill only its missing diagnostics.
      const history = await read(`repos/${repo}/compare/${evidence.mergeBase}...${evidence.headSha}`);
      if (!Array.isArray(history.commits) || history.commits.length !== history.total_commits
        || history.merge_base_commit?.sha !== evidence.mergeBase) throw new Error('diagnostic commit range incomplete');
      const first = history.commits.findIndex(commit => commit.parents?.[0]?.sha === evidence.primaryHead);
      if (first < 0) throw new Error('diagnostic primary boundary unavailable');
      range = history.commits.slice(first);
    }
    if (!range.length) throw new Error('commit range unavailable');
    let comments, rounds;
    // Diagnostics are best effort. Bound intermediate snapshot/commit reads
    // without changing the independently computed preservation verdict.
    const maxDiagnosticCommits = 20;
    for (const entry of range.slice(0, maxDiagnosticCommits)) {
      signal.throwIfAborted();
      const snapshot = entry.sha === evidence.headSha ? { files: evidence.finalFiles, merge_base_commit: { sha: evidence.mergeBase } }
        : await read(`repos/${repo}/compare/${evidence.mergeBase}...${entry.sha}`);
      if (snapshot.merge_base_commit?.sha !== evidence.mergeBase) throw new Error('diagnostic merge base differs');
      changes(snapshot.files);
      const touched = diagnostics.filter(region => signature(previous, region) !== signature(snapshot.files, region));
      if (touched.length) {
        const commit = await read(`repos/${repo}/commits/${entry.sha}`);
        if (commit.sha !== entry.sha) throw new Error('diagnostic commit differs');
        let pipelineRepair = null, repairKind = null;
        try {
          rounds ??= await bounded(() => readCompletedRemediationRounds(primaryChangeRoot(args), repo, prNumber));
          if (rounds.some(round => round.resultingHeadSha === entry.sha)) {
            pipelineRepair = true; repairKind = 'completed remediation round';
          } else {
            comments ??= await read(`repos/${repo}/issues/${prNumber}/comments?per_page=100`);
            if (!Array.isArray(comments) || comments.length >= 100) throw new Error('diagnostic comments incomplete');
            pipelineRepair = comments.some(comment => exactHammerValidation(comment, entry.sha));
            if (pipelineRepair) repairKind = 'hammer audit';
          }
        } catch (error) {
          signal.throwIfAborted();
          if (error?.primaryChangeReadFailed === true || error?.authOutage === true
            || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || isTransientGhError(error)) throw error;
          // Unknown classification remains diagnostic only.
        }
        const attribution = { sha: entry.sha, author: commit.author?.login || commit.commit?.author?.name || null,
          pipelineRepair, repairKind };
        for (const region of touched) region.commits.push(attribution);
      }
      previous = snapshot.files;
    }
    if (range.length > maxDiagnosticCommits) throw new Error(`diagnostic commit range truncated after ${maxDiagnosticCommits} of ${range.length} commits`);
  } catch (error) {
    if (error?.primaryChangeReadFailed === true || error?.authOutage === true
      || error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || isTransientGhError(error)) throw error;
    for (const region of diagnostics) region.error = String(error.message || error);
  }
  return diagnostics;
}

// Every production primary-change read also proves the independent cost gate.
// Keep history failures distinct and retain the existing terminal-state handling.
export async function fetchPrimaryChange(args, { fetchCiCostImpl = fetchCiCost } = {}) {
  let history;
  if (args.get.persistPrimaryChange && primaryChangeStoreOwned(primaryChangeRoot(args))) {
    try {
      const pr = await args.get(`repos/${args.repo}/pulls/${args.prNumber}`);
      if (pr.head?.sha !== args.headSha || !SHA.test(pr.base?.sha || '')) {
        return { headSha: args.headSha, hasHammerCommits: null, headMismatch: true };
      }
      const comparison = await args.get.metadata(`repos/${args.repo}/compare/${pr.base.sha}...${args.headSha}`);
      if (!SHA.test(comparison.merge_base_commit?.sha || '')) throw new Error('missing merge base');
      // Reviews and dispatcher provenance can change without a head move.
      // Include them so stored finding waivers cannot survive supersession.
      const reviewsPath = `repos/${args.repo}/pulls/${args.prNumber}/reviews?per_page=100`;
      const reviews = await args.get(reviewsPath);
      const reviewKey = createHash('sha256').update(JSON.stringify(reviews)).digest('hex');
      const launchHead = readPrimaryChangeLaunchHead(primaryChangeRoot(args), args.repo, args.prNumber);
      history = await storedPrimaryChange({ ...args, rootDir: primaryChangeRoot(args),
        baseSha: pr.base.sha, mergeBase: comparison.merge_base_commit.sha, reviewKey, launchHead },
      () => fetchPrimaryChangeHistory({ ...args, get: Object.assign(
        path => path === `repos/${args.repo}/pulls/${args.prNumber}` ? Promise.resolve(pr) : path === reviewsPath ? Promise.resolve(reviews) : args.get(path),
        { metadata: args.get.metadata, commitVerification: args.get.commitVerification }) }));
    } catch (error) {
      return { headSha: args.headSha, hasHammerCommits: null, readFailed: true, historyReadFailed: true, reason: String(error.message).startsWith('history read failed:') ? error.message : `history read failed: ${error.message}` };
    }
  } else history = await fetchPrimaryChangeHistory(args);
  if (![true, false].includes(history.hasHammerCommits) || history.headMismatch) return history;
  const ciCost = await fetchCiCostImpl({ ...args, get: path =>
    args.get.metadata && path.includes('/compare/') ? args.get.metadata(path) : args.get(path) });
  const guardEvidence = await fetchGuardReversals(args, history);
  const evidence = { ...history, ciCost, ...guardEvidence };
  return { ...evidence, ...await fetchGuardReviewSnapshots(args, evidence) };
}

// Explicit operator context only. Merge-authority callers use fetchPrimaryChange
// and never pay for diagnostic snapshots, even when a refused head is reused.
export async function fetchPrimaryChangeContext(args, {
  strictNonBlockingRemediation = false, diagnosticTimeoutMs = 15000,
  createDiagnosticReaderImpl = createHistoryReader, ...options
} = {}) {
  const evidence = await fetchPrimaryChange(args, options);
  const refusal = checkPrimaryChange(evidence, args.headSha, { strictNonBlockingRemediation });
  if (refusal.reason !== 'primary-change-reverted') return evidence;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException('diagnostic time budget exhausted', 'TimeoutError')), diagnosticTimeoutMs);
  const signal = args.signal ? AbortSignal.any([args.signal, deadline.signal]) : deadline.signal;
  try {
    evidence.revertedRegionDiagnostics = await describeRevertedRegions({ ...args, signal,
      get: createDiagnosticReaderImpl({ signal }) }, evidence, refusal);
    args.signal?.throwIfAborted();
    return evidence;
  } finally { clearTimeout(timer); }
}
