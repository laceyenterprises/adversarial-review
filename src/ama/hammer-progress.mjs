import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { controllerLaunchId } from './hammer-controller.mjs';
import { resolveHqRoot } from '../hq-root.mjs';

export const HAMMER_PROGRESS_MILESTONES = Object.freeze([
  'verify-head', 'remediation-pushed', 'merge-attempted', 'terminal-stop',
]);

// Fixed-size receipts are run-scoped. Tool activity and script inspection never
// emit one. They grant no merge authority, CI validation or budget refund.
export function recordHammerProgress(milestone, { env = process.env, reason, now = new Date() } = {}) {
  if (!HAMMER_PROGRESS_MILESTONES.includes(milestone)) throw new TypeError('invalid hammer milestone');
  if (milestone === 'terminal-stop' && !/^[a-z][a-z0-9:-]*$/.test(reason || '')) {
    throw new TypeError('terminal milestone requires a named reason');
  }
  const launchRequestId = controllerLaunchId(env);
  const runId = env.HQ_WORKER_RUN_ID;
  if (!/^wrun_[A-Za-z0-9-]+$/.test(runId || '')) throw new Error('hammer milestone requires run identity');
  const root = env.HAM_HQ_ROOT || resolveHqRoot(env);
  const directory = join(root, 'dispatch', launchRequestId, 'hammer-progress', runId);
  mkdirSync(directory, { recursive: true });
  const receipt = { schemaVersion: 1, launchRequestId, runId, milestone, at: now.toISOString(),
    ...(milestone === 'terminal-stop' ? { reason } : {}) };
  try {
    writeFileSync(join(directory, `${milestone}.json`), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
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
