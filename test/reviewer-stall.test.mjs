import { FakeClock } from './helpers/load-time-kit.mjs';
import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isReviewerStall, reviewerStallOptions } from '../src/reviewer-stall.mjs';
import { __test__ as harness } from '../src/reviewer-harness.mjs';
import { spawnCapturedProcessGroup } from '../src/process-group-spawn.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';

test('REVIEWSTALL-01: stall classification accepts errors and raw log strings', () => {
  for (const error of [
    { reviewerStalled: true },
    new Error('[reviewer-stalled] no first output'),
    '[reviewer-stalled] no first output',
  ]) {
    assert.equal(isReviewerStall(error), true);
  }
  for (const error of [undefined, null, '', {}, new Error('other failure'), 'other failure']) {
    assert.equal(isReviewerStall(error), false);
  }
});

for (const wrapper of ['spawnWithInput', 'spawnCaptured']) {
  test(`REVIEWSTALL-01: ${wrapper} forwards the custom stall receipt sink`, async () => {
    const receipts = [];
    await assert.rejects(harness[wrapper](process.execPath, ['-e',
      'setInterval(() => {}, 1000);',
    ], {
      timeout: 5000,
      firstOutputTimeout: 500,
      progressTimeout: 700,
      killGraceMs: 30,
      stallReviewer: { model: 'fixture-model', identity: wrapper },
      onStall: receipt => receipts.push(receipt),
    }), isReviewerStall);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].reason, 'first-output');
    assert.equal(receipts[0].reviewer.identity, wrapper);
  });
}

test('REVIEWSTALL-01: both load-aware budgets scale once and respect the call ceiling', () => {
  for (const multiplier of [1, 3, 6]) {
    const calls = [];
    const options = reviewerStallOptions(500_000, { model: 'fixture' }, {
      loadAwareTimeoutMsImpl: (nominal, policy) => {
        calls.push([nominal, policy]);
        return nominal * multiplier;
      },
    });
    assert.deepEqual(calls, [[120_000, { maxMs: 500_000 }], [180_000, { maxMs: 500_000 }]]);
    assert.equal(options.firstOutputTimeout, Math.min(120_000 * multiplier, 500_000));
    assert.equal(options.progressTimeout, Math.min(180_000 * multiplier, 500_000));
  }
  const tiny = reviewerStallOptions(40, { model: 'fixture' }, {
    loadAwareTimeoutMsImpl: nominal => nominal,
  });
  assert.equal(tiny.firstOutputTimeout, 40);
  assert.equal(tiny.progressTimeout, 40);
});

for (const fileBacked of [false, true]) {
  for (const output of [false, true]) {
    test(`REVIEWSTALL-01: ${fileBacked ? 'file' : 'pipe'} reviewer ${output ? 'goes silent' : 'never emits'}`, async t => {
      const clock = new FakeClock(t);
      let started, progressed;
      const ready = new Promise(resolve => { started = resolve; });
      const progress = new Promise(resolve => { progressed = resolve; });
      const root = mkdtempSync(join(tmpdir(), 'stall-fixture-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const receipts = [];
      const firstOutputTimeout = 500;
      const progressTimeout = 700;
      const start = Date.now();
      const rejected = assert.rejects(spawnCapturedProcessGroup(process.execPath, ['-e',
        `${output ? 'process.stdout.write("progress\\n");' : ''}process.send({ready:true}); setInterval(() => {}, 1000);`,
      ], {
        timeout: 5000, firstOutputTimeout, progressTimeout, killGraceMs: 30,
        onMessage: () => { started(); },
        onStdoutData: () => { progressed(); },
        stallReviewer: { model: 'fixture-model', runtime: 'fixture-runtime', identity: 'fixture-seat' },
        onStall: receipt => receipts.push(receipt),
        ...(fileBacked ? { stdoutPath: join(root, 'stdout'), stderrPath: join(root, 'stderr') } : {}),
      }), err => {
        assert.equal(err.reviewerStalled, true);
        assert.equal(classifyReviewerFailure(err.message), 'reviewer-stalled');
        return true;
      });
      await ready;
      if (output && !fileBacked) await progress;
      if (output && fileBacked) await clock.advance(125); // Observe the completed file write.
      await clock.advance(output ? progressTimeout : firstOutputTimeout);
      await clock.advance(30);
      await rejected;
      assert.ok(clock.monotonic() < 5000, 'settles before the outer ceiling');
      assert.equal(receipts.length, 1);
      const receipt = receipts[0];
      assert.equal(receipt.reason, output ? 'no-progress' : 'first-output');
      assert.equal(receipt.firstOutputBudgetMs, firstOutputTimeout);
      assert.equal(receipt.noProgressWindowMs, progressTimeout);
      assert.equal(receipt.ceilingMs, 5000);
      assert.equal(receipt.reviewer.identity, 'fixture-seat');
      assert.equal(receipt.firstOutputAt === null, !output);
      assert.ok(Date.parse(receipt.startedAt) >= start);
      assert.ok(Date.parse(receipt.lastProgressAt) >= Date.parse(receipt.startedAt));
      assert.equal(Date.parse(receipt.stalledAt) - Date.parse(output ? receipt.lastProgressAt : receipt.startedAt),
        output ? progressTimeout : firstOutputTimeout);
    });
  }
}

test('REVIEWSTALL-01: continuous progress survives the first-output budget', async () => {
  const receipts = [];
  const result = await spawnCapturedProcessGroup(process.execPath, ['-e',
    'process.stdout.write("start\\n"); let n=0; const timer=setInterval(() => { process.stderr.write("progress\\n"); if(++n===10) clearInterval(timer); },100);',
  ], { timeout: 5000, firstOutputTimeout: 500, progressTimeout: 500,
    stallReviewer: { model: 'fixture' }, onStall: receipt => receipts.push(receipt) });
  assert.match(result.stdout, /start/);
  assert.equal(result.stderr.trim().split('\n').length, 10);
  assert.deepEqual(receipts, []);
});

test('REVIEWSTALL-01: a progressing reviewer still meets the outer ceiling', async () => {
  const receipts = [];
  await assert.rejects(spawnCapturedProcessGroup(process.execPath, ['-e',
    'process.stdout.write("start\\n"); setInterval(() => process.stdout.write("progress\\n"),100);',
  ], { timeout: 1000, firstOutputTimeout: 500, progressTimeout: 500, killGraceMs: 30,
    stallReviewer: { model: 'fixture' }, onStall: receipt => receipts.push(receipt) }),
  err => {
    assert.equal(Boolean(err.reviewerStalled), false);
    assert.match(err.message, /timed out after 1000ms/);
    return true;
  });
  assert.deepEqual(receipts, []);
});
