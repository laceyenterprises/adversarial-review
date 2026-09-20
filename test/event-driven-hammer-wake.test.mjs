import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  hammerWakeAuditPath,
  requestEligibleHammerWake,
} from '../src/hammer-wake.mjs';
import { collectReviewPipelineHealth } from '../src/review-pipeline-health.mjs';

const identity = {
  repo: 'laceyenterprises/agent-os',
  prNumber: 6613,
  headSha: 'abc123currenthead',
  eligibilityReason: 'clean-current-head-ci-green-policy-eligible',
};

function root() {
  return mkdtempSync(join(tmpdir(), 'hammer-wake-'));
}

function wakeImpl(calls) {
  return (args) => {
    calls.push(args);
    return { requested: true, payload: { request_id: 'wake-1', requested_at: args.requestedAt } };
  };
}

test('clean current-head eligible verdict wakes the existing AMA watcher route', () => {
  const rootDir = root();
  const calls = [];
  const result = requestEligibleHammerWake({
    rootDir,
    ...identity,
    eligibility: { eligible: true, reasons: [] },
    requestWatcherWakeImpl: wakeImpl(calls),
    log: { log() {} },
  });
  assert.equal(result.outcome, 'requested');
  assert.equal(result.route, 'watcher-ama-merge-authority');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headSha, identity.headSha);
  const audit = JSON.parse(readFileSync(hammerWakeAuditPath(rootDir, identity), 'utf8'));
  assert.equal(audit.outcome, 'requested');
  const health = collectReviewPipelineHealth({ rootDir, config: { hostChecksEnabled: false } });
  assert.equal(health.hammerWakes.recent[0].headSha, identity.headSha);
});

test('not-yet-eligible snapshot skips without creating a wake reservation', () => {
  const calls = [];
  const result = requestEligibleHammerWake({
    rootDir: root(),
    ...identity,
    eligibility: { eligible: false, reasons: ['ci-not-green'] },
    requestWatcherWakeImpl: wakeImpl(calls),
    log: { log() {} },
  });
  assert.equal(result.outcome, 'skipped');
  assert.equal(result.reason, 'ci-not-green');
  assert.equal(calls.length, 0);
});

test('duplicate wake key does not start a second close-lane race', () => {
  const rootDir = root();
  const calls = [];
  const args = {
    rootDir,
    ...identity,
    eligibility: { eligible: true, reasons: [] },
    requestWatcherWakeImpl: wakeImpl(calls),
    log: { log() {} },
  };
  assert.equal(requestEligibleHammerWake(args).outcome, 'requested');
  assert.equal(requestEligibleHammerWake(args).outcome, 'duplicate');
  assert.equal(calls.length, 1);
});

test('merge-rule refusal does not wake Hammer', () => {
  const calls = [];
  const result = requestEligibleHammerWake({
    rootDir: root(),
    ...identity,
    eligibility: { eligible: false, reasons: ['branch-protection-missing-gate'] },
    requestWatcherWakeImpl: wakeImpl(calls),
    log: { log() {} },
  });
  assert.equal(result.outcome, 'skipped');
  assert.equal(result.reason, 'branch-protection-missing-gate');
  assert.equal(calls.length, 0);
});
