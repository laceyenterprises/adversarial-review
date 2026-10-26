import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { maybeDispatchAmaCloser, readAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { createLaneRoutingController } from '../src/finalization/queue-routing.mjs';
import { resolveQueueOwnerAdapter } from '../src/finalization/queue-owner.mjs';
import { readAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { createQueueHandoffService } from '../src/finalization/queue-handoff-store.mjs';
import { queueHandoffFixture } from './helpers/queue-handoff-fixture.mjs';

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
      reviewedBy: 'example-reviewer',
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


test('MGQ-10: migrated dispatch renders once with no legacy merge procedures', async () => {
  const { openFinalizationQueueStore } = await import('../src/finalization/queue-store.mjs');
  const { createLaneRoutingController } = await import('../src/finalization/queue-routing.mjs');
  const rootDir = mkdtempSync(join(tmpdir(), 'queue-dispatch-'));
  const store = openFinalizationQueueStore({ rootDir });
  try {
    const lane = { repository: 'example/review', base: 'main' };
    const laneRoutes = [{ ...lane, executor: 'queue-v2' }];
    await createLaneRoutingController({ store }).transfer({ cfg: { laneRoutes }, lane, expectedGeneration: 0,
      drainAdapter: { read: async () => ({ quiescent: true, sourceRef: 'fixture:drain', results: {} }) } });
    const deps = testDeps(); let prompt;
    deps.guardStackedBaseImpl = async () => null;
    deps.writeFileImpl = (_dir, _path, body) => { prompt = body; };
    const args = findingsRemediationArgs(rootDir, { cfg: { laneRoutes }, prMetadata: { baseBranch: lane.base },
      dispatchContext: { repo: lane.repository, baseBranch: lane.base,
        queueCloser: { handoffInstructions: 'Use the composed handoff service with literal <<RUN_DIR>> and <<REPO>>.', handoff: async () => {} } } });
    const result = await maybeDispatchAmaCloser({ ...args, ...deps });
    assert.equal(result.dispatched, true, JSON.stringify(result));
    const launch = deps.calls.find(c => c.args.includes('--completion-shape'));
    assert.equal(launch.args[launch.args.indexOf('--completion-shape') + 1], 'branch-push');
    assert.equal(launch.args[launch.args.indexOf('--required-outcome') + 1], 'push');
    assert.match(prompt, /Queue remediation closer/);
    assert.match(prompt, /Exit successfully/);
    assert.match(prompt, /literal <<RUN_DIR>> and <<REPO>>/);
    assert.doesNotMatch(prompt.replace('literal <<RUN_DIR>> and <<REPO>>', ''), /<<|ham_merge_phase\(/);
    const record = readAmaCloserDispatchRecord(rootDir, { repo: lane.repository, prNumber: 404, headSha: HEAD });
    assert.equal(readdirSync(record.scratchDir).some(name => /^hammer-(verify-head|publish|merge)\.sh$/.test(name)), false);
  } finally { store.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test('legacy closer launches while another writer holds the lane flock without preflight writes', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'legacy-locked-dispatch-'));
  const store = openFinalizationQueueStore({ rootDir });
  const lane = { repository: 'example/review', base: 'main' };
  const release = resolveQueueOwnerAdapter(store).tryLock(lane);
  try {
    assert.equal(typeof release, 'function');
    const before = store.db.serialize();
    const deps = testDeps();
    deps.guardStackedBaseImpl = async () => null;
    const args = findingsRemediationArgs(rootDir, { prMetadata: { baseBranch: lane.base },
      dispatchContext: { repo: lane.repository, baseBranch: lane.base } });
    const result = await maybeDispatchAmaCloser({ ...args, ...deps });
    assert.equal(result.dispatched, true, JSON.stringify(result));
    assert.deepEqual(store.db.serialize(), before);
  } finally { release?.(); store.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test('missing queue prompt input returns a structured refusal and releases the unsubmitted lease', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'queue-prompt-missing-'));
  const store = openFinalizationQueueStore({ rootDir });
  try {
    const lane = { repository: 'example/review', base: 'main' };
    const cfg = { laneRoutes: [{ ...lane, executor: 'queue-v2' }] };
    await createLaneRoutingController({ store }).transfer({ cfg, lane, expectedGeneration: 0,
      drainAdapter: { read: async () => ({ quiescent: true, sourceRef: 'fixture:drain', results: {} }) } });
    for (const missing of ['prUrl', 'riskClass']) {
      const deps = testDeps();
      deps.guardStackedBaseImpl = async () => null;
      const args = findingsRemediationArgs(rootDir, { cfg, prMetadata: { baseBranch: lane.base },
        dispatchContext: { repo: lane.repository, baseBranch: lane.base, [missing]: undefined,
          queueCloser: { handoffInstructions: 'Use the composed handoff service.', handoff: async () => {} } } });
      const result = await maybeDispatchAmaCloser({ ...args, ...deps });
      assert.equal(result.reason, 'queue-closer-prompt-input-missing', JSON.stringify(result));
      assert.equal(result.skipMergeAgent, true);
      assert.equal(deps.calls.length, 0);
      const lease = readAmaCloserLease(rootDir, { repo: lane.repository, prNumber: 404, headSha: HEAD });
      assert.equal(lease.status, 'terminal');
      assert.equal(lease.terminalOutcome, 'deferred');
      assert.equal(readAmaCloserDispatchRecord(rootDir, { repo: lane.repository, prNumber: 404, headSha: HEAD }), null);
      assert.deepEqual(readdirSync(join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-prompts')), []);
    }
  } finally { store.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test('late durable ack after route preflight: twenty consecutive dispatch decisions under the existing single-flight', async t => {
  let duplicates = 0, confirmed = 0;
  for (let i = 0; i < 20; i++) {
    const rootDir = mkdtempSync(join(tmpdir(), 'late-ack-'));
    const store = openFinalizationQueueStore({ rootDir });
    try {
      const lane = { repository: 'example/review', base: 'main' };
      const cfg = { laneRoutes: [{ ...lane, executor: 'queue-v2' }] };
      await createLaneRoutingController({ store }).transfer({ cfg, lane, expectedGeneration: 0,
        drainAdapter: { read: async () => ({ quiescent: true, sourceRef: 'fixture:drain', results: {} }) } });
      const original = queueHandoffFixture(404);
      const { h, e } = JSON.parse(JSON.stringify(original).replaceAll('b'.repeat(40), HEAD));
      const service = createQueueHandoffService({ store, evidenceAdapter: { read: async () => e } });
      const deps = testDeps();
      deps.guardStackedBaseImpl = async () => {
        // The first dispatcher route/ack read has completed. A previous closer
        // commits its handoff while this wake is suspended in a live read.
        await service.submit(h); return null;
      };
      const args = findingsRemediationArgs(rootDir, { cfg, prMetadata: { baseBranch: lane.base },
        dispatchContext: { repo: lane.repository, baseBranch: lane.base,
          queueCloser: { handoffInstructions: 'Use the composed handoff service.', handoff: async () => {} } } });
      const result = await maybeDispatchAmaCloser({ ...args, ...deps });
      duplicates += deps.calls.filter(c => c.args.includes('--prompt')).length;
      confirmed += Number(result.reason === 'queue-handoff-acknowledged');
      assert.equal(store.entries(lane).length, 1);
    } finally { store.close(); rmSync(rootDir, { recursive: true, force: true }); }
  }
  t.diagnostic(`late-ack trials=20 duplicate closer launches=${duplicates} confirmed acknowledgements=${confirmed}`);
  assert.equal(duplicates, 0); assert.equal(confirmed, 20);
});
