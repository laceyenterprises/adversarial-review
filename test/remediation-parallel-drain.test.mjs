import test from 'node:test';
import assert from 'node:assert/strict';
import { drainRemediationJobs } from '../src/remediation-parallel-drain.mjs';

test('fatal drain error observes sibling failures before returning', async () => {
  const observed = [];
  const warnings = [];
  let calls = 0;
  await assert.rejects(drainRemediationJobs({
    capacity: 2,
    activeAtStart: 0,
    shouldStop: () => false,
    log: { warn: line => warnings.push(line) },
    run: async () => {
      calls += 1;
      if (calls === 1) throw new Error('fatal first');
      throw new Error('sibling failed');
    },
    onError: async err => {
      observed.push(err.message);
      if (err.message === 'fatal first') throw err;
    },
  }), /fatal first/);
  assert.deepEqual(observed, ['fatal first', 'sibling failed']);
  assert.match(warnings[0], /sibling preparation failed during fatal drain/);
});
