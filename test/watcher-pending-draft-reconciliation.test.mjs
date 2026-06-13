import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_PENDING_DRAFT_RESPAWN_AGE_SECONDS,
  reconcilePendingDraftsBeforeSpawn,
  resolvePendingDraftRespawnAgeSeconds,
} from '../src/watcher.mjs';
import { AgentOSConfigError } from '../src/config-loader.mjs';

const WATCHER_SOURCE = new URL('../src/watcher.mjs', import.meta.url);

async function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeLog() {
  const lines = [];
  const warnings = [];
  return {
    lines,
    warnings,
    log(message) { lines.push(String(message)); },
    warn(message) { warnings.push(String(message)); },
  };
}

function parseStructuredEvent(log) {
  const line = log.lines.find((entry) => entry.includes('"event":"watcher_tick_reconciliation"'));
  assert.ok(line, 'expected reconciliation event');
  return JSON.parse(line);
}

test('watcher pre-spawn reconciliation clears stale-head drafts before spawn and emits schemaVersion 1', async () => {
  const deleted = [];
  const log = makeLog();
  const fetchImpl = async (url, opts = {}) => {
    if (url === 'https://api.github.com/user') {
      return { ok: true, status: 200, async json() { return { login: 'claude-reviewer-lacey' }; } };
    }
    if (url.endsWith('/pulls/177/reviews') && (!opts.method || opts.method === 'GET')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [
            {
              id: 7001,
              state: 'PENDING',
              commit_id: 'old-head',
              created_at: '2026-05-30T03:59:00.000Z',
              user: { login: 'claude-reviewer-lacey' },
            },
          ];
        },
      };
    }
    if (url.endsWith('/reviews/7001') && opts.method === 'DELETE') {
      deleted.push(7001);
      return { ok: true, status: 200, async json() { return {}; } };
    }
    throw new Error(`unmocked fetch: ${opts.method || 'GET'} ${url}`);
  };

  const result = await withEnv({ GH_CLAUDE_REVIEWER_TOKEN: 'token' }, () => reconcilePendingDraftsBeforeSpawn({
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 177,
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    currentHeadSha: 'new-head',
    now: new Date('2026-05-30T04:00:00.000Z'),
    fetchImpl,
    log,
  }));

  assert.equal(result.skipSpawn, false);
  assert.deepEqual(deleted, [7001]);
  const event = parseStructuredEvent(log);
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.repo, 'laceyenterprises/adversarial-review');
  assert.equal(event.listed, 1);
  assert.equal(event.pendingMine, 1);
  assert.equal(event.cleared, 1);
  assert.equal(event.retained, 0);
  assert.equal(event.retainedReason, null);
  assert.equal(event.skippedReason, null);
});

test('watcher runs pending-draft reconciliation after claim and freshness re-check', () => {
  const source = readFileSync(WATCHER_SOURCE, 'utf8');
  const claimIndex = source.indexOf(': stmtMarkAttemptStarted.run(');
  const infraClaimIndex = source.indexOf('? stmtMarkInfraAutoRecoveryAttemptStarted.run(');
  const freshnessIndex = source.indexOf('Freshness re-check (2026-05-18)');
  const reconcileIndex = source.indexOf('const preSpawnReconciliation = await reconcilePendingDraftsBeforeSpawn({');
  const releaseIndex = source.indexOf('stmtReleaseReviewerClaim.run(reviewerSessionUuid, repoPath, prNumber);');

  assert.ok(claimIndex > 0, 'claim site should exist');
  assert.ok(infraClaimIndex > 0, 'infra-recovery claim site should exist');
  assert.ok(infraClaimIndex < claimIndex, 'infra-recovery claim should be checked before the generic claim');
  assert.ok(freshnessIndex > claimIndex, 'freshness re-check should happen after claim');
  assert.ok(reconcileIndex > freshnessIndex, 'reconciliation should happen after freshness re-check');
  assert.ok(releaseIndex > reconcileIndex, 'skip-spawn path should release the claim');
});

test('watcher pre-spawn reconciliation retains a fresh current-head draft and skips this tick', async () => {
  const log = makeLog();
  const fetchImpl = async (url, opts = {}) => {
    if (url === 'https://api.github.com/user') {
      return { ok: true, status: 200, async json() { return { login: 'claude-reviewer-lacey' }; } };
    }
    if (url.endsWith('/pulls/177/reviews') && (!opts.method || opts.method === 'GET')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [
            {
              id: 7000,
              state: 'PENDING',
              commit_id: 'current-head',
              created_at: '2026-05-30T03:59:00.000Z',
              user: { login: 'other-reviewer-lacey' },
            },
            {
              id: 7002,
              state: 'PENDING',
              commit_id: 'current-head',
              created_at: '2026-05-30T03:59:00.000Z',
              user: { login: 'claude-reviewer-lacey' },
            },
          ];
        },
      };
    }
    throw new Error(`unmocked fetch: ${opts.method || 'GET'} ${url}`);
  };

  const result = await withEnv({ GH_CLAUDE_REVIEWER_TOKEN: 'token' }, () => reconcilePendingDraftsBeforeSpawn({
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 177,
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    currentHeadSha: 'current-head',
    now: new Date('2026-05-30T04:00:00.000Z'),
    fetchImpl,
    log,
  }));

  assert.equal(result.skipSpawn, true);
  assert.equal(result.retained, 1);
  assert.equal(result.retainedReason, 'current-head-fresh-draft');
  assert.equal(result.respawnDeadlineUtc, '2026-05-30T04:14:00.000Z');
  const event = parseStructuredEvent(log);
  assert.equal(event.listed, 2);
  assert.equal(event.pendingMine, 1);
  assert.equal(event.retainedReason, 'current-head-fresh-draft');
  assert.equal(event.respawnDeadlineUtc, '2026-05-30T04:14:00.000Z');
});

test('watcher pre-spawn reconciliation clears an expired current-head draft and proceeds', async () => {
  const deleted = [];
  const log = makeLog();
  const fetchImpl = async (url, opts = {}) => {
    if (url === 'https://api.github.com/user') {
      return { ok: true, status: 200, async json() { return { login: 'claude-reviewer-lacey' }; } };
    }
    if (url.endsWith('/pulls/177/reviews') && (!opts.method || opts.method === 'GET')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return [
            {
              id: 7003,
              state: 'PENDING',
              commit_id: 'current-head',
              created_at: '2026-05-30T03:44:59.000Z',
              user: { login: 'claude-reviewer-lacey' },
            },
          ];
        },
      };
    }
    if (url.endsWith('/reviews/7003') && opts.method === 'DELETE') {
      deleted.push(7003);
      return { ok: true, status: 200, async json() { return {}; } };
    }
    throw new Error(`unmocked fetch: ${opts.method || 'GET'} ${url}`);
  };

  const result = await withEnv({ GH_CLAUDE_REVIEWER_TOKEN: 'token' }, () => reconcilePendingDraftsBeforeSpawn({
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 177,
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    currentHeadSha: 'current-head',
    now: new Date('2026-05-30T04:00:00.000Z'),
    respawnAgeSeconds: 900,
    fetchImpl,
    log,
  }));

  assert.equal(result.skipSpawn, false);
  assert.deepEqual(deleted, [7003]);
  const event = parseStructuredEvent(log);
  assert.equal(event.cleared, 1);
  assert.equal(event.retainedReason, null);
});

test('watcher reconciliation emits repo-scoped skipped event when identity probe fails', async () => {
  const log = makeLog();
  const fetchImpl = async (url) => {
    if (url === 'https://api.github.com/user') {
      return { ok: false, status: 503, async json() { return { message: 'unavailable' }; } };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const result = await withEnv({ GH_CLAUDE_REVIEWER_TOKEN: 'token' }, () => reconcilePendingDraftsBeforeSpawn({
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 177,
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    currentHeadSha: 'current-head',
    now: new Date('2026-05-30T04:00:00.000Z'),
    fetchImpl,
    log,
  }));

  assert.equal(result.skipSpawn, false);
  assert.equal(result.skippedReason, 'identity-probe-failed');
  const event = parseStructuredEvent(log);
  assert.equal(event.repo, 'laceyenterprises/adversarial-review');
  assert.equal(event.pr, 177);
  assert.equal(event.identity, null);
  assert.equal(event.listed, 0);
  assert.equal(event.pendingMine, 0);
  assert.equal(event.skippedReason, 'identity-probe-failed');
});

test('two ticks against the same fresh draft skip first and reap after the respawn age elapses', async () => {
  const deleted = [];
  const log = makeLog();
  let draftPresent = true;
  const fetchImpl = async (url, opts = {}) => {
    if (url === 'https://api.github.com/user') {
      return { ok: true, status: 200, async json() { return { login: 'codex-reviewer-lacey' }; } };
    }
    if (url.endsWith('/pulls/188/reviews') && (!opts.method || opts.method === 'GET')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return draftPresent
            ? [{
              id: 8801,
              state: 'PENDING',
              commit_id: 'same-head',
              created_at: '2026-05-30T04:00:00.000Z',
              user: { login: 'codex-reviewer-lacey' },
            }]
            : [];
        },
      };
    }
    if (url.endsWith('/reviews/8801') && opts.method === 'DELETE') {
      draftPresent = false;
      deleted.push(8801);
      return { ok: true, status: 200, async json() { return {}; } };
    }
    throw new Error(`unmocked fetch: ${opts.method || 'GET'} ${url}`);
  };

  const first = await withEnv({ GH_CODEX_REVIEWER_TOKEN: 'token' }, () => reconcilePendingDraftsBeforeSpawn({
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 188,
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    currentHeadSha: 'same-head',
    now: new Date('2026-05-30T04:00:30.000Z'),
    respawnAgeSeconds: 120,
    fetchImpl,
    log,
  }));
  const second = await withEnv({ GH_CODEX_REVIEWER_TOKEN: 'token' }, () => reconcilePendingDraftsBeforeSpawn({
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 188,
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    currentHeadSha: 'same-head',
    now: new Date('2026-05-30T04:02:01.000Z'),
    respawnAgeSeconds: 120,
    fetchImpl,
    log,
  }));

  assert.equal(first.skipSpawn, true);
  assert.equal(second.skipSpawn, false);
  assert.deepEqual(deleted, [8801]);
});

test('respawn age validation accepts fence-on values in [60, 1800] and rejects outside the range', () => {
  assert.equal(
    resolvePendingDraftRespawnAgeSeconds({
      ADVERSARIAL_REVIEW_SIGTERM_FENCE: 'on',
      ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS: '60',
    }),
    60
  );
  assert.equal(
    resolvePendingDraftRespawnAgeSeconds({
      ADVERSARIAL_REVIEW_SIGTERM_FENCE: 'on',
      ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS: '1800',
    }),
    1800
  );
  assert.equal(resolvePendingDraftRespawnAgeSeconds({}), DEFAULT_PENDING_DRAFT_RESPAWN_AGE_SECONDS);
  assert.throws(
    () => resolvePendingDraftRespawnAgeSeconds({
      ADVERSARIAL_REVIEW_SIGTERM_FENCE: 'on',
      ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS: '59',
    }),
    (err) => err instanceof AgentOSConfigError
  );
  assert.throws(
    () => resolvePendingDraftRespawnAgeSeconds({
      ADVERSARIAL_REVIEW_SIGTERM_FENCE: 'on',
      ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS: '86400',
    }),
    (err) => err?.logKey === 'respawn_age_out_of_range'
  );
  assert.throws(
    () => resolvePendingDraftRespawnAgeSeconds({
      ADVERSARIAL_REVIEW_SIGTERM_FENCE: 'on',
      ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS: '60xyz',
    }),
    (err) => err instanceof AgentOSConfigError
  );
  assert.throws(
    () => resolvePendingDraftRespawnAgeSeconds({
      ADVERSARIAL_REVIEW_SIGTERM_FENCE: 'on',
      ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS: '15min',
    }),
    (err) => err instanceof AgentOSConfigError
  );
});

test('respawn age validation enforces the fence-off 300s floor with a distinct log key', () => {
  assert.equal(
    resolvePendingDraftRespawnAgeSeconds({
      ADVERSARIAL_REVIEW_SIGTERM_FENCE: 'off',
      ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS: '300',
    }),
    300
  );
  assert.equal(
    resolvePendingDraftRespawnAgeSeconds({
      ADVERSARIAL_REVIEW_SIGTERM_FENCE: 'on',
      ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS: '60',
    }),
    60
  );
  assert.throws(
    () => resolvePendingDraftRespawnAgeSeconds({
      ADVERSARIAL_REVIEW_SIGTERM_FENCE: 'off',
      ADVERSARIAL_REVIEW_PENDING_DRAFT_RESPAWN_AGE_SECONDS: '60',
    }),
    (err) => err?.logKey === 'respawn_age_below_fence_off_floor'
  );
});
