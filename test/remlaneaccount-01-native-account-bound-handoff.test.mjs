import './helpers/registry-session-fixture.mjs';
// REMLANEACCOUNT-01: in native orchestration mode an account-bound remediation
// lane (the corporate Claude remediator) is handed to HQ dispatch, which binds
// the account, instead of being refused. Comment-only remediation therefore
// keeps flowing while Codex is capped. Native mode still refuses a lane when HQ
// dispatch cannot be reached, 'agentos' mode is unchanged, and the watcher's
// remediation-job-missing blocker names the hold cause. Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAccountFixture } from './helpers/claude-account-fixture.mjs';
import {
  remediationLaneRuntimeMode,
  resolveRemediationWorkerClassWithFallback,
} from '../src/remediation-worker-class-fallback.mjs';
import { createFollowUpJob } from '../src/follow-up-jobs.mjs';
import { consumeNextFollowUpJob } from '../src/follow-up-remediation.mjs';
import { remediationHoldCause, remediationJobMissingDetail } from '../src/remediation-hold-cause.mjs';
import { resolveMergeAgentCoexistenceForWatcher } from '../src/ama-closure-orchestration.mjs';

const quiet = { info() {}, warn() {}, log() {}, error() {} };
const execFor = snapshot => async () => ({ stdout: JSON.stringify(snapshot) });
const CORP = 'remediator-claude-corp';
// The declared production order while Codex is capped: Gemini reviews the next
// round, personal Claude has no ready account, corporate Claude has quota.
const FALLBACKS = ['gemini', 'claude-code'];

function hqRootFixture(t, { present }) {
  const rootDir = mkdtempSync(join(tmpdir(), 'remlaneaccount-01-'));
  if (present) mkdirSync(join(rootDir, 'hq'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, hqRoot: join(rootDir, 'hq') };
}

const resolveNative = (snapshot, env, options = {}) => resolveRemediationWorkerClassWithFallback({
  primary: 'codex', fallbackWorkerClasses: FALLBACKS, reviewerModels: ['codex', 'gemini'],
  codexAccountPolicy: 'pinned', remediationMode: 'local', env,
  execFileImpl: execFor(snapshot), ...options });

const corporateOnly = claudeAccountFixture({ primary: 'exhausted' });

test('native mode with Codex capped selects the corporate Claude lane when HQ dispatch is reachable', async t => {
  const { hqRoot } = hqRootFixture(t, { present: true });
  const routed = await resolveNative(corporateOnly, { HQ_ROOT: hqRoot });
  assert.equal(routed.workerClass, CORP);
  assert.equal(routed.hold, false);
  assert.equal(routed.fellBack, true);
  assert.equal(routed.from, 'codex');
  assert.equal(routed.modeRefusals, undefined);
  assert.equal(remediationLaneRuntimeMode(routed.workerClass, 'local', { env: { HQ_ROOT: hqRoot } }), 'os');

  // Declared order is honoured: an explicit corporate entry ahead of the others wins.
  const explicit = await resolveNative(corporateOnly, { HQ_ROOT: hqRoot },
    { fallbackWorkerClasses: [CORP, 'gemini'] });
  assert.equal(explicit.workerClass, CORP);
});

test('the corporate lane is selected only while its account has quota', async t => {
  const { hqRoot } = hqRootFixture(t, { present: true });
  const capped = await resolveNative(claudeAccountFixture({ corp: 'exhausted', primary: 'exhausted' }),
    { HQ_ROOT: hqRoot });
  assert.equal(capped.hold, true);
  assert.notEqual(capped.workerClass, CORP);
  assert.equal(capped.modeRefusals, undefined);
});

test('native mode still refuses an account-bound lane that HQ dispatch cannot bind', async t => {
  const { hqRoot } = hqRootFixture(t, { present: false });
  for (const env of [{}, { HQ_ROOT: hqRoot }]) {
    const held = await resolveNative(corporateOnly, env);
    assert.equal(held.hold, true, JSON.stringify(env));
    assert.equal(held.reason, 'remediation-lane-unrunnable-in-mode');
    assert.deepEqual(held.modeRefusals, [{ workerClass: CORP, mode: 'local',
      reason: 'requires-account-bound-hq-dispatch' }]);
    assert.equal(remediationLaneRuntimeMode(CORP, 'local', { env }), 'local');
  }
});

test('agentos (os) mode is unchanged, and no other lane changes mode', async t => {
  const { hqRoot } = hqRootFixture(t, { present: false });
  const os = await resolveNative(corporateOnly, { HQ_ROOT: hqRoot }, { remediationMode: 'os' });
  assert.equal(os.workerClass, CORP);
  assert.equal(os.modeRefusals, undefined);
  assert.equal(remediationLaneRuntimeMode(CORP, 'os', { env: {} }), 'os');
  for (const workerClass of ['codex', 'remediator-codex', 'remediator-codex-corp', 'claude-code', 'remediator-claude', 'gemini']) {
    assert.equal(remediationLaneRuntimeMode(workerClass, 'local', { env: { HQ_ROOT: hqRoot } }), 'local', workerClass);
  }
});

// ── consume path ───────────────────────────────────────────────────────────

function nativeJobFixture(t, { present }) {
  const { rootDir, hqRoot } = hqRootFixture(t, { present });
  const overrides = { AGENT_OS_CONFIG_PATH: '/dev/null', AGENT_OS_ROLES_REMEDIATOR: 'adversarial',
    ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR: undefined, ADV_WITH_HQ_INTEGRATION: undefined,
    AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: 'native', HQ_ROOT: hqRoot,
    HQ_PARENT_SESSION: undefined, HQ_PROJECT: undefined };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  const apply = values => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  apply(overrides);
  t.after(() => apply(previous));
  createFollowUpJob({ branch: 'fixture/remediation', rootDir, repo: 'sample/project', prNumber: 42,
    builderTag: 'codex', reviewerModel: 'codex', reviewBody: '## Verdict\nRequest changes', critical: true,
    reviewPostedAt: '2026-11-06T00:00:00Z' });
  return { rootDir, hqRoot };
}

function consumeNative({ rootDir, hqRoot, snapshot, hqCalls }) {
  return consumeNextFollowUpJob({ rootDir,
    promptTemplate: 'Synthetic remediation prompt.',
    resolveRemediationWorkerClassImpl: args => resolveRemediationWorkerClassWithFallback({ ...args,
      fallbackWorkerClasses: FALLBACKS, execFileImpl: execFor(snapshot) }),
    guardStackedBaseImpl: async () => null, resolvePRLifecycleImpl: async () => null,
    execFileImpl: async (command, args, options) => {
      if (command === 'gh' && args[0] === 'api' && String(args[1]).endsWith('/pulls/42')) {
        return { stdout: JSON.stringify({ base: { ref: 'main' },
          head: { ref: 'synthetic-branch', repo: { full_name: 'sample/project' } } }) };
      }
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: JSON.stringify({ status: 'queued', workspacePath: join(hqRoot, 'workers', 'lrq_synthetic') }) };
      }
      if (args[0] === 'dispatch') {
        hqCalls.push({ command, args, env: options?.env });
        return { stdout: JSON.stringify({ launchRequestId: 'lrq_synthetic', dispatchId: 'dispatch_synthetic' }) };
      }
      return { stdout: '' };
    },
    spawnImpl: () => assert.fail('the account-bound lane must not self-spawn in native mode'),
    postCommentImpl: async () => {}, deliverAlertImpl: async () => {}, log: quiet,
  });
}

test('native consume launches the corporate Claude lane through HQ dispatch with the ordinary hq bookkeeping', async t => {
  const fixture = nativeJobFixture(t, { present: true });
  const hqCalls = [];
  const result = await consumeNative({ ...fixture, snapshot: corporateOnly, hqCalls });
  assert.equal(result.consumed, true, JSON.stringify(result.reason));
  assert.equal(hqCalls.length, 1);
  const argv = hqCalls[0].args;
  assert.equal(argv[argv.indexOf('--worker-class') + 1], CORP);
  assert.equal(argv[argv.indexOf('--completion-shape') + 1], 'branch-push');
  assert.equal(argv[argv.indexOf('--parent-session') + 1], 'session:adversarial-review:watcher');
  assert.equal(hqCalls[0].env.HQ_PROJECT, 'pr-merge-orchestration');
  assert.equal(result.job.remediationPlan.dispatchPath, 'hq');
  const worker = result.job.remediationWorker;
  assert.equal(worker.dispatchMode, 'hq');
  assert.equal(worker.launchRequestId, 'lrq_synthetic');
  assert.equal(worker.dispatchId, 'dispatch_synthetic');
  assert.equal(worker.workerClass, CORP);
  assert.deepEqual(worker.hqDispatchHandoff, { workerClass: CORP, from: 'local', to: 'os' });
  assert.equal(worker.fallbackFrom, 'claude-code');
  assert.equal(worker.modeRefusals, undefined);
  assert.equal(process.env.HQ_PARENT_SESSION, undefined, 'the handoff must not leak into the daemon environment');
});

test('native consume with an unreachable HQ root still holds the job instead of burning a round', async t => {
  const fixture = nativeJobFixture(t, { present: false });
  const result = await consumeNative({ ...fixture, snapshot: corporateOnly, hqCalls: [] });
  assert.equal(result.consumed, false);
  assert.equal(result.reason, 'remediator-capped-hold');
  assert.equal(result.job.status, 'pending');
  assert.equal(result.job.remediationPlan.currentRound, 0);
});

// ── the blocker names the hold cause ───────────────────────────────────────

test('a held job yields a hold cause naming lane and reason; a free or absent job yields none', async t => {
  const fixture = nativeJobFixture(t, { present: false });
  const held = await consumeNative({ ...fixture, snapshot: corporateOnly, hqCalls: [] });
  const cause = remediationHoldCause(held.job);
  assert.equal(cause.lane, 'claude-code');
  assert.equal(cause.reason, 'remediation-lane-unrunnable-in-mode');
  assert.deepEqual(cause.modeRefusals, [{ workerClass: CORP, mode: 'local',
    reason: 'requires-account-bound-hq-dispatch' }]);
  assert.ok(Date.parse(cause.holdUntil) > 0);
  assert.equal(remediationHoldCause({ ...held.job, status: 'in_progress' }), null);
  assert.equal(remediationHoldCause(null), null);
  assert.deepEqual(remediationJobMissingDetail({ rootDir: fixture.rootDir, repo: 'sample/project', prNumber: 42 }),
    { remediationHold: cause });
  assert.deepEqual(remediationJobMissingDetail({ rootDir: fixture.rootDir, repo: 'sample/project', prNumber: 7 }), {});
  assert.deepEqual(remediationJobMissingDetail({ findLatestImpl: () => { throw new Error('unreadable'); } }), {});
});

test('the watcher remediation-job-missing blocker line carries the hold cause', async t => {
  const fixture = nativeJobFixture(t, { present: false });
  await consumeNative({ ...fixture, snapshot: corporateOnly, hqCalls: [] });
  const events = [];
  const missing = { dispatched: false, skipMergeAgent: true, amaEnabled: true, reason: 'remediation-job-missing' };
  const run = (prNumber) => resolveMergeAgentCoexistenceForWatcher({
    rootDir: fixture.rootDir, repoPath: 'sample/project', prNumber,
    reviewStateRow: { repo: 'sample/project', pr_number: prNumber, pr_state: 'open' },
    candidate: { headSha: 'a'.repeat(40), prState: 'open' }, labelNames: [], dispatchJob: {},
    currentRevisionRef: 'a'.repeat(40),
    logger: { log() {}, warn() {}, info: line => events.push(JSON.parse(line)) },
    maybeDispatchAmaClosureForImpl: async () => missing,
  });
  await run(42);
  const blocker = events.find(event => event.event === 'ama.closure_blocker');
  assert.equal(blocker.reason, 'remediation-job-missing');
  assert.equal(blocker.remediationHold.lane, 'claude-code');
  assert.equal(blocker.remediationHold.reason, 'remediation-lane-unrunnable-in-mode');

  events.length = 0;
  await run(7);
  const plain = events.find(event => event.event === 'ama.closure_blocker');
  assert.equal(plain.reason, 'remediation-job-missing');
  assert.equal(plain.remediationHold, undefined);
});
