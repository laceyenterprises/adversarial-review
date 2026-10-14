import { deliverAlert as defaultDeliverAlert } from './alert-delivery.mjs';

const DEFAULT_SILENT_POLL_THRESHOLD = 3;
const DEFAULT_SAMPLE_LIMIT = 5;

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function resolveHealthProbeConfig(env = process.env) {
  return {
    enabled: String(env.ADVERSARIAL_WATCHER_HEALTH_PROBE ?? '1') !== '0',
    threshold: parsePositiveInteger(
      env.ADVERSARIAL_WATCHER_SILENT_POLL_THRESHOLD,
      DEFAULT_SILENT_POLL_THRESHOLD
    ),
  };
}

function nowIso(now = () => new Date()) {
  const value = now();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function formatSamplePR(repo, prNumber) {
  return `${repo}#${Number(prNumber)}`;
}

function buildNoProgressAlertText(payload) {
  return `No reviewer spawn for ${payload.pollsSinceLastSpawn} polls while `
    + `${payload.openPendingPRs} PR(s) await first pass.`;
}

function createWatcherHealthProbe({
  env = process.env,
  stdout = process.stdout,
  logger = console,
  pid = process.pid,
  now = () => new Date(),
  deliverAlertFn = defaultDeliverAlert,
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
} = {}) {
  const config = resolveHealthProbeConfig(env);
  const state = {
    healthState: 'healthy',
    pollsSinceLastSpawn: 0,
    silentPollsSinceLastSpawn: 0,
    lastSpawnAt: null,
    noProgressSilentPolls: 0,
    spawnsSinceRecovery: 0,
  };

  function beginTick() {
    return {
      enabled: config.enabled,
      openPendingPRs: 0,
      openPendingRereviewPRs: 0,
      samplePRs: [],
      pendingSet: new Map(),
      startedSet: new Set(),
      inFlightSet: new Set(),
      spawnCount: 0,
      recoveredFromSilentPolls: 0,
      finished: false,
    };
  }

  function recordOpenPending(tick, { repo, prNumber, hasCompletedReviewRound = false } = {}) {
    if (!config.enabled || !tick?.enabled || !repo || !prNumber) return;
    const sample = formatSamplePR(repo, prNumber);
    if (tick.pendingSet.has(sample) || tick.startedSet.has(sample) || tick.inFlightSet.has(sample)) return;
    tick.pendingSet.set(sample, hasCompletedReviewRound);
  }

  function recordInFlight(tick, { repo, prNumber } = {}) {
    if (!config.enabled || !tick?.enabled || !repo || !prNumber) return;
    const sample = formatSamplePR(repo, prNumber);
    tick.inFlightSet.add(sample);
    tick.pendingSet.delete(sample);
  }

  function recordSpawn(tick, { repo, prNumber, at = nowIso(now) } = {}) {
    if (!config.enabled || !tick?.enabled) return;
    if (repo && prNumber) {
      const sample = formatSamplePR(repo, prNumber);
      // Pipeline stages, fallback runs and heartbeat updates can report the
      // same logical attempt more than once.
      if (tick.startedSet.has(sample)) return;
      tick.startedSet.add(sample);
      tick.pendingSet.delete(sample);
    }
    tick.spawnCount += 1;
    const silentPolls = state.silentPollsSinceLastSpawn;
    tick.recoveredFromSilentPolls = Math.max(
      tick.recoveredFromSilentPolls,
      silentPolls
    );
    state.pollsSinceLastSpawn = 0;
    state.silentPollsSinceLastSpawn = 0;
    state.lastSpawnAt = at;
    // Single-wave dispatch can return before preparation launches the process.
    // A finalized tick will never reach finishTick again to report recovery.
    if (tick.finished) recordRecovery(1, silentPolls);
  }

  function emit(payload) {
    stdout?.write?.(`${JSON.stringify(payload)}\n`);
  }

  function recordRecovery(spawnCount, silentPolls) {
    if (state.healthState !== 'no_progress') return null;
    const payload = {
      event: 'watcher.recovered',
      spawnsSinceRecovery: spawnCount,
      recoveredFromSilentPolls: silentPolls,
      watcherPid: pid,
    };
    emit(payload);
    state.healthState = 'healthy';
    state.noProgressSilentPolls = 0;
    state.spawnsSinceRecovery = 0;
    // Recovery is telemetry only, never a page or stand-alone alert.
    return payload;
  }

  async function sendTransitionAlert(text, payload) {
    try {
      await deliverAlertFn(text, { event: payload?.event || null, payload });
      return true;
    } catch (err) {
      logger?.error?.(
        `[watcher] health alert delivery failed: ${err?.message || err}`
      );
      return false;
    }
  }

  async function finishTick(tick, { inFlightReviewers = [] } = {}) {
    if (!config.enabled || !tick?.enabled || tick.finished) return null;
    tick.finished = true;
    for (const reviewer of inFlightReviewers) {
      recordInFlight(tick, { repo: reviewer.repo, prNumber: reviewer.pr });
    }
    const firstPassPRs = [];
    tick.openPendingRereviewPRs = 0;
    for (const [sample, hasCompletedReviewRound] of tick.pendingSet) {
      if (hasCompletedReviewRound) tick.openPendingRereviewPRs += 1;
      else firstPassPRs.push(sample);
    }
    tick.openPendingPRs = firstPassPRs.length;
    tick.samplePRs = firstPassPRs.slice(0, sampleLimit);

    if (tick.spawnCount > 0) {
      const recovery = recordRecovery(tick.spawnCount, tick.recoveredFromSilentPolls);
      state.spawnsSinceRecovery = 0;
      return recovery;
    }

    state.silentPollsSinceLastSpawn += 1;
    // In-flight reviewers exclude only their own PR from pendingSet. An
    // unrelated reviewer must not hide waiting first passes. Quiet polls break
    // the waiting streak, but preserve the silent-poll recovery metric.
    if (tick.openPendingPRs === 0) {
      state.pollsSinceLastSpawn = 0;
      return null;
    }
    state.pollsSinceLastSpawn += 1;
    if (
      state.pollsSinceLastSpawn >= config.threshold &&
      tick.openPendingPRs >= 1
    ) {
      const payload = {
        event: 'watcher.no_progress',
        pollsSinceLastSpawn: state.pollsSinceLastSpawn,
        openPendingPRs: tick.openPendingPRs,
        openPendingRereviewPRs: tick.openPendingRereviewPRs,
        samplePRs: tick.samplePRs,
        lastSpawnAt: state.lastSpawnAt,
        watcherPid: pid,
        thresholdConfigured: config.threshold,
      };
      emit(payload);
      const isTransition = state.healthState !== 'no_progress';
      state.healthState = 'no_progress';
      state.noProgressSilentPolls = state.pollsSinceLastSpawn;
      state.spawnsSinceRecovery = 0;
      // This is an incident-transition alert, not a metronome.  Repeating the
      // identical page every threshold interval gives no new operator action
      // and turns a known stall into alert noise. Freshness owns the one
      // operator page; this earlier signal is retained as a digest notice.
      if (isTransition) {
        await sendTransitionAlert(buildNoProgressAlertText(payload), payload);
      }
      return payload;
    }

    return null;
  }

  return {
    beginTick,
    finishTick,
    recordOpenPending,
    recordInFlight,
    recordSpawn,
    getState() {
      return { ...state };
    },
    getConfig() {
      return { ...config };
    },
  };
}

export {
  buildNoProgressAlertText,
  createWatcherHealthProbe,
  parsePositiveInteger,
  resolveHealthProbeConfig,
};
