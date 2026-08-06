import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HAMMER_WORKER_CLASSES,
  isHammerWorkerClass,
} from '../src/ama/hammer-worker-class.mjs';
import { __testables__ } from '../src/ama/dispatch-closer.mjs';

// PR #786 added `hammer-claude` (claude-opus-5) as a second closer worker class
// used when codex quota is exhausted, but the AMA route-engagement gates still
// keyed on the literal string 'hammer', so a `worker_class = hammer-claude`
// deploy parked every PR. Both classes must engage every hammer route gate.

test('isHammerWorkerClass accepts both hammer classes and rejects everything else', () => {
  assert.equal(isHammerWorkerClass('hammer'), true);
  assert.equal(isHammerWorkerClass('hammer-claude'), true);
  // Whitespace tolerance (the config value is trimmed at every gate).
  assert.equal(isHammerWorkerClass('  hammer-claude  '), true);

  assert.equal(isHammerWorkerClass('codex'), false);
  assert.equal(isHammerWorkerClass('claude-code'), false);
  assert.equal(isHammerWorkerClass('merge-agent'), false);
  assert.equal(isHammerWorkerClass(''), false);
  assert.equal(isHammerWorkerClass(null), false);
  assert.equal(isHammerWorkerClass(undefined), false);
});

test('HAMMER_WORKER_CLASSES is the frozen canonical set', () => {
  assert.deepEqual([...HAMMER_WORKER_CLASSES], ['hammer', 'hammer-claude']);
  assert.equal(Object.isFrozen(HAMMER_WORKER_CLASSES), true);
});

// Route-gate proof: cleanupHammerCloserWorker's guard (dispatch-closer.mjs) used
// to `return null` for any class != 'hammer', so a hammer-claude closer's worker
// was never torn down. It must now engage the teardown for hammer-claude too,
// using the same deterministic `hammer-ama-pr-<n>` worker identity.
test('cleanupHammerCloserWorker route gate now engages for hammer-claude', async () => {
  const calls = [];
  const execFileImpl = async (bin, args) => {
    calls.push({ bin, args });
    return { stdout: '', stderr: '' };
  };
  const logger = { info() {}, warn() {}, error() {} };

  const result = await __testables__.cleanupHammerCloserWorker({
    prNumber: 786,
    workerClass: 'hammer-claude',
    hqPath: '/fake/hq',
    hqRoot: '/fake/hq-root',
    execFileImpl,
    logger,
    reason: 'unit-test',
  });

  assert.notEqual(result, null, 'hammer-claude must engage the teardown, not return null');
  assert.equal(result.ok, true);
  assert.equal(result.workerId, 'hammer-ama-pr-786');
  assert.equal(calls.length, 1, 'the teardown exec must actually run for hammer-claude');
  assert.deepEqual(
    calls[0].args,
    ['worker', 'tear-down', 'hammer-ama-pr-786', '--force', '--root', '/fake/hq-root'],
  );
});

test('cleanupHammerCloserWorker still engages for the default hammer class', async () => {
  const calls = [];
  const execFileImpl = async (bin, args) => {
    calls.push({ bin, args });
    return { stdout: '', stderr: '' };
  };

  const result = await __testables__.cleanupHammerCloserWorker({
    prNumber: 4242,
    workerClass: 'hammer',
    hqPath: '/fake/hq',
    hqRoot: '/fake/hq-root',
    execFileImpl,
    logger: { info() {}, warn() {}, error() {} },
    reason: 'unit-test',
  });

  assert.notEqual(result, null);
  assert.equal(result.workerId, 'hammer-ama-pr-4242');
  assert.equal(calls.length, 1);
});

test('cleanupHammerCloserWorker still short-circuits for non-hammer classes', async () => {
  let called = false;
  const execFileImpl = async () => {
    called = true;
    return { stdout: '', stderr: '' };
  };

  const result = await __testables__.cleanupHammerCloserWorker({
    prNumber: 786,
    workerClass: 'codex',
    hqPath: '/fake/hq',
    hqRoot: '/fake/hq-root',
    execFileImpl,
    logger: { info() {}, warn() {}, error() {} },
    reason: 'unit-test',
  });

  assert.equal(result, null, 'a non-hammer closer must not be torn down by the hammer path');
  assert.equal(called, false, 'no teardown exec may run for a non-hammer class');
});
