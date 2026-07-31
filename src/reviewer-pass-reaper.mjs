import { loadRoleConfig } from './role-config.mjs';
import { completeReviewerPass } from './reviewer-pass-tokens.mjs';
import { QUOTA_EXHAUSTED_FAILURE_CLASS } from './quota-exhaustion.mjs';

const DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS = 3600;

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

function reapRunningPassTimeouts({ db, rootDir, log = console } = {}) {
  const thresholdSeconds = resolveRunningPassTimeoutSeconds();
  const rows = db.prepare(
    `SELECT pass_id, repo, pr_number, attempt_number, pass_kind, reviewer_class, reviewer_model, started_at
       FROM reviewer_passes
      WHERE status = 'running'
        AND datetime(started_at) < datetime('now', '-' || ? || ' seconds')`
  ).all(thresholdSeconds);

  let reaped = 0;
  for (const row of rows) {
    try {
      completeReviewerPass(rootDir, {
        repo: row.repo,
        prNumber: row.pr_number,
        attemptNumber: row.attempt_number,
        passKind: row.pass_kind,
        status: 'failed',
        metadata: {
          failureClass: QUOTA_EXHAUSTED_FAILURE_CLASS,
          failureReason: 'running-pass-timeout',
          timeoutThresholdSeconds: thresholdSeconds,
        },
      });
      const ageSeconds = Math.floor((Date.now() - new Date(`${row.started_at}Z`).getTime()) / 1000);
      log.log(
        `[watcher] reviewer-pass reaper: pr=${row.repo}#${row.pr_number} reviewer=${row.reviewer_model || row.reviewer_class}\n` +
        `          pass_id=${row.pass_id} status running->failed reason=running-pass-timeout\n` +
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
