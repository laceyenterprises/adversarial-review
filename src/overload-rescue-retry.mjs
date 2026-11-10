import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnCapturedProcessGroup } from './process-group-spawn.mjs';
import { resolveHqRoot } from './hq-root.mjs';

// The watcher poll owns rescue retry debt. It submits only a PR identity to the
// ordinary rescue entrypoint: head, review, holds and live writers are read again.
// No receipt recipe is executable input here. One bounded child at a time keeps
// recovery from starving the review claim loop. Disk debt survives watcher exit.
export function createOverloadRescueRetry({
  rootDir, env = process.env, logger = console, now = () => Date.now(),
  execute = spawnCapturedProcessGroup,
} = {}) {
  let running = null;
  const attempted = new Map();
  return {
    tick() {
      if (running) return running;
      const directory = join(rootDir, 'data', 'follow-up-jobs', 'merge-agent-dispatches');
      let names;
      try { names = readdirSync(directory).filter(name => name.endsWith('.json')); }
      catch (error) {
        if (error.code !== 'ENOENT') logger.warn?.(`[overload-rescue] receipt listing failed: ${error.message}`);
        return Promise.resolve();
      }
      const candidates = [];
      for (const name of names) {
        try {
          const record = JSON.parse(readFileSync(join(directory, name), 'utf8'));
          const receipt = record.overloadDeferral;
          if (!record.pendingHandoff || !receipt || record.launchRequestId
            || !/^[\w.-]+\/[\w.-]+$/.test(record.repo)
            || !Number.isSafeInteger(record.prNumber) || record.prNumber <= 0) continue;
          if (!receipt.overloadAlert
            && (!Number.isFinite(receipt.nextRetryAt) || now() < receipt.nextRetryAt * 1000)) continue;
          const key = `${record.repo}#${record.prNumber}`;
          candidates.push({ key, record, last: attempted.get(key) || 0 });
        } catch (error) {
          logger.warn?.(`[overload-rescue] receipt unreadable ${name}: ${error.message}`);
        }
      }
      // Round-robin failed observations too; one unavailable PR cannot starve
      // the rest. The durable receipt, not this fairness hint, owns retry timing.
      const candidate = candidates.sort((a, b) => a.last - b.last || a.key.localeCompare(b.key))[0];
      if (!candidate) return Promise.resolve();
      attempted.set(candidate.key, now());
      if (attempted.size > 1000) attempted.delete(attempted.keys().next().value);
      const { repo, prNumber } = candidate.record;
      running = Promise.resolve().then(() => execute(env.HQ_BIN || 'hq', [
        'merge-agent', 'rescue', String(prNumber), '--repo', repo,
        '--hq-root', resolveHqRoot(env), '--apply', '--json', '--retry-overload-only',
      ], {
        env, cwd: rootDir, timeout: 600_000, progressTimeout: 0,
        reapGroupOnExit: true, maxBuffer: 1024 * 1024,
      })).catch(error => {
        // rc 75 is an ordinary deferral. Timeout/read failures keep disk debt
        // and are observed again, never converted into a dispatch verdict.
        logger.warn?.(`[overload-rescue] ${candidate.key}: ${error.message}`);
      }).finally(() => { running = null; });
      return running;
    },
  };
}
