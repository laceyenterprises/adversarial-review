#!/usr/bin/env node
/**
 * `npm run diagnose-stuck-rereview` — operator diagnostic for the
 * 2026-05-30 #1067 stuck-rereview class of bugs.
 *
 * Background: after a watcher crash window (the 2026-05-29 ALERT_TO env
 * crash-loop + main-catchup SIGTERM-during-drain restarts), at least one
 * PR (#1067) was left with a state shape the watcher could not advance:
 *
 *   - `review_status = 'pending'` (correct for a queued rereview claim)
 *   - `posted_at = NULL` (cleared by `requestReviewRereview` on purpose)
 *   - `rereview_requested_at` set to >5 minutes ago
 *   - `last_attempted_at` older than `rereview_requested_at`
 *
 * The watcher's per-PR loop kept logging `adversarial gate: pending
 * (remediation-queued)` and `merge-agent decision: skip-remediation-active`
 * but never reached the claim site for this row. Three operator levers
 * were tried (`retrigger-review`, `follow-up:reconcile`, `kickstart -k`);
 * none unstuck the PR. Diagnosis required reading the watcher source +
 * follow-up-jobs filesystem state by hand.
 *
 * This tool surfaces the same triage information operators had to chase
 * manually, plus a "what would need to be true" hint set for each stuck
 * row. By default it is read-only. With `--apply`, it re-arms the stuck
 * row through a watchdog-only CAS, so the next watcher tick can claim it.
 * The automated path uses its own `stuck-rereview-watchdog:` reason
 * prefix, refreshes only the rereview timestamp/reason, refuses rows that
 * carry terminal-failure evidence, and caps repeated re-arms per PR/head.
 *
 * Usage:
 *   npm run diagnose-stuck-rereview                  # all open rows
 *   npm run diagnose-stuck-rereview -- --repo X --pr N   # single PR
 *   npm run diagnose-stuck-rereview -- --json        # machine-readable
 *   npm run diagnose-stuck-rereview -- --threshold-minutes 5
 *   npm run diagnose-stuck-rereview -- --apply
 */

import { parseArgs } from 'node:util';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { writeFileAtomic } from './atomic-write.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');

const DEFAULT_STUCK_THRESHOLD_MINUTES = 5;
const DEFAULT_APPLY_LIMIT = 25;
const DEFAULT_APPLY_MAX_ATTEMPTS = 3;
const APPLY_REASON = 'stuck-rereview-watchdog: stuck rereview detected by diagnose-stuck-rereview --apply';

function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function minutesBetween(laterMs, earlierMs) {
  if (laterMs == null || earlierMs == null) return null;
  return Math.round((laterMs - earlierMs) / 60_000);
}

function readJobsForPR({ rootDir, repo, prNumber }) {
  const base = join(rootDir, 'data', 'follow-up-jobs');
  const result = { latestJob: null, latestJobKey: null, byBucket: {} };
  if (!existsSync(base)) return result;
  const buckets = ['pending', 'in-progress', 'completed', 'failed', 'stopped'];
  const filenamePrefix = `${repo.replace('/', '__')}-pr-${prNumber}-`;
  let latestTs = '';
  for (const bucket of buckets) {
    const dir = join(base, bucket);
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir)
      .filter((name) => name.startsWith(filenamePrefix) && name.endsWith('.json'));
    if (!entries.length) continue;
    result.byBucket[bucket] = [];
    for (const filename of entries) {
      const path = join(dir, filename);
      let job;
      try {
        job = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        // Only surface parse failures whose filename matches this PR's prefix
        // (already enforced above) so the diagnostic does not chase unrelated
        // job files into operator triage noise.
        result.byBucket[bucket].push({ filename, error: 'parse-failed' });
        continue;
      }
      if (job?.repo !== repo) continue;
      if (Number(job?.prNumber) !== Number(prNumber)) continue;
      const ts = job.completedAt || job.failedAt || job.stoppedAt || job.claimedAt || job.createdAt || '';
      result.byBucket[bucket].push({
        filename,
        bucket,
        status: job.status,
        revisionRef: job.revisionRef,
        completedAt: job.completedAt,
        reReviewRequested: !!(job.reReview && job.reReview.requested),
        ts,
      });
      if (ts > latestTs) {
        latestTs = ts;
        result.latestJob = {
          bucket,
          status: job.status,
          revisionRef: job.revisionRef,
          completedAt: job.completedAt,
          reReviewRequested: !!(job.reReview && job.reReview.requested),
        };
        result.latestJobKey = filename;
      }
    }
  }
  return result;
}

function readReviewPassInfoAfterRereview({ db, repo, prNumber, after }) {
  const empty = {
    landedAfterRereview: 0,
    completedAfterRereview: 0,
    nonLandedAfterRereview: 0,
    latestPass: null,
    error: null,
  };
  if (parseTimestamp(after) == null) return empty;
  try {
    const rows = db.prepare(
      `SELECT pass_kind AS passKind,
              status,
              started_at AS startedAt,
              ended_at AS endedAt,
              head_sha AS headSha,
              verdict,
              gh_comment_id AS ghCommentId,
              CASE
                WHEN status = 'completed'
                 AND (
                   (gh_comment_id IS NOT NULL AND gh_comment_id <> '')
                   OR (verdict IS NOT NULL AND verdict <> '')
                   OR (body_md IS NOT NULL AND body_md <> '')
                 )
                THEN 1 ELSE 0
              END AS landed
         FROM reviewer_passes
        WHERE repo = ?
          AND pr_number = ?
          AND pass_kind IN ('first-pass', 'rereview')
          AND (
            (started_at IS NOT NULL AND started_at >= ?)
            OR (ended_at IS NOT NULL AND ended_at >= ?)
          )
        ORDER BY COALESCE(ended_at, started_at, '') DESC, pass_id DESC
        LIMIT 20`
    ).all(repo, prNumber, after, after);
    const landedAfterRereview = rows.filter((row) => Number(row.landed) === 1).length;
    const completedAfterRereview = rows.filter((row) => row.status === 'completed').length;
    return {
      landedAfterRereview,
      completedAfterRereview,
      nonLandedAfterRereview: rows.length - landedAfterRereview,
      latestPass: rows[0] ? {
        passKind: rows[0].passKind,
        status: rows[0].status,
        startedAt: rows[0].startedAt,
        endedAt: rows[0].endedAt,
        headSha: rows[0].headSha,
        verdict: rows[0].verdict,
        ghCommentId: rows[0].ghCommentId,
      } : null,
      error: null,
    };
  } catch (err) {
    return {
      ...empty,
      error: err?.message || String(err),
    };
  }
}

function buildStuckHints(row, { jobInfo, reviewPassInfo }) {
  const hints = [];
  const latestJob = jobInfo.latestJob;
  if (!latestJob) {
    hints.push('no follow-up job records found for this PR; check data/follow-up-jobs/ buckets manually');
  } else {
    if (latestJob.status !== 'completed') {
      hints.push(`latest job status=${latestJob.status} (not completed); gate-status may classify as remediation-active`);
    }
    if (latestJob.status === 'completed' && !latestJob.reReviewRequested) {
      hints.push('latest job is completed but reReview.requested=false; worker did not request rereview');
    }
  }
  if (row.posted_at) {
    hints.push(`posted_at=${row.posted_at} but review_status=pending; row may not have been reset cleanly by requestReviewRereview`);
  }
  if (reviewPassInfo?.error) {
    hints.push(`could not inspect reviewer_passes: ${reviewPassInfo.error}`);
  } else if (reviewPassInfo && reviewPassInfo.landedAfterRereview <= 0) {
    let detail = 'no completed GitHub review pass landed since rereview_requested_at';
    if (reviewPassInfo.latestPass) {
      const latest = reviewPassInfo.latestPass;
      const head = latest.headSha ? ` head=${String(latest.headSha).slice(0, 12)}` : '';
      detail += `; latest reviewer pass status=${latest.status || '(unknown)'}${head}`;
    }
    hints.push(detail);
  }
  return hints;
}

function classifyRow(row, { now, thresholdMs, jobInfo, reviewPassInfo }) {
  if (row.review_status !== 'pending') {
    return { stuck: false, reason: `review_status=${row.review_status} (not pending)` };
  }
  if (row.failed_at) {
    return {
      stuck: false,
      reason: 'pending row carries failed_at evidence; terminal-failure retry/finalization path owns it',
    };
  }
  const rereviewAtMs = parseTimestamp(row.rereview_requested_at);
  if (rereviewAtMs == null) {
    return { stuck: false, reason: 'no rereview_requested_at; row is fresh-pending awaiting first-pass claim' };
  }
  const lastAttemptedMs = parseTimestamp(row.last_attempted_at);
  if (lastAttemptedMs != null && lastAttemptedMs >= rereviewAtMs) {
    if (reviewPassInfo?.landedAfterRereview > 0) {
      return {
        stuck: false,
        reason: 'completed GitHub review pass landed after rereview_requested_at',
      };
    }
    const ageMs = now - rereviewAtMs;
    if (ageMs < thresholdMs) {
      return {
        stuck: false,
        reason: `rereview attempt is ${Math.round(ageMs/60_000)}min old with no landed review yet; threshold is ${Math.round(thresholdMs/60_000)}min`,
        ageMinutes: minutesBetween(now, rereviewAtMs),
      };
    }
    return {
      stuck: true,
      ageMinutes: minutesBetween(now, rereviewAtMs),
      hints: buildStuckHints(row, { jobInfo, reviewPassInfo }),
      suggestedAction: `npm run retrigger-review -- --repo ${row.repo} --pr ${row.pr_number} --reason "stuck rereview detected by diagnose-stuck-rereview"`,
    };
  }
  const ageMs = now - rereviewAtMs;
  if (ageMs < thresholdMs) {
    return {
      stuck: false,
      reason: `rereview is ${Math.round(ageMs/60_000)}min old; threshold is ${Math.round(thresholdMs/60_000)}min — give the watcher more cycles before flagging`,
      ageMinutes: minutesBetween(now, rereviewAtMs),
    };
  }
  return {
    stuck: true,
    ageMinutes: minutesBetween(now, rereviewAtMs),
    hints: buildStuckHints(row, { jobInfo, reviewPassInfo }),
    suggestedAction: `npm run retrigger-review -- --repo ${row.repo} --pr ${row.pr_number} --reason "stuck rereview detected by diagnose-stuck-rereview"`,
  };
}

function formatHumanRow({ row, classification, jobInfo, reviewPassInfo }) {
  const lines = [];
  lines.push(`${row.repo}#${row.pr_number}`);
  lines.push(`  review_status         : ${row.review_status}`);
  lines.push(`  review_attempts       : ${row.review_attempts}`);
  lines.push(`  last_attempted_at     : ${row.last_attempted_at || '(null)'}`);
  lines.push(`  posted_at             : ${row.posted_at || '(null)'}`);
  lines.push(`  rereview_requested_at : ${row.rereview_requested_at || '(null)'}`);
  lines.push(`  reviewer_head_sha     : ${row.reviewer_head_sha ? row.reviewer_head_sha.slice(0, 12) : '(null)'}`);
  if (jobInfo.latestJobKey) {
    const j = jobInfo.latestJob;
    lines.push(`  latestJob             : ${jobInfo.latestJobKey}`);
    lines.push(`    bucket              : ${j.bucket}`);
    lines.push(`    status              : ${j.status}`);
    lines.push(`    revisionRef         : ${j.revisionRef ? j.revisionRef.slice(0, 12) : '(null)'}`);
    lines.push(`    reReview.requested  : ${j.reReviewRequested}`);
  } else {
    lines.push(`  latestJob             : (none found)`);
  }
  if (reviewPassInfo?.latestPass) {
    const pass = reviewPassInfo.latestPass;
    lines.push(`  latestReviewerPass    : ${pass.passKind || '(unknown)'} / ${pass.status || '(unknown)'}`);
    lines.push(`    startedAt           : ${pass.startedAt || '(null)'}`);
    lines.push(`    endedAt             : ${pass.endedAt || '(null)'}`);
    lines.push(`    headSha             : ${pass.headSha ? String(pass.headSha).slice(0, 12) : '(null)'}`);
    lines.push(`    ghCommentId         : ${pass.ghCommentId || '(null)'}`);
    lines.push(`    verdict             : ${pass.verdict || '(null)'}`);
    lines.push(`    landedSinceRequest  : ${reviewPassInfo.landedAfterRereview}`);
  } else {
    lines.push(`  latestReviewerPass    : (none found since rereview request)`);
  }
  if (classification.stuck) {
    lines.push(`  *** STUCK *** age=${classification.ageMinutes}min`);
    for (const hint of classification.hints || []) {
      lines.push(`    hint                : ${hint}`);
    }
    lines.push(`  suggested action      : ${classification.suggestedAction}`);
  } else {
    lines.push(`  status                : not-stuck — ${classification.reason}`);
  }
  return lines.join('\n');
}

function watchdogStatePath(rootDir) {
  return join(rootDir, 'data', 'follow-up-jobs', 'stuck-rereview-watchdog.json');
}

function readWatchdogState(rootDir) {
  const path = watchdogStatePath(rootDir);
  if (!existsSync(path)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object'
      ? { entries: parsed.entries }
      : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

function writeWatchdogState(rootDir, state) {
  writeFileAtomic(
    watchdogStatePath(rootDir),
    JSON.stringify({ entries: state.entries || {} }, null, 2) + '\n'
  );
}

function watchdogKey(row) {
  const head = String(row.revision_ref || row.reviewer_head_sha || 'unknown-head');
  return `${row.repo}#${row.pr_number}@${head}`;
}

function rearmBackoffMs(thresholdMs, nextAttempt) {
  const baseMs = Math.max(60_000, thresholdMs);
  return baseMs * (2 ** Math.max(0, nextAttempt - 1));
}

function isBenignApplyRace(reason) {
  return ['review-in-flight', 'pr-not-open', 'terminal-failure-evidence-present'].includes(reason);
}

function refreshPendingRereviewRow({ db, row, requestedAt, reason }) {
  const result = db.prepare(
    `UPDATE reviewed_prs
        SET rereview_requested_at = ?,
            rereview_reason = ?
      WHERE repo = ?
        AND pr_number = ?
        AND pr_state = 'open'
        AND review_status = 'pending'
        AND rereview_requested_at = ?
        AND failed_at IS NULL`
  ).run(requestedAt, reason, row.repo, row.pr_number, row.rereview_requested_at);
  if (result.changes === 1) {
    return { triggered: true, status: 'pending', reason: 'watchdog-rereview-refreshed' };
  }

  const current = db.prepare(
    `SELECT review_status, pr_state, failed_at
       FROM reviewed_prs
      WHERE repo = ? AND pr_number = ?`
  ).get(row.repo, row.pr_number);
  if (!current) return { triggered: false, status: 'blocked', reason: 'review-row-missing' };
  if (current.review_status === 'reviewing') {
    return { triggered: false, status: 'blocked', reason: 'review-in-flight' };
  }
  if (current.pr_state !== 'open') {
    return { triggered: false, status: 'blocked', reason: 'pr-not-open' };
  }
  if (current.failed_at) {
    return { triggered: false, status: 'blocked', reason: 'terminal-failure-evidence-present' };
  }
  return { triggered: false, status: 'blocked', reason: 'rereview-cas-no-match' };
}

function applyStuckRereviewRows({
  db,
  rootDir,
  stuckRows,
  requestedAt = new Date().toISOString(),
  limit = DEFAULT_APPLY_LIMIT,
  thresholdMs = DEFAULT_STUCK_THRESHOLD_MINUTES * 60_000,
  maxAttempts = DEFAULT_APPLY_MAX_ATTEMPTS,
}) {
  const results = [];
  const state = readWatchdogState(rootDir);
  const requestedAtMs = parseTimestamp(requestedAt) ?? Date.now();
  let stateChanged = false;

  for (const entry of stuckRows.slice(0, limit)) {
    const row = entry.row;
    const key = watchdogKey(row);
    const prior = state.entries[key] && typeof state.entries[key] === 'object'
      ? state.entries[key]
      : {};
    const attempts = Number.isInteger(prior.attempts) && prior.attempts > 0 ? prior.attempts : 0;
    const nextEligibleAtMs = parseTimestamp(prior.nextEligibleAt);

    if (attempts >= maxAttempts) {
      results.push({
        repo: row.repo,
        prNumber: row.pr_number,
        applied: false,
        status: 'blocked',
        reason: 'watchdog-rearm-cap-exhausted',
        attempts,
        nextEligibleAt: prior.nextEligibleAt || null,
      });
      continue;
    }

    if (nextEligibleAtMs != null && requestedAtMs < nextEligibleAtMs) {
      results.push({
        repo: row.repo,
        prNumber: row.pr_number,
        applied: false,
        skipped: true,
        status: 'skipped',
        reason: 'watchdog-rearm-backoff-active',
        attempts,
        nextEligibleAt: prior.nextEligibleAt || null,
      });
      continue;
    }

    let result;
    try {
      result = refreshPendingRereviewRow({
        db,
        row,
        requestedAt,
        reason: APPLY_REASON,
      });
    } catch (err) {
      results.push({
        repo: row.repo,
        prNumber: row.pr_number,
        applied: false,
        error: err?.message || String(err),
      });
      continue;
    }

    const applied = result.triggered === true || result.status === 'already-pending';
    const skipped = !applied && isBenignApplyRace(result.reason);
    if (applied) {
      const nextAttempts = attempts + 1;
      state.entries[key] = {
        repo: row.repo,
        prNumber: row.pr_number,
        head: String(row.revision_ref || row.reviewer_head_sha || 'unknown-head'),
        attempts: nextAttempts,
        lastAppliedAt: requestedAt,
        nextEligibleAt: new Date(requestedAtMs + rearmBackoffMs(thresholdMs, nextAttempts)).toISOString(),
      };
      stateChanged = true;
    }

    results.push({
      repo: row.repo,
      prNumber: row.pr_number,
      applied,
      skipped,
      status: result.status || null,
      reason: result.reason || null,
      attempts: applied ? attempts + 1 : attempts,
    });
  }
  if (stateChanged) {
    writeWatchdogState(rootDir, state);
  }
  return results;
}

// Exit-code contract (for cron / operator alerting; keep stable):
//   0 = clean — no stuck rows found, or help/usage printed
//   2 = usage error — invalid flag combination (e.g. --pr without --repo,
//       --threshold-minutes negative or non-finite)
//   3 = environment error — reviews.db missing or unreadable
//   4 = stuck rows found in read-only mode (operator action required)
//   5 = --apply found stuck rows but one or more re-arm attempts failed
// Add a new code only after thinking through every consumer of `npm run
// diagnose-stuck-rereview` (cron jobs, follow-up alerts, runbook prose).
function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      pr: { type: 'string' },
      'threshold-minutes': { type: 'string' },
      apply: { type: 'boolean', default: false },
      limit: { type: 'string' },
      json: { type: 'boolean', default: false },
      'root-dir': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  }).values;

  if (args.help) {
    stdout.write(`usage: diagnose-stuck-rereview [--repo X --pr N] [--json] [--threshold-minutes N] [--apply]\n`);
    stdout.write(`  Triage PRs stuck in review_status=pending after a rereview was requested.\n`);
    stdout.write(`  Default threshold: ${DEFAULT_STUCK_THRESHOLD_MINUTES} minutes. --apply re-arms stuck rows.\n`);
    return 0;
  }

  if ((args.repo && !args.pr) || (args.pr && !args.repo)) {
    stderr.write(`error: --repo and --pr must be passed together\n`);
    return 2;
  }
  let prNumber = null;
  if (args.pr !== undefined) {
    const parsedPr = Number(args.pr);
    if (!Number.isInteger(parsedPr) || parsedPr <= 0) {
      stderr.write(`error: --pr must be a positive integer (got ${JSON.stringify(args.pr)})\n`);
      return 2;
    }
    prNumber = parsedPr;
  }

  let thresholdMinutes = DEFAULT_STUCK_THRESHOLD_MINUTES;
  if (args['threshold-minutes'] !== undefined) {
    const parsed = Number(args['threshold-minutes']);
    if (!Number.isFinite(parsed) || parsed < 0) {
      stderr.write(`error: --threshold-minutes must be a non-negative finite number (got ${JSON.stringify(args['threshold-minutes'])})\n`);
      return 2;
    }
    thresholdMinutes = parsed;
  }
  let limit = DEFAULT_APPLY_LIMIT;
  if (args.limit !== undefined) {
    const parsed = Number(args.limit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      stderr.write(`error: --limit must be a positive integer (got ${JSON.stringify(args.limit)})\n`);
      return 2;
    }
    limit = parsed;
  }
  const thresholdMs = thresholdMinutes * 60_000;
  const now = Date.now();

  const rootDir = args['root-dir'] || DEFAULT_ROOT;
  const dbPath = join(rootDir, 'data', 'reviews.db');
  if (!existsSync(dbPath)) {
    stderr.write(`error: reviews.db not found at ${dbPath}\n`);
    return 3;
  }

  // The watcher runs as `placey` and owns `reviews.db`; opening that file
  // with a writeable handle from a different uid (e.g. an `airlock` shell)
  // would materialize WAL/SHM sidecars under the wrong owner and break the
  // watcher's next bounce. Opening readonly with `query_only=1` keeps us off
  // that footgun entirely (no WAL/SHM writes), and the soft owner mismatch
  // warning surfaces the misconfiguration so the operator notices instead of
  // silently using a stale or wrong DB path.
  if (typeof process.getuid === 'function') {
    try {
      const fileUid = statSync(dbPath).uid;
      const callerUid = process.getuid();
      if (fileUid !== callerUid) {
        const message =
          `warning: reviews.db is owned by uid=${fileUid} but this process is uid=${callerUid}; ` +
          `read-only access continues, but verify the rootDir matches the watcher's deploy checkout.\n`;
        if (args.apply) {
          stderr.write(
            `error: refusing --apply because reviews.db is owned by uid=${fileUid} ` +
            `but this process is uid=${callerUid}; run under the DB owner.\n`
          );
          return 3;
        }
        stderr.write(message);
      }
    } catch {
      // best-effort owner probe; do not fail the diagnostic if statSync errors
    }
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: !args.apply, fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    if (!args.apply) {
      db.pragma('query_only = 1');
    }
  } catch (err) {
    stderr.write(`error: failed to open reviews.db ${args.apply ? 'read-write' : 'readonly'}: ${err?.message || err}\n`);
    return 3;
  }

  try {
    let rows;
    if (args.repo && prNumber != null) {
      rows = db.prepare(
        `SELECT repo, pr_number, review_status, review_attempts, last_attempted_at,
                posted_at, rereview_requested_at, rereview_reason, reviewer_head_sha,
                revision_ref, failed_at
           FROM reviewed_prs
          WHERE repo = ? AND pr_number = ?`
      ).all(args.repo, prNumber);
    } else {
      rows = db.prepare(
        `SELECT repo, pr_number, review_status, review_attempts, last_attempted_at,
                posted_at, rereview_requested_at, rereview_reason, reviewer_head_sha,
                revision_ref, failed_at
           FROM reviewed_prs
          WHERE pr_state = 'open'
            AND review_status = 'pending'
            AND rereview_requested_at IS NOT NULL`
      ).all();
    }
    const report = [];
    for (const row of rows) {
      const jobInfo = readJobsForPR({ rootDir, repo: row.repo, prNumber: row.pr_number });
      const reviewPassInfo = readReviewPassInfoAfterRereview({
        db,
        repo: row.repo,
        prNumber: row.pr_number,
        after: row.rereview_requested_at,
      });
      const classification = classifyRow(row, { now, thresholdMs, jobInfo, reviewPassInfo });
      report.push({ row, classification, jobInfo, reviewPassInfo });
    }
    const stuck = report.filter((r) => r.classification.stuck);
    const applyResults = args.apply
      ? applyStuckRereviewRows({ db, rootDir, stuckRows: stuck, limit, thresholdMs })
      : [];
    const appliedCount = applyResults.filter((result) => result.applied).length;
    const skippedApplyCount = applyResults.filter((result) => result.skipped).length;
    const failedApplyCount = applyResults.filter((result) => !result.applied && !result.skipped).length;
    if (args.json) {
      stdout.write(JSON.stringify({
        thresholdMinutes,
        stuckCount: stuck.length,
        totalCandidates: report.length,
        appliedCount,
        skippedApplyCount,
        failedApplyCount,
        applyResults,
        rows: report,
      }, null, 2) + '\n');
    } else {
      stdout.write(`scanned ${report.length} candidate row(s); ${stuck.length} stuck (threshold=${thresholdMinutes}min)\n`);
      if (args.apply) {
        stdout.write(`apply: ${appliedCount} re-armed, ${skippedApplyCount} skipped, ${failedApplyCount} failed (limit=${limit})\n`);
      }
      for (const entry of report) {
        stdout.write('\n' + formatHumanRow(entry) + '\n');
      }
    }
    if (args.apply) {
      return failedApplyCount > 0 ? 5 : 0;
    }
    return stuck.length > 0 ? 4 : 0;
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}

// Use process.exitCode rather than process.exit so non-blocking stdout
// (e.g. when piped into `jq` or `tee`) drains before the process terminates.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

export {
  APPLY_REASON,
  applyStuckRereviewRows,
  main,
};
