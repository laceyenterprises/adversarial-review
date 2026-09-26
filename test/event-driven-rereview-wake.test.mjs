import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REREVIEW_WAKE_REASONS,
  REREVIEW_WAKE_RESETTLE_GUARD_MS,
  REREVIEW_WAKE_STATES,
  classifyRereviewWakeOutcome,
  consumeRereviewWakes,
  listPendingRereviewWakes,
  rereviewWakeBacklog,
  rereviewWakeDedupeKey,
  rereviewWakePendingPath,
  rereviewWakeSettledPath,
  requestRereviewWake,
  settleRereviewWake,
  sweepRereviewWakeQueue,
} from '../src/rereview-wake.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { collectReviewLatencyReport } from '../src/review-latency-report.mjs';
import { main as rereviewWakeCli } from '../bin/rereview-wake.mjs';

const REPO = 'laceyenterprises/agent-os';
const PR = 6603;
const HEAD = 'a'.repeat(40);

function root() {
  return mkdtempSync(join(tmpdir(), 'rereview-wake-'));
}

function collectingWake(calls) {
  return (args) => {
    calls.push(args);
    return { requested: true, payload: { request_id: 'watcher-wake-1', requested_at: args.requestedAt, reason: args.reason } };
  };
}

test('a producer with the wrong UID refuses before creating queue or SQLite files', (t) => {
  const rootDir = root();
  if (process.getuid === undefined) return;
  t.mock.method(process, 'getuid', () => 10_000_000);
  const result = requestRereviewWake({
    rootDir, repo: REPO, prNumber: PR, reason: REREVIEW_WAKE_REASONS.OPERATOR,
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'wake-queue-owner-mismatch');
  assert.equal(existsSync(join(rootDir, 'data')), false);
});

function latencyRows(rootDir) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    return db.prepare(
      `SELECT event_type, reason, idempotency_key, payload_json
         FROM review_latency_events
        WHERE event_type = 'rereview_wake'
        ORDER BY event_id ASC`
    ).all().map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
  } finally {
    db.close();
  }
}

function seedReviewRow(rootDir, overrides = {}) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    const row = {
      repo: REPO,
      pr_number: PR,
      revision_ref: HEAD,
      reviewed_at: '2026-09-21T00:00:00.000Z',
      reviewer: 'agy',
      pr_state: 'open',
      review_status: 'pending',
      posted_at: null,
      reviewer_head_sha: null,
      ...overrides,
    };
    db.prepare(
      `INSERT INTO reviewed_prs (repo, pr_number, revision_ref, reviewed_at, reviewer, pr_state,
                                 review_status, posted_at, reviewer_head_sha)
       VALUES (@repo, @pr_number, @revision_ref, @reviewed_at, @reviewer, @pr_state,
               @review_status, @posted_at, @reviewer_head_sha)`
    ).run(row);
    return row;
  } finally {
    db.close();
  }
}

function readReviewRow(rootDir, repo = REPO, prNumber = PR) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    return db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(repo, prNumber) || null;
  } finally {
    db.close();
  }
}

// ── producers ────────────────────────────────────────────────────────────────

test('remediation closeout enqueues a durable wake and nudges the watcher', () => {
  const rootDir = root();
  const calls = [];
  const result = requestRereviewWake({
    rootDir,
    repo: REPO,
    prNumber: PR,
    headSha: HEAD,
    reason: REREVIEW_WAKE_REASONS.REMEDIATION_CLOSEOUT,
    source: 'follow-up-remediation',
    sourceRef: 'job-1',
    requestedAt: '2026-09-21T01:00:00.000Z',
    requestWatcherWakeImpl: collectingWake(calls),
    log: { warn() {} },
  });

  assert.equal(result.requested, true);
  assert.equal(result.outcome, 'requested');
  assert.equal(result.wakeReason, REREVIEW_WAKE_REASONS.REMEDIATION_CLOSEOUT);
  assert.equal(calls.length, 1);
  // The watcher-wake reason stays on the historical handoff string so the
  // handoff telemetry step ledger keeps counting this transition.
  assert.equal(calls[0].reason, 'remediation-to-rereview');
  assert.equal(calls[0].headSha, HEAD);

  const record = JSON.parse(readFileSync(result.recordPath, 'utf8'));
  assert.equal(record.state, REREVIEW_WAKE_STATES.REQUESTED);
  assert.equal(record.reason, REREVIEW_WAKE_REASONS.REMEDIATION_CLOSEOUT);
  assert.equal(record.sourceRef, 'job-1');
  assert.equal(record.watcherWake.requested, true);

  const rows = latencyRows(rootDir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.state, 'requested');
  assert.equal(
    rows[0].idempotency_key,
    `rereview-wake:requested:${rereviewWakeDedupeKey({ repo: REPO, prNumber: PR, headSha: HEAD, reason: REREVIEW_WAKE_REASONS.REMEDIATION_CLOSEOUT })}`
  );
});

test('a CI transition wake is a distinct request from the remediation wake on the same head', () => {
  const rootDir = root();
  const calls = [];
  const base = {
    rootDir,
    repo: REPO,
    prNumber: PR,
    headSha: HEAD,
    requestWatcherWakeImpl: collectingWake(calls),
    log: { warn() {} },
  };
  assert.equal(
    requestRereviewWake({ ...base, reason: REREVIEW_WAKE_REASONS.REMEDIATION_CLOSEOUT }).outcome,
    'requested'
  );
  assert.equal(
    requestRereviewWake({ ...base, reason: REREVIEW_WAKE_REASONS.CI_TRANSITION }).outcome,
    'requested'
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].reason, 'ci-transition-to-rereview');
  assert.equal(listPendingRereviewWakes(rootDir).length, 2);
});

test('a failed watcher wake transport still leaves the durable request behind', () => {
  const rootDir = root();
  const warnings = [];
  const result = requestRereviewWake({
    rootDir,
    repo: REPO,
    prNumber: PR,
    headSha: HEAD,
    reason: REREVIEW_WAKE_REASONS.CI_TRANSITION,
    requestWatcherWakeImpl: () => { throw new Error('wake file unwritable'); },
    log: { warn: (message) => warnings.push(message) },
  });
  assert.equal(result.requested, true);
  assert.equal(result.watcherWake.requested, false);
  assert.equal(result.watcherWake.reason, 'wake-transport-failed');
  assert.equal(warnings.length, 1);
  // Polling is the fallback: the request survives so the next ordinary tick
  // still drains it.
  assert.equal(listPendingRereviewWakes(rootDir).length, 1);
});

test('an invalid or unknown-reason wake is refused without writing a record', () => {
  const rootDir = root();
  const calls = [];
  const wake = collectingWake(calls);
  assert.equal(
    requestRereviewWake({ rootDir, repo: '', prNumber: PR, reason: REREVIEW_WAKE_REASONS.OPERATOR, requestWatcherWakeImpl: wake }).reason,
    'invalid-wake-repo'
  );
  assert.equal(
    requestRereviewWake({ rootDir, repo: REPO, prNumber: 0, reason: REREVIEW_WAKE_REASONS.OPERATOR, requestWatcherWakeImpl: wake }).reason,
    'invalid-wake-pr-number'
  );
  assert.equal(
    requestRereviewWake({ rootDir, repo: REPO, prNumber: PR, reason: 'whatever-i-feel-like', requestWatcherWakeImpl: wake }).reason,
    'unknown-wake-reason'
  );
  assert.equal(calls.length, 0);
  assert.equal(listPendingRereviewWakes(rootDir).length, 0);
});

test('the env kill switch degrades to poll-only without erroring', () => {
  const rootDir = root();
  const calls = [];
  const result = requestRereviewWake({
    rootDir,
    repo: REPO,
    prNumber: PR,
    headSha: HEAD,
    reason: REREVIEW_WAKE_REASONS.OPERATOR,
    env: { ADVERSARIAL_REREVIEW_WAKE: '0' },
    requestWatcherWakeImpl: collectingWake(calls),
  });
  assert.equal(result.requested, false);
  assert.equal(result.outcome, 'disabled');
  assert.equal(calls.length, 0);
  assert.equal(listPendingRereviewWakes(rootDir).length, 0);
});

// ── dedupe ───────────────────────────────────────────────────────────────────

test('duplicate wakes coalesce on (repo, pr, head, reason) and fire one watcher wake', () => {
  const rootDir = root();
  const calls = [];
  const args = {
    rootDir,
    repo: REPO,
    prNumber: PR,
    headSha: HEAD,
    reason: REREVIEW_WAKE_REASONS.REMEDIATION_CLOSEOUT,
    requestWatcherWakeImpl: collectingWake(calls),
    log: { warn() {} },
  };
  assert.equal(requestRereviewWake(args).outcome, 'requested');
  assert.equal(requestRereviewWake(args).outcome, 'duplicate');
  assert.equal(requestRereviewWake(args).reason, 'wake-already-pending');
  assert.equal(calls.length, 1);
  assert.equal(listPendingRereviewWakes(rootDir).length, 1);
  assert.equal(latencyRows(rootDir).length, 1);
});

test('a new head gets its own wake even while the old head request is pending', () => {
  const rootDir = root();
  const calls = [];
  const args = {
    rootDir,
    repo: REPO,
    prNumber: PR,
    reason: REREVIEW_WAKE_REASONS.REMEDIATION_CLOSEOUT,
    requestWatcherWakeImpl: collectingWake(calls),
    log: { warn() {} },
  };
  assert.equal(requestRereviewWake({ ...args, headSha: HEAD }).outcome, 'requested');
  assert.equal(requestRereviewWake({ ...args, headSha: 'b'.repeat(40) }).outcome, 'requested');
  assert.equal(calls.length, 2);
  assert.equal(listPendingRereviewWakes(rootDir).length, 2);
});

function writeSettledWake(rootDir, identity, settledAt) {
  mkdirSync(join(rootDir, 'data', 'rereview-wakes', 'settled'), { recursive: true });
  writeFileSync(
    rereviewWakeSettledPath(rootDir, identity, REREVIEW_WAKE_STATES.COMPLETED),
    `${JSON.stringify({ ...identity, state: 'completed', settledAt })}\n`
  );
}

test('a just-settled wake is not re-enqueued by a late duplicate producer', () => {
  const rootDir = root();
  const identity = { repo: REPO, prNumber: PR, headSha: HEAD, reason: REREVIEW_WAKE_REASONS.CI_TRANSITION };
  writeSettledWake(rootDir, identity, '2026-09-21T01:00:00.000Z');
  const calls = [];
  const result = requestRereviewWake({
    rootDir, ...identity, requestedAt: '2026-09-21T01:02:00.000Z',
    requestWatcherWakeImpl: collectingWake(calls), log: { warn() {} },
  });
  assert.equal(result.outcome, 'duplicate');
  assert.equal(result.reason, 'wake-already-completed');
  assert.equal(calls.length, 0);
});

test('an old settled wake does not suppress a genuinely new transition on the same head', () => {
  // A remediation round that only posts a refutation leaves the head unchanged.
  // If the settled record suppressed forever, that PR would silently lose the
  // wake for the rest of retention and quietly fall back to poll latency.
  const rootDir = root();
  const identity = { repo: REPO, prNumber: PR, headSha: HEAD, reason: REREVIEW_WAKE_REASONS.REMEDIATION_CLOSEOUT };
  writeSettledWake(rootDir, identity, '2026-09-21T01:00:00.000Z');
  const calls = [];
  const result = requestRereviewWake({
    rootDir,
    ...identity,
    requestedAt: new Date(Date.parse('2026-09-21T01:00:00.000Z') + REREVIEW_WAKE_RESETTLE_GUARD_MS + 1).toISOString(),
    requestWatcherWakeImpl: collectingWake(calls),
    log: { warn() {} },
  });
  assert.equal(result.outcome, 'requested');
  assert.equal(calls.length, 1);
  assert.equal(listPendingRereviewWakes(rootDir).length, 1);
});

test('an unreadable settle time fails open toward flow', () => {
  const rootDir = root();
  const identity = { repo: REPO, prNumber: PR, headSha: HEAD, reason: REREVIEW_WAKE_REASONS.OPERATOR };
  writeSettledWake(rootDir, identity, 'not-a-timestamp');
  const calls = [];
  assert.equal(
    requestRereviewWake({ rootDir, ...identity, requestWatcherWakeImpl: collectingWake(calls), log: { warn() {} } }).outcome,
    'requested'
  );
  assert.equal(calls.length, 1);
});

// ── classifier ───────────────────────────────────────────────────────────────

test('classifier maps admission outcomes to wake states', () => {
  const record = { repo: REPO, prNumber: PR, headSha: HEAD, requestedAt: '2026-09-21T01:00:00.000Z' };
  const nowMs = Date.parse('2026-09-21T01:05:00.000Z');
  const classify = (reviewRow, extra = {}) => classifyRereviewWakeOutcome({ record, reviewRow, nowMs, ...extra });

  assert.deepEqual(
    classify({ pr_state: 'merged', review_status: 'posted' }),
    { state: 'skipped', reason: 'pr-terminal' }
  );
  assert.deepEqual(classify(null), { state: 'skipped', reason: 'review-row-missing' });
  assert.deepEqual(
    classify({ pr_state: 'open', review_status: 'pending' }, { currentHeadSha: 'c'.repeat(40) }),
    { state: 'skipped', reason: 'head-superseded' }
  );
  assert.deepEqual(
    classify({ pr_state: 'open', review_status: 'malformed' }),
    { state: 'skipped', reason: 'review-status-terminal:malformed' }
  );
  assert.deepEqual(
    classify({ pr_state: 'open', review_status: 'pending' }),
    { state: 'completed', reason: 'rereview-admitted:pending' }
  );
  assert.deepEqual(
    classify({ pr_state: 'open', review_status: 'reviewing' }),
    { state: 'completed', reason: 'rereview-admitted:reviewing' }
  );
  assert.deepEqual(
    classify({
      pr_state: 'open',
      review_status: 'posted',
      posted_at: '2026-09-21T01:02:00.000Z',
      reviewer_head_sha: HEAD,
    }),
    { state: 'completed', reason: 'rereview-posted' }
  );
  // A post that predates the request is the OLD review, not this wake's.
  assert.deepEqual(
    classify({
      pr_state: 'open',
      review_status: 'posted',
      posted_at: '2026-09-20T23:00:00.000Z',
      reviewer_head_sha: HEAD,
    }),
    { state: 'pending', reason: 'awaiting-admission:posted' }
  );
});

test('a CI-blocked row keeps the wake pending with a named reason until it expires', () => {
  const record = { repo: REPO, prNumber: PR, headSha: HEAD, requestedAt: '2026-09-21T01:00:00.000Z' };
  const reviewRow = { pr_state: 'open', review_status: 'ci-blocked' };
  assert.deepEqual(
    classifyRereviewWakeOutcome({ record, reviewRow, nowMs: Date.parse('2026-09-21T02:00:00.000Z') }),
    { state: 'pending', reason: 'ci-blocked' }
  );
  assert.deepEqual(
    classifyRereviewWakeOutcome({
      record,
      reviewRow,
      nowMs: Date.parse('2026-09-21T01:00:00.000Z') + 1,
      maxAgeMs: 0,
    }),
    { state: 'skipped', reason: 'wake-expired:ci-blocked' }
  );
});

// ── consumer ─────────────────────────────────────────────────────────────────

test('the admission lane claims then completes a wake whose row is armed', () => {
  const rootDir = root();
  requestRereviewWake({
    rootDir,
    repo: REPO,
    prNumber: PR,
    headSha: HEAD,
    reason: REREVIEW_WAKE_REASONS.REMEDIATION_CLOSEOUT,
    requestedAt: '2026-09-21T01:00:00.000Z',
    requestWatcherWakeImpl: collectingWake([]),
    log: { warn() {} },
  });
  const summary = consumeRereviewWakes({
    rootDir,
    repo: REPO,
    prNumber: PR,
    reviewRow: { pr_state: 'open', review_status: 'pending' },
    currentHeadSha: HEAD,
    at: '2026-09-21T01:00:34.000Z',
    log: { warn() {} },
  });
  assert.deepEqual(
    { claimed: summary.claimed, completed: summary.completed, skipped: summary.skipped, held: summary.held },
    { claimed: 1, completed: 1, skipped: 0, held: 0 }
  );
  assert.equal(listPendingRereviewWakes(rootDir).length, 0);

  const states = latencyRows(rootDir).map((row) => row.payload.state);
  assert.deepEqual(states, ['requested', 'claimed', 'completed']);
  const settled = JSON.parse(readFileSync(
    rereviewWakeSettledPath(rootDir, { repo: REPO, prNumber: PR, headSha: HEAD, reason: REREVIEW_WAKE_REASONS.REMEDIATION_CLOSEOUT }, 'completed'),
    'utf8'
  ));
  assert.equal(settled.settledReason, 'rereview-admitted:pending');
  assert.equal(settled.claimedAt, '2026-09-21T01:00:34.000Z');
});

test('an ineligible wake is skipped with a named reason rather than held forever', () => {
  const rootDir = root();
  requestRereviewWake({
    rootDir,
    repo: REPO,
    prNumber: PR,
    headSha: HEAD,
    reason: REREVIEW_WAKE_REASONS.OPERATOR,
    requestWatcherWakeImpl: collectingWake([]),
    log: { warn() {} },
  });
  const summary = consumeRereviewWakes({
    rootDir,
    repo: REPO,
    prNumber: PR,
    reviewRow: { pr_state: 'merged', review_status: 'posted' },
    currentHeadSha: HEAD,
    subjectTerminal: true,
    at: '2026-09-21T01:01:00.000Z',
    log: { warn() {} },
  });
  assert.equal(summary.skipped, 1);
  assert.equal(summary.completed, 0);
  assert.equal(listPendingRereviewWakes(rootDir).length, 0);
  assert.deepEqual(latencyRows(rootDir).map((row) => row.payload.state), ['requested', 'claimed', 'skipped']);
});

test('a CI-blocked PR keeps its wake queued and does not re-emit a claimed event', () => {
  const rootDir = root();
  requestRereviewWake({
    rootDir,
    repo: REPO,
    prNumber: PR,
    headSha: HEAD,
    reason: REREVIEW_WAKE_REASONS.CI_TRANSITION,
    requestWatcherWakeImpl: collectingWake([]),
    log: { warn() {} },
  });
  const blocked = { pr_state: 'open', review_status: 'ci-blocked' };
  const first = consumeRereviewWakes({
    rootDir, repo: REPO, prNumber: PR, reviewRow: blocked, currentHeadSha: HEAD,
    at: '2026-09-21T01:01:00.000Z', log: { warn() {} },
  });
  const second = consumeRereviewWakes({
    rootDir, repo: REPO, prNumber: PR, reviewRow: blocked, currentHeadSha: HEAD,
    at: '2026-09-21T01:06:00.000Z', log: { warn() {} },
  });
  assert.equal(first.claimed, 1);
  assert.equal(first.held, 1);
  // Re-observing a held wake must not inflate the claim telemetry; the claim
  // time is the FIRST pickup, which is the latency operators care about.
  assert.equal(second.claimed, 0);
  assert.equal(second.held, 1);

  const [pending] = listPendingRereviewWakes(rootDir);
  assert.equal(pending.state, REREVIEW_WAKE_STATES.CLAIMED);
  assert.equal(pending.holdReason, 'ci-blocked');
  assert.equal(pending.holdCount, 2);
  assert.equal(pending.claimedAt, '2026-09-21T01:01:00.000Z');
  assert.deepEqual(latencyRows(rootDir).map((row) => row.payload.state), ['requested', 'claimed']);

  // Then CI goes green and admission arms the row: the same wake settles.
  const third = consumeRereviewWakes({
    rootDir, repo: REPO, prNumber: PR, reviewRow: { pr_state: 'open', review_status: 'pending' },
    currentHeadSha: HEAD, at: '2026-09-21T01:11:00.000Z', log: { warn() {} },
  });
  assert.equal(third.completed, 1);
  assert.equal(listPendingRereviewWakes(rootDir).length, 0);
});

test('a wake for another PR is left alone by the subject drain', () => {
  const rootDir = root();
  const wake = collectingWake([]);
  requestRereviewWake({ rootDir, repo: REPO, prNumber: PR, headSha: HEAD, reason: REREVIEW_WAKE_REASONS.OPERATOR, requestWatcherWakeImpl: wake, log: { warn() {} } });
  requestRereviewWake({ rootDir, repo: REPO, prNumber: PR + 1, headSha: HEAD, reason: REREVIEW_WAKE_REASONS.OPERATOR, requestWatcherWakeImpl: wake, log: { warn() {} } });
  const summary = consumeRereviewWakes({
    rootDir, repo: REPO, prNumber: PR, reviewRow: { pr_state: 'open', review_status: 'pending' },
    currentHeadSha: HEAD, at: '2026-09-21T01:01:00.000Z', log: { warn() {} },
  });
  assert.equal(summary.completed, 1);
  const remaining = listPendingRereviewWakes(rootDir);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].prNumber, PR + 1);
});

// ── restart / durability ─────────────────────────────────────────────────────

test('a watcher restart still drains a wake requested while it was down', () => {
  const rootDir = root();
  // A wake lands while the watcher is stopped: the transient wake FILE is the
  // only thing the pre-RPL-04 path had, and a restart consumes it as "already
  // seen". The durable record is what survives.
  requestRereviewWake({
    rootDir,
    repo: REPO,
    prNumber: PR,
    headSha: HEAD,
    reason: REREVIEW_WAKE_REASONS.REMEDIATION_CLOSEOUT,
    requestedAt: '2026-09-21T01:00:00.000Z',
    requestWatcherWakeImpl: collectingWake([]),
    log: { warn() {} },
  });
  seedReviewRow(rootDir, { review_status: 'pending', revision_ref: HEAD });

  // Fresh process: nothing in memory, only the queue on disk.
  const pendingAfterRestart = listPendingRereviewWakes(rootDir);
  assert.equal(pendingAfterRestart.length, 1);
  assert.equal(pendingAfterRestart[0].state, REREVIEW_WAKE_STATES.REQUESTED);

  const summary = sweepRereviewWakeQueue({
    rootDir,
    lookupReviewRow: (repo, prNumber) => readReviewRow(rootDir, repo, prNumber),
    at: '2026-09-21T01:30:00.000Z',
    log: { warn() {} },
  });
  assert.deepEqual(
    { scanned: summary.scanned, completed: summary.completed, skipped: summary.skipped, held: summary.held },
    { scanned: 1, completed: 1, skipped: 0, held: 0 }
  );
  assert.equal(listPendingRereviewWakes(rootDir).length, 0);
});

test('the backlog sweep retires a wake whose PR the admission lane can never reach', () => {
  const rootDir = root();
  requestRereviewWake({
    rootDir, repo: REPO, prNumber: PR, headSha: HEAD, reason: REREVIEW_WAKE_REASONS.OPERATOR,
    requestWatcherWakeImpl: collectingWake([]), log: { warn() {} },
  });
  const summary = sweepRereviewWakeQueue({
    rootDir,
    lookupReviewRow: () => null,
    at: '2026-09-21T02:00:00.000Z',
    log: { warn() {} },
  });
  assert.equal(summary.skipped, 1);
  assert.equal(listPendingRereviewWakes(rootDir).length, 0);
  const settled = readdirSync(join(rootDir, 'data', 'rereview-wakes', 'settled'));
  assert.equal(settled.length, 1);
  assert.match(settled[0], /\.skipped\.json$/);
});

test('a lookup failure during the sweep holds the wake instead of dropping it', () => {
  const rootDir = root();
  requestRereviewWake({
    rootDir, repo: REPO, prNumber: PR, headSha: HEAD, reason: REREVIEW_WAKE_REASONS.OPERATOR,
    requestWatcherWakeImpl: collectingWake([]), log: { warn() {} },
  });
  const warnings = [];
  const summary = sweepRereviewWakeQueue({
    rootDir,
    lookupReviewRow: () => { throw new Error('database is locked'); },
    log: { warn: (message) => warnings.push(message) },
  });
  assert.equal(summary.held, 1);
  assert.equal(warnings.length, 1);
  assert.equal(listPendingRereviewWakes(rootDir).length, 1);
});

// ── operator surfaces ────────────────────────────────────────────────────────

test('the backlog surface reports depth, age, and what is holding each wake', () => {
  const rootDir = root();
  const wake = collectingWake([]);
  requestRereviewWake({
    rootDir, repo: REPO, prNumber: PR, headSha: HEAD,
    reason: REREVIEW_WAKE_REASONS.CI_TRANSITION, requestedAt: '2026-09-21T01:00:00.000Z',
    requestWatcherWakeImpl: wake, log: { warn() {} },
  });
  requestRereviewWake({
    rootDir, repo: REPO, prNumber: PR + 1, headSha: HEAD,
    reason: REREVIEW_WAKE_REASONS.OPERATOR, requestedAt: '2026-09-21T01:30:00.000Z',
    requestWatcherWakeImpl: wake, log: { warn() {} },
  });
  consumeRereviewWakes({
    rootDir, repo: REPO, prNumber: PR, reviewRow: { pr_state: 'open', review_status: 'ci-blocked' },
    currentHeadSha: HEAD, at: '2026-09-21T01:02:00.000Z', log: { warn() {} },
  });

  const backlog = rereviewWakeBacklog({ rootDir, nowMs: Date.parse('2026-09-21T02:00:00.000Z') });
  assert.equal(backlog.pending, 2);
  assert.equal(backlog.claimed, 1);
  assert.equal(backlog.unclaimed, 1);
  assert.equal(backlog.oldest.prNumber, PR);
  assert.equal(backlog.oldestAgeMs, 60 * 60 * 1000);
  assert.equal(backlog.oldest.claimLatencyMs, 2 * 60 * 1000);
  assert.deepEqual(backlog.byHoldReason, [{ reason: 'ci-blocked', count: 1 }]);
  assert.deepEqual(
    backlog.byReason.map((row) => row.reason).sort(),
    [REREVIEW_WAKE_REASONS.CI_TRANSITION, REREVIEW_WAKE_REASONS.OPERATOR].sort()
  );
});

test('the latency report carries the wake queue and the rereview stage', () => {
  const rootDir = root();
  requestRereviewWake({
    rootDir, repo: REPO, prNumber: PR, headSha: HEAD, reason: REREVIEW_WAKE_REASONS.CI_TRANSITION,
    requestWatcherWakeImpl: collectingWake([]), log: { warn() {} },
  });
  const report = collectReviewLatencyReport({ rootDir, since: '24h' });
  assert.equal(report.rereviewWakeQueue.available, true);
  assert.equal(report.rereviewWakeQueue.pending, 1);
  assert.ok(report.stages.some((stage) => stage.key === 'rereview_wake_to_row_claimed'));
});

test('the operator CLI requests, coalesces, and reports the queue', () => {
  const rootDir = root();
  const out = [];
  const err = [];
  const io = { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } };
  const argv = ['request', '--root-dir', rootDir, '--repo', REPO, '--pr', String(PR), '--head-sha', HEAD];

  assert.equal(rereviewWakeCli(argv, io), 0);
  assert.match(out.join(''), /^requested /);
  // Re-running is idempotent AND exits zero, so an operator retry loop cannot
  // wedge on the queue's own dedupe.
  assert.equal(rereviewWakeCli(argv, io), 0);
  assert.match(out.join(''), /duplicate /);

  out.length = 0;
  assert.equal(rereviewWakeCli(['status', '--root-dir', rootDir, '--json'], io), 0);
  const status = JSON.parse(out.join(''));
  assert.equal(status.pending, 1);
  assert.equal(status.entries[0].reason, REREVIEW_WAKE_REASONS.OPERATOR);

  assert.equal(rereviewWakeCli(['request', '--root-dir', rootDir, '--repo', 'not-a-repo', '--pr', '1'], io), 64);
  assert.equal(rereviewWakeCli(['request', '--root-dir', rootDir, '--repo', REPO, '--pr', String(PR), '--reason', 'nope'], io), 64);
  assert.equal(rereviewWakeCli(['explode', '--root-dir', rootDir], io), 64);
  assert.match(err.join(''), /unknown command: explode/);
});

test('status scoping filters entries without lying about the fleet-wide backlog', () => {
  const rootDir = root();
  const wake = collectingWake([]);
  requestRereviewWake({ rootDir, repo: REPO, prNumber: PR, reason: REREVIEW_WAKE_REASONS.OPERATOR, requestWatcherWakeImpl: wake, log: { warn() {} } });
  requestRereviewWake({ rootDir, repo: 'laceyenterprises/other', prNumber: 9, reason: REREVIEW_WAKE_REASONS.OPERATOR, requestWatcherWakeImpl: wake, log: { warn() {} } });
  const out = [];
  const io = { stdout: { write: (text) => out.push(text) }, stderr: { write: () => {} } };
  assert.equal(rereviewWakeCli(['status', '--root-dir', rootDir, '--repo', REPO, '--json'], io), 0);
  const status = JSON.parse(out.join(''));
  assert.equal(status.pending, 2);
  assert.equal(status.entries.length, 1);
  assert.equal(status.entries[0].repo, REPO);
});

test('a large backlog is sampled and the per-tick sweep rotates across records', () => {
  const rootDir = root();
  const dir = join(rootDir, 'data', 'rereview-wakes', 'pending');
  mkdirSync(dir, { recursive: true });
  for (let n = 0; n < 201; n += 1) {
    writeFileSync(join(dir, `wake-${String(n).padStart(3, '0')}.json`), JSON.stringify({
      repo: REPO, prNumber: n + 1, reason: REREVIEW_WAKE_REASONS.OPERATOR,
      state: 'requested', requestedAt: '2026-09-21T01:00:00.000Z',
    }));
  }
  const backlog = rereviewWakeBacklog({ rootDir });
  assert.equal(backlog.pending, 201);
  assert.equal(backlog.truncated, true);
  assert.equal(backlog.entries.length, 200);
  assert.equal(backlog.claimed, null);
  assert.equal(backlog.unclaimed, null);

  const first = listPendingRereviewWakes(rootDir, { limit: 200, roundRobin: true });
  const second = listPendingRereviewWakes(rootDir, { limit: 200, roundRobin: true });
  assert.equal(new Set([...first, ...second].map((record) => record.prNumber)).size, 201);
});

test('settled retention runs off the enqueue path and at most every ten minutes', () => {
  const rootDir = root();
  const settled = join(rootDir, 'data', 'rereview-wakes', 'settled');
  mkdirSync(settled, { recursive: true });
  const nowMs = Date.parse('2026-09-21T12:00:00.000Z');
  const writeOld = (name) => {
    const file = join(settled, name);
    writeFileSync(file, '{}');
    const old = new Date(nowMs - 31 * 24 * 60 * 60 * 1000);
    utimesSync(file, old, old);
    return file;
  };
  const first = writeOld('old-a.json');
  requestRereviewWake({ rootDir, repo: REPO, prNumber: PR, reason: REREVIEW_WAKE_REASONS.OPERATOR,
    requestWatcherWakeImpl: collectingWake([]), log: { warn() {} } });
  assert.equal(existsSync(first), true, 'request must not scan settled files');
  sweepRereviewWakeQueue({ rootDir, at: new Date(nowMs).toISOString(), lookupReviewRow: () => null,
    log: { warn() {} } });
  assert.equal(existsSync(first), false);
  const second = writeOld('old-b.json');
  sweepRereviewWakeQueue({ rootDir, at: new Date(nowMs + 60_000).toISOString(), lookupReviewRow: () => null,
    log: { warn() {} } });
  assert.equal(existsSync(second), true);
  sweepRereviewWakeQueue({ rootDir, at: new Date(nowMs + 11 * 60_000).toISOString(), lookupReviewRow: () => null,
    log: { warn() {} } });
  assert.equal(existsSync(second), false);
});

test('the pending path is stable for a given dedupe identity', () => {
  const rootDir = root();
  const identity = { repo: REPO, prNumber: PR, headSha: HEAD, reason: REREVIEW_WAKE_REASONS.OPERATOR };
  assert.equal(rereviewWakePendingPath(rootDir, identity), rereviewWakePendingPath(rootDir, { ...identity }));
  assert.notEqual(
    rereviewWakePendingPath(rootDir, identity),
    rereviewWakePendingPath(rootDir, { ...identity, headSha: 'b'.repeat(40) })
  );
  assert.equal(
    rereviewWakeDedupeKey({ repo: REPO, prNumber: PR, reason: REREVIEW_WAKE_REASONS.OPERATOR }),
    `${REPO}#${PR}@-:operator`
  );
});

// ── watcher wiring (integration) ─────────────────────────────────────────────

test('the adoption phase sweeps the wake backlog and reports its depth', async () => {
  const { runQueuedReviewAdoptionPhase } = await import('../src/posted-review-row.mjs');
  const rootDir = root();
  requestRereviewWake({
    rootDir, repo: REPO, prNumber: PR, headSha: HEAD,
    reason: REREVIEW_WAKE_REASONS.REMEDIATION_CLOSEOUT,
    requestWatcherWakeImpl: collectingWake([]), log: { warn() {} },
  });
  requestRereviewWake({
    rootDir, repo: REPO, prNumber: PR + 1, headSha: HEAD,
    reason: REREVIEW_WAKE_REASONS.CI_TRANSITION,
    requestWatcherWakeImpl: collectingWake([]), log: { warn() {} },
  });

  const logs = [];
  await runQueuedReviewAdoptionPhase({
    rootDir,
    drainReviewerDispatchCandidates: async () => ({ dispatched: 0, deferred: 0 }),
    retryPendingMergeAgentLifecycleCleanupsImpl: async () => {},
    syncPRLifecycleImpl: async () => {},
    retryPendingDagAutowalkOnMergeImpl: async () => {},
    retryPendingTriageSyncsImpl: async () => ({ attempted: 0, synced: 0, pending: 0 }),
    retryPendingMergeCloseoutsImpl: async () => {},
    retryPendingRetriggerAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
    retryPendingRetriggerReviewAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
    noProgressLaneGate: { shouldRun: () => true, recordResult: () => {} },
    postedReviewHandlers: [],
    postReviewMaintenanceHandlers: [],
    runPostedReviewHandlersFairlyImpl: async () => ({ executed: [], deferred: [], timedOut: null }),
    // PR 6603 has an armed row; 6604 has none, so one completes and one is
    // retired as unreachable — the two halves of the backstop's job.
    sweepRereviewWakeQueueImpl: (args) => sweepRereviewWakeQueue({
      ...args,
      lookupReviewRow: (repo, prNumber) => (
        prNumber === PR ? { pr_state: 'open', review_status: 'pending', revision_ref: HEAD } : null
      ),
    }),
    logger: { log: (message) => logs.push(String(message)), warn() {}, error() {} },
  });

  assert.equal(listPendingRereviewWakes(rootDir).length, 0);
  const line = logs.find((message) => message.includes('rereview-wake queue:'));
  assert.ok(line, `expected a backlog log line, got: ${logs.join(' | ')}`);
  assert.match(line, /swept=2 completed=1 skipped=1 held=0/);
});

test('a raising wake sweep cannot break the adoption phase', async () => {
  const { runQueuedReviewAdoptionPhase } = await import('../src/posted-review-row.mjs');
  const errors = [];
  let postedLaneRan = false;
  await runQueuedReviewAdoptionPhase({
    rootDir: root(),
    drainReviewerDispatchCandidates: async () => ({ dispatched: 0, deferred: 0 }),
    retryPendingMergeAgentLifecycleCleanupsImpl: async () => {},
    syncPRLifecycleImpl: async () => {},
    retryPendingDagAutowalkOnMergeImpl: async () => {},
    retryPendingTriageSyncsImpl: async () => ({ attempted: 0, synced: 0, pending: 0 }),
    retryPendingMergeCloseoutsImpl: async () => {},
    retryPendingRetriggerAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
    retryPendingRetriggerReviewAckCommentsImpl: async () => ({ attempted: 0, posted: 0 }),
    noProgressLaneGate: { shouldRun: () => true, recordResult: () => {} },
    postedReviewHandlers: [],
    postReviewMaintenanceHandlers: [],
    runPostedReviewHandlersFairlyImpl: async () => {
      postedLaneRan = true;
      return { executed: [], deferred: [], timedOut: null };
    },
    sweepRereviewWakeQueueImpl: () => { throw new Error('queue directory exploded'); },
    logger: { log() {}, warn() {}, error: (message) => errors.push(String(message)) },
  });
  assert.equal(postedLaneRan, true);
  assert.match(errors.join(' | '), /rereview wake backlog sweep raised: queue directory exploded/);
});

test('the admission lane drains wakes before it decides anything about the PR', () => {
  const source = readFileSync(new URL('../src/pollonce-phases.mjs', import.meta.url), 'utf8');
  const rowRead = source.indexOf('let current = stmtGetReviewRow.get(repoPath, prNumber);');
  const drain = source.indexOf('consumeRereviewWakesImpl({', rowRead);
  const ciBlockedBranch = source.indexOf("current?.review_status === REREVIEW_CI_BLOCKED_STATUS", rowRead);
  const spawnDecision = source.indexOf('const activeFollowUp = shouldDeferReviewForActiveFollowUp({', rowRead);
  assert.ok(rowRead > 0 && drain > 0 && ciBlockedBranch > 0 && spawnDecision > 0);
  // The drain must see the row this tick evaluated and must run before the
  // branches that can return early, or a CI-blocked PR would never have its
  // wake claimed in the admission lane at all.
  assert.ok(drain > rowRead, 'the drain must read the row the admission lane just loaded');
  assert.ok(drain < ciBlockedBranch, 'the drain must run before the ci-blocked early return');
  assert.ok(drain < spawnDecision, 'the drain must run before the reviewer spawn decision');
});

test('the CI-transition producer only fires once the row is actually re-armed', () => {
  const source = readFileSync(new URL('../src/pollonce-phases.mjs', import.meta.url), 'utf8');
  assert.match(source, /const requestCiTransitionRereviewWake = \(\{[^}]*armed[^}]*\}\) => \{\s*\n\s*if \(!armed\) return null;/);
  assert.equal(source.split('requestCiTransitionRereviewWake({').length - 1, 2);
  assert.ok(source.includes("detail: 'ci-green-on-parked-head'"));
  assert.ok(source.includes("detail: 'ci-blocked-head-moved'"));
});

// ── settle CAS + record naming ───────────────────────────────────────────────

test('a lost settle race reports already-settled instead of double-recording', () => {
  const rootDir = root();
  const enqueued = requestRereviewWake({
    rootDir, repo: REPO, prNumber: PR, headSha: HEAD, reason: REREVIEW_WAKE_REASONS.OPERATOR,
    requestWatcherWakeImpl: collectingWake([]), log: { warn() {} },
  });
  const [record] = listPendingRereviewWakes(rootDir);
  assert.equal(record.recordPath, enqueued.recordPath);

  const first = settleRereviewWake({
    rootDir, record, state: 'completed', reason: 'rereview-admitted:pending',
    at: '2026-09-21T01:05:00.000Z', log: { warn() {} },
  });
  // Same in-memory record, replayed: the pending inode is gone, so the second
  // caller must not write a second terminal record or a second latency event.
  const second = settleRereviewWake({
    rootDir, record, state: 'skipped', reason: 'pr-terminal',
    at: '2026-09-21T01:06:00.000Z', log: { warn() {} },
  });
  assert.equal(first.settled, true);
  assert.equal(second.settled, false);
  assert.equal(second.reason, 'wake-already-settled');
  const settledFiles = readdirSync(join(rootDir, 'data', 'rereview-wakes', 'settled'));
  assert.deepEqual(settledFiles.map((name) => name.split('.').slice(-2).join('.')), ['completed.json']);
  assert.deepEqual(
    latencyRows(rootDir).map((row) => row.payload.state),
    ['requested', 'completed']
  );
});

test('a pending record names its subject so the per-PR drain can filter by entry', () => {
  const rootDir = root();
  const wake = collectingWake([]);
  requestRereviewWake({ rootDir, repo: REPO, prNumber: PR, reason: REREVIEW_WAKE_REASONS.OPERATOR, requestWatcherWakeImpl: wake, log: { warn() {} } });
  requestRereviewWake({ rootDir, repo: REPO, prNumber: PR + 1, reason: REREVIEW_WAKE_REASONS.OPERATOR, requestWatcherWakeImpl: wake, log: { warn() {} } });
  const names = readdirSync(join(rootDir, 'data', 'rereview-wakes', 'pending')).sort();
  assert.equal(names.length, 2);
  for (const name of names) {
    assert.match(name, /^laceyenterprises_agent-os__pr-\d+__[0-9a-f]{64}\.json$/);
  }
  assert.equal(names.filter((name) => name.startsWith(`laceyenterprises_agent-os__pr-${PR}__`)).length, 1);
  // The slug is a filter key only; identity still comes from the record.
  assert.deepEqual(
    listPendingRereviewWakes(rootDir, { repo: REPO, prNumber: PR }).map((r) => r.prNumber),
    [PR]
  );
});

test('a repo name that is not filesystem-safe still produces one stable record', () => {
  const rootDir = root();
  const identity = { repo: 'weird/../repo name', prNumber: PR, headSha: HEAD, reason: REREVIEW_WAKE_REASONS.OPERATOR };
  const wake = collectingWake([]);
  const first = requestRereviewWake({ rootDir, ...identity, requestWatcherWakeImpl: wake, log: { warn() {} } });
  const second = requestRereviewWake({ rootDir, ...identity, requestWatcherWakeImpl: wake, log: { warn() {} } });
  assert.equal(first.outcome, 'requested');
  assert.equal(second.outcome, 'duplicate');
  const names = readdirSync(join(rootDir, 'data', 'rereview-wakes', 'pending'));
  assert.equal(names.length, 1);
  assert.ok(!names[0].includes('/'), 'the record must not escape the pending directory');
  assert.ok(!names[0].includes('..'), 'the record must not carry a traversal segment');
  assert.equal(listPendingRereviewWakes(rootDir, { repo: identity.repo, prNumber: PR }).length, 1);
});
