import { opendir, readFile } from 'node:fs/promises';
import { loadConfigCached } from './config-loader.mjs';
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
  readConfig = () => loadConfigCached().getMergeAuthorityConfig(),
  scanLimit = 100, readReceipt = path => readFile(path, 'utf8'),
} = {}) {
  let running = null;
  const attempted = new Map();
  const failures = new Map();
  let cursor = null;
  async function scanAndRetry() {
    const cfg = readConfig();
    if (cfg.enabled === false || cfg.autonomousMergeExecutionEnabled === false) return;
    const directory = join(rootDir, 'data', 'follow-up-jobs', 'merge-agent-dispatches');
    // Keep a directory cursor across ticks: bound work before reading contents,
    // without dropping old durable debt or restarting at the same history.
    try { cursor ||= await opendir(directory); }
    catch (error) {
      if (error.code !== 'ENOENT') logger.warn?.(`[overload-rescue] receipt listing failed: ${error.message}`);
      return;
    }
    const candidates = [];
    for (let count = 0; count < scanLimit; count++) {
      const entry = await cursor.read();
      if (!entry) {
        await cursor.close();
        cursor = null;
        break;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const name = entry.name;
      try {
        const record = JSON.parse(await readReceipt(join(directory, name)));
        const receipt = record.overloadDeferral;
        if (!record.pendingHandoff || !receipt || record.launchRequestId
          || !/^[\w.-]+\/[\w.-]+$/.test(record.repo)
          || !Number.isSafeInteger(record.prNumber) || record.prNumber <= 0) continue;
        if (!receipt.overloadAlert
          && (!Number.isFinite(receipt.nextRetryAt) || now() < receipt.nextRetryAt * 1000)) continue;
        const key = `${record.repo}#${record.prNumber}`;
        if (now() < (failures.get(key)?.retryAt || 0)) continue;
        candidates.push({ key, record, last: attempted.get(key) || 0 });
      } catch (error) {
        logger.warn?.(`[overload-rescue] receipt unreadable ${name}: ${error.message}`);
      }
    }
    // Round-robin failed observations too; one unavailable PR cannot starve
    // the rest. Durable retry times and local failure backoff both gate attempts.
    const candidate = candidates.sort((a, b) => a.last - b.last || a.key.localeCompare(b.key))[0];
    if (!candidate) return Promise.resolve();
    attempted.set(candidate.key, now());
    if (attempted.size > 1000) attempted.delete(attempted.keys().next().value);
    const { repo, prNumber } = candidate.record;
    await Promise.resolve().then(() => execute(env.HQ_BIN || 'hq', [
      'merge-agent', 'rescue', String(prNumber), '--repo', repo,
      '--hq-root', resolveHqRoot(env), '--apply', '--json', '--retry-overload-only',
    ], {
      env, cwd: rootDir, timeout: 600_000, progressTimeout: 0,
      reapGroupOnExit: true, maxBuffer: 1024 * 1024,
    })).then(() => { failures.delete(candidate.key); }).catch(error => {
      const count = (failures.get(candidate.key)?.count || 0) + 1;
      failures.set(candidate.key, { count,
        retryAt: now() + Math.min(30_000 * 2 ** Math.min(count - 1, 10), 1_800_000) });
      if (failures.size > 1000) failures.delete(failures.keys().next().value);
      // rc 75 is an ordinary deferral. Timeout/read failures keep disk debt
      // and are observed again, never converted into a dispatch verdict.
      logger.warn?.(`[overload-rescue] ${candidate.key}: ${error.message}`);
    });
  }
  return {
    tick() {
      if (!running) running = scanAndRetry().catch(error => {
        logger.warn?.(`[overload-rescue] retry observation failed: ${error.message}`);
      }).finally(() => { running = null; });
      return running;
    },
  };
}
