import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    const record = JSON.parse(readFileSync(reviewerRunStatePath(rootDir, req.sessionUuid), 'utf8'));
    assert.equal(record.state, 'completed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('cli-direct strips forbidden API-key fallback env before spawning', async () => {
  const rootDir = makeRoot();
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousAnthropic = process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = 'must-not-propagate';
  process.env.ANTHROPIC_API_KEY = 'must-not-propagate';
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
      forbiddenFallbacks: ['api-key', 'anthropic-api-key'],
    });
    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(childEnv, 'OPENAI_API_KEY'), false);
    assert.equal(Object.hasOwn(childEnv, 'ANTHROPIC_API_KEY'), false);
  } finally {
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropic;
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
    assert.deepEqual(recovered, { recovered: 1 });
    const row = db.prepare('SELECT review_status, failure_message FROM reviewed_prs WHERE reviewer_session_uuid = ?').get('bounce-session');
    assert.equal(row.review_status, 'failed');
    assert.match(row.failure_message, /daemon-bounce/);
  } finally {
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
