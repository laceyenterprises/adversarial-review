import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDetachedReviewerDispatchTracker, persistedSpawnReservationSource } from '../src/watcher-reviewer-pool.mjs';
import { writeReviewerRunRecord } from '../src/adapters/reviewer-runtime/run-state.mjs';
import { upsertSpawnRecord } from '../src/reviewer-fence.mjs';

import { createWatcherHealthProbe } from '../src/health-probe.mjs';

const DEFAULT_ENV = Object.freeze({
  ADVERSARIAL_WATCHER_HEALTH_PROBE: '1',
  ADVERSARIAL_WATCHER_SILENT_POLL_THRESHOLD: '3',
});

function makeProbe({ env = {}, pid = 12345 } = {}) {
  const events = [];
  const alerts = [];
  let nowTick = 0;
  const probe = createWatcherHealthProbe({
    env: { ...DEFAULT_ENV, ...env },
    pid,
    now: () => new Date(Date.UTC(2026, 4, 11, 5, 43, 11 + nowTick++)),
    stdout: {
      write(line) {
        events.push(JSON.parse(line));
      },
    },
    logger: {
      error() {},
    },
    deliverAlertFn: async (text, meta) => {
      alerts.push({ text, ...meta });
    },
  });
  return { probe, events, alerts };
}

async function silentTick(probe, prs = [['sample-org/review-fixture', 75]]) {
  const tick = probe.beginTick();
  for (const [repo, prNumber] of prs) {
    probe.recordOpenPending(tick, { repo, prNumber });
  }
  await probe.finishTick(tick);
}

async function spawnedTick(probe, prs = [['sample-org/review-fixture', 75]]) {
  const tick = probe.beginTick();
  for (const [repo, prNumber] of prs) {
    probe.recordOpenPending(tick, { repo, prNumber });
  }
  probe.recordSpawn(tick, { at: '2026-05-11T05:43:11.000Z' });
  await probe.finishTick(tick);
}

test('3 consecutive empty polls with open pending PR emits no_progress and one alert', async () => {
  const { probe, events, alerts } = makeProbe();

  await silentTick(probe);
  await silentTick(probe);
  await silentTick(probe, [
    ['sample-org/review-fixture', 75],
    ['sample-org/second-fixture', 357],
  ]);

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    event: 'watcher.no_progress',
    pollsSinceLastSpawn: 3,
    openPendingPRs: 2,
    openPendingRereviewPRs: 0,
    samplePRs: [
      'sample-org/review-fixture#75',
      'sample-org/second-fixture#357',
    ],
    lastSpawnAt: null,
    watcherPid: 12345,
    thresholdConfigured: 3,
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, 'watcher.no_progress');
  assert.equal(alerts[0].payload.openPendingPRs, 2);
  assert.match(alerts[0].text, /No reviewer spawn/);
});

test('6 consecutive empty polls with open pending PR emits telemetry but pages only on the incident transition', async () => {
  const { probe, events, alerts } = makeProbe();

  for (let i = 0; i < 6; i += 1) {
    await silentTick(probe);
  }

  assert.equal(events.length, 4);
  assert.deepEqual(
    events.map((event) => event.pollsSinceLastSpawn),
    [3, 4, 5, 6]
  );
  assert.equal(alerts.length, 1);
  assert.deepEqual(
    alerts.map((alert) => alert.event),
    ['watcher.no_progress']
  );
  assert.equal(alerts[0].payload.pollsSinceLastSpawn, 3);
});

test('spawn after no_progress emits a recovery event without another page', async () => {
  const { probe, events, alerts } = makeProbe();

  for (let i = 0; i < 5; i += 1) {
    await silentTick(probe);
  }
  await spawnedTick(probe);

  assert.deepEqual(
    events.map((event) => event.event),
    [
      'watcher.no_progress',
      'watcher.no_progress',
      'watcher.no_progress',
      'watcher.recovered',
    ]
  );
  assert.deepEqual(events.at(-1), {
    event: 'watcher.recovered',
    spawnsSinceRecovery: 1,
    recoveredFromSilentPolls: 5,
    watcherPid: 12345,
  });
  assert.equal(alerts.length, 1);
  assert.deepEqual(
    alerts.map((alert) => alert.event),
    ['watcher.no_progress']
  );
});

test('0 open pending PRs never alerts during a quiet period', async () => {
  const { probe, events, alerts } = makeProbe();

  for (let i = 0; i < 10; i += 1) {
    await silentTick(probe, []);
  }

  assert.equal(events.length, 0);
  assert.equal(alerts.length, 0);
  assert.equal(probe.getState().pollsSinceLastSpawn, 0);
});

test('threshold override waits until the configured silent poll count', async () => {
  const { probe, events, alerts } = makeProbe({
    env: { ADVERSARIAL_WATCHER_SILENT_POLL_THRESHOLD: '5' },
  });

  await silentTick(probe);
  await silentTick(probe);
  await silentTick(probe);
  assert.equal(events.length, 0);
  assert.equal(alerts.length, 0);

  await silentTick(probe);
  await silentTick(probe);
  assert.equal(events.length, 1);
  assert.equal(events[0].pollsSinceLastSpawn, 5);
  assert.equal(events[0].thresholdConfigured, 5);
  assert.equal(alerts.length, 1);
});

test('disabled health probe emits no events and sends no alerts', async () => {
  const { probe, events, alerts } = makeProbe({
    env: { ADVERSARIAL_WATCHER_HEALTH_PROBE: '0' },
  });

  for (let i = 0; i < 10; i += 1) {
    await silentTick(probe);
  }
  await spawnedTick(probe);

  assert.equal(events.length, 0);
  assert.equal(alerts.length, 0);
  assert.equal(probe.getConfig().enabled, false);
});

test('health alerts complete once the durable sink has queued the alert', async () => {
  const events = [];
  const probe = createWatcherHealthProbe({
    env: DEFAULT_ENV,
    pid: 12345,
    stdout: {
      write(line) {
        events.push(JSON.parse(line));
      },
    },
    logger: {
      error() {},
    },
    deliverAlertFn: async () => {
      return { status: 'queued', queued: true };
    },
  });

  await silentTick(probe);
  await silentTick(probe);

  const thirdTick = silentTick(probe);
  await Promise.resolve();
  assert.equal(events.length, 1, 'health event is emitted before alert delivery settles');

  let settled = false;
  void thirdTick.then(() => {
    settled = true;
  });
  await Promise.resolve();
  await thirdTick;
  assert.equal(settled, true, 'finishTick should settle once the alert is durably queued');
});

test('health alert delivery rejection is logged and does not reject finishTick', async () => {
  const errors = [];
  const probe = createWatcherHealthProbe({
    env: DEFAULT_ENV,
    pid: 12345,
    stdout: {
      write() {},
    },
    logger: {
      error(message) {
        errors.push(message);
      },
    },
    deliverAlertFn: async () => {
      throw new Error('slack down');
    },
  });

  await silentTick(probe);
  await silentTick(probe);
  await silentTick(probe);

  assert.deepEqual(errors, [
    '[watcher] health alert delivery failed: slack down',
  ]);
});


test('REVIEWDELAY-01: three polls with reviewer starts need no reviewer return', async () => {
  const { probe, events, alerts } = makeProbe();
  const returns = [];
  const runs = [];
  for (let prNumber = 1; prNumber <= 3; prNumber += 1) {
    const tick = probe.beginTick();
    probe.recordOpenPending(tick, { repo: 'sample-org/review-fixture', prNumber });
    runs.push(new Promise(resolve => {
      returns.push(resolve);
      probe.recordSpawn(tick, { repo: 'sample-org/review-fixture', prNumber });
    }));
    await probe.finishTick(tick);
    assert.equal(tick.openPendingPRs, 0);
    assert.equal(probe.getState().pollsSinceLastSpawn, 0);
    assert.ok(probe.getState().lastSpawnAt);
  }
  assert.deepEqual(events, []);
  assert.deepEqual(alerts, []);
  for (const resolve of returns) resolve();
  await Promise.all(runs);
});

test('REVIEWDELAY-01: refused first passes page once and later rounds stay out of the sample', async () => {
  const { probe, events, alerts } = makeProbe();
  for (let poll = 0; poll < 3; poll += 1) {
    const tick = probe.beginTick();
    for (let duplicate = 0; duplicate < 2; duplicate += 1) {
      probe.recordOpenPending(tick, { repo: 'sample-org/review-fixture', prNumber: 1 });
      probe.recordOpenPending(tick, {
        repo: 'sample-org/review-fixture', prNumber: 2, hasCompletedReviewRound: true,
      });
    }
    await probe.finishTick(tick);
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].openPendingPRs, 1);
  assert.equal(events[0].openPendingRereviewPRs, 1);
  assert.deepEqual(events[0].samplePRs, ['sample-org/review-fixture#1']);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].text, 'No reviewer spawn for 3 polls while 1 PR(s) await first pass.');
});

test('REVIEWDELAY-01: an in-flight third-round reviewer is neither waiting nor silent', async () => {
  const { probe, events } = makeProbe();
  for (let poll = 0; poll < 3; poll += 1) {
    const tick = probe.beginTick();
    probe.recordOpenPending(tick, {
      repo: 'sample-org/review-fixture', prNumber: 3, hasCompletedReviewRound: true,
    });
    probe.recordInFlight(tick, { repo: 'sample-org/review-fixture', prNumber: 3 });
    // Accounting is independent of observer order.
    probe.recordOpenPending(tick, {
      repo: 'sample-org/review-fixture', prNumber: 3, hasCompletedReviewRound: true,
    });
    await probe.finishTick(tick);
    assert.equal(tick.openPendingPRs, 0);
    assert.equal(tick.openPendingRereviewPRs, 0);
    assert.deepEqual(tick.samplePRs, []);
  }
  assert.deepEqual(events, []);
  assert.equal(probe.getState().pollsSinceLastSpawn, 0);
});

test('REVIEWDELAY-01: a quiet poll breaks the consecutive silent waiting streak', async () => {
  const { probe, events } = makeProbe();
  await silentTick(probe);
  await silentTick(probe);
  await silentTick(probe, []);
  await silentTick(probe);
  await silentTick(probe);
  assert.deepEqual(events, []);
  await silentTick(probe);
  assert.equal(events[0].pollsSinceLastSpawn, 3);
});


test('REVIEWDELAY-01: restart waits for inherited reviewers to end and three further silent polls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewdelay-restart-'));
  const nowMs = Date.parse('2026-10-01T00:00:00.000Z');
  const stateDir = join(root, 'state');
  const livePgids = new Set([123456, 123457]);
  try {
    for (let index = 0; index < 2; index += 1) {
      const sessionUuid = `inherited-session-${index}`;
      upsertSpawnRecord(stateDir, {
        spawnToken: `inherited-token-${index}`,
        repo: 'sample-org/review-fixture', pr: index + 1,
        reviewerModel: index === 0 ? 'codex' : 'claude',
        reviewerSessionUuid: sessionUuid,
        spawnedAt: new Date(nowMs - 60_000).toISOString(),
      });
      writeReviewerRunRecord(root, {
        sessionUuid, state: 'heartbeating', pgid: 123456 + index,
      });
    }
    const tracker = createDetachedReviewerDispatchTracker({
      activeReviewerSpawns: new Map(),
      now: () => nowMs,
      timeoutMs: 600_000,
      ...persistedSpawnReservationSource({
        stateDir, runStateRootDir: root,
        isPgidAliveImpl: pgid => livePgids.has(pgid),
      }),
    });
    const { probe, events, alerts } = makeProbe();
    const poll = async () => {
      const tick = probe.beginTick();
      probe.recordOpenPending(tick, { repo: 'sample-org/review-fixture', prNumber: 1 });
      probe.recordOpenPending(tick, {
        repo: 'sample-org/review-fixture', prNumber: 2, hasCompletedReviewRound: true,
      });
      probe.recordOpenPending(tick, { repo: 'sample-org/review-fixture', prNumber: 3 });
      await probe.finishTick(tick, { inFlightReviewers: tracker.liveSpawnEntries() });
      return tick;
    };
    assert.equal(tracker.liveSpawnEntries().length, 2);
    for (let index = 0; index < 3; index += 1) {
      const tick = await poll();
      assert.equal(tick.openPendingPRs, 1);
      assert.equal(tick.openPendingRereviewPRs, 0);
      assert.deepEqual(tick.samplePRs, ['sample-org/review-fixture#3']);
    }
    assert.deepEqual(events, []);
    assert.equal(probe.getState().pollsSinceLastSpawn, 0);
    assert.equal(probe.getState().lastSpawnAt, null, 'inherited runs are not new spawns');
    livePgids.delete(123456);
    await poll();
    assert.deepEqual(events, [], 'one surviving process still prevents a silent poll');
    writeReviewerRunRecord(root, {
      sessionUuid: 'inherited-session-1', state: 'completed', pgid: 123457,
    });
    assert.deepEqual(tracker.liveSpawnEntries(), []);
    await poll();
    await poll();
    assert.deepEqual(events, []);
    await poll();
    assert.equal(events.length, 1);
    assert.equal(events[0].pollsSinceLastSpawn, 3);
    assert.equal(events[0].openPendingPRs, 2);
    assert.equal(events[0].openPendingRereviewPRs, 1);
    assert.deepEqual(events[0].samplePRs, [
      'sample-org/review-fixture#1', 'sample-org/review-fixture#3',
    ]);
    assert.equal(alerts.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
