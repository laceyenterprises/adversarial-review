import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { createQueueOwner } from '../src/finalization/queue-owner.mjs';
import { createLaneRoutingController } from '../src/finalization/queue-routing.mjs';
import { createQueueGsr, queueGsrMain } from '../src/finalization/queue-gsr.mjs';

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
  assert.equal(queueGsrMain(['status', root]).present, true);
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
