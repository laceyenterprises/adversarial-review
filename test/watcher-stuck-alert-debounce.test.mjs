// Regression test for the Sentinel alert payload + debounce key
// using the round-2 stuckDetail.launchRequestId.
//
// Before round-2:
//   - dispatchMergeAgentForPR returned `{decision, ..., stuckDetail}`
//     (no recordedDispatch, no top-level launchRequestId).
//   - maybeFireMergeAgentStuckAlert tried `dispatched.recordedDispatch.
//     launchRequestId || dispatched.launchRequestId` → null.
//   - alert payload went out with `launchRequestId: null`.
//   - debounce key collapsed to `${repo}-pr-${prNumber}-no-lrq.json`
//     — every stuck dispatch on the same PR shared one suppression
//     slot, so a fresh stuck dispatch could be suppressed by a stale
//     prior alert.
//
// After round-2:
//   - stuckDetail carries `launchRequestId`.
//   - alert payload includes it.
//   - debounce key is `${repo}-pr-${prNumber}-${lrq}.json` — distinct
//     per dispatch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { maybeFireMergeAgentStuckAlert } from '../src/watcher.mjs';

const LRQ = 'lrq_fb1a7760-4378-4f34-b731-4a1033bec5dd';
const NOW = Date.parse('2026-05-18T03:30:00Z');

function tmpStateDir() {
  return mkdtempSync(path.join(tmpdir(), 'stuck-alert-debounce-'));
}

function quietLogger() {
  return { log: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

test('round2: alert payload includes launchRequestId from stuckDetail', async () => {
  const stateDir = tmpStateDir();
  try {
    const captured = { text: null, structured: null };
    const deliverFn = async (text, structured) => {
      captured.text = text;
      captured.structured = structured;
      return { ok: true };
    };

    const dispatched = {
      decision: 'skip-already-dispatched',
      stuckDetail: {
        launchRequestId: LRQ,
        stuckForMinutes: 90,
        refusalCount: 340,
        primaryReason: 'memory_pressure',
        lastRefusedAt: '2026-05-18T03:25:00Z',
      },
    };

    const fired = await maybeFireMergeAgentStuckAlert({
      rootDir: '/tmp/unused-rootDir',
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 643,
      dispatched,
      deliverAlertFn: deliverFn,
      logger: quietLogger(),
      now: NOW,
      alertStateDir: stateDir,
    });

    assert.strictEqual(fired, true, 'alert should fire on first stuck dispatch');
    assert.ok(captured.structured, 'deliverAlertFn must receive a structured payload');

    // The structured payload MUST include the LRQ so the alert
    // recipient can run diagnostics. Pre-round-2 this was null
    // (the lookup chain through `dispatched.recordedDispatch.
    // launchRequestId` collapsed to null because the dispatch
    // result didn't carry recordedDispatch). Post-round-2,
    // stuckDetail.launchRequestId is set by describeStaleDispatch
    // and flows through to the structured payload.
    assert.strictEqual(
      captured.structured.payload?.launchRequestId, LRQ,
      `alert structured payload MUST include the LRQ — operator can't ` +
      `run diagnostics without it. Captured: ${JSON.stringify(captured.structured).slice(0, 400)}`,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('round2: debounce key is keyed on the LRQ (not the no-lrq fallback slot)', async () => {
  const stateDir = tmpStateDir();
  try {
    const deliverFn = async () => ({ ok: true });

    const dispatched = {
      decision: 'skip-already-dispatched',
      stuckDetail: {
        launchRequestId: LRQ,
        stuckForMinutes: 90,
        refusalCount: 340,
        primaryReason: 'memory_pressure',
        lastRefusedAt: '2026-05-18T03:25:00Z',
      },
    };

    await maybeFireMergeAgentStuckAlert({
      rootDir: '/tmp/unused-rootDir',
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 643,
      dispatched,
      deliverAlertFn: deliverFn,
      logger: quietLogger(),
      now: NOW,
      alertStateDir: stateDir,
    });

    // The debounce state file should be keyed on the LRQ — NOT the
    // `no-lrq` fallback that the pre-round-2 code path produced.
    const expectedLrqKeyFile = path.join(
      stateDir,
      `laceyenterprises_agent-os-pr-643-${LRQ}.json`,
    );
    const noLrqFallbackFile = path.join(
      stateDir,
      'laceyenterprises_agent-os-pr-643-no-lrq.json',
    );

    assert.ok(
      existsSync(expectedLrqKeyFile),
      `Debounce file MUST be keyed on the LRQ (${expectedLrqKeyFile}) — ` +
      'this proves stuckDetail.launchRequestId reached the debounce code.',
    );
    assert.ok(
      !existsSync(noLrqFallbackFile),
      'no-lrq fallback debounce file must NOT be created when the LRQ is ' +
      'available — that would mean stuckDetail.launchRequestId regressed to null.',
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('round2: second stuck dispatch on a different LRQ for same PR does NOT collapse to same debounce slot', async () => {
  const stateDir = tmpStateDir();
  try {
    const deliveries = [];
    const deliverFn = async (payload) => {
      deliveries.push(payload);
      return { ok: true };
    };

    const OTHER_LRQ = 'lrq_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    // First stuck dispatch
    await maybeFireMergeAgentStuckAlert({
      rootDir: '/tmp/unused',
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 643,
      dispatched: {
        decision: 'skip-already-dispatched',
        stuckDetail: {
          launchRequestId: LRQ,
          stuckForMinutes: 90,
          refusalCount: 340,
          primaryReason: 'memory_pressure',
          lastRefusedAt: '2026-05-18T03:25:00Z',
        },
      },
      deliverAlertFn: deliverFn,
      logger: quietLogger(),
      now: NOW,
      alertStateDir: stateDir,
    });

    // Second stuck dispatch on the SAME PR but a DIFFERENT LRQ
    // (e.g. a retry that the operator re-dispatched as r6).
    const fired2 = await maybeFireMergeAgentStuckAlert({
      rootDir: '/tmp/unused',
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 643,
      dispatched: {
        decision: 'skip-already-dispatched',
        stuckDetail: {
          launchRequestId: OTHER_LRQ,
          stuckForMinutes: 35,
          refusalCount: 12,
          primaryReason: 'memory_pressure',
          lastRefusedAt: '2026-05-18T03:29:00Z',
        },
      },
      deliverAlertFn: deliverFn,
      logger: quietLogger(),
      now: NOW + 60_000, // 1 min later
      alertStateDir: stateDir,
    });

    assert.strictEqual(fired2, true,
      'A NEW stuck dispatch with a different LRQ on the same PR MUST fire ' +
      'a separate alert — pre-round-2 the debounce key was `no-lrq` shared ' +
      'across all dispatches for the PR, so the second alert was suppressed.');
    assert.strictEqual(deliveries.length, 2,
      'Both alerts should have been delivered (one per LRQ).');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
