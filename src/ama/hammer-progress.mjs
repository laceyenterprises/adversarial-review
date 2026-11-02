import { execFileSync } from 'node:child_process';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { controllerLaunchId } from './hammer-controller.mjs';
import { resolveHqRoot } from '../hq-root.mjs';

export const HAMMER_PROGRESS_MILESTONES = Object.freeze([
  'verify-head', 'remediation-committed', 'validation-passed', 'validation-failed', 'remediation-pushed', 'merge-attempted', 'terminal-stop',
]);

// Fixed-size receipts are run-scoped. Tool activity and script inspection never
// emit one. They grant no merge authority, CI validation or budget refund.
// terminal-stop means the run is ending: the supervisor allows only a short exit
// grace after it, so only the explicit final run exit may record it, never a
// deferred or retryable outcome the closer may still act on in this run.
export function recordHammerProgress(milestone, { env = process.env, reason, final = false, now = new Date() } = {}) {
  if (!HAMMER_PROGRESS_MILESTONES.includes(milestone)) throw new TypeError('invalid hammer milestone');
  if (milestone === 'terminal-stop' && !/^[a-z][a-z0-9:-]{0,95}$/.test(reason || '')) {
    throw new TypeError('terminal milestone requires a named reason');
  }
  if (milestone === 'terminal-stop' && final !== true) {
    throw new TypeError('terminal milestone requires the final run exit');
  }
  const launchRequestId = controllerLaunchId(env);
  const runId = env.HQ_WORKER_RUN_ID;
  if (!/^wrun_[A-Za-z0-9-]+$/.test(runId || '')) throw new Error('hammer milestone requires run identity');
  const root = env.HAM_HQ_ROOT || resolveHqRoot(env);
  const directory = join(root, 'dispatch', launchRequestId, 'hammer-progress', runId);
  mkdirSync(directory, { recursive: true });
  const receipt = { schemaVersion: 1, launchRequestId, runId, milestone, at: now.toISOString(),
    ...(milestone === 'terminal-stop' ? { reason } : {}) };
  const path = join(directory, `${milestone}.json`);
  try {
    writeFileSync(path, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  return receipt;
}

export function reportHammerProgress(milestone, options) {
  try { return recordHammerProgress(milestone, options); }
  catch {
    process.stderr.write('HAM progress receipt unavailable\n');
    return null;
  }
}

// Observe Git, never model prose: only a descendant commit above the reviewed
// head earns local remediation credit. Repetition cannot refresh its receipt.
export function reportRemediationCommit({ env = process.env, cwd = process.cwd(), execImpl = execFileSync } = {}) {
  if (!/^[a-f0-9]{40}$/.test(env.HAM_REVIEWED_SHA || '')) return null;
  try {
    const options = { cwd, env, encoding: 'utf8', timeout: loadAwareTimeoutMs(5000), stdio: ['ignore', 'pipe', 'pipe'] };
    const head = execImpl('git', ['rev-parse', 'HEAD'], options).trim();
    if (!/^[a-f0-9]{40}$/.test(head) || head === env.HAM_REVIEWED_SHA) return null;
    execImpl('git', ['merge-base', '--is-ancestor', env.HAM_REVIEWED_SHA, head], options);
    return reportHammerProgress('remediation-committed', { env });
  } catch { return null; }
}
