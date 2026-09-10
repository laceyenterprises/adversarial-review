import {
  readReviewerRunRecord,
} from './adapters/reviewer-runtime/run-state.mjs';

function resolveReviewerRunStateRoot({ env = process.env, rootDir = process.cwd() } = {}) {
  return String(env.REVIEWER_RUN_STATE_ROOT_DIR || rootDir || '').trim();
}

function persistReviewerChildRunState({
  env = process.env,
  rootDir = process.cwd(),
  sessionUuid = env.REVIEWER_SESSION_UUID,
  log = console,
} = {}) {
  const normalizedSessionUuid = String(sessionUuid || '').trim();
  if (!normalizedSessionUuid) return null;
  const runStateRoot = resolveReviewerRunStateRoot({ env, rootDir });
  if (!runStateRoot) return null;
  try {
    return readReviewerRunRecord(runStateRoot, normalizedSessionUuid);
  } catch (err) {
    log.warn?.(
      `[reviewer] WARN: reviewer child could not read run-state for ${normalizedSessionUuid}; ` +
        `${err?.message || err}`
    );
    return null;
  }
}

export {
  persistReviewerChildRunState,
  resolveReviewerRunStateRoot,
};
