import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHqDispatchStatusOutputParser } from '../src/hq-dispatch-status-output.mjs';
import { parseHqDispatchStatus } from '../src/producer-contracts/dispatch-receipt.mjs';
import {
  isMergeAgentDispatchActiveForHead,
  recordMergeAgentDispatch,
  scanStuckMergeAgentDispatches,
} from '../src/follow-up-merge-agent.mjs';
import { createAgentOsHqReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/agent-os-hq/index.mjs';
import { writeReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';
import { assessWorkerLivenessDetailed } from '../src/remediation-worker-liveness.mjs';
import { resolveHqWorkerWorkspace } from '../src/remediation-hq-dispatch.mjs';

const LRQ = 'lrq_11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-10-01T02:00:00Z');
const HEAD = { repo: 'fixture/repo', prNumber: 1, headSha: 'fixture-head' };
const HUMAN = 'failed — worker exited — next: inspect';

function fixture(t, { status = 'failed', malformed = false } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'status-json-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const hqRoot = join(rootDir, 'hq-root');
  mkdirSync(join(hqRoot, '.hq'), { recursive: true });
  writeFileSync(join(hqRoot, '.hq', 'config.json'), JSON.stringify({ ownerUser: 'fixture-owner' }));
  const callsPath = join(rootDir, 'calls.jsonl');
  const hqBin = join(rootDir, 'hq');
  writeFileSync(hqBin, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n');
if (args[0] !== 'dispatch' || args[1] !== 'status') process.exit(2);
const payload = ${JSON.stringify({ status, workspaceDir: join(rootDir, 'worker'), failureClass: 'fixture-failure' })};
console.log(${malformed} || !args.includes('--json') ? ${JSON.stringify(HUMAN)} : JSON.stringify(payload));
`, { mode: 0o755 });
  const env = {
    HQ_ROOT: hqRoot, HQ_BIN: hqBin, USER: 'fixture-owner',
    HQ_PARENT_SESSION: 'session:fixture', HQ_PROJECT: 'fixture-project',
  };
  recordMergeAgentDispatch(rootDir, HEAD, {
    launchRequestId: LRQ, dispatchedAt: '2026-10-01T00:00:00Z',
  });
  const auditDir = join(hqRoot, 'dispatch', 'audit', '2026-10-01');
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(join(auditDir, `${LRQ}.jsonl`), Array.from({ length: 6 }, () => JSON.stringify({
    decision: 'refuse_admit_memory_pressure', createdAt: '2026-10-01T01:00:00Z',
  })).join('\n') + '\n');
  const warnings = [];
  return {
    rootDir, hqRoot, hqBin, env, warnings,
    logger: { warn: message => warnings.push(message) },
    calls: () => readFileSync(callsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
  };
}

function scan(f) {
  return scanStuckMergeAgentDispatches({
    rootDir: f.rootDir, hqRoot: f.hqRoot, hqPath: f.hqBin,
    runtimeEnv: f.env, activePRs: [HEAD], now: NOW, logger: f.logger,
  });
}

function active(f) {
  return isMergeAgentDispatchActiveForHead(f.rootDir, HEAD, {
    env: f.env, logger: f.logger, detectAgentOsPresenceImpl: () => ({ present: true, path: f.hqBin }),
  });
}

async function review(f) {
  const record = writeReviewerRunRecord(f.rootDir, {
    sessionUuid: 'fixture-review', runtime: 'agent-os-hq', state: 'heartbeating',
    reattachToken: LRQ, spawnedAt: '2026-10-01T00:00:00Z', subjectContext: {},
  });
  const adapter = createAgentOsHqReviewerRuntimeAdapter({
    rootDir: f.rootDir, hqBin: f.hqBin, env: f.env, logger: f.logger,
  });
  return adapter.reattach(record);
}

test('synthetic hq defaults to a human line and requires --json', t => {
  const f = fixture(t);
  assert.equal(execFileSync(f.hqBin, ['dispatch', 'status', LRQ], { encoding: 'utf8' }).trim(), HUMAN);
  assert.equal(JSON.parse(execFileSync(f.hqBin, ['dispatch', 'status', LRQ, '--json'])).status, 'failed');
});

for (const status of ['running', 'succeeded', 'failed']) {
  test(`sync and async merge probes read ${status} through the real command boundary`, async t => {
    const f = fixture(t, { status });
    assert.deepEqual(scan(f), [], 'live status must suppress stale refusal history');
    const result = await active(f);
    assert.equal(result.status, status);
    assert.equal(result.active, status === 'running');
    assert.deepEqual(f.calls(), Array(2).fill(['dispatch', 'status', LRQ, '--json', '--as-owner', 'fixture-owner']));
    assert.deepEqual(f.warnings, []);
  });
}

test('reviewer runtime reads failed status and preserves --root', async t => {
  const f = fixture(t);
  const result = await review(f);
  assert.equal(result.ok, false);
  assert.equal(result.failureClass, 'fixture-failure');
  assert.match(result.error, /ended with status failed/);
  assert.deepEqual(f.calls(), [['dispatch', 'status', LRQ, '--json', '--root', f.hqRoot]]);
});

test('remediation liveness and workspace probes request JSON and preserve --root', async t => {
  const f = fixture(t);
  const worker = { dispatchMode: 'hq', dispatchId: LRQ, hqRoot: f.hqRoot };
  const result = await assessWorkerLivenessDetailed({ remediationWorker: worker }, { env: f.env });
  assert.equal(result.state, 'exited');
  assert.equal(result.dispatchStatus.status, 'failed');
  assert.equal(await resolveHqWorkerWorkspace({ worker, env: f.env }), join(f.rootDir, 'worker'));
  assert.deepEqual(f.calls(), Array(2).fill(['dispatch', 'status', LRQ, '--json', '--root', f.hqRoot]));
});

// Each test file has its own module state; this also checks the shared warning
// budget across all consumers and distinct dispatch arguments in one process.
test('non-JSON probes retain their failure behavior and emit one shared diagnostic', async t => {
  const f = fixture(t, { malformed: true });
  assert.equal(scan(f).length, 1, 'sync probe still falls back to refusal history');
  assert.equal((await active(f)).status, null);
  assert.match((await review(f)).error, /did not return JSON/);
  const worker = { dispatchMode: 'hq', dispatchId: LRQ, hqRoot: f.hqRoot };
  const liveness = await assessWorkerLivenessDetailed({ remediationWorker: worker }, { env: f.env, logger: f.logger });
  assert.equal(liveness.dispatchStatus.status, 'unknown');
  await assert.rejects(resolveHqWorkerWorkspace({ worker, env: f.env, logger: f.logger }), /did not return JSON/);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /non-JSON output/);
  assert.ok(f.warnings[0].includes(JSON.stringify(f.calls()[0])));
  assert.ok(f.warnings[0].includes(HUMAN));
});

test('diagnostics are bounded, renew after a minute, and preserve the thrown error', () => {
  let time = 0;
  const parse = createHqDispatchStatusOutputParser({ nowMs: () => time });
  const warnings = [];
  const logger = { warn: message => warnings.push(message) };
  const args = ['dispatch', 'status', LRQ, '--json'];
  const stdout = 'x'.repeat(200) + 'OMITTED' + 'y'.repeat(5000);
  const error = new SyntaxError('malformed fixture');
  const fail = () => { throw error; };
  assert.throws(() => parse(stdout, args, fail, logger), err => err === error);
  time = 59_999;
  assert.throws(() => parse(stdout, [...args, '--root', '/fixture/root'], fail, logger));
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].endsWith(`stdout=${JSON.stringify('x'.repeat(200))}`));
  assert.ok(!warnings[0].includes('OMITTED'));
  time = 60_000;
  assert.throws(() => parse('', args, JSON.parse, logger));
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /stdout=""/);
  assert.deepEqual(parse('{"status":"failed"}', args, JSON.parse, logger), { status: 'failed' });
  assert.throws(() => parse('{}', args, parseHqDispatchStatus, logger), /missing status/);
  assert.equal(warnings.length, 2, 'valid JSON with a missing status is not a non-JSON warning');
});
