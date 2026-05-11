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
  return [
    'Adversarial Watcher Health: watcher.no_progress',
    `Polls since last spawn: ${payload.pollsSinceLastSpawn}`,
    `Open pending PRs: ${payload.openPendingPRs}`,
    `Sample PRs: ${payload.samplePRs.length ? payload.samplePRs.join(', ') : 'none'}`,
    `Last spawn: ${payload.lastSpawnAt || 'never in this process'}`,
    `Watcher PID: ${payload.watcherPid}`,
    `Threshold: ${payload.thresholdConfigured}`,
  ].join('\n');
}

function buildRecoveredAlertText(payload) {
  return [
    'Adversarial Watcher Health: watcher.recovered',
    `Spawns since recovery: ${payload.spawnsSinceRecovery}`,
    `Recovered from silent polls: ${payload.recoveredFromSilentPolls}`,
    `Watcher PID: ${payload.watcherPid}`,
  ].join('\n');
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
    lastSpawnAt: null,
    noProgressSilentPolls: 0,
    spawnsSinceRecovery: 0,
  };

  function beginTick() {
    return {
      enabled: config.enabled,
      openPendingPRs: 0,
      samplePRs: [],
      pendingSet: new Set(),
      sampleSet: new Set(),
      spawnCount: 0,
      recoveredFromSilentPolls: 0,
    };
  }

  function recordOpenPending(tick, { repo, prNumber } = {}) {
    if (!config.enabled || !tick?.enabled || !repo || !prNumber) return;
    const sample = formatSamplePR(repo, prNumber);
    if (tick.pendingSet.has(sample)) return;
    tick.pendingSet.add(sample);
    tick.openPendingPRs += 1;
    if (tick.samplePRs.length >= sampleLimit || tick.sampleSet.has(sample)) return;
    tick.sampleSet.add(sample);
    tick.samplePRs.push(sample);
  }

  function recordSpawn(tick, { at = nowIso(now) } = {}) {
    if (!config.enabled || !tick?.enabled) return;
    tick.spawnCount += 1;
    tick.recoveredFromSilentPolls = Math.max(
      tick.recoveredFromSilentPolls,
      state.pollsSinceLastSpawn
    );
    state.pollsSinceLastSpawn = 0;
    state.lastSpawnAt = at;
  }

  function emit(payload) {
    stdout?.write?.(`${JSON.stringify(payload)}\n`);
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

  async function finishTick(tick) {
    if (!config.enabled || !tick?.enabled) return null;

    if (tick.spawnCount > 0) {
      const wasNoProgress = state.healthState === 'no_progress';
      if (wasNoProgress) {
        state.spawnsSinceRecovery += tick.spawnCount;
        const payload = {
          event: 'watcher.recovered',
          spawnsSinceRecovery: state.spawnsSinceRecovery,
          recoveredFromSilentPolls:
            tick.recoveredFromSilentPolls || state.noProgressSilentPolls,
          watcherPid: pid,
        };
        emit(payload);
        state.healthState = 'healthy';
        state.noProgressSilentPolls = 0;
        state.spawnsSinceRecovery = 0;
        await sendTransitionAlert(buildRecoveredAlertText(payload), payload);
        return payload;
      }
      state.spawnsSinceRecovery = 0;
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
      if (isTransition) {
        await sendTransitionAlert(buildNoProgressAlertText(payload), payload);
      }
      return payload;
    }

    if (state.healthState === 'no_progress' && tick.openPendingPRs === 0) {
      state.noProgressSilentPolls = state.pollsSinceLastSpawn;
    }
    return null;
  }

  return {
    beginTick,
    finishTick,
    recordOpenPending,
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
  buildRecoveredAlertText,
  createWatcherHealthProbe,
  parsePositiveInteger,
  resolveHealthProbeConfig,
};
