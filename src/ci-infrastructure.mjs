import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { execGhWithRetry } from './gh-cli.mjs';
import { checkItemState, latestCheckRollupItems, isAdversarialOwnStatusContext } from './checks-summary.mjs';

const attachedSteps = new WeakMap();
const jobEvidenceCaches = new WeakMap();
export function rememberCheckSteps(check, steps) {
  if (check && typeof check === 'object' && Array.isArray(steps)) attachedSteps.set(check, steps);
}
export function checkSteps(check) {
  return check?.job?.steps || check?.steps || (check && typeof check === 'object' ? attachedSteps.get(check) : undefined);
}

const FAILED = new Set(['FAILURE', 'ERROR', 'STARTUP_FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STALE']);

// Missing steps are unknown. A skipped step is not execution; a completed or
// started non-skipped step is. Never infer infrastructure from duration/name.
export function checkInfrastructureReason(check) {
  if (!FAILED.has(checkItemState(check))) return null;
  const evidence = check?.job || check;
  const rawAnnotations = evidence?.annotations || check?.output?.annotations;
  const annotations = Array.isArray(rawAnnotations) ? rawAnnotations : [];
  const messages = [check?.output?.summary, check?.output?.text,
    ...annotations.map(item => typeof item === 'string' ? item : item?.message)];
  const steps = checkSteps(check);
  const zeroSteps = Array.isArray(steps) && steps.every(step =>
    step && (String(step.conclusion || '').toLowerCase() === 'skipped'
      || (!step.started_at && !step.startedAt && !step.completed_at && !step.completedAt
        && !['completed', 'in_progress'].includes(String(step.status || '').toLowerCase())
        && !step.conclusion)));
  if (zeroSteps && messages.some(message => /(?:job|workflow).*(?:not started|not run).*(?:budget|billing|quota|spending limit)|(?:budget|billing|quota).*(?:preventing further use|not started)/i.test(String(message || '')))) {
    return 'actions-billing-quota';
  }
  if (zeroSteps) return 'actions-zero-step';
  return null;
}

export function infrastructureOnlyFailures(checks) {
  return Array.isArray(checks) && checks.length > 0 && checks.every(check => checkInfrastructureReason(check));
}

export function rollupFailures(rollup, { excludeContexts = ['agent-os/adversarial-gate'] } = {}) {
  const excluded = new Set((Array.isArray(excludeContexts) ? excludeContexts : ['agent-os/adversarial-gate'])
    .map(value => String(value).trim().toLowerCase()));
  return latestCheckRollupItems(rollup).filter(item =>
    !isAdversarialOwnStatusContext(item, excluded) && FAILED.has(checkItemState(item)));
}

export function rollupInfrastructureOnly(rollup, options) {
  return infrastructureOnlyFailures(rollupFailures(rollup, options));
}

export function rollupInfrastructureEvidencePending(rollup, options) {
  return infrastructureEvidencePending(rollupFailures(rollup, options));
}

export function hasMissingActionsEvidence(checks, repo) {
  return checks.some(item => !checkInfrastructureReason(item) && !Array.isArray(checkSteps(item))
    && String(item.detailsUrl || '').startsWith('https://github.com/' + repo + '/actions/runs/'));
}

export function infrastructureEvidencePending(checks) {
  return Array.isArray(checks) && checks.some(checkInfrastructureReason) && checks.every(item =>
    checkInfrastructureReason(item) || (!Array.isArray(checkSteps(item))
      && /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/\d+/.test(String(item?.detailsUrl || ''))));
}

// Reuse job evidence already attached by another reader. Otherwise ONE read,
// one page, one transient retry under a load-aware bound. Exact job/head matching keeps
// a historical run or a sibling workflow from lending zero-step evidence.
export async function enrichCiInfrastructureEvidence({ rollup, repo, headSha, execFileImpl, env = process.env, signal } = {}) {
  if (!Array.isArray(rollup)) return rollup;
  rollup = rollup.map(item => Array.isArray(checkSteps(item)) ? { ...item, steps: checkSteps(item) } : item);
  let cache = execFileImpl && jobEvidenceCaches.get(execFileImpl);
  if (execFileImpl && !cache) { cache = new Map(); jobEvidenceCaches.set(execFileImpl, cache); }
  rollup = rollup.map(item => {
    const steps = cache?.get(JSON.stringify([repo, headSha, item?.detailsUrl]));
    return Array.isArray(steps) ? { ...item, steps } : item;
  });
  const items = latestCheckRollupItems(rollup);
  const missing = items.filter(item => FAILED.has(checkItemState(item))
    && !checkInfrastructureReason(item) && !Array.isArray(checkSteps(item)));
  const candidate = missing.map(item => ({ item, match: String(item.detailsUrl || item.details_url || '').match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)(?:\?.*)?$/) }))
    .find(({ match }) => match && match[1] === repo);
  if (!candidate || !headSha || !execFileImpl || signal?.aborted) return rollup;
  try {
    const timeoutMs = loadAwareTimeoutMs(3000);
    const { stdout } = await execGhWithRetry({ execFileImpl,
      args: ['api', `repos/${repo}/actions/runs/${candidate.match[2]}/jobs?filter=latest&per_page=100`],
      env, signal, timeoutMs, totalTimeoutMs: timeoutMs * 2 + 100, retries: 1, backoffMs: 100,
      refreshGhAuthImpl: async () => ({ reminted: false }), log: null });
    const jobs = JSON.parse(stdout).jobs;
    if (!Array.isArray(jobs)) return rollup;
    return rollup.map(item => {
      const match = String(item.detailsUrl || item.details_url || '').match(/\/actions\/runs\/(\d+)\/job\/(\d+)(?:\?.*)?$/);
      if (!match || match[1] !== candidate.match[2]) return item;
      const job = jobs.find(job => String(job.id) === match[2] && job.head_sha === headSha
        && String(job.conclusion || '').toUpperCase() === checkItemState(item));
      if (job && Array.isArray(job.steps)) {
        if (cache.size >= 512) cache.delete(cache.keys().next().value);
        cache.set(JSON.stringify([repo, headSha, item.detailsUrl]), job.steps);
        return { ...item, steps: job.steps };
      }
      return item;
    });
  } catch { return rollup; }
}

// Legacy and new stops need actual recorded failures, never narrative alone.
export function recordedCiFailures(stop) {
  const sources = [stop?.failedChecks, stop?.ciGate?.failedChecks, stop?.ciRegression?.failedChecks,
    stop?.failure?.failedChecks, stop?.failure?.ciGate?.failedChecks, stop?.failure?.ciRegression?.failedChecks,
    stop?.completion?.ciGate?.failedChecks, stop?.githubGate?.badChecks,
    stop?.eligibilityTrace?.trace?.requiredChecks?.badChecks];
  return sources.filter(Array.isArray).flat();
}

// A missing/pending/skipped replacement cannot prove the failed job ran again.
export function checksExecutedAgain(rollup, failures) {
  const latest = latestCheckRollupItems(rollup);
  return failures.length > 0 && failures.every(failed => latest.some(item =>
    String(item.name || item.context || '') === String(failed.name || failed.context || '')
    && checkItemState(item) === 'SUCCESS'));
}

export const CI_INFRASTRUCTURE_STOP_REASONS = new Set([
  'ci-infrastructure', 'ci-not-green', 'github-gate-not-green', 'ci-failed',
  'ci-red-final', 'ci-regression', 'no-progress',
]);
