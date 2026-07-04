import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

const DEFAULT_WATCHER_STALL_EXIT_CODE = 75;
const DEFAULT_WATCHER_STALL_WATCHDOG_MS = 10 * 60 * 1000;
const DEFAULT_WATCHER_STALL_CHECK_INTERVAL_MS = 30 * 1000;

function watcherHeartbeatPath(rootDir) {
  return join(rootDir, 'data', 'watcher-heartbeat.json');
}

function parsePositiveMs(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readPriorHeartbeat(filePath, readFile = readFileSync) {
  try {
    return JSON.parse(readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeCounter(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : 0;
}

function createWatcherHeartbeat({
  rootDir,
  filePath = watcherHeartbeatPath(rootDir),
  now = () => new Date(),
  writeFile = writeFileAtomic,
  readFile = readFileSync,
  pid = process.pid,
  logger = console,
} = {}) {
  if (!filePath) {
    throw new TypeError('createWatcherHeartbeat requires rootDir or filePath');
  }

  const prior = readPriorHeartbeat(filePath, readFile);
  let pollCounter = normalizeCounter(prior?.poll_counter);
  let lastPollAt = typeof prior?.last_poll_at === 'string' ? prior.last_poll_at : null;
  let lastReviewAt = typeof prior?.last_review_at === 'string' ? prior.last_review_at : null;

  function persist(event, extra = {}, at = now().toISOString()) {
    const heartbeat = {
      schema_version: 1,
      watcher_pid: pid,
      updated_at: at,
      last_poll_at: lastPollAt,
      last_review_at: lastReviewAt,
      poll_counter: pollCounter,
      event,
      ...extra,
    };
    try {
      writeFile(filePath, `${JSON.stringify(heartbeat, null, 2)}\n`);
    } catch (err) {
      logger?.warn?.(`[watcher] failed to persist heartbeat at ${filePath}: ${err?.message || err}`);
    }
    return heartbeat;
  }

  function markPoll(extra = {}) {
    const at = now().toISOString();
    pollCounter += 1;
    lastPollAt = at;
    return persist('poll', extra, at);
  }

  function markReview(extra = {}) {
    const at = now().toISOString();
    lastReviewAt = at;
    return persist('review', extra, at);
  }

  function snapshot() {
    return {
      filePath,
      last_poll_at: lastPollAt,
      last_review_at: lastReviewAt,
      poll_counter: pollCounter,
    };
  }

  return { filePath, markPoll, markReview, persist, snapshot };
}

function createWatcherStallWatchdog({
  heartbeat,
  stallMs = DEFAULT_WATCHER_STALL_WATCHDOG_MS,
  checkIntervalMs = DEFAULT_WATCHER_STALL_CHECK_INTERVAL_MS,
  nowMs = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onStall,
  exitCode = DEFAULT_WATCHER_STALL_EXIT_CODE,
  logger = console,
} = {}) {
  if (!heartbeat || typeof heartbeat.snapshot !== 'function') {
    throw new TypeError('createWatcherStallWatchdog requires a heartbeat with snapshot()');
  }
  const effectiveStallMs = parsePositiveMs(stallMs, DEFAULT_WATCHER_STALL_WATCHDOG_MS);
  const effectiveCheckIntervalMs = parsePositiveMs(
    checkIntervalMs,
    Math.min(DEFAULT_WATCHER_STALL_CHECK_INTERVAL_MS, effectiveStallMs),
  );
  let lastCounter = normalizeCounter(heartbeat.snapshot().poll_counter);
  let lastProgressMs = nowMs();
  let pollInFlight = false;
  let tripped = false;
  let timer = null;

  function noteProgress() {
    const currentCounter = normalizeCounter(heartbeat.snapshot().poll_counter);
    if (currentCounter !== lastCounter) {
      lastCounter = currentCounter;
      lastProgressMs = nowMs();
    }
  }

  function beginPoll() {
    pollInFlight = true;
    noteProgress();
  }

  function endPoll() {
    pollInFlight = false;
    noteProgress();
  }

  function check() {
    noteProgress();
    if (tripped || pollInFlight) return false;
    const stalledForMs = nowMs() - lastProgressMs;
    if (stalledForMs < effectiveStallMs) return false;
    tripped = true;
    const snapshot = heartbeat.snapshot();
    logger?.error?.(
      `[watcher] stall watchdog: no poll-counter advance for ${stalledForMs}ms ` +
      `(last_poll_at=${snapshot.last_poll_at || 'null'}, poll_counter=${snapshot.poll_counter}); ` +
      `exiting ${exitCode} for launchd respawn`
    );
    onStall?.({
      exitCode,
      stalledForMs,
      stallMs: effectiveStallMs,
      heartbeat: snapshot,
    });
    return true;
  }

  function start() {
    if (timer) return timer;
    timer = setIntervalFn(check, effectiveCheckIntervalMs);
    return timer;
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  return {
    beginPoll,
    endPoll,
    check,
    start,
    stop,
    getState: () => ({
      pollInFlight,
      tripped,
      lastCounter,
      lastProgressMs,
      stallMs: effectiveStallMs,
      checkIntervalMs: effectiveCheckIntervalMs,
    }),
  };
}

export {
  createWatcherHeartbeat,
  createWatcherStallWatchdog,
  watcherHeartbeatPath,
  DEFAULT_WATCHER_STALL_EXIT_CODE,
  DEFAULT_WATCHER_STALL_WATCHDOG_MS,
  DEFAULT_WATCHER_STALL_CHECK_INTERVAL_MS,
};
