// ARC-18 (cluster 20): the reviewer fence + SIGTERM/exit cluster, extracted
// verbatim from watcher.mjs. cancelInFlightReviewerRuntimeSessions +
// cancelReviewerRuntimeSession drive reviewer-runtime cancellation; the fence
// helpers (emit/quarantine/queue/process/sweep/wait) reconcile the on-disk
// spawn fence; exitAfterReviewerCleanup/exitForPollDeadline own the
// preserve-vs-cancel exit path; shouldPreserveReviewersOnSigterm is the pure
// SIGTERM policy. The process-level SIGTERM/uncaughtException/unhandledRejection
// handlers stay in watcher.mjs and call these functions via the import-back.
//
// Shared mutable session collections come from ./reviewer-session-registry.mjs
// (same live references the spawn/settle cluster mutates). ROOT /
// ADVERSARIAL_REVIEW_STATE_DIR / POLL_DEADLINE_EXIT_CODE and the module-level
// exitInProgress guard are re-derived / moved here (all cluster-exclusive);
// resolveBotTokenEnvForIdentity moves too (only processQueuedFenceCleanupJobs
// used it). Never import from watcher.mjs.
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inFlightReviewerSessions,
  activeReviewerSpawns,
} from './reviewer-session-registry.mjs';
import {
  reviewerRuntimeAdapterForRunRecord,
  reviewerRuntimeState,
} from './reviewer-runtime-adapter.mjs';
import { readReviewerRunRecord } from './adapters/reviewer-runtime/run-state.mjs';
import { clearPendingReviewsForSelf } from './reviewer-pre-write.mjs';
import {
  appendFenceAuditEvent,
  classifyFenceOrphan,
  deleteCleanupJob,
  isFenceStale,
  listCleanupJobs,
  listFenceJsonPaths,
  listFenceLockPaths,
  loadSpawnRecords,
  moveFenceArtifactToQuarantine,
  probeFenceLock,
  queueFenceCleanupJob,
  readFenceRecord,
  resolveAdversarialReviewStateDir,
  resolveFencePaths,
  resolveSigtermFenceGraceSeconds,
  syncSpawnRecords,
  validateFenceConfig,
} from './reviewer-fence.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADVERSARIAL_REVIEW_STATE_DIR = resolveAdversarialReviewStateDir(ROOT, process.env);

// Distinct exit code for poll-watchdog-tripped restarts so the launchd
// log shows whether respawns are caused by SQLite orphan recovery (75)
// or a hung poll deadline (86). KeepAlive=true respawns either way.
const POLL_DEADLINE_EXIT_CODE = 86;

function resolveBotTokenEnvForIdentity(identity) {
  const normalized = String(identity || '').trim().toLowerCase();
  if (normalized.startsWith('codex-reviewer-')) return 'GH_CODEX_REVIEWER_TOKEN';
  if (normalized.startsWith('claude-reviewer-')) return 'GH_CLAUDE_REVIEWER_TOKEN';
  if (normalized.startsWith('gemini-reviewer-')) return 'GH_GEMINI_REVIEWER_TOKEN';
  return null;
}


let exitInProgress = false;

async function cancelInFlightReviewerRuntimeSessions(reason) {
  const sessions = Array.from(inFlightReviewerSessions);
  inFlightReviewerSessions.clear();
  await Promise.all(sessions.map(async (sessionUuid) => {
    await cancelReviewerRuntimeSession({ sessionUuid, reason });
  }));
}

async function cancelReviewerRuntimeSession({
  sessionUuid,
  reason,
  rootDir = ROOT,
  logger = console,
  readRunRecord = readReviewerRunRecord,
  adapterForRecord = reviewerRuntimeAdapterForRunRecord,
  defaultAdapter = reviewerRuntimeState.adapter,
} = {}) {
  let record = null;
  try {
    record = readRunRecord(rootDir, sessionUuid);
  } catch (err) {
    logger.error?.(
      `[watcher] reviewer_runtime_cancel_record_read_failed session=${sessionUuid} reason=${reason}; using default runtime: ${err?.message || err}`
    );
  }

  let cancelAdapter = defaultAdapter;
  if (record) {
    try {
      cancelAdapter = adapterForRecord(record, { rootDir, logger });
    } catch (err) {
      logger.error?.(
        `[watcher] reviewer_runtime_cancel_adapter_resolve_failed session=${sessionUuid} runtime=${record.runtime} reason=${reason}; using default runtime: ${err?.message || err}`
      );
      cancelAdapter = defaultAdapter;
    }
  }

  try {
    await cancelAdapter.cancel(sessionUuid);
  } catch (err) {
    logger.error?.(
      `[watcher] reviewer_runtime_cancel_failed session=${sessionUuid} reason=${reason}: ${err?.message || err}`
    );
  }
}

function emitFenceAuditEvent(stateDir = ADVERSARIAL_REVIEW_STATE_DIR, event) {
  const payload = {
    schemaVersion: 1,
    ...event,
  };
  console.log(JSON.stringify(payload));
  appendFenceAuditEvent(stateDir, payload);
}

function quarantineCorruptFenceFile(stateDir, filePath, {
  fileKind,
  err,
} = {}) {
  const quarantinedPath = moveFenceArtifactToQuarantine(stateDir, filePath, {
    prefix: `${fileKind || 'file'}-corrupt`,
  });
  emitFenceAuditEvent(stateDir, {
    event: 'fence_corrupted_skipped',
    fileKind: fileKind || null,
    filePath,
    quarantinedPath,
    error: err?.message || String(err),
  });
  return quarantinedPath;
}

async function processQueuedFenceCleanupJobs({
  stateDir = ADVERSARIAL_REVIEW_STATE_DIR,
  clearPendingReviewsImpl = clearPendingReviewsForSelf,
  log = console,
} = {}) {
  let processed = 0;
  for (const jobPath of listCleanupJobs(stateDir)) {
    let job;
    try {
      job = JSON.parse(readFileSync(jobPath, 'utf8'));
    } catch (err) {
      quarantineCorruptFenceFile(stateDir, jobPath, {
        fileKind: 'cleanup-job',
        err,
      });
      continue;
    }
    const tokenEnv = job.botTokenEnv || resolveBotTokenEnvForIdentity(job.identity);
    try {
      if (!tokenEnv) {
        throw new Error(`Unknown reviewer identity ${JSON.stringify(job.identity)}; cannot resolve bot token env`);
      }
      if (!process.env[tokenEnv]) {
        throw new Error(`Missing ${tokenEnv}; cleanup job retained for retry`);
      }
      await clearPendingReviewsImpl({
        repo: job.repo,
        prNumber: job.pr,
        token: process.env[tokenEnv],
        log,
      });
      deleteCleanupJob(jobPath);
      processed += 1;
      emitFenceAuditEvent(stateDir, {
        event: 'fence_cleanup_processed',
        spawnToken: job.spawnToken || null,
        repo: job.repo,
        pr: job.pr,
        identity: job.identity || null,
      });
    } catch (err) {
      emitFenceAuditEvent(stateDir, {
        event: 'fence_cleanup_failed',
        spawnToken: job.spawnToken || null,
        repo: job.repo,
        pr: job.pr,
        identity: job.identity || null,
        error: err?.message || String(err),
      });
    }
  }
  return processed;
}

function queueFenceCleanupFromRecord(record, {
  stateDir = ADVERSARIAL_REVIEW_STATE_DIR,
  botTokenEnv = null,
  reason,
} = {}) {
  queueFenceCleanupJob(stateDir, {
    spawnToken: record.spawnToken,
    repo: record.repo || null,
    pr: record.pr,
    identity: record.identity,
    botTokenEnv: botTokenEnv || null,
    reason,
  });
}

async function sweepReviewerFencesOnStartup({
  stateDir = ADVERSARIAL_REVIEW_STATE_DIR,
  staleTtlSeconds = validateFenceConfig(process.env).staleTtlSeconds,
  activeSpawnMap = activeReviewerSpawns,
} = {}) {
  const persistedSpawnRecords = loadSpawnRecords(stateDir);
  const persistedSpawnTokens = new Set(Object.keys(persistedSpawnRecords));
  const activeSpawnTokens = new Set(activeSpawnMap.keys());
  let orphaned = 0;

  for (const jsonPath of listFenceJsonPaths(stateDir)) {
    let record;
    try {
      record = readFenceRecord(jsonPath);
    } catch (err) {
      quarantineCorruptFenceFile(stateDir, jsonPath, {
        fileKind: 'fence-json',
        err,
      });
      continue;
    }
    const { lockPath } = resolveFencePaths(stateDir, record.spawnToken);
    const lockProbe = probeFenceLock(lockPath);
    const orphanDecision = classifyFenceOrphan({
      record,
      lockProbe,
      activeSpawnTokens,
      persistedSpawnTokens,
      staleTtlSeconds,
    });
    if (!orphanDecision.orphan) {
      continue;
    }

    if (lockProbe.reason === 'lock-missing') {
      emitFenceAuditEvent(stateDir, {
        event: 'fence_lock_missing_with_json',
        spawnToken: record.spawnToken,
        pr: record.pr,
        identity: record.identity,
      });
    }
    const persisted = persistedSpawnRecords[record.spawnToken] || null;
    queueFenceCleanupFromRecord(
      { ...persisted, ...record },
      {
        stateDir,
        botTokenEnv: persisted?.botTokenEnv || null,
        reason: orphanDecision.reason,
      }
    );
    rmSync(jsonPath, { force: true });
    rmSync(lockPath, { force: true });
    delete persistedSpawnRecords[record.spawnToken];
    orphaned += 1;
    emitFenceAuditEvent(stateDir, {
      event: 'fence_orphan_reaped',
      spawnToken: record.spawnToken,
      pr: record.pr,
      identity: record.identity,
      orphanReason: orphanDecision.reason,
    });
  }

  const now = Date.now();
  for (const lockPath of listFenceLockPaths(stateDir)) {
    const spawnToken = basename(lockPath, '.lock');
    const { jsonPath } = resolveFencePaths(stateDir, spawnToken);
    if (existsSync(jsonPath)) continue;
    let ageSeconds = Number.POSITIVE_INFINITY;
    try {
      ageSeconds = (now - statSync(lockPath).mtimeMs) / 1000;
    } catch (err) {
      emitFenceAuditEvent(stateDir, {
        event: 'fence_orphan_lock_probe_failed',
        spawnToken,
        error: err?.message || String(err),
      });
      continue;
    }
    if (ageSeconds <= staleTtlSeconds) continue;
    rmSync(lockPath, { force: true });
    orphaned += 1;
    emitFenceAuditEvent(stateDir, {
      event: 'fence_orphan_lock_reaped',
      spawnToken,
      ageSeconds,
    });
  }

  for (const activeToken of activeSpawnMap.keys()) {
    persistedSpawnRecords[activeToken] = persistedSpawnRecords[activeToken] || activeSpawnMap.get(activeToken);
  }
  syncSpawnRecords(stateDir, persistedSpawnRecords);
  return orphaned;
}

async function waitForActiveReviewerFencesOnSigterm({
  stateDir = ADVERSARIAL_REVIEW_STATE_DIR,
  graceSeconds = resolveSigtermFenceGraceSeconds(process.env),
  staleTtlSeconds = validateFenceConfig(process.env).staleTtlSeconds,
  activeSpawnMap = activeReviewerSpawns,
  queueCleanupOnGraceExpiry = true,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const deadlineMs = Date.now() + (graceSeconds * 1000);
  const remaining = new Map();
  let sawStaleFence = false;
  for (const jsonPath of listFenceJsonPaths(stateDir)) {
    const record = readFenceRecord(jsonPath);
    if (!activeSpawnMap.has(record.spawnToken)) continue;
    const spawnMeta = activeSpawnMap.get(record.spawnToken);
    remaining.set(record.spawnToken, {
      ...record,
      repo: spawnMeta?.repo || null,
      botTokenEnv: spawnMeta?.botTokenEnv || null,
      jsonPath,
      lockPath: resolveFencePaths(stateDir, record.spawnToken).lockPath,
    });
  }
  if (remaining.size === 0) {
    return { status: 'no-active-fence', outstanding: [] };
  }

  while (remaining.size > 0) {
    for (const [spawnToken, record] of remaining.entries()) {
      if (!existsSync(record.jsonPath)) {
        remaining.delete(spawnToken);
        continue;
      }
      if (isFenceStale(record, staleTtlSeconds)) {
        queueFenceCleanupFromRecord(record, {
          stateDir,
          botTokenEnv: record.botTokenEnv,
          reason: 'fence_stuck_open',
        });
        emitFenceAuditEvent(stateDir, {
          event: 'fence_stuck_open',
          spawnToken,
          repo: record.repo,
          pr: record.pr,
          identity: record.identity,
          openedAt: record.openedAt,
        });
        sawStaleFence = true;
        remaining.delete(spawnToken);
        continue;
      }
    }
    if (remaining.size === 0) break;
    if (Date.now() >= deadlineMs) {
      for (const record of remaining.values()) {
        if (queueCleanupOnGraceExpiry) {
          queueFenceCleanupFromRecord(record, {
            stateDir,
            botTokenEnv: record.botTokenEnv,
            reason: 'fence_grace_exceeded',
          });
        }
        emitFenceAuditEvent(stateDir, {
          event: 'fence_grace_exceeded',
          spawnToken: record.spawnToken,
          repo: record.repo,
          pr: record.pr,
          identity: record.identity,
          openedAt: record.openedAt,
          cleanupQueued: queueCleanupOnGraceExpiry,
        });
      }
      return {
        status: 'grace-exceeded',
        outstanding: Array.from(remaining.values()),
      };
    }
    await sleepImpl(250);
  }
  return { status: sawStaleFence ? 'stale' : 'cleared', outstanding: [] };
}

function exitAfterReviewerCleanup({
  code,
  reason,
  source,
  message,
  err = null,
  preserveInFlightReviewers = true,
} = {}) {
  if (exitInProgress) return;
  exitInProgress = true;
  const detail = err ? `: ${err?.stack || err?.message || err}` : '';
  console.error(`[watcher] ${message}${source ? ` (source=${source})` : ''}${detail}`);
  process.exitCode = code;
  if (preserveInFlightReviewers) {
    const preserved = inFlightReviewerSessions.size;
    inFlightReviewerSessions.clear();
    console.error(
      `[watcher] reviewer_runtime_preserved_on_drain count=${preserved} reason=${reason} ` +
      `— next watcher will reattach via reconcileReviewerSessions`
    );
    setImmediate(() => process.exit(code));
    return;
  }
  const forceExitTimer = setTimeout(() => {
    process.exit(code);
  }, 5_000);
  forceExitTimer.unref?.();
  cancelInFlightReviewerRuntimeSessions(reason)
    .catch((cleanupErr) => {
      console.error('[watcher] reviewer runtime cancellation failed during exit:', cleanupErr);
    })
    .finally(() => {
      clearTimeout(forceExitTimer);
      setImmediate(() => process.exit(code));
    });
}

function exitForPollDeadline(err, source) {
  exitAfterReviewerCleanup({
    code: POLL_DEADLINE_EXIT_CODE,
    reason: 'poll deadline exceeded',
    source,
    err,
    message:
      'FATAL: poll deadline exceeded. Preserving in-flight reviewer runtime sessions so launchd can respawn and reattach',
  });
}

// Decision: does a SIGTERM preserve in-flight reviewers?
// Pulled out as a pure function so tests can exercise the rule without
// having to fork the watcher process and capture process.exit. The rule is
// now intentionally simple: every routine daemon SIGTERM preserves children.
// Operators use `npm run hard-shutdown` for the distinct cancel-first path.
//
// See `projects/daemon-bounce-safety/SPEC.md` §6a for the contract.
function shouldPreserveReviewersOnSigterm(_drainState) {
  return true;
}

export {
  cancelReviewerRuntimeSession,
  processQueuedFenceCleanupJobs,
  sweepReviewerFencesOnStartup,
  waitForActiveReviewerFencesOnSigterm,
  exitAfterReviewerCleanup,
  exitForPollDeadline,
  shouldPreserveReviewersOnSigterm,
};
