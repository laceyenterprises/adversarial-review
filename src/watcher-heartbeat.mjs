import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { assertCanonicalOwner } from './adapters/agent-runtime/append-only-owner.mjs';
import { writeFileAtomic } from './atomic-write.mjs';

const DEFAULT_WATCHER_STALL_EXIT_CODE = 75;
const DEFAULT_WATCHER_STALL_WATCHDOG_MS = 10 * 60 * 1000;
const DEFAULT_WATCHER_STALL_CHECK_INTERVAL_MS = 30 * 1000;

// WPS-01 — poll STARVATION, as distinct from poll ABSENCE.
//
// The stall watchdog below answers "is the watcher failing to start polls while
// idle?" and deliberately returns early whenever `pollInFlight` is true: a poll
// that is running is, for its purposes, healthy. That blind spot is the entire
// failure mode of this incident. A live watcher spent 40+ minutes inside ONE
// tick — 0% CPU, sleeping, no child processes, `poll_counter` frozen, heartbeat
// long past its 900s SLA — and every liveness surface reported healthy, because
// the process existed and a poll was technically "in flight". The outer
// `safePollOnce` deadline could not catch it either: it is workload-aware and
// resolves to roughly 12.5 hours for a single repo.
//
// So this adds the missing signal on exactly that state: a poll in flight for
// longer than the heartbeat SLA with no `poll_counter` advance, observed across
// several consecutive checks so a single slow-but-productive tick is not paged.
//
// It SIGNALS, it does not exit. Killing a long tick would abort in-flight
// reviewer work that may be legitimately slow, and the existing
// POLL_DEADLINE_EXCEEDED path already owns the kill decision. What was missing
// was somebody being told — this fills that gap and leaves recovery policy where
// it already lives.
const DEFAULT_WATCHER_POLL_STARVATION_MS = 15 * 60 * 1000;
const DEFAULT_WATCHER_POLL_STARVATION_CHECKS = 3;
const WRONG_OWNED_HEARTBEAT_MESSAGE = 'refusing write to non-canonical-owned watcher heartbeat file';

function watcherHeartbeatPath(rootDir) {
  return join(rootDir, 'data', 'watcher-heartbeat.json');
}

// Resolve the heartbeat file path so it is ALWAYS written to a stable,
// well-known location, whether or not the operator pins one. Priority:
//   1. explicit ADVERSARIAL_WATCHER_HEARTBEAT_PATH override, else
//   2. `${HQ_ROOT}/.adversarial-watcher/heartbeat.json` when HQ_ROOT is set
//      (the launchd deploy always sets HQ_ROOT), which lives outside the
//      submodule tree so the external liveness watchdog has one fixed path
//      to poll, else
//   3. the `${rootDir}/data/watcher-heartbeat.json` default next to the
//      watcher's own data dir.
// Returning `undefined` lets createWatcherHeartbeat fall back to (3) when
// neither an override nor HQ_ROOT nor rootDir is available.
function resolveWatcherHeartbeatPath({ env = process.env, rootDir } = {}) {
  const override = env?.ADVERSARIAL_WATCHER_HEARTBEAT_PATH;
  if (typeof override === 'string' && override.trim() !== '') {
    return override;
  }
  const hqRoot = env?.HQ_ROOT;
  if (typeof hqRoot === 'string' && hqRoot.trim() !== '') {
    return join(hqRoot, '.adversarial-watcher', 'heartbeat.json');
  }
  if (rootDir) {
    return watcherHeartbeatPath(rootDir);
  }
  return undefined;
}

function resolveWatcherHeartbeatOwnerGuardRoot({ env = process.env, rootDir, filePath } = {}) {
  const hqRoot = env?.HQ_ROOT;
  if (typeof hqRoot === 'string' && hqRoot.trim() !== '') {
    const hqHeartbeatPath = join(hqRoot, '.adversarial-watcher', 'heartbeat.json');
    if (filePath === hqHeartbeatPath) {
      return hqRoot;
    }
  }
  return rootDir;
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

function isWrongOwnedHeartbeatError(err) {
  return typeof err?.message === 'string' && err.message.startsWith(WRONG_OWNED_HEARTBEAT_MESSAGE);
}

function createWatcherHeartbeat({
  rootDir,
  filePath = watcherHeartbeatPath(rootDir),
  now = () => new Date(),
  writeFile = writeFileAtomic,
  readFile = readFileSync,
  unlinkFile = unlinkSync,
  pid = process.pid,
  logger = console,
  ownerGuardRootDir = rootDir,
  ownerGuardOptions,
} = {}) {
  if (!filePath) {
    throw new TypeError('createWatcherHeartbeat requires rootDir or filePath');
  }

  const prior = readPriorHeartbeat(filePath, readFile);
  let pollCounter = normalizeCounter(prior?.poll_counter);
  let completedPollCounter = normalizeCounter(prior?.completed_poll_counter);
  let lastPollAt = typeof prior?.last_poll_at === 'string' ? prior.last_poll_at : null;
  let lastCompletedPollAt = typeof prior?.last_completed_poll_at === 'string'
    ? prior.last_completed_poll_at
    : null;
  let lastReviewAt = typeof prior?.last_review_at === 'string' ? prior.last_review_at : null;
  let lastSpawnDecisionAt = typeof prior?.last_spawn_decision_at === 'string'
    ? prior.last_spawn_decision_at
    : null;
  let lastSpawnDecision = prior?.last_spawn_decision && typeof prior.last_spawn_decision === 'object'
    ? prior.last_spawn_decision
    : null;
  let pendingReviewHeartbeat = null;
  let reviewPersistScheduled = false;
  let reviewPersistChain = Promise.resolve();

  function assertHeartbeatOwner() {
    assertCanonicalOwner(ownerGuardRootDir, filePath, {
      cannotVerifyMessage: 'cannot verify watcher heartbeat caller ownership',
      crossUserMessage: 'refusing cross-user watcher heartbeat write',
      existingFileMessage: WRONG_OWNED_HEARTBEAT_MESSAGE,
      ...ownerGuardOptions,
    });
  }

  function writeHeartbeat(heartbeat) {
    try {
      if (ownerGuardRootDir) {
        try {
          assertHeartbeatOwner();
        } catch (err) {
          if (!isWrongOwnedHeartbeatError(err)) throw err;
          logger?.warn?.(
            `[watcher] recovering wrong-owned heartbeat at ${filePath}: ${err.message}; unlinking and retrying`
          );
          try {
            unlinkFile(filePath);
          } catch (unlinkErr) {
            if (unlinkErr?.code !== 'ENOENT') throw unlinkErr;
          }
          assertHeartbeatOwner();
        }
      }
      return Promise.resolve(writeFile(filePath, `${JSON.stringify(heartbeat, null, 2)}\n`))
        .catch((err) => {
          logger?.warn?.(`[watcher] failed to persist heartbeat at ${filePath}: ${err?.message || err}`);
        });
    } catch (err) {
      logger?.warn?.(`[watcher] failed to persist heartbeat at ${filePath}: ${err?.message || err}`);
      return Promise.resolve();
    }
  }

  function persistReviewLater(heartbeat) {
    pendingReviewHeartbeat = heartbeat;
    if (reviewPersistScheduled) return;
    reviewPersistScheduled = true;
    queueMicrotask(() => {
      reviewPersistScheduled = false;
      const nextHeartbeat = pendingReviewHeartbeat;
      pendingReviewHeartbeat = null;
      reviewPersistChain = reviewPersistChain.then(() => writeHeartbeat(nextHeartbeat));
    });
  }

  function heartbeatPayload(event, extra = {}, at = now().toISOString()) {
    return {
      schema_version: 1,
      watcher_pid: pid,
      updated_at: at,
      last_poll_at: lastPollAt,
      last_completed_poll_at: lastCompletedPollAt,
      last_review_at: lastReviewAt,
      last_spawn_decision_at: lastSpawnDecisionAt,
      last_spawn_decision: lastSpawnDecision,
      poll_counter: pollCounter,
      completed_poll_counter: completedPollCounter,
      event,
      ...extra,
    };
  }

  function persist(event, extra = {}, at = now().toISOString()) {
    const heartbeat = heartbeatPayload(event, extra, at);
    void writeHeartbeat(heartbeat);
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
    const heartbeat = heartbeatPayload('review', extra, at);
    persistReviewLater(heartbeat);
    return heartbeat;
  }

  function markPollCompleted(extra = {}) {
    const at = now().toISOString();
    completedPollCounter += 1;
    lastCompletedPollAt = at;
    return persist('poll-completed', extra, at);
  }

  function markSpawnDecision(extra = {}) {
    const at = now().toISOString();
    lastSpawnDecisionAt = at;
    lastSpawnDecision = {
      ...extra,
      decided_at: at,
    };
    return persist('spawn-decision', {}, at);
  }

  function snapshot() {
    return {
      filePath,
      last_poll_at: lastPollAt,
      last_completed_poll_at: lastCompletedPollAt,
      last_review_at: lastReviewAt,
      last_spawn_decision_at: lastSpawnDecisionAt,
      last_spawn_decision: lastSpawnDecision,
      poll_counter: pollCounter,
      completed_poll_counter: completedPollCounter,
    };
  }

  async function flush() {
    await Promise.resolve();
    await reviewPersistChain;
  }

  return { filePath, markPoll, markPollCompleted, markReview, markSpawnDecision, persist, snapshot, flush };
}

function createWatcherStallWatchdog({
  heartbeat,
  stallMs = DEFAULT_WATCHER_STALL_WATCHDOG_MS,
  checkIntervalMs = DEFAULT_WATCHER_STALL_CHECK_INTERVAL_MS,
  nowMs = () => performance.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onStall,
  starvationMs = DEFAULT_WATCHER_POLL_STARVATION_MS,
  starvationChecksRequired = DEFAULT_WATCHER_POLL_STARVATION_CHECKS,
  onStarvation,
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
  const effectiveStarvationMs = parsePositiveMs(starvationMs, DEFAULT_WATCHER_POLL_STARVATION_MS);
  const effectiveStarvationChecks = Math.max(
    1,
    Math.trunc(parsePositiveMs(starvationChecksRequired, DEFAULT_WATCHER_POLL_STARVATION_CHECKS)),
  );
  let lastCounter = normalizeCounter(heartbeat.snapshot().poll_counter);
  let lastProgressMs = nowMs();
  let pollInFlight = false;
  let tripped = false;
  let timer = null;
  let pollStartedMs = null;
  let pollStartCounter = null;
  let starvationChecks = 0;
  let starvationSignalled = false;

  function noteProgress() {
    const currentCounter = normalizeCounter(heartbeat.snapshot().poll_counter);
    if (currentCounter !== lastCounter) {
      lastCounter = currentCounter;
      lastProgressMs = nowMs();
    }
  }

  function beginPoll() {
    pollInFlight = true;
    pollStartedMs = nowMs();
    pollStartCounter = normalizeCounter(heartbeat.snapshot().poll_counter);
    starvationChecks = 0;
    starvationSignalled = false;
    noteProgress();
  }

  function endPoll() {
    pollInFlight = false;
    pollStartedMs = null;
    pollStartCounter = null;
    starvationChecks = 0;
    starvationSignalled = false;
    lastProgressMs = nowMs();
    noteProgress();
  }

  // Runs only while a poll is in flight — the window the stall watchdog skips.
  // Returns true on the tick it signals, so callers/tests can observe the edge.
  function checkStarvation() {
    if (pollStartedMs === null) return false;
    const inFlightMs = nowMs() - pollStartedMs;
    if (inFlightMs < effectiveStarvationMs) {
      starvationChecks = 0;
      return false;
    }
    const snapshot = heartbeat.snapshot();
    if (normalizeCounter(snapshot.poll_counter) !== pollStartCounter) {
      // The counter advanced under us (a re-entrant or externally-driven poll):
      // whatever this is, it is not a frozen loop.
      starvationChecks = 0;
      return false;
    }
    starvationChecks += 1;
    if (starvationChecks < effectiveStarvationChecks) return false;
    // One signal per poll. Re-arming per check would page on a loop; the
    // condition is durable, so the first observation is the one that matters and
    // the heartbeat file keeps the state readable until the poll ends.
    if (starvationSignalled) return false;
    starvationSignalled = true;
    logger?.error?.(
      `[watcher] poll starvation: one poll has been in flight for ${Math.round(inFlightMs)}ms ` +
      `with no poll_counter advance across ${starvationChecks} consecutive checks ` +
      `(poll_counter=${snapshot.poll_counter}, last_poll_at=${snapshot.last_poll_at || 'null'}); ` +
      'new PRs cannot be discovered until this tick returns',
    );
    onStarvation?.({
      inFlightMs,
      starvationMs: effectiveStarvationMs,
      checks: starvationChecks,
      checksRequired: effectiveStarvationChecks,
      heartbeat: snapshot,
    });
    return true;
  }

  function check() {
    noteProgress();
    if (pollInFlight && !tripped) {
      checkStarvation();
    }
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
    checkStarvation,
    start,
    stop,
    getState: () => ({
      pollInFlight,
      tripped,
      lastCounter,
      lastProgressMs,
      stallMs: effectiveStallMs,
      checkIntervalMs: effectiveCheckIntervalMs,
      starvationMs: effectiveStarvationMs,
      starvationChecksRequired: effectiveStarvationChecks,
      starvationChecks,
      starvationSignalled,
      pollInFlightMs: pollStartedMs === null ? null : nowMs() - pollStartedMs,
    }),
  };
}

export {
  createWatcherHeartbeat,
  createWatcherStallWatchdog,
  watcherHeartbeatPath,
  resolveWatcherHeartbeatPath,
  resolveWatcherHeartbeatOwnerGuardRoot,
  DEFAULT_WATCHER_STALL_EXIT_CODE,
  DEFAULT_WATCHER_STALL_WATCHDOG_MS,
  DEFAULT_WATCHER_STALL_CHECK_INTERVAL_MS,
  DEFAULT_WATCHER_POLL_STARVATION_MS,
  DEFAULT_WATCHER_POLL_STARVATION_CHECKS,
};
