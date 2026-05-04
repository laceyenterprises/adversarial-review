/**
 * LAC-11: PR Watcher
 * Polls GitHub every N minutes for new agent-built PRs and spawns reviewer agents.
 * Also tracks PR lifecycle (merged/closed) and syncs status to Linear automatically.
 */

import { Octokit } from '@octokit/rest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  routePR,
} from './watcher-title-guardrails.mjs';
import { signalMalformedTitleFailure } from './watcher-fail-loud.mjs';
import {
  buildSafePollOnce,
  computeWorkloadAwarePollDeadlineMs,
  DEFAULT_POLL_DEADLINE_FLOOR_MS,
} from './watcher-poll-guard.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from './review-state.mjs';
import { isSqliteOrphanError } from './sqlite-orphan.mjs';
import {
  CASCADE_FAILURE_CAP,
  classifyReviewerFailure,
  clearCascadeState,
  recordCascadeFailure,
  shouldBackoffReviewerSpawn,
} from './reviewer-cascade.mjs';
import {
  DEFAULT_MAX_REMEDIATION_ROUNDS,
  resolveRoundBudgetForJob,
  summarizePRRemediationLedger,
} from './follow-up-jobs.mjs';
import {
  buildMergeAgentDispatchJob,
  dispatchMergeAgentForPR,
  fetchMergeAgentCandidate,
} from './follow-up-merge-agent.mjs';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));

// ── DB setup ────────────────────────────────────────────────────────────────

const db = openReviewStateDb(ROOT);
ensureReviewStateSchema(db);

// ── Inode-orphan recovery ───────────────────────────────────────────────────
//
// SQLite returns SQLITE_READONLY_DBMOVED when the file behind a long-
// open database connection has been replaced on disk (the inode the
// connection holds no longer matches the path). better-sqlite3 surfaces
// it as `err.code === 'SQLITE_READONLY_DBMOVED'`. This is a real bite
// in operations because the watcher opens the DB once at module load
// time and reuses it for the process's lifetime — anything that
// replaces `data/reviews.db` (git checkout that touches the file, an
// adversarial-review submodule reset, a `restore.sh` run, a backup
// rollback) leaves the watcher writing to the orphaned inode forever.
// The classic scar from PR #18: a 6-hour readonly-loop window where
// every poll's writes silently failed and the reviews-ledger lost
// dozens of rows.
//
// All prepared statements are bound to the connection above, so we
// can't fix an orphaned handle in place. The cleanest recovery is to
// exit cleanly and let launchd's KeepAlive respawn us with a fresh
// connection. ThrottleInterval=30 in the plist caps the respawn rate.
//
// We use exit code 75 (BSD `EX_TEMPFAIL`) for documentation only;
// KeepAlive=true respawns regardless of exit code.
const SQLITE_ORPHAN_EXIT_CODE = 75;

// Distinct exit code for poll-watchdog-tripped restarts so the launchd
// log shows whether respawns are caused by SQLite orphan recovery (75)
// or a hung poll deadline (86). KeepAlive=true respawns either way.
const POLL_DEADLINE_EXIT_CODE = 86;

function exitForSqliteOrphan(err, contextLabel) {
  console.error(
    `[watcher] FATAL: SQLite database file was replaced on disk while we held it open ` +
    `(SQLITE_READONLY_DBMOVED in ${contextLabel}); exiting so launchd KeepAlive can respawn ` +
    `us with a fresh handle. Original error: ${err?.message || err}`
  );
  // Allow the log line to flush before exit.
  process.exitCode = SQLITE_ORPHAN_EXIT_CODE;
  // setImmediate → next tick gives stdout/stderr a chance to flush
  // before the process disappears. process.exit immediately would
  // sometimes truncate the message.
  setImmediate(() => process.exit(SQLITE_ORPHAN_EXIT_CODE));
}

function handlePollError(err, source = 'pollOnce') {
  if (isSqliteOrphanError(err)) {
    exitForSqliteOrphan(err, source);
    return;
  }
  console.error(`[watcher] Poll error (source=${source}):`, err);
}

// Set of AbortControllers for in-flight reviewer subprocesses. The
// watchdog-timeout exit path aborts every controller in this set
// before exiting so spawned reviewers cannot post a review after the
// parent watcher has died — without this, an orphan child can post,
// the parent never gets to mark the row 'posted', the row stays in
// 'reviewing' (or 'pending' under the previous design), restart
// spawns a second reviewer, and the same PR gets two reviews. See
// reconcileOrphanedReviewing() for the durable-state half of this
// guard.
const inFlightReviewerControllers = new Set();

function abortInFlightReviewers(reason) {
  for (const controller of inFlightReviewerControllers) {
    try {
      controller.abort(reason);
    } catch {
      // Aborting an already-aborted controller is a no-op; swallow
      // any unexpected throw rather than block the exit path.
    }
  }
  inFlightReviewerControllers.clear();
}

function exitForPollDeadline(err, source) {
  console.error(
    `[watcher] FATAL: ${err?.message || err} (source=${source}). ` +
    'Aborting in-flight reviewer subprocesses and exiting so launchd ' +
    'KeepAlive respawns the watcher with a clean event loop. ' +
    'The abandoned pollOnce continuation may still be alive in this ' +
    'process; restarting drops it.'
  );
  // Tear down spawned reviewer children synchronously BEFORE setting
  // up the deferred exit. Without this, an orphan child can finish
  // its `gh pr review` call after we exit, posting a review the
  // parent watcher never recorded — and the next watcher run, seeing
  // the row stuck in 'reviewing', will turn it into 'failed-orphan'
  // (sticky, requires operator). Aborting up front prevents that
  // case in the first place.
  abortInFlightReviewers('poll deadline exceeded');
  process.exitCode = POLL_DEADLINE_EXIT_CODE;
  setImmediate(() => process.exit(POLL_DEADLINE_EXIT_CODE));
}

// Belt-and-suspenders: in case a synchronous SqliteError escapes a
// catch (e.g. from an unawaited promise chain or a setInterval handler
// that re-throws synchronously), catch it at the process level and
// route through the same recovery.
process.on('uncaughtException', (err) => {
  if (isSqliteOrphanError(err)) {
    exitForSqliteOrphan(err, 'uncaughtException');
    return;
  }
  console.error('[watcher] uncaughtException:', err);
  // Non-orphan uncaught exceptions: re-throw default behavior is
  // crash-and-respawn, which is also what we want.
  setImmediate(() => process.exit(1));
});
process.on('unhandledRejection', (err) => {
  if (isSqliteOrphanError(err)) {
    exitForSqliteOrphan(err, 'unhandledRejection');
    return;
  }
  console.error('[watcher] unhandledRejection:', err);
});

const stmtGetReviewRow = db.prepare(
  'SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
);
const stmtCreateReviewRow = db.prepare(
  'INSERT OR IGNORE INTO reviewed_prs (repo, pr_number, reviewed_at, reviewer, pr_state, linear_ticket, review_status, review_attempts) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
);
const stmtUpdateReviewRouting = db.prepare(
  'UPDATE reviewed_prs SET reviewer = ?, linear_ticket = COALESCE(?, linear_ticket) WHERE repo = ? AND pr_number = ?'
);
const stmtMarkMalformed = db.prepare(
  "UPDATE reviewed_prs SET reviewer = 'malformed-title', review_status = 'malformed', failure_message = ?, failed_at = ?, last_attempted_at = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
);
// 'reviewing' is the durable in-progress claim: set BEFORE spawning
// the reviewer subprocess, replaced with 'posted' / 'failed' once the
// spawn resolves. If the watcher exits between these two updates
// (watchdog timeout, OOM kill, launchd restart), the row stays in
// 'reviewing' on disk — that is the operator-visible signal that a
// review subprocess was in flight when the parent died and may have
// posted a review the parent never recorded. reconcileOrphanedReviewing
// converts these on startup to 'failed-orphan' (sticky), which is the
// signal to a human that the GitHub PR may already carry a review
// from the killed child and a blind retry would produce a duplicate.
// Compare-and-swap claim: only flip `pending` / `failed` rows to
// `'reviewing'`. The unconditional UPDATE the previous version of this
// statement performed was safe under the in-process pollOnce
// serialization in this module, but did NOT close the cross-process
// race: if a second watcher instance (operator dev-mode launch racing
// launchd's KeepAlive, accidental double-launch, etc.) reads the same
// `pending` row, both would have called the unconditional UPDATE and
// both would have spawned a reviewer subprocess, producing duplicate
// GitHub reviews. The atomic CAS below is the second of two layers
// (in-process self-scheduled poll loop + cross-process SQL CAS) that
// together close the duplicate-spawn vector at both layers.
//
// Match conditions:
//   - `review_status = 'pending'` — happy-path claim.
//   - `review_status = 'failed'` — automatic-retry path; the pre-CAS
//     code treated `failed` as eligible for retry on the next poll,
//     and we preserve that contract here.
//   - `review_status = 'pending-upstream'` — upstream-cascade backoff
//     path. pollOnce gates this state on file-backed nextRetryAfter,
//     and once that window expires the row may be reclaimed for
//     another attempt without burning review_attempts.
//
// Terminal statuses (`posted`, `malformed`) and the durable in-flight
// states (`reviewing`, `failed-orphan`) are NOT reclaimable by this
// CAS. `failed-orphan` recovery is operator-driven via
// `npm run retrigger-review --allow-failed-reset` after verifying the
// GitHub side; that path resets the row to `pending` and the CAS
// then matches it on the next poll.
//
// Callers must check `result.changes === 1` before proceeding with
// the spawn. A 0-changes result means another watcher (or a parallel
// claim path) won the row, or the row's status moved to a state this
// CAS does not match — log and skip.
const stmtMarkAttemptStarted = db.prepare(
  `UPDATE reviewed_prs
     SET review_status = 'reviewing',
         last_attempted_at = ?,
         failed_at = CASE
           WHEN review_status = 'pending-upstream' THEN failed_at
           ELSE NULL
         END,
         failure_message = CASE
           WHEN review_status = 'pending-upstream' THEN failure_message
           ELSE NULL
         END
   WHERE repo = ?
     AND pr_number = ?
     AND review_status IN ('pending', 'failed', 'pending-upstream')`
);
const stmtMarkPosted = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'posted', posted_at = ?, failed_at = NULL, failure_message = NULL, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
);
const stmtMarkFailed = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
);
const stmtMarkCascadeFailed = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ? WHERE repo = ? AND pr_number = ?"
);
const stmtMarkPendingUpstream = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'pending-upstream', failed_at = ?, failure_message = ? WHERE repo = ? AND pr_number = ?"
);
const stmtListReviewing = db.prepare(
  "SELECT repo, pr_number, last_attempted_at FROM reviewed_prs WHERE review_status = 'reviewing'"
);
const stmtMarkOrphan = db.prepare(
  "UPDATE reviewed_prs SET review_status = 'failed-orphan', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1 WHERE repo = ? AND pr_number = ?"
);
const stmtGetOpenPRs = db.prepare(
  "SELECT repo, pr_number, linear_ticket FROM reviewed_prs WHERE pr_state = 'open'"
);
const stmtMarkMerged = db.prepare(
  "UPDATE reviewed_prs SET pr_state = 'merged', merged_at = ? WHERE repo = ? AND pr_number = ?"
);
const stmtMarkClosed = db.prepare(
  "UPDATE reviewed_prs SET pr_state = 'closed', closed_at = ? WHERE repo = ? AND pr_number = ?"
);

// ── Orphan review reconciliation (startup) ───────────────────────────────────
//
// On startup, find any rows still in 'reviewing' from a previous
// watcher run that exited (watchdog timeout, crash, OOM, launchd
// restart) before transitioning them to 'posted' or 'failed'. Those
// rows mean a reviewer subprocess was in flight when the parent died
// — and may have posted a review to GitHub the parent never recorded.
//
// Auto-retrying these rows would risk a duplicate review post. Mark
// them sticky-failed ('failed-orphan') so pollOnce skips them and the
// operator gets a clear, durable record. Recovery path:
//
//   1. Inspect the GitHub PR to see whether a review was already posted.
//   2. If yes: leave the row alone (it's effectively done) — or use
//      the operator tooling to mark it posted; either way the row
//      stops blocking.
//   3. If no: run `npm run retrigger-review --repo <slug> --pr <n>
//      --reason "verified no orphan review present"` to clear the
//      sticky state and re-arm review_status='pending'.
//
// This is the durable half of the duplicate-review guard; the abort-
// children-on-timeout path in exitForPollDeadline is the proactive
// half. Together they close the race the previous design left open.
function reconcileOrphanedReviewing() {
  const orphans = stmtListReviewing.all();
  if (orphans.length === 0) return;

  const failureAt = new Date().toISOString();
  for (const row of orphans) {
    const message =
      'Watcher restarted while review subprocess was in flight. ' +
      'A review may have been posted on GitHub by the orphaned child. ' +
      'Verify the PR before retriggering with `npm run retrigger-review`.';
    stmtMarkOrphan.run(failureAt, message, row.repo, row.pr_number);
    console.warn(
      `[watcher] Orphan reviewer detected for ${row.repo}#${row.pr_number} ` +
      `(last_attempted_at=${row.last_attempted_at || 'unknown'}); ` +
      `marked review_status='failed-orphan'. Operator must verify GitHub ` +
      `before clearing.`
    );
  }
}

// ── Author tag detection ─────────────────────────────────────────────────────

// ── Linear ticket extraction ─────────────────────────────────────────────────

function extractLinearTicketId(prTitle) {
  const match = prTitle.match(/\b(LAC-\d+)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function resolveCodexReviewerEnv(reviewerEnv) {
  const sourceDir = process.env.CODEX_SOURCE_HOME || '/Users/placey/.codex';
  const sourceAuthPath = join(sourceDir, 'auth.json');

  reviewerEnv.HOME = reviewerEnv.HOME || '/Users/airlock';
  reviewerEnv.CODEX_AUTH_PATH = sourceAuthPath;
  reviewerEnv.CODEX_SOURCE_HOME = sourceDir;
  delete reviewerEnv.OPENAI_API_KEY;

  return { authPath: sourceAuthPath, home: reviewerEnv.HOME };
}

// ── Reviewer spawning ────────────────────────────────────────────────────────

async function spawnReviewer({
  repo,
  prNumber,
  reviewerModel,
  botTokenEnv,
  linearTicketId,
  builderTag,
  reviewAttemptNumber,
  maxRemediationRounds,
}) {
  const reviewerPath = join(__dirname, 'reviewer.mjs');
  const args = JSON.stringify({
    repo,
    prNumber,
    reviewerModel,
    botTokenEnv,
    linearTicketId,
    builderTag,
    reviewAttemptNumber,
    maxRemediationRounds,
  });

  const finalRound = (
    Number.isFinite(reviewAttemptNumber) &&
    Number.isFinite(maxRemediationRounds) &&
    reviewAttemptNumber > maxRemediationRounds
  );
  const roundLabel = Number.isFinite(reviewAttemptNumber)
    ? ` attempt=${reviewAttemptNumber}/${1 + Number(maxRemediationRounds || 0)}${finalRound ? ' [FINAL — lenient threshold]' : ''}`
    : '';
  console.log(`[watcher] Spawning reviewer for ${repo}#${prNumber} (model: ${reviewerModel})${roundLabel}`);

  // AbortController ties the reviewer subprocess lifetime to the
  // watcher process. On normal completion it's a no-op. On a
  // watchdog-timeout exit (exitForPollDeadline) we abort every
  // controller in inFlightReviewerControllers BEFORE the parent
  // exits, which sends SIGTERM to the child via execFile's signal
  // option. That kill closes the duplicate-review race: without it
  // the child can keep running after the parent dies, post a review
  // the parent never recorded, and the next watcher run would spawn
  // a second reviewer for the same PR.
  const controller = new AbortController();
  inFlightReviewerControllers.add(controller);

  try {
    const reviewerEnv = { ...process.env };

    if (String(reviewerModel || '').toLowerCase().includes('codex')) {
      const { authPath, home } = resolveCodexReviewerEnv(reviewerEnv);
      console.log(`[watcher] Using Codex auth for reviewer at ${authPath} with HOME=${home}`);
    }

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [reviewerPath, args],
      {
        env: reviewerEnv,
        timeout: 5 * 60 * 1000,
        signal: controller.signal,
        killSignal: 'SIGTERM',
      }
    );
    if (stdout) console.log(`[reviewer:${prNumber}] ${stdout.trim()}`);
    if (stderr) console.error(`[reviewer:${prNumber}] stderr: ${stderr.trim()}`);
    return { ok: true };
  } catch (err) {
    const detail = [err.message, err.stdout, err.stderr]
      .filter(Boolean)
      .join('\n')
      .trim()
      .slice(0, 4000);
    return {
      ok: false,
      error: detail || err.message,
      exitCode: Number.isInteger(err?.exitCode)
        ? err.exitCode
        : (Number.isInteger(err?.code) ? err.code : null),
      errorCode: typeof err?.code === 'string' ? err.code : null,
      stderr: String(err?.stderr || detail || ''),
      failureClass: classifyReviewerFailure(
        err?.stderr || detail || '',
        Number.isInteger(err?.exitCode) ? err.exitCode : err?.code,
        err?.code
      ),
    };
  } finally {
    inFlightReviewerControllers.delete(controller);
  }
}

function settleReviewerAttempt({
  rootDir = ROOT,
  repoPath,
  prNumber,
  result,
  failureAt = new Date().toISOString(),
  maxRemediationRounds,
  statements = {
    markPosted: stmtMarkPosted,
    markFailed: stmtMarkFailed,
    markCascadeFailed: stmtMarkCascadeFailed,
    markPendingUpstream: stmtMarkPendingUpstream,
    getReviewRow: stmtGetReviewRow,
  },
  log = console,
}) {
  if (result.ok) {
    statements.markPosted.run(new Date().toISOString(), repoPath, prNumber);
    clearCascadeState(rootDir, { repo: repoPath, prNumber });
    return;
  }

  const failureClass = result.failureClass || 'unknown';
  if (failureClass === 'cascade') {
    const cascadeState = recordCascadeFailure(rootDir, {
      repo: repoPath,
      prNumber,
      failedAt: failureAt,
    });
    const cascadeMessage =
      result.error ||
      'Reviewer hit a LiteLLM/upstream cascade failure; watcher backoff engaged.';
    if (cascadeState.consecutiveCascadeFailures >= CASCADE_FAILURE_CAP) {
      statements.markPendingUpstream.run(failureAt, cascadeMessage, repoPath, prNumber);
      log.warn(
        `[watcher] PR #${prNumber} marked pending-upstream after ${cascadeState.consecutiveCascadeFailures} cascade failures; will resume when upstream recovers`
      );
    } else {
      statements.markCascadeFailed.run(failureAt, cascadeMessage, repoPath, prNumber);
    }
    log.warn(
      `[watcher] Reviewer cascade-class failure on #${prNumber} (consecutive=${cascadeState.consecutiveCascadeFailures}); backing off ${cascadeState.backoffMinutes}m`
    );
    return;
  }

  clearCascadeState(rootDir, { repo: repoPath, prNumber });
  statements.markFailed.run(failureAt, result.error || 'Unknown reviewer failure', repoPath, prNumber);
  const updatedRow = statements.getReviewRow.get(repoPath, prNumber);
  if (failureClass === 'bug') {
    log.warn(
      `[watcher] Reviewer bug-class failure on #${prNumber} (attempt ${updatedRow.review_attempts}/${1 + Number(maxRemediationRounds || 0)})`
    );
  } else {
    log.warn(
      `[watcher] Reviewer unknown-class failure on #${prNumber}; counting against attempt budget (${updatedRow.review_attempts}/${1 + Number(maxRemediationRounds || 0)})`
    );
  }
}

function evaluateRoundBudgetForReview({
  rootDir = ROOT,
  repo,
  prNumber,
  linearTicketId,
  reviewStatus,
  reviewAttempts = 0,
  log = console.log,
}) {
  if (reviewStatus !== 'pending' || Number(reviewAttempts) <= 0) {
    return { skip: false };
  }

  const ledger = summarizePRRemediationLedger(rootDir, { repo, prNumber });
  const resolution = resolveRoundBudgetForJob({
    linearTicketId,
    riskClass: ledger.latestRiskClass,
    remediationPlan: {
      maxRounds: ledger.latestMaxRounds,
    },
  }, { rootDir });

  if (ledger.completedRoundsForPR < resolution.roundBudget) {
    return {
      skip: false,
      completedRoundsForPR: ledger.completedRoundsForPR,
      roundBudget: resolution.roundBudget,
      riskClass: resolution.riskClass,
    };
  }

  log(
    `[watcher] Skipping rereview for ${repo}#${prNumber}: completed remediation rounds ${ledger.completedRoundsForPR}/${resolution.roundBudget} exhaust the ${resolution.riskClass} risk-class budget. Merge-agent handoff is future Track B work.`
  );

  return {
    skip: true,
    reason: 'round-budget-exhausted',
    completedRoundsForPR: ledger.completedRoundsForPR,
    roundBudget: resolution.roundBudget,
    riskClass: resolution.riskClass,
  };
}

// ── Linear state helpers ─────────────────────────────────────────────────────

let linearClient = null;

async function getLinearClient() {
  if (!process.env.LINEAR_API_KEY) return null;
  if (!linearClient) {
    const { LinearClient } = await import('@linear/sdk');
    linearClient = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });
  }
  return linearClient;
}

async function setLinearState(ticketId, targetStateName) {
  if (!ticketId) return;
  const linear = await getLinearClient();
  if (!linear) return;

  try {
    const issue = await linear.issue(ticketId);
    if (!issue) return;

    const team = await issue.team;
    const states = await team.states();
    const targetState = states.nodes.find(
      (s) => s.name.toLowerCase() === targetStateName.toLowerCase()
    );
    if (!targetState) {
      console.warn(`[watcher] Linear state "${targetStateName}" not found for team`);
      return;
    }

    const currentState = await issue.state;
    if (currentState?.name?.toLowerCase() === targetStateName.toLowerCase()) {
      console.log(`[watcher] Linear ${ticketId} already in "${targetStateName}" — skipping`);
      return;
    }

    await linear.updateIssue(issue.id, { stateId: targetState.id });
    console.log(`[watcher] Linear ${ticketId} → "${targetStateName}"`);
  } catch (err) {
    console.error(`[watcher] Linear update failed for ${ticketId} (→ ${targetStateName}):`, err.message);
  }
}

// Convenience wrappers using configurable state names
const linearStates = {
  inReview:   config.linearStates?.inReview   ?? 'In Review',
  done:       config.linearStates?.done       ?? 'Done',
  cancelled:  config.linearStates?.cancelled  ?? 'Cancelled',
};

const setLinearInReview  = (id) => setLinearState(id, linearStates.inReview);
const setLinearDone      = (id) => setLinearState(id, linearStates.done);
const setLinearCancelled = (id) => setLinearState(id, linearStates.cancelled);

// ── prlt linear sync ─────────────────────────────────────────────────────────

const PRLT_HQ = config.prltHq ?? '/Users/placey/prlt-hq/Laceyenterprises-hq';
const PRLT_BIN = config.prltBin ?? '/opt/homebrew/bin/prlt';

async function runPrltSync() {
  if (!process.env.LINEAR_API_KEY) return;

  try {
    const { stdout, stderr } = await execFileAsync(
      PRLT_BIN,
      ['linear', 'sync', '--machine'],
      {
        cwd: PRLT_HQ,
        env: { ...process.env },
        timeout: 60_000,
      }
    );
    const result = JSON.parse(stdout || '{}');
    const synced = result?.result?.synced ?? result?.result?.tickets?.length ?? '?';
    console.log(`[watcher] prlt linear sync complete — ${synced} ticket(s) synced`);
    if (stderr) console.warn(`[watcher] prlt sync stderr: ${stderr.trim()}`);
  } catch (err) {
    // Non-fatal — log and continue
    console.error(`[watcher] prlt linear sync failed:`, err.message);
  }
}

// ── Org repo discovery ───────────────────────────────────────────────────────

let activeRepos = config.repos ?? [];
let lastRepoRefresh = 0;

async function refreshOrgRepos(octokit) {
  if (!config.org) return;

  const now = Date.now();
  const refreshInterval = config.repoRefreshIntervalMs ?? 3_600_000;
  if (now - lastRepoRefresh < refreshInterval) return;

  try {
    const all = await octokit.paginate(octokit.rest.repos.listForOrg, {
      org: config.org,
      type: 'all',
      per_page: 100,
    });

    const excluded = new Set(config.excludeRepos ?? []);
    activeRepos = all
      .filter((r) => !r.archived && !excluded.has(r.name) && !excluded.has(`${config.org}/${r.name}`))
      .map((r) => `${config.org}/${r.name}`);

    lastRepoRefresh = now;
    console.log(`[watcher] Org repos refreshed — watching ${activeRepos.length} repos: ${activeRepos.join(', ')}`);
  } catch (err) {
    console.error(`[watcher] Failed to list org repos for ${config.org}:`, err.message);
  }
}

// ── Lifecycle sync: check open PRs for merge/close ──────────────────────────

/**
 * For every PR we previously marked as "open", check if it has since been
 * merged or closed and update Linear accordingly.
 */
async function syncPRLifecycle(octokit) {
  const openRows = stmtGetOpenPRs.all();
  if (openRows.length === 0) return;

  let anyChanged = false;

  for (const row of openRows) {
    const { repo, pr_number: prNumber, linear_ticket: linearTicketId } = row;
    const [owner, repoName] = repo.split('/');

    let pr;
    try {
      const { data } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber });
      pr = data;
    } catch (err) {
      console.error(`[watcher] Failed to fetch PR ${repo}#${prNumber}:`, err.message);
      continue;
    }

    if (pr.merged_at) {
      console.log(`[watcher] PR ${repo}#${prNumber} was merged — syncing Linear`);
      stmtMarkMerged.run(pr.merged_at, repo, prNumber);
      await setLinearDone(linearTicketId);
      anyChanged = true;
    } else if (pr.state === 'closed') {
      console.log(`[watcher] PR ${repo}#${prNumber} was closed (unmerged) — syncing Linear`);
      stmtMarkClosed.run(pr.closed_at ?? new Date().toISOString(), repo, prNumber);
      await setLinearCancelled(linearTicketId);
      anyChanged = true;
    }
    // Still open → nothing to do
  }

  // If anything changed, run prlt sync to keep prlt's DB in step
  if (anyChanged) {
    await runPrltSync();
  }
}

// ── Poll loop (new PRs) ──────────────────────────────────────────────────────

async function pollOnce(octokit) {
  await refreshOrgRepos(octokit);

  // Check lifecycle of previously-seen PRs first
  await syncPRLifecycle(octokit);

  for (const repoPath of activeRepos) {
    const [owner, repo] = repoPath.split('/');

    let prs;
    try {
      const { data } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: 'open',
        per_page: 50,
        sort: 'created',
        direction: 'desc',
      });
      prs = data;
    } catch (err) {
      console.error(`[watcher] Failed to fetch PRs for ${repoPath}:`, err.message);
      continue;
    }

    for (const pr of prs) {
      const prNumber = pr.number;
      const prTitle = pr.title;
      const prState = String(pr.state || '').trim().toLowerCase();
      const existing = stmtGetReviewRow.get(repoPath, prNumber);

      // 'failed-orphan' is a sticky state set by reconcileOrphanedReviewing()
      // when the watcher restarted with a row stuck in 'reviewing' — i.e.
      // a reviewer subprocess was in flight when the watcher died and may
      // have posted a review the parent never recorded. Auto-retrying that
      // row would risk a duplicate review post on GitHub; the operator
      // must explicitly clear it via `npm run retrigger-review` after
      // verifying the actual GitHub PR state.
      if (
        existing?.review_status === 'malformed' ||
        existing?.review_status === 'failed-orphan'
      ) {
        continue;
      }

      if (prState && prState !== 'open') {
        continue;
      }

      if (existing?.review_status === 'posted') {
        try {
          const candidate = await fetchMergeAgentCandidate(repoPath, prNumber, {
            execFileImpl: execFileAsync,
          });
          const dispatchJob = buildMergeAgentDispatchJob(ROOT, candidate);
          const dispatched = await dispatchMergeAgentForPR({
            rootDir: ROOT,
            ...dispatchJob,
          });
          console.log(
            `[watcher] merge-agent decision for ${repoPath}#${prNumber}: ${dispatched.decision}`
          );
        } catch (err) {
          console.error(
            `[watcher] merge-agent dispatch check failed for ${repoPath}#${prNumber}:`,
            err?.message || err
          );
        }
        continue;
      }

      const route = routePR(prTitle);
      if (!route) {
        if (!existing) {
          stmtCreateReviewRow.run(
            repoPath,
            prNumber,
            new Date().toISOString(),
            'malformed-title',
            'open',
            null,
            'pending'
          );
        }

        await signalMalformedTitleFailure(octokit, {
          repoPath,
          owner,
          repo,
          prNumber,
          prTitle,
        });

        // Malformed titles are terminal in watcher state to avoid ambiguous retitle retries.
        const failureAt = new Date().toISOString();
        stmtMarkMalformed.run(
          `Malformed PR title: ${prTitle}`,
          failureAt,
          failureAt,
          repoPath,
          prNumber
        );
        continue;
      }

      const linearTicketId = extractLinearTicketId(prTitle);
      if (!existing) {
        stmtCreateReviewRow.run(
          repoPath,
          prNumber,
          new Date().toISOString(),
          route.reviewerModel,
          'open',
          linearTicketId,
          'pending'
        );
      } else {
        stmtUpdateReviewRouting.run(route.reviewerModel, linearTicketId, repoPath, prNumber);
      }

      const current = stmtGetReviewRow.get(repoPath, prNumber);
      const cascadeGate = shouldBackoffReviewerSpawn(ROOT, {
        repo: repoPath,
        prNumber,
      });
      if (cascadeGate.shouldBackoff) {
        continue;
      }

      if (!existing) {
        console.log(
          `[watcher] New PR ${repoPath}#${prNumber}: "${prTitle}" → ${route.reviewerModel}` +
            (linearTicketId ? ` (${linearTicketId})` : '')
        );
      } else {
        console.log(
          `[watcher] Retrying PR ${repoPath}#${prNumber}: "${prTitle}" → ${route.reviewerModel}` +
            (linearTicketId ? ` (${linearTicketId})` : '') +
            ` | previous status=${current?.review_status || existing.review_status}`
        );
      }

      const roundBudgetDecision = evaluateRoundBudgetForReview({
        rootDir: ROOT,
        repo: repoPath,
        prNumber,
        linearTicketId,
        reviewStatus: existing?.review_status || 'pending',
        reviewAttempts: existing?.review_attempts || 0,
      });
      if (roundBudgetDecision.skip) {
        continue;
      }

      const attemptAt = new Date().toISOString();
      const claim = stmtMarkAttemptStarted.run(attemptAt, repoPath, prNumber);
      if (claim.changes === 0) {
        // Lost the cross-process compare-and-swap. Either another
        // watcher just claimed this row, or the row's status moved to
        // a non-claimable state (`reviewing`, `failed-orphan`, terminal)
        // between the readback above and the UPDATE here. Either way,
        // do NOT spawn a reviewer; the next poll will see fresh state.
        console.log(
          `[watcher] Lost claim race on ${repoPath}#${prNumber} — another watcher is handling this PR (or its row is now in a non-claimable state). Skipping.`
        );
        continue;
      }
      await setLinearInReview(linearTicketId);

      // Final-round inputs come from the durable per-PR follow-up ledger,
      // not from `reviewed_prs.review_attempts`. Two reasons (reviewer
      // blocking issues #1 and #2):
      //
      //   1. `review_attempts` is incremented for failed posts / OAuth
      //      crashes / reviewer timeouts as well as successful posts. A
      //      transient post failure should not count as a remediation
      //      cycle and must not silently trip the lenient threshold.
      //
      //   2. `maxRemediationRounds` must come from the job's persisted
      //      cap, not the global default. A legacy job created with the
      //      old 6-round cap must be allowed to use all 6 rounds, even
      //      though new jobs default to 3.
      //
      // `summarizePRRemediationLedger` reads currentRound from terminal
      // follow-up jobs (the only place a remediation cycle is actually
      // recorded as completed) and the latest job's persisted maxRounds.
      const ledger = summarizePRRemediationLedger(ROOT, {
        repo: repoPath,
        prNumber,
      });
      const reviewAttemptNumber = ledger.completedRoundsForPR + 1;
      const maxRemediationRounds = ledger.latestMaxRounds || DEFAULT_MAX_REMEDIATION_ROUNDS;

      const result = await spawnReviewer({
        repo: repoPath,
        prNumber,
        reviewerModel: route.reviewerModel,
        botTokenEnv: route.botTokenEnv,
        linearTicketId,
        builderTag: route.tag,
        reviewAttemptNumber,
        maxRemediationRounds,
      });

      settleReviewerAttempt({
        rootDir: ROOT,
        repoPath,
        prNumber,
        result,
        maxRemediationRounds,
      });

      // Sync prlt after each new PR picked up
      await runPrltSync();
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`[watcher] Missing required env var: ${name}`);
    process.exit(1);
  }
}

function main() {
  requireEnv('GITHUB_TOKEN');

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const intervalMs = config.pollIntervalMs ?? 300_000;
  const configuredDeadlineMs = config.pollDeadlineMs;

  if (Object.prototype.hasOwnProperty.call(config, 'fallbackReviewer')) {
    console.error(
      '[watcher] config.fallbackReviewer is no longer supported. Remove it from config.json; malformed titles now fail loud and are never auto-routed.'
    );
    process.exit(1);
  }

  // Reconcile any rows stuck in 'reviewing' from a previous watcher
  // run that died mid-spawn before this poll loop touches the queue.
  // See reconcileOrphanedReviewing for the recovery contract.
  reconcileOrphanedReviewing();

  // Workload-aware deadline: the previous fixed 10m watchdog tripped
  // on legitimate org-wide work (a single spawnReviewer can already
  // consume 5m, and pollOnce processes repos/PRs serially). Resolve
  // the deadline per-call from the current activeRepos count so the
  // budget grows with the workload. Operators can still pin a fixed
  // value via `config.pollDeadlineMs`; an explicit number always
  // wins over the dynamic default.
  function resolveDeadlineMsForCall() {
    if (Number.isFinite(configuredDeadlineMs) && configuredDeadlineMs > 0) {
      return configuredDeadlineMs;
    }
    return computeWorkloadAwarePollDeadlineMs({
      activeRepoCount: activeRepos.length,
    });
  }

  const watchMode = config.org
    ? `org: ${config.org} (dynamic discovery, refresh every ${(config.repoRefreshIntervalMs ?? 3_600_000) / 60_000}m)`
    : `repos: ${activeRepos.join(', ')}`;
  const deadlineLabel = Number.isFinite(configuredDeadlineMs) && configuredDeadlineMs > 0
    ? `${configuredDeadlineMs / 1000}s (configured)`
    : `workload-aware (default floor ${DEFAULT_POLL_DEADLINE_FLOOR_MS / 1000}s)`;
  console.log(
    `[watcher] Starting — ${watchMode} | poll interval: ${intervalMs / 1000}s | poll deadline: ${deadlineLabel}`
  );

  // Self-scheduling loop. Awaiting safePollOnce before sleeping
  // guarantees no two polls overlap, so the previous overlap-skip
  // scheme is no longer needed. Cadence is fixed-rate: the next
  // start is `lastStart + intervalMs`, and the loop sleeps only the
  // remaining delay (clamped at zero). This preserves the operator-
  // expected meaning of `pollIntervalMs` — a 4m poll on a 5m
  // interval is still ~5m start-to-start, not 9m. The watchdog
  // deadline inside safePollOnce protects against a single hung
  // poll wedging the loop forever — on timeout, exitForPollDeadline
  // aborts in-flight reviewer subprocesses and calls process.exit
  // so launchd KeepAlive respawns a clean process.
  const safePollOnce = buildSafePollOnce({
    pollOnceImpl: pollOnce,
    octokit,
    errorHandler: handlePollError,
    onTimeout: exitForPollDeadline,
    deadlineMs: resolveDeadlineMsForCall,
  });

  (async function pollLoop() {
    let nextStart = Date.now();
    await safePollOnce('startup pollOnce');
    nextStart += intervalMs;
    while (true) {
      // Fixed-rate cadence: subtract elapsed work from the next
      // sleep so cadence is start-to-start, not finish-to-start.
      // Math.max(0, ...) means a poll that ran longer than the
      // interval starts the next pass immediately rather than
      // sleeping for a negative delay.
      const sleepMs = Math.max(0, nextStart - Date.now());
      // The interval-sleep timer is the only handle keeping the
      // event loop alive between polls, so it MUST NOT be unref'd.
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
      await safePollOnce('scheduled pollOnce');
      nextStart += intervalMs;
    }
  })().catch((err) => {
    // Should be unreachable — safePollOnce never rejects, it returns
    // a typed result. This is a backstop for an unexpected throw in
    // the loop scaffolding itself.
    console.error('[watcher] poll loop crashed unexpectedly:', err);
    process.exit(1);
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}

export {
  classifyReviewerFailure,
  evaluateRoundBudgetForReview,
  pollOnce,
  settleReviewerAttempt,
};
