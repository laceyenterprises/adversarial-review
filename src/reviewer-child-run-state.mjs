import {
  readReviewerRunRecord,
  TERMINAL_RUN_STATES,
  updateReviewerRunRecord,
  writeReviewerRunRecord,
} from './adapters/reviewer-runtime/run-state.mjs';

function resolveReviewerRunStateRoot({ env = process.env, rootDir = process.cwd() } = {}) {
  return String(env.REVIEWER_RUN_STATE_ROOT_DIR || rootDir || '').trim();
}

function persistReviewerChildRunState({
  env = process.env,
  rootDir = process.cwd(),
  sessionUuid = env.REVIEWER_SESSION_UUID,
  subjectContext = null,
  pid = process.pid,
  now = () => new Date().toISOString(),
  log = console,
} = {}) {
  const normalizedSessionUuid = String(sessionUuid || '').trim();
  if (!normalizedSessionUuid) return null;
  const runStateRoot = resolveReviewerRunStateRoot({ env, rootDir });
  if (!runStateRoot) return null;
  const pgid = Number(pid);
  if (!Number.isInteger(pgid) || pgid <= 0) return null;
  const heartbeatAt = typeof now === 'function' ? String(now()) : new Date().toISOString();

  let existing = null;
  try {
    existing = readReviewerRunRecord(runStateRoot, normalizedSessionUuid);
  } catch (err) {
    log.warn?.(
      `[reviewer] WARN: reviewer child could not read run-state for ${normalizedSessionUuid}; ` +
        `repairing from child pid: ${err?.message || err}`
    );
  }
  if (existing && TERMINAL_RUN_STATES.has(existing.state)) return existing;

  const record = existing || {
    sessionUuid: normalizedSessionUuid,
    domain: subjectContext?.domainId || 'code-pr',
    runtime: 'cli-direct',
    reattachToken: normalizedSessionUuid,
    subjectContext,
  };
  const patch = {
    state: 'heartbeating',
    pgid,
    spawnedAt: heartbeatAt,
    lastHeartbeatAt: heartbeatAt,
    reattachToken: record.reattachToken || normalizedSessionUuid,
    subjectContext: record.subjectContext || subjectContext || null,
  };

  try {
    return existing
      ? updateReviewerRunRecord(runStateRoot, record, patch)
      : writeReviewerRunRecord(runStateRoot, {
          ...record,
          ...patch,
        });
  } catch (err) {
    log.warn?.(
      `[reviewer] WARN: reviewer child could not persist run-state for ${normalizedSessionUuid}: ` +
        `${err?.message || err}`
    );
    return null;
  }
}

export {
  persistReviewerChildRunState,
  resolveReviewerRunStateRoot,
};
