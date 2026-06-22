#!/usr/bin/env node
/**
 * Operator re-arm for a stuck quota-held / quota-exhausted reviewer row.
 *
 * Mirrors the dispatch-lane `hq fleet quota nudge`: when a `[claude-code]` (or
 * any) PR's reviewer hit a hard provider usage cap, the watcher holds the review
 * until the cap window clears (HRR graceful degradation). If the captured reset
 * was wrong/absent, or the operator knows the provider has already recovered and
 * wants the review re-attempted NOW, this clears the quota hold state and resets
 * the bounded infra auto-recover budget so the watcher re-reviews on the next
 * poll.
 *
 * It deliberately ONLY operates on failed rows whose stored failure is
 * quota-class (`[quota-exhausted]` failure_message, or a parked quota row
 * carrying a quota_reset_at_utc). Use `--force` to re-arm a failed row whose
 * failure is no longer quota-tagged (e.g. after operator-verified evidence was
 * lost), but force never re-arms posted/malformed/backoff rows.
 *
 * Effect (single UPDATE): review_status -> 'pending', clears failed_at /
 * failure_message / quota_reset_at_utc, resets infra_auto_recover_attempts -> 0,
 * clears the reviewer lease. The next watcher poll claims it as a normal pending
 * review.
 *
 * Exit codes:
 *   0   re-armed (or already pending — nothing to do)
 *   1   refused (row missing, PR not open, not failed/recoverable, not a quota
 *       row without --force, or a reviewer is currently in flight)
 *   2   usage error
 *   4   runtime error
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import {
  ensureReviewStateSchema,
  getReviewRow,
  openReviewStateDb,
} from '../src/review-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT_DIR = resolve(__dirname, '..');

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
const EXIT_RUNTIME = 4;

const USAGE = `\
Usage:
  node bin/quota-rearm.mjs --repo <owner/repo> --pr <number> [options]

Force-retry a reviewer row stuck on an HRR quota hold (provider usage cap):
clears the quota hold state + resets the infra auto-recover budget so the
watcher re-reviews the PR on its next poll.

Required:
  --repo <owner/repo>   Repository slug
  --pr <number>         Pull request number

Optional:
  --force               Re-arm a failed row even if its failure is no longer quota-tagged
  --root-dir <path>     Tool root containing data/reviews.db (default: repo root)
  --json                Emit machine-readable JSON outcome
  -h, --help            Show this help text
`;

class UsageError extends Error {}

// Pure predicate: is this stored row a quota-class hold/failure we should re-arm?
// A row qualifies when its failure_message is quota-tagged OR it carries a
// captured quota_reset_at_utc (a parked quota hold). `force` bypasses the check.
function isQuotaRearmEligible(row, { force = false } = {}) {
  if (!row) return false;
  if (force) return true;
  const message = String(row.failure_message || '').toLowerCase();
  if (message.startsWith('[quota-exhausted]')) return true;
  if (row.quota_reset_at_utc && String(row.quota_reset_at_utc).trim() !== '') return true;
  return false;
}

function hasReviewerProcessEvidence(row) {
  if (!row) return false;
  return Boolean(
    String(row.reviewer_session_uuid || '').trim()
      || String(row.reviewer_started_at || '').trim()
      || row.reviewer_pgid !== null && row.reviewer_pgid !== undefined && String(row.reviewer_pgid).trim() !== ''
      || String(row.reviewer_lease_expires_at || '').trim()
  );
}

// Pure decision over the row state. Returns { action, reason }.
//   action: 'rearm' | 'noop-already-pending' | 'refuse'
function planQuotaRearm(row, { force = false } = {}) {
  if (!row) return { action: 'refuse', reason: 'review-row-missing' };
  if (row.pr_state !== 'open') return { action: 'refuse', reason: 'pr-not-open' };
  if (row.review_status === 'reviewing') return { action: 'refuse', reason: 'reviewing' };
  if (row.review_status === 'pending') return { action: 'noop-already-pending', reason: 'already-pending' };
  if (row.review_status !== 'failed') return { action: 'refuse', reason: 'not-recoverable-failed-row' };
  if (hasReviewerProcessEvidence(row)) return { action: 'refuse', reason: 'reviewer-evidence-present' };
  if (!isQuotaRearmEligible(row, { force })) {
    return { action: 'refuse', reason: 'not-a-quota-row' };
  }
  return { action: 'rearm', reason: 'quota-hold' };
}

// Apply the re-arm: idempotent single UPDATE guarded on the exact failed row
// observed during planning so a concurrent watcher/operator transition cannot
// be clobbered. Returns the changed-row count.
function applyQuotaRearm(db, { repo, prNumber, plannedRow }) {
  const stmt = db.prepare(
    `UPDATE reviewed_prs
        SET review_status = 'pending',
            failed_at = NULL,
            failure_message = NULL,
            quota_reset_at_utc = NULL,
            infra_auto_recover_attempts = 0,
            reviewer_session_uuid = NULL,
            reviewer_started_at = NULL,
            reviewer_pgid = NULL,
            reviewer_lease_expires_at = NULL
      WHERE repo = ?
        AND pr_number = ?
        AND pr_state = 'open'
        AND review_status = 'failed'
        AND failed_at IS ?
        AND failure_message IS ?
        AND quota_reset_at_utc IS ?
        AND reviewer_session_uuid IS ?`
  );
  return stmt.run(
    repo,
    prNumber,
    plannedRow.failed_at ?? null,
    plannedRow.failure_message ?? null,
    plannedRow.quota_reset_at_utc ?? null,
    plannedRow.reviewer_session_uuid ?? null
  ).changes;
}

function rearmQuotaReview({ rootDir, repo, prNumber, force = false }) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const row = getReviewRow(db, { repo, prNumber });
    const plan = planQuotaRearm(row, { force });
    if (plan.action === 'rearm') {
      const changes = applyQuotaRearm(db, { repo, prNumber, plannedRow: row });
      if (changes === 0) {
        // Lost the race: the watcher/operator moved or edited the row.
        const after = getReviewRow(db, { repo, prNumber });
        return { ok: false, action: 'refuse', reason: 'state-changed', row: after };
      }
      return { ok: true, action: 'rearm', reason: plan.reason, row: getReviewRow(db, { repo, prNumber }) };
    }
    if (plan.action === 'noop-already-pending') {
      return { ok: true, action: 'noop-already-pending', reason: plan.reason, row };
    }
    return { ok: false, action: 'refuse', reason: plan.reason, row };
  } finally {
    db.close();
  }
}

function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        repo: { type: 'string' },
        pr: { type: 'string' },
        force: { type: 'boolean', default: false },
        'root-dir': { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (parsed.values.help) return parsed.values;
  if (!parsed.values.repo || !parsed.values.pr) {
    throw new UsageError('--repo and --pr are required');
  }
  const rawPr = String(parsed.values.pr);
  if (!/^[1-9][0-9]*$/.test(rawPr)) {
    throw new UsageError(`--pr must be a positive integer (got: ${parsed.values.pr})`);
  }
  const prNumber = Number(rawPr);
  if (!Number.isSafeInteger(prNumber)) {
    throw new UsageError(`--pr must be a positive integer (got: ${parsed.values.pr})`);
  }
  return { ...parsed.values, prNumber };
}

function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let values;
  try {
    values = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`error: ${err.message}\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    throw err;
  }
  if (values.help) {
    stdout.write(USAGE);
    return EXIT_OK;
  }

  const rootDir = values['root-dir'] ? resolve(values['root-dir']) : DEFAULT_ROOT_DIR;
  let result;
  try {
    result = rearmQuotaReview({
      rootDir,
      repo: values.repo,
      prNumber: values.prNumber,
      force: values.force,
    });
  } catch (err) {
    stderr.write(`error: ${err.message}\n`);
    return EXIT_RUNTIME;
  }

  if (values.json) {
    stdout.write(`${JSON.stringify({
      ok: result.ok,
      action: result.action,
      reason: result.reason,
      repo: values.repo,
      pr: values.prNumber,
      reviewStatus: result.row?.review_status ?? null,
    })}\n`);
  }

  if (result.ok) {
    if (!values.json) {
      const verb = result.action === 'rearm' ? 're-armed' : 'already pending (no-op)';
      stdout.write(`ok: ${values.repo}#${values.prNumber} ${verb}; watcher will re-review on next poll\n`);
    }
    return EXIT_OK;
  }

  if (!values.json) {
    const hints = {
      'review-row-missing': 'no reviewed_prs row exists for this PR (watcher has not seen it yet)',
      'pr-not-open': 'PR is not open (merged/closed)',
      reviewing: 'a reviewer subprocess is currently in flight; wait for it to settle',
      'not-recoverable-failed-row': 'only open failed quota rows can be re-armed; inspect this status manually',
      'reviewer-evidence-present': 'failed row still has reviewer process/session evidence; cancel the reviewer first',
      'not-a-quota-row': 'this row is not a quota-class hold; re-run with --force if you are sure',
      'state-changed': 'row state changed concurrently; re-run to inspect',
    };
    stderr.write(`refused: ${values.repo}#${values.prNumber} (${result.reason})\n`);
    if (hints[result.reason]) stderr.write(`${hints[result.reason]}\n`);
  }
  return EXIT_REFUSED;
}

const isDirectInvocation =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectInvocation) {
  process.exit(main(process.argv.slice(2)));
}

export {
  applyQuotaRearm,
  hasReviewerProcessEvidence,
  isQuotaRearmEligible,
  main,
  planQuotaRearm,
  rearmQuotaReview,
};
