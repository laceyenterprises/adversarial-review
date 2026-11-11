import { opendir, readFile, stat } from 'node:fs/promises';
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
  maxReceiptAgeMs = 24 * 60 * 60 * 1000,
  receiptStat = stat, scanLimit = 100, openDirectory = opendir, readReceipt = path => readFile(path, 'utf8'),
} = {}) {
  let running = null;
  const attempted = new Map();
  const failures = new Map();
  let cursor = null;
  let pending = [];
  const shutdown = new AbortController();
  async function closeCursor() {
    const previous = cursor;
    cursor = null;
    try { await previous?.close(); } catch { /* already closed or broken */ }
  }
  function backoff(key) {
    const count = (failures.get(key)?.count || 0) + 1;
    failures.delete(key);
    failures.set(key, { count,
      retryAt: now() + Math.min(30_000 * 2 ** Math.min(count - 1, 10), 1_800_000) });
    if (failures.size > 1000) failures.delete(failures.keys().next().value);
  }
  async function recent(path) {
    return now() - (await receiptStat(path)).mtimeMs <= maxReceiptAgeMs;
  }
  function eligible(record) {
    const receipt = record.overloadDeferral;
    return record.pendingHandoff && receipt && !record.launchRequestId
      && /^[\w.-]+\/[\w.-]+$/.test(record.repo)
      && Number.isSafeInteger(record.prNumber) && record.prNumber > 0
      && (receipt.overloadAlert || (Number.isFinite(receipt.nextRetryAt)
        && now() >= receipt.nextRetryAt * 1000));
  }
  function progress(record) {
    return JSON.stringify([record.pendingHandoff, record.launchRequestId,
      record.overloadDeferral?.deferralCount, record.overloadDeferral?.nextRetryAt,
      record.overloadDeferral?.overloadAlert]);
  }
  async function scanAndRetry() {
    const cfg = readConfig();
    if (cfg.enabled === false || cfg.autonomousMergeExecutionEnabled === false) return;
    if (shutdown.signal.aborted) return;
    const directory = join(rootDir, 'data', 'follow-up-jobs', 'merge-agent-dispatches');
    // Drain one bounded window before advancing: due debt is never discarded
    // behind the cursor. Re-read queued receipts before executing stale identity.
    if (!pending.length) {
      try { cursor ||= await openDirectory(directory); }
      catch (error) {
        if (error.code !== 'ENOENT') logger.warn?.(`[overload-rescue] receipt listing failed: ${error.message}`);
        return;
      }
      try {
        for (let count = 0; count < scanLimit; count++) {
          const entry = await cursor.read();
          if (!entry) { await closeCursor(); break; }
          if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
          const path = join(directory, entry.name);
          try {
            const record = JSON.parse(await readReceipt(path));
            const key = `${record.repo}#${record.prNumber}`;
            if (eligible(record) && await recent(path) && now() >= (failures.get(key)?.retryAt || 0)) {
              pending.push({ key, path, last: attempted.get(key) || 0 });
            }
          } catch (error) {
            logger.warn?.(`[overload-rescue] receipt unreadable ${entry.name}: ${error.message}`);
          }
        }
      } catch (error) {
        await closeCursor();
        throw error;
      }
      pending.sort((a, b) => a.last - b.last || a.key.localeCompare(b.key));
    }
    let candidate;
    while (pending.length && !shutdown.signal.aborted) {
      const next = pending.shift();
      try {
        const record = JSON.parse(await readReceipt(next.path));
        if (`${record.repo}#${record.prNumber}` !== next.key || !eligible(record)
          || !await recent(next.path) || now() < (failures.get(next.key)?.retryAt || 0)) continue;
        candidate = { ...next, record };
        break;
      } catch (error) {
        logger.warn?.(`[overload-rescue] queued receipt unreadable: ${error.message}`);
      }
    }
    if (!candidate || shutdown.signal.aborted) return;
    attempted.delete(candidate.key);
    attempted.set(candidate.key, now());
    if (attempted.size > 1000) attempted.delete(attempted.keys().next().value);
    const { repo, prNumber } = candidate.record;
    await Promise.resolve().then(() => execute(env.HQ_BIN || 'hq', [
      'merge-agent', 'rescue', String(prNumber), '--repo', repo,
      '--hq-root', resolveHqRoot(env), '--apply', '--json', '--retry-overload-only',
    ], {
      env, signal: shutdown.signal, cwd: rootDir, timeout: 600_000, progressTimeout: 0,
      reapGroupOnExit: true, settleAfterKillMs: 250, maxBuffer: 1024 * 1024,
    })).then(async () => {
      let current;
      try { current = JSON.parse(await readReceipt(candidate.path)); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (current && eligible(current) && progress(current) === progress(candidate.record)) backoff(candidate.key);
      else failures.delete(candidate.key);
    }).catch(error => {
      backoff(candidate.key);
      // rc 75 is an ordinary deferral. Timeout/read failures keep disk debt
      // and are observed again, never converted into a dispatch verdict.
      logger.warn?.(`[overload-rescue] ${candidate.key}: ${error.message}`);
    });
  }
  return {
    abort() { shutdown.abort(); },
    async stop() {
      shutdown.abort();
      await running;
      pending = [];
      await closeCursor();
    },
    tick() {
      if (!running) running = scanAndRetry().catch(error => {
        logger.warn?.(`[overload-rescue] retry observation failed: ${error.message}`);
      }).finally(() => { running = null; });
      return running;
    },
  };
}
