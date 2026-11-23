import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { maybeDispatchAmaCloser, readAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { createLaneRoutingController } from '../src/finalization/queue-routing.mjs';
import { resolveQueueOwnerAdapter } from '../src/finalization/queue-owner.mjs';
import { readAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { createQueueHandoffService } from '../src/finalization/queue-handoff-store.mjs';
import { queueHandoffFixture } from './helpers/queue-handoff-fixture.mjs';
import { hammerQueueInputs } from '../src/finalization/hammer-queue-command.mjs';

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


test('MRQ-21: migrated dispatch renders the ordinary hammer whose controller ends at the queue handoff', async () => {
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
        queueCloser: { hammerHandoffCommand: ['/fixture/installed handoff', '--lane', "it's"] } } });
    const result = await maybeDispatchAmaCloser({ ...args, ...deps });
    assert.equal(result.dispatched, true, JSON.stringify(result));
    // The required outcome is the terminal audit the admitted handoff writes.
    const launch = deps.calls.find(c => c.args.includes('--completion-shape'));
    assert.equal(launch.args[launch.args.indexOf('--completion-shape') + 1], 'decision-only');
    assert.equal(launch.args[launch.args.indexOf('--required-outcome') + 1], 'terminal-audit');
    assert.match(prompt, /^hammer prompt /, 'the ordinary hammer prompt, not a queue-only prompt');
    assert.doesNotMatch(prompt, /<</);
    const record = readAmaCloserDispatchRecord(rootDir, { repo: lane.repository, prNumber: 404, headSha: HEAD });
    const files = readdirSync(record.scratchDir);
    for (const name of ['hammer-bootstrap.sh', 'hammer-verify-head.sh', 'hammer-publish.sh', 'hammer-merge.sh']) {
      assert.ok(files.includes(name), `${name} missing: ${files.join(', ')}`);
    }
    const bootstrap = readFileSync(join(record.scratchDir, 'hammer-bootstrap.sh'), 'utf8');
    const line = bootstrap.split('\n').find(l => l.startsWith('export HAM_FINALIZATION_EXECUTOR='));
    assert.ok(line, bootstrap);
    // The rendered inputs line round-trips through the shell unchanged.
    const echoed = execFileSync('/bin/bash', ['-c', `${line}\nprintf '%s\\n' "$HAM_FINALIZATION_EXECUTOR" "$HAM_QUEUE_ROUTE_GENERATION" "$HAM_QUEUE_HANDOFF_COMMAND" "$HAM_QUEUE_CLOSER_WORKER_CLASS" "$HAM_QUEUE_CLOSER_WORKER_ID"`],
      { encoding: 'utf8' }).split('\n');
    assert.equal(echoed[0], 'queue-v2');
    assert.equal(echoed[1], '1');
    assert.deepEqual(JSON.parse(echoed[2]), ['/fixture/installed handoff', '--lane', "it's"]);
    assert.ok(echoed[3]);
    assert.equal(echoed[4], record.workerId);
    assert.ok(echoed[4]);
  } finally { store.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test('MRQ-21: queue inputs reject unavailable closer identity at render time', () => {
  const inputs = { routeGeneration: 1, handoffCommand: ['/fixture/installed-handoff'],
    workerId: 'closer-1', workerClass: 'hammer' };
  for (const field of ['workerId', 'workerClass']) {
    for (const value of [undefined, null, '', ' \t', false, 0]) {
      assert.throws(() => hammerQueueInputs({ ...inputs, [field]: value }),
        /queue hammer inputs require a non-empty closer worker identity/);
    }
  }
});

test('MRQ-21: a legacy lane renders no queue inputs and keeps its decision-only terminal-audit launch', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'legacy-dispatch-'));
  try {
    const deps = testDeps();
    deps.guardStackedBaseImpl = async () => null;
    const args = findingsRemediationArgs(rootDir, { prMetadata: { baseBranch: 'main' },
      dispatchContext: { repo: 'example/review', baseBranch: 'main',
        queueCloser: { hammerHandoffCommand: ['/fixture/installed-handoff'] } } });
    const result = await maybeDispatchAmaCloser({ ...args, ...deps });
    assert.equal(result.dispatched, true, JSON.stringify(result));
    const launch = deps.calls.find(c => c.args.includes('--completion-shape'));
    assert.equal(launch.args[launch.args.indexOf('--completion-shape') + 1], 'decision-only');
    assert.equal(launch.args[launch.args.indexOf('--required-outcome') + 1], 'terminal-audit');
    const record = readAmaCloserDispatchRecord(rootDir, { repo: 'example/review', prNumber: 404, headSha: HEAD });
    const bootstrap = readFileSync(join(record.scratchDir, 'hammer-bootstrap.sh'), 'utf8');
    assert.doesNotMatch(bootstrap, /HAM_FINALIZATION_EXECUTOR|HAM_QUEUE_|<<QUEUE_INPUTS>>/);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
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

test('MRQ-21: a queue lane with a missing dispatch input fails exactly like a legacy lane', async () => {
  // The queue-only prompt and its queue-closer-prompt-input-missing refusal are
  // retired: a queue lane renders the ordinary hammer, with legacy's behavior.
  const observe = async (rootDir, cfg, missing) => {
    const deps = testDeps();
    deps.guardStackedBaseImpl = async () => null;
    const args = findingsRemediationArgs(rootDir, { cfg, prMetadata: { baseBranch: 'main' },
      dispatchContext: { repo: 'example/review', baseBranch: 'main', [missing]: undefined,
        queueCloser: { hammerHandoffCommand: ['/fixture/installed-handoff'] } } });
    let outcome;
    try { outcome = { result: await maybeDispatchAmaCloser({ ...args, ...deps }) }; }
    catch (error) { outcome = { error: error.message }; }
    const lease = readAmaCloserLease(rootDir, { repo: 'example/review', prNumber: 404, headSha: HEAD });
    return { ...outcome, launches: deps.calls.filter(c => c.args.includes('--prompt')).length,
      leaseStatus: lease?.status ?? null, leaseOutcome: lease?.terminalOutcome ?? null,
      record: Boolean(readAmaCloserDispatchRecord(rootDir, { repo: 'example/review', prNumber: 404, headSha: HEAD })) };
  };
  for (const missing of ['prUrl', 'riskClass']) {
    const queueRoot = mkdtempSync(join(tmpdir(), 'queue-input-missing-'));
    const legacyRoot = mkdtempSync(join(tmpdir(), 'legacy-input-missing-'));
    const store = openFinalizationQueueStore({ rootDir: queueRoot });
    try {
      const lane = { repository: 'example/review', base: 'main' };
      const cfg = { laneRoutes: [{ ...lane, executor: 'queue-v2' }] };
      await createLaneRoutingController({ store }).transfer({ cfg, lane, expectedGeneration: 0,
        drainAdapter: { read: async () => ({ quiescent: true, sourceRef: 'fixture:drain', results: {} }) } });
      const queued = await observe(queueRoot, cfg, missing);
      const legacy = await observe(legacyRoot, {}, missing);
      assert.deepEqual(queued, legacy, missing);
      assert.equal(queued.launches, 0);
    } finally {
      store.close();
      rmSync(queueRoot, { recursive: true, force: true });
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  }
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
          queueCloser: { hammerHandoffCommand: ['/fixture/installed-handoff'] } } });
      const result = await maybeDispatchAmaCloser({ ...args, ...deps });
      duplicates += deps.calls.filter(c => c.args.includes('--prompt')).length;
      confirmed += Number(result.reason === 'queue-handoff-acknowledged');
      assert.equal(store.entries(lane).length, 1);
    } finally { store.close(); rmSync(rootDir, { recursive: true, force: true }); }
  }
  t.diagnostic(`late-ack trials=20 duplicate closer launches=${duplicates} confirmed acknowledgements=${confirmed}`);
  assert.equal(duplicates, 0); assert.equal(confirmed, 20);
});
