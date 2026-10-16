import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewerPreflight, reviewerHandoffPending, startReviewerHandoff, waitForReviewerHandoff } from '../src/reviewer-admission-lifecycle.mjs';

test('inline hammer fences only its PR until completion, including failure', async () => {
  for (const fails of [false, true]) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const handoff = startReviewerHandoff('example/review-fixture', 201, async () => {
      await gate;
      if (fails) throw new Error('synthetic handoff failure');
    });
    assert.equal(reviewerHandoffPending('example/review-fixture', 201), true);
    assert.equal(reviewerHandoffPending('example/review-fixture', 202), false);
    let samePrReady = false;
    const waiting = waitForReviewerHandoff('example/review-fixture', 201).then(() => { samePrReady = true; });
    await waitForReviewerHandoff('example/review-fixture', 202);
    assert.equal(samePrReady, false);
    release();
    if (fails) {
      await assert.rejects(handoff, /synthetic handoff failure/);
      await assert.rejects(waiting, /synthetic handoff failure/);
    } else { await handoff; await waiting; }
    assert.equal(reviewerHandoffPending('example/review-fixture', 201), false);
  }
});

test('preparation refreshes expired evidence outside admission; launch consumes a stable snapshot', async () => {
  let now = 0, probes = 0;
  const prepared = createReviewerPreflight({ now: () => now, ttlMs: 100 });
  const probe = async () => ++probes;
  assert.equal(await prepared.read('synthetic-head', probe), 1);
  now = 101;
  assert.equal(await prepared.read('synthetic-head', probe), 2);
  now = 1000;
  assert.equal(await prepared.take('synthetic-head', probe), 2, 'launch never repeats a prepared probe');
  assert.equal(await prepared.read('new-head', probe), 3, 'changed inputs cannot reuse old evidence');
});


test('SEATIDLE-03: a multi-minute review cannot expire completed maintenance and repeat it at handoff', async () => {
  let now = 0, maintenance = 0, ciProbes = 0, liveProbes = 0;
  const prepared = createReviewerPreflight({ now: () => now });
  const maintenanceProbe = async () => ++maintenance;
  const ciProbe = async () => ++ciProbes;
  const liveProbe = async () => ++liveProbes;
  assert.equal(await prepared.read('maintenance', maintenanceProbe), 1);
  assert.equal(await prepared.read('ci', ciProbe, { ttlMs: 10_000 }), 1);
  now += 5 * 60_000;
  assert.equal(await prepared.read('maintenance', maintenanceProbe), 1);
  assert.equal(await prepared.read('ci', ciProbe, { ttlMs: 10_000 }), 2, 'mutable CI evidence must refresh outside admission');
  assert.equal(await prepared.take('maintenance', maintenanceProbe), 1);
  assert.equal(maintenance, 1, 'handoff consumes maintenance prepared while the previous seat was busy');
  assert.equal(await prepared.read('live-head', liveProbe, { ttlMs: 0 }), 1);
  assert.equal(await prepared.read('live-head', liveProbe, { ttlMs: 0 }), 2, 'head evidence refreshes even without advancing the clock');
  assert.equal(await prepared.take('live-head', liveProbe, { ttlMs: 0 }), 2, 'the admitted run consumes that fresh head snapshot');
});
