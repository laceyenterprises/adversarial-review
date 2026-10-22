/** Optional per-subject proposals; routing, accounts and verdict authority remain with their owners. */
import { spawn } from 'node:child_process';
import { getConfig } from './config-loader.mjs';
import { applyEffectiveReviewerRoute, REVIEWER_ROUTE_BY_MODEL, reviewerRefusesBuilder } from './adapters/subject/github-pr/routing.mjs';

function recordReason(log, reason, repoPath, prNumber) {
  try { log.info?.(`[watcher] osg-reviewer ${repoPath || 'unknown'}#${prNumber || 0} reason=${reason}`); } catch {}
}

export function applyReviewerArmEffectiveRoute(options) {
  if (!options.baseRoute?.reviewerArm) return applyEffectiveReviewerRoute(options);
  const defaultRoute = applyEffectiveReviewerRoute({ ...options, baseRoute: options.baseRoute.reviewerArmDefaultRoute });
  // The trial replaces the default selection, while the ordinary integrity
  // guard still runs. Keep the fully resolved default for admission fallback.
  return { ...applyEffectiveReviewerRoute({ ...options, mode: 'off', primaryReviewerQuotaCapped: false }),
    reviewerArmDefaultRoute: defaultRoute };
}

export function reviewerArmExecution(route) {
  const arm = route?.reviewerArm;
  return arm?.harness === route?.reviewerModel ? { reviewerArm: arm } : {};
}

export function reviewerArmOwner(value, { env = process.env, timeoutMs = 1500 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(env.HQ_PYTHON3 || env.AGENT_OS_PY || 'python3', ['-B', '-m', 'cwp_dispatch.osg_reviewer'],
      { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 131072) child.kill('SIGKILL');
    });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw Error('owner unavailable');
        resolve(JSON.parse(output));
      } catch { reject(Error('owner unavailable')); }
    });
    child.stdin.end(JSON.stringify(value));
  });
}

export async function applyReviewerArm({ baseRoute, domainId, repoPath, prNumber,
  reviewerMode = 'off', primaryReviewerQuotaCapped = false,
  config, owner = reviewerArmOwner, log = console } = {}) {
  try {
    if (domainId !== 'code-pr' || !baseRoute || baseRoute.configBroken) return baseRoute;
    config ??= getConfig('osg', { mode: 'off' });
    if (!['apply', 'shadow'].includes(config?.mode)) return baseRoute;
    const { resolveReviewerExecution } = await import('./reviewer-harness.mjs');
    const currentRoute = applyEffectiveReviewerRoute({ baseRoute, builderClass: baseRoute.builderClass,
      mode: reviewerMode, primaryReviewerQuotaCapped, routeTable: baseRoute.routeTable });
    const allowedFamilies = Object.keys(REVIEWER_ROUTE_BY_MODEL)
      .filter(family => !reviewerRefusesBuilder(baseRoute.builderClass, family));
    const result = await owner({ repo: repoPath?.split('/').at(-1), prNumber, mode: config.mode,
      reviewerModel: currentRoute.reviewerModel, allowedFamilies,
      execution: resolveReviewerExecution(currentRoute.reviewerModel, { log }) });
    // Stable tokens only: the owner must never echo provider/DB diagnostics.
    const reason = /^[A-Za-z0-9_-]{1,80}$/.test(result?.reason) ? result.reason : 'error-invalid-owner';
    recordReason(log, reason, repoPath, prNumber);
    if (config.mode !== 'apply' || !result.arm) return baseRoute;
    const arm = result.arm;
    if (arm.role !== 'reviewer' || !['codex', 'claude'].includes(arm.harness)
      || arm.worker_class !== `${arm.harness}-reviewer`
      || reviewerRefusesBuilder(baseRoute.builderClass, arm.harness)
      || !['model', 'effort', 'account'].every(k => typeof arm[k] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,127}$/.test(arm[k]))) {
      recordReason(log, 'arm-refused', repoPath, prNumber);
      return baseRoute;
    }
    return { ...baseRoute, ...REVIEWER_ROUTE_BY_MODEL[arm.harness], reviewerArm: { ...arm }, reviewerArmDefaultRoute: currentRoute };
  } catch {
    recordReason(log, 'error-owner-unavailable', repoPath, prNumber);
    return baseRoute;
  }
}
