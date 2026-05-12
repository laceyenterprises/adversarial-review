import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createReviewerRuntimeAdapterForDomain,
  recoverReviewerRunRecords,
  resolveReviewerRuntimeName,
} from '../src/adapters/reviewer-runtime/index.mjs';
import { createCliDirectReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/cli-direct/index.mjs';
import {
  readActiveReviewerRunRecords,
  readRecoverableReviewerRunRecords,
  reviewerRunStatePath,
  writeReviewerRunRecord,
} from '../src/adapters/reviewer-runtime/run-state.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';

function makeRoot() {
  const rootDir = mkdtempSync(join(tmpdir(), 'reviewer-runtime-'));
  mkdirSync(join(rootDir, 'domains'), { recursive: true });
  return rootDir;
}

test('loads reviewer runtime by name from domain config with cli-direct default', () => {
  assert.equal(resolveReviewerRuntimeName({}), 'cli-direct');
  assert.equal(resolveReviewerRuntimeName({ reviewerRuntime: 'fixture-stub' }), 'fixture-stub');

  const rootDir = makeRoot();
  try {
    const adapter = createReviewerRuntimeAdapterForDomain({
      rootDir,
      domainId: 'research-finding',
      domainConfig: { id: 'research-finding', reviewerRuntime: 'fixture-stub' },
      reviewerBodies: ['## Verdict\nComment only'],
    });
    assert.equal(adapter.describe().id, 'fixture-stub');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct delegates failure classification to the runtime adapter', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      spawnCapturedImpl: async () => {
        const err = new Error('reviewer failed');
        err.stderr = 'LiteLLM retry pool: all upstream attempts failed';
        err.exitCode = 1;
        throw err;
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });

    const result = await adapter.spawnReviewer({
      model: 'codex',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 1 },
      timeoutMs: 100,
      sessionUuid: 'classification-session',
      forbiddenFallbacks: ['api-key'],
    });

    assert.equal(result.ok, false);
    assert.equal(result.failureClass, 'cascade');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct writes atomic reviewer run records and refuses double-spawn for a session', async () => {
  const rootDir = makeRoot();
  let release;
  let spawnCount = 0;
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      spawnCapturedImpl: async (_command, _args, options) => {
        spawnCount += 1;
        options.onSpawn({ pgid: 4242 });
        await new Promise((resolve) => { release = resolve; });
        return { stdout: 'posted\n', stderr: '' };
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });

    const req = {
      model: 'claude',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 2 },
      timeoutMs: 100,
      sessionUuid: 'double-spawn-session',
      forbiddenFallbacks: ['api-key'],
    };
    const first = adapter.spawnReviewer(req);
    await new Promise((resolve) => setImmediate(resolve));
    const duplicate = await adapter.spawnReviewer(req);
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.failureClass, 'daemon-bounce');
    assert.equal(spawnCount, 1);

    const active = readActiveReviewerRunRecords(rootDir);
    assert.equal(active.length, 1);
    assert.equal(active[0].state, 'heartbeating');
    assert.equal(active[0].pgid, 4242);

    release();
    const completed = await first;
    assert.equal(completed.ok, true);
    assert.equal(existsSync(reviewerRunStatePath(rootDir, req.sessionUuid)), true);

    const terminalDuplicate = await adapter.spawnReviewer(req);
    assert.equal(terminalDuplicate.ok, false);
    assert.equal(terminalDuplicate.failureClass, 'bug');
    assert.match(terminalDuplicate.stderrTail, /terminal state completed/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct preserves cancelled state across abort races', async () => {
  const rootDir = makeRoot();
  let release;
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      spawnCapturedImpl: async (_command, _args, options) => {
        options.onSpawn({ pgid: 4243 });
        await new Promise((resolve) => { release = resolve; });
        const err = new Error('aborted');
        err.code = 'ABORT_ERR';
        err.signal = 'SIGTERM';
        throw err;
      },
      now: () => '2026-05-11T20:00:00.000Z',
    });

    const req = {
      model: 'claude',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 2 },
      timeoutMs: 100,
      sessionUuid: 'cancelled-session',
      forbiddenFallbacks: ['api-key'],
    };
    const run = adapter.spawnReviewer(req);
    await new Promise((resolve) => setImmediate(resolve));
    await adapter.cancel(req.sessionUuid);
    release();

    const cancelled = await run;
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.failureClass, 'unknown');
    assert.equal(existsSync(reviewerRunStatePath(rootDir, req.sessionUuid)), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct strips forbidden API-key fallback env before spawning', async () => {
  const rootDir = makeRoot();
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousAnthropic = process.env.ANTHROPIC_API_KEY;
  const previousAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const previousClaudeBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
  const previousClaudeVertex = process.env.CLAUDE_CODE_USE_VERTEX;
  const previousAwsBearerTokenBedrock = process.env.AWS_BEARER_TOKEN_BEDROCK;
  const previousGoogleApiKey = process.env.GOOGLE_API_KEY;
  const previousGeminiApiKey = process.env.GEMINI_API_KEY;
  process.env.OPENAI_API_KEY = 'must-not-propagate';
  process.env.ANTHROPIC_API_KEY = 'must-not-propagate';
  process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.invalid';
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  process.env.CLAUDE_CODE_USE_VERTEX = '1';
  process.env.AWS_BEARER_TOKEN_BEDROCK = 'must-not-propagate';
  process.env.GOOGLE_API_KEY = 'must-not-propagate';
  process.env.GEMINI_API_KEY = 'must-not-propagate';
  try {
    let childEnv;
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      spawnCapturedImpl: async (_command, _args, options) => {
        childEnv = options.env;
        options.onSpawn({ pgid: 5150 });
        return { stdout: 'ok', stderr: '' };
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'claude',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 3 },
      timeoutMs: 100,
      sessionUuid: 'oauth-strip-session',
      forbiddenFallbacks: ['api-key', 'anthropic-api-key', 'bedrock', 'vertex'],
    });
    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(childEnv, 'OPENAI_API_KEY'), false);
    assert.equal(Object.hasOwn(childEnv, 'ANTHROPIC_API_KEY'), false);
    assert.equal(Object.hasOwn(childEnv, 'ANTHROPIC_BASE_URL'), false);
    assert.equal(Object.hasOwn(childEnv, 'CLAUDE_CODE_USE_BEDROCK'), false);
    assert.equal(Object.hasOwn(childEnv, 'CLAUDE_CODE_USE_VERTEX'), false);
    assert.equal(Object.hasOwn(childEnv, 'AWS_BEARER_TOKEN_BEDROCK'), false);
    assert.equal(Object.hasOwn(childEnv, 'GOOGLE_API_KEY'), false);
    assert.equal(Object.hasOwn(childEnv, 'GEMINI_API_KEY'), false);
  } finally {
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropic;
    if (previousAnthropicBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = previousAnthropicBaseUrl;
    if (previousClaudeBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
    else process.env.CLAUDE_CODE_USE_BEDROCK = previousClaudeBedrock;
    if (previousClaudeVertex === undefined) delete process.env.CLAUDE_CODE_USE_VERTEX;
    else process.env.CLAUDE_CODE_USE_VERTEX = previousClaudeVertex;
    if (previousAwsBearerTokenBedrock === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    else process.env.AWS_BEARER_TOKEN_BEDROCK = previousAwsBearerTokenBedrock;
    if (previousGoogleApiKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = previousGoogleApiKey;
    if (previousGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGeminiApiKey;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct enforces canonical OAuth strip regardless of forbiddenFallbacks shape', async () => {
  // Regression: the watcher passes only `['api-key', 'anthropic-api-key']` as
  // forbiddenFallbacks. Previously, only OPENAI_API_KEY / ANTHROPIC_API_KEY /
  // GOOGLE_API_KEY / GEMINI_API_KEY got stripped (4 of 8) — the bedrock /
  // vertex / proxy redirectors survived into the reviewer subprocess, so an
  // ANTHROPIC_BASE_URL=https://attacker.invalid in the launchd context could
  // route OAuth bearer traffic through a hostile proxy even though the
  // adapter advertised `oauthStripEnforced: true`. Capability bit MUST mean
  // "the full canonical 8-env set is stripped" no matter what the caller passes.
  const rootDir = makeRoot();
  const previous = {};
  const canonical = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'AWS_BEARER_TOKEN_BEDROCK',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
  ];
  for (const k of canonical) {
    previous[k] = process.env[k];
    process.env[k] = 'must-not-propagate';
  }
  try {
    let childEnv;
    const adapter = createCliDirectReviewerRuntimeAdapter({
      rootDir,
      spawnCapturedImpl: async (_command, _args, options) => {
        childEnv = options.env;
        options.onSpawn({ pgid: 5151 });
        return { stdout: 'ok', stderr: '' };
      },
    });
    const result = await adapter.spawnReviewer({
      model: 'claude',
      prompt: '',
      subjectContext: { domainId: 'code-pr', repo: 'lacey/repo', prNumber: 3 },
      timeoutMs: 100,
      sessionUuid: 'oauth-strip-canonical-session',
      // Production watcher value — narrow alias list, only 'api-key' family.
      forbiddenFallbacks: ['api-key', 'anthropic-api-key'],
    });
    assert.equal(result.ok, true);
    for (const k of canonical) {
      assert.equal(Object.hasOwn(childEnv, k), false, `${k} must be stripped by canonical-OAuth-strip enforcement`);
    }
  } finally {
    for (const k of canonical) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cancelled reviewer run records remain recoverable on next startup', () => {
  const rootDir = makeRoot();
  try {
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'cancelled-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'cancelled',
      pgid: 7070,
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'cancelled-session',
    });

    const recoverable = readRecoverableReviewerRunRecords(rootDir);
    assert.equal(recoverable.length, 1);
    assert.equal(recoverable[0].state, 'cancelled');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('bounce recovery reattaches active run records and requeues reviewing rows', async () => {
  const rootDir = makeRoot();
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
        reviewer_session_uuid, reviewer_started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'lacey/repo',
    4,
    '2026-05-11T19:59:00.000Z',
    'codex',
    'open',
    'reviewing',
    'bounce-session',
    '2026-05-11T20:00:00.000Z',
  );
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({ rootDir });
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'bounce-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'heartbeating',
      pgid: 6060,
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'bounce-session',
    });
    const before = db.prepare('SELECT review_status FROM reviewed_prs WHERE reviewer_session_uuid = ?').get('bounce-session');
    assert.equal(before.review_status, 'reviewing');

    const recovered = await recoverReviewerRunRecords({
      rootDir,
      adapter,
      db,
      log: { log() {} },
      now: new Date('2026-05-11T20:01:00.000Z'),
    });
    assert.deepEqual(recovered, { recovered: 1, pruned: 0 });
    const row = db.prepare('SELECT review_status, failure_message FROM reviewed_prs WHERE reviewer_session_uuid = ?').get('bounce-session');
    assert.equal(row.review_status, 'failed');
    assert.match(row.failure_message, /daemon-bounce/);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('bounce recovery counts only rows it actually requeued', async () => {
  const rootDir = makeRoot();
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({ rootDir });
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'posted-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'heartbeating',
      pgid: 6060,
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'posted-session',
    });

    const recovered = await recoverReviewerRunRecords({
      rootDir,
      adapter,
      db,
      log: { log() {} },
      now: new Date('2026-05-11T20:01:00.000Z'),
    });
    assert.deepEqual(recovered, { recovered: 0, pruned: 0 });
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('bounce recovery requeues reviewing rows for cancelled reviewer run records', async () => {
  const rootDir = makeRoot();
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
        reviewer_session_uuid, reviewer_started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'lacey/repo',
    5,
    '2026-05-11T19:59:00.000Z',
    'codex',
    'open',
    'reviewing',
    'cancelled-recovery-session',
    '2026-05-11T20:00:00.000Z',
  );
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({ rootDir });
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'cancelled-recovery-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'cancelled',
      pgid: 6061,
      spawnedAt: '2026-05-11T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-11T20:00:30.000Z',
      reattachToken: 'cancelled-recovery-session',
    });

    const recovered = await recoverReviewerRunRecords({
      rootDir,
      adapter,
      db,
      log: { log() {} },
      now: new Date('2026-05-11T20:01:00.000Z'),
    });
    assert.deepEqual(recovered, { recovered: 1, pruned: 0 });
    const row = db.prepare('SELECT review_status, failure_message FROM reviewed_prs WHERE reviewer_session_uuid = ?').get('cancelled-recovery-session');
    assert.equal(row.review_status, 'failed');
    assert.match(row.failure_message, /daemon-bounce/);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('bounce recovery prunes old terminal run-state files on startup', async () => {
  const rootDir = makeRoot();
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  try {
    const adapter = createCliDirectReviewerRuntimeAdapter({ rootDir });
    writeReviewerRunRecord(rootDir, {
      sessionUuid: 'old-terminal-session',
      domain: 'code-pr',
      runtime: 'cli-direct',
      state: 'failed',
      pgid: 6060,
      spawnedAt: '2026-05-09T20:00:00.000Z',
      lastHeartbeatAt: '2026-05-09T20:00:30.000Z',
      reattachToken: 'old-terminal-session',
    });

    const recovered = await recoverReviewerRunRecords({
      rootDir,
      adapter,
      db,
      log: { log() {} },
      now: new Date('2026-05-11T20:01:00.000Z'),
    });
    assert.deepEqual(recovered, { recovered: 0, pruned: 1 });
    assert.equal(existsSync(reviewerRunStatePath(rootDir, 'old-terminal-session')), false);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
