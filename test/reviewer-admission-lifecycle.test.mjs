import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewerHandoffPending, startReviewerHandoff, waitForReviewerHandoff } from '../src/reviewer-admission-lifecycle.mjs';

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

