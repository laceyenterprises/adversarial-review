/** Optional per-subject proposals; routing, accounts and verdict authority remain with their owners. */
import { spawn } from 'node:child_process';
import { getConfig } from './config-loader.mjs';
import { resolveAgentOsPython } from './agent-os-python.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { applyEffectiveReviewerRoute, REVIEWER_ROUTE_BY_MODEL, reviewerRefusesBuilder } from './adapters/subject/github-pr/routing.mjs';

function recordReason(log, reason, repoPath, prNumber) {
  try { log.info?.(`[watcher] osg-reviewer ${repoPath || 'unknown'}#${prNumber || 0} reason=${reason}`); } catch {}
}

export function applyReviewerArmEffectiveRoute(options) {
  if (!options.baseRoute?.reviewerArm) return applyEffectiveReviewerRoute(options);
  const defaultRoute = options.baseRoute.reviewerArmDefaultRoute;
  // The trial replaces the default selection, while the ordinary integrity
  // guard still runs. Keep the fully resolved default for admission fallback.
  return { ...applyEffectiveReviewerRoute({ ...options, mode: 'off', primaryReviewerQuotaCapped: false }),
    reviewerArmDefaultRoute: defaultRoute };
}

export function reviewerArmExecution(route) {
  const arm = route?.reviewerArm;
  return arm?.harness === route?.reviewerModel ? { reviewerArm: arm } : {};
}

const OWNER_ERRORS = new Set(['error-owner-spawn', 'error-owner-import', 'error-owner-timeout',
  'error-owner-exit', 'error-owner-invalid-json']);

export function reviewerArmOwner(value, { env = process.env, timeoutMs = loadAwareTimeoutMs(5000, { maxMs: 30000 }) } = {}) {
  return new Promise((resolve, reject) => {
    let launch;
    try { launch = resolveAgentOsPython({ env }); } catch { reject(Error('error-owner-spawn')); return; }
    const child = spawn(launch.python, ['-B', '-m', 'cwp_dispatch.osg_reviewer'],
      { env: launch.env, cwd: launch.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let stderr = '';
    let failure;
    const timer = setTimeout(() => { failure = 'error-owner-timeout'; child.kill('SIGKILL'); },
      Number.isFinite(timeoutMs) ? Math.max(1, Math.min(30000, timeoutMs)) : 30000);
    child.on('error', () => { clearTimeout(timer); reject(Error('error-owner-spawn')); });
    child.stdin.on('error', () => {});
    // Retain only bounded private evidence to classify an import failure.
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 131072) { failure = 'error-owner-invalid-json'; output = ''; child.kill('SIGKILL'); }
    });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        if (failure) throw Error(failure);
        if (code !== 0) throw Error(/ModuleNotFoundError|ImportError|No module named/.test(stderr)
          ? 'error-owner-import' : 'error-owner-exit');
        resolve(JSON.parse(output));
      } catch (error) { reject(Error(OWNER_ERRORS.has(error.message) ? error.message : 'error-owner-invalid-json')); }
    });
    child.stdin.end(JSON.stringify(value));
  });
}

export async function applyReviewerArm({ baseRoute, domainId, repoPath, prNumber,
  reviewerMode = 'off', primaryReviewerQuotaCapped = false, routeTable,
  config, owner = reviewerArmOwner, ensureWorkerRegistryReadyImpl, log = console } = {}) {
  try {
    if (domainId !== 'code-pr' || !baseRoute || baseRoute.configBroken) return baseRoute;
    config ??= getConfig('osg', { mode: 'off' });
    if (!['apply', 'shadow'].includes(config?.mode)) return baseRoute;
    const { resolveReviewerExecutionAsync } = await import('./reviewer-harness.mjs');
    const currentRoute = applyEffectiveReviewerRoute({ baseRoute, builderClass: baseRoute.builderClass,
      mode: reviewerMode, primaryReviewerQuotaCapped, routeTable: routeTable ?? baseRoute.routeTable });
    const allowedFamilies = Object.keys(REVIEWER_ROUTE_BY_MODEL)
      .filter(family => !reviewerRefusesBuilder(baseRoute.builderClass, family));
    const result = await owner({ repo: repoPath, prNumber, mode: config.mode,
      reviewerModel: currentRoute.reviewerModel, allowedFamilies,
      execution: await resolveReviewerExecutionAsync(currentRoute.reviewerModel, { log, ensureWorkerRegistryReadyImpl }) });
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
  } catch (error) {
    recordReason(log, OWNER_ERRORS.has(error?.message) ? error.message : 'error-owner-unavailable', repoPath, prNumber);
    return baseRoute;
  }
}
