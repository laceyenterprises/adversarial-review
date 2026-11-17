// Must stay the first import: it isolates this file's state before any production module loads.
import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { dispatchMergeAgentForPR } from '../src/follow-up-merge-agent.mjs';

// The dispatcher call runs real fake children (no network): the default exec
// path goes through the shared keep-output runner, so a timeout keeps output.
const ENV = {
  AGENT_OS_CONFIG_PATH: '/dev/null',
  MERGE_AGENT_PARENT_SESSION: 'session:test:merge-watcher',
  MERGE_AGENT_HQ_PROJECT: 'merge-project',
};

function fakeHq(dir, body) {
  const file = path.join(dir, 'fake-hq');
  writeFileSync(file, `#!${process.execPath}\n${body}`);
  chmodSync(file, 0o755);
  return file;
}

function scratchDir(t, prefix = 'followupexeccap-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function dispatch(t, hqPath, extra = {}) {
  const rootDir = scratchDir(t, 'followupexeccap-root-');
  return dispatchMergeAgentForPR({
    agentOsDetectImpl: () => ({ present: true, source: 'test' }),
    prepareOriginalWorkerImpl: async () => ({ decision: 'proceed' }),
    resolveMergeAgentHarnessImpl: async () => ({ workerClass: 'hammer' }),
    ghExecFileImpl: async () => ({ stdout: '' }),
    rootDir,
    repo: 'example-org/example-repo',
    prNumber: 401,
    branch: 'feature/pr-401',
    baseBranch: 'main',
    headSha: 'abc123',
    lastVerdict: 'Comment only',
    mergeable: 'CONFLICTING',
    checksConclusion: 'SUCCESS',
    labels: [{ name: 'merge-agent-requested' }],
    mergeAgentRequest: {
      actor: 'operator-login',
      createdAt: '2026-05-07T12:05:00.000Z',
      labelEventId: 'evt-merge-agent-requested',
      labelEventNodeId: 'LE_merge_agent_requested',
      headSha: 'abc123',
    },
    prState: 'open',
    merged: false,
    latestFollowUpJobStatus: 'completed',
    remediationCurrentRound: 1,
    remediationMaxRounds: 1,
    blockingFindingCount: 0,
    blockingFindingState: 'known',
    env: ENV,
    hqPath,
    now: '2026-05-19T04:20:00.000Z',
    ...extra,
  });
}

const OK_JSON = '{"dispatchId":"disp_real","lrq":"lrq_real"}';

test('a dispatcher timeout keeps the child partial stderr and names the budget', async (t) => {
  const dir = scratchDir(t);
  const hq = fakeHq(dir, `process.stderr.write('provisioning workspace step 3\\n'); setInterval(() => {}, 1000);`);
  const error = await dispatch(t, hq, { dispatchTimeoutMsOverride: 400, dispatchKillGraceMs: 2000, dispatchRetryDelaysMs: [] })
    .then(() => null, err => err);
  assert.ok(error, 'dispatch must fail');
  assert.match(error.message, /hq dispatch failed \(exit code ETIMEDOUT\): hq dispatch timed out after 400 ms/);
  assert.match(error.message, /provisioning workspace step 3/);
  assert.match(error.stderr, /provisioning workspace step 3/);
  assert.equal(error.code, 'ETIMEDOUT');
  assert.equal(error.cause.killed, true);
  assert.equal(error.cause.signal, 'SIGTERM');
  assert.equal(error.cause.cmd, hq);
});

test('a dispatcher that ignores SIGTERM is SIGKILLed after the grace', async (t) => {
  const dir = scratchDir(t);
  const pidFile = path.join(dir, 'pid');
  const hq = fakeHq(dir, `
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    process.stderr.write('ignoring term\\n');
    setInterval(() => {}, 1000);`);
  const startedAt = Date.now();
  const error = await dispatch(t, hq, { dispatchTimeoutMsOverride: 300, dispatchKillGraceMs: 300, dispatchRetryDelaysMs: [] })
    .then(() => null, err => err);
  assert.ok(error);
  assert.match(error.message, /timed out after 300 ms/);
  assert.match(error.stderr, /ignoring term/);
  assert.ok(Date.now() - startedAt >= 550, 'SIGKILL must wait for the grace, not fire at expiry');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the child must be gone');
});

test('a timed-out dispatch is still transient: the retry loop re-runs it', async (t) => {
  const dir = scratchDir(t);
  const counter = path.join(dir, 'count');
  const hq = fakeHq(dir, `
    const fs = require('node:fs');
    const n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0;
    fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
    if (n === 0) { process.stderr.write('slow start\\n'); setInterval(() => {}, 1000); }
    else process.stdout.write(${JSON.stringify(OK_JSON)});`);
  const result = await dispatch(t, hq, { dispatchTimeoutMsOverride: 400, dispatchKillGraceMs: 2000, dispatchRetryDelaysMs: [0] });
  assert.equal(result.decision, 'dispatch');
  assert.equal(result.launchRequestId, 'lrq_real');
  assert.equal(readFileSync(counter, 'utf8'), '2');
});

test('success is unchanged and the child receives the dispatch env and args', async (t) => {
  const dir = scratchDir(t);
  const seen = path.join(dir, 'seen.json');
  const hq = fakeHq(dir, `
    require('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({
      argv: process.argv.slice(2),
      trigger: process.env.MERGE_AGENT_DISPATCH_TRIGGER,
      project: process.env.MERGE_AGENT_HQ_PROJECT,
    }));
    process.stdout.write(${JSON.stringify(OK_JSON)});`);
  const result = await dispatch(t, hq);
  assert.equal(result.decision, 'dispatch');
  assert.equal(result.launchRequestId, 'lrq_real');
  const call = JSON.parse(readFileSync(seen, 'utf8'));
  assert.equal(call.argv[0], 'dispatch');
  assert.ok(call.argv.includes('--priority'));
  assert.equal(call.trigger, 'merge-agent-requested');
  assert.equal(call.project, 'merge-project');
});

test('a non-zero exit surfaces code, stdout and stderr and is not retried', async (t) => {
  const dir = scratchDir(t);
  const counter = path.join(dir, 'count');
  const hq = fakeHq(dir, `
    require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'x');
    process.stdout.write('partial stdout\\n');
    process.stderr.write('hq: error: unknown project merge-project\\n');
    process.exit(2);`);
  const error = await dispatch(t, hq, { dispatchRetryDelaysMs: [0, 0] }).then(() => null, err => err);
  assert.ok(error);
  assert.equal(error.code, 2);
  assert.match(error.stderr, /unknown project merge-project/);
  assert.match(error.stdout, /partial stdout/);
  assert.match(error.message, /unknown project merge-project/);
  assert.equal(readFileSync(counter, 'utf8'), 'x');
  assert.ok(existsSync(counter));
});

test('the priority-flag fallback still re-runs without --priority', async (t) => {
  const dir = scratchDir(t);
  const calls = path.join(dir, 'calls');
  const hq = fakeHq(dir, `
    const args = process.argv.slice(2);
    require('node:fs').appendFileSync(${JSON.stringify(calls)}, args.includes('--priority') ? 'P' : 'N');
    if (args.includes('--priority')) {
      process.stderr.write('hq dispatch: error: unrecognized arguments: --priority critical\\n');
      process.exit(2);
    }
    process.stdout.write(${JSON.stringify(OK_JSON)});`);
  const result = await dispatch(t, hq, { dispatchRetryDelaysMs: [] });
  assert.equal(result.decision, 'dispatch');
  assert.equal(readFileSync(calls, 'utf8'), 'PN');
});
