/**
 * AMA-04 — provenance trailers + audit JSON writer.
 *
 * Implements the §4.4 state machine of
 * `projects/adversarial-merge-authority/SPEC.md`. The audit record is a
 * watcher-owned durable per-`(repo, prNumber, headSha)` JSON document
 * stored at:
 *
 *   `$HQ_ROOT/dispatch/audit/adversarial-merge-authority/<repo>-pr-<n>-<head>.json`
 *
 * State machine:
 *
 *   in_progress
 *      │  attempt outcome = "deferred"
 *      ├─────▶ deferred  ─┐
 *      │  attempt outcome = "superseded"
 *      ├─────▶ superseded ─┤  (further attempts may resume)
 *      │  attempt outcome = "succeeded"
 *      ├─────▶ succeeded   (TERMINAL — STICKY)
 *      │  attempt outcome = "failed-without-merge"
 *      └─────▶ failed-without-merge
 *
 * Rules:
 *
 *   - `appendAmaAuditAttempt` appends an immutable entry to
 *     `attempts[]` and recomputes `status` from the *latest* attempt's
 *     outcome, NOT from a vote across history. Per SPEC §4.4 state rule
 *     #2, the attempt array preserves retry history; the surface
 *     `status` is the watcher's view of the *current* closure
 *     authority.
 *   - `succeeded` is sticky. Once a single attempt has outcome
 *     `succeeded`, the writer refuses to demote to
 *     `failed-without-merge` (SPEC §4.4 rule #5: "No terminal failure
 *     state is based solely on the CLI exit code, and a normal
 *     pre-merge defer never becomes failed-without-merge"). A retry
 *     attempt with outcome `deferred` after `succeeded` is also
 *     refused — the audit's terminal-succeeded surface is the
 *     contract, and downstream repair logic (SPEC §4.4 rule #7)
 *     reconciles from fresh GitHub state, not from the record.
 *   - `deferred` and `superseded` are NOT terminal failures (SPEC
 *     §4.4 rule #3 + the audit status enum). Subsequent attempts may
 *     append and transition the surface status.
 *   - Atomic writes go through `writeFileAtomic` (tmp + rename) at
 *     mode 0640.
 *
 * @module ama/audit
 */

import { join } from 'node:path';

import { writeFileAtomic } from '../atomic-write.mjs';
import { readFileSync, statSync } from 'node:fs';

const AUDIT_FILE_MODE = 0o640;

/** Outcomes a single attempt can record. */
const VALID_ATTEMPT_OUTCOMES = new Set([
  'in_progress',
  'deferred',
  'superseded',
  'succeeded',
  'failed-without-merge',
]);

/**
 * State surface enum — what the audit's `status` field can hold.
 * Same string set as the attempt outcomes by design (SPEC §4.4): the
 * surface mirrors the latest attempt's outcome with the
 * sticky-succeeded carve-out applied.
 */
const VALID_AUDIT_STATUSES = new Set([
  'in_progress',
  'deferred',
  'superseded',
  'succeeded',
  'failed-without-merge',
]);

/**
 * Resolve the on-disk audit path for a `(repo, prNumber, headSha)`
 * tuple. The slash in `<owner>/<name>` is collapsed to `-` so each
 * record is a single filename and `ls`-able.
 *
 * @param {string} hqRoot     Absolute path to the HQ root.
 * @param {string} repo       `<owner>/<name>` form.
 * @param {number} prNumber   PR number.
 * @param {string} headSha    Authorized head SHA.
 * @returns {string}          Absolute file path.
 */
export function amaAuditFilePath(hqRoot, repo, prNumber, headSha) {
  if (!hqRoot) throw new Error('amaAuditFilePath: hqRoot is required');
  if (!repo) throw new Error('amaAuditFilePath: repo is required');
  if (!Number.isFinite(Number(prNumber))) {
    throw new Error('amaAuditFilePath: prNumber must be numeric');
  }
  if (!headSha) throw new Error('amaAuditFilePath: headSha is required');
  const safeRepo = String(repo).replace(/\//g, '-');
  return join(
    hqRoot,
    'dispatch',
    'audit',
    'adversarial-merge-authority',
    `${safeRepo}-pr-${Number(prNumber)}-${String(headSha)}.json`,
  );
}

/**
 * Derive the surface `status` from an attempts array per SPEC §4.4.
 *
 * Rule order:
 *
 *   1. If any prior attempt has outcome `succeeded` → `succeeded`
 *      (sticky; the writer refuses to demote downstream).
 *   2. Otherwise, the LATEST attempt's outcome wins.
 *   3. If the attempts array is empty, the status is `in_progress`
 *      (the initial state the watcher writes before dispatch).
 *
 * @param {Array<object>} attempts
 * @returns {string}
 */
function deriveStatus(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return 'in_progress';
  }
  // Sticky-succeeded check across history.
  const everSucceeded = attempts.some(
    (a) => String(a?.outcome || '').toLowerCase() === 'succeeded',
  );
  if (everSucceeded) {
    return 'succeeded';
  }
  const latestOutcome = String(attempts[attempts.length - 1]?.outcome || '')
    .toLowerCase()
    .trim();
  if (!VALID_AUDIT_STATUSES.has(latestOutcome)) {
    return 'in_progress';
  }
  return latestOutcome;
}

/**
 * Validate a single attempt entry. Throws on missing `outcome` or an
 * outcome not in the canonical enum — the prompt's "Don't add outcomes
 * not in the §4.4 list" contract.
 */
function validateAttempt(attempt) {
  if (!attempt || typeof attempt !== 'object') {
    throw new TypeError('attempt must be an object');
  }
  const outcome = String(attempt.outcome || '').toLowerCase().trim();
  if (!VALID_ATTEMPT_OUTCOMES.has(outcome)) {
    throw new RangeError(
      `attempt.outcome '${attempt.outcome}' is not in the §4.4 enum ` +
      `(${[...VALID_ATTEMPT_OUTCOMES].join('|')})`,
    );
  }
}

/**
 * Read an existing audit doc from disk. Returns `null` if absent.
 * Wrapped here so the writer can branch on first-create vs append
 * without leaking fs error shapes.
 */
function readExisting(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Build the initial `in_progress` audit document the watcher writes
 * before dispatching a closer. The `attempt` argument is the watcher's
 * initial attempt entry (typically `outcome: "in_progress"` with
 * eligibility evidence).
 *
 * @param {object} args
 * @param {string} args.hqRoot
 * @param {string} args.repo
 * @param {number} args.prNumber
 * @param {string} args.headSha
 * @param {object} args.attempt   Attempt entry per SPEC §4.4 (outcome required).
 * @param {string=} args.now      ISO timestamp for `createdAt` / `updatedAt`. Caller-provided so the writer stays deterministic for tests.
 * @returns {{ filePath: string, doc: object }}
 */
export function writeAmaAuditEntry({
  hqRoot,
  repo,
  prNumber,
  headSha,
  attempt,
  now,
}) {
  validateAttempt(attempt);
  const filePath = amaAuditFilePath(hqRoot, repo, prNumber, headSha);
  const timestamp = now || new Date().toISOString();
  const attempts = [{ attemptNumber: 1, startedAt: timestamp, ...attempt }];
  const doc = {
    schemaVersion: 1,
    repo,
    prNumber: Number(prNumber),
    headSha,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: deriveStatus(attempts),
    attempts,
  };
  writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`, {
    mode: AUDIT_FILE_MODE,
  });
  return { filePath, doc };
}

/**
 * Append an attempt entry to an existing audit doc, recompute the
 * surface `status`, and atomically rewrite. Per SPEC §4.4:
 *
 *   - The attempts array is immutable — each new attempt appends; no
 *     prior entry is mutated.
 *   - Status `succeeded` is sticky. A `failed-without-merge` or
 *     `deferred` attempt after `succeeded` is refused with a thrown
 *     error so the regression surfaces at the writer rather than
 *     getting silently absorbed.
 *
 * If the file does not exist yet, this throws — the watcher's flow is
 * `writeAmaAuditEntry` first (the `in_progress` record) and
 * `appendAmaAuditAttempt` for every subsequent closer attempt.
 *
 * @param {object} args
 * @param {string} args.hqRoot
 * @param {string} args.repo
 * @param {number} args.prNumber
 * @param {string} args.headSha
 * @param {object} args.attempt
 * @param {string=} args.now
 * @returns {{ filePath: string, doc: object }}
 */
export function appendAmaAuditAttempt({
  hqRoot,
  repo,
  prNumber,
  headSha,
  attempt,
  now,
}) {
  validateAttempt(attempt);
  const filePath = amaAuditFilePath(hqRoot, repo, prNumber, headSha);
  const existing = readExisting(filePath);
  if (!existing) {
    throw new Error(
      `appendAmaAuditAttempt: no existing record at ${filePath} — ` +
      `call writeAmaAuditEntry first`,
    );
  }

  const currentStatus = String(existing.status || '').toLowerCase();
  const nextOutcome = String(attempt.outcome || '').toLowerCase();

  // Sticky-succeeded refusal. SPEC §4.4 rule #5: terminal succeeded
  // can't regress to failed-without-merge based on CLI exit codes,
  // and a normal pre-merge defer never becomes failed-without-merge.
  if (currentStatus === 'succeeded' && nextOutcome !== 'succeeded') {
    throw new Error(
      `appendAmaAuditAttempt: refusing to demote terminal 'succeeded' ` +
      `to '${nextOutcome}' for ${repo} pr#${prNumber} head=${headSha}. ` +
      `If a post-merge GitHub repair changed the observed state, write a ` +
      `new record at the new (pr, headSha) keyed for the new head.`,
    );
  }

  const timestamp = now || new Date().toISOString();
  const attemptNumber = (existing.attempts?.length || 0) + 1;
  const attempts = [
    ...(Array.isArray(existing.attempts) ? existing.attempts : []),
    { attemptNumber, startedAt: timestamp, ...attempt },
  ];
  const doc = {
    ...existing,
    updatedAt: timestamp,
    status: deriveStatus(attempts),
    attempts,
  };
  writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`, {
    mode: AUDIT_FILE_MODE,
  });
  return { filePath, doc };
}

/**
 * Compose the SPEC §4.4 provenance trailers as a string the closer
 * worker pipes to `gh pr merge --body-from-stdin` (or its equivalent
 * for `merge_method: merge`).
 *
 * Trailers are byte-for-byte the SPEC §4.4 list:
 *
 *   Closed-By: <workerClass>-closer (adversarial-pipe-mode)
 *   Reviewed-By: <reviewerFamily>
 *   Risk-Class: <riskClass>
 *   Eligibility-Reason: <eligibilityReason>
 *   Eligibility-Trace: <auditPath>
 *
 * Each value is stripped of CR/LF before assembly — defense against a
 * malformed reviewer login or operator-supplied eligibility reason
 * leaking into the trailer block (same shape the existing
 * worker-provenance commit-msg hook refuses, per CLAUDE.md
 * §"Commit-msg provenance hook").
 *
 * @param {object} args
 * @param {string} args.workerClass       e.g. "codex" or "claude-code"
 * @param {string} args.reviewerFamily    reviewer bot login (e.g. "claude-reviewer-lacey")
 * @param {string} args.riskClass         resolved risk class
 * @param {string} args.eligibilityReason short human summary, one line
 * @param {string} args.auditPath         absolute path to the audit JSON
 * @returns {string} trailer block; lines joined by `\n`, no trailing newline.
 */
export function composeAmaTrailers({
  workerClass,
  reviewerFamily,
  riskClass,
  eligibilityReason,
  auditPath,
}) {
  const sanitize = (value, label) => {
    const str = String(value ?? '');
    if (/[\r\n]/.test(str)) {
      throw new Error(
        `composeAmaTrailers: ${label} value contains CR/LF; refusing ` +
        `to compose a trailer block with a line-break injection`,
      );
    }
    return str.trim();
  };
  const lines = [
    `Closed-By: ${sanitize(workerClass, 'workerClass')}-closer (adversarial-pipe-mode)`,
    `Reviewed-By: ${sanitize(reviewerFamily, 'reviewerFamily')}`,
    `Risk-Class: ${sanitize(riskClass, 'riskClass')}`,
    `Eligibility-Reason: ${sanitize(eligibilityReason, 'eligibilityReason')}`,
    `Eligibility-Trace: ${sanitize(auditPath, 'auditPath')}`,
  ];
  return lines.join('\n');
}

/**
 * Test helper — returns the on-disk file mode of an audit file. Used
 * by the atomic-write integration test to assert 0640.
 *
 * @param {string} filePath
 * @returns {number} file mode bits (e.g. 0o640).
 */
export function readAuditFileMode(filePath) {
  return statSync(filePath).mode & 0o777;
}
