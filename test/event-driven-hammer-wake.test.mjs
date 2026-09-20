import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  hammerWakeAuditDir,
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

test('latency telemetry failure does not demote a delivered wake', () => {
  const rootDir = root();
  mkdirSync(join(rootDir, 'data', 'reviews.db'), { recursive: true });
  const calls = [];
  const args = {
    rootDir,
    ...identity,
    eligibility: { eligible: true, reasons: [] },
    requestWatcherWakeImpl: wakeImpl(calls),
    log: { log() {}, warn() {} },
  };

  const requested = requestEligibleHammerWake(args);
  const duplicate = requestEligibleHammerWake(args);
  const audit = JSON.parse(readFileSync(hammerWakeAuditPath(rootDir, identity), 'utf8'));

  assert.equal(requested.outcome, 'requested');
  assert.equal(requested.latencyEvent.recorded, false);
  assert.equal(requested.latencyEvent.reason, 'latency-event-failed');
  assert.equal(duplicate.outcome, 'duplicate');
  assert.equal(calls.length, 1);
  assert.equal(audit.outcome, 'requested');
  assert.equal(audit.latencyEvent.recorded, false);
});

test('audit directory failure returns a failed event instead of throwing', () => {
  const rootDir = root();
  writeFileSync(join(rootDir, 'data'), 'not a directory\n');
  const calls = [];

  const result = requestEligibleHammerWake({
    rootDir,
    ...identity,
    eligibility: { eligible: true, reasons: [] },
    requestWatcherWakeImpl: wakeImpl(calls),
    log: { log() {} },
  });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'wake-audit-dir-unavailable');
  assert.equal(calls.length, 0);
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

test('wake-path failure is retryable without allowing duplicate successful wakes', () => {
  const rootDir = root();
  const calls = [];
  const args = {
    rootDir,
    ...identity,
    eligibility: { eligible: true, reasons: [] },
    log: { log() {} },
  };
  const failed = requestEligibleHammerWake({
    ...args,
    requestWatcherWakeImpl: () => {
      throw new Error('wake transport unavailable');
    },
  });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.retryable, true);

  const retried = requestEligibleHammerWake({ ...args, requestWatcherWakeImpl: wakeImpl(calls) });
  const duplicate = requestEligibleHammerWake({ ...args, requestWatcherWakeImpl: wakeImpl(calls) });
  assert.equal(retried.outcome, 'requested');
  assert.equal(duplicate.outcome, 'duplicate');
  assert.equal(calls.length, 1);
});

test('health surface parses only the newest hammer wake audit files', () => {
  const rootDir = root();
  const dir = hammerWakeAuditDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const oldTime = new Date('2026-01-01T00:00:00.000Z');
  const newTime = new Date('2026-01-02T00:00:00.000Z');

  for (let i = 0; i < 5; i += 1) {
    const path = join(dir, `old-${i}.json`);
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      event: 'hammer_wake',
      repo: identity.repo,
      prNumber: identity.prNumber,
      headSha: `old-${i}`,
      eligibilityReason: identity.eligibilityReason,
      observedAt: '2099-01-01T00:00:00.000Z',
      outcome: 'requested',
    })}\n`);
    utimesSync(path, oldTime, oldTime);
  }
  for (let i = 0; i < 20; i += 1) {
    const path = join(dir, `new-${i}.json`);
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      event: 'hammer_wake',
      repo: identity.repo,
      prNumber: identity.prNumber,
      headSha: `new-${i}`,
      eligibilityReason: identity.eligibilityReason,
      observedAt: `2026-01-02T00:00:${String(i).padStart(2, '0')}.000Z`,
      outcome: 'requested',
    })}\n`);
    utimesSync(path, newTime, newTime);
  }

  const health = collectReviewPipelineHealth({ rootDir, config: { hostChecksEnabled: false } });
  assert.equal(health.hammerWakes.recent.length, 20);
  assert.deepEqual(
    health.hammerWakes.recent.map((entry) => entry.headSha).filter((headSha) => headSha.startsWith('old-')),
    [],
  );
});
