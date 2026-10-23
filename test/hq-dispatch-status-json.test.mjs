import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHqDispatchStatusOutputParser } from '../src/hq-dispatch-status-output.mjs';
import { parseHqDispatchStatus } from '../src/producer-contracts/dispatch-receipt.mjs';
import {
  cancelMergeAgentDispatchOnMerge,
  dispatchMergeAgentForPR,
  listMergeAgentDispatches,
  isMergeAgentDispatchActiveForHead,
  recordMergeAgentDispatch,
  scanStuckMergeAgentDispatches,
} from '../src/follow-up-merge-agent.mjs';
import { createAgentOsHqReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/agent-os-hq/index.mjs';
import { writeReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';
import { assessWorkerLivenessDetailed } from '../src/remediation-worker-liveness.mjs';
import { dispatchStatusExamples } from './helpers/dispatch-status-cases.mjs';
import { readDispatchStatus, LAUNCH_REQUEST_STATUSES } from '@agent-os/app-sdk';
import { normalizeWorkerTerminalEvent, workerTerminalEventToDispatchStatus } from '../src/remediation-hq-dispatch.mjs';
import { reconcileFollowUpJob } from '../src/follow-up-remediation.mjs';
import { createFollowUpJob, claimNextFollowUpJob, markFollowUpJobSpawned } from '../src/follow-up-jobs.mjs';
import { resolveHqWorkerWorkspace } from '../src/remediation-hq-dispatch.mjs';

const LRQ = 'lrq_11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-10-01T02:00:00Z');
const HEAD = { repo: 'fixture/repo', prNumber: 1, headSha: 'fixture-head' };
const HUMAN = 'failed — worker exited — next: inspect';

function fixture(t, { status = 'failed', wire = {}, malformed = false, malformedOutput = HUMAN } = {}) {
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
const payload = ${JSON.stringify({ status, workspaceDir: join(rootDir, 'worker'), failureClass: 'fixture-failure', ...wire })};
console.log(${malformed} || !args.includes('--json') ? ${JSON.stringify(malformedOutput)} : JSON.stringify(payload));
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
  const whitespace = fixture(t, { malformed: true, malformedOutput: ' \n\t ' });
  whitespace.logger = f.logger;
  assert.equal((await active(whitespace)).status, null);
  assert.equal(f.warnings.length, 1);
  assert.ok(f.warnings[0].endsWith('stdout=""'), 'async probe trims whitespace-only output like the sync probe');
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
});

for (const stdout of [HUMAN, '', ' \n\t ', '{broken}']) {
  test(`producer-contract parser warns on non-JSON output ${JSON.stringify(stdout)}`, () => {
    const parse = createHqDispatchStatusOutputParser();
    const warnings = [];
    const args = ['dispatch', 'status', LRQ, '--json'];
    assert.throws(() => parse(stdout, args, parseHqDispatchStatus, {
      warn: message => warnings.push(message),
    }), /\$stdout (?:invalid JSON|empty)/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /non-JSON output/);
    assert.ok(warnings[0].endsWith(`stdout=${JSON.stringify(stdout)}`));
  });
}

test('backward clock adjustments renew the warning budget', () => {
  let time = 60_000;
  const parse = createHqDispatchStatusOutputParser({ nowMs: () => time });
  const warnings = [];
  const logger = { warn: message => warnings.push(message) };
  const args = ['dispatch', 'status', LRQ, '--json'];
  const fail = () => assert.throws(() => parse(HUMAN, args, parseHqDispatchStatus, logger));
  fail();
  time = 0;
  fail();
  assert.equal(warnings.length, 2);
  time = 59_999;
  fail();
  assert.equal(warnings.length, 2);
  time = 60_000;
  fail();
  assert.equal(warnings.length, 3);
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

assert.deepEqual([...new Set(dispatchStatusExamples.map(x => x.value.status))].sort(),
  [...LAUNCH_REQUEST_STATUSES].sort(), 'public examples cover every canonical state');

const dispatchCases = [
  ...dispatchStatusExamples.map(({ scenario, value }) => [scenario, value]),
  // Negative/compatibility mutations: producer booleans are independent.
  ['negative explicit terminal false', { status: 'succeeded', terminal: false }],
  ['negative explicit succeeded false', { status: 'succeeded', succeeded: false }],
  ['negative explicit both false', { status: 'succeeded', terminal: false, succeeded: false }],
  ['negative explicit terminal true', { status: 'running', terminal: true, succeeded: false }],
  ['legacy missing booleans', { status: 'succeeded' }],
  ['negative unknown', { status: 'future' }],
  ['negative malformed', { status: { value: 'succeeded' } }],
  ...['completed', 'complete', 'done', 'cancelled'].map(status => [`negative alias ${status}`, { status }]),
];
for (const [scenario, payload] of dispatchCases) {
  test(`SDK dispatch boundary: ${scenario} controls reviewer, remediation and event handling`, async t => {
    const f = fixture(t);
    const evidence = readDispatchStatus(payload);
    const artifactPath = join(f.rootDir, 'review.md');
    writeFileSync(artifactPath, '## Summary\nSynthetic review.\n\n## Verdict\nComment only\n');
    const record = writeReviewerRunRecord(f.rootDir, {
      sessionUuid: 'sdk-review', runtime: 'agent-os-hq', state: 'heartbeating',
      reattachToken: LRQ, spawnedAt: '2026-10-01T00:00:00Z',
      subjectContext: { agentOsHq: { artifactPath, hqRoot: f.hqRoot } },
    });
    let polls = 0;
    const adapter = createAgentOsHqReviewerRuntimeAdapter({
      rootDir: f.rootDir, hqBin: f.hqBin, env: f.env, logger: f.logger,
      sleepImpl: async () => {},
      execFileImpl: async () => ({ stdout: JSON.stringify(++polls === 1 ? payload : { status: 'failed' }) }),
    });
    const result = await adapter.reattach(record);
    assert.equal(polls, evidence.terminal ? 1 : 2, 'nonterminal/unknown evidence keeps polling');
    assert.equal(result.ok, evidence.terminal && evidence.succeeded, 'exit zero and artifact presence alone cannot deliver a review');
    if (!evidence.succeeded) assert.equal(result.reviewBody, null);
    const worker = { dispatchMode: 'hq', dispatchId: LRQ, launchRequestId: LRQ, hqRoot: f.hqRoot };
    const liveness = await assessWorkerLivenessDetailed({ remediationWorker: worker }, {
      env: f.env, execFileImpl: async () => ({ stdout: JSON.stringify(payload) }),
    });
    assert.equal(liveness.state, evidence.terminal ? 'exited' : 'active');
    const event = normalizeWorkerTerminalEvent(`health.worker.terminal.${LRQ}`, { ...payload, lrq: LRQ });
    assert.equal(Boolean(event), evidence.terminal && evidence.status !== null);
    if (event) {
      const projected = workerTerminalEventToDispatchStatus(event);
      assert.equal(projected.terminal, evidence.terminal);
      assert.equal(projected.succeeded, evidence.succeeded);
    }
    const active = await isMergeAgentDispatchActiveForHead(f.rootDir, HEAD, {
      env: f.env, logger: f.logger, detectAgentOsPresenceImpl: () => ({ present: true, path: f.hqBin }),
      probeDispatchStatusViaHqImpl: async () => payload,
    });
    assert.equal(active.active, !evidence.terminal && Boolean(evidence.status || payload.terminal === false));
  });
}

for (const payload of [
  { status: 'succeeded', terminal: false, succeeded: false },
  { status: 'failed', terminal: false },
  { status: 'not-found', terminal: false },
  { status: 'blocked_needs_decision', terminal: true, succeeded: false },
  { status: 'waiting_approval' }, { status: 'waiting_input' },
  { status: 'completed' }, { status: 'cancelled' }, { status: 'future' },
]) {
  test(`negative/parked merge retry evidence ${JSON.stringify(payload)} cannot redrive a recorded launch`, async t => {
    const f = fixture(t);
    const result = await dispatchMergeAgentForPR({
      rootDir: f.rootDir, ...HEAD, branch: 'fixture-branch', baseBranch: 'main',
      lastVerdict: 'Comment only', mergeable: 'MERGEABLE', checksConclusion: 'SUCCESS',
      prState: 'open', merged: false, latestFollowUpJobStatus: 'completed',
      remediationCurrentRound: 1, remediationMaxRounds: 1,
      labels: [{ name: 'merge-agent-dispatched' }],
      env: { ...f.env, MERGE_AGENT_PARENT_SESSION: 'session:fixture', MERGE_AGENT_HQ_PROJECT: 'fixture-project' },
      agentOsDetectImpl: () => ({ present: true, path: f.hqBin }),
      prepareOriginalWorkerImpl: () => ({ decision: 'ready' }),
      execFileImpl: async (_command, args) => {
        assert.deepEqual(args.slice(0, 2), ['dispatch', 'status'], 'no new dispatch');
        return { stdout: JSON.stringify(payload) };
      },
      ghExecFileImpl: async () => ({ stdout: '' }), logger: f.logger,
      now: new Date(NOW).toISOString(),
    });
    assert.equal(result.decision, 'skip-already-dispatched');
    assert.equal(listMergeAgentDispatches(f.rootDir).length, 1);
  });
}

for (const status of [null, '', 42, 'future', 'succeeded']) {
  test(`negative wire-only merge transport ${JSON.stringify(status)} retains explicit terminal false`, async t => {
    const f = fixture(t, { wire: { status, terminal: false, succeeded: false } });
    assert.equal((await active(f)).active, true);
    assert.ok(f.calls()[0].includes('--json'));
  });
}

for (const terminal of [true, false]) {
  for (const succeeded of [true, false]) {
    test(`wire-only cancel probe terminal=${terminal} succeeded=${succeeded} controls label cleanup`, async t => {
      const f = fixture(t);
      recordMergeAgentDispatch(f.rootDir, HEAD, { launchRequestId: LRQ,
        dispatchedAt: '2026-10-01T00:00:00Z', hqOwnerUser: 'fixture-owner' });
      let labelRemovals = 0;
      const result = await cancelMergeAgentDispatchOnMerge({
        rootDir: f.rootDir, repo: HEAD.repo, prNumber: HEAD.prNumber, hqPath: f.hqBin,
        now: new Date(NOW).toISOString(), env: f.env, cancelRetryDelaysMs: [],
        ghExecFileImpl: async () => { labelRemovals++; return { stdout: '' }; },
        hqExecFileImpl: async (_command, args) => {
          if (args[1] === 'cancel') throw new Error('unreadable cancel failure');
          assert.deepEqual(args, ['dispatch', 'status', LRQ, '--json', '--as-owner', 'fixture-owner']);
          return { stdout: JSON.stringify({ status: null, terminal, succeeded }) };
        },
      });
      assert.equal(result.probeConfirmedTerminal, terminal);
      assert.equal(result.cleanupComplete, terminal);
      assert.equal(result.retryable, !terminal);
      assert.equal(result.labelRemoved, terminal);
      assert.equal(labelRemovals, terminal ? 1 : 0);
      if (terminal) assert.equal(result.probedDispatchStatus, 'terminal');
    });
  }
}

for (const payload of [
  { status: 'succeeded', terminal: false },
  { status: 'succeeded', terminal: true, succeeded: false },
  { status: 'succeeded', terminal: true, succeeded: true },
]) {
  test(`remediation reconcile requires terminal success before missing-artifact settlement: ${JSON.stringify(payload)}`, async t => {
    const f = fixture(t);
    const priorHqRoot = process.env.HQ_ROOT;
    process.env.HQ_ROOT = f.hqRoot;
    t.after(() => {
      if (priorHqRoot === undefined) delete process.env.HQ_ROOT;
      else process.env.HQ_ROOT = priorHqRoot;
    });
    const headSha = 'a'.repeat(40);
    createFollowUpJob({ rootDir: f.rootDir, repo: HEAD.repo, prNumber: HEAD.prNumber,
      branch: 'fixture/remediation', revisionRef: headSha, reviewerModel: 'claude', critical: true,
      reviewBody: '## Summary\nFix the finding.', reviewPostedAt: '2026-10-01T00:00:00Z' });
    const claimed = claimNextFollowUpJob({ rootDir: f.rootDir, claimedAt: '2026-10-01T00:01:00Z' });
    const workspaceDir = join(f.hqRoot, 'adversarial-review', 'follow-up-workspaces', claimed.job.jobId);
    mkdirSync(workspaceDir, { recursive: true });
    const spawned = markFollowUpJobSpawned({ rootDir: f.rootDir, jobPath: claimed.jobPath,
      spawnedAt: '2026-10-01T00:02:00Z', worker: {
        model: 'codex', workerClass: 'codex', dispatchMode: 'hq', dispatchId: LRQ,
        launchRequestId: LRQ, hqRoot: f.hqRoot, workspaceDir,
        outputPath: join(workspaceDir, 'last-message.md'),
        logPath: join(workspaceDir, 'worker.log'),
        replyPath: join(f.hqRoot, 'dispatch', 'remediation-replies', claimed.job.jobId, 'remediation-reply.json'),
      } });
    const result = await reconcileFollowUpJob({
      rootDir: f.rootDir, jobPath: spawned.jobPath, job: spawned.job,
      now: () => new Date(NOW).toISOString(),
      resolvePRLifecycleImpl: async () => ({ source: 'live', prState: 'open', headSha }),
      execFileImpl: async (_command, args) => {
        assert.deepEqual(args.slice(0, 2), ['dispatch', 'status']);
        return { stdout: JSON.stringify({ ...payload, workspaceDir }) };
      },
      postCommentImpl: async () => ({ posted: false, error: 'offline fixture' }), log: f.logger,
    });
    if (payload.terminal === false) {
      assert.equal(result.action, 'active');
      assert.equal(result.job.status, 'in_progress');
      assert.equal(result.job.remediationWorker.state, 'spawned');
    } else {
      assert.equal(result.action, 'failed');
      assert.equal(result.job.failure.code, payload.succeeded ? 'artifact-missing-completion' : 'hq-dispatch-failed');
    }
  });
}
