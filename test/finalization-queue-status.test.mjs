import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { createQueueOwner } from '../src/finalization/queue-owner.mjs';
import { createCleanReviewService } from '../src/finalization/queue-clean-review.mjs';
import { createLaneRoutingController } from '../src/finalization/queue-routing.mjs';
import { openQueueStatus, readRoutingConfig, renderQueueStatus } from '../src/finalization/queue-status.mjs';
import { probeQueueOwner, queueProbeMain } from '../src/finalization/queue-probe.mjs';
import { finalizationMain } from '../src/finalization-cli.mjs';
import { queueCleanFixture } from './helpers/queue-clean-fixture.mjs';
const at = '2026-10-25T00:00:00Z', now = '2026-10-25T00:10:00Z';
const lane = { repository: 'example/review', base: 'main' };
const cfg = { laneRoutes: [{ ...lane, executor: 'queue-v2' }] };
const drainAdapter = { read: async () => ({ quiescent: true, sourceRef: 'drain', results: {} }) };
async function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'queue-status-'));
  const store = openFinalizationQueueStore({ rootDir });
  t.after(() => { store.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const routing = createLaneRoutingController({ store, now: () => at, runtime: { build: 'actual-loaded-writer-build', pid: 42 } });
  await routing.transfer({ cfg, lane, expectedGeneration: 0, drainAdapter });
  await routing.run({ cfg, lane, kind: 'daemon', queue: async () => ({ status: 'observed' }) });
  for (const pr of [101, 102, 103]) {
    const { h, e } = queueCleanFixture(pr);
    await createCleanReviewService({ store, evidenceAdapter: { read: async () => e }, now: () => at }).submit(h);
  }
  const owner = createQueueOwner({ store, now: () => at });
  const { fence } = await owner.claim({ lane, ownerId: 'queue:observed', routeGeneration: 1, expiresAt: '2026-10-25T00:30:00Z' });
  const all = store.entries(lane);
  store.progress({ fence, entryId: all[0].entryId, phase: 'ready', at });
  store.progress({ fence, entryId: all[2].entryId, phase: 'parked-infrastructure', at,
    patch: { reason: 'missing-required-check:integration', infrastructure: { nextProbeAt: '2026-10-25T00:35:00Z' } } });
  return { store, rootDir, all };
}
function io(f) {
  const output = { stdout: '', stderr: '' };
  return { output, now,
    stdout: { write: s => { output.stdout += s; } }, stderr: { write: s => { output.stderr += s; } },
    openQueueStatus: options => openQueueStatus({ ...options, rootDir: f.rootDir, readConfig: () => cfg }) };
}

test('status projects real route, writer build, fence, FIFO, reasons, parking and lifecycle metrics without writes', async t => {
  const f = await fixture(t);
  const before = readFileSync(join(f.rootDir, 'data/reviews.db'));
  const files = readdirSync(join(f.rootDir, 'data'), { recursive: true });
  const reader = openQueueStatus({ rootDir: f.rootDir, now, readConfig: () => cfg });
  const status = reader.status(lane); reader.close();
  assert.equal(status.route.executor, 'queue-v2');
  assert.equal(status.running.build, 'actual-loaded-writer-build');
  assert.notEqual(status.runtime.build, status.running.build);
  assert.equal(status.owner.owner_id, 'queue:observed');
  assert.equal(status.owner.route_generation, 1);
  assert.equal(status.head.prNumber, 101); assert.equal(status.head.phase, 'ready');
  assert.equal(status.waiting[0].position, 2); assert.equal(status.waiting[0].reason, 'predecessor-active');
  assert.equal(status.parked[0].prNumber, 103); assert.equal(status.parked[0].position, null);
  assert.equal(status.metrics.arrivals, 3); assert.equal(status.metrics.merges, 0);
  assert.equal(status.metrics.infrastructureParks, 1);
  assert.match(renderQueueStatus(status), /missing-required-check:integration/);
  for (const patience of [undefined, null, {}]) {
    assert.match(renderQueueStatus({ ...status, head: { ...status.head, patience } }), /deadline none/);
  }
  assert.deepEqual(readFileSync(join(f.rootDir, 'data/reviews.db')), before);
  assert.deepEqual(readdirSync(join(f.rootDir, 'data'), { recursive: true }), files);
});

test('receipt retains actual signed source/adjudication/check/proof/result/delivery data, unknown remains null', async t => {
  const f = await fixture(t), reader = openQueueStatus({ rootDir: f.rootDir, now, readConfig: () => cfg });
  t.after(() => reader.close());
  const r = reader.receipt({ repository: lane.repository, prNumber: 101 });
  assert.equal(r.entry.entryId, f.all[0].entryId);
  assert.equal(r.admission.kind, 'clean'); assert.equal(r.admission.input.sourceReview.commitId, r.entry.head);
  assert.equal(r.entry.proof, null); assert.equal(r.entry.checks, null); assert.equal(r.merge, null);
  assert.deepEqual(r.deliveries, []);
  assert.throws(() => reader.receipt({ repository: lane.repository, prNumber: 999 }), /unavailable/);
});

test('public finalization status/receipt/probe JSON and text use the reader and fail visibly', async t => {
  const f = await fixture(t);
  for (const command of [['status', '--repo', lane.repository, '--base', 'main'], ['receipt', '--repo', lane.repository, '--pr', '101']]) {
    const streams = io(f);
    assert.equal(finalizationMain(['queue', ...command, '--json'], streams), 0);
    assert.equal(JSON.parse(streams.output.stdout).runtime.role, 'read-only-observer');
  }
  const streams = io(f);
  assert.equal(finalizationMain(['queue', 'status', '--repo', lane.repository, '--base', 'main'], streams), 0);
  assert.match(streams.output.stdout, /route queue-v2/);
  const failed = io(f); failed.openQueueStatus = () => { throw new Error('secret-like diagnostic must not be exposed'); };
  assert.equal(finalizationMain(['queue', 'status', '--repo', lane.repository, '--base', 'main'], failed), 1);
  assert.match(failed.output.stderr, /store\/config/); assert.doesNotMatch(failed.output.stderr, /secret-like/);
  assert.equal(finalizationMain(['queue', 'status', '--repo', lane.repository], io(f)), 2);
  assert.equal(finalizationMain(['queue', 'receipt', '--repo', lane.repository, '--pr', '101junk'], io(f)), 2);
  const probeIo = io(f); probeIo.probe = options => probeQueueOwner({ ...options, rootDir: f.rootDir, now, readConfig: () => cfg });
  assert.equal(finalizationMain(['queue', 'probe', '--capability', 'routing', '--json'], probeIo), 0);
  const parsed = JSON.parse(probeIo.output.stdout);
  assert.equal(parsed.capabilities.routing.available, true); assert.ok(parsed.runtime.build);
});

test('routing probe validates real store/schema/config; never manufactures organic evidence', async t => {
  const f = await fixture(t);
  const before = readFileSync(join(f.rootDir, 'data/reviews.db'));
  const result = probeQueueOwner({ rootDir: f.rootDir, now, readConfig: () => cfg });
  assert.equal(result.capabilities.routing.available, true);
  assert.equal(result.observations.routing.organicRoutingObserved, true);
  assert.deepEqual(readFileSync(join(f.rootDir, 'data/reviews.db')), before);
  const failure = probeQueueOwner({ rootDir: f.rootDir, now, readConfig: () => { throw new Error('unreadable'); } });
  assert.equal(failure.capabilities.routing.available, false);
  let output = '';
  assert.equal(queueProbeMain(['--capability', 'routing', '--json'], { stdout: { write: s => { output += s; } }, probe: () => failure }), 1);
  assert.equal(JSON.parse(output).capabilities.routing.available, false);
  f.store.db.exec('DROP INDEX idx_finalization_queue_legacy_writer_lane');
  assert.equal(probeQueueOwner({ rootDir: f.rootDir, now, readConfig: () => cfg }).capabilities.routing.available, false);
  assert.throws(() => openQueueStatus({ rootDir: f.rootDir, now, readConfig: () => cfg }), /schema/);
});

test('real config reader resolves current selector and fails on unreadable or malformed config', async t => {
  const f = await fixture(t), configPath = join(f.rootDir, 'top.yaml');
  writeFileSync(configPath, JSON.stringify({ version: 1, roles: { adversarial: { merge_authority: { lane_routes: cfg.laneRoutes } } } }));
  assert.deepEqual(readRoutingConfig({ rootDir: f.rootDir, configPath }).laneRoutes, cfg.laneRoutes);
  const envPath = process.env.AGENT_OS_CONFIG_PATH;
  t.after(() => {
    if (envPath === undefined) delete process.env.AGENT_OS_CONFIG_PATH;
    else process.env.AGENT_OS_CONFIG_PATH = envPath;
  });
  process.env.AGENT_OS_CONFIG_PATH = configPath;
  assert.deepEqual(readRoutingConfig({ rootDir: f.rootDir }).laneRoutes, cfg.laneRoutes);
  for (const options of [{ configPath }, {}]) {
    const reader = openQueueStatus({ rootDir: f.rootDir, now, ...options });
    try {
      assert.equal(reader.status(lane).route.executor, 'queue-v2');
      assert.equal(reader.receipt({ repository: lane.repository, prNumber: 101 }).route.executor, 'queue-v2');
    } finally { reader.close(); }
    assert.equal(probeQueueOwner({ rootDir: f.rootDir, now, ...options }).capabilities.routing.available, true);
  }
  process.env.AGENT_OS_CONFIG_PATH = join(f.rootDir, 'missing-env.yaml');
  assert.deepEqual(readRoutingConfig({ rootDir: f.rootDir, configPath }).laneRoutes, cfg.laneRoutes);
  assert.throws(() => readRoutingConfig({ rootDir: f.rootDir }), /routing-config-unavailable/);
  delete process.env.AGENT_OS_CONFIG_PATH;
  assert.throws(() => readRoutingConfig({ rootDir: f.rootDir }), /routing-config-unavailable/);
  // Keep the versionless module layer out of the top-level schema parser.
  writeFileSync(join(f.rootDir, 'config.yaml'), JSON.stringify({
    __aliases: { 'merge_agent.worker_class': 'roles.merge_agent_worker_class' },
    roles: { adversarial: { merge_authority: { lane_routes: cfg.laneRoutes } } },
  }));
  assert.deepEqual(readRoutingConfig({ rootDir: f.rootDir }).laneRoutes, cfg.laneRoutes);
  assert.deepEqual(readRoutingConfig({ rootDir: f.rootDir, configPath }).laneRoutes, cfg.laneRoutes);
  writeFileSync(configPath, 'roles: [broken');
  assert.throws(() => readRoutingConfig({ rootDir: f.rootDir, configPath }));
  assert.throws(() => readRoutingConfig({ rootDir: f.rootDir, configPath: join(f.rootDir, 'missing') }));
});

test('a deployed empty routing store reports availability with pending organic writer evidence', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'empty-routing-'));
  const store = openFinalizationQueueStore({ rootDir });
  t.after(() => { store.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const probe = probeQueueOwner({ rootDir, now, readConfig: () => ({}) });
  assert.equal(probe.capabilities.routing.available, true);
  assert.equal(probe.observations.routing.organicRoutingObserved, false);
  const reader = openQueueStatus({ rootDir, now, readConfig: () => ({}) });
  try {
    const result = reader.status(lane);
    assert.equal(result.running, null); assert.equal(result.organicEvidence, 'pending');
    assert.equal(result.head, null); assert.equal(result.metrics, null); assert.equal(result.mode, 'legacy');
  } finally { reader.close(); }
});
