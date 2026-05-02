import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SQLITE_ORPHAN_EXIT_CODE,
  REVIEWER_BOT_LOGIN,
  REVIEWER_HEADER_NEEDLE,
  classifyFailureForRecovery,
  computeCycleStartMs,
  findOrphanRecoverableReview,
} from '../src/watcher.mjs';
import { SQLITE_READONLY_DBMOVED } from '../src/sqlite-orphan.mjs';

// ── classifyFailureForRecovery ──────────────────────────────────────────────

test('classifyFailureForRecovery → orphan-exit (75) for SQLITE_READONLY_DBMOVED', () => {
  const err = Object.assign(new Error('attempt to write a readonly database'), {
    code: SQLITE_READONLY_DBMOVED,
  });
  assert.deepEqual(classifyFailureForRecovery(err), {
    kind: 'orphan-exit',
    code: SQLITE_ORPHAN_EXIT_CODE,
  });
});

test('classifyFailureForRecovery → crash-after-log (1) for any non-orphan error', () => {
  // Regression: an earlier `unhandledRejection` handler returned without
  // exiting for non-orphan rejections, silently turning fail-loud into
  // limp-along. Non-orphan errors must crash so launchd KeepAlive
  // respawns the watcher with clean state.
  const cases = [
    new Error('plain non-orphan rejection'),
    Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }),
    Object.assign(new Error('something'), { code: 'EPIPE' }),
    'string rejection',
    null,
    undefined,
  ];
  for (const err of cases) {
    assert.deepEqual(
      classifyFailureForRecovery(err),
      { kind: 'crash-after-log', code: 1 },
      `non-orphan ${typeof err === 'object' ? err?.message : err} must crash, not swallow`
    );
  }
});

// ── computeCycleStartMs ─────────────────────────────────────────────────────

test('computeCycleStartMs returns the larger of rereviewRequestedAt and reviewedAt', () => {
  const reviewedAt = '2026-04-01T00:00:00.000Z';
  const rereviewRequestedAt = '2026-04-15T00:00:00.000Z';
  assert.equal(
    computeCycleStartMs({ reviewedAt, rereviewRequestedAt }),
    new Date(rereviewRequestedAt).getTime()
  );
  assert.equal(
    computeCycleStartMs({ reviewedAt: rereviewRequestedAt, rereviewRequestedAt: reviewedAt }),
    new Date(rereviewRequestedAt).getTime()
  );
});

test('computeCycleStartMs is 0 when no boundaries are known', () => {
  assert.equal(computeCycleStartMs({}), 0);
  assert.equal(computeCycleStartMs({ reviewedAt: null, rereviewRequestedAt: null }), 0);
});

test('computeCycleStartMs treats unparseable timestamps as 0 instead of NaN', () => {
  // NaN propagates through Math.max and would silently match every
  // review (since `submittedMs >= NaN` is false for everything, but a
  // typo here once made the cutoff `0`-ish and matched stale posts).
  // The helper coerces NaN to 0 so the contract is explicit.
  assert.equal(computeCycleStartMs({ reviewedAt: 'not-a-date', rereviewRequestedAt: 'also-bad' }), 0);
});

// ── findOrphanRecoverableReview ─────────────────────────────────────────────

function makeOctokit(reviewsByPr) {
  return {
    rest: {
      pulls: {
        listReviews: async ({ pull_number }) => ({ data: reviewsByPr[pull_number] || [] }),
      },
    },
    paginate: async (fn, params) => {
      const result = await fn(params);
      return result.data;
    },
  };
}

test('findOrphanRecoverableReview skips the GitHub call when there is no prior attempt', async () => {
  // First-ever attempt — `last_attempted_at` is NULL because we read
  // the row BEFORE this tick's stmtMarkAttemptStarted. The check must
  // be a no-op (no API call, no match) so first attempts have no extra
  // GitHub round-trip cost.
  let listed = false;
  const octokit = {
    rest: { pulls: { listReviews: async () => { listed = true; return { data: [] }; } } },
    paginate: async (fn, params) => (await fn(params)).data,
  };
  const result = await findOrphanRecoverableReview({
    octokit,
    owner: 'lacey',
    repo: 'r',
    prNumber: 1,
    reviewerModel: 'codex',
    reviewedAt: '2026-04-01T00:00:00.000Z',
    rereviewRequestedAt: null,
    lastAttemptedAt: null,
  });
  assert.deepEqual(result, { match: null });
  assert.equal(listed, false, 'must not call GitHub when no prior attempt exists');
});

test('findOrphanRecoverableReview returns the prior bot review when one exists in this cycle', async () => {
  // Orphan-respawn scenario: previous tick posted a Codex review at
  // T_post (inside this cycle), then crashed before stmtMarkPosted.
  // The check must surface that review so the watcher marks the row
  // posted instead of re-spawning the reviewer.
  const reviews = [
    {
      id: 1,
      user: { login: 'somebody-else' },
      body: 'unrelated review',
      submitted_at: '2026-04-22T05:30:00.000Z',
    },
    {
      id: 2,
      user: { login: REVIEWER_BOT_LOGIN.codex },
      body: `${REVIEWER_HEADER_NEEDLE.codex}\n\n## Summary\n…`,
      submitted_at: '2026-04-22T05:31:00.000Z',
    },
  ];
  const octokit = makeOctokit({ 7: reviews });

  const result = await findOrphanRecoverableReview({
    octokit,
    owner: 'lacey',
    repo: 'adversarial-review',
    prNumber: 7,
    reviewerModel: 'codex',
    reviewedAt: '2026-04-22T05:00:00.000Z',
    rereviewRequestedAt: null,
    lastAttemptedAt: '2026-04-22T05:29:00.000Z',
  });

  assert.equal(result.match.id, 2);
});

test('findOrphanRecoverableReview ignores prior posts from earlier cycles (re-review case)', async () => {
  // A legitimate re-review request resets the row to pending. The PRIOR
  // cycle's bot review still exists on the PR but predates the rereview
  // boundary — we WANT a fresh post for the new cycle, so the check
  // must NOT match.
  const reviews = [
    {
      id: 100,
      user: { login: REVIEWER_BOT_LOGIN.claude },
      body: `${REVIEWER_HEADER_NEEDLE.claude}\n\n## Summary\nold cycle`,
      submitted_at: '2026-04-10T00:00:00.000Z',
    },
  ];
  const octokit = makeOctokit({ 5: reviews });

  const result = await findOrphanRecoverableReview({
    octokit,
    owner: 'lacey',
    repo: 'adversarial-review',
    prNumber: 5,
    reviewerModel: 'claude',
    reviewedAt: '2026-04-01T00:00:00.000Z',
    rereviewRequestedAt: '2026-04-15T00:00:00.000Z',
    lastAttemptedAt: '2026-04-10T00:00:00.000Z',
  });

  assert.equal(result.match, null);
});

test('findOrphanRecoverableReview does not false-positive on non-bot comments mentioning the header', async () => {
  // A human or other bot quoting our header in a body must never be
  // mistaken for our prior post. Bot login filtering is the primary
  // discriminator; the header-text check is the secondary.
  const reviews = [
    {
      id: 1,
      user: { login: 'random-human' },
      body: `Quoting the marker: ${REVIEWER_HEADER_NEEDLE.codex}`,
      submitted_at: '2026-04-22T05:31:00.000Z',
    },
  ];
  const octokit = makeOctokit({ 7: reviews });

  const result = await findOrphanRecoverableReview({
    octokit,
    owner: 'lacey',
    repo: 'adversarial-review',
    prNumber: 7,
    reviewerModel: 'codex',
    reviewedAt: '2026-04-22T05:00:00.000Z',
    rereviewRequestedAt: null,
    lastAttemptedAt: '2026-04-22T05:29:00.000Z',
  });

  assert.equal(result.match, null);
});

test('findOrphanRecoverableReview surfaces GitHub errors so the caller can fail conservatively', async () => {
  // If the GitHub query itself fails, we must NOT silently proceed to
  // re-spawn (that would risk a duplicate post). The caller turns this
  // into a failed attempt that the next poll retries.
  const octokit = {
    rest: { pulls: { listReviews: async () => { throw new Error('boom: 502'); } } },
    paginate: async (fn, params) => (await fn(params)).data,
  };

  const result = await findOrphanRecoverableReview({
    octokit,
    owner: 'lacey',
    repo: 'adversarial-review',
    prNumber: 7,
    reviewerModel: 'codex',
    reviewedAt: '2026-04-22T05:00:00.000Z',
    rereviewRequestedAt: null,
    lastAttemptedAt: '2026-04-22T05:29:00.000Z',
  });

  assert.ok(result.error);
  assert.match(result.error.message, /502/);
});

test('findOrphanRecoverableReview ignores unknown reviewer models gracefully', async () => {
  // The bot-login map is hard-coded; an unknown reviewerModel should
  // be a no-op rather than mismatched matching against the whole
  // review list.
  const reviews = [
    {
      id: 1,
      user: { login: 'whoever' },
      body: 'anything',
      submitted_at: '2026-04-22T05:31:00.000Z',
    },
  ];
  const octokit = makeOctokit({ 7: reviews });

  const result = await findOrphanRecoverableReview({
    octokit,
    owner: 'lacey',
    repo: 'adversarial-review',
    prNumber: 7,
    reviewerModel: 'mystery-model',
    reviewedAt: '2026-04-22T05:00:00.000Z',
    rereviewRequestedAt: null,
    lastAttemptedAt: '2026-04-22T05:29:00.000Z',
  });

  assert.deepEqual(result, { match: null });
});

// ── End-to-end process-handler wiring (spawned child) ───────────────────────
//
// Verifies the actual `process.on(...)` registrations in watcher.mjs.
// Without these, a regression like "swallow non-orphan rejections"
// slips past unit-tested decision helpers because the wiring step
// itself is what was broken.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WATCHER_PATH = join(ROOT, 'src', 'watcher.mjs');

function runChild(scriptSource, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', scriptSource],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          // The watcher module-load opens data/reviews.db; that's a
          // benign file create in the project root, no main() runs on
          // import. We don't need GITHUB_TOKEN for that.
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Child timed out after ${timeoutMs}ms; stderr=${stderr}`));
    }, timeoutMs);

    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

test('watcher unhandledRejection handler crashes (exit 1) for non-orphan errors', async () => {
  // Regression test for the "swallow non-orphan rejections" review
  // finding. If this test fails with code 0 again, the handler has
  // reverted to log-and-continue behavior.
  const script = `
import ${JSON.stringify(WATCHER_PATH)};
Promise.reject(new Error('test-non-orphan-rejection'));
// Keep the event loop alive until the rejection fires.
setTimeout(() => {}, 5000);
`;
  const { code, stderr } = await runChild(script);
  assert.equal(code, 1, `expected exit 1 for non-orphan rejection, got ${code}; stderr=${stderr.slice(0, 800)}`);
  assert.match(stderr, /unhandledRejection/);
});

test('watcher unhandledRejection handler exits 75 for SQLITE_READONLY_DBMOVED', async () => {
  // The orphan path must take precedence over the generic crash path.
  const script = `
import ${JSON.stringify(WATCHER_PATH)};
const err = Object.assign(new Error('orphaned'), { code: 'SQLITE_READONLY_DBMOVED' });
Promise.reject(err);
setTimeout(() => {}, 5000);
`;
  const { code, stderr } = await runChild(script);
  assert.equal(code, SQLITE_ORPHAN_EXIT_CODE, `expected exit ${SQLITE_ORPHAN_EXIT_CODE} for orphan rejection, got ${code}; stderr=${stderr.slice(0, 800)}`);
  assert.match(stderr, /SQLITE_READONLY_DBMOVED/);
});

test('watcher uncaughtException handler crashes (exit 1) for non-orphan errors', async () => {
  const script = `
import ${JSON.stringify(WATCHER_PATH)};
setTimeout(() => { throw new Error('test-non-orphan-throw'); }, 10);
setTimeout(() => {}, 5000);
`;
  const { code, stderr } = await runChild(script);
  assert.equal(code, 1, `expected exit 1 for non-orphan throw, got ${code}; stderr=${stderr.slice(0, 800)}`);
  assert.match(stderr, /uncaughtException/);
});

test('watcher uncaughtException handler exits 75 for SQLITE_READONLY_DBMOVED', async () => {
  const script = `
import ${JSON.stringify(WATCHER_PATH)};
setTimeout(() => {
  const err = Object.assign(new Error('orphaned'), { code: 'SQLITE_READONLY_DBMOVED' });
  throw err;
}, 10);
setTimeout(() => {}, 5000);
`;
  const { code, stderr } = await runChild(script);
  assert.equal(code, SQLITE_ORPHAN_EXIT_CODE, `expected exit ${SQLITE_ORPHAN_EXIT_CODE} for orphan throw, got ${code}; stderr=${stderr.slice(0, 800)}`);
  assert.match(stderr, /SQLITE_READONLY_DBMOVED/);
});
