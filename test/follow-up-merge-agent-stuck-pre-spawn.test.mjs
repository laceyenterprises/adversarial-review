// Regression coverage for the `describeStaleDispatch` helper that
// detects merge-agent dispatches recorded by the watcher but never
// admitted by the agent-os dispatch daemon (BEG-00-era incident:
// PR #643 sat 90+ min while the daemon refused admission 340 times
// under memory pressure, and the watcher's `skip-already-dispatched`
// log line gave no operator-visible signal).
//
// The helper MUST fail closed when run outside the agent-os bundled
// environment (OSS standalone) — no hqRoot, no audit files, no false
// "stuck" claims. These tests pin that behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  describeStaleDispatch,
  STUCK_DISPATCH_DEFAULTS,
} from '../src/follow-up-merge-agent.mjs';

const NOW = Date.parse('2026-05-18T03:30:00Z');
const LRQ = 'lrq_test-1234567890';

function tmpHqRoot() {
  return mkdtempSync(path.join(tmpdir(), 'hq-stuck-test-'));
}

function writeAuditEvents(hqRoot, lrq, utcDate, events) {
  const dir = path.join(hqRoot, 'dispatch', 'audit', utcDate);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${lrq}.jsonl`);
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

function refusal(at, reasonCode = 'memory_pressure_projected_headroom_low') {
  return {
    createdAt: at,
    decision: 'refuse_admit_memory_pressure',
    structuredReasons: [{ reasonCode }],
  };
}

test('describeStaleDispatch — null when hqRoot is missing (OSS standalone case)', () => {
  const detail = describeStaleDispatch(
    { dispatchedAt: '2026-05-18T02:00:00Z', launchRequestId: LRQ },
    { hqRoot: null, now: NOW },
  );
  assert.equal(detail, null);
});

test('describeStaleDispatch — null when dispatch is younger than min age', () => {
  const hqRoot = tmpHqRoot();
  try {
    // 5-min-old dispatch with refusals already — should still be null
    // because the threshold is 10 min and warm starts can plausibly
    // take a few minutes.
    writeAuditEvents(hqRoot, LRQ, '2026-05-18', [
      refusal('2026-05-18T03:26:00Z'),
      refusal('2026-05-18T03:27:00Z'),
      refusal('2026-05-18T03:28:00Z'),
    ]);
    const detail = describeStaleDispatch(
      { dispatchedAt: '2026-05-18T03:25:00Z', launchRequestId: LRQ },
      { hqRoot, now: NOW },
    );
    assert.equal(detail, null);
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('describeStaleDispatch — null when audit dir missing entirely', () => {
  const hqRoot = tmpHqRoot();
  try {
    const detail = describeStaleDispatch(
      { dispatchedAt: '2026-05-18T02:00:00Z', launchRequestId: LRQ },
      { hqRoot, now: NOW },
    );
    assert.equal(detail, null);
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('describeStaleDispatch — null when fewer than min refusals (still in-flight)', () => {
  const hqRoot = tmpHqRoot();
  try {
    writeAuditEvents(hqRoot, LRQ, '2026-05-18', [
      refusal('2026-05-18T03:20:00Z'),
      refusal('2026-05-18T03:21:00Z'),
      // Only 2 refusals; below the default min of 3.
    ]);
    const detail = describeStaleDispatch(
      { dispatchedAt: '2026-05-18T02:00:00Z', launchRequestId: LRQ },
      { hqRoot, now: NOW },
    );
    assert.equal(detail, null);
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('describeStaleDispatch — surfaces detail when stuck (the #643 case)', () => {
  const hqRoot = tmpHqRoot();
  try {
    const events = [
      refusal('2026-05-18T02:30:00Z', 'memory_pressure_projected_headroom_low'),
      refusal('2026-05-18T02:40:00Z', 'memory_pressure_projected_headroom_low'),
      refusal('2026-05-18T02:50:00Z', 'memory_pressure_elevated_concurrency_cap'),
      refusal('2026-05-18T03:00:00Z', 'memory_pressure_projected_headroom_low'),
      refusal('2026-05-18T03:10:00Z', 'memory_pressure_elevated_concurrency_cap'),
      refusal('2026-05-18T03:20:00Z', 'memory_pressure_projected_headroom_low'),
    ];
    writeAuditEvents(hqRoot, LRQ, '2026-05-18', events);
    const detail = describeStaleDispatch(
      { dispatchedAt: '2026-05-18T02:00:00Z', launchRequestId: LRQ },
      { hqRoot, now: NOW },
    );
    assert.notEqual(detail, null);
    assert.equal(detail.refusalCount, 6);
    assert.equal(detail.stuckForMinutes, 90);
    assert.equal(detail.primaryReason, 'memory_pressure_projected_headroom_low');  // 4 of 6
    assert.equal(detail.lastRefusedAt, '2026-05-18T03:20:00Z');
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('describeStaleDispatch — scans both yesterday and today UTC dirs (cross-midnight)', () => {
  const hqRoot = tmpHqRoot();
  try {
    // Dispatch started 2 days ago (UTC). Refusals split across yesterday + today.
    writeAuditEvents(hqRoot, LRQ, '2026-05-17', [
      refusal('2026-05-17T23:00:00Z'),
      refusal('2026-05-17T23:30:00Z'),
    ]);
    writeAuditEvents(hqRoot, LRQ, '2026-05-18', [
      refusal('2026-05-18T00:30:00Z'),
      refusal('2026-05-18T01:00:00Z'),
    ]);
    const detail = describeStaleDispatch(
      { dispatchedAt: '2026-05-17T22:00:00Z', launchRequestId: LRQ },
      { hqRoot, now: NOW },
    );
    assert.notEqual(detail, null);
    assert.equal(detail.refusalCount, 4);
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('describeStaleDispatch — null when recordedDispatch is missing or malformed', () => {
  // Defensive: helper should never throw on bad input.
  assert.equal(describeStaleDispatch(null, { hqRoot: '/tmp', now: NOW }), null);
  assert.equal(describeStaleDispatch({}, { hqRoot: '/tmp', now: NOW }), null);
  assert.equal(describeStaleDispatch(
    { dispatchedAt: 'not-a-date', launchRequestId: LRQ },
    { hqRoot: '/tmp', now: NOW },
  ), null);
  assert.equal(describeStaleDispatch(
    { dispatchedAt: '2026-05-18T02:00:00Z' },  // no LRQ
    { hqRoot: '/tmp', now: NOW },
  ), null);
});

test('describeStaleDispatch — corrupt audit lines are skipped silently', () => {
  const hqRoot = tmpHqRoot();
  try {
    // Hand-crafted file with mixed valid + invalid lines.
    const dir = path.join(hqRoot, 'dispatch', 'audit', '2026-05-18');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${LRQ}.jsonl`),
      [
        JSON.stringify(refusal('2026-05-18T03:00:00Z')),
        'not valid json {{{',
        JSON.stringify(refusal('2026-05-18T03:10:00Z')),
        '',
        JSON.stringify(refusal('2026-05-18T03:20:00Z')),
      ].join('\n') + '\n',
    );
    const detail = describeStaleDispatch(
      { dispatchedAt: '2026-05-18T02:00:00Z', launchRequestId: LRQ },
      { hqRoot, now: NOW },
    );
    assert.notEqual(detail, null);
    assert.equal(detail.refusalCount, 3);  // 3 valid, the malformed line ignored
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('STUCK_DISPATCH_DEFAULTS — contract is stable (10 min, 3 refusals)', () => {
  assert.equal(STUCK_DISPATCH_DEFAULTS.minAgeMinutes, 10);
  assert.equal(STUCK_DISPATCH_DEFAULTS.minRefusals, 3);
});
