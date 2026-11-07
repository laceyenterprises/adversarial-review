// REVIEWCARRY-01: carry a settled review across a head change that leaves the
// PR's own patch unchanged except for declared generated paths.
//
// Problem: a PR with a settled, clean review was rebased only to resolve
// conflicts in generated files (a fingerprint fixture, a generated catalog).
// The reviewed SHA left the branch, the pipeline read the PR as unreviewed
// (`stale-review-head`), and a full review → strict remediation → new head
// cycle started again although the PR's own change was identical.
//
// Rule: when the head moves, the latest settled review carries forward to the
// new head ONLY when all of these hold:
//   1. the review verdict is `comment-only` or `approved`, its blocking
//      findings are known and zero, and no remediation is pending for it;
//   2. the PR's own patch (diff vs. its merge base) at the new head equals the
//      patch at the reviewed head after excluding the declared generated paths,
//      compared as a normalized diff (hunk line numbers dropped, content and
//      whitespace kept exactly);
//   3. that remaining patch is non-empty and fully readable (no truncated or
//      binary non-generated file, no capped file list);
//   4. the new merge base descends from the reviewed merge base (a branch reset
//      onto an older base never inherits a review).
// Anything else keeps today's behaviour: an exact-head re-review.
//
// The generated list is the host repository's declaration,
// `.adversarial-review/generated-paths`, read from the PR's BASE commit, never
// from the PR head: a PR cannot declare its own files generated. A caller may
// pass an explicit list instead. Patterns are root-anchored globs; a pattern
// that could match the declaration itself, a catch-all, or a negation is
// refused. The declaration file is therefore always part of the compared patch.
//
// A carry-forward is recorded once per (PR, new head) under
// `data/review-carry-forward/`, naming both SHAs, the excluded patterns and the
// generated paths that differed. Closers read that record: it carries the
// reviewed verdict only for the exact (reviewed head, current head) pair it
// names, and every other merge predicate (CI on the exact head, mergeability,
// blockers, live review reconcile) still applies.
//
// This module imports only Node built-ins and the atomic writer so it stays
// cheap to load from watcher and closer consumers.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

export const GENERATED_PATHS_DECLARATION = '.adversarial-review/generated-paths';
export const REVIEW_CARRY_FORWARD_PROOF = 'own-patch-equal-excluding-generated-paths';
export const REVIEW_CARRY_FORWARD_REASON = 'review-carried-forward';
export const REVIEW_CARRY_FORWARD_EVENT = 'review_carried_forward_generated_only';
const RECORD_SCHEMA_VERSION = 1;
const SHA = /^[0-9a-f]{40}$/i;
const BASE_REF = /^[\w][\w./-]{0,254}$/;
const CARRYABLE_VERDICTS = new Set(['comment-only', 'approved']);
// GitHub's compare endpoint lists at most 300 files; a full page is not proof.
const COMPARE_FILE_CAP = 300;
const MAX_PATTERNS = 200;
const MAX_PATTERN_LENGTH = 256;

function sha(value) {
  return String(value || '').trim();
}

function escapeRegExp(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

// Root-anchored glob: `**` crosses directories, `*` and `?` stay inside one
// path segment, a trailing `/` names a whole directory.
function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function normalizePattern(raw) {
  let pattern = String(raw || '').trim();
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  if (pattern.endsWith('/')) pattern = `${pattern}**`;
  return pattern;
}

/**
 * Parse a generated-paths declaration (or an explicit list). One root-anchored
 * glob per line; `#` starts a comment. Refused patterns are reported, never
 * silently widened.
 */
export function parseGeneratedPathsDeclaration(input) {
  const lines = Array.isArray(input) ? input : String(input || '').split(/\r?\n/);
  const patterns = [];
  const rejected = [];
  for (const line of lines) {
    const raw = String(line || '').replace(/(^|\s)#.*$/, '').trim();
    if (!raw) continue;
    const pattern = normalizePattern(raw);
    let reason = null;
    if (pattern.length > MAX_PATTERN_LENGTH) reason = 'pattern-too-long';
    else if (raw.startsWith('!')) reason = 'negation-unsupported';
    else if (/\\/.test(pattern) || pattern.split('/').some(part => part === '..' || part === '.')) reason = 'unsafe-path';
    else if (/^[*/?]+$/.test(pattern)) reason = 'catch-all';
    else if (globToRegExp(pattern).test(GENERATED_PATHS_DECLARATION)) reason = 'matches-declaration';
    if (reason) rejected.push({ pattern: raw, reason });
    else if (!patterns.includes(pattern)) patterns.push(pattern);
  }
  if (patterns.length > MAX_PATTERNS) {
    for (const pattern of patterns.splice(MAX_PATTERNS)) rejected.push({ pattern, reason: 'too-many-patterns' });
  }
  return { patterns, rejected };
}

export function compileGeneratedPathMatcher(patterns) {
  const compiled = (Array.isArray(patterns) ? patterns : []).map(globToRegExp);
  return (path) => {
    const value = String(path || '');
    if (!value || value === GENERATED_PATHS_DECLARATION) return false;
    return compiled.some(regex => regex.test(value));
  };
}

// Drop hunk headers (line numbers and the function-context hint), keep every
// content line byte-for-byte. A base change next to the PR's hunk changes the
// context lines and so refuses the carry: conservative by construction.
function normalizeFilePatch(patch) {
  return String(patch).split('\n').filter(line => !line.startsWith('@@')).join('\n');
}

/**
 * Normalize one side's own-patch file list (GitHub compare `files[]` shape) into
 * its non-generated entries. A file counts as generated only when both its
 * current and previous paths match. Fails closed on a capped list or on a
 * non-generated file whose patch GitHub did not return (binary or too large).
 */
export function normalizeOwnPatch(files, { isGenerated } = {}) {
  if (!Array.isArray(files)) return { complete: false, reason: 'file-list-missing' };
  if (files.length >= COMPARE_FILE_CAP) return { complete: false, reason: 'file-list-capped' };
  const generated = typeof isGenerated === 'function' ? isGenerated : () => false;
  const entries = [];
  const excludedPaths = [];
  for (const file of files) {
    const filename = String(file?.filename || '');
    if (!filename) return { complete: false, reason: 'file-entry-invalid' };
    const previous = file?.previous_filename ? String(file.previous_filename) : null;
    if (generated(filename) && (!previous || generated(previous))) {
      excludedPaths.push(filename);
      continue;
    }
    const status = String(file?.status || '');
    const changes = Number(file?.changes || 0);
    if (typeof file?.patch !== 'string' && (changes > 0 || !['renamed', 'changed', 'unchanged'].includes(status))) {
      return { complete: false, reason: 'patch-unavailable', path: filename };
    }
    entries.push({ filename, previous, status, patch: typeof file?.patch === 'string' ? normalizeFilePatch(file.patch) : '' });
  }
  entries.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { complete: true, entries, excludedPaths: excludedPaths.sort(), digest };
}

async function readDeclaration({ repo, ref, get }) {
  try {
    const body = await get(`repos/${repo}/contents/${GENERATED_PATHS_DECLARATION}?ref=${ref}`);
    if (body?.type !== 'file' || typeof body?.content !== 'string' || body?.encoding !== 'base64') {
      throw new Error('declaration is not a readable file');
    }
    return Buffer.from(body.content, 'base64').toString('utf8');
  } catch (error) {
    // Absent declaration = no generated paths (the exact-patch carry still
    // applies). Any other read failure is missing proof.
    if (/\b404\b|not found/i.test(`${error?.message || ''} ${error?.stderr || ''}`)) return '';
    throw error;
  }
}

/**
 * Prove (or refuse) that `currentHead` carries `reviewedHead`'s own patch,
 * modulo declared generated paths. `get(path)` returns parsed GitHub REST JSON.
 * Never throws: every failure is a refusal with a reason.
 */
export async function proveReviewCarryForward({
  repo, reviewedHead, currentHead, baseRef, get, generatedPaths = undefined,
} = {}) {
  const reviewed = sha(reviewedHead);
  const current = sha(currentHead);
  const base = sha(baseRef);
  const result = { proven: false, proof: REVIEW_CARRY_FORWARD_PROOF, reviewedHead: reviewed || null,
    currentHead: current || null, baseRef: base || null };
  if (!SHA.test(reviewed) || !SHA.test(current) || !BASE_REF.test(base) || base.includes('..')) {
    return { ...result, reason: 'head-or-base-invalid' };
  }
  if (reviewed === current) return { ...result, reason: 'not-stale' };
  if (!repo || typeof get !== 'function') return { ...result, reason: 'reader-unavailable' };
  try {
    const reviewedCompare = await get(`repos/${repo}/compare/${base}...${reviewed}`);
    const currentCompare = await get(`repos/${repo}/compare/${base}...${current}`);
    const reviewedFork = sha(reviewedCompare?.merge_base_commit?.sha);
    const currentFork = sha(currentCompare?.merge_base_commit?.sha);
    const forks = { ...result, reviewedMergeBase: reviewedFork || null, currentMergeBase: currentFork || null };
    if (!SHA.test(reviewedFork) || !SHA.test(currentFork)) return { ...forks, reason: 'merge-base-unknown' };
    if (reviewedFork !== currentFork) {
      const ancestry = await get(`repos/${repo}/compare/${reviewedFork}...${currentFork}`);
      if (!['ahead', 'identical'].includes(ancestry?.status)) return { ...forks, reason: 'merge-base-not-forward' };
    }
    // The declaration is read at the new merge base: a base-branch commit the
    // PR cannot author, so the PR cannot declare its own files generated.
    const declaration = generatedPaths === undefined
      ? { source: GENERATED_PATHS_DECLARATION,
        ...parseGeneratedPathsDeclaration(await readDeclaration({ repo, ref: currentFork, get })) }
      : { source: 'explicit', ...parseGeneratedPathsDeclaration(generatedPaths) };
    const isGenerated = compileGeneratedPathMatcher(declaration.patterns);
    const withFacts = { ...forks, generatedPathsSource: declaration.source,
      excludedPatterns: declaration.patterns, rejectedPatterns: declaration.rejected };
    const reviewedPatch = normalizeOwnPatch(reviewedCompare?.files, { isGenerated });
    const currentPatch = normalizeOwnPatch(currentCompare?.files, { isGenerated });
    if (!reviewedPatch.complete) return { ...withFacts, reason: `reviewed-patch-${reviewedPatch.reason}` };
    if (!currentPatch.complete) return { ...withFacts, reason: `current-patch-${currentPatch.reason}` };
    const excludedPathsChanged = [...new Set([...reviewedPatch.excludedPaths, ...currentPatch.excludedPaths])].sort();
    const facts = { ...withFacts, ownPatchDigest: currentPatch.digest, reviewedOwnPatchDigest: reviewedPatch.digest,
      excludedPathsChanged };
    if (reviewedPatch.entries.length === 0) return { ...facts, reason: 'own-patch-empty' };
    if (reviewedPatch.digest !== currentPatch.digest) {
      const changed = new Set();
      const byName = new Map(reviewedPatch.entries.map(entry => [entry.filename, JSON.stringify(entry)]));
      for (const entry of currentPatch.entries) {
        if (byName.get(entry.filename) !== JSON.stringify(entry)) changed.add(entry.filename);
        byName.delete(entry.filename);
      }
      for (const name of byName.keys()) changed.add(name);
      return { ...facts, reason: 'own-patch-changed', changedPaths: [...changed].sort() };
    }
    return { ...facts, proven: true, reason: 'own-patch-equal' };
  } catch (error) {
    return { ...result, reason: 'proof-read-failed', detail: String(error?.message || error).slice(0, 300) };
  }
}

/**
 * The carry predicate. Pure. `settledReview` is the reviewed head's settled
 * review as resolved by the gate snapshot (`verdict`, `blockingFindingState`,
 * `blockingFindingCount`, `remediationPending`).
 */
export function decideReviewCarryForward({ settledReview, proof } = {}) {
  const reasons = [];
  const verdict = String(settledReview?.verdict || '').trim().toLowerCase();
  if (!CARRYABLE_VERDICTS.has(verdict)) reasons.push('verdict-not-settled-clean');
  const blockingState = String(settledReview?.blockingFindingState || 'unknown').trim().toLowerCase();
  const blockingCount = Number(settledReview?.blockingFindingCount);
  if (blockingState !== 'known' || !Number.isFinite(blockingCount)) reasons.push('blocking-findings-unknown');
  else if (blockingCount > 0) reasons.push('blocking-findings-present');
  if (settledReview?.remediationPending !== false) reasons.push('remediation-pending-or-unknown');
  if (proof?.proven !== true) reasons.push(proof?.reason || 'carry-forward-proof-missing');
  return { carry: reasons.length === 0, reasons };
}

function slug(repo) {
  return String(repo || '').replace(/[^A-Za-z0-9._-]+/g, '__');
}

export function reviewCarryForwardRecordPath(rootDir, { repo, prNumber, currentHead } = {}) {
  return join(rootDir, 'data', 'review-carry-forward', `${slug(repo)}-pr-${Number(prNumber)}-${sha(currentHead)}.json`);
}

/** Write the auditable record once per (PR, new head). Best-effort for callers. */
export function writeReviewCarryForwardRecord(rootDir, {
  repo, prNumber, proof, settledReview, recordedAt = new Date().toISOString(),
} = {}) {
  const currentHead = sha(proof?.currentHead);
  if (!rootDir || !repo || !Number.isSafeInteger(Number(prNumber)) || proof?.proven !== true || !SHA.test(currentHead)) {
    return { written: false, reason: 'not-proven' };
  }
  const path = reviewCarryForwardRecordPath(rootDir, { repo, prNumber, currentHead });
  const record = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    event: REVIEW_CARRY_FORWARD_EVENT,
    repo,
    prNumber: Number(prNumber),
    reviewedHead: proof.reviewedHead,
    currentHead,
    baseRef: proof.baseRef,
    reviewedMergeBase: proof.reviewedMergeBase,
    currentMergeBase: proof.currentMergeBase,
    proof: REVIEW_CARRY_FORWARD_PROOF,
    ownPatchDigest: proof.ownPatchDigest,
    generatedPathsSource: proof.generatedPathsSource,
    excludedPatterns: proof.excludedPatterns || [],
    excludedPathsChanged: proof.excludedPathsChanged || [],
    carriedVerdict: String(settledReview?.verdict || '').toLowerCase() || null,
    blockingFindingCount: Number(settledReview?.blockingFindingCount ?? 0),
    nonBlockingFindingCount: Number(settledReview?.nonBlockingFindingCount ?? 0),
    recordedAt,
  };
  try {
    mkdirSync(join(rootDir, 'data', 'review-carry-forward'), { recursive: true });
    writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`, { overwrite: false });
    return { written: true, path, record };
  } catch (error) {
    if (error?.code === 'EEXIST') return { written: false, reason: 'already-recorded', path };
    return { written: false, reason: 'record-write-failed', path, detail: String(error?.message || error) };
  }
}

/**
 * Read the record that carries `reviewedHead`'s verdict to `currentHead`.
 * Returns null unless the record names exactly that pair with a clean carried
 * verdict; a missing, malformed or mismatched record is no carry-forward.
 */
export function readReviewCarryForwardRecord(rootDir, { repo, prNumber, reviewedHead, currentHead } = {}) {
  const reviewed = sha(reviewedHead);
  const current = sha(currentHead);
  if (!rootDir || !repo || !SHA.test(reviewed) || !SHA.test(current) || reviewed === current) return null;
  let record;
  try {
    record = JSON.parse(readFileSync(reviewCarryForwardRecordPath(rootDir, { repo, prNumber, currentHead: current }), 'utf8'));
  } catch {
    return null;
  }
  const valid = record?.schemaVersion === RECORD_SCHEMA_VERSION
    && record.event === REVIEW_CARRY_FORWARD_EVENT
    && record.proof === REVIEW_CARRY_FORWARD_PROOF
    && record.repo === repo && record.prNumber === Number(prNumber)
    && record.reviewedHead === reviewed && record.currentHead === current
    && CARRYABLE_VERDICTS.has(record.carriedVerdict) && record.blockingFindingCount === 0
    && Array.isArray(record.excludedPatterns) && Array.isArray(record.excludedPathsChanged);
  return valid ? record : null;
}

/**
 * Closer head-proof shape for a recorded carry-forward, consumed by the shared
 * `closerAuthoredStaleEligible` predicate. It carries no closer commits; the
 * predicate still requires a settled clean verdict, zero blockers, exact-head
 * green CI and resolved mergeability.
 */
export function reviewCarryForwardHeadProof(record) {
  if (!record) return null;
  return { proven: true, reviewedHead: record.reviewedHead, currentHead: record.currentHead,
    anchorHead: record.reviewedHead, closerCommits: [], reason: REVIEW_CARRY_FORWARD_REASON,
    reviewCarryForward: { excludedPatterns: record.excludedPatterns,
      excludedPathsChanged: record.excludedPathsChanged, recordedAt: record.recordedAt } };
}

async function defaultGet(path) {
  // An absent test collaborator is missing evidence, never live GitHub I/O.
  if (process.env.NODE_TEST_CONTEXT) throw new Error('live GitHub reads are disabled under node:test');
  const { execGhWithRetry } = await import('./gh-cli.mjs');
  const { stdout } = await execGhWithRetry({ args: ['api', path] });
  return JSON.parse(stdout);
}

/**
 * Watcher entry point: the posted review on `reviewRow.reviewer_head_sha` is
 * stale against `currentHead`. Returns `{ carried, record?, reasons }`. Reads
 * the existing record first so a carried head costs no GitHub call per tick.
 */
export async function resolveReviewCarryForward({
  rootDir, repo, prNumber, reviewedHead, currentHead, baseRef, settledReview,
  get = defaultGet, generatedPaths = undefined, logger = console,
} = {}) {
  const existing = readReviewCarryForwardRecord(rootDir, { repo, prNumber, reviewedHead, currentHead });
  if (existing) return { carried: true, record: existing, reasons: [] };
  const precheck = decideReviewCarryForward({ settledReview, proof: { proven: true } });
  if (!precheck.carry) return { carried: false, reasons: precheck.reasons };
  const proof = await proveReviewCarryForward({ repo, reviewedHead, currentHead, baseRef, get, generatedPaths });
  const decision = decideReviewCarryForward({ settledReview, proof });
  if (!decision.carry) return { carried: false, reasons: decision.reasons, proof };
  const written = writeReviewCarryForwardRecord(rootDir, { repo, prNumber, proof, settledReview });
  const record = written.record || readReviewCarryForwardRecord(rootDir, { repo, prNumber, reviewedHead, currentHead });
  if (!record) {
    logger?.warn?.(`[review-carry-forward] record unavailable for ${repo}#${prNumber}@${sha(currentHead).slice(0, 12)}: `
      + `${written.reason}${written.detail ? ` ${written.detail}` : ''}; not carrying forward`);
    return { carried: false, reasons: [written.reason || 'record-unavailable'], proof };
  }
  logger?.log?.(`[review-carry-forward] ${repo}#${prNumber}: settled ${record.carriedVerdict} review on `
    + `${record.reviewedHead.slice(0, 12)} carried to ${record.currentHead.slice(0, 12)}; own patch unchanged; `
    + `generated paths changed: ${record.excludedPathsChanged.length ? record.excludedPathsChanged.join(', ') : 'none'}`);
  return { carried: true, record, reasons: [] };
}

/**
 * Watcher seam: true when the stale posted review was carried forward and the
 * automatic re-review of `currentHead` must not be requested. Any failure is
 * false, which leaves today's re-review behaviour in place.
 */
export async function carryStalePostedReviewForward({
  rootDir, repo, prNumber, reviewRow, currentHead, baseRef, resolveSettledReview,
  resolveImpl = resolveReviewCarryForward, logger = console, ...options
} = {}) {
  try {
    const reviewedHead = sha(reviewRow?.reviewer_head_sha);
    if (!SHA.test(reviewedHead) || !SHA.test(sha(currentHead)) || reviewedHead === sha(currentHead)) return false;
    const settledReview = typeof resolveSettledReview === 'function' ? await resolveSettledReview() : null;
    const result = await resolveImpl({ rootDir, repo, prNumber, reviewedHead, currentHead, baseRef,
      settledReview, logger, ...options });
    return result?.carried === true;
  } catch (error) {
    logger?.warn?.(`[review-carry-forward] ${repo}#${prNumber}: carry-forward check failed; `
      + `re-review proceeds: ${error?.message || error}`);
    return false;
  }
}
