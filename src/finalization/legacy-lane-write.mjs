// Thin shell-writer boundary: preserve the existing entitled command and its
// output while holding the same route/issuance lock as the daemon and queue.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadEffectiveMergeAuthorityConfig } from '../ama/effective-policy.mjs';
import { routeFinalizationWriter } from './queue-routing-boundary.mjs';
import { queueWaitMs } from './queue-wait.mjs';

const execute = promisify(execFile);
export async function runLegacyLaneWrite({ rootDir, repository, base, command, argv, subject = null,
  readConfig = loadEffectiveMergeAuthorityConfig, exec = execute, deadline, now = () => new Date().toISOString(), load } = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  deadline ??= new Date(Date.parse(clock()) + 60_000).toISOString();
  const cfg = readConfig({ rootDir });
  return routeFinalizationWriter({ rootDir, cfg, lane: { repository, base }, kind: 'closer', subject, legacyDeadline: deadline, now: clock,
    legacy: () => {
      const timeout = queueWaitMs(30_000, { ceilingMs: 60_000, deadline, now: clock(), load });
      if (!timeout) throw new Error('legacy writer deadline expired');
      return exec(command, argv, { timeout, killSignal: 'SIGTERM', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } });
}
