import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { reconcileBuilderClass, resolveBuilderProvenanceRouting } from '../src/builder-provenance-routing.mjs';
import { routeSubject } from '../src/adapters/subject/github-pr/routing.mjs';
import { readPrBuilderProvenance } from '../src/session-ledger-read-adapter.mjs';
import { fetchPrState, main as reroute } from '../bin/reroute-builder-review.mjs';

const headSha = 'a'.repeat(40);
const hermeticEnv = { AGENT_OS_CONFIG_PATH: '/dev/null' };

function sqliteProvenanceFixture(t, { payload = {}, workerClass = 'claude-code',
  workerRuns = [{ runId: 'wr_1', metadata: { actualHarness: 'codex' }, createdAt: '2026-09-29' }],
} = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'builder-provenance-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const path = join(rootDir, '.agent-os', 'session-ledger', 'ledger.db');
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE build_completions (completion_id TEXT PRIMARY KEY, repo TEXT,
        pr_number INTEGER, head_sha TEXT, launch_request_id TEXT, recorded_at TEXT NOT NULL);
      CREATE TABLE launch_requests (launch_request_id TEXT PRIMARY KEY,
        worker_class TEXT, request_payload_json TEXT NOT NULL);
      CREATE TABLE worker_runs (run_id TEXT PRIMARY KEY, launch_request_id TEXT,
        metadata_json TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    const launch = db.prepare('INSERT INTO launch_requests VALUES (?, ?, ?)');
    launch.run('lrq_old', 'gemini', '{}');
    launch.run('lrq_latest', workerClass, typeof payload === 'string' ? payload : JSON.stringify(payload));
    launch.run('lrq_other', 'gemini', '{}');
    const completion = db.prepare('INSERT INTO build_completions VALUES (?, ?, ?, ?, ?, ?)');
    completion.run('bc_old', 'org/repo', 12, headSha, 'lrq_old', '2026-09-28');
    completion.run('bc_latest', 'org/repo', 12, headSha, 'lrq_latest', '2026-09-29');
    // Newer rows for another repo/PR must not override this PR's builder.
    completion.run('bc_other_repo', 'other/repo', 12, headSha, 'lrq_other', '2026-09-30');
    completion.run('bc_other_pr', 'org/repo', 13, headSha, 'lrq_other', '2026-09-30');
    const run = db.prepare('INSERT INTO worker_runs VALUES (?, ?, ?, ?)');
    for (const { runId, metadata, createdAt } of workerRuns) {
      run.run(runId, 'lrq_latest', JSON.stringify(metadata), createdAt);
    }
  } finally {
    db.close();
  }
  return { rootDir, ledgerTarget: { backend: 'sqlite', path } };
}
for (const [title, actual, reviewer] of [
  ['claude-code', 'codex', 'claude'],
  ['codex', 'claude-code', 'codex'],
]) {
  test(`${title} title with ${actual} ledger routes by actual builder`, () => {
    const result = reconcileBuilderClass({ builderClass: title }, { ok: true, actualHarness: actual, launchRequestId: 'lrq_fixture' });
    assert.equal(result.finding.name, 'builder_class_mismatch');
    const route = routeSubject(result.subject, {
      loaderImpl: () => ({ get: (_key, fallback) => fallback }),
      env: {}, geminiReviewerMode: 'off',
    });
    assert.equal(route.reviewerModel, reviewer);
  });
}
test('absent provenance preserves title routing and records inconclusive', () => {
  const subject = { builderClass: 'codex' };
  const result = reconcileBuilderClass(subject, { ok: false, reason: 'missing-builder-provenance' });
  assert.equal(result.subject, subject);
  assert.equal(result.deferClaim, false);
  assert.equal(result.finding.name, 'builder_class_inconclusive');
});
for (const [name, ledgerTarget, expectedLocator] of [
  ['databaseName-only', { backend: 'postgres', databaseName: 'fixture_ledger' }, 'fixture_ledger'],
  ['libpq keyword/value', { backend: 'postgres', dsn: 'host=127.0.0.1 port=6432 dbname=fixture_ledger' },
    'host=127.0.0.1 port=6432 dbname=fixture_ledger'],
]) {
  test(`postgres provenance reads ${name} target without a URL rewrite`, t => {
    const warnings = [];
    t.mock.method(console, 'warn', message => warnings.push(message));
    let attempts = 0;
    const result = readPrBuilderProvenance({ repo: 'org/repo', prNumber: 12,
      env: hermeticEnv, ledgerTarget,
      spawnSyncImpl: (cmd, args, options) => {
        attempts += 1;
        assert.equal(cmd, 'psql');
        assert.ok(args.includes(expectedLocator));
        if (ledgerTarget.databaseName) assert.ok(args.includes('-d'));
        assert.match(options.input, /^BEGIN READ ONLY;/);
        assert.match(options.input, /COMMIT;\n$/);
        assert.doesNotMatch(options.input, /^\s*SET\s/im);
        return { status: 0, stdout: '{"actualHarness":"codex"}\n' };
      },
    });
    assert.equal(result.actualHarness, 'codex');
    assert.equal(attempts, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /using configured Postgres target/);
  });
}
for (const [name, failure] of [
  ['connection reset', { status: 2, stderr: 'connection reset by peer' }],
  ['TLS handshake timeout', { status: 2, stderr: 'TLS handshake timeout' }],
  ['SSL disconnect', { status: 2, stderr: 'SSL SYSCALL error: EOF detected' }],
  ['subprocess timeout', { status: null, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }],
  ['subprocess EIO', { status: null, error: Object.assign(new Error('input/output error'), { code: 'EIO' }) }],
  ['thrown EIO', Object.assign(new Error('input/output error'), { code: 'EIO' })],
]) {
  test(`postgres provenance recovers from transient ${name} before choosing a reviewer`, () => {
    let attempts = 0;
    const delays = [];
    const provenance = readPrBuilderProvenance({ repo: 'org/repo', prNumber: 12,
      ledgerTarget: 'postgresql://test@127.0.0.1:6432/fixture', env: hermeticEnv,
      sleepSyncImpl: ms => delays.push(ms),
      spawnSyncImpl: () => {
        attempts += 1;
        if (attempts < 3) {
          if (failure instanceof Error) throw failure;
          return failure;
        }
        return { status: 0, stdout: '{"actualHarness":"claude-code"}\n' };
      },
    });
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [100, 200]);
    const reconciled = reconcileBuilderClass({ builderClass: 'codex' }, provenance);
    assert.equal(reconciled.subject.builderClass, 'claude-code');
    assert.equal(reconciled.finding.name, 'builder_class_mismatch');
    assert.ok(!reconciled.deferClaim);
  });
}
for (const [name, failure, expectedAttempts] of [
  ['transient exhaustion', { status: 2, stderr: 'connection refused' }, 3],
  ['authentication failure', { status: 2, stderr: 'password authentication failed' }, 1],
  ['SQL failure', { status: 1, stderr: 'relation worker_runs does not exist' }, 1],
  ['missing psql', { status: null, error: { code: 'ENOENT' } }, 1],
  ['invalid JSON', { status: 0, stdout: '{invalid' }, 1],
]) {
  test(`postgres ${name} defers claims without falling back to the title route`, () => {
    let attempts = 0;
    const delays = [];
    const provenance = readPrBuilderProvenance({ repo: 'org/repo', prNumber: 12,
      ledgerTarget: 'postgresql://test@127.0.0.1:6432/fixture', env: hermeticEnv,
      sleepSyncImpl: ms => delays.push(ms),
      spawnSyncImpl: () => { attempts += 1; return failure; },
    });
    assert.equal(attempts, expectedAttempts);
    assert.equal(delays.length, expectedAttempts - 1);
    assert.equal(provenance.ok, false);
    assert.equal(provenance.deferClaim, true);
    const reconciled = resolveBuilderProvenanceRouting({ builderClass: 'codex' }, {
      readProvenance: () => provenance,
    });
    assert.equal(reconciled.deferClaim, true);
    assert.equal(reconciled.finding.name, 'builder_class_inconclusive');
  });
}
test('a successful empty Postgres query keeps title fallback', () => {
  const provenance = readPrBuilderProvenance({ repo: 'org/repo', prNumber: 12,
    ledgerTarget: 'postgresql://test@127.0.0.1:6432/fixture', env: hermeticEnv,
    spawnSyncImpl: () => ({ status: 0, stdout: '' }),
    sleepSyncImpl: () => assert.fail('empty query must not retry'),
  });
  assert.equal(provenance.reason, 'missing-builder-provenance');
  assert.equal(reconcileBuilderClass({ builderClass: 'codex' }, provenance).deferClaim, false);
});
test('an unexpected provenance read exception defers the claim', () => {
  const reconciled = resolveBuilderProvenanceRouting({ builderClass: 'codex' }, {
    readProvenance: () => { throw new Error('fixture read failure'); },
  });
  assert.equal(reconciled.deferClaim, true);
  assert.equal(reconciled.finding.reason, 'ledger-read-failed');
});
test('postgres builder lookup selects latest PR provenance across head moves in a read-only transaction', () => {
  let captured;
  const inputs = [];
  const deps = { repo: 'org/repo', prNumber: 12,
    ledgerTarget: 'postgresql://test@127.0.0.1:6432/agent_os_ledger_test',
    spawnSyncImpl: (_cmd, args, options) => {
      captured = { args, options };
      inputs.push(options.input);
      return { status: 0, stdout: '{"actualHarness":"codex","launchRequestId":"lrq_fixture"}\n' };
    },
  };
  const result = readPrBuilderProvenance({ ...deps, headSha });
  assert.deepEqual(readPrBuilderProvenance({ ...deps, headSha: 'b'.repeat(40) }), result);
  assert.deepEqual(readPrBuilderProvenance(deps), result);
  assert.equal(new Set(inputs).size, 1);
  assert.equal(result.actualHarness, 'codex');
  assert.ok(captured.args.includes('postgresql://test@127.0.0.1:5432/agent_os_ledger_test'));
  assert.ok(captured.args.includes('-q'));
  assert.match(captured.options.input, /BEGIN READ ONLY;/);
  assert.match(captured.options.input, /COMMIT;/);
  assert.doesNotMatch(captured.options.input, /^\s*SET\s/im);
  assert.doesNotMatch(captured.options.input, /bc\.head_sha|:'head_sha'/);
  assert.match(captured.options.input, /bc.repo = :'repo' AND bc.pr_number = :'pr_number'::integer/);
  assert.match(captured.options.input, /ORDER BY bc.recorded_at DESC, bc.completion_id DESC LIMIT 1/);
  assert.ok(captured.args.includes('repo=org/repo'));
  assert.ok(captured.args.includes('pr_number=12'));
});
test('default SQLite lookup preserves latest PR builder across head moves without writing the ledger', t => {
  const { rootDir, ledgerTarget } = sqliteProvenanceFixture(t);
  const before = readFileSync(ledgerTarget.path);
  const deps = { repo: 'org/repo', prNumber: 12, rootDir,
    env: { ...hermeticEnv, HOME: rootDir, AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME: 'off' },
    spawnSyncImpl: () => { throw new Error('SQLite must not invoke psql'); },
  };
  const expected = { ok: true, launchRequestId: 'lrq_latest', workerClass: 'claude-code', actualHarness: 'codex' };
  assert.deepEqual(readPrBuilderProvenance({ ...deps, headSha }), expected);
  assert.deepEqual(readPrBuilderProvenance({ ...deps, headSha: 'b'.repeat(40) }), expected);
  assert.deepEqual(readPrBuilderProvenance(deps), expected);
  assert.deepEqual(readFileSync(ledgerTarget.path), before);
});
for (const [name, options, expected] of [
  ['actual harness', { payload: { actualHarness: 'codex', workerSpec: { harness: 'gemini' } } }, 'codex'],
  ['worker spec', { payload: { actualHarness: '', workerSpec: { harness: 'gemini' } } }, 'gemini'],
  ['latest worker metadata', { workerRuns: [
    { runId: 'wr_z', metadata: { actualHarness: 'gemini' }, createdAt: '2026-09-28' },
    { runId: 'wr_a', metadata: { actualHarness: 'claude-code' }, createdAt: '2026-09-29' },
    { runId: 'wr_b', metadata: { actualHarness: 'codex' }, createdAt: '2026-09-29' },
  ] }, 'codex'],
  ['worker class with no worker run', { workerRuns: [] }, 'claude-code'],
  ['worker class with empty metadata', { workerRuns: [
    { runId: 'wr_1', metadata: { actualHarness: '' }, createdAt: '2026-09-29' },
  ] }, 'claude-code'],
]) {
  test(`SQLite provenance uses ${name} at the correct precedence`, t => {
    const { ledgerTarget } = sqliteProvenanceFixture(t, options);
    const result = readPrBuilderProvenance({ repo: 'org/repo', prNumber: 12, ledgerTarget, env: hermeticEnv });
    assert.equal(result.ok, true);
    assert.equal(result.actualHarness, expected);
  });
}
test('malformed SQLite provenance defers while missing provenance keeps fallback without creating a database', t => {
  const { ledgerTarget } = sqliteProvenanceFixture(t, { payload: '{malformed' });
  const subject = { builderClass: 'codex' };
  const malformed = readPrBuilderProvenance({ repo: 'org/repo', prNumber: 12, ledgerTarget, env: hermeticEnv });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, 'ledger-read-failed');
  assert.equal(reconcileBuilderClass(subject, malformed).subject, subject);
  assert.equal(reconcileBuilderClass(subject, malformed).deferClaim, true);
  const missing = readPrBuilderProvenance({ repo: 'org/repo', prNumber: 99, ledgerTarget, env: hermeticEnv });
  assert.deepEqual(missing, { ok: false, reason: 'missing-builder-provenance' });
  const missingPath = `${ledgerTarget.path}.missing`;
  const unavailable = readPrBuilderProvenance({ repo: 'org/repo', prNumber: 12,
    ledgerTarget: { backend: 'sqlite', path: missingPath }, env: hermeticEnv,
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, 'missing-ledger-target');
  assert.equal(existsSync(missingPath), false);
});
test('invalid PR selectors do not read provenance', () => {
  for (const prNumber of [0, -1, 1.5, 'invalid']) {
    assert.deepEqual(readPrBuilderProvenance({ repo: 'org/repo', prNumber, headSha }),
      { ok: false, reason: 'missing-pr-identity' });
  }
});
test('operator PR lookup retries transient CLI failures and awaits recovery before rerouting', async () => {
  let attempts = 0;
  const delays = [];
  const live = { state: 'OPEN', headRefOid: headSha, title: '[claude-code] fixture' };
  const fetchPr = (repo, pr) => fetchPrState(repo, pr, {
    env: hermeticEnv,
    sleep: async ms => { delays.push(ms); },
    execFileImpl: async (cmd, args, options) => {
      assert.equal(cmd, 'gh');
      assert.deepEqual(args, ['pr', 'view', '12', '--repo', 'org/repo', '--json', 'state,headRefOid,title']);
      assert.equal(options.timeout, 30_000);
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('TLS handshake timeout'), { stderr: 'TLS handshake timeout' });
      if (attempts === 2) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      return { stdout: JSON.stringify(live) };
    },
  });
  let retriggers = 0;
  await reroute(['--repo', 'org/repo', '--pr', '12', '--apply', '--reason', 'fixture'], {
    fetchPr,
    readProvenance: () => { assert.equal(attempts, 3); return { ok: true, actualHarness: 'codex' }; },
    retrigger: () => { retriggers += 1; return 0; },
    stdout: { write: () => {} },
  });
  assert.equal(retriggers, 1);
  assert.deepEqual(delays, [500, 1000]);
});
for (const [name, stderr, expectedAttempts] of [
  ['transient exhaustion', 'HTTP 503 Service Unavailable', 3],
  ['permanent permission error', 'HTTP 403 Forbidden', 1],
]) {
  test(`operator PR lookup stops on ${name} without rerouting`, async () => {
    let attempts = 0;
    const error = Object.assign(new Error(stderr), { stderr });
    await assert.rejects(reroute(['--repo', 'org/repo', '--pr', '12', '--apply', '--reason', 'fixture'], {
      fetchPr: (repo, pr) => fetchPrState(repo, pr, { env: hermeticEnv, sleep: async () => {},
        execFileImpl: async () => { attempts += 1; throw error; },
      }),
      readProvenance: () => assert.fail('failed lookup must not read ledger'),
      retrigger: () => assert.fail('failed lookup must not reroute'),
    }), thrown => thrown === error);
    assert.equal(attempts, expectedAttempts);
  });
}
test('operator PR lookup rejects malformed JSON without retrying a successful command', async () => {
  let attempts = 0;
  await assert.rejects(fetchPrState('org/repo', 12, { env: hermeticEnv,
    execFileImpl: async () => { attempts += 1; return { stdout: '{malformed' }; },
  }), SyntaxError);
  assert.equal(attempts, 1);
});
test('operator reroute defaults to preview, apply uses existing exact-head retrigger', async () => {
  const calls = [];
  const deps = {
    fetchPr: () => ({ state: 'OPEN', headRefOid: headSha, title: '[claude-code] fixture' }),
    readProvenance: () => ({ ok: true, actualHarness: 'codex' }),
    stdout: { write: () => {} },
    retrigger: args => { calls.push(args); return 0; },
  };
  await reroute(['--repo', 'org/repo', '--pr', '12'], deps);
  assert.equal(calls.length, 0);
  await reroute(['--repo', 'org/repo', '--pr', '12', '--apply', '--reason', 'fixture'], deps);
  assert.ok(calls[0].includes('--exact-head-now'));
  assert.ok(calls[0].includes(headSha));
  assert.ok(calls[0].includes('--no-bump-budget'));
  await assert.rejects(reroute(['--repo', 'org/repo', '--pr', '12', '--apply', '--reason', 'fixture'], {
    ...deps, fetchPr: () => ({ state: 'MERGED' }),
  }), /terminal PR/);
  assert.equal(calls.length, 1);
});

test('operator reroute passes root-dir to ledger lookup and exact-head retrigger', async () => {
  const reads = [];
  const retriggers = [];
  const rootDir = '/fixture/alternate-checkout';
  const deps = {
    fetchPr: () => ({ state: 'OPEN', headRefOid: headSha, title: '[claude-code] fixture' }),
    readProvenance: options => { reads.push(options); return { ok: true, actualHarness: 'codex' }; },
    stdout: { write: () => {} },
    retrigger: args => { retriggers.push(args); return 0; },
  };
  await reroute(['--repo', 'org/repo', '--pr', '12', '--root-dir', rootDir], deps);
  await reroute(['--repo', 'org/repo', '--pr', '12', '--root-dir', rootDir,
    '--apply', '--reason', 'fixture'], deps);
  assert.deepEqual(reads, Array(2).fill({ repo: 'org/repo', prNumber: 12, headSha, rootDir }));
  assert.equal(retriggers.length, 1);
  assert.equal(retriggers[0][retriggers[0].indexOf('--root-dir') + 1], rootDir);
});
