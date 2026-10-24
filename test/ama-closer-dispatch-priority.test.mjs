import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import {
  maybeDispatchAmaCloser,
  amaCloserDispatchFilePath,
  readAmaCloserDispatchRecord,
  reconcileAmaCloserLease,
  resolveAmaCloserDispatchPriority,
  updateAmaCloserDispatchRecord,
} from '../src/ama/dispatch-closer.mjs';
import { resolveMergeAgentCoexistenceForWatcher } from '../src/ama-closure-orchestration.mjs';
import { observeCloserBacklog } from '../src/ama/closure-lag.mjs';
import { AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS, acquireAmaCloserLease, readAmaCloserLease, rekeyAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { resolveCloserDispatchHarness } from '../src/ama/harness-fallback.mjs';
import { codexAccountFixture } from './helpers/codex-account-fixture.mjs';
import { readAmaAuditEntry, appendAmaAuditAttempt } from '../src/ama/audit.mjs';
import { readLaunchRequestSnapshotFromLedgerAsync } from '../src/session-ledger-read-adapter.mjs';
import {
  findMalformedProtectivePredecessorLines,
  hasMergedDependentProtectingPr,
  normalizeProtectivePredecessorDeclaration,
  parseProtectivePredecessorDeclaration,
} from '../src/ama/protective-predecessor.mjs';

// LCR — AMA closer dispatch admission-priority routing.
//
// The reserved critical admission lane (cwp_dispatch `admission.priority_lane`)
// grants a load-cap BYPASS to `critical` rows only, so a clean pipeline-critical
// merge is not stalled by the dynamic CPU-load dispatch cap. These tests pin the
// routing predicate the closer uses when it builds `hq dispatch --priority`:
//
//   - a no-terminal-remediation validate-gate-and-click / mechanical-gate close
//     resolves to `critical` (lane-eligible);
//   - a terminal-remediation hammer (post-exhaustion blocking/non-blocking
//     findings, forced red CI, or mergeability repair) stays `normal` unless a
//     merged dependent names this PR as its protector, which promotes the safety
//     window to the reserved lane;
//   - the `--priority` flag actually carries the resolved value on the dispatch;
//   - an older/forked `hq` without `--priority` degrades cleanly (retry once
//     without the flag) instead of failing the dispatch.
//
// A fully-clean, eligible, green, mergeable PR never reaches this dispatch
// surface — the daemon clean-route closes it inline (`daemon-clean-route`) — so
// every dispatch here is either a terminal remediation (normal) or a
// no-terminal-remediation mechanical-gate repair (critical). This is admission
// routing ONLY: priority never changes merge eligibility.

const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';
const HEAD = 'a'.repeat(40);
const REQUIRED_GATE = 'agent-os/adversarial-gate';

function testDeps() {
  const calls = [];
  return {
    calls,
    deliverAlertImpl: async () => {},
    readPullRequestStateImpl: () => null,
    processExecFileImpl: async () => ({ stdout: 'Thu Oct 22 10:18:18 2026\n' }),
    execFileImpl: async (cmd, args, options = {}) => {
      calls.push({ cmd, args, options });
      return { stdout: JSON.stringify({ ticketRef: `AMA-PR-${args[args.indexOf('--pr') + 1]}`, dispatchId: 'lrq_hammer_1', launchRequestId: 'lrq_hammer_1' }), stderr: '' };
    },
    readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    logger: { log() {}, info() {}, warn() {}, error() {} },
  };
}

function baseArgs(rootDir, overrides = {}) {
  return {
    reviewState: {
      verdict: 'request changes',
      headSha: HEAD,
      riskClass: 'low',
      remediationPending: false,
      blockingFindingState: 'known',
      blockingFindingCount: 1,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      operatorApprovedEvidence: null,
      prAuthor: 'builder',
      ...overrides.reviewState,
    },
    prMetadata: {
      prNumber: 404,
      headSha: HEAD,
      isOpen: true,
      isDraft: false,
      mergeableState: 'MERGEABLE',
      labels: [],
      statusCheckRollup: [
        { __typename: 'CheckRun', name: REQUIRED_GATE, conclusion: 'SUCCESS' },
      ],
      branchProtection: { requiredContexts: [REQUIRED_GATE] },
      author: 'builder',
      ...overrides.prMetadata,
    },
    cfg: {
      enabled: true,
      workerClass: 'hammer',
      mergeMethod: 'squash',
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false },
      branchProtection: { required: true },
      ...overrides.cfg,
    },
    options: { env: { ADV_GATE_STATUS_CONTEXT: REQUIRED_GATE } },
    dispatchContext: {
      rootDir,
      repo: 'acme/repo',
      prUrl: 'https://github.com/acme/repo/pull/404',
      reviewedSha: HEAD,
      riskClass: 'low',
      requiredGateContext: REQUIRED_GATE,
      reviewedBy: 'codex-reviewer-lacey',
      reviewer: 'codex',
      parentSession: 'session:test:watcher',
      hqPath: '/bin/hq-test',
      hqRoot: join(rootDir, 'hq-root'),
      hqOwnerUser: CURRENT_USER,
      currentUser: CURRENT_USER,
      closerTokenRollupPollDelaysMs: [],
      dispatchedAt: '2026-07-20T12:00:00Z',
      livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefName: 'codex/live' }),
      ...overrides.dispatchContext,
    },
  };
}

// An exhausted review cycle WITH blocking findings — the hammer is dispatched to
// terminal-remediate them in code as the final rescue lane.
function findingsRemediationArgs(rootDir, overrides = {}) {
  return baseArgs(rootDir, {
    reviewState: {
      reviewCycleExhausted: true,
      ...overrides.reviewState,
    },
    ...overrides,
  });
}

// A CLEAN review (zero findings) that still reaches the closer dispatch surface
// because a required check is still pending. This is a no-terminal-remediation
// mechanical validate-gate-and-click close, so it rides the reserved critical
// lane.
function cleanValidateAndClickArgs(rootDir, overrides = {}) {
  return baseArgs(rootDir, {
    reviewState: {
      verdict: 'comment-only',
      blockingFindingState: 'known',
      blockingFindingCount: 0,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      ...overrides.reviewState,
    },
    prMetadata: {
      statusCheckRollup: [
        { __typename: 'CheckRun', name: REQUIRED_GATE, conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'ci/test', status: 'IN_PROGRESS' },
      ],
      branchProtection: { requiredContexts: [REQUIRED_GATE, 'ci/test'] },
      ...overrides.prMetadata,
    },
    ...overrides,
  });
}

function flagValue(args, flag) {
  const idx = args.indexOf(flag);
  return idx === -1 ? undefined : args[idx + 1];
}

test('LRQSTATUS-01: the secondary launch probe persists a newly parked status', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-secondary-park-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = findingsRemediationArgs(rootDir), deps = testDeps();
  const identity = { repo: args.dispatchContext.repo, prNumber: 404, headSha: HEAD };
  // No stored ownership status or dispatched lease: only the secondary probe
  // can discover that this receipt is now parked.
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
    state: 'dispatched', launchRequestId: 'secondary-park', workerClass: 'hammer',
    dispatchedAt: args.dispatchContext.dispatchedAt }));
  const result = await maybeDispatchAmaCloser({ ...args, ...deps,
    readLaunchRequestStatusImpl: async () => ({ ok: true, row: { status: 'waiting_input' } }),
  });
  assert.equal(result.reason, 'dispatch-status-waiting-input');
  assert.equal(result.skipMergeAgent, true);
  assert.equal(JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity))).lastObservedStatus, 'waiting_input');
  assert.equal(deps.calls.length, 0);
});

for (const account of ['personal', 'corporate', 'pinned-personal']) test(`LANEFAILOVER-01: AMA dispatch uses and logs ${account}`, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'codex-ama-dispatch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const env = { AGENT_OS_CONFIG_PATH: '/dev/null' };
  if (account === 'pinned-personal') {
    env.AGENT_OS_CONFIG_PATH = join(rootDir, 'config.yaml');
    writeFileSync(env.AGENT_OS_CONFIG_PATH, 'version: 1\nroles:\n  adversarial:\n    merge_authority:\n      worker_class: hammer\n');
  }
  const deps = testDeps(); const logs = []; const resolutions = [];
  const snapshot = codexAccountFixture({ corp: account === 'personal' ? 'exhausted' : 'ok' });
  const result = await maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, { dispatchContext: {
      repo: 'sample/project', prUrl: 'https://github.com/sample/project/pull/404', reviewedBy: 'synthetic-reviewer',
    } }),
    ...deps,
    env,
    resolveCloserDispatchHarnessImpl: args => {
      resolutions.push(args);
      return resolveCloserDispatchHarness(args);
    },
    execFileImpl: async (command, args, options) => args[0] === 'fleet'
      ? { stdout: JSON.stringify(snapshot) } : deps.execFileImpl(command, args, options),
    logger: { ...deps.logger, info: line => logs.push(line) },
  });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].env, env);
  assert.equal(resolutions[0].codexAccountPolicy, account === 'pinned-personal' ? 'pinned' : 'corporate-first');
  const dispatch = deps.calls.find(call => call.args[0] === 'dispatch');
  assert.equal(flagValue(dispatch.args, '--worker-class'), account === 'corporate' ? 'hammer-corp' : 'hammer');
  const choices = logs.filter(line => line.includes('codex_account='));
  assert.equal(choices.length, 1);
  assert.match(choices[0], new RegExp(`codex_account=${account === 'pinned-personal' ? 'personal' : account} .*reason=`));
});

test('LCR: findings-remediation hammer dispatches with --priority normal', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-priority-remediation-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({ ...findingsRemediationArgs(rootDir), ...deps });

  assert.equal(result.dispatched, true, 'a findings hammer must dispatch');
  assert.equal(deps.calls.length, 1);
  const args = deps.calls[0].args;
  assert.equal(flagValue(args, '--completion-shape'), 'decision-only');
  assert.equal(flagValue(args, '--required-outcome'), 'terminal-audit');
  assert.equal(flagValue(args, '--task-kind'), 'merge');
  assert.equal(
    flagValue(args, '--priority'),
    'normal',
    'findings-remediation hammer must NOT take the reserved critical lane',
  );
});

test('LCR: hq dispatch caps worker provision watchdog at the AMA dispatch timeout', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-provision-timeout-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const previousProvisionTimeout = process.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS;
  const previousProvisionSubprocessTimeout = process.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS;
  delete process.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS;
  delete process.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS;
  t.after(() => {
    if (previousProvisionTimeout === undefined) {
      delete process.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS;
    } else {
      process.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS = previousProvisionTimeout;
    }
    if (previousProvisionSubprocessTimeout === undefined) {
      delete process.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS;
    } else {
      process.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS = previousProvisionSubprocessTimeout;
    }
  });
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, { cfg: { dispatchTimeoutMs: 240_000 } }),
    ...deps,
  });

  assert.equal(result.dispatched, true);
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].options.timeout, 240_000);
  assert.equal(deps.calls[0].options.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS, '150');
  assert.equal(deps.calls[0].options.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS, '195');
});

test('LCR: hq dispatch preserves an already stricter worker provision timeout', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-provision-timeout-strict-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const previousProvisionTimeout = process.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS;
  const previousProvisionSubprocessTimeout = process.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS;
  process.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS = '45';
  process.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS = '30';
  t.after(() => {
    if (previousProvisionTimeout === undefined) {
      delete process.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS;
    } else {
      process.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS = previousProvisionTimeout;
    }
    if (previousProvisionSubprocessTimeout === undefined) {
      delete process.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS;
    } else {
      process.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS = previousProvisionSubprocessTimeout;
    }
  });
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, { cfg: { dispatchTimeoutMs: 240_000 } }),
    ...deps,
  });

  assert.equal(result.dispatched, true);
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].options.timeout, 240_000);
  assert.equal(deps.calls[0].options.env.HQ_WORKER_PROVISION_TIMEOUT_SECONDS, '45');
  assert.equal(deps.calls[0].options.env.HQ_PROVISION_SUBPROCESS_TIMEOUT_SECONDS, '30');
});

test('CLOSERGATE-01: legacy keyless dispatching records never defer another PR at capacity', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-active-launch-defers-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  for (const prNumber of [997, 998, 999]) {
    updateAmaCloserDispatchRecord(rootDir, {
      repo: 'acme/repo', prNumber, headSha: 'b'.repeat(40),
    }, () => ({
    schemaVersion: 1,
    repo: 'acme/repo',
    prNumber,
    headSha: 'b'.repeat(40),
    state: 'dispatching',
    lastAttemptedAt: '2026-07-20T12:00:00Z',
    dispatchedAt: null,
    dispatchId: null,
    launchRequestId: null,
    lastError: null,
    dispatchTimeoutMs: 300_000,
    }));
    acquireAmaCloserLease({ rootDir, repo: 'acme/repo', prNumber,
      headSha: 'b'.repeat(40), watcherPid: process.pid, now: '2026-07-20T12:00:00Z' });
  }
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, {
      cfg: { amaCloserConcurrentLaunchCeiling: 3 },
      dispatchContext: {
        dispatchedAt: '2026-07-20T12:04:00Z',
      },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(result.activeLaunch, undefined);
  assert.equal(deps.calls.length, 1);
});

for (const kind of ['legacy-stale', 'orphan', 'unknown', 'held', 'inspection-required']) {
  test(`CLOSERGATE-01: ${kind} intents for other PRs do not consume launch capacity`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'closergate-other-pr-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const args = findingsRemediationArgs(rootDir, {
      cfg: { amaCloserMaxConcurrentLaunches: 1, amaCloserConcurrentLaunchCeiling: 1 },
    });
    const other = { repo: 'fixture/other', prNumber: 99, headSha: 'b'.repeat(40) };
    updateAmaCloserDispatchRecord(rootDir, other, () => ({ ...other, state: 'dispatching',
      dispatchIdempotencyKey: kind === 'legacy-stale' ? null : 'synthetic-intent-key',
      lastAttemptedAt: kind === 'legacy-stale' ? '2026-01-01T00:00:00Z' : args.dispatchContext.dispatchedAt,
      preReceiptReconciliation: { status: kind, reason: 'synthetic-unresolved' } }));
    const deps = testDeps();
    const events = [];
    const result = await maybeDispatchAmaCloser({ ...args, ...deps,
      readIntentReceiptImpl: () => assert.fail('another PR must not trigger intent lookup'),
      logger: { ...deps.logger, info: line => events.push(JSON.parse(line)) } });
    assert.equal(result.dispatched, true, JSON.stringify(result));
    assert.equal(result.activeLaunch, undefined);
    assert.equal(events.find(event => event.event === 'ama.closer_queue_depth').liveLaunches, 0);
    assert.equal(deps.calls.length, 1);
  });
}

for (const keyed of [false, true]) {
  test(`CLOSERGATE-01: inspection holds only its own PR/head (keyed=${keyed})`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'closergate-own-head-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const args = findingsRemediationArgs(rootDir);
    const own = { repo: args.dispatchContext.repo, prNumber: 404, headSha: HEAD };
    updateAmaCloserDispatchRecord(rootDir, own, () => ({ ...own, state: 'dispatching',
      dispatchIdempotencyKey: keyed ? 'synthetic-own-intent' : null,
      lastAttemptedAt: '2026-01-01T00:00:00Z', dispatchTimeoutMs: 600_000,
      preReceiptReconciliation: { status: 'inspection-required', reason: 'submission-absence-unproven' } }));
    const deps = testDeps();
    let pages = 0;
    const result = await maybeDispatchAmaCloser({ ...args, ...deps,
      deliverAlertImpl: async () => { pages++; },
      readIntentReceiptImpl: () => ({ ok: false }) });
    assert.equal(result.reason, 'existing-dispatch-unknown');
    assert.equal(result.activeLaunch.headSha, HEAD);
    assert.equal(deps.calls.length, 0);
    assert.equal(pages, 1);
    const next = await maybeDispatchAmaCloser({ ...args, ...deps,
      prMetadata: { ...args.prMetadata, headSha: 'c'.repeat(40) },
      reviewState: { ...args.reviewState, headSha: 'c'.repeat(40) },
      dispatchContext: { ...args.dispatchContext, reviewedSha: 'c'.repeat(40) },
      deliverAlertImpl: () => assert.fail('old head must not page'),
      readIntentReceiptImpl: () => assert.fail('old head must not be reconciled') });
    assert.equal(next.dispatched, true, JSON.stringify(next));
  });
}

for (const state of ['CLOSED', 'MERGED']) {
  test(`CLOSERGATE-01: authoritative ${state} metadata bypasses intent holds`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'closergate-terminal-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const args = findingsRemediationArgs(rootDir);
    const own = { repo: args.dispatchContext.repo, prNumber: 404, headSha: HEAD };
    updateAmaCloserDispatchRecord(rootDir, own, () => ({ ...own, state: 'dispatching',
      dispatchIdempotencyKey: 'synthetic-terminal', lastAttemptedAt: args.dispatchContext.dispatchedAt }));
    const result = await maybeDispatchAmaCloser({ ...args, ...testDeps(),
      prMetadata: { ...args.prMetadata, isOpen: false, state },
      readIntentReceiptImpl: () => assert.fail('terminal PR must not look up receipts'),
      execFileImpl: () => assert.fail('terminal PR must not launch') });
    assert.equal(result.reason, 'pr-not-mergeable');
    assert.equal(result.inFlight, undefined);
    assert.equal(result.activeLaunch, undefined);
  });
}

for (const unreadable of [false, true]) {
  test(`HAMRETRY-01: production dispatch shares one PostgreSQL capacity snapshot (unreadable=${unreadable})`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'hammer-production-capacity-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const args = findingsRemediationArgs(rootDir, {
      cfg: { amaCloserMaxConcurrentLaunches: 3, amaCloserConcurrentLaunchCeiling: 3 },
      dispatchContext: { ledgerTarget: { backend: 'postgres', databaseName: 'synthetic_ledger' } },
    });
    const rows = [997, 998, 999].map(prNumber => {
      const identity = { repo: 'acme/repo', prNumber, headSha: 'b'.repeat(40) };
      updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
        state: 'dispatched', launchRequestId: `lrq_${prNumber}`, lastObservedStatus: 'starting',
        lastAttemptedAt: args.dispatchContext.dispatchedAt }));
      return { launch_request_id: `lrq_${prNumber}`, status: 'succeeded' };
    });
    let queries = 0;
    const deps = testDeps();
    const events = [];
    // Keep the production default status reader and its retry wrapper. Stub
    // only the snapshot's subprocess boundary; no live database is contacted.
    const result = await maybeDispatchAmaCloser({ ...args, ...deps,
      logger: { ...deps.logger, info: line => events.push(JSON.parse(line)) },
      readLaunchRequestSnapshotImpl: input => readLaunchRequestSnapshotFromLedgerAsync({ ...input,
        spawnSyncImpl: (command, _argv, opts) => {
          queries++;
          assert.equal(command, 'psql');
          assert.match(opts.input, /BEGIN READ ONLY;/);
          return unreadable ? { status: 1, stderr: 'synthetic ledger outage' }
            : { status: 0, stdout: rows.map(row => JSON.stringify(row)).join('\n') };
        },
      }),
    });
    assert.equal(queries, 1, 'the wrapped production reader must share a single snapshot');
    const depth = events.find(event => event.event === 'ama.closer_queue_depth');
    assert.equal(depth.liveLaunches, unreadable ? 3 : 0);
    assert.equal(result.dispatched, !unreadable, JSON.stringify(result));
    if (unreadable) assert.equal(result.reason, 'ama-closer-launch-in-progress');
    assert.equal(deps.calls.length, unreadable ? 0 : 1);
  });
}

test('HAMRETRY-01: wrapped per-launch readers fail closed at fleet cap on unreadable evidence', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-unreadable-capacity-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = findingsRemediationArgs(rootDir, {
    cfg: { amaCloserMaxConcurrentLaunches: 3, amaCloserConcurrentLaunchCeiling: 3 },
  });
  for (const prNumber of [997, 998, 999]) {
    const identity = { repo: 'acme/repo', prNumber, headSha: 'b'.repeat(40) };
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
      state: 'dispatched', launchRequestId: `lrq_${prNumber}`, lastObservedStatus: 'starting',
      lastAttemptedAt: args.dispatchContext.dispatchedAt }));
  }
  let probes = 0;
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({ ...args, ...deps,
    readLaunchRequestStatusImpl: () => { probes++; return { ok: false, reason: 'query-failed' }; },
  });
  assert.equal(probes, 1, 'the first unreadable result stops per-launch probes');
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'ama-closer-launch-in-progress');
  assert.equal(deps.calls.length, 0);
});

test('CLOSERGATE-01: an unresolved prior-head intent does not hold the current head', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-same-pr-prior-head-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const oldHead = 'b'.repeat(40);
  updateAmaCloserDispatchRecord(rootDir, { repo: 'acme/repo', prNumber: 404, headSha: oldHead }, () => ({
    repo: 'acme/repo', prNumber: 404, headSha: oldHead,
    state: 'dispatching', lastAttemptedAt: '2026-07-20T12:00:00Z',
    launchRequestId: null, lastError: null, dispatchTimeoutMs: 300_000,
  }));
  acquireAmaCloserLease({ rootDir, repo: 'acme/repo', prNumber: 404,
    headSha: oldHead, watcherPid: process.pid, now: '2026-07-20T12:00:00Z' });
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, { dispatchContext: { dispatchedAt: '2026-07-20T12:01:00Z' } }),
    ...deps,
  });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(result.activeLaunch, undefined);
  assert.equal(deps.calls.length, 1);
});

test('LCR: a dispatched worker on a prior head holds its PR', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-same-pr-worker-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const oldHead = 'b'.repeat(40);
  updateAmaCloserDispatchRecord(rootDir, { repo: 'acme/repo', prNumber: 404, headSha: oldHead }, () => ({
    repo: 'acme/repo', prNumber: 404, headSha: oldHead,
    state: 'dispatched', lastAttemptedAt: '2026-07-20T12:00:00Z',
    launchRequestId: 'lrq_old', lastObservedStatus: 'running', lastError: null,
  }));
  acquireAmaCloserLease({ rootDir, repo: 'acme/repo', prNumber: 404,
    headSha: oldHead, watcherPid: process.pid, now: '2026-07-20T12:00:00Z' });
  updateAmaCloserLease({ rootDir, repo: 'acme/repo', prNumber: 404, headSha: oldHead,
    status: 'dispatched', lrqId: 'lrq_old', now: '2026-07-20T12:00:00Z' });
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, { dispatchContext: { dispatchedAt: '2026-07-20T12:01:00Z' } }),
    ...deps,
  });
  assert.equal(result.reason, 'ama-closer-launch-in-progress');
  assert.equal(result.activeLaunch.headSha, oldHead);
  assert.equal(deps.calls.length, 0);
});

test('LCR: blocked record cannot consume another PR launch slot', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-blocked-launch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  updateAmaCloserDispatchRecord(rootDir, { repo: 'acme/repo', prNumber: 999, headSha: 'b'.repeat(40) }, () => ({
    repo: 'acme/repo', prNumber: 999, headSha: 'b'.repeat(40), state: 'dispatch-blocked-branch-holder',
    lastAttemptedAt: '2026-07-20T12:00:00Z', launchRequestId: null,
    lastError: 'ProvisionError: branch holder',
  }));
  acquireAmaCloserLease({ rootDir, repo: 'acme/repo', prNumber: 999,
    headSha: 'b'.repeat(40), watcherPid: process.pid, now: '2026-07-20T12:00:00Z' });
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, { dispatchContext: { dispatchedAt: '2026-07-20T12:01:00Z' } }),
    ...deps,
  });
  assert.equal(result.dispatched, true);
  assert.equal(deps.calls.length, 1);
  assert.ok(readAmaCloserLease(rootDir, { repo: 'acme/repo', prNumber: 999,
    headSha: 'b'.repeat(40) }), 'another PR admission must leave the blocked holder lease intact');
});

test('AMASCALE: observed backlog holds at the floor, then scales below the ceiling', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-three-accepted-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  for (const prNumber of [997, 998, 999]) {
    const identity = { repo: 'acme/repo', prNumber, headSha: 'b'.repeat(40) };
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
      state: 'dispatched', launchRequestId: `lrq_${prNumber}`, lastObservedStatus: 'running',
      lastAttemptedAt: '2026-07-20T12:00:00Z', lastObservedAt: '2026-07-20T12:00:00Z',
    }));
    acquireAmaCloserLease({ rootDir, ...identity, watcherPid: process.pid, now: '2026-07-20T12:00:00Z' });
    updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: `lrq_${prNumber}`,
      now: '2026-07-20T12:00:00Z' });
  }
  const deps = testDeps();
  const events = [];
  const args = {
    ...findingsRemediationArgs(rootDir, { cfg: { amaCloserConcurrentLaunchCeiling: 32 }, dispatchContext: { dispatchedAt: '2026-07-20T12:01:00Z' } }),
    ...deps,
    logger: { ...deps.logger, info: (text) => events.push(JSON.parse(text)) },
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'running' } }),
  };
  const result = await maybeDispatchAmaCloser(args);
  assert.equal(result.reason, 'ama-closer-launch-in-progress');
  assert.equal(deps.calls.length, 0);
  assert.deepEqual(events.find(({ event }) => event === 'ama.closer_queue_depth'), {
    event: 'ama.closer_queue_depth', eligibleBacklog: 1, liveLaunches: 3, effectiveCap: 3,
  });

  // Current eligible observations, rather than the active count plus one,
  // increase the dispatch limit. Reobserving this candidate does not double-count it.
  for (const prNumber of [997, 998, 999]) {
    await observeCloserBacklog({ rootDir, repo: 'acme/repo', prNumber });
  }
  assert.equal((await maybeDispatchAmaCloser(args)).dispatched, true);
  assert.equal(deps.calls.length, 1);
  assert.deepEqual(events.filter(({ event }) => event === 'ama.closer_queue_depth').at(-1), {
    event: 'ama.closer_queue_depth', eligibleBacklog: 4, liveLaunches: 3, effectiveCap: 4,
  });
});

test('LCR: dead no-LRQ AMA launch lease does not globally hold hammer dispatch', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-dead-active-launch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  updateAmaCloserDispatchRecord(rootDir, {
    repo: 'acme/repo',
    prNumber: 999,
    headSha: 'c'.repeat(40),
  }, () => ({
    schemaVersion: 1,
    repo: 'acme/repo',
    prNumber: 999,
    headSha: 'c'.repeat(40),
    state: 'dispatching',
    lastAttemptedAt: '2026-07-20T12:00:00Z',
    dispatchedAt: null,
    dispatchId: null,
    launchRequestId: null,
    lastError: null,
    dispatchTimeoutMs: 600_000,
  }));
  acquireAmaCloserLease({
    rootDir,
    repo: 'acme/repo',
    prNumber: 999,
    headSha: 'c'.repeat(40),
    watcherPid: 999999,
    now: '2026-07-20T12:00:00Z',
  });
  const deps = testDeps();
  const gone = new Error('pid is gone');
  gone.code = 'ESRCH';

  const result = await maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, {
      dispatchContext: {
        dispatchedAt: '2026-07-20T12:20:00Z',
      },
    }),
    ...deps,
    processKillImpl: () => {
      throw gone;
    },
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.launchRequestId, 'lrq_hammer_1');
  assert.equal(deps.calls.length, 1, 'dead no-LRQ launches must not block later PRs');
  assert.ok(readAmaCloserLease(rootDir, { repo: 'acme/repo', prNumber: 999,
    headSha: 'c'.repeat(40) }), 'another PR admission must not delete this lease');
});

test('LCR: non-exhausted request-changes findings do not dispatch hammer before Codex remediation', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-request-changes-codex-first-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({ ...baseArgs(rootDir), ...deps });

  assert.equal(result.dispatched, false, 'hammer must not answer first on a request-changes findings head');
  assert.equal(result.reason, 'not-eligible');
  assert.ok(result.reasons.includes('blocking-findings-present'), JSON.stringify(result.reasons));
  assert.ok(result.reasons.includes('verdict-not-settled-success'), JSON.stringify(result.reasons));
  assert.equal(deps.calls.length, 0, 'no hq hammer dispatch');
});

for (const [name, reviewState] of [
  ['fresh request-changes', {}],
  ['pending follow-up even at exhaustion', { remediationPending: true, reviewCycleExhausted: true, completedRemediationRounds: 2 }],
  ['unknown follow-up state', { remediationPending: undefined }],
  ['rereview-only exhaustion', { blockingFindingState: 'unknown', reviewCycleExhausted: true, completedRemediationRounds: 0, completedRereviewRounds: 3 }],
  ['fresh comment-only before grace', { verdict: 'comment-only', blockingFindingCount: 0, nonBlockingFindingCount: 1 }],
]) {
  test(`recovery flag preserves ordinary hammer gates: ${name}`, async (t) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'recovery-codex-first-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const deps = testDeps();
    const result = await maybeDispatchAmaCloser({
      ...baseArgs(rootDir, { reviewState, dispatchContext: { automatedRecovery: true, settledCommentOnlyTerminalMs: 0 } }),
      ...deps,
    });
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, 'not-eligible');
    assert.equal(result.recoveryWait, name === 'fresh comment-only before grace' ? 'comment-only-grace' : undefined);
    assert.equal(deps.calls.length, 0, 'recovery must not launch a competing hammer');
  });
}

test('recovery preserves strict comment-only dispatch after grace and exhausted follow-up handoff', async (t) => {
  for (const [reviewState, dispatchContext] of [
    [{ verdict: 'comment-only', blockingFindingCount: 0, nonBlockingFindingCount: 1 },
      { settledCommentOnlyTerminalMs: 60_000, commentOnlyTerminalGraceMs: 60_000 }],
    [{ reviewCycleExhausted: true, completedRemediationRounds: 2 }, {}],
  ]) {
    const rootDir = mkdtempSync(join(tmpdir(), 'recovery-terminal-handoff-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const deps = testDeps();
    const result = await maybeDispatchAmaCloser({
      ...baseArgs(rootDir, { reviewState,
        dispatchContext: { ...dispatchContext, automatedRecovery: true } }),
      ...deps,
    });
    assert.equal(result.dispatched, true);
    assert.equal(deps.calls.length, 1);
    assert.equal(flagValue(deps.calls[0].args, '--priority'), 'normal');
  }
});

test('recovery preserves mechanical pending-CI validate-and-click routing', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'recovery-mechanical-ci-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({
    ...cleanValidateAndClickArgs(rootDir, { dispatchContext: { automatedRecovery: true } }),
    ...deps,
  });
  assert.equal(result.dispatched, true);
  assert.equal(deps.calls.length, 1);
  assert.equal(flagValue(deps.calls[0].args, '--priority'), 'critical', 'pending CI must retain its mechanical prompt');
});

test('LCR: rereview-only exhaustion does not dispatch hammer before Codex remediation', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-rereview-only-codex-first-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({
    ...baseArgs(rootDir, {
      reviewState: {
        verdict: 'request changes',
        remediationPending: false,
        blockingFindingState: 'unknown',
        blockingFindingCount: 0,
        nonBlockingFindingState: 'known',
        nonBlockingFindingCount: 0,
        reviewCycleExhausted: true,
        completedRemediationRounds: 0,
        completedRereviewRounds: 3,
      },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, false, 'rereview-only exhaustion must not mint a terminal hammer');
  assert.equal(result.reason, 'not-eligible');
  assert.ok(result.reasons.includes('blocking-findings-unknown'), JSON.stringify(result.reasons));
  assert.ok(result.reasons.includes('verdict-not-settled-success'), JSON.stringify(result.reasons));
  assert.equal(deps.calls.length, 0, 'no hq hammer dispatch');
});

test('LCR: comment-only exhaustion can dispatch terminal hammer without a remediation round', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-comment-only-exhaustion-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({
    ...baseArgs(rootDir, {
      reviewState: {
        verdict: 'comment-only',
        blockingFindingState: 'known',
        blockingFindingCount: 0,
        nonBlockingFindingState: 'known',
        nonBlockingFindingCount: 1,
        reviewCycleExhausted: true,
        completedRemediationRounds: 0,
        completedRereviewRounds: 2,
      },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, true, 'comment-only cycles do not spawn Codex remediators');
  assert.equal(deps.calls.length, 1, 'terminal hammer remains available after rereview budget exhaustion');
});

test('LCR: clean mechanical-gate closer dispatches with --priority critical', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-priority-clean-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({ ...cleanValidateAndClickArgs(rootDir), ...deps });

  assert.equal(result.dispatched, true, 'a clean mechanical-gate close reaching the dispatch surface must dispatch');
  assert.equal(deps.calls.length, 1);
  const args = deps.calls[0].args;
  assert.equal(flagValue(args, '--completion-shape'), 'decision-only');
  assert.equal(flagValue(args, '--required-outcome'), 'terminal-audit');
  assert.equal(flagValue(args, '--task-kind'), 'merge');
  assert.equal(
    flagValue(args, '--priority'),
    'critical',
    'clean mechanical-gate closer must take the reserved critical lane',
  );
});

test('LCR: forced terminal-remediation prompt dispatches with --priority normal even with a clean verdict', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-priority-forced-terminal-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  const result = await maybeDispatchAmaCloser({
    ...cleanValidateAndClickArgs(rootDir, {
      prMetadata: {
        statusCheckRollup: [
          { __typename: 'CheckRun', name: REQUIRED_GATE, conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'ci/test', conclusion: 'FAILURE' },
        ],
        branchProtection: { requiredContexts: [REQUIRED_GATE, 'ci/test'] },
      },
    }),
    ...deps,
  });

  assert.equal(result.dispatched, true, 'a clean verdict with red required CI should auto-hammer');
  assert.equal(deps.calls.length, 1);
  const args = deps.calls[0].args;
  assert.equal(flagValue(args, '--completion-shape'), 'decision-only');
  assert.equal(flagValue(args, '--required-outcome'), 'terminal-audit');
  assert.equal(flagValue(args, '--task-kind'), 'merge');
  assert.equal(
    flagValue(args, '--priority'),
    'normal',
    'forced terminal-remediation prompt must not take the reserved critical lane',
  );
});

test('LCR: auto-hammer log gate keys on PR metadata repo before dispatch context fallback', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-auto-hammer-gate-key-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  const gateNotes = [];

  const result = await maybeDispatchAmaCloser({
    ...cleanValidateAndClickArgs(rootDir, {
      prMetadata: {
        repoPath: 'acme/pr-metadata-repo',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: REQUIRED_GATE, conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'ci/test', conclusion: 'FAILURE' },
        ],
        branchProtection: { requiredContexts: [REQUIRED_GATE, 'ci/test'] },
      },
      dispatchContext: {
        repo: 'acme/dispatch-context-repo',
      },
    }),
    ...deps,
    logGate: {
      note(key, signature) {
        gateNotes.push({ key, signature });
        return { changed: true, count: 1, suppressedSincePrevious: 0 };
      },
    },
  });

  assert.equal(result.dispatched, true, 'a clean verdict with red required CI should auto-hammer');
  assert.equal(gateNotes[0]?.key, 'acme/pr-metadata-repo#404');
});

test('LCR: --priority precedes the base dispatch args and is emitted exactly once', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-priority-shape-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();

  await maybeDispatchAmaCloser({ ...cleanValidateAndClickArgs(rootDir), ...deps });

  const args = deps.calls[0].args;
  assert.equal(args[0], 'dispatch');
  assert.equal(args.filter((a) => a === '--priority').length, 1, 'exactly one --priority flag');
  assert.deepEqual(args.slice(0, 3), ['dispatch', '--priority', 'critical']);
});

test('LCR: unsupported --priority hq degrades to a flag-less retry (no dispatch regression)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lcr-priority-unsupported-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  const calls = [];
  deps.calls = calls;
  deps.execFileImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    if (args.includes('--priority')) {
      throw Object.assign(new Error("error: unrecognized argument '--priority'"), {
        code: 2,
        stderr: "error: unrecognized argument '--priority'",
      });
    }
    return { stdout: JSON.stringify({ ticketRef: `AMA-PR-${args[args.indexOf('--pr') + 1]}`, dispatchId: 'lrq_hammer_1', launchRequestId: 'lrq_hammer_1' }), stderr: '' };
  };

  const result = await maybeDispatchAmaCloser({ ...findingsRemediationArgs(rootDir), ...deps });

  assert.equal(result.dispatched, true, 'closer must still dispatch when hq lacks --priority');
  assert.equal(calls.length, 2, 'one failed priority attempt + one flag-less retry');
  assert.ok(calls[0].args.includes('--priority'), 'first attempt carries --priority');
  assert.ok(!calls[1].args.includes('--priority'), 'retry drops --priority');
  assert.equal(flagValue(calls[1].args, '--task-kind'), 'merge', 'retry preserves the merge dispatch');
});

test('MERGEORDER-01: protector named by a merged dependent promotes terminal HAM urgency', () => {
  const decision = resolveAmaCloserDispatchPriority({
    useHammerTerminalRemediationPrompt: true,
    repo: 'acme/repo',
    prNumber: 6767,
    mergedProtectiveDependents: [
      {
        repo: 'acme/repo',
        prNumber: 6760,
        state: 'MERGED',
        protectivePredecessor: { protectorPrNumber: 6767 },
      },
    ],
  });

  assert.equal(decision.priority, 'critical');
  assert.equal(decision.reason, 'protective-predecessor-for-merged-dependent');
  assert.equal(decision.protectiveBoost.dependentPrNumber, 6760);
});

test('MERGEORDER-01: protective dependency can promote clean validate-and-click dispatch', () => {
  const decision = resolveAmaCloserDispatchPriority({
    useHammerTerminalRemediationPrompt: false,
    repo: 'acme/repo',
    prNumber: 6767,
    mergedProtectiveDependents: [
      {
        repo: 'acme/repo',
        prNumber: 6760,
        state: 'MERGED',
        protectivePredecessor: { protectorPrNumber: 6767 },
      },
    ],
  });

  assert.equal(decision.priority, 'critical');
  assert.equal(decision.reason, 'protective-predecessor-for-merged-dependent');
  assert.equal(decision.protectiveBoost.dependentPrNumber, 6760);
});

test('MERGEORDER-01: ordinary terminal remediation priority is unchanged without protective evidence', () => {
  const decision = resolveAmaCloserDispatchPriority({
    useHammerTerminalRemediationPrompt: true,
    repo: 'acme/repo',
    prNumber: 6767,
    mergedProtectiveDependents: [],
  });

  assert.equal(decision.priority, 'normal');
  assert.equal(decision.protectiveBoost, null);
});

test('MERGEORDER-01: protective boost changes terminal remediation priority', () => {
  const unboosted = resolveAmaCloserDispatchPriority({
    useHammerTerminalRemediationPrompt: true,
    repo: 'acme/repo',
    prNumber: 6767,
    mergedProtectiveDependents: [],
  });
  const boosted = resolveAmaCloserDispatchPriority({
    useHammerTerminalRemediationPrompt: true,
    repo: 'acme/repo',
    prNumber: 6767,
    mergedProtectiveDependents: [
      {
        repo: 'acme/repo',
        prNumber: 6760,
        state: 'MERGED',
        protectivePredecessor: { protectorPrNumber: 6767 },
      },
    ],
  });

  assert.notEqual(boosted.priority, unboosted.priority);
  assert.equal(unboosted.priority, 'normal');
  assert.equal(boosted.priority, 'critical');
});

test('MERGEORDER-01: parser honors exact full-line trailers consistently across body blocks', () => {
  const body = [
    'Body text',
    '```',
    'Protects-Against-Unsafe-Merge-Until-PR: #1',
    '```',
    'Protects-Against-Unsafe-Merge-Until-PR: #6766',
    'Protects-Against-Unsafe-Merge-Until-PR: #6767',
  ].join('\n');
  const declaration = parseProtectivePredecessorDeclaration(body);

  assert.deepEqual(declaration.protectorPrNumbers, [1, 6766, 6767]);
  assert.equal(declaration.protectorPrNumber, 1);

  const shell = spawnSync('/bin/sh', ['-c', `
PROTECTIVE_PREDECESSORS=$(awk '/^[[:space:]]*Protects-Against-Unsafe-Merge-Until-PR[[:space:]]*:/ {print $0}')
while IFS= read -r predecessor_line; do
  PROTECTOR_PR=$(printf "%s" "$predecessor_line" | sed -nE 's/^[[:space:]]*Protects-Against-Unsafe-Merge-Until-PR[[:space:]]*:[[:space:]]*#?([1-9][0-9]*)[[:space:]]*$/\\1/p')
  [ -n "$PROTECTOR_PR" ] || { echo MALFORMED; exit 64; }
  echo "$PROTECTOR_PR"
done <<EOF_PROTECTIVE_PREDECESSORS
$PROTECTIVE_PREDECESSORS
EOF_PROTECTIVE_PREDECESSORS
`], { input: body, encoding: 'utf8' });
  assert.equal(shell.status, 0, shell.stderr);
  assert.deepEqual(
    shell.stdout.trim().split('\n').map((value) => Number(value)),
    declaration.protectorPrNumbers,
  );
});

test('MERGEORDER-01: malformed trailers are surfaced and scalar declarations normalize to arrays', () => {
  assert.deepEqual(
    findMalformedProtectivePredecessorLines(
      'Protects-Against-Unsafe-Merge-Until-PR: #6767 (rebase ordering)',
    ),
    [{
      lineNumber: 1,
      line: 'Protects-Against-Unsafe-Merge-Until-PR: #6767 (rebase ordering)',
    }],
  );

  assert.deepEqual(
    normalizeProtectivePredecessorDeclaration(6767).protectorPrNumbers,
    [6767],
  );
});

test('MERGEORDER-01: merged dependent matching requires explicit declaration and valid dependent PR', () => {
  assert.equal(hasMergedDependentProtectingPr({
    repo: 'acme/repo',
    prNumber: 6767,
    mergedDependents: [{ repo: 'acme/repo', prNumber: 6767, state: 'MERGED' }],
  }), null);

  assert.equal(hasMergedDependentProtectingPr({
    repo: 'acme/repo',
    prNumber: 6767,
    mergedDependents: [{ repo: 'acme/repo', state: 'MERGED', protectivePredecessor: { protectorPrNumber: 6767 } }],
  }), null);
});

test('MERGEORDER-01: merged dependent scalar declaration matches protector', () => {
  const match = hasMergedDependentProtectingPr({
    repo: 'acme/repo',
    prNumber: 6767,
    mergedDependents: [
      {
        repo: 'acme/repo',
        prNumber: 6760,
        state: 'MERGED',
        protectivePredecessor: 6767,
      },
    ],
  });

  assert.equal(match.dependentPrNumber, 6760);
  assert.equal(match.protectorPrNumber, 6767);
  assert.deepEqual(match.declaration.protectorPrNumbers, [6767]);
});

test('MERGEORDER-01: dispatch boost emits a finding naming dependent and protector', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'mergeorder-protective-boost-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  const findings = [];

  const result = await maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, {
      prMetadata: { prNumber: 6767 },
      dispatchContext: {
        prUrl: 'https://github.com/acme/repo/pull/6767',
        mergedProtectiveDependents: [
          {
            repo: 'acme/repo',
            prNumber: 6760,
            state: 'MERGED',
            protectivePredecessor: { protectorPrNumber: 6767 },
          },
        ],
      },
    }),
    ...deps,
    emitProtectivePredecessorFindingImpl: async (finding) => findings.push(finding),
  });

  assert.equal(result.dispatched, true);
  assert.equal(flagValue(deps.calls[0].args, '--priority'), 'critical');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].dependentPrNumber, 6760);
  assert.equal(findings[0].protectorPrNumber, 6767);
  assert.match(findings[0].reason, /#6760/);
  assert.match(findings[0].reason, /#6767/);
});


test('transient primary evidence does not suppress CI/conflict repair dispatch', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-primary-read-repair-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  for (const conflict of [false, true]) {
    const deps = testDeps();
    const args = baseArgs(rootDir, {
      reviewState: { verdict: 'approved', blockingFindingCount: 0 },
      prMetadata: { prNumber: conflict ? 406 : 405,
        mergeableState: conflict ? 'CONFLICTING' : 'MERGEABLE',
        statusCheckRollup: [{ name: REQUIRED_GATE, conclusion: 'FAILURE' }] },
    });
    const result = await maybeDispatchAmaCloser({ ...args, ...deps,
      options: { primaryChange: { headSha: HEAD, hasHammerCommits: null, readFailed: true } },
    });
    assert.equal(result.dispatched, true, JSON.stringify(result));
    assert.ok(deps.calls.some(({ args }) => args.includes('dispatch')));
  }
});


test('watcher never exhausts a real pre-grace comment-only closer across ticks', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'recovery-comment-grace-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  let age = 0;
  let pages = 0;
  let evaluations = 0;
  const input = { rootDir, repoPath: 'acme/repo', prNumber: 404,
    currentRevisionRef: HEAD, candidate: { prState: 'open', headSha: HEAD },
    dispatchJob: {}, reviewStateRow: {}, logger: deps.logger,
    recoveryOptions: { pageImpl: async () => { pages += 1; }, now: () => age },
    maybeDispatchAmaClosureForImpl: async (options) => {
      evaluations += 1;
      const result = await maybeDispatchAmaCloser({
        ...baseArgs(rootDir, {
          reviewState: { verdict: 'comment-only', blockingFindingCount: 0, nonBlockingFindingCount: 1 },
          dispatchContext: { settledCommentOnlyTerminalMs: age, automatedRecovery: options.automatedRecovery },
        }), ...deps,
      });
      return { ...result, amaEnabled: true };
    } };
  for (let tick = 0; tick < 8; tick += 1) {
    age = tick * 60_000;
    const waiting = await resolveMergeAgentCoexistenceForWatcher(input);
    assert.equal(waiting.outcome, 'ama-pending');
    assert.equal(waiting.amaClosureResult.recoveryWait, 'comment-only-grace');
    assert.equal(waiting.orphan?.attempts || 0, 0);
  }
  assert.equal(evaluations, 8, 'a grace hold needs only the initial closer evaluation');
  assert.equal(pages, 0);
  assert.equal(deps.calls.length, 0);
  age = 10 * 60_000;
  assert.equal((await resolveMergeAgentCoexistenceForWatcher(input)).outcome, 'ama-dispatched');
  assert.equal(deps.calls.length, 1, 'ordinary hammer admission resumes after grace');
});


test('AMASCALE: five blocked decision launches leave all other-PR capacity available', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'amascale-parked-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  for (const prNumber of [991, 992, 993, 994, 995]) {
    const identity = { repo: 'acme/repo', prNumber, headSha: 'b'.repeat(40) };
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
      state: 'dispatched', launchRequestId: `lrq_${prNumber}`, lastObservedStatus: 'running',
      lastAttemptedAt: '2026-07-20T12:00:00Z', lastObservedAt: '2026-07-20T12:00:00Z' }));
  }
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, { cfg: { amaCloserConcurrentLaunchCeiling: 3 },
      dispatchContext: { dispatchedAt: '2026-07-20T12:01:00Z' } }),
    ...deps,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'blocked_needs_decision' } }),
  });
  assert.equal(result.dispatched, true);
});


test('AMASCALE: ten eligible closer dispatches are admitted with floor three and ceiling 32', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'amascale-ten-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, { prMetadata: { prNumber: 100 + index },
      cfg: { amaCloserMaxConcurrentLaunches: 3, amaCloserConcurrentLaunchCeiling: 32 } }),
    ...deps,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'running' } }),
  })));
  assert.equal(results.filter((result) => result.dispatched).length, 10, JSON.stringify(results));
  assert.equal(deps.calls.length, 10);
});

test('withdrawal-only non-exhausted review follows the clean dispatch route', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'withdrawn-dispatch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = baseArgs(rootDir, { reviewState: { reviewCycleExhausted: false, verdict: 'request-changes',
    blockingFindingIdentities: ['unique-finding'] } });
  args.options.hammerWithdrawnFindings = [{ identity: 'unique-finding',
    resolution: 'withdrawn-by-hammer', evidenceSha256: 'e'.repeat(64),
    findingReviewedHead: HEAD, headSha: HEAD }];
  const result = await maybeDispatchAmaCloser({ ...args, ...testDeps() });
  assert.equal(result.reason, 'daemon-clean-route', JSON.stringify(result));
  assert.equal(result.dispatched, false);
});

test('LABELGATE-01: only label failures hold closure and page once per head', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'labelgate-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const alerts = [];
  const args = findingsRemediationArgs(rootDir, { prMetadata: { statusCheckRollup: [
    { name: 'submodule-pointer-gate', conclusion: 'FAILURE' },
    { name: 'test', conclusion: 'SUCCESS' },
  ] } });
  const deps = { ...testDeps(), deliverAlertImpl: async (text, opts) => alerts.push({ text, opts }),
    execFileImpl: async () => { throw new Error('must not launch'); },
    logger: { log() {}, info() {}, warn() {}, error() {} } };
  for (let i = 0; i < 2; i++) {
    const result = await maybeDispatchAmaCloser({ ...args, ...deps });
    assert.equal(result.reason, 'operator-label-required:allow-submodule-pointer-bump');
    assert.equal(result.dispatched, false);
    assert.equal(result.skipMergeAgent, true);
  }
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /apply the named label and rerun review or the named check/);
  assert.match(alerts[0].text, /submodule-pointer-gate.*allow-submodule-pointer-bump/);
  await maybeDispatchAmaCloser({ ...args, ...deps, prMetadata: { ...args.prMetadata, headSha: 'b'.repeat(40) },
    reviewState: { ...args.reviewState, headSha: 'b'.repeat(40) },
    dispatchContext: { ...args.dispatchContext, reviewedSha: 'b'.repeat(40) } });
  assert.equal(alerts.length, 2);
});

import { operatorLabelGateFailures } from '../src/ama/operator-label-gates.mjs';

test('LABELGATE-01: latest runs, mixed failures, pending and advisory checks', () => {
  const failure = { name: 'submodule-pointer-gate', conclusion: 'FAILURE', completedAt: '2026-10-11T01:00:00Z' };
  assert.equal(operatorLabelGateFailures([failure]).length, 1);
  assert.deepEqual(operatorLabelGateFailures([failure, { name: 'unit', conclusion: 'FAILURE' }]), []);
  assert.deepEqual(operatorLabelGateFailures([failure, { name: 'unit', status: 'IN_PROGRESS' }]), []);
  assert.deepEqual(operatorLabelGateFailures([failure, { name: 'unit' }]), []);
  for (const state of ['EXPECTED', 'QUEUED', 'WAITING', 'REQUESTED']) {
    assert.deepEqual(operatorLabelGateFailures([failure, { __typename: 'StatusContext', context: 'unit', state }]), []);
  }
  // Production normalizes to name/status/detailsUrl/conclusion/completedAt.
  // Without output, a registered name is deliberately a paging heuristic.
  assert.equal(operatorLabelGateFailures([{ ...failure, status: 'COMPLETED', detailsUrl: 'https://github.com/acme/repo/actions/runs/12/job/34' }]).length, 1);
  assert.deepEqual(operatorLabelGateFailures([failure, { ...failure, conclusion: 'SUCCESS', completedAt: '2026-10-11T02:00:00Z' }]), []);
  assert.deepEqual(operatorLabelGateFailures([{ ...failure, status: 'IN_PROGRESS' }]), []);
  assert.deepEqual(operatorLabelGateFailures([{ ...failure, conclusion: 'CANCELLED' }]), []);
  assert.deepEqual(operatorLabelGateFailures([{ name: 'repo-guards', conclusion: 'FAILURE' }]), []);
  assert.deepEqual(operatorLabelGateFailures([]), []);
  assert.equal(operatorLabelGateFailures([{ name: 'repo-guards', conclusion: 'FAILURE', output: { summary: "Override: apply the 'allow-submodule-pointer-bump' label" } }])[0].label, 'allow-submodule-pointer-bump');
});

import { resolveOperatorLabelGateFailures as resolveClassification } from '../src/ama/operator-label-gates.mjs';
const resolveOperatorLabelGateFailures = async args => (await resolveClassification(args)).gates;

test('LABELGATE-01: composite jobs require exact-head, exclusively label-gate failed steps', async () => {
  const rollup = [{ name: 'repo-guards-code', conclusion: 'FAILURE',
    detailsUrl: 'https://github.com/acme/repo/actions/runs/12/job/34' }];
  const args = { repo: 'acme/repo', headSha: HEAD, rollup };
  const job = { head_sha: HEAD, conclusion: 'failure', steps: [
    { name: 'Gym freeze guard', conclusion: 'success' },
    { name: 'CI-cost guard', conclusion: 'failure' },
  ] };
  const read = data => async (command, argv) => {
    assert.equal(command, 'gh');
    assert.deepEqual(argv, ['api', 'repos/acme/repo/actions/jobs/34']);
    return { stdout: JSON.stringify(data) };
  };
  const gates = await resolveOperatorLabelGateFailures({ ...args, execFileImpl: read(job) });
  assert.equal(gates[0].reason, 'operator-label-required:ci-cost-approved');
  assert.match(gates[0].check, /repo-guards-code: CI-cost guard/);
  assert.deepEqual(await resolveOperatorLabelGateFailures({ ...args, execFileImpl: read({ ...job, head_sha: 'stale' }) }), []);
  assert.deepEqual(await resolveOperatorLabelGateFailures({ ...args, execFileImpl: read({ ...job, steps: [
    ...job.steps, { name: 'Unit tests', conclusion: 'failure' },
  ] }) }), []);
  assert.deepEqual(await resolveOperatorLabelGateFailures({ ...args, execFileImpl: async () => { throw new Error('unreadable'); } }), []);
});

test('LABELGATE-01: page receipt survives restart and concurrent observations; transport failures retry', async t => {
  const { holdForOperatorLabels } = await import('../src/ama/operator-label-gates.mjs');
  const restarted = await import('../src/ama/operator-label-gates.mjs?labelgate-restart');
  const rootDir = mkdtempSync(join(tmpdir(), 'labelgate-pages-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const gates = operatorLabelGateFailures([{ name: 'ci-cost-guard', conclusion: 'FAILURE' }]);
  const args = { rootDir, repo: 'acme/repo', prNumber: 404, headSha: HEAD, gates, logger: { warn() {} } };
  let pages = 0;
  let release;
  const delivered = new Promise(resolve => { release = resolve; });
  const first = holdForOperatorLabels({ ...args, deliverAlertImpl: async () => { pages++; await delivered; } });
  await restarted.holdForOperatorLabels({ ...args, deliverAlertImpl: async () => { pages++; } });
  release();
  await first;
  const path = join(rootDir, 'data', 'operator-label-holds', readdirSync(join(rootDir, 'data', 'operator-label-holds'))[0]);
  const before = statSync(path);
  await restarted.holdForOperatorLabels({ ...args, deliverAlertImpl: async () => { pages++; } });
  assert.equal(statSync(path).ino, before.ino, 'matching receipt avoids atomic replacement');
  assert.equal(statSync(path).mtimeMs, before.mtimeMs);
  assert.equal(pages, 1);
  await restarted.holdForOperatorLabels({ ...args, gates: [...gates, { ...gates[0], check: 'another gate' }], deliverAlertImpl: async () => { pages++; } });
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).gates.length, 2);
  assert.equal(pages, 1, 'changed gates update receipt without repaging');
  const otherHead = { ...args, headSha: 'another-head' };
  await holdForOperatorLabels({ ...otherHead, deliverAlertImpl: async () => { pages++; throw new Error('transport'); } });
  await holdForOperatorLabels({ ...otherHead, deliverAlertImpl: async () => { pages++; } });
  assert.equal(pages, 3);
});


test('LABELGATE-01: pending and unrelated failures bypass composite reads', async () => {
  const composite = { name: 'repo-guards-code', conclusion: 'FAILURE',
    detailsUrl: 'https://github.com/acme/repo/actions/runs/12/job/234' };
  let calls = 0;
  const args = { repo: 'acme/repo', headSha: HEAD, execFileImpl: async () => { calls++; throw new Error('unexpected read'); } };
  for (const sibling of [
    { name: 'unit', conclusion: 'FAILURE' },
    { name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/repo/actions/runs/12/job/235' },
    { name: 'unit', status: 'IN_PROGRESS' },
    { name: 'unit' },
  ]) {
    assert.deepEqual(await resolveOperatorLabelGateFailures({ ...args, rollup: [composite,
      { name: 'submodule-pointer-gate', conclusion: 'FAILURE' }, sibling] }), []);
  }
  assert.equal(calls, 0);
});

test('LABELGATE-01: job cache keys include head/repo/job and retain negative completed reads', async () => {
  let calls = 0;
  const execFileImpl = async () => {
    calls++;
    return { stdout: JSON.stringify({ head_sha: HEAD, conclusion: 'failure', steps: [{ name: 'CI-cost guard', conclusion: 'failure' }] }) };
  };
  const args = { repo: 'acme/repo', headSha: HEAD, execFileImpl,
    rollup: [{ name: 'repo-guards-code', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/repo/actions/runs/12/job/334' }] };
  for (let i = 0; i < 2; i++) assert.equal((await resolveOperatorLabelGateFailures(args)).length, 1);
  assert.equal(calls, 1);
  for (let i = 0; i < 2; i++) assert.deepEqual(await resolveOperatorLabelGateFailures({ ...args, headSha: 'new-head' }), []);
  assert.equal(calls, 2);
  await resolveOperatorLabelGateFailures({ ...args, rollup: [{ ...args.rollup[0], detailsUrl: 'https://github.com/acme/repo/actions/runs/12/job/335' }] });
  await resolveOperatorLabelGateFailures({ ...args, repo: 'acme/other', rollup: [{ ...args.rollup[0], detailsUrl: 'https://github.com/acme/other/actions/runs/12/job/334' }] });
  assert.equal(calls, 4);
  let failures = 0;
  const failedRead = async () => { failures++; throw new Error('unreadable'); };
  for (let i = 0; i < 2; i++) assert.deepEqual(await resolveOperatorLabelGateFailures({ ...args, execFileImpl: failedRead }), []);
  assert.equal(failures, 1, 'transport errors cool down instead of reading every tick');
});

test('LABELGATE-01: per-pass read cap and cancellation bound composite expansion', async () => {
  const rollup = [434, 435, 436].map(id => ({ name: `repo-guards-${id}`, conclusion: 'FAILURE',
    detailsUrl: `https://github.com/acme/repo/actions/runs/12/job/${id}` }));
  const controller = new AbortController();
  let calls = 0;
  const execFileImpl = async (command, argv, options) => {
    calls++;
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(options.timeout > 0 && options.timeout <= 3000);
    return { stdout: JSON.stringify({ head_sha: HEAD, conclusion: 'failure', steps: [{ name: 'CI-cost guard', conclusion: 'failure' }] }) };
  };
  const args = { repo: 'acme/repo', headSha: HEAD, rollup, signal: controller.signal, execFileImpl };
  assert.deepEqual(await resolveClassification(args), { gates: [], inconclusive: true });
  assert.equal(calls, 2);
  assert.equal((await resolveOperatorLabelGateFailures(args)).length, 3, 'next pass reuses cached results');
  assert.equal(calls, 3);
  controller.abort();
  assert.deepEqual(await resolveOperatorLabelGateFailures(args), []);
  assert.equal(calls, 3);
  const running = new AbortController();
  assert.deepEqual(await resolveOperatorLabelGateFailures({ ...args, signal: running.signal,
    execFileImpl: async (command, argv, options) => { assert.ok(options.signal instanceof AbortSignal); running.abort(); throw new Error('aborted'); } }), []);
});

test('LABELGATE-01: ineligible PRs neither read jobs nor page', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'labelgate-ineligible-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let reads = 0;
  let pages = 0;
  for (const overrides of [
    { prMetadata: { isOpen: false } }, { prMetadata: { headSha: null } },
    { prMetadata: { isDraft: true } }, { reviewState: { riskClass: 'critical' } },
    { reviewState: { remediationPending: true } }, { reviewState: { reviewCycleExhausted: false } },
  ]) {
    const args = findingsRemediationArgs(rootDir);
    const result = await maybeDispatchAmaCloser({ ...args, ...testDeps(),
      reviewState: { ...args.reviewState, ...overrides.reviewState },
      prMetadata: { ...args.prMetadata, statusCheckRollup: [
        { name: 'submodule-pointer-gate', conclusion: 'FAILURE' },
        { name: 'repo-guards-code', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/repo/actions/runs/12/job/534' },
      ], ...overrides.prMetadata },
      execFileImpl: async () => { reads++; throw new Error('unexpected read or dispatch'); },
      deliverAlertImpl: async () => { pages++; },
    });
    assert.equal(result.dispatched, false);
    assert.notEqual(result.reason, 'operator-label-required:allow-submodule-pointer-bump');
  }
  assert.equal(reads, 0);
  assert.equal(pages, 0);
});


test('LABELGATE-01: evidence-stop releases persist before label paging', async t => {
  const { writeAmaAuditEntry } = await import('../src/ama/audit.mjs');
  const rootDir = mkdtempSync(join(tmpdir(), 'labelgate-release-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = findingsRemediationArgs(rootDir, { prMetadata: { statusCheckRollup: [
    { name: 'submodule-pointer-gate', conclusion: 'FAILURE' },
  ] } });
  writeAmaAuditEntry({ hqRoot: args.dispatchContext.hqRoot, repo: 'acme/repo', prNumber: 404, headSha: HEAD,
    attempt: { outcome: 'failed-without-merge', reason: 'primary-change-unknown' } });
  const path = join(rootDir, 'data', 'follow-up-jobs', 'hammer-stop-hold', 'acme-repo-pr-404.json');
  let pages = 0;
  let observedStop;
  const result = await maybeDispatchAmaCloser({ ...args, ...testDeps(),
    fetchPrimaryChangeImpl: async () => ({ headSha: HEAD, hasHammerCommits: false }),
    deliverAlertImpl: async () => {
      pages++;
      observedStop = JSON.parse(readFileSync(path, 'utf8')).heads[HEAD];
    },
  });
  assert.equal(result.reason, 'operator-label-required:allow-submodule-pointer-bump');
  assert.equal(pages, 1);
  assert.equal(observedStop?.releasedAt, args.dispatchContext.dispatchedAt);
  assert.deepEqual(observedStop?.releasedBy, ['primary-change-evidence']);
});


test('LABELGATE-01: missing required contexts prevent a label-only page', async () => {
  const rollup = [{ name: 'ci-cost-guard', conclusion: 'FAILURE' }];
  assert.deepEqual(operatorLabelGateFailures(rollup, { requiredContexts: ['unit'] }), []);
  let reads = 0;
  assert.deepEqual(await resolveClassification({ rollup, repo: 'acme/repo', headSha: HEAD,
    requiredContexts: ['unit'], execFileImpl: async () => { reads++; } }), { gates: [], inconclusive: false });
  assert.equal(reads, 0);
});

test('LABELGATE-01: exhausted transport retries hold without paging or dispatch', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'labelgate-transport-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  let reads = 0;
  let pages = 0;
  const args = findingsRemediationArgs(rootDir, { prMetadata: { statusCheckRollup: [{
    name: 'repo-guards-core', conclusion: 'FAILURE',
    detailsUrl: 'https://github.com/acme/repo/actions/runs/12/job/34',
  }] } });
  const result = await maybeDispatchAmaCloser({ ...args, ...testDeps(),
    execFileImpl: async () => { reads++; throw new Error('TLS handshake timeout'); },
    deliverAlertImpl: async () => { pages++; },
  });
  assert.equal(result.reason, 'operator-label-classification-pending');
  assert.equal(result.recoveryWait, true);
  assert.equal(result.dispatched, false);
  assert.equal(reads, 2);
  assert.equal(pages, 0);
});

test('LABELGATE-01: live repo-guards name and alternate workflow names expand', async () => {
  // Captured from agent-os Repo Guards run 38159836521 on 2026-10-11.
  const fixture = { name: 'repo-guards-core', conclusion: 'FAILURE',
    detailsUrl: 'https://github.com/laceyenterprises/agent-os/actions/runs/38159836521/job/114530330298' };
  const execFileImpl = async () => ({ stdout: JSON.stringify({ head_sha: HEAD, conclusion: 'failure',
    steps: [{ name: 'CI-cost guard', conclusion: 'failure' }] }) });
  for (const item of [fixture, { ...fixture, name: 'guards', workflowName: 'Repo Guards' }]) {
    const result = await resolveClassification({ repo: 'laceyenterprises/agent-os', headSha: HEAD,
      rollup: [item], execFileImpl });
    assert.equal(result.inconclusive, false);
    assert.equal(result.gates[0].label, 'ci-cost-approved');
  }
});

test('LABELGATE-01: sweep removes superseded and closed receipts, preserving active claims', async t => {
  const { holdForOperatorLabels, sweepOperatorLabelHolds } = await import('../src/ama/operator-label-gates.mjs');
  const rootDir = mkdtempSync(join(tmpdir(), 'labelgate-retention-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = { rootDir, repo: 'acme/repo', prNumber: 404,
    gates: operatorLabelGateFailures([{ name: 'ci-cost-guard', conclusion: 'FAILURE' }]),
    deliverAlertImpl: async () => {} };
  await holdForOperatorLabels({ ...args, headSha: HEAD });
  await holdForOperatorLabels({ ...args, headSha: 'next-head' });
  const dir = join(rootDir, 'data', 'operator-label-holds');
  assert.equal(readdirSync(dir).length, 1);
  const path = join(dir, readdirSync(dir)[0]);
  writeFileSync(`${path}.lock`, '');
  sweepOperatorLabelHolds({ ...args, closed: true });
  assert.ok(existsSync(path));
  rmSync(`${path}.lock`);
  sweepOperatorLabelHolds({ ...args, closed: true });
  assert.deepEqual(readdirSync(dir), []);
});

test('OWNERPROOF-01: terminal closer lease and spent dispatch counter do not refuse bounded recovery', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ownerproof-dispatch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'acme/repo', prNumber: 404, headSha: HEAD };
  acquireAmaCloserLease({ rootDir, ...identity, watcherPid: process.pid, now: '2026-07-20T12:00:00Z' });
  updateAmaCloserLease({ rootDir, ...identity, status: 'terminal', terminalOutcome: 'failed-without-merge' });
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, state: 'no-dispatch', reason: 'not-eligible', retryCount: 100 }));
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({ ...baseArgs(rootDir, {
    dispatchContext: { orphanRecovery: { ownerProof: true, headSha: HEAD } },
  }), ...deps });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(deps.calls.filter(c => c.args.includes('dispatch')).length, 1);
});

for (const status of ['succeeded-open', 'succeeded', 'failed', 'running', 'starting', 'unreadable', 'throws', 'timeout',
  'pending', 'pending-dead', 'pending-live', 'pending-expired']) {
  test(`CLOSERLEASE-01: reconcile ${status} lease before red-CI remediation refusal`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'closerlease-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const deps = testDeps();
    const args = baseArgs(rootDir, {
      reviewState: { remediationPending: true },
      prMetadata: { statusCheckRollup: [{ __typename: 'CheckRun', name: REQUIRED_GATE, conclusion: 'FAILURE' }] },
    });
    const identity = { rootDir, repo: args.dispatchContext.repo, prNumber: 404, headSha: HEAD };
    const pending = status.startsWith('pending');
    const localWatcher = status === 'pending-dead' || status === 'pending-live';
    const acquiredAt = status === 'pending-expired'
      ? new Date(Date.parse(args.dispatchContext.dispatchedAt) - AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS).toISOString()
      : args.dispatchContext.dispatchedAt;
    acquireAmaCloserLease({ ...identity, now: acquiredAt,
      host: localWatcher ? hostname() : `${hostname()}.foreign`, watcherPid: 123 });
    if (!pending) updateAmaCloserLease({ ...identity, status: 'dispatched',
      lrqId: 'lrq_synthetic', now: args.dispatchContext.dispatchedAt });
    const beforeLease = readAmaCloserLease(rootDir, identity);
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({ repo: identity.repo, prNumber: 404,
      headSha: HEAD, workerClass: 'hammer', state: 'dispatched', launchRequestId: 'lrq_synthetic',
      lastObservedStatus: 'running', dispatchedAt: args.dispatchContext.dispatchedAt }));
    let reads = 0;
    let pidProbes = 0;
    const result = await maybeDispatchAmaCloser({ ...args, ...deps,
      processKillImpl: (pid, signal) => {
        pidProbes++;
        assert.equal(localWatcher, true, 'foreign and dispatched leases must not probe local PIDs');
        assert.equal(pid, 123);
        assert.equal(signal, 0);
        if (status === 'pending-dead') throw Object.assign(new Error('synthetic dead watcher'), { code: 'ESRCH' });
      },
      readPullRequestStateImpl: () => status === 'succeeded-open' ? { state: 'OPEN' } : null,
      readLaunchRequestStatusImpl: () => {
        reads++;
        if (status === 'throws' || status === 'timeout') throw Object.assign(new Error('synthetic failure'),
          { code: status === 'timeout' ? 'ETIMEDOUT' : 'EIO' });
        return status === 'unreadable' ? { ok: false } : { ok: true, row: {
          status: status === 'succeeded-open' ? 'succeeded' : status,
          terminal_at: new Date(Date.parse(args.dispatchContext.dispatchedAt) - 61_000).toISOString(),
        } };
      },
    });
    // Fresh foreign/live pending leases retain ownership before eligibility.
    // Dead local and age-expired leases reach the red-CI refusal without launch.
    const heldPending = status === 'pending' || status === 'pending-live';
    assert.equal(result.reason, heldPending ? 'closer-lease-held-by-other-process' : 'not-eligible');
    assert.notEqual(result.reason, 'active-remediation-job');
    assert.equal(reads, pending ? 0 : 1);
    assert.equal(pidProbes, localWatcher ? 1 : 0);
    const lease = readAmaCloserLease(rootDir, identity);
    const terminal = status === 'failed' || status === 'succeeded-open';
    assert.equal(lease.status, terminal ? 'terminal' : pending ? 'pending' : 'dispatched');
    assert.equal(lease.terminalOutcome, terminal ? 'failed-without-merge' : null);
    if (pending) assert.deepEqual(lease, beforeLease, 'refused admission must not mutate pending ownership');
    assert.equal(deps.calls.length, 0);
  });
}

for (const scenario of [
  { name: 'disabled AMA', enabled: false, prNumber: 404, reason: 'ama-disabled' },
  { name: 'missing AMA config', missingConfig: true, prNumber: 404, reason: 'ama-disabled' },
  { name: 'zero PR number', enabled: true, prNumber: 0, reason: 'invalid-pr-number' },
  { name: 'negative PR number', enabled: true, prNumber: -1, reason: 'invalid-pr-number' },
]) {
  test(`CLOSERLEASE-01: ${scenario.name} cannot probe or settle ownership`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'closerlease-gate-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const deps = testDeps();
    const args = baseArgs(rootDir, { cfg: { enabled: scenario.enabled },
      prMetadata: { prNumber: scenario.prNumber } });
    if (scenario.missingConfig) args.cfg = undefined;
    const identity = { rootDir, repo: args.dispatchContext.repo, prNumber: scenario.prNumber, headSha: HEAD };
    acquireAmaCloserLease({ ...identity, now: args.dispatchContext.dispatchedAt });
    updateAmaCloserLease({ ...identity, status: 'dispatched', lrqId: 'lrq_disabled', now: args.dispatchContext.dispatchedAt });
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({
      ...identity, state: 'dispatched', launchRequestId: 'lrq_disabled', lastObservedStatus: 'running',
    }));
    const recordPath = amaCloserDispatchFilePath(rootDir, identity);
    const beforeLease = readAmaCloserLease(rootDir, identity);
    const beforeRecord = readFileSync(recordPath, 'utf8');
    let probes = 0;
    const result = await maybeDispatchAmaCloser({ ...args, ...deps,
      readLaunchRequestStatusImpl: () => { probes++; return { ok: true, row: { status: 'failed' } }; },
      readBuildCompletionSignalForPrImpl: () => { probes++; return { ok: true }; },
    });
    assert.equal(result.reason, scenario.reason);
    assert.equal(probes, 0);
    assert.deepEqual(readAmaCloserLease(rootDir, identity), beforeLease);
    assert.equal(readFileSync(recordPath, 'utf8'), beforeRecord);
    assert.equal(deps.calls.length, 0);
  });
}

for (const evidence of ['merged signal', 'terminal audit', 'terminal audit without hqRoot']) {
  test(`CLOSERLEASE-01: success hold settles when delayed ${evidence} arrives`, t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'closerlease-delayed-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const identity = { repo: 'acme/repo', prNumber: 404, headSha: HEAD };
    const now = '2026-07-20T12:00:00Z';
    acquireAmaCloserLease({ rootDir, ...identity, now });
    updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_delayed', now });
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({
      ...identity, state: 'dispatched', launchRequestId: 'lrq_delayed', lastObservedStatus: 'running',
    }));
    const recordPath = amaCloserDispatchFilePath(rootDir, identity);
    const beforeLease = readAmaCloserLease(rootDir, identity);
    let merged = false;
    const args = { rootDir, ...identity, hqRoot: rootDir, now,
      ...testDeps(),
      readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }),
      readBuildCompletionSignalForPrImpl: () => merged ? { ok: true, row: { head_sha: HEAD } }
        : { ok: false, reason: 'missing-build-completion-signal' },
    };
    if (evidence === 'terminal audit without hqRoot') delete args.hqRoot;
    assert.equal(reconcileAmaCloserLease(args), false);
    assert.deepEqual(readAmaCloserLease(rootDir, identity), beforeLease, 'holding must not refresh the reclaim clock');
    const observed = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.equal(observed.lastObservedStatus, 'unverified-terminal-success');
    assert.equal(observed.terminalLaunchStatus, 'succeeded');
    if (evidence === 'merged signal') merged = true;
    else appendAmaAuditAttempt({ hqRoot: rootDir, ...identity, now, attempt: { outcome: 'succeeded' } });
    assert.equal(reconcileAmaCloserLease(args), true);
    assert.equal(readAmaCloserLease(rootDir, identity).terminalOutcome, 'succeeded');
    const terminalRecord = readFileSync(recordPath, 'utf8');
    assert.equal(reconcileAmaCloserLease(args), false);
    assert.equal(readFileSync(recordPath, 'utf8'), terminalRecord, 'settlement is idempotent');
  });
}

for (const routing of [
  { ledgerTarget: { backend: 'postgres', databaseName: 'fixture-ledger' }, ledgerDbPath: null },
  { ledgerTarget: null, ledgerDbPath: '/fixture/custom-ledger.sqlite' },
]) {
  test(`CLOSERLEASE-01: completion reads preserve explicit ${routing.ledgerTarget ? 'ledgerTarget' : 'ledgerDbPath'}`, t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'closerlease-ledger-routing-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const identity = { repo: 'acme/repo', prNumber: 404, headSha: HEAD };
    const now = '2026-07-20T12:00:00Z';
    acquireAmaCloserLease({ rootDir, ...identity, now });
    updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_routing', now });
    const reads = [];
    let merged = false;
    const args = { rootDir, ...identity, hqRoot: rootDir, now, ...routing, env: {}, logger: { info() {} },
      readPullRequestStateImpl: () => null,
      readLaunchRequestStatusImpl: input => {
        reads.push(['launch', input]);
        return { ok: true, row: { status: 'succeeded' } };
      },
      readBuildCompletionSignalForPrImpl: input => {
        reads.push(['signal', input]);
        const routed = input.ledgerTarget === routing.ledgerTarget && input.ledgerDbPath === routing.ledgerDbPath;
        return merged && routed ? { ok: true, row: { head_sha: HEAD } }
          : { ok: false, reason: 'missing-build-completion-signal' };
      },
      readBuildCompletionProducerEvidenceImpl: input => {
        reads.push(['producer', input]);
        return { ok: true, row: { producer_class: 'closer-hammer' } };
      },
    };
    assert.equal(reconcileAmaCloserLease(args), false, 'producer evidence alone must retain the lease');
    assert.deepEqual(reads.map(([kind]) => kind), ['launch', 'signal', 'producer']);
    for (const [, input] of reads) {
      assert.equal(input.ledgerTarget, routing.ledgerTarget);
      assert.equal(input.ledgerDbPath, routing.ledgerDbPath);
      assert.equal(input.rootDir, rootDir);
      assert.equal(input.hqRoot, rootDir);
      assert.equal(input.env, args.env);
    }
    reads.length = 0;
    merged = true;
    assert.equal(reconcileAmaCloserLease(args), true);
    assert.deepEqual(reads.map(([kind]) => kind), ['launch', 'signal']);
    assert.equal(readAmaCloserLease(rootDir, identity).terminalOutcome, 'succeeded');
  });
}

for (const scenario of [
  { name: 'open after 61 seconds', state: 'OPEN', age: 61, outcome: 'failed-without-merge' },
  { name: 'open at 60 seconds', state: 'OPEN', age: 60, outcome: 'failed-without-merge' },
  { name: 'Date terminal time', state: 'OPEN', terminalAt: new Date('2026-07-20T11:59:00.000Z'), outcome: 'failed-without-merge' },
  { name: 'numeric terminal time', state: 'OPEN', terminalAt: Date.parse('2026-07-20T11:59:00.000Z'), outcome: 'failed-without-merge' },
  { name: 'epoch zero terminal time', state: 'OPEN', terminalAt: 0, outcome: 'failed-without-merge' },
  { name: 'invalid Date terminal time', state: 'OPEN', terminalAt: new Date(NaN) },
  { name: 'nonfinite numeric terminal time', state: 'OPEN', terminalAt: Infinity },
  { name: 'boolean terminal time', state: 'OPEN', terminalAt: true },
  { name: 'padded JSON output', state: 'OPEN', stdout: '\n {"state":"OPEN"} \n', age: 61, outcome: 'failed-without-merge' },
  { name: 'whitespace-only output', stdout: '\n \t', age: 61 },
  { name: 'empty output', stdout: '', age: 61 },
  { name: 'malformed JSON output', stdout: 'warning: unavailable', age: 61 },
  { name: 'open after 59 seconds', state: 'OPEN', age: 59 },
  { name: 'merged immediately', state: 'MERGED', age: 0, outcome: 'succeeded' },
  { name: 'closed without merge', state: 'CLOSED', age: 0, outcome: 'pr-closed-externally' },
  { name: 'throwing read', throws: true, age: 61 },
  { name: 'timed out read', timeout: true, age: 61 },
  { name: 'malformed read', age: 61 },
  { name: 'missing terminal time', state: 'OPEN' },
  { name: 'invalid terminal time', state: 'OPEN', terminalAt: 'invalid' },
  { name: 'future terminal time', state: 'OPEN', age: -1 },
  { name: 'running launch', status: 'running', state: 'OPEN', age: 61, noRead: true },
  { name: 'pending lease', pending: true, state: 'OPEN', age: 61, noRead: true },
  { name: 'merged signal', merged: true, age: 61, outcome: 'succeeded', noRead: true },
  { name: 'terminal audit', audit: true, age: 61, outcome: 'failed-without-merge', noRead: true },
  { name: 'advanced head', rekeyed: true, state: 'OPEN', age: 61, outcome: 'superseded' },
]) {
  test(`CLOSERLEASE-02: ${scenario.name}`, t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'closerlease-state-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const now = '2026-07-20T12:00:00.000Z';
    const identity = { repo: 'example/repo', prNumber: 42, headSha: HEAD };
    acquireAmaCloserLease({ rootDir, ...identity, now });
    if (!scenario.pending) updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_state', now });
    if (scenario.rekeyed) {
      rekeyAmaCloserLease({ rootDir, ...identity, fromHeadSha: HEAD, toHeadSha: 'b'.repeat(40), now });
      identity.headSha = 'b'.repeat(40);
    }
    if (scenario.audit) appendAmaAuditAttempt({ hqRoot: rootDir, ...identity, now,
      attempt: { outcome: 'failed-without-merge' } });
    let reads = 0;
    const logs = [];
    const args = { rootDir, ...identity, hqRoot: rootDir, now,
      readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: scenario.status || 'succeeded',
        terminal_at: scenario.terminalAt ?? (scenario.age === undefined ? undefined
          : new Date(Date.parse(now) - scenario.age * 1000).toISOString()) } }),
      readBuildCompletionSignalForPrImpl: () => scenario.merged ? { ok: true, row: { head_sha: HEAD } } : { ok: false },
      readBuildCompletionProducerEvidenceImpl: () => ({ ok: false }),
      readPullRequestStateImpl: input => {
        reads++;
        assert.equal(input.repo, identity.repo);
        assert.equal(input.prNumber, identity.prNumber);
        if (scenario.throws || scenario.timeout) throw Object.assign(new Error('synthetic read failure'),
          { code: scenario.timeout ? 'ETIMEDOUT' : 'EIO' });
        return scenario.state ? { state: scenario.state } : { unexpected: true };
      },
      logger: { info: line => logs.push(JSON.parse(line)) },
    };
    if (scenario.stdout !== undefined) {
      // Exercise the production subprocess/parser without a token or network.
      writeFileSync(join(rootDir, 'gh'), '#!/bin/sh\nprintf "%s" "$HAM_TEST_PR_STDOUT"\n', { mode: 0o755 });
      args.env = { ...process.env, PATH: rootDir, HAM_TEST_PR_STDOUT: scenario.stdout };
      delete args.readPullRequestStateImpl;
    }
    const before = readAmaCloserLease(rootDir, identity);
    assert.equal(reconcileAmaCloserLease(args), Boolean(scenario.outcome));
    assert.equal(reads, scenario.noRead || scenario.stdout !== undefined ? 0 : 1);
    const lease = readAmaCloserLease(rootDir, identity);
    if (scenario.outcome) {
      if (scenario.rekeyed && scenario.outcome === 'superseded') assert.equal(lease, null);
      else {
        assert.equal(lease.status, 'terminal');
        assert.equal(lease.terminalOutcome, scenario.outcome);
      }
      assert.equal(logs.length, 1);
      if (!scenario.noRead) assert.equal(logs[0].prState, scenario.state);
      assert.equal(reconcileAmaCloserLease(args), false);
      assert.equal(reads, scenario.noRead || scenario.stdout !== undefined ? 0 : 1);
    } else assert.deepEqual(lease, before);
  });
}

test('HAMCLOSE-07 reused stale target re-derives reviewed and target heads before composing', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-dispatch-head-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const current = 'b'.repeat(40);
  updateAmaCloserDispatchRecord(rootDir, { repo: 'acme/repo', prNumber: 404, headSha: HEAD }, () => ({
    state: 'failed', headSha: HEAD, reviewedSha: HEAD, targetRemediationSha: HEAD,
  }));
  const deps = testDeps();
  let prompt;
  const result = await maybeDispatchAmaCloser({ ...findingsRemediationArgs(rootDir, {
    reviewState: { headSha: current, reviewCycleExhausted: true }, prMetadata: { headSha: current },
    dispatchContext: { reviewedSha: HEAD, targetRemediationSha: HEAD, dispatchRecordHeadSha: HEAD,
      livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefOid: current }) },
  }), ...deps, writeFileImpl: (_dir, _path, body) => { prompt = body; } });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.ok(prompt.includes(`${current} ${current}`));
  assert.ok(!prompt.includes(HEAD));
  assert.equal(deps.calls.length, 1);
});

test('HAMCLOSE-07 stale target without a current review binding declines with a reason', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-dispatch-unbound-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({ ...findingsRemediationArgs(rootDir, {
    reviewState: { headSha: null }, prMetadata: { headSha: 'b'.repeat(40) },
    dispatchContext: { reviewedSha: HEAD, targetRemediationSha: HEAD },
  }), ...deps });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'dispatch-head-context-unavailable');
  assert.equal(deps.calls.length, 0);
});

test('HAMCLOSE-07 a final live-probe head move defers instead of launching the stale prompt', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-dispatch-race-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({ ...findingsRemediationArgs(rootDir, {
    dispatchContext: { livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true,
      headRefOid: 'b'.repeat(40) }) },
  }), ...deps });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'dispatch-head-context-changed');
  assert.equal(deps.calls.length, 0);
  assert.equal(readAmaCloserLease(rootDir, { repo: 'acme/repo', prNumber: 404, headSha: HEAD }), null);
});

test('stale missing review context still reconciles a dispatched lease', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-stale-reconcile-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  const args = findingsRemediationArgs(rootDir, {
    reviewState: { headSha: null }, prMetadata: { headSha: 'b'.repeat(40) },
    dispatchContext: { reviewedSha: HEAD, targetRemediationSha: HEAD },
  });
  const identity = { rootDir, repo: args.dispatchContext.repo, prNumber: 404, headSha: HEAD };
  acquireAmaCloserLease({ ...identity, now: args.dispatchContext.dispatchedAt });
  updateAmaCloserLease({ ...identity, status: 'dispatched', lrqId: 'lrq_stale', now: args.dispatchContext.dispatchedAt });
  let probes = 0;
  const result = await maybeDispatchAmaCloser({ ...args, ...deps,
    readLaunchRequestStatusImpl: () => { probes++; return { ok: true, row: { status: 'failed' } }; },
  });
  assert.equal(probes, 1);
  assert.equal(result.reason, 'dispatch-head-context-unavailable');
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'terminal');
  assert.equal(deps.calls.length, 0);
});


test('REMLABEL-01: operator-only findings hold the terminal hammer and page once', async t => {
  const { classifyOperatorGatedFindings } = await import('../src/ama/operator-label-gates.mjs');
  const rootDir = mkdtempSync(join(tmpdir(), 'remlabel-hammer-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const operatorLabelFindings = classifyOperatorGatedFindings('## Blocking issues\n- **[live_pack_cross_edit] Live pack** — operator waiver needed.');
  const args = findingsRemediationArgs(rootDir, { reviewState: { reviewCycleExhausted: true, operatorLabelFindings } });
  let pages = 0;
  let comments = 0;
  const deps = { ...testDeps(), deliverAlertImpl: async () => { pages++; },
    execFileImpl: async (cmd, argv) => {
      assert.equal(cmd, 'gh');
      assert.ok(argv.includes('repos/acme/repo/issues/404/comments'));
      comments++;
      return { stdout: '{}', stderr: '' };
    } };
  for (let i = 0; i < 2; i++) {
    const result = await maybeDispatchAmaCloser({ ...args, ...deps });
    assert.equal(result.dispatched, false);
    assert.equal(result.reason, 'operator-label-required:live-pack-edit-approved');
  }
  assert.equal(pages, 1);
  assert.equal(comments, 1);
});

test('DRAINDEFER-01: first clear pass dispatches deferred PRs in order within the existing cap', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-drain-resume-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const prNumbers = [41, 42, 43, 44];
  let isDraining = true;
  const launched = [];
  const run = async prNumber => {
    const deps = testDeps();
    return maybeDispatchAmaCloser({
      ...findingsRemediationArgs(rootDir, { prMetadata: { prNumber }, cfg: { amaCloserConcurrentLaunchCeiling: 3 } }),
      ...deps,
      readDispatchDrainStatusImpl: async () => ({ isDraining, epoch: 7 }),
      execFileImpl: async (_cmd, args) => {
        assert.ok(args.includes('dispatch'));
        launched.push(prNumber);
        return { stdout: JSON.stringify({ ticketRef: `AMA-PR-${prNumber}`, launchRequestId: `synthetic-${prNumber}` }) };
      },
    });
  };
  for (const prNumber of prNumbers) {
    const identity = { repo: 'acme/repo', prNumber, headSha: HEAD };
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
      state: 'deferred-by-drain', drainEpoch: '7', retryCount: 0 }));
    assert.equal((await run(prNumber)).reason, 'deferred-by-drain');
  }
  assert.deepEqual(launched, []);
  isDraining = false;
  const results = [];
  for (const prNumber of prNumbers) results.push(await run(prNumber));
  assert.deepEqual(launched, prNumbers.slice(0, 3));
  assert.ok(results.slice(0, 3).every(result => result.dispatched), JSON.stringify(results));
  assert.equal(results[3].dispatched, false);
  assert.match(results[3].reason, /launch-(?:capacity|in-progress)/);
});

test('DRAINDEFER-01: unreadable drain status retains normal admission instead of adding a gate', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-drain-status-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'acme/repo', prNumber: 404, headSha: HEAD };
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, state: 'deferred-by-drain', drainEpoch: '7', retryCount: 0 }));
  const result = await maybeDispatchAmaCloser({ ...findingsRemediationArgs(rootDir), ...testDeps(),
    readDispatchDrainStatusImpl: async () => { throw new Error('synthetic unavailable status'); } });
  assert.equal(result.dispatched, true, JSON.stringify(result));
});


test('DRAINDEFER-01: a cleared drain does not mask a new eligibility blocker', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-drain-new-blocker-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'acme/repo', prNumber: 404, headSha: HEAD };
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
    state: 'deferred-by-drain', drainEpoch: '7', retryCount: 0 }));
  const result = await maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, { prMetadata: { isDraft: true } }), ...testDeps(),
    readDispatchDrainStatusImpl: async () => ({ isDraining: false, epoch: 7 }),
  });
  assert.equal(result.dispatched, false);
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.state, 'no-dispatch');
  assert.equal(record.reason, 'drain-wait-ended');
});

for (const status of [{}, { isDraining: 'true' }, { isDraining: null }]) {
  test(`DRAINDEFER-01: invalid drain schema ${JSON.stringify(status)} is unreadable and warns once per epoch`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'ama-drain-schema-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const identity = { repo: 'acme/repo', prNumber: 404, headSha: HEAD };
    const warnings = [];
    for (let i = 0; i < 2; i++) {
      updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
        state: 'deferred-by-drain', drainEpoch: 'schema-fixture', updatedAt: new Date().toISOString() }));
      const result = await maybeDispatchAmaCloser({
        ...findingsRemediationArgs(rootDir, { prMetadata: { isDraft: true } }), ...testDeps(),
        readDispatchDrainStatusImpl: async () => status,
        logger: { warn: message => warnings.push(message), log() {}, info() {} },
      });
      assert.equal(result.dispatched, false);
      assert.equal(JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8')).state, 'no-dispatch');
    }
    assert.equal(warnings.filter(message => message.includes('drain status unavailable')).length, 1);
  });
}

for (const headSource of ['prMetadata', 'reviewState', 'dispatchContext', 'args']) {
  test(`DRAINDEFER-01: drain lookup and retirement use ${headSource} head fallback in priority order`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'ama-drain-head-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const identity = { repo: 'acme/repo', prNumber: 404, headSha: HEAD };
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
      state: 'deferred-by-drain', drainEpoch: '7', updatedAt: new Date().toISOString() }));
    const heads = [null, null, null, null];
    const selected = ['prMetadata', 'reviewState', 'dispatchContext', 'args'].indexOf(headSource);
    heads[selected] = HEAD;
    for (let i = selected + 1; i < heads.length; i++) heads[i] = 'b'.repeat(40);
    const args = findingsRemediationArgs(rootDir, {
      prMetadata: { headSha: heads[0], isDraft: true },
      reviewState: { headSha: heads[1] },
      dispatchContext: { reviewedSha: heads[2] },
    });
    let isDraining = true;
    let probes = 0;
    const run = overrides => maybeDispatchAmaCloser({ ...args, ...testDeps(), headSha: heads[3],
      readDispatchDrainStatusImpl: async () => { probes++; return { isDraining, epoch: 8 }; },
      ...overrides });
    const held = await run();
    assert.equal(held.reason, 'deferred-by-drain');
    assert.equal(probes, 1);
    const readRecord = () => JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
    assert.equal(readRecord().drainEpoch, '8');

    isDraining = false;
    assert.equal((await run()).dispatched, false);
    assert.equal(probes, 2);
    assert.equal(readRecord().state, 'no-dispatch');
    assert.equal(readRecord().reason, 'drain-wait-ended');

    updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
      state: 'deferred-by-drain', drainEpoch: '8', updatedAt: new Date().toISOString() }));
    assert.equal((await run({ cfg: { enabled: false } })).reason, 'ama-disabled');
    assert.equal(probes, 2, 'disabled AMA retires the hint without a subprocess');
    assert.equal(readRecord().state, 'no-dispatch');
  });
}

test('CLOSERGATE-01: slow pre-receipt acknowledgements serialize only their own PR', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'concurrent-launch-cap-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const waiters = [];
  const starts = [];
  let allStarted;
  const started = new Promise(resolve => { allStarted = resolve; });
  const argsFor = prNumber => findingsRemediationArgs(rootDir, {
    prMetadata: { prNumber },
    cfg: { amaCloserMaxConcurrentLaunches: 3, amaCloserConcurrentLaunchCeiling: 3 },
    dispatchContext: { repo: 'fixture/project', prNumber,
      prUrl: `https://github.com/fixture/project/pull/${prNumber}` },
  });
  const attempts = [1, 2, 3, 4].map(prNumber => maybeDispatchAmaCloser({
    ...argsFor(prNumber), ...testDeps(),
    observeCloserBacklogImpl: async () => 4,
    execFileImpl: async () => {
      starts.push(prNumber);
      await new Promise(resolve => {
        waiters.push(resolve);
        if (starts.length === 4) allStarted();
      });
      return { stdout: JSON.stringify({ ticketRef: `AMA-PR-${prNumber}`, dispatchId: `lrq_fixture_${prNumber}`, launchRequestId: `lrq_fixture_${prNumber}` }), stderr: '' };
    },
  }));
  try {
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('unrelated intent held admission')), 5000);
      t.after(() => clearTimeout(timer));
    });
    await Promise.race([started, timeout]);
    assert.equal(starts.length, 4);
    const duplicate = await maybeDispatchAmaCloser({ ...argsFor(1), ...testDeps(),
      execFileImpl: () => assert.fail('same PR/head must not launch twice') });
    assert.equal(duplicate.reason, 'existing-dispatch-unknown');
  } finally {
    waiters.forEach(resolve => resolve());
    await Promise.all(attempts);
  }
});

for (const scenario of ['audit', 'no audit', 'auto-merge armed', 'expired auto-merge', 'expired auto-merge fallback']) {
  const audited = scenario === 'audit';
  test(`HAMRETRY-01: terminal success on the open same head reconciles before retry (${scenario})`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'same-head-retry-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const args = findingsRemediationArgs(rootDir, { dispatchContext: { dispatchReason: 'exhausted-final-hammer' } });
    const identity = { repo: args.dispatchContext.repo, prNumber: 404, headSha: HEAD };
    const now = args.dispatchContext.dispatchedAt;
    acquireAmaCloserLease({ rootDir, ...identity, now });
    updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: 'synthetic-first' });
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, state: 'dispatched',
      workerClass: 'hammer', launchRequestId: 'synthetic-first', retryCount: 1,
      reviewedSha: HEAD, dispatchedAt: now, lastObservedAt: now, lastObservedStatus: 'starting' }));
    const { recordHammerRetryDispatch, readHammerRetryCapLedger } = await import('../src/ama/hammer-retry-cap.mjs');
    recordHammerRetryDispatch(rootDir, identity, { jobKey: HEAD, headSha: HEAD, now });
    if (audited) appendAmaAuditAttempt({ hqRoot: args.dispatchContext.hqRoot, ...identity, now,
      attempt: { outcome: 'failed-without-merge', reason: 'history-read-failed' } });
    const deps = testDeps();
    const baseExec = deps.execFileImpl;
    deps.execFileImpl = async (cmd, argv, options) => argv[0] === 'dispatch' && argv[1] === 'status'
      ? { stdout: JSON.stringify({ status: 'starting' }) } : baseExec(cmd, argv, options);
    const events = [];
    const input = { ...args, ...deps,
      logger: { info: line => events.push(JSON.parse(line)), warn() {}, error() {} },
      readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }),
      readPullRequestStateImpl: () => ({ state: 'OPEN', headRefOid: HEAD }),
      fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', headSha: HEAD, comments: [] }),
      deliverAlertImpl: async () => ({ ok: true }),
    };
    if (scenario === 'auto-merge armed' || scenario.startsWith('expired auto-merge')) {
      const live = { state: 'OPEN', headRefOid: HEAD, headBranchExists: true,
        autoMergeRequest: { enabledAt: now } };
      input.readPullRequestStateImpl = () => live;
      input.dispatchContext.livePrProbeImpl = async () => live;
      const held = await maybeDispatchAmaCloser(input);
      assert.equal(held.dispatched, false, JSON.stringify(held));
      assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
      assert.equal(readHammerRetryCapLedger(rootDir, identity).lifetimeAttemptCount, 1);
      assert.equal(deps.calls.length, 0, 'do not dispatch while GitHub has a queued merge');
      if (scenario.startsWith('expired auto-merge')) {
        input.dispatchContext.dispatchedAt = new Date(Date.parse(now) + 30 * 60_000).toISOString();
        input.prMetadata.statusCheckRollup = [
          { __typename: 'CheckRun', name: REQUIRED_GATE, conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'test', conclusion: 'FAILURE' },
        ];
        input.prMetadata.branchProtection.requiredContexts.push('test');
        if (scenario.endsWith('fallback')) input.readPullRequestStateImpl = () => null;
      } else live.autoMergeRequest = null;
    }
    let result = await maybeDispatchAmaCloser(input);
    if (scenario.endsWith('fallback')) {
      assert.equal(result.reason, 'stale-dispatched-lease-terminalized');
      assert.equal(readAmaCloserLease(rootDir, identity).terminalOutcome, 'failed-without-merge');
      result = await maybeDispatchAmaCloser(input);
    }
    if (scenario.startsWith('expired auto-merge')) {
      assert.equal(events.filter(event => event.event === 'ama_closer.auto_merge_hold_released').length, 1);
    }
    assert.equal(result.dispatched, true, JSON.stringify(result));
    assert.equal(result.launchRequestId, 'lrq_hammer_1');
    assert.equal(deps.calls.filter(c => c.args[0] === 'dispatch').length, 1);
    assert.equal(readAmaCloserLease(rootDir, identity).lrqId, 'lrq_hammer_1');
    assert.equal(readHammerRetryCapLedger(rootDir, identity).lifetimeAttemptCount, 2);
    if (scenario.startsWith('expired auto-merge')) {
      input.dispatchContext.dispatchedAt = new Date(Date.parse(input.dispatchContext.dispatchedAt) + 30 * 60_000).toISOString();
    }
    let capped = await maybeDispatchAmaCloser(input);
    if (scenario.endsWith('fallback')) {
      assert.equal(capped.reason, 'stale-dispatched-lease-terminalized');
      capped = await maybeDispatchAmaCloser(input);
    }
    assert.equal(capped.dispatched, false);
    assert.equal(capped.reason, 'hammer-retry-cap-exhausted', JSON.stringify(capped));
    assert.equal(deps.calls.filter(c => c.args[0] === 'dispatch').length, 1);
  });
}

test('HAMRETRY-01: confirmed merged hammer keeps succeeded ownership sticky', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'same-head-merged-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'synthetic/repository', prNumber: 23, headSha: HEAD };
  acquireAmaCloserLease({ rootDir, ...identity });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'synthetic-merged' });
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, state: 'dispatched',
    launchRequestId: 'synthetic-merged', lastObservedStatus: 'starting' }));
  assert.equal(reconcileAmaCloserLease({ rootDir, ...identity,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }),
    readMergedSignalImpl: () => ({ ok: true }), logger: { info() {} },
  }), true);
  const lease = readAmaCloserLease(rootDir, identity);
  assert.equal(lease.terminalOutcome, 'succeeded');
  assert.equal(acquireAmaCloserLease({ rootDir, ...identity }).acquired, false);
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity)));
  assert.equal(record.state, 'launch-terminal');
  assert.equal(record.outcome, 'succeeded');
});

for (const advanced of [false, true]) {
  test(`HAMRETRY-01: stale starting worker with ledger success respects live evidence (advanced=${advanced})`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'terminal-live-evidence-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const currentHead = advanced ? 'b'.repeat(40) : HEAD;
    const args = findingsRemediationArgs(rootDir, {
      reviewState: { headSha: currentHead, reviewCycleExhausted: true },
      prMetadata: { headSha: currentHead },
      dispatchContext: { reviewedSha: currentHead, targetRemediationSha: currentHead,
        dispatchRecordHeadSha: HEAD, dispatchReason: 'exhausted-final-hammer',
        livePrProbeImpl: async () => advanced
          ? { state: 'OPEN', headRefOid: currentHead, headBranchExists: true } : null },
    });
    const identity = { repo: args.dispatchContext.repo, prNumber: 404, headSha: HEAD };
    const now = args.dispatchContext.dispatchedAt;
    acquireAmaCloserLease({ rootDir, ...identity, now });
    updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: 'synthetic-first' });
    if (advanced) rekeyAmaCloserLease({ rootDir, ...identity, fromHeadSha: HEAD, toHeadSha: currentHead, now });
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, state: 'dispatched',
      workerClass: 'hammer', launchRequestId: 'synthetic-first', retryCount: 1,
      reviewedSha: HEAD, targetRemediationSha: currentHead,
      dispatchedAt: now, lastObservedAt: now, lastObservedStatus: 'starting' }));
    const deps = testDeps();
    const baseExec = deps.execFileImpl;
    deps.execFileImpl = async (cmd, argv, opts) => argv[0] === 'dispatch' && argv[1] === 'status'
      ? { stdout: JSON.stringify({ status: 'starting' }) } : baseExec(cmd, argv, opts);
    const result = await maybeDispatchAmaCloser({ ...args, ...deps,
      readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }),
      readPullRequestStateImpl: () => advanced ? { state: 'OPEN', headRefOid: currentHead } : null,
      readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'query-failed' }),
      fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', headSha: currentHead, comments: [] }),
      deliverAlertImpl: async () => ({ ok: true }),
    });
    const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity)));
    if (advanced) {
      assert.equal(result.dispatched, true, JSON.stringify(result));
      assert.equal(record.outcome, 'hammer-exited-without-close', 'head advance alone cannot claim a merge');
    } else {
      assert.equal(result.dispatched, false, JSON.stringify(result));
      assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched', 'unknown merge and PR evidence preserves ownership');
      assert.equal(record.terminalLaunchStatus, 'succeeded');
      assert.equal(deps.calls.length, 0);
    }
  });
}

test('HAMRETRY-01: operation cancellation prevents delayed lease settlement', async t => {
  const { reconcileAmaCloserLeaseAsync } = await import('../src/ama/dispatch-closer.mjs');
  const rootDir = mkdtempSync(join(tmpdir(), 'terminal-cancel-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'synthetic/repository', prNumber: 23, headSha: HEAD };
  acquireAmaCloserLease({ rootDir, ...identity });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'synthetic-ended' });
  const before = readAmaCloserLease(rootDir, identity);
  const controller = new AbortController();
  await assert.rejects(reconcileAmaCloserLeaseAsync({ rootDir, ...identity, signal: controller.signal,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }),
    readMergedSignalImpl: () => ({ ok: false }),
    readPullRequestStateImpl: ({ signal }) => {
      assert.equal(signal, controller.signal);
      controller.abort(new Error('synthetic operation timeout'));
      return { state: 'OPEN', headRefOid: HEAD };
    },
  }), /synthetic operation timeout/);
  assert.deepEqual(readAmaCloserLease(rootDir, identity), before);
});

for (const ageMs of [0, 59_999, 60_000, null]) {
  test(`HAMRETRY-01: same-head terminal settle grace at age ${ageMs}`, t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'terminal-settle-grace-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const identity = { repo: 'synthetic/repository', prNumber: 23, headSha: HEAD };
    const now = '2026-10-18T04:00:00.000Z';
    acquireAmaCloserLease({ rootDir, ...identity, now });
    updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: 'synthetic-ended' });
    const row = { status: 'succeeded', ...(ageMs === null ? {} : { terminal_at: new Date(Date.parse(now) - ageMs).toISOString() }) };
    const settled = reconcileAmaCloserLease({ rootDir, ...identity, now,
      readLaunchRequestStatusImpl: () => ({ ok: true, row }),
      readMergedSignalImpl: () => ({ ok: false }),
      readPullRequestStateImpl: () => ({ state: 'OPEN', headRefOid: HEAD }), logger: { info() {} },
    });
    assert.equal(settled, ageMs === null || ageMs >= 60_000);
    assert.equal(readAmaCloserLease(rootDir, identity).status, settled ? 'terminal' : 'dispatched');
  });
}

for (const ageMs of [30 * 60_000 - 1, 30 * 60_000]) {
  test(`HAMRETRY-01: armed auto-merge lease bound at age ${ageMs}`, t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'auto-merge-bound-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const identity = { repo: 'synthetic/repository', prNumber: 23, headSha: HEAD };
    const started = '2026-10-18T04:00:00.000Z';
    const now = new Date(Date.parse(started) + ageMs).toISOString();
    acquireAmaCloserLease({ rootDir, ...identity, now: started });
    updateAmaCloserLease({ rootDir, ...identity, now: started, status: 'dispatched', lrqId: 'synthetic-ended' });
    const events = [];
    const input = { rootDir, ...identity, now,
      readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded', terminal_at: started } }),
      readMergedSignalImpl: () => ({ ok: false }),
      readPullRequestStateImpl: () => ({ state: 'OPEN', headRefOid: HEAD, autoMergeRequest: { enabledAt: started } }),
      logger: { info: line => events.push(JSON.parse(line)) },
    };
    const expired = ageMs >= 30 * 60_000;
    assert.equal(reconcileAmaCloserLease(input), expired);
    const lease = readAmaCloserLease(rootDir, identity);
    assert.equal(lease.status, expired ? 'terminal' : 'dispatched');
    assert.equal(lease.updatedAt, expired ? now : started, 'observations do not extend the hold');
    if (expired) {
      assert.equal(lease.terminalOutcome, 'failed-without-merge');
      assert.ok(events.some(event => event.event === 'ama_closer.auto_merge_hold_released'));
    }
  });
}

for (const wireOnly of [false, true])
for (const ageMs of [0, 59_999, 60_000]) {
  test(`dispatch fallback respects prefetched terminal settle grace at age ${ageMs}, wireOnly=${wireOnly}`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'dispatch-settle-grace-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const args = findingsRemediationArgs(rootDir, { dispatchContext: { dispatchReason: 'exhausted-final-hammer' } });
    const identity = { repo: args.dispatchContext.repo, prNumber: 404, headSha: HEAD };
    const now = args.dispatchContext.dispatchedAt;
    acquireAmaCloserLease({ rootDir, ...identity, now });
    updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: 'synthetic-first' });
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, state: 'dispatched',
      workerClass: 'hammer', launchRequestId: 'synthetic-first', retryCount: 1,
      reviewedSha: HEAD, dispatchedAt: now, lastObservedAt: now, lastObservedStatus: 'starting' }));
    const deps = testDeps();
    const baseExec = deps.execFileImpl;
    deps.execFileImpl = async (cmd, argv, options) => argv[0] === 'dispatch' && argv[1] === 'status'
      ? { stdout: JSON.stringify({ status: 'starting' }) } : baseExec(cmd, argv, options);
    const result = await maybeDispatchAmaCloser({ ...args, ...deps,
      readLaunchRequestStatusImpl: () => ({ ok: true, row: { ...(wireOnly ? { terminal: true, succeeded: true } : { status: 'succeeded' }),
        terminal_at: new Date(Date.parse(now) - ageMs).toISOString() } }),
      // Early reconciliation has no live PR evidence; the dispatch fallback does.
      readPullRequestStateImpl: () => null,
      fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', headSha: HEAD, comments: [] }),
      deliverAlertImpl: async () => ({ ok: true }),
    });
    assert.equal(result.dispatched, ageMs >= 60_000, JSON.stringify(result));
    if (ageMs < 60_000) {
      assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
      assert.equal(deps.calls.length, 0);
    }
  });
}

for (const holdReason of ['fleet-quota-status-unavailable', 'codex-account-evidence-unknown', 'all-fallbacks-grounded']) {
  test(`HAMMERQUOTAREAD-01: dispatch preserves ${holdReason} in result and audit`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'closer-hold-reason-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const deps = testDeps();
    const args = findingsRemediationArgs(rootDir);
    const result = await maybeDispatchAmaCloser({ ...args, ...deps,
      resolveOsgRemediatorRouteImpl: async () => assert.fail('OSG must not bypass a harness hold'),
      resolveCloserDispatchHarnessImpl: async options => {
        assert.equal(options.rootDir, rootDir);
        return { workerClass: 'hammer', hold: true, reason: holdReason };
      } });
    const expected = holdReason === 'all-fallbacks-grounded' ? holdReason : `harness-hold:${holdReason}`;
    assert.equal(result.dispatched, false);
    assert.equal(result.skipMergeAgent, true);
    assert.equal(result.reason, expected);
    assert.equal(result.namedReason, expected);
    assert.equal(result.holdReason, holdReason);
    assert.equal(deps.calls.length, 0);
    const audit = readAmaAuditEntry(args.dispatchContext.hqRoot, args.dispatchContext.repo, 404, HEAD);
    assert.equal(audit.attempts.at(-1).reason, expected);
    assert.equal(audit.attempts.at(-1).harnessResolution.reason, holdReason);
    assert.equal(audit.status, 'deferred');
  });
}

test('HAMMERQUOTAREAD-01: snapshot provenance survives personal dispatch and audit', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-snapshot-audit-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const deps = testDeps();
  const args = findingsRemediationArgs(rootDir);
  const evidence = { evidenceSource: 'last-good-snapshot', evidenceAgeMs: 180_000,
    evidenceReadAt: Date.parse('2026-10-01T12:00:00Z'), liveReadReason: 'fleet-quota-status-unavailable' };
  const result = await maybeDispatchAmaCloser({ ...args, ...deps,
    resolveCloserDispatchHarnessImpl: async () => ({ workerClass: 'hammer', fellBack: false,
      reason: 'personal-ready', ...evidence }) });
  assert.equal(result.dispatched, true);
  for (const [key, value] of Object.entries(evidence)) {
    assert.equal(result.harnessResolution[key], value);
    const audit = readAmaAuditEntry(args.dispatchContext.hqRoot, args.dispatchContext.repo, 404, HEAD);
    assert.equal(audit.harnessResolution[key], value);
    assert.equal(audit.attempts.at(-1).harnessResolution[key], value);
  }
});

// TERMLEASE-01 fixtures contain only synthetic heads, launches and repository IDs.
for (const outcome of ['superseded', 'failed-without-merge', 'deferred', 'succeeded']) {
  test(`TERMLEASE-01: current-head terminal ${outcome} with a finished launch`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'termlease-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const oldHead = 'b'.repeat(40);
    const args = findingsRemediationArgs(rootDir, { reviewState: { verdict: 'comment-only',
      reviewCycleExhausted: true, blockingFindingCount: 0, nonBlockingFindingCount: 2 } });
    const identity = { repo: 'acme/repo', prNumber: 404, headSha: HEAD };
    const now = args.dispatchContext.dispatchedAt;
    acquireAmaCloserLease({ rootDir, ...identity, headSha: oldHead, now });
    updateAmaCloserLease({ rootDir, ...identity, headSha: oldHead, now,
      status: 'dispatched', lrqId: 'synthetic-finished' });
    rekeyAmaCloserLease({ rootDir, ...identity, fromHeadSha: oldHead, toHeadSha: HEAD, now });
    updateAmaCloserLease({ rootDir, ...identity, now, status: 'terminal', terminalOutcome: outcome });
    // The launch exited successfully after pushing; it did not merge this head.
    appendAmaAuditAttempt({ hqRoot: args.dispatchContext.hqRoot, ...identity, headSha: oldHead,
      now, attempt: { outcome: 'succeeded' } });
    const deps = testDeps(), logs = [];
    let launchStatusReads = 0;
    const before = readAmaCloserLease(rootDir, identity);
    const result = await maybeDispatchAmaCloser({ ...args, ...deps,
      readLaunchRequestStatusImpl: () => {
        launchStatusReads += 1;
        return { ok: true, row: { status: 'succeeded' } };
      },
      logger: { ...deps.logger, info: line => logs.push(line) },
    });
    const dispatches = deps.calls.filter(call => call.args[0] === 'dispatch' && call.args[1] !== 'status');
    if (outcome === 'succeeded') {
      assert.equal(launchStatusReads, 0, 'sticky succeeded leases bypass launch status probes');
      assert.equal(result.reason, 'lease-held', JSON.stringify(result));
      assert.equal(dispatches.length, 0);
      assert.deepEqual(readAmaCloserLease(rootDir, identity), before);
    } else {
      assert.equal(result.dispatched, true, JSON.stringify(result));
      assert.equal(dispatches.length, 1, 'launches on the same watcher pass');
      assert.equal(readAmaCloserLease(rootDir, identity).lrqId, 'lrq_hammer_1');
      assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
      assert.ok(logs.some(line => JSON.parse(line).event === 'ama_closer.terminal_lease_reclaimed'));
    }
  });
}

for (const probe of [
  { ok: true, row: { status: 'running' } },
  { ok: false, reason: 'query-failed' },
  { ok: true, row: { status: 'succeeded' }, retryChainUnreadable: true },
  { ok: true, row: { status: 'succeeded' }, retryChain: [{ status: 'running', launch_request_id: 'synthetic-retry' }] },
]) test(`TERMLEASE-01: terminal lease retains possible live launch ${JSON.stringify(probe)}`, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'termlease-live-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'acme/repo', prNumber: 404, headSha: HEAD };
  const args = findingsRemediationArgs(rootDir), deps = testDeps();
  acquireAmaCloserLease({ rootDir, ...identity, now: args.dispatchContext.dispatchedAt });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'synthetic-live' });
  updateAmaCloserLease({ rootDir, ...identity, status: 'terminal', terminalOutcome: 'superseded' });
  const before = readAmaCloserLease(rootDir, identity);
  const result = await maybeDispatchAmaCloser({ ...args, ...deps, readLaunchRequestStatusImpl: () => probe });
  assert.equal(result.reason, 'lease-held', JSON.stringify(result));
  assert.match(result.closureBlocker, /terminal lease from launch synthetic-live still live/);
  assert.deepEqual(readAmaCloserLease(rootDir, identity), before);
  assert.equal(deps.calls.length, 0);
});

for (const evidence of ['missing ledger row', 'terminal dispatch record']) {
  test(`TERMLEASE-01: reclaim terminal lease with ${evidence}`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'termlease-evidence-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const identity = { repo: 'acme/repo', prNumber: 404, headSha: HEAD };
    const args = findingsRemediationArgs(rootDir), deps = testDeps();
    acquireAmaCloserLease({ rootDir, ...identity, now: args.dispatchContext.dispatchedAt });
    updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'synthetic-ended' });
    updateAmaCloserLease({ rootDir, ...identity, status: 'terminal', terminalOutcome: 'deferred' });
    if (evidence === 'terminal dispatch record') {
      // A historical copy with the same LRQ must not hide terminal proof.
      updateAmaCloserDispatchRecord(rootDir, { ...identity, headSha: '0'.repeat(40) }, () => ({
        ...identity, headSha: '0'.repeat(40), launchRequestId: 'synthetic-ended',
        state: 'dispatched', lastObservedStatus: 'running', lastAttemptedAt: '2026-07-19T12:00:00Z',
      }));
      updateAmaCloserDispatchRecord(rootDir, { ...identity, headSha: 'b'.repeat(40) }, () => ({
        ...identity, headSha: 'b'.repeat(40), launchRequestId: 'synthetic-ended',
        state: 'launch-terminal', lastObservedStatus: 'succeeded',
      }));
    }
    const result = await maybeDispatchAmaCloser({ ...args, ...deps,
      readLaunchRequestStatusImpl: () => ({ ok: false, reason: evidence === 'missing ledger row'
        ? 'missing-launch-request-row' : 'query-failed' }),
    });
    assert.equal(result.dispatched, true, JSON.stringify(result));
  });
}

test('TERMLEASE-01: delayed liveness evidence cannot delete a replacement lease', async t => {
  const { deleteAmaCloserLease } = await import('../src/ama/closer-lease.mjs');
  const rootDir = mkdtempSync(join(tmpdir(), 'termlease-replacement-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'acme/repo', prNumber: 404, headSha: HEAD };
  const args = findingsRemediationArgs(rootDir), deps = testDeps();
  acquireAmaCloserLease({ rootDir, ...identity, now: args.dispatchContext.dispatchedAt });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'synthetic-ended' });
  updateAmaCloserLease({ rootDir, ...identity, status: 'terminal', terminalOutcome: 'superseded' });
  const result = await maybeDispatchAmaCloser({ ...args, ...deps, readLaunchRequestStatusImpl: () => {
    deleteAmaCloserLease(rootDir, identity);
    acquireAmaCloserLease({ rootDir, ...identity, watcherPid: process.pid });
    updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'synthetic-replacement' });
    return { ok: true, row: { status: 'succeeded' } };
  } });
  assert.equal(result.dispatched, false);
  assert.equal(readAmaCloserLease(rootDir, identity).lrqId, 'synthetic-replacement');
  assert.equal(deps.calls.length, 0);
});

test('TERMLEASE-01: superseding a finished dispatch releases its rekeyed current-head lease', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'termlease-supersede-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const oldHead = 'b'.repeat(40);
  const identity = { repo: 'acme/repo', prNumber: 404, headSha: oldHead };
  const args = findingsRemediationArgs(rootDir);
  const now = args.dispatchContext.dispatchedAt;
  acquireAmaCloserLease({ rootDir, ...identity, now });
  updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: 'synthetic-superseded' });
  rekeyAmaCloserLease({ rootDir, ...identity, fromHeadSha: oldHead, toHeadSha: HEAD, now });
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
    state: 'launch-terminal', workerClass: 'hammer', launchRequestId: 'synthetic-superseded',
    retryCount: 1, reviewedSha: HEAD, lastObservedStatus: 'succeeded', dispatchedAt: now,
  }));
  assert.equal(reconcileAmaCloserLease({ rootDir, ...identity, now,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }),
    readMergedSignalImpl: () => ({ ok: false }),
    readPullRequestStateImpl: () => ({ state: 'OPEN', headRefOid: HEAD }),
    logger: { info() {} },
  }), true);
  assert.equal(readAmaCloserLease(rootDir, { ...identity, headSha: HEAD }), null,
    'supersession releases the carried lease before any new dispatch');
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({ ...args, ...deps,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }),
  });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  const current = readAmaCloserLease(rootDir, { ...identity, headSha: HEAD });
  assert.equal(current.status, 'dispatched');
  assert.equal(current.lrqId, 'lrq_hammer_1');
  const original = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity)));
  assert.equal(original.outcome, 'superseded');
});


test('TERMLEASE-01: concurrent reclaimers dispatch only one replacement launch', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'termlease-concurrent-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'acme/repo', prNumber: 404, headSha: HEAD };
  const args = findingsRemediationArgs(rootDir), deps = testDeps();
  acquireAmaCloserLease({ rootDir, ...identity, now: args.dispatchContext.dispatchedAt });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'synthetic-ended' });
  updateAmaCloserLease({ rootDir, ...identity, status: 'terminal', terminalOutcome: 'superseded' });
  const dispatch = () => maybeDispatchAmaCloser({ ...args, ...deps,
    readLaunchRequestStatusImpl: ({ launchRequestId }) => ({ ok: true,
      row: { status: launchRequestId === 'synthetic-ended' ? 'succeeded' : 'running' } }),
  });
  const results = await Promise.all([dispatch(), dispatch()]);
  assert.equal(results.filter(result => result.dispatched).length, 1, JSON.stringify(results));
  assert.equal(deps.calls.filter(call => call.args[0] === 'dispatch' && call.args[1] !== 'status').length, 1);
  assert.equal(readAmaCloserLease(rootDir, identity).lrqId, 'lrq_hammer_1');
});

test('TERMLEASE-01: dispatch supersession keeps the outcome off the superseding head lease', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'termlease-dispatch-supersede-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const oldHead = 'b'.repeat(40);
  const identity = { repo: 'acme/repo', prNumber: 404, headSha: oldHead };
  const args = findingsRemediationArgs(rootDir, { dispatchContext: { dispatchRecordHeadSha: oldHead } });
  const now = args.dispatchContext.dispatchedAt;
  acquireAmaCloserLease({ rootDir, ...identity, now });
  updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: 'synthetic-predecessor' });
  rekeyAmaCloserLease({ rootDir, ...identity, fromHeadSha: oldHead, toHeadSha: HEAD, now });
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity,
    state: 'launch-terminal', workerClass: 'hammer', launchRequestId: 'synthetic-predecessor',
    retryCount: 1, reviewedSha: HEAD, lastObservedStatus: 'succeeded', dispatchedAt: now,
  }));
  appendAmaAuditAttempt({ hqRoot: args.dispatchContext.hqRoot, ...identity, now,
    attempt: { outcome: 'succeeded' } });
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({ ...args, ...deps,
    // The dispatch record and HQ prove completion while the ledger is unreadable.
    // Reconciliation therefore leaves settlement to the dispatch decision path.
    readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'query-failed' }),
    execFileImpl: async (command, argv, options) => argv[0] === 'dispatch' && argv[1] === 'status'
      ? { stdout: JSON.stringify({ status: 'succeeded' }) } : deps.execFileImpl(command, argv, options),
  });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(readAmaCloserLease(rootDir, { ...identity, headSha: HEAD }).status, 'dispatched');
  assert.equal(readAmaCloserLease(rootDir, { ...identity, headSha: HEAD }).lrqId, 'lrq_hammer_1');
  assert.equal(JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity))).outcome, 'superseded');
});

test('TERMLEASE-01: a live dispatch record names its terminal lease on early refusal', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'termlease-live-record-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'acme/repo', prNumber: 404, headSha: HEAD };
  const args = findingsRemediationArgs(rootDir), deps = testDeps();
  const now = args.dispatchContext.dispatchedAt;
  acquireAmaCloserLease({ rootDir, ...identity, now });
  updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: 'synthetic-live' });
  updateAmaCloserLease({ rootDir, ...identity, now, status: 'terminal', terminalOutcome: 'superseded' });
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, workerClass: 'hammer',
    state: 'dispatched', launchRequestId: 'synthetic-live', retryCount: 1,
    dispatchedAt: now, lastObservedAt: now, lastObservedStatus: 'running' }));
  const before = readAmaCloserLease(rootDir, identity);
  const result = await maybeDispatchAmaCloser({ ...args, ...deps,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'running' } }),
    execFileImpl: async () => ({ stdout: JSON.stringify({ status: 'running' }) }),
  });
  assert.equal(result.dispatched, false, JSON.stringify(result));
  assert.match(result.closureBlocker, /terminal lease from launch synthetic-live still live/);
  assert.deepEqual(readAmaCloserLease(rootDir, identity), before);
});

test('OSG-14: assigned hammer changes execution parameters while preserving the closer prompt and lease', async t => {
  const prompts = [];
  const cases = [null, ...['hammer', 'hammer-claude'].flatMap(workerClass =>
    [undefined, null, '', ' ', 'default', 7, 'low'].map(effort => ({ workerClass, effort })))];
  for (const experiment of cases) {
    const rootDir = mkdtempSync(join(tmpdir(), 'osg-hammer-dispatch-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const deps = testDeps();
    const args = findingsRemediationArgs(rootDir, {
      dispatchContext: { repo: 'example/fixture', reviewedBy: 'synthetic-reviewer' },
    });
    const result = await maybeDispatchAmaCloser({ ...args, ...deps,
      env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
      writeFileImpl: (_directory, _path, content) => { prompts.push(content); },
      resolveOsgRemediatorRouteImpl: async ({ current }) => experiment ? {
        ...current, workerClass: experiment.workerClass,
        modelResolution: { resolvedModel: 'fixture-model', resolvedReasoningLevel: experiment.effort },
        osg: { reason: 'assigned', assignment: { assignment_id: 'fixture' },
          accountProposal: { identity: experiment.workerClass, tokenAccountId: 'fixture-account' } },
      } : current,
    });
    assert.equal(result.dispatched, true, JSON.stringify(result));
    const dispatch = deps.calls.find(call => call.args[0] === 'dispatch');
    assert.ok(dispatch.args.every(value => typeof value === 'string'), 'execFile accepts string arguments only');
    assert.equal(flagValue(dispatch.args, '--worker-class'), experiment?.workerClass || 'hammer');
    assert.equal(flagValue(dispatch.args, '--model'), experiment ? 'fixture-model' : undefined);
    assert.equal(dispatch.args.includes('--reasoning-level'), experiment?.effort === 'low');
    if (experiment?.effort === 'low') assert.equal(flagValue(dispatch.args, '--reasoning-level'), 'low');
    assert.equal(result.workerClass, 'hammer', 'logical merge authority is unchanged');
    assert.ok(result.leasePath);
    const audit = readAmaAuditEntry(args.dispatchContext.hqRoot, 'example/fixture', 404, HEAD);
    for (const resolution of [audit.harnessResolution, audit.attempts.at(-1).harnessResolution]) {
      assert.equal(resolution.workerClass, experiment?.workerClass || 'hammer');
      if (experiment) {
        assert.equal(resolution.modelResolution.resolvedModel, 'fixture-model');
        assert.equal(resolution.osgRemediator.assignment.assignment_id, 'fixture');
        assert.equal(resolution.accountProposal.identity, experiment.workerClass);
      }
    }
  }
  assert.equal(prompts.length, cases.length);
  assert.ok(prompts.every(prompt => prompt === prompts[0]), 'execution arm does not rewrite terminal-remediation instructions');
});


test('LEGACYINTENT-01: automatic negative ledger proof releases an old intent for a new closer', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'legacy-redrive-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'sample/project', prNumber: 404, headSha: HEAD };
  const attemptedAt = '2026-07-20T10:00:00Z';
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({
    ...identity, reviewedSha: HEAD, targetRemediationSha: HEAD, state: 'dispatching',
    workerClass: 'hammer', lastAttemptedAt: attemptedAt, retryCount: 1,
  }));
  acquireAmaCloserLease({ rootDir, ...identity, now: attemptedAt, watcherPid: 12345 });
  let queries = 0;
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({
    ...findingsRemediationArgs(rootDir, { dispatchContext: {
      repo: identity.repo, prUrl: 'https://github.com/sample/project/pull/404', reviewedBy: 'synthetic-reviewer',
    } }), ...deps,
    env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
    processKillImpl: () => { throw Object.assign(Error('fixture dead owner'), { code: 'ESRCH' }); },
    readLegacyIntentLaunchesImpl: async query => {
      queries++;
      assert.equal(query.ticketRef, 'AMA-PR-404');
      assert.equal(query.requestedAtOrAfter, attemptedAt);
      return { ok: true, rows: [] };
    },
  });
  assert.equal(queries, 1);
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(deps.calls.filter(call => call.args[0] === 'dispatch').length, 1);
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.state, 'dispatched');
  assert.equal(record.launchRequestId, 'lrq_hammer_1');
  assert.ok(record.dispatchIdempotencyKey);
});

for (const failedCall of [false, true])
for (const patch of [
  { ticketRef: 'CONFLICT-REBASE-404' }, { repo: 'other/project' }, { headSha: 'b'.repeat(40) },
]) test(`CLOSERINTENT-01: dispatch output rejects foreign identity ${JSON.stringify(patch)} (failed call=${failedCall})`, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-identity-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const messages = [];
  const result = await maybeDispatchAmaCloser({ ...findingsRemediationArgs(rootDir), ...testDeps(),
    readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'missing-launch-request-row' }),
    logger: { warn: text => messages.push(text) },
    execFileImpl: async () => {
      const output = { stdout: JSON.stringify({ ticketRef: 'AMA-PR-404',
        repo: 'acme/repo', headSha: HEAD, launchRequestId: 'lrq_other', ...patch }) };
      if (failedCall) throw Object.assign(new Error('synthetic dispatch error'), output);
      return output;
    },
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'non-hammer-launch-not-adopted');
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, { repo: 'acme/repo', prNumber: 404, headSha: HEAD })));
  assert.equal(record.state, 'no-dispatch');
  assert.equal(record.reason, 'non-hammer-launch-not-adopted');
  assert.equal(record.retryCount, 0);
  assert.equal(record.lastError, null);
  assert.equal(record.launchRequestId, null);
  assert.equal(record.dispatchId, null);
  assert.equal(record.unadoptedLaunchRequestId, 'lrq_other');
  const lease = readAmaCloserLease(rootDir, record);
  assert.equal(lease.status, 'terminal');
  assert.equal(lease.terminalOutcome, 'superseded');
  assert.equal(lease.lrqId, null);
  assert.equal(existsSync(record.scratchDir), false);
  assert.equal(existsSync(record.promptPath), false);
  const next = await maybeDispatchAmaCloser({ ...findingsRemediationArgs(rootDir), ...testDeps(),
    readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'missing-launch-request-row' }),
  });
  assert.equal(next.dispatched, true, JSON.stringify(next));
  assert.ok(messages.some(line => line.includes('launch_identity_mismatch')));
});

test('CLOSERINTENT-01: new submitting intent cannot inherit the previous attempt receipt', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-predecessor-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'acme/repo', prNumber: 404, headSha: HEAD };
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, reviewedSha: HEAD,
    targetRemediationSha: HEAD, workerClass: 'hammer', state: 'dispatch-failed', retryCount: 1,
    launchRequestId: 'lrq_previous', dispatchId: 'dispatch_previous',
    dispatchedAt: '2026-07-20T10:00:00Z', lastObservedStatus: 'failed' }));
  let submitted = false;
  const result = await maybeDispatchAmaCloser({ ...findingsRemediationArgs(rootDir), ...testDeps(),
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'failed' } }),
    execFileImpl: async (_cmd, args) => {
      if (args[0] !== 'dispatch' || args[1] === 'status') return { stdout: '{"status":"failed"}' };
      submitted = true;
      const intent = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity)));
      assert.equal(intent.dispatchPhase, 'submitting');
      assert.ok(intent.dispatchIdempotencyKey);
      assert.equal(intent.launchRequestId, null);
      assert.equal(intent.dispatchId, null);
      return { stdout: JSON.stringify({ ticketRef: 'AMA-PR-404', launchRequestId: 'lrq_new' }) };
    },
  });
  assert.equal(submitted, true, JSON.stringify(result));
  assert.equal(result.dispatched, true, JSON.stringify(result));
});

for (const failedCall of [false, true]) test(`CLOSERINTENT-01: missing ticket evidence logs an unverified receipt (failed call=${failedCall})`, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-unverified-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const messages = [];
  const result = await maybeDispatchAmaCloser({ ...findingsRemediationArgs(rootDir), ...testDeps(),
    readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'missing-launch-request-row' }),
    logger: { warn: text => messages.push(text) },
    execFileImpl: async () => {
      const output = { stdout: JSON.stringify({ launchRequestId: 'lrq_unverified' }) };
      if (failedCall) throw Object.assign(new Error('synthetic dispatch error'), output);
      return output;
    },
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'dispatch-receipt-unverified');
  assert.ok(messages.some(line => line.includes('ama_closer.launch_receipt_unverified')));
  assert.ok(messages.every(line => !line.includes('ama_closer.launch_identity_mismatch')));
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, { repo: 'acme/repo', prNumber: 404, headSha: HEAD })));
  assert.equal(record.state, 'dispatching');
  assert.equal(record.launchRequestId, null);
  assert.equal(readAmaCloserLease(rootDir, record).status, 'pending');
});
for (const status of ['succeeded', 'failed', 'canceled', 'superseded']) {
  test(`SDK wire terminal false retains closer ownership for ${status}`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'dispatch-wire-false-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const args = findingsRemediationArgs(rootDir);
    const identity = { repo: args.dispatchContext.repo, prNumber: 404, headSha: HEAD };
    const now = args.dispatchContext.dispatchedAt;
    acquireAmaCloserLease({ rootDir, ...identity, now });
    updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: 'synthetic-owner' });
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, state: 'dispatched',
      workerClass: 'hammer', launchRequestId: 'synthetic-owner', retryCount: 1,
      reviewedSha: HEAD, dispatchedAt: now, lastObservedAt: now, lastObservedStatus: 'starting' }));
    const payload = { status, terminal: false, succeeded: false };
    const deps = testDeps();
    const result = await maybeDispatchAmaCloser({ ...args, ...deps,
      readLaunchRequestStatusImpl: () => ({ ok: true, row: payload }),
      execFileImpl: async (_command, argv) => {
        assert.deepEqual(argv.slice(0, 2), ['dispatch', 'status'], 'no replacement dispatch');
        return { stdout: JSON.stringify(payload) };
      },
      cleanupScratchImpl: () => assert.fail('nonterminal owner retains scratch'),
    });
    assert.equal(result.dispatched, false);
    assert.equal(result.skipMergeAgent, true);
    assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
    assert.equal(readAmaCloserLease(rootDir, identity).lrqId, 'synthetic-owner');
  });
}

for (const status of [null, 'starting', 'running', 'future'])
for (const source of ['dispatch probe', 'preflight ledger', 'stale starting worker', 'unknown worker']) {
  for (const succeeded of [false, true]) {
    test(`SDK terminal evidence records ${source} success=${succeeded} status=${status}`, async t => {
      const rootDir = mkdtempSync(join(tmpdir(), 'dispatch-wire-terminal-'));
      t.after(() => rmSync(rootDir, { recursive: true, force: true }));
      const args = findingsRemediationArgs(rootDir, { dispatchContext: {
        reviewCycleCapReached: true, dispatchReason: 'exhausted-final-hammer',
        livePrProbeImpl: async () => ({ state: 'UNKNOWN' }),
      } });
      const identity = { repo: args.dispatchContext.repo, prNumber: 404, headSha: HEAD };
      const now = args.dispatchContext.dispatchedAt;
      // No lease: exercise dispatch reconciliation rather than early lease repair.
      updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, state: 'dispatched',
        workerClass: 'hammer', launchRequestId: 'synthetic-owner', retryCount: 2,
        reviewedSha: HEAD, dispatchedAt: now, lastObservedAt: now, lastObservedStatus: 'starting' }));
      const payload = { status, terminal: true, succeeded };
      const deps = testDeps();
      const result = await maybeDispatchAmaCloser({ ...args, ...deps,
        readLaunchRequestStatusImpl: () => source !== 'dispatch probe'
          ? { ok: true, row: payload } : { ok: false },
        execFileImpl: async (_command, argv) => {
          assert.deepEqual(argv.slice(0, 2), ['dispatch', 'status'], 'unknown PR evidence prevents redispatch');
          return { stdout: JSON.stringify(source === 'dispatch probe' ? payload
            : { status: source === 'stale starting worker' ? 'starting' : 'future' }) };
        },
      });
      const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
      assert.equal(record.state, 'launch-terminal', JSON.stringify({ result, record }));
      assert.equal(record.terminalLaunchStatus, succeeded ? 'succeeded' : 'failed');
      assert.equal(record.lastObservedStatus, succeeded ? 'unverified-terminal-success' : 'failed');
    });
  }
}

for (const withLease of [false, true])
for (const status of ['succeeded', 'starting', 'running', 'future']) {
  test(`SDK terminal evidence rejects non-success during preflight recording status=${status} withLease=${withLease}`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'dispatch-wire-success-false-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const args = findingsRemediationArgs(rootDir);
    const identity = { repo: args.dispatchContext.repo, prNumber: 404, headSha: HEAD };
    const now = args.dispatchContext.dispatchedAt;
    if (withLease) {
      acquireAmaCloserLease({ rootDir, ...identity, now });
      updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: 'synthetic-owner' });
    }
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, state: 'dispatched',
      workerClass: 'hammer', launchRequestId: 'synthetic-owner', retryCount: 1,
      reviewedSha: HEAD, dispatchedAt: now, lastObservedAt: now, lastObservedStatus: 'starting' }));
    await maybeDispatchAmaCloser({ ...args, ...testDeps(),
      readLaunchRequestStatusImpl: () => ({ ok: true,
        row: { status, terminal: true, succeeded: false } }),
      execFileImpl: async () => ({ stdout: JSON.stringify({ status: 'future' }) }),
    });
    const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
    assert.equal(record.state, 'launch-terminal');
    assert.equal(record.terminalLaunchStatus, 'failed');
    assert.equal(record.lastObservedStatus, 'failed');
  });
}

for (const advanced of [false, true]) {
  for (const signalHead of ['shaN', 'matching', 'reviewed', 'foreign', null]) {
    test(`MERGESIGNAL-01: ${advanced ? 'advanced target' : 'reviewed'} head with ${signalHead} signal`, async t => {
      const rootDir = mkdtempSync(join(tmpdir(), 'merge-signal-head-'));
      t.after(() => rmSync(rootDir, { recursive: true, force: true }));
      const target = advanced ? 'b'.repeat(40) : HEAD;
      const repo = `acme/merge-signal-${advanced}-${signalHead}`;
      const producer = signalHead === 'matching' ? target : signalHead === 'reviewed' ? HEAD : signalHead === 'foreign' ? 'c'.repeat(40) : signalHead;
      const logs = [];
      let signalReads = 0;
      const deps = testDeps();
      const result = await maybeDispatchAmaCloser({
        ...cleanValidateAndClickArgs(rootDir, {
          prMetadata: { headSha: target,
            statusCheckRollup: [{ __typename: 'CheckRun', name: REQUIRED_GATE, conclusion: 'SUCCESS' },
              { __typename: 'CheckRun', name: 'ci/test', status: 'IN_PROGRESS' }],
            branchProtection: { requiredContexts: [REQUIRED_GATE, 'ci/test'] },
          },
          reviewState: { reviewCycleExhausted: true },
          dispatchContext: { repo, prUrl: `https://github.com/${repo}/pull/404`,
            targetRemediationSha: target, allowStaleReviewHeadHammerResume: true },
        }),
        ...deps,
        logger: { info: line => logs.push(JSON.parse(line)), log() {}, warn() {} },
        readBuildCompletionProducerEvidenceImpl: () => signalHead === 'reviewed'
          ? { ok: false, reason: 'missing-build-completion-producer-evidence' }
          : { ok: true, row: { producer_class: 'synthetic-producer' } },
        readBuildCompletionSignalForPrImpl: () => {
          signalReads += 1;
          return { ok: true, row: {
            head_sha: producer, completion_id: 'synthetic-completion', signal_kind: 'merged',
          } };
        },
      });
      assert.equal(signalReads, 1, 'only the current target head is probed');
      const mismatches = logs.filter(row => row.event === 'ama_closer.merged_signal_head_mismatch');
      if (signalHead === 'matching' || (!advanced && signalHead === 'reviewed')) {
        assert.equal(result.reason, 'merged-signal-present');
        assert.equal(result.dispatched, false);
        assert.equal(mismatches.length, 0);
      } else {
        assert.notEqual(result.reason, 'merged-signal-present');
        assert.equal(result.dispatched, true, JSON.stringify(result));
        assert.notEqual(readAmaCloserLease(rootDir, { repo, prNumber: 404, headSha: target })?.terminalOutcome, 'succeeded');
        assert.equal(mismatches.length, 1, 'unmatched signal logs once per dispatch cycle');
        assert.equal(mismatches[0].expectedHeadSha, target);
        assert.equal(Object.hasOwn(mismatches[0], 'reviewedHeadSha'), false);
        const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, {
          repo, prNumber: 404, headSha: target,
        }), 'utf8'));
        assert.equal(record.targetRemediationSha, target, 'hammer dispatch owns the current target');
      }
    });
  }
}

test('MERGESIGNAL-01: foreign signal does not settle lease and logs once for its head', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'merge-signal-lease-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'example/synthetic-signal', prNumber: 51, headSha: HEAD };
  const now = '2026-07-20T12:00:00Z';
  acquireAmaCloserLease({ rootDir, ...identity, now });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_synthetic', now });
  const before = readAmaCloserLease(rootDir, identity);
  const logs = [];
  const args = {
    rootDir, ...identity, now,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }),
    readPullRequestStateImpl: () => ({ state: 'OPEN' }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: true, row: {
      head_sha: 'shaN', completion_id: 'synthetic-completion', signal_kind: 'merged',
    } }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: true, row: {} }),
    logger: { info: line => logs.push(JSON.parse(line)) },
  };
  assert.equal(reconcileAmaCloserLease(args), false);
  assert.equal(reconcileAmaCloserLease(args), false);
  assert.deepEqual(readAmaCloserLease(rootDir, identity), before);
  const mismatches = logs.filter(row => row.event === 'ama_closer.merged_signal_head_mismatch');
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].producerHeadSha, 'shan');
  assert.equal(mismatches[0].completionId, 'synthetic-completion');
  const advanced = 'b'.repeat(40);
  rekeyAmaCloserLease({ rootDir, ...identity, fromHeadSha: HEAD, toHeadSha: advanced, now });
  assert.equal(reconcileAmaCloserLease({ ...args, headSha: advanced }), false);
  assert.equal(logs.filter(row => row.event === 'ama_closer.merged_signal_head_mismatch').length, 2);
});

for (const length of [40, 64]) {
  for (const uppercaseExpected of [false, true]) {
    test(`MERGESIGNAL-01: ${length}-digit mixed-case signal matches uppercaseExpected=${uppercaseExpected}`, t => {
      const rootDir = mkdtempSync(join(tmpdir(), 'merge-signal-case-'));
      t.after(() => rmSync(rootDir, { recursive: true, force: true }));
      const headSha = 'abcdef12'.repeat(length / 8);
      const identity = { repo: 'example/synthetic-case', prNumber: 52,
        headSha: uppercaseExpected ? headSha.toUpperCase() : headSha };
      const now = '2026-07-20T12:00:00Z';
      acquireAmaCloserLease({ rootDir, ...identity, now });
      updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_synthetic', now });
      const logs = [];
      assert.equal(reconcileAmaCloserLease({
        rootDir, ...identity, now,
        readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }),
        readPullRequestStateImpl: () => assert.fail('matching merge signal supplies success evidence'),
        readBuildCompletionSignalForPrImpl: () => ({ ok: true, row: {
          head_sha: `  ${'aBcDeF12'.repeat(length / 8)}  `, signal_kind: 'merged',
        } }),
        readBuildCompletionProducerEvidenceImpl: () => assert.fail('matching signal needs no absence evidence'),
        logger: { info: line => logs.push(JSON.parse(line)) },
      }), true);
      assert.equal(readAmaCloserLease(rootDir, identity).terminalOutcome, 'succeeded');
      assert.equal(logs.filter(row => row.event === 'ama_closer.merged_signal_head_mismatch').length, 0);
    });
  }
}

test('MERGESIGNAL-01: null logger preserves foreign-signal absence fallback', t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'merge-signal-null-logger-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'example/synthetic-null-logger', prNumber: 53, headSha: HEAD };
  const now = '2026-07-20T12:00:00Z';
  acquireAmaCloserLease({ rootDir, ...identity, now });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_synthetic', now });
  const before = readAmaCloserLease(rootDir, identity);
  let producerReads = 0;
  assert.equal(reconcileAmaCloserLease({
    rootDir, ...identity, now, logger: null,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }),
    readPullRequestStateImpl: () => null,
    readBuildCompletionSignalForPrImpl: () => ({ ok: true, row: {
      head_sha: 'b'.repeat(40), signal_kind: 'merged',
    } }),
    readBuildCompletionProducerEvidenceImpl: () => {
      producerReads += 1;
      return { ok: true, row: {} };
    },
  }), false);
  assert.equal(producerReads, 1, 'null logging must not interrupt absence evidence');
  assert.deepEqual(readAmaCloserLease(rootDir, identity), before);
});

test('CLOSERPENDINGDEAD-01: background submission persists watcher and child identities before receipt', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-submitter-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = findingsRemediationArgs(rootDir);
  const identity = { repo: args.dispatchContext.repo, prNumber: args.prMetadata.prNumber, headSha: HEAD };
  let submitted = false;
  const result = await maybeDispatchAmaCloser({ ...args, ...testDeps(),
    env: args.options.env,
    processExecFileImpl: async (command, psArgs, options) => {
      assert.equal(command, 'ps');
      assert.deepEqual(psArgs.slice(0, 3), ['-o', 'lstart=', '-p']);
      assert.ok(options.timeout <= 1000);
      assert.equal(options.env.ADV_GATE_STATUS_CONTEXT, REQUIRED_GATE);
      await new Promise(resolve => setImmediate(resolve));
      return { stdout: 'Thu Oct 22 10:18:18 2026\n' };
    },
    execFileImpl: (command, dispatchArgs) => {
      assert.equal(dispatchArgs[0], 'dispatch');
      submitted = true;
      const submission = new Promise(resolve => setImmediate(() => setImmediate(resolve))).then(() => {
        const intent = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity)));
        assert.deepEqual(intent.dispatchWatcher, { pid: process.pid, startedAt: '2026-10-22T10:18:18.000Z' });
        assert.deepEqual(intent.dispatchSubmitter, { pid: 12346, startedAt: '2026-10-22T10:18:18.000Z' });
        assert.equal(intent.dispatchPhase, 'submitting');
        assert.equal(intent.launchRequestId, null);
        return { stdout: JSON.stringify({ ticketRef: `AMA-PR-${identity.prNumber}`, launchRequestId: 'lrq_synthetic_child' }) };
      });
      submission.child = { pid: 12346 };
      return submission;
    },
  });
  assert.equal(submitted, true, JSON.stringify(result));
  assert.equal(result.dispatched, true, JSON.stringify(result));
});

test('CLOSERPENDINGDEAD-01: submission rejection is observed during asynchronous child capture', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-submitter-rejection-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = findingsRemediationArgs(rootDir);
  const identity = { repo: args.dispatchContext.repo, prNumber: args.prMetadata.prNumber, headSha: HEAD };
  let childCaptured = false;
  const result = await maybeDispatchAmaCloser({ ...args, ...testDeps(),
    processExecFileImpl: async (_command, psArgs) => {
      if (psArgs.at(-1) === '12346') {
        await new Promise(resolve => setImmediate(resolve));
        childCaptured = true;
      }
      return { stdout: 'Thu Oct 22 10:18:18 2026\n' };
    },
    execFileImpl: () => {
      const submission = Promise.reject(new Error('synthetic submission refused'));
      submission.child = { pid: 12346 };
      return submission;
    },
  });
  assert.equal(childCaptured, true);
  assert.equal(result.dispatched, false);
  const intent = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity)));
  assert.match(intent.lastError, /synthetic submission refused/);
});

for (const replacement of ['state', 'key', 'missing']) {
  test(`CLOSERPENDINGDEAD-01: submitter identity preserves ${replacement} intent replacement`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'closer-submitter-replaced-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const args = findingsRemediationArgs(rootDir);
    const identity = { repo: args.dispatchContext.repo, prNumber: args.prMetadata.prNumber, headSha: HEAD };
    const path = amaCloserDispatchFilePath(rootDir, identity);
    let checked = false;
    const result = await maybeDispatchAmaCloser({ ...args, ...testDeps(),
      processExecFileImpl: async () => ({ stdout: 'Thu Oct 22 10:18:18 2026\n' }),
      execFileImpl: () => {
        const original = readFileSync(path, 'utf8');
        const changed = { ...JSON.parse(original), ...(replacement === 'state'
          ? { state: 'completed' } : { dispatchIdempotencyKey: 'synthetic-replacement-key' }) };
        // Model an out-of-band writer that bypasses the held intent fence.
        if (replacement === 'missing') rmSync(path);
        else writeFileSync(path, JSON.stringify(changed));
        const submission = new Promise(resolve => setImmediate(resolve)).then(() => {
          if (replacement === 'missing') assert.equal(existsSync(path), false);
          else assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), changed);
          checked = true;
          // Restore the fixture before the separate receipt persistence path.
          writeFileSync(path, original);
          return { stdout: JSON.stringify({ ticketRef: `AMA-PR-${identity.prNumber}`, launchRequestId: 'lrq_synthetic_child' }) };
        });
        submission.child = { pid: 12346 };
        return submission;
      },
    });
    assert.equal(checked, true, JSON.stringify(result));
    assert.equal(result.dispatched, true, JSON.stringify(result));
  });
}

test('CLOSERPENDINGDEAD-01: one poll re-takes a dead intent through ordinary dispatch admission', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closer-dead-intent-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = findingsRemediationArgs(rootDir);
  const identity = { repo: args.dispatchContext.repo, prNumber: args.prMetadata.prNumber, headSha: HEAD };
  const at = args.dispatchContext.dispatchedAt;
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, targetRemediationSha: HEAD,
    state: 'dispatching', dispatchPhase: 'submitting', dispatchIdempotencyKey: 'ama-closer-synthetic-dead',
    lastAttemptedAt: at, dispatchTimeoutMs: 2_700_000, retryCount: 1, workerClass: 'hammer' }));
  acquireAmaCloserLease({ rootDir, ...identity, watcherPid: 12345, now: at });
  const deps = testDeps();
  const result = await maybeDispatchAmaCloser({ ...args, ...deps,
    processKillImpl: () => { throw Object.assign(Error('synthetic dead'), { code: 'ESRCH' }); },
    processExecFileSyncImpl: (_command, psArgs) => psArgs[0] === '-axww'
      ? '99 Thu Oct 22 10:18:18 2026 synthetic-process\n' : 'Thu Oct 22 10:18:18 2026\n',
    processExecFileImpl: async () => ({ stdout: 'Thu Oct 22 10:18:18 2026\n' }),
    readIntentReceiptImpl: () => ({ ok: true, rows: [] }),
    readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'missing-launch-request-row' }),
  });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(deps.calls.filter(call => call.args[0] === 'dispatch').length, 1);
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
});

for (const finalHammer of [false, true]) {
  test(`LVR-02 producer no_work_done records failure and preserves refund policy (final=${finalHammer})`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'no-work-done-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const currentHead = 'b'.repeat(40);
    const args = findingsRemediationArgs(rootDir, {
      reviewState: { headSha: HEAD, reviewCycleExhausted: true },
      prMetadata: { headSha: currentHead },
      dispatchContext: { reviewedSha: HEAD, targetRemediationSha: currentHead, dispatchRecordHeadSha: HEAD,
        allowStaleReviewHeadHammerResume: true,
        ...(finalHammer ? { dispatchReason: 'exhausted-final-hammer' } : {}),
        livePrProbeImpl: async () => ({ state: 'OPEN', headRefOid: currentHead, headBranchExists: true }) },
    });
    const identity = { repo: args.dispatchContext.repo, prNumber: 404, headSha: HEAD };
    const now = args.dispatchContext.dispatchedAt;
    acquireAmaCloserLease({ rootDir, ...identity, now });
    updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: 'synthetic-first' });
    rekeyAmaCloserLease({ rootDir, ...identity, fromHeadSha: HEAD, toHeadSha: currentHead, now });
    updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, state: 'dispatched',
      workerClass: 'hammer', launchRequestId: 'synthetic-first', retryCount: 1,
      reviewedSha: HEAD, dispatchedAt: now, lastObservedAt: now, lastObservedStatus: 'starting',
      ...(finalHammer ? { dispatchReason: 'exhausted-final-hammer' } : {}) }));
    const { recordHammerRetryDispatch, readHammerRetryCapLedger } = await import('../src/ama/hammer-retry-cap.mjs');
    recordHammerRetryDispatch(rootDir, identity, { jobKey: HEAD, headSha: HEAD, now });
    const deps = testDeps();
    const exec = deps.execFileImpl;
    deps.execFileImpl = (cmd, argv, options) => argv[0] === 'dispatch' && argv[1] === 'status'
      ? Promise.resolve({ stdout: JSON.stringify({ status: 'failed' }) }) : exec(cmd, argv, options);
    const result = await maybeDispatchAmaCloser({ ...args, ...deps,
      readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'failed', failure_class: 'no_work_done' } }),
      readPullRequestStateImpl: () => ({ state: 'OPEN', headRefOid: currentHead }),
      fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', headSha: currentHead, comments: [] }),
    });
    assert.equal(result.dispatched, true, JSON.stringify(result));
    const record = readAmaCloserDispatchRecord(rootDir, identity);
    assert.equal(record.lastObservedStatus, 'failed');
    assert.equal(record.failure, 'no_work_done', JSON.stringify(record));
    assert.match(record.failureReason, /open PR and no terminal audit/);
    const ledger = readHammerRetryCapLedger(rootDir, identity);
    assert.equal(ledger.lifetimeAttemptCount, 2);
    assert.equal(ledger.attemptCount, finalHammer ? 2 : 1);
  });
}
