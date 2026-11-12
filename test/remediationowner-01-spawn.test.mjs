// REMEDIATIONOWNER-01: the spawn path asks HQ for the PR's live owner again
// immediately before the remediation worker starts. Synthetic repos, PRs,
// branches and launch ids only.
import './helpers/review-cli-resolver-fixture.mjs';
import { serviceFixtureExec } from './helpers/codex-service-fixture.mjs';
import './helpers/registry-session-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { consumeNextFollowUpJob } from '../src/follow-up-remediation.mjs';
import { createFollowUpJob, readFollowUpJob, writeFollowUpJob } from '../src/follow-up-jobs.mjs';
import {
  LIVE_PR_OWNER_DEFERRED,
  LIVE_PR_OWNER_UNKNOWN,
  createLivePrOwnerLookup,
} from '../src/remediation-live-pr-owner.mjs';

const REPO = 'example-org/sample-service';
const NOW = '2026-04-21T10:00:00.000Z';
const quiet = { log() {}, warn() {}, error() {}, info() {} };

async function withLocalEnv(t, run) {
  const workDir = mkdtempSync(path.join(tmpdir(), 'remediationowner-01-spawn-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const authDir = path.join(workDir, '.codex');
  mkdirSync(authDir, { recursive: true });
  mkdirSync(path.join(workDir, 'local-replies'), { recursive: true });
  writeFileSync(path.join(authDir, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt', tokens: { access_token: 'access-token', refresh_token: 'refresh-token' },
  }));
  const keys = ['ADV_REPLIES_ROOT', 'CODEX_AUTH_PATH', 'CODEX_CLI_PATH', 'CODEX_HOME', 'HOME', 'HQ_ROOT'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    ADV_REPLIES_ROOT: path.join(workDir, 'local-replies'),
    CODEX_AUTH_PATH: path.join(authDir, 'auth.json'),
    CODEX_CLI_PATH: '/usr/bin/true',
    CODEX_HOME: authDir,
    HOME: workDir,
  });
  delete process.env.HQ_ROOT;
  try {
    return await run(workDir);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function pendingJob(rootDir, prNumber) {
  return createFollowUpJob({
    builderTag: 'claude-code',
    branch: `synthetic/pr-${prNumber}`,
    rootDir,
    repo: REPO,
    prNumber,
    reviewerModel: 'claude',
    linearTicketId: null,
    reviewBody: '## Summary\nSynthetic finding.\n\n## Blocking issues\n- Fix the synthetic bug.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-04-21T08:00:00.000Z',
    critical: false,
  });
}

// Drives one consume to the spawn point. `lookups` answers the claim-time and
// spawn-time owner lookups in order; null wires no lookup.
async function consume(rootDir, lookups, { delayedPendingPaths = new Set() } = {}) {
  const asked = [];
  const spawns = [];
  const result = await consumeNextFollowUpJob({
    execFileSyncImpl: serviceFixtureExec,
    guardStackedBaseImpl: async () => null,
    rootDir,
    promptTemplate: 'Reply path: ${REPLY_PATH}',
    now: () => NOW,
    delayedPendingPaths,
    execFileImpl: async (command, args) => {
      if (command === 'git' && args[0] === 'clone') mkdirSync(path.join(args.at(-1), '.git'), { recursive: true });
      if (command === 'gh' && args[0] === 'api' && /\/pulls\//.test(args[1])) {
        return { stdout: JSON.stringify({ base: { ref: 'main' }, head: { ref: 'synthetic-head', repo: { full_name: REPO } } }), stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
    spawnImpl: (...args) => { spawns.push(args); return { pid: 7777, unref() {} }; },
    livePrOwnerLookupImpl: lookups && (async (args) => {
      asked.push(args);
      const next = lookups[asked.length - 1];
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(args) : next;
    }),
    log: quiet,
  });
  return { result, asked, spawns };
}

const FREE = { state: 'free' };
const LIVE_UPDATE = {
  state: 'owned',
  owner: { launchRequestId: 'lrq_synthetic_update', workerClass: 'claude-code', launchStatus: 'running', kind: 'pr-update' },
};

function assertReturnedToPending(job, jobPath) {
  assert.ok(existsSync(jobPath), 'the job is back in pending');
  assert.equal(job.status, 'pending');
  assert.equal(job.claimedAt, null);
  assert.equal(job.remediationWorker, null, 'no worker record exists');
  assert.equal(job.remediationPlan.currentRound, 0, 'no remediation round is charged');
  assert.deepEqual(job.remediationPlan.rounds, [], 'the never-spawned round is dropped');
}

test('an HQ owner that starts between claim and spawn defers the job before any worker starts', async (t) => {
  await withLocalEnv(t, async (rootDir) => {
    const { jobPath } = pendingJob(rootDir, 6101);
    const delayedPendingPaths = new Set();
    const { result, asked, spawns } = await consume(rootDir, [FREE, LIVE_UPDATE], { delayedPendingPaths });

    assert.deepEqual(asked, [{ repo: REPO, prNumber: 6101 }, { repo: REPO, prNumber: 6101 }],
      'HQ is asked at claim and again at spawn');
    assert.equal(spawns.length, 0, 'no remediation worker spawns while HQ reports a live owner');
    assert.equal(result.consumed, false);
    assert.equal(result.reason, LIVE_PR_OWNER_DEFERRED);
    assert.deepEqual(result.owner, { launchRequestId: 'lrq_synthetic_update', workerClass: 'claude-code',
      launchStatus: 'running', kind: 'pr-update' }, 'the typed result names the owner');
    assert.equal(result.jobPath, jobPath);
    assert.ok(delayedPendingPaths.has(jobPath), 'the job is skipped for the rest of this pass');

    const job = readFollowUpJob(jobPath);
    assertReturnedToPending(job, jobPath);
    assert.deepEqual(job.livePrOwnerDeferral, {
      reason: LIVE_PR_OWNER_DEFERRED, launchRequestId: 'lrq_synthetic_update', workerClass: 'claude-code',
      launchStatus: 'running', kind: 'pr-update', observedAt: NOW, since: NOW,
    });
  });
});

test('a terminal owner lets the spawn proceed and the job is consumed', async (t) => {
  await withLocalEnv(t, async (rootDir) => {
    pendingJob(rootDir, 6102);
    const { result, asked, spawns } = await consume(rootDir, [FREE, FREE]);
    assert.equal(result.consumed, true, JSON.stringify(result));
    assert.equal(asked.length, 2, 'the spawn-time lookup ran');
    assert.equal(spawns.length, 1);
    assert.equal(result.job.livePrOwnerDeferral, undefined);
  });
});

for (const [label, answer, lookupReason] of [
  ['throws', new Error('synthetic transport failure'), 'lookup-failed'],
  ['times out', { state: 'unknown', reason: 'lookup-timeout' }, 'lookup-timeout'],
  ['returns nothing', undefined, 'lookup-failed'],
]) {
  test(`a spawn-time owner lookup that ${label} defers; it never proceeds`, async (t) => {
    await withLocalEnv(t, async (rootDir) => {
      const { jobPath } = pendingJob(rootDir, 6103);
      const { result, spawns } = await consume(rootDir, [FREE, answer]);
      assert.equal(spawns.length, 0);
      assert.equal(result.consumed, false);
      assert.equal(result.reason, LIVE_PR_OWNER_UNKNOWN);
      assert.equal(result.lookupReason, lookupReason);
      const job = readFollowUpJob(jobPath);
      assertReturnedToPending(job, jobPath);
      assert.equal(job.livePrOwnerDeferral.reason, LIVE_PR_OWNER_UNKNOWN);
      assert.equal(job.livePrOwnerDeferral.lookupReason, lookupReason);
    });
  });
}

test('the production lookup defers at spawn when HQ exits 75 with ledger-unavailable', async (t) => {
  await withLocalEnv(t, async (rootDir) => {
    const { jobPath } = pendingJob(rootDir, 6104);
    let calls = 0;
    const hqLookup = createLivePrOwnerLookup({ env: { HQ_BIN: '/synthetic/bin/hq' }, timeoutMs: 1000, log: quiet,
      execFileImpl: async () => {
        calls += 1;
        if (calls === 1) return { stdout: '{"ok":true,"owner":null}\n' };
        throw Object.assign(new Error('exit 75'), { code: 75, stdout: '{"ok":false,"reason":"ledger-unavailable"}\n' });
      } });
    const { result, spawns } = await consume(rootDir, [hqLookup, hqLookup]);
    assert.equal(spawns.length, 0);
    assert.equal(result.reason, LIVE_PR_OWNER_UNKNOWN);
    assert.equal(readFollowUpJob(jobPath).livePrOwnerDeferral.lookupReason, 'ledger-unavailable');
  });
});

test('an operator retrigger keeps its one-shot override across a spawn-time deferral', async (t) => {
  await withLocalEnv(t, async (rootDir) => {
    const { jobPath, job } = pendingJob(rootDir, 6105);
    writeFollowUpJob(jobPath, { ...job, remediationPlan: { ...job.remediationPlan, nextAction: {
      type: 'consume-pending-round', round: 1, operatorVisibility: 'explicit', operatorOverride: true,
      requestedAt: NOW, requestedBy: 'synthetic-operator', reason: 'synthetic retrigger',
    } } });
    const { result } = await consume(rootDir, [FREE, LIVE_UPDATE]);
    assert.equal(result.reason, LIVE_PR_OWNER_DEFERRED);
    const requeued = readFollowUpJob(jobPath);
    assertReturnedToPending(requeued, jobPath);
    assert.equal(requeued.remediationPlan.nextAction.operatorOverride, true);
    assert.equal(requeued.remediationPlan.nextAction.round, 1);
  });
});

test('without a lookup the spawn path is unchanged', async (t) => {
  await withLocalEnv(t, async (rootDir) => {
    pendingJob(rootDir, 6106);
    const { result, spawns } = await consume(rootDir, null);
    assert.equal(result.consumed, true, JSON.stringify(result));
    assert.equal(spawns.length, 1);
  });
});
