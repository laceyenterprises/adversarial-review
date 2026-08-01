import { loadRoleConfig } from './role-config.mjs';

const DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS = 3600;
const RUNNING_PASS_TIMEOUT_FAILURE_CLASS = 'reviewer-timeout';
const RUNNING_PASS_TIMEOUT_FAILURE_REASON = 'running-pass-timeout';

function parseMetadataJson(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseTimestampMs(value) {
  if (!value) return null;
  const text = String(value);
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function resolveRunningPassTimeoutSeconds(env = process.env, options = {}) {
  const raw = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'reviewer.running_pass_timeout_seconds',
  }).get(
    'reviewer.running_pass_timeout_seconds',
    DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS
  );
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS;
  }
  return parsed;
}

function reapRunningPassTimeouts({ db, log = console } = {}) {
  const thresholdSeconds = resolveRunningPassTimeoutSeconds();
  const rows = db.prepare(
    `SELECT pass_id, repo, pr_number, attempt_number, pass_kind, reviewer_class, reviewer_model, started_at, metadata_json
       FROM reviewer_passes
      WHERE status = 'running'
        AND ended_at IS NULL
        AND datetime(started_at) < datetime('now', '-' || ? || ' seconds')`
  ).all(thresholdSeconds);

  const update = db.prepare(
    `UPDATE reviewer_passes
        SET ended_at = ?,
            status = 'failed',
            metadata_json = ?
      WHERE pass_id = ?
        AND status = 'running'
        AND ended_at IS NULL`
  );

  let reaped = 0;
  for (const row of rows) {
    try {
      const startedMs = parseTimestampMs(row.started_at);
      if (startedMs == null) continue;
      const endedAt = new Date().toISOString();
      const metadata = {
        ...parseMetadataJson(row.metadata_json),
        failureClass: RUNNING_PASS_TIMEOUT_FAILURE_CLASS,
        failureReason: RUNNING_PASS_TIMEOUT_FAILURE_REASON,
        timeoutThresholdSeconds: thresholdSeconds,
      };
      const result = update.run(endedAt, JSON.stringify(metadata), row.pass_id);
      if (result.changes === 0) continue;
      const ageSeconds = Math.floor((Date.now() - startedMs) / 1000);
      log.log(
        `[watcher] reviewer-pass reaper: pr=${row.repo}#${row.pr_number} reviewer=${row.reviewer_model || row.reviewer_class}\n` +
        `          pass_id=${row.pass_id} status running->failed reason=${RUNNING_PASS_TIMEOUT_FAILURE_REASON}\n` +
        `          age=${ageSeconds}s threshold=${thresholdSeconds}s`
      );
      reaped++;
    } catch (err) {
      log.error(`[watcher] reviewer-pass reaper failed for ${row.repo}#${row.pr_number}:`, err);
    }
  }
  return { reaped };
}

export {
  DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS,
  resolveRunningPassTimeoutSeconds,
  reapRunningPassTimeouts,
};
