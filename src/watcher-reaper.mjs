import { completeReviewerPass, reviewerPassRows } from './reviewer-pass-tokens.mjs';
import { loadRoleConfig } from './role-config.mjs';

const DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS = 3600;

export function resolveRunningPassTimeoutSeconds(env = process.env, options = {}) {
  const raw = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'watcher.running_pass_timeout_seconds',
  }).get(
    'watcher.running_pass_timeout_seconds',
    DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS
  );
  const rawText = raw === undefined ? null : String(raw).trim();
  const parsed = raw === undefined
    ? DEFAULT_RUNNING_PASS_TIMEOUT_SECONDS
    : Number(rawText);

  if (
    !Number.isInteger(parsed) ||
    (rawText !== null && String(parsed) !== rawText) ||
    parsed < 1
  ) {
    const err = new Error(
      `AGENT_OS_REVIEWER_RUNNING_PASS_TIMEOUT_SECONDS must be an integer seconds value >= 1; got ${JSON.stringify(raw)}`
    );
    err.logKey = 'running_pass_timeout_out_of_range';
    throw err;
  }
  return parsed;
}

export function reapRunningReviewerPasses(rootDir, log = console, env = process.env) {
  const thresholdSeconds = resolveRunningPassTimeoutSeconds(env);
  const now = Date.now();
  const cutoff = new Date(now - thresholdSeconds * 1000).toISOString();
  let reaped = 0;
  for (const row of reviewerPassRows(rootDir)) {
    if (row.status === 'running' && row.started_at < cutoff) {
      completeReviewerPass(rootDir, {
        repo: row.repo,
        prNumber: row.pr_number,
        attemptNumber: row.attempt_number,
        passKind: row.pass_kind,
        status: 'failed',
        metadata: { reason: 'running-pass-timeout', reasonClass: 'reviewer-timeout' },
      });
      reaped++;
      const passIdStr = row.pass_id.toString().padStart(2, '0');
      const paddedPassId = `rp_${passIdStr}`;
      const ageSeconds = Math.round((now - new Date(row.started_at).getTime()) / 1000);
      log.log?.(`[watcher] reviewer-pass reaper: pr=${row.repo}#${row.pr_number} reviewer=${row.reviewer_class || 'unknown'} ` +
               `pass_id=${paddedPassId} status running->failed reason=running-pass-timeout ` +
               `age=${ageSeconds}s threshold=${thresholdSeconds}s`);
    }
  }
  return reaped;
}
