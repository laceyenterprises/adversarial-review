import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { createQueueOwner } from '../src/finalization/queue-owner.mjs';
import { createLaneRoutingController } from '../src/finalization/queue-routing.mjs';
import { createQueueGsr, queueGsrMain, queueGsrSnapshot } from '../src/finalization/queue-gsr.mjs';

const at = '2026-11-03T00:00:00.000Z';
const lane = { repository: 'example/project', base: 'main' };
const cfg = { laneRoutes: [{ ...lane, executor: 'queue-v2' }] };
const token = 'maintenance-window:fixture';
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'queue-gsr-'));
  const store = openFinalizationQueueStore({ rootDir });
  const owner = createQueueOwner({ store, now: () => at });
  const gsr = createQueueGsr({ store, now: () => at });
  const routing = createLaneRoutingController({ store, now: () => at });
  t.after(() => { store.close(); rmSync(rootDir, { recursive: true, force: true }); });
  return { store, owner, gsr, routing };
}

test('queue GSR CLI reports argument and maintenance token errors on stderr', t => {
  const root = mkdtempSync(join(tmpdir(), 'queue-gsr-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('../src/finalization/queue-gsr.mjs', import.meta.url));
  for (const [args, message] of [
    [[], 'queue GSR command and root required'],
    [['drain', root, 'invalid'], 'maintenance token required'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `queue GSR unavailable: ${message}\n`);
  }
});

test('drain fences new claims; steer retains queue work; only original token resumes', async t => {
  const f = fixture(t);
  await f.routing.transfer({ cfg, lane, expectedGeneration: 0,
    drainAdapter: { read: async () => ({ quiescent: true, sourceRef: 'synthetic:drained', results: {} }) } });
  assert.equal(f.gsr.drain(token).held, true);
  assert.equal((await f.owner.claim({ lane, ownerId: 'fixture', routeGeneration: 1,
    expiresAt: '2026-11-03T00:05:00Z' })).reason, 'maintenance-drain');
  assert.equal(f.gsr.steer().token, token);
  assert.equal(f.gsr.drain('maintenance-window:other').token, token);
  assert.equal(f.gsr.resume('maintenance-window:other').held, true);
  assert.equal(f.gsr.resume(token).held, false);
  const claimed = await f.owner.claim({ lane, ownerId: 'fixture', routeGeneration: 1,
    expiresAt: '2026-11-03T00:05:00Z' });
  assert.equal(claimed.ok, true);
  // An already claimed owner cannot issue after drain, even with a live fence.
  f.gsr.drain(token);
  await assert.rejects(f.owner.issue({ fence: claimed.fence, entryId: 'missing',
    operationId: 'must-not-issue', kind: 'push', invoke: () => assert.fail('drained writer issued') }),
  /maintenance drain/);
});

test('unknown remote operation stays blocking across drain/reopen/resume', async t => {
  const f = fixture(t);
  f.store.tx(() => {
    f.store.ensureLane(lane);
    f.store.db.prepare(`INSERT INTO finalization_queue_operation
      (operation_id,repository,base,entry_id,generation,route_generation,kind,intent_json)
      VALUES ('unknown',?,?, 'entry',1,1,'merge','{}')`).run(lane.repository, lane.base);
  });
  f.gsr.drain(token);
  assert.equal(f.gsr.steer().operations.length, 1);
  f.gsr.resume(token);
  assert.equal(f.gsr.steer().operations.length, 1);
  assert.equal(f.store.operations(lane)[0].result_json, null);
});

test('a cold queue is covered before any future lane is created', t => {
  const root = mkdtempSync(join(tmpdir(), 'cold-queue-gsr-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(queueGsrMain(['status', root]).present, false);
  assert.equal(queueGsrMain(['drain', root, token]).held, true);
  assert.equal(queueGsrMain(['status', root]).token, token);
  assert.equal(queueGsrMain(['resume', root, token]).held, false);
});

export async function qualifyDrain(t, ownerFactory = createQueueOwner) {
  let issuedWhileDrained = 0;
  for (let trial = 0; trial < 30; trial++) {
    const f = fixture(t);
    f.owner = ownerFactory({ store: f.store, now: () => at });
    await f.routing.transfer({ cfg, lane, expectedGeneration: 0,
      drainAdapter: { read: async () => ({ quiescent: true, sourceRef: 'synthetic:drained', results: {} }) } });
    const fence = (await f.owner.claim({ lane, ownerId: 'fixture', routeGeneration: 1,
      expiresAt: '2026-11-03T00:05:00Z' })).fence;
    f.store.acknowledge({ lane, entryId: 'entry', prNumber: 42, head: 'old-head',
      admissionGeneration: 1, handoffId: 'handoff', ackId: 'ack', at });
    for (const phase of ['ready', 'rebasing', 'publishing']) {
      f.store.progress({ fence, entryId: 'entry', phase, at,
        patch: phase === 'publishing' ? { candidate: 'candidate', exactBase: 'base' } : {} });
    }
    f.gsr.drain(token); // force the old owner to continue after confirmed drain
    try {
      await f.owner.issue({ fence, entryId: 'entry', operationId: 'push', kind: 'push',
        invoke: async () => {
          issuedWhileDrained++;
          return { outcome: 'succeeded', sourceRef: 'synthetic:publication' };
        } });
    } catch (error) {
      assert.match(error.message, /maintenance drain/);
    }
    assert.equal(f.gsr.steer().token, token);
  }
  return issuedWhileDrained;
}

test('30 forced post-drain continuations cannot issue through a still-live owner fence', async t => {
  assert.equal(await qualifyDrain(t), 0);
  t.diagnostic('30 consecutive forced post-drain continuations: 0 remote invocations');
});

test('missing lane table is absent and token mismatches have explicit failed CLI receipts', t => {
  const root = mkdtempSync(join(tmpdir(), 'gsr-receipts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = new Database(':memory:');
  t.after(() => db.close());
  assert.equal(queueGsrSnapshot(db).present, false);
  const cli = new URL('../src/finalization/queue-gsr.mjs', import.meta.url);
  const run = (command, requested) => {
    const result = spawnSync(process.execPath, [cli.pathname, command, root, requested], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    return { status: result.status, receipt: JSON.parse(result.stdout) };
  };
  assert.equal(run('drain', token).receipt.accepted, true);
  assert.equal(run('drain', token).status, 0);
  const other = run('drain', 'maintenance-window:other');
  assert.equal(other.status, 1);
  assert.equal(other.receipt.accepted, false);
  assert.equal(other.receipt.token, token);
  const wrong = run('resume', 'maintenance-window:other');
  assert.equal(wrong.status, 1);
  assert.equal(wrong.receipt.released, false);
  assert.equal(wrong.receipt.held, true);
  const released = run('resume', token);
  assert.equal(released.status, 0);
  assert.equal(released.receipt.released, true);
  assert.equal(run('resume', token).status, 1);
});
