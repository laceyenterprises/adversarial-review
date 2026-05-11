import test from 'node:test';
import assert from 'node:assert/strict';

import { createWatcherHealthProbe } from '../src/health-probe.mjs';

const DEFAULT_ENV = Object.freeze({
  ADVERSARIAL_WATCHER_HEALTH_PROBE: '1',
  ADVERSARIAL_WATCHER_SILENT_POLL_THRESHOLD: '3',
});

function makeProbe({ env = {}, pid = 12345 } = {}) {
  const events = [];
  const alerts = [];
  const warnings = [];
  const debug = [];
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
      warn(message) {
        warnings.push(message);
      },
      debug(message) {
        debug.push(message);
      },
    },
    deliverAlertFn: async (text, meta) => {
      alerts.push({ text, ...meta });
    },
  });
  return { probe, events, alerts, warnings, debug };
}

async function silentTick(probe, prs = [['laceyenterprises/adversarial-review', 75]]) {
  const tick = probe.beginTick();
  for (const [repo, prNumber] of prs) {
    probe.recordOpenPending(tick, { repo, prNumber });
  }
  await probe.finishTick(tick);
}

async function spawnedTick(probe, prs = [['laceyenterprises/adversarial-review', 75]]) {
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
    ['laceyenterprises/adversarial-review', 75],
    ['laceyenterprises/agent-os', 357],
  ]);

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    event: 'watcher.no_progress',
    pollsSinceLastSpawn: 3,
    openPendingPRs: 2,
    samplePRs: [
      'laceyenterprises/adversarial-review#75',
      'laceyenterprises/agent-os#357',
    ],
    lastSpawnAt: null,
    watcherPid: 12345,
    thresholdConfigured: 3,
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, 'watcher.no_progress');
  assert.equal(alerts[0].payload.openPendingPRs, 2);
  assert.match(alerts[0].text, /watcher\.no_progress/);
});

test('6 consecutive empty polls with open pending PR keeps alert transition-gated', async () => {
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
  assert.equal(alerts[0].event, 'watcher.no_progress');
});

test('spawn after no_progress emits recovered and one recovery alert', async () => {
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
  assert.equal(alerts.length, 2);
  assert.deepEqual(
    alerts.map((alert) => alert.event),
    ['watcher.no_progress', 'watcher.recovered']
  );
});

test('0 open pending PRs never alerts during a quiet period', async () => {
  const { probe, events, alerts } = makeProbe();

  for (let i = 0; i < 10; i += 1) {
    await silentTick(probe, []);
  }

  assert.equal(events.length, 0);
  assert.equal(alerts.length, 0);
  assert.equal(probe.getState().pollsSinceLastSpawn, 10);
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

test('health alerts do not block poll completion while delivery is still pending', async () => {
  const events = [];
  let alertCalls = 0;
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
      alertCalls += 1;
      await new Promise(() => {});
    },
  });

  await silentTick(probe);
  await silentTick(probe);
  await silentTick(probe);

  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'watcher.no_progress');
  assert.equal(alertCalls, 1);
});

test('invalid PR identifiers do not collapse samples into repo#NaN', async () => {
  const { probe, events, alerts, debug } = makeProbe();

  const tick = probe.beginTick();
  probe.recordOpenPending(tick, { repo: 'laceyenterprises/adversarial-review', prNumber: 'not-a-number' });
  await probe.finishTick(tick);

  assert.equal(events.length, 0);
  assert.equal(alerts.length, 0);
  assert.equal(debug.length, 1);
  assert.match(debug[0], /ignoring invalid PR sample/);
});

test('overlapping probe ticks are skipped instead of mutating shared state', async () => {
  const { probe, warnings } = makeProbe();

  const firstTick = probe.beginTick();
  const overlappingTick = probe.beginTick();

  assert.equal(overlappingTick.enabled, false);
  assert.equal(overlappingTick.skippedOverlap, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /skipped overlapping tick/);

  await probe.finishTick(firstTick);
  assert.equal(probe.getState().tickInFlight, false);
});
