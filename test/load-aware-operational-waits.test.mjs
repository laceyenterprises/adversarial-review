import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os, { loadavg } from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { observeClosureWait, CLOSURE_WAIT_BOUND_MS } from '../src/ama/closure-wait.mjs';
import { resolveReviewerTimeoutMs, resolveProgressTimeoutMs, resolveAgyPrintTimeoutMs,
  resolveFirstOutputTimeoutMs, resolveAgyChunkTimeoutPlan } from '../src/reviewer-timeout.mjs';
import { resolveReviewerCeilingSeconds, resolveReviewerIdleTimeoutSeconds } from '../src/reviewer-timeout-model.mjs';
import { __testables__ } from '../src/ama/dispatch-closer.mjs';
import { amaCloserPendingLeaseExpiryMs, isReclaimablePendingAmaCloserLease, AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS } from '../src/ama/closer-lease.mjs';
import { resolveRoutingTierReadinessTimeoutMs } from '../src/routing-tier-readiness.mjs';
import { ownerlessBoundMs } from '../src/ama/orphan-watchdog.mjs';
import { readPipelineGithub } from '../src/pipeline-health-github.mjs';
import { resetLoadAwareTimeoutCachesForTesting } from '../src/load-aware-timeout.mjs';
import { resolveReviewPipelineHealthConfig, summarizeFirstPassCiOrphans } from '../src/review-pipeline-health.mjs';
import { createSlackThreadCommsAdapter } from '../src/adapters/comms/slack-thread/index.mjs';
import { acquireMergeLease, acquireDaemonMergeLease, releaseMergeLease, upsertMergeLeaseWaiter } from '../src/ama/merge-lease.mjs';


function busyHost(t) {
  t.mock.method(os, 'loadavg', () => [os.cpus().length * 3, 0, 0]);
  t.mock.method(childProcess, 'execFileSync', command => {
    assert.equal(command, '/bin/ps');
    return `${os.cpus().length * 100}\n`;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
function waitFixture(t, overrides = {}) {
  const rootDir = mkdtempSync(join(os.tmpdir(), 'closure-load-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const pages = [];
  const args = { rootDir, repo: 'example/project', prNumber: 42, headSha: 'synthetic-head',
    reason: 'in-flight:synthetic-launch', env: {}, pageImpl: async text => pages.push(text), ...overrides };
  return { pages, observe: options => observeClosureWait({ ...args, ...options }) };
}

const preloadedLoadavg = os.loadavg;
test('idle-host preload synchronizes the named OS loadavg binding', () => {
  assert.equal(loadavg, preloadedLoadavg);
  assert.deepEqual(loadavg(), [0, 0, 0]);
});

test('slack lock acquisition retains its initial budget when host load drops', async t => {
  busyHost(t);
  const rootDir = mkdtempSync(join(os.tmpdir(), 'slack-load-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const lockPath = join(rootDir, '.slack-thread-transcripts', 'subject.md', 'slack-thread.jsonl.lock');
  mkdirSync(join(rootDir, '.slack-thread-transcripts', 'subject.md'), { recursive: true });
  writeFileSync(lockPath, `${process.pid}\n`);
  let clock = 0, attempts = 0;
  t.mock.method(Date, 'now', () => clock);
  t.mock.method(os, 'loadavg', () => {
    attempts++;
    return [os.cpus().length * 3, 0, 0];
  });
  let failure;
  const adapter = createSlackThreadCommsAdapter({ rootDir,
    slackClient: { postMessage: async () => ({ deliveryExternalId: 'synthetic-delivery' }) } });
  const pending = adapter.postReview({ kind: 'comment-only', body: 'fixture' }, {
    domainId: 'research-finding', subjectExternalId: 'subject.md',
    revisionRef: 'fixture', round: 1, kind: 'review',
  }).catch(error => { failure = error; });
  // The first synchronous attempt has sampled the busy host before sleeping.
  assert.equal(attempts, 1);
  clock = 6_000; // Past nominal 5s, but within the granted 30s.
  t.mock.method(os, 'loadavg', () => { attempts++; return [0, 0, 0]; });
  await new Promise(resolve => setTimeout(resolve, 60));
  unlinkSync(lockPath);
  await pending;
  assert.equal(failure, undefined);
  assert.equal(attempts, 1, 'a retry must not resize its deadline');
});

test('reused pipeline health config scales orphan deadlines and worker probes at use time', t => {
  busyHost(t);
  const env = {
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_FIRST_PASS_CI_ORPHAN_DEADLINE_MS: '100',
    ADVERSARIAL_REVIEW_PIPELINE_HEALTH_FIRST_PASS_CI_ORPHAN_WORKER_STATUS_TIMEOUT_MS: '200',
  };
  const config = resolveReviewPipelineHealthConfig(env);
  assert.equal(config.firstPassCiOrphanDeadlineMs, 100);
  assert.equal(config.firstPassCiOrphanWorkerStatusTimeoutMs, 200);
  const overridden = resolveReviewPipelineHealthConfig(env, {
    firstPassCiOrphanDeadlineMs: 150, firstPassCiOrphanWorkerStatusTimeoutMs: 250,
  });
  assert.equal(overridden.firstPassCiOrphanDeadlineMs, 150);
  assert.equal(overridden.firstPassCiOrphanWorkerStatusTimeoutMs, 250);
  const hqRoot = mkdtempSync(join(os.tmpdir(), 'orphan-load-'));
  t.after(() => rmSync(hqRoot, { recursive: true, force: true }));
  const workerDir = join(hqRoot, 'workers', 'fixture');
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, 'workspace.json'), JSON.stringify({
    repo: 'example/project', branch: 'fixture', launchRequestId: 'synthetic-launch',
  }));
  const queue = { firstPassPrs: [1, 2].map(prNumber => ({
    repo: 'example/project', prNumber, reviewAttempts: 0, reviewerFailed: false,
  })) };
  for (const multiplier of [6, 1]) {
    t.mock.method(os, 'loadavg', () => [multiplier === 6 ? os.cpus().length * 3 : 0, 0, 0]);
    resetLoadAwareTimeoutCachesForTesting();
    let clock = 0, probes = 0;
    t.mock.method(Date, 'now', () => clock);
    const result = summarizeFirstPassCiOrphans(queue, { hqRoot, config,
      execFileSyncImpl: (command, args, options) => {
        if (command === 'gh') return args.includes('checks')
          ? JSON.stringify([{ name: 'test', state: 'FAILURE', bucket: 'fail' }])
          : JSON.stringify({ state: 'OPEN', headRefName: 'fixture' });
        probes++;
        assert.equal(options.timeout, 200 * multiplier, 'worker timeout scales exactly once');
        clock = 200; // Second PR fits only the busy-host 600ms deadline.
        return JSON.stringify({ status: 'running' });
      },
    });
    assert.equal(probes, multiplier === 6 ? 2 : 1);
    assert.equal(result.count, 0);
  }
});

test('closure wait grants the full multiplier beyond the helper default one-hour cap', async t => {
  busyHost(t);
  const f = waitFixture(t);
  const first = await f.observe({ now: 0 });
  assert.equal(first.boundedMs, CLOSURE_WAIT_BOUND_MS * 6);
  assert.equal((await f.observe({ now: CLOSURE_WAIT_BOUND_MS })).exhausted, false);
  assert.equal((await f.observe({ now: CLOSURE_WAIT_BOUND_MS * 6 - 1 })).exhausted, false);
  const last = await f.observe({ now: CLOSURE_WAIT_BOUND_MS * 6 });
  assert.equal(last.exhausted, true);
  assert.equal(last.retryAfterMs, 30_000);
  assert.match(f.pages[0], /closure wait exhausted/);
});

test('closure env override is nominal, including overrides longer than an hour', async t => {
  busyHost(t);
  for (const base of [100, 7_200_000]) {
    const f = waitFixture(t, { env: { AMA_CLOSURE_WAIT_BOUND_MS: String(base) } });
    assert.equal((await f.observe({ now: 0 })).boundedMs, base * 6);
    assert.equal((await f.observe({ now: base * 6 - 1 })).exhausted, false);
    assert.equal((await f.observe({ now: base * 6 })).exhausted, true);
  }
});

test('confirmed live launch changes only the notice, preserving debt, receipt and retry', async t => {
  const f = waitFixture(t);
  await f.observe({ now: 0 });
  const reached = await f.observe({ now: CLOSURE_WAIT_BOUND_MS, launchAlive: true });
  assert.equal(reached.exhausted, true);
  assert.equal(reached.startedAt, 0);
  assert.equal(reached.retryAfterMs, 30_000);
  assert.match(f.pages[0], /closure still running after 30 minutes/);
  assert.doesNotMatch(f.pages[0], /exhausted/);
  await f.observe({ now: CLOSURE_WAIT_BOUND_MS + 1, launchAlive: true });
  assert.equal(f.pages.length, 1);
});

test('reason text alone is not liveness evidence and immediate pages still exhaust', async t => {
  for (const immediate of [false, true]) {
    const f = waitFixture(t);
    await f.observe({ now: 0 });
    await f.observe({ now: CLOSURE_WAIT_BOUND_MS, immediate, launchAlive: immediate });
    assert.match(f.pages[0], /closure wait exhausted/);
  }
});

test('background launch uses its already-sized execution boundary exactly once', async t => {
  busyHost(t);
  const f = waitFixture(t, { waitClass: 'final-round' });
  await f.observe({ now: 0 });
  const launchWait = { startedAt: 60_000, boundMs: 5 * 60_000 * 6 };
  assert.equal((await f.observe({ now: 60_000 + launchWait.boundMs - 1, launchWait })).exhausted, false);
  await f.observe({ now: 60_000 + launchWait.boundMs, launchWait, launchAlive: true });
  assert.match(f.pages[0], /still running after 30 minutes/);
});

test('reviewer budgets scale once, including the derived multi-chunk budget', t => {
  busyHost(t);
  assert.equal(resolveReviewerTimeoutMs({}), 20 * 60_000 * 6);
  assert.equal(resolveProgressTimeoutMs({}), 15 * 60_000 * 6);
  assert.equal(resolveAgyPrintTimeoutMs({}), 19 * 60_000 * 6);
  assert.equal(resolveFirstOutputTimeoutMs({}), 0);
  assert.equal(resolveReviewerIdleTimeoutSeconds({}), 600 * 6);
  assert.equal(resolveReviewerCeilingSeconds({ changedLines: 0, env: {} }), 1800 * 6);
  const plan = resolveAgyChunkTimeoutPlan({ chunkCount: 2, env: {} });
  assert.equal(plan.perChunkTimeoutMs, 20 * 60_000 * 6);
  assert.equal(plan.timeoutMs, plan.perChunkTimeoutMs * 2 + 120_000);
  assert.equal(plan.capMs, 6 * 60 * 60_000 * 6);
});

test('closer dispatch, readiness probes, ownerless and pending lease bounds scale', t => {
  busyHost(t);
  assert.equal(__testables__.resolveAmaDispatchTimeoutMs({}), 600_000 * 6);
  assert.equal(__testables__.resolveAmaDispatchTimeoutMs({ dispatchTimeoutMs: 1234 }), 1234 * 6);
  assert.equal(resolveRoutingTierReadinessTimeoutMs({}), 5000 * 6);
  assert.equal(resolveRoutingTierReadinessTimeoutMs({ WATCHER_ROUTING_TIER_READINESS_TIMEOUT_MS: '1000' }), 6000);
  assert.equal(ownerlessBoundMs({}), 15 * 60_000 * 6);
  assert.equal(amaCloserPendingLeaseExpiryMs(120_000), 391_500, 'effective dispatch budget is consumed once');
  const lease = { status: 'pending', watcherPid: 123, acquiredAt: new Date(0).toISOString() };
  assert.equal(isReclaimablePendingAmaCloserLease(lease, {
    now: AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS, processKillImpl() {},
  }), false);
  assert.equal(isReclaimablePendingAmaCloserLease(lease, {
    now: AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS * 6, processKillImpl() {},
  }), true);
});

test('Python GitHub attempt bound shares its parent helper snapshot', t => {
  busyHost(t);
  let checked = false;
  readPipelineGithub('state', 'example/project', 42, {
    env: { GHA_ADAPTER_BIN: '/synthetic/github-adapter/bin/read',
      OAUTH_BROKER_MERGE_AGENT_EXPECTED_APP_ID: '123', OAUTH_BROKER_MERGE_AGENT_EXPECTED_INSTALLATION_ID: '456' },
    execFileSyncImpl: (_command, args, options) => {
      checked = true;
      assert.equal(options.timeout, 20_000 * 6);
      assert.equal(args[args.indexOf('--attempt-timeout-seconds') + 1], '30');
      return JSON.stringify({ state: 'OPEN' });
    },
  });
  assert.equal(checked, true);
});

test('operator launch-status read, GitHub provenance read and worker CPU probe use scaled bounds', async t => {
  busyHost(t);
  const { operatorNoticeInFlight } = await import('../src/ama/operator-notice-route.mjs');
  const { updateAmaCloserDispatchRecord } = await import('../src/ama/dispatch-closer.mjs');
  const { fetchFastMergeHamCommit } = await import('../src/fast-merge-github-io.mjs');
  const { readWorkerCpuPercent } = await import('../src/follow-up-worker-progress.mjs');
  const rootDir = mkdtempSync(join(os.tmpdir(), 'operational-read-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'example/project', prNumber: 42, headSha: 'synthetic-head' };
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
    state: 'dispatched', launchRequestId: 'synthetic-launch' }));
  let statusRead = false;
  assert.equal(await operatorNoticeInFlight(rootDir, identity, {
    readLaunchRequestStatusImpl: async options => {
      statusRead = true;
      assert.equal(options.timeoutMs, 1000 * 6);
      return { ok: true, row: { status: 'running' } };
    },
  }), 'closer-in-flight');
  assert.equal(statusRead, true);
  await fetchFastMergeHamCommit({ repo: identity.repo, headSha: identity.headSha,
    ghClient: { execFileImpl: async (_command, _args, options) => {
      assert.equal(options.timeout, 30_000 * 6);
      return { stdout: '{}' };
    } } });
  let cpuRead = false;
  readWorkerCpuPercent({ remediationWorker: { processId: 123, processGroupId: 123,
    spawnedAt: new Date(0).toISOString() } }, {
    execFileSyncImpl: (_command, _args, options) => {
      cpuRead = true;
      assert.equal(options.timeout, 2000 * 6);
      return '';
    },
  });
  assert.equal(cpuRead, true);
});

test('DAG autowalk dispatch and OSS remediation keep their nominal subprocess bases', async t => {
  busyHost(t);
  const { attemptDagAutowalkOnMerge } = await import('../src/dag-autowalk-on-merge.mjs');
  const { applyOssReadinessRemediation, OSS_READINESS_AUDIT_CHECK_NAME } = await import('../src/remediation-oss-readiness.mjs');
  const rootDir = mkdtempSync(join(os.tmpdir(), 'operational-dispatch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let dispatched = false;
  const result = await attemptDagAutowalkOnMerge({ rootDir,
    record: { repo: 'example/project', prNumber: 42 }, env: {}, logger: {},
    loadConfigImpl: () => ({ get: () => null }),
    execFileImpl: async (_command, _args, options) => {
      dispatched = true;
      assert.equal(options.timeout, 120_000 * 6);
      return { stdout: '{}' };
    },
  });
  assert.equal(dispatched, true);
  assert.equal(result.ok, true);
  let applied = false;
  await assert.rejects(applyOssReadinessRemediation({ rootDir, workspaceDir: rootDir,
    job: { ciFailures: [OSS_READINESS_AUDIT_CHECK_NAME] }, env: {},
    execFileImpl: async (_command, args, options) => {
      if (args[0] === '--apply') {
        applied = true;
        assert.equal(options.timeout, 60_000 * 6);
      }
      throw new Error('synthetic executor refusal');
    },
  }));
  assert.equal(applied, true);
});

test('Argus child scratch initialization sizes its Git subprocess without launching a reviewer', { timeout: 5000 }, async t => {
  busyHost(t);
  const { registerHooks } = await import('node:module');
  const rootDir = mkdtempSync(join(os.tmpdir(), 'operational-child-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/argus-security-review-child.mjs')) {
      const sources = {
        './argus-security-drain.mjs': "export const ARGUS_REVIEW_OUTCOME_PREFIX = 'ARGUS_REVIEW_OUTCOME ';",
        './argus-security-queue.mjs': "export function readArgusJob() { return { jobId: 'synthetic-job' }; }",
        './argus-security-review.mjs': "export async function reviewArgusJob() { return { kind: 'complete' }; }",
        './argus-security-review-deps.mjs': 'export function createDefaultArgusReviewDeps() { return {}; }',
      };
      if (sources[specifier]) return { url: `data:text/javascript,${encodeURIComponent(sources[specifier])}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  } });
  t.after(() => hooks.deregister());
  const argv = process.argv;
  t.after(() => { process.argv = argv; });
  process.argv = ['node', 'synthetic-child', '--root', rootDir, '--job', 'synthetic-job.json'];
  let initialized = false;
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    initialized = true;
    assert.equal(command, 'git');
    assert.deepEqual(args.slice(0, 2), ['init', '-q']);
    assert.equal(options.timeout, 30_000 * 6);
    return { status: 0 };
  });
  syncBuiltinESMExports();
  let outcome;
  t.mock.method(process.stdout, 'write', text => {
    if (String(text).startsWith('ARGUS_REVIEW_OUTCOME ')) outcome = JSON.parse(String(text).slice(21));
    return true;
  });
  await import('../src/argus-security-review-child.mjs?loadar-synthetic-child');
  assert.equal(initialized, true);
  assert.deepEqual(outcome, { kind: 'complete' });
});

test('background queue scales its nominal fallback and preserves a supplied effective budget', async t => {
  busyHost(t);
  const { createAmaHammerBackgroundQueue } = await import('../src/ama-hammer-background-dispatch.mjs');
  const queue = createAmaHammerBackgroundQueue({ logger: {} });
  const fallback = queue.submit({ key: 'example/project#42@synthetic-head', run: async () => ({}) });
  assert.equal(fallback.boundMs, 15 * 60_000 * 6);
  const supplied = queue.submit({ key: 'example/project#43@synthetic-head', timeoutMs: 120_000, run: async () => ({}) });
  assert.equal(supplied.boundMs, 120_000);
  await queue.drain();
});

test('branch lookup and unpublished-work Git probe from the current base also scale', async t => {
  busyHost(t);
  const { readFollowUpPRHead } = await import('../src/follow-up-branch.mjs');
  const { findCommittedUnpublishedWork } = await import('../src/remediation-unpublished.mjs');
  const { fetchPRBranchMetadata } = await import('../src/remediation-git-pr-io.mjs');
  let branchRead = false;
  t.mock.method(childProcess, 'spawnSync', (command, _args, options) => {
    if (command === '/bin/ps') return `${os.cpus().length * 100}\n`;
    assert.equal(command, 'gh');
    branchRead = true;
    assert.equal(options.timeout, 8000 * 6);
    return { status: 0, stderr: '', stdout: JSON.stringify({ head: { ref: 'synthetic-feature' }, title: '[codex] synthetic change' }) };
  });
  syncBuiltinESMExports();
  assert.equal(readFollowUpPRHead({ repo: 'example/project', prNumber: 42 }).branch, 'synthetic-feature');
  assert.equal(branchRead, true);
  const metadata = await fetchPRBranchMetadata({ repo: 'example/project', prNumber: 42, env: {},
    execFileImpl: async (_command, _args, options) => {
      assert.equal(options.timeout, 8000 * 6);
      return { stdout: JSON.stringify({ base: { ref: 'main' }, head: { ref: 'synthetic-feature' } }) };
    },
  });
  assert.equal(metadata.branch, 'synthetic-feature');
  const commitSha = 'a'.repeat(40);
  const debt = await findCommittedUnpublishedWork({ reply: { summary: 'could not publish the commit' },
    job: { jobId: 'synthetic-job', revisionRef: 'b'.repeat(40) }, workspaceDir: 'synthetic-workspace',
    execFileImpl: async (_command, _args, options) => {
      assert.equal(options.timeout, 5000 * 6);
      return { stdout: commitSha };
    },
  });
  assert.equal(debt.commitSha, commitSha);
});

test('merge lease fairness retains load-scaled holders and closer waits with fixed daemon reservations', t => {
  busyHost(t);
  const rootDir = mkdtempSync(join(os.tmpdir(), 'lease-fair-load-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const request = { rootDir, repo: 'owner/name', base: 'main', holderPr: 101,
    holderHead: 'holder-head', holderPid: process.pid, holderHost: os.hostname(),
    deadlineSeconds: 90, now: '2026-06-20T18:00:00Z' };
  const holder = acquireMergeLease(request);
  assert.equal(holder.acquired, true);
  assert.equal(holder.lease.deadlineSeconds, 540);
  const closer = acquireMergeLease({ ...request, holderPr: 102, registerWaiter: true });
  assert.equal(closer.acquired, false);
  assert.equal(closer.waiter.deadlineSeconds, 540);
  const daemon = acquireDaemonMergeLease({ ...request, holderPr: 103 });
  assert.equal(daemon.acquired, false);
  assert.equal(daemon.waiter.deadlineSeconds, 3600, 'twice the 300s poll, scaled once at 6x load');
  assert.equal(daemon.queuePosition, 1);
  assert.equal(releaseMergeLease({ rootDir, ...holder.lease }).released, true);
  const resumed = acquireDaemonMergeLease({ ...request, holderPr: 103 });
  assert.equal(resumed.acquired, true);
  assert.equal(resumed.lease.deadlineSeconds, 540);
});

test('explicit daemon waiter deadlines scale once while effective deadlines stay fixed', t => {
  busyHost(t);
  const rootDir = mkdtempSync(join(os.tmpdir(), 'daemon-deadline-load-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const request = { rootDir, repo: 'owner/name', base: 'main', pr: 101,
    head: 'daemon-head', holderPid: process.pid, priority: 'daemon', waiterId: 'daemon' };
  assert.equal(upsertMergeLeaseWaiter({ ...request, deadlineSeconds: 90 }).waiter.deadlineSeconds, 540);
  assert.equal(upsertMergeLeaseWaiter({ ...request, deadlineSeconds: 90,
    effectiveDeadlineSeconds: 180 }).waiter.deadlineSeconds, 180);
});
