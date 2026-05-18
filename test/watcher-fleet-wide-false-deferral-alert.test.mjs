// Defense-in-depth for the 2026-05-18 session-ledger DB-path bug class
// — see adversarial-review#129 + agent-os#669/#670.
//
// The merge-agent's `original-worker-run-row-missing-but-worktree-
// present` deferral guard was intended to refuse dispatch on orphan
// worker dirs. The bug it hid: a wrong-DB lookup returns 0 rows from
// a stale snapshot, so every newly-provisioned worker tripped this
// guard. Individual deferrals look benign; the SIGNATURE is many
// distinct LRQs deferring on the same reason in a short window.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  FLEET_WIDE_FALSE_DEFERRAL_REASON,
  maybeFireFleetWideFalseDeferralAlert,
} from '../src/watcher.mjs';

function tmpStateDir() {
  return mkdtempSync(path.join(tmpdir(), 'fleet-wide-false-deferral-'));
}

function quietLogger() {
  return { log: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function buildDispatchedDeferred({ lrq, reason = FLEET_WIDE_FALSE_DEFERRAL_REASON }) {
  return {
    decision: 'dispatch-deferred',
    reason,
    originalWorkerId: 'codex-fake',
    workerStatus: null,
    launchRequestId: lrq,
  };
}

test('no alert until distinct-LRQ threshold is crossed within the window', async () => {
  const alertStateDir = tmpStateDir();
  try {
    const calls = [];
    const deliverFn = async (text, structured) => {
      calls.push({ text, structured });
      return { ok: true };
    };
    const now0 = Date.parse('2026-05-18T03:30:00Z');

    // 1st LRQ — under threshold.
    const fired1 = await maybeFireFleetWideFalseDeferralAlert({
      dispatched: buildDispatchedDeferred({ lrq: 'lrq-1' }),
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 661,
      deliverAlertFn: deliverFn,
      logger: quietLogger(),
      now: now0,
      alertStateDir,
    });
    assert.strictEqual(fired1, false, 'one LRQ must not trip the threshold');

    // 2nd LRQ — still under threshold.
    const fired2 = await maybeFireFleetWideFalseDeferralAlert({
      dispatched: buildDispatchedDeferred({ lrq: 'lrq-2' }),
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 664,
      deliverAlertFn: deliverFn,
      logger: quietLogger(),
      now: now0 + 60_000,
      alertStateDir,
    });
    assert.strictEqual(fired2, false, 'two LRQs must not trip the threshold');

    // 3rd LRQ — threshold = 3, fire.
    const fired3 = await maybeFireFleetWideFalseDeferralAlert({
      dispatched: buildDispatchedDeferred({ lrq: 'lrq-3' }),
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 665,
      deliverAlertFn: deliverFn,
      logger: quietLogger(),
      now: now0 + 120_000,
      alertStateDir,
    });
    assert.strictEqual(fired3, true,
      '3 distinct LRQs within the 30min window MUST fire the alert — '
      + 'this is the exact pattern the 2026-05-18 incident produced.');

    assert.strictEqual(calls.length, 1, 'exactly one alert fired');
    const payload = calls[0].structured?.payload;
    assert.strictEqual(payload?.distinctLrqCount, 3);
    assert.strictEqual(payload?.reason, FLEET_WIDE_FALSE_DEFERRAL_REASON);
    assert.deepStrictEqual(
      payload?.observedTargets.sort(),
      [
        'laceyenterprises/agent-os#661',
        'laceyenterprises/agent-os#664',
        'laceyenterprises/agent-os#665',
      ],
    );
  } finally {
    rmSync(alertStateDir, { recursive: true, force: true });
  }
});

test('observations outside the window are pruned and do not count toward threshold', async () => {
  const alertStateDir = tmpStateDir();
  try {
    const calls = [];
    const deliverFn = async (text, structured) => {
      calls.push({ text, structured });
      return { ok: true };
    };
    const baseTime = Date.parse('2026-05-18T03:30:00Z');

    // Three LRQs from >30min ago (outside window).
    for (let i = 0; i < 3; i++) {
      await maybeFireFleetWideFalseDeferralAlert({
        dispatched: buildDispatchedDeferred({ lrq: `old-lrq-${i}` }),
        repoPath: 'laceyenterprises/agent-os',
        prNumber: 600 + i,
        deliverAlertFn: deliverFn,
        logger: quietLogger(),
        now: baseTime,
        alertStateDir,
      });
    }
    // The 3rd old LRQ DID fire the alert. Reset call log for the next
    // round; we want to verify the NEXT observation 35min later sees
    // a pruned window with 1 fresh LRQ + 0 carry-over.
    calls.length = 0;

    // 35min later — one fresh LRQ. Window has expired; the 3 old LRQs
    // must be pruned and the fresh one must not trigger an alert.
    const fired = await maybeFireFleetWideFalseDeferralAlert({
      dispatched: buildDispatchedDeferred({ lrq: 'fresh-lrq' }),
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 700,
      deliverAlertFn: deliverFn,
      logger: quietLogger(),
      now: baseTime + 35 * 60 * 1000,
      alertStateDir,
    });
    assert.strictEqual(fired, false,
      'After the 30min window expires, old observations must be pruned. '
      + 'A single fresh LRQ must not inherit the old count.');
  } finally {
    rmSync(alertStateDir, { recursive: true, force: true });
  }
});

test('debounce suppresses re-alerts within the debounce window', async () => {
  const alertStateDir = tmpStateDir();
  try {
    const calls = [];
    const deliverFn = async (text, structured) => {
      calls.push({ text, structured });
      return { ok: true };
    };
    const baseTime = Date.parse('2026-05-18T03:30:00Z');

    // Cross threshold and fire.
    for (let i = 0; i < 3; i++) {
      await maybeFireFleetWideFalseDeferralAlert({
        dispatched: buildDispatchedDeferred({ lrq: `lrq-${i}` }),
        repoPath: 'laceyenterprises/agent-os',
        prNumber: 600 + i,
        deliverAlertFn: deliverFn,
        logger: quietLogger(),
        now: baseTime,
        alertStateDir,
      });
    }
    assert.strictEqual(calls.length, 1, 'first alert fired');

    // 5 min later — another LRQ pushes count to 4. Still under
    // debounce, so no new alert. The bug class doesn't change every
    // 5 min — one alert per hour is the right cadence.
    const fired = await maybeFireFleetWideFalseDeferralAlert({
      dispatched: buildDispatchedDeferred({ lrq: 'lrq-3' }),
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 603,
      deliverAlertFn: deliverFn,
      logger: quietLogger(),
      now: baseTime + 5 * 60 * 1000,
      alertStateDir,
    });
    assert.strictEqual(fired, false, '5min after the first alert is inside the debounce window');
    assert.strictEqual(calls.length, 1, 'no additional alert delivered');
  } finally {
    rmSync(alertStateDir, { recursive: true, force: true });
  }
});

test('dispatched objects that are not the false-deferral signature are ignored', async () => {
  const alertStateDir = tmpStateDir();
  try {
    const calls = [];
    const deliverFn = async (text, structured) => {
      calls.push({ text, structured });
      return { ok: true };
    };
    const now0 = Date.parse('2026-05-18T03:30:00Z');

    // Wrong decision shape — not dispatch-deferred.
    const fired1 = await maybeFireFleetWideFalseDeferralAlert({
      dispatched: { decision: 'ready', launchRequestId: 'lrq-1' },
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 661,
      deliverAlertFn: deliverFn,
      logger: quietLogger(),
      now: now0,
      alertStateDir,
    });
    assert.strictEqual(fired1, false);

    // Right decision shape but different reason — not our signature.
    const fired2 = await maybeFireFleetWideFalseDeferralAlert({
      dispatched: {
        decision: 'dispatch-deferred',
        reason: 'workspace-json-missing-but-worker-dir-present',
        launchRequestId: 'lrq-2',
      },
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 664,
      deliverAlertFn: deliverFn,
      logger: quietLogger(),
      now: now0,
      alertStateDir,
    });
    assert.strictEqual(fired2, false);

    // Right decision and reason, but no LRQ — can't deduplicate, skip.
    const fired3 = await maybeFireFleetWideFalseDeferralAlert({
      dispatched: buildDispatchedDeferred({ lrq: null }),
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 665,
      deliverAlertFn: deliverFn,
      logger: quietLogger(),
      now: now0,
      alertStateDir,
    });
    assert.strictEqual(fired3, false);

    assert.strictEqual(calls.length, 0, 'none of these shapes should fire an alert');
  } finally {
    rmSync(alertStateDir, { recursive: true, force: true });
  }
});

test('repeated observations of the same LRQ do not inflate the distinct-LRQ count', async () => {
  // The watcher tick loops; the same stuck PR can re-observe its same
  // deferred LRQ many times. The threshold is keyed on DISTINCT LRQs,
  // not raw observation count, so repeated observations of one LRQ
  // must not bypass the threshold.
  const alertStateDir = tmpStateDir();
  try {
    const calls = [];
    const deliverFn = async (text, structured) => {
      calls.push({ text, structured });
      return { ok: true };
    };
    const now0 = Date.parse('2026-05-18T03:30:00Z');

    for (let i = 0; i < 10; i++) {
      await maybeFireFleetWideFalseDeferralAlert({
        dispatched: buildDispatchedDeferred({ lrq: 'one-stuck-lrq' }),
        repoPath: 'laceyenterprises/agent-os',
        prNumber: 661,
        deliverAlertFn: deliverFn,
        logger: quietLogger(),
        now: now0 + i * 60_000,
        alertStateDir,
      });
    }
    assert.strictEqual(calls.length, 0,
      'Ten observations of ONE stuck LRQ must not fire — the alert '
      + 'targets the fleet-wide bug signature (multiple distinct LRQs '
      + 'simultaneously deferring), not single-PR stuckness.');
  } finally {
    rmSync(alertStateDir, { recursive: true, force: true });
  }
});

test('state file is persisted between observations so later LRQs can cross the threshold', async () => {
  const alertStateDir = tmpStateDir();
  try {
    const calls = [];
    const deliverFn = async (text, structured) => {
      calls.push({ text, structured });
      return { ok: true };
    };
    const now0 = Date.parse('2026-05-18T03:30:00Z');

    // First observation persists state.
    await maybeFireFleetWideFalseDeferralAlert({
      dispatched: buildDispatchedDeferred({ lrq: 'lrq-1' }),
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 661,
      deliverAlertFn: deliverFn,
      logger: quietLogger(),
      now: now0,
      alertStateDir,
    });
    const statePath = path.join(alertStateDir, 'fleet-state.json');
    assert.ok(existsSync(statePath), 'state file MUST be written after first observation');
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.strictEqual(persisted.observations.length, 1);
    assert.strictEqual(persisted.observations[0].lrq, 'lrq-1');

    // Subsequent observations must reload prior LRQs from disk and fire
    // once the persisted distinct-LRQ threshold is reached.
    await maybeFireFleetWideFalseDeferralAlert({
      dispatched: buildDispatchedDeferred({ lrq: 'lrq-2' }),
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 662,
      deliverAlertFn: deliverFn,
      logger: quietLogger(),
      now: now0 + 60_000,
      alertStateDir,
    });
    const fired = await maybeFireFleetWideFalseDeferralAlert({
      dispatched: buildDispatchedDeferred({ lrq: 'lrq-3' }),
      repoPath: 'laceyenterprises/agent-os',
      prNumber: 663,
      deliverAlertFn: deliverFn,
      logger: quietLogger(),
      now: now0 + 120_000,
      alertStateDir,
    });
    assert.strictEqual(fired, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(
      calls[0].structured?.event,
      'merge_agent.fleet_wide_false_deferral',
    );
  } finally {
    rmSync(alertStateDir, { recursive: true, force: true });
  }
});

test('corrupt state file fails closed and emits a degraded detector alert', async () => {
  const alertStateDir = tmpStateDir();
  try {
    const calls = [];
    const deliverFn = async (text, structured) => {
      calls.push({ text, structured });
      return { ok: true };
    };
    const statePath = path.join(alertStateDir, 'fleet-state.json');
    writeFileSync(statePath, '{not-json\n');

    await assert.rejects(
      maybeFireFleetWideFalseDeferralAlert({
        dispatched: buildDispatchedDeferred({ lrq: 'lrq-1' }),
        repoPath: 'laceyenterprises/agent-os',
        prNumber: 661,
        deliverAlertFn: deliverFn,
        logger: quietLogger(),
        now: Date.parse('2026-05-18T03:30:00Z'),
        alertStateDir,
      }),
      /fleet-wide false-deferral detector state read failed/
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(
      calls[0].structured?.event,
      'merge_agent.fleet_wide_false_deferral_detector_degraded',
    );
    assert.strictEqual(calls[0].structured?.payload?.operation, 'read');
  } finally {
    rmSync(alertStateDir, { recursive: true, force: true });
  }
});

test('state write failure fails closed and emits a degraded detector alert', async () => {
  const alertStateDir = tmpStateDir();
  try {
    const calls = [];
    const deliverFn = async (text, structured) => {
      calls.push({ text, structured });
      return { ok: true };
    };

    await assert.rejects(
      maybeFireFleetWideFalseDeferralAlert({
        dispatched: buildDispatchedDeferred({ lrq: 'lrq-1' }),
        repoPath: 'laceyenterprises/agent-os',
        prNumber: 661,
        deliverAlertFn: deliverFn,
        logger: quietLogger(),
        now: Date.parse('2026-05-18T03:30:00Z'),
        alertStateDir,
        writeStateFileFn: () => {
          throw new Error('disk full');
        },
      }),
      /fleet-wide false-deferral detector state write-observations failed/
    );

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(
      calls[0].structured?.event,
      'merge_agent.fleet_wide_false_deferral_detector_degraded',
    );
    assert.strictEqual(calls[0].structured?.payload?.operation, 'write-observations');
  } finally {
    rmSync(alertStateDir, { recursive: true, force: true });
  }
});
