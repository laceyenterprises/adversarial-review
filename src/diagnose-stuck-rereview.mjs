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
 * row. It is read-only — no DB mutations, no spawn attempts. Pair with
 * `npm run retrigger-review` (existing) for the action surface.
 *
 * Usage:
 *   npm run diagnose-stuck-rereview                  # all open rows
 *   npm run diagnose-stuck-rereview -- --repo X --pr N   # single PR
 *   npm run diagnose-stuck-rereview -- --json        # machine-readable
 *   npm run diagnose-stuck-rereview -- --threshold-minutes 5
 */

import { parseArgs } from 'node:util';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openReviewStateDb, ensureReviewStateSchema } from './review-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..');

const DEFAULT_STUCK_THRESHOLD_MINUTES = 5;

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
  let latestTs = '';
  for (const bucket of buckets) {
    const dir = join(base, bucket);
    if (!existsSync(dir)) continue;
    const entries = readdirSync(dir).filter((name) => name.includes(`pr-${prNumber}-`)).filter((n) => n.endsWith('.json'));
    if (!entries.length) continue;
    result.byBucket[bucket] = [];
    for (const filename of entries) {
      const path = join(dir, filename);
      let job;
      try {
        job = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
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

function classifyRow(row, { now, thresholdMs, jobInfo }) {
  if (row.review_status !== 'pending') {
    return { stuck: false, reason: `review_status=${row.review_status} (not pending)` };
  }
  const rereviewAtMs = parseTimestamp(row.rereview_requested_at);
  if (rereviewAtMs == null) {
    return { stuck: false, reason: 'no rereview_requested_at; row is fresh-pending awaiting first-pass claim' };
  }
  const lastAttemptedMs = parseTimestamp(row.last_attempted_at);
  if (lastAttemptedMs != null && lastAttemptedMs >= rereviewAtMs) {
    return { stuck: false, reason: 'last_attempted_at >= rereview_requested_at; spawn already happened' };
  }
  const ageMs = now - rereviewAtMs;
  if (ageMs < thresholdMs) {
    const remainingMs = thresholdMs - ageMs;
    return {
      stuck: false,
      reason: `rereview is ${Math.round(ageMs/60_000)}min old; threshold is ${Math.round(thresholdMs/60_000)}min — give the watcher more cycles before flagging`,
      ageMinutes: minutesBetween(now, rereviewAtMs),
    };
  }
  const latestJob = jobInfo.latestJob;
  const hints = [];
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
  return {
    stuck: true,
    ageMinutes: minutesBetween(now, rereviewAtMs),
    hints,
    suggestedAction: `npm run retrigger-review -- --repo ${row.repo} --pr ${row.pr_number} --reason "stuck rereview detected by diagnose-stuck-rereview"`,
  };
}

function formatHumanRow({ row, classification, jobInfo }) {
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

function main() {
  const args = parseArgs({
    options: {
      repo: { type: 'string' },
      pr: { type: 'string' },
      'threshold-minutes': { type: 'string' },
      json: { type: 'boolean', default: false },
      'root-dir': { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  }).values;

  if (args.help) {
    process.stdout.write(`usage: diagnose-stuck-rereview [--repo X --pr N] [--json] [--threshold-minutes N]\n`);
    process.stdout.write(`  Read-only triage for PRs stuck in review_status=pending after a rereview\n`);
    process.stdout.write(`  was requested. Default threshold: ${DEFAULT_STUCK_THRESHOLD_MINUTES} minutes.\n`);
    return 0;
  }

  const rootDir = args['root-dir'] || DEFAULT_ROOT;
  const thresholdMinutes = Number(args['threshold-minutes']) || DEFAULT_STUCK_THRESHOLD_MINUTES;
  const thresholdMs = thresholdMinutes * 60_000;
  const now = Date.now();

  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    let rows;
    if (args.repo && args.pr) {
      rows = db.prepare(
        `SELECT repo, pr_number, review_status, review_attempts, last_attempted_at,
                posted_at, rereview_requested_at, reviewer_head_sha
           FROM reviewed_prs
          WHERE repo = ? AND pr_number = ?`
      ).all(args.repo, Number(args.pr));
    } else {
      rows = db.prepare(
        `SELECT repo, pr_number, review_status, review_attempts, last_attempted_at,
                posted_at, rereview_requested_at, reviewer_head_sha
           FROM reviewed_prs
          WHERE pr_state = 'open'
            AND review_status = 'pending'
            AND rereview_requested_at IS NOT NULL`
      ).all();
    }
    const report = [];
    for (const row of rows) {
      const jobInfo = readJobsForPR({ rootDir, repo: row.repo, prNumber: row.pr_number });
      const classification = classifyRow(row, { now, thresholdMs, jobInfo });
      report.push({ row, classification, jobInfo });
    }
    const stuck = report.filter((r) => r.classification.stuck);
    if (args.json) {
      process.stdout.write(JSON.stringify({ thresholdMinutes, stuckCount: stuck.length, totalCandidates: report.length, rows: report }, null, 2) + '\n');
    } else {
      process.stdout.write(`scanned ${report.length} candidate row(s); ${stuck.length} stuck (threshold=${thresholdMinutes}min)\n`);
      for (const entry of report) {
        process.stdout.write('\n' + formatHumanRow(entry) + '\n');
      }
    }
    return stuck.length > 0 ? 4 : 0;
  } finally {
    try { db.close(); } catch { /* best-effort */ }
  }
}

process.exit(main());
