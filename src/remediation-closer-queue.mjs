import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';

const queueDir = rootDir => join(rootDir, 'data', 'remediation-closer-queue');
const RETRY_MS = 15_000;

export function enqueueRemediationCloser(rootDir, job, headSha = null) {
  const prNumber = Number(job.prNumber), completedAt = Date.parse(job.completedAt);
  if (!job.repo || !Number.isSafeInteger(prNumber) || prNumber < 1 || !Number.isFinite(completedAt)) return;
  const key = createHash('sha256').update(JSON.stringify([job.repo, prNumber, job.jobId])).digest('hex');
  const path = join(queueDir(rootDir), `${completedAt}-${key}.json`);
  try {
    writeFileAtomic(path, JSON.stringify({ repo: job.repo, prNumber, headSha,
      reviewRequested: job.reReview?.requested === true }), { overwrite: false });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
}

export function startRemediationCloserDrain({ rootDir, decide, runBatch = run => run(), logger = console }) {
  const dir = queueDir(rootDir);
  const retryAt = new Map();
  let current, closed = false;
  const drain = () => closed ? null : current ??= Promise.resolve().then(async () => {
    const names = readdirSync(dir).filter(name => /^\d+-[a-f0-9]{64}\.json$/.test(name)).sort();
    const ready = names.filter(name => (retryAt.get(name) || 0) <= Date.now());
    await runBatch(() => Promise.all(ready.slice(0, 4).map(async name => {
      const path = join(dir, name);
      retryAt.set(name, Date.now() + RETRY_MS);
      try {
        const contents = readFileSync(path, 'utf8');
        let event;
        try { event = JSON.parse(contents); }
        catch {
          const deadLetterDir = join(dir, 'dead-letter');
          mkdirSync(deadLetterDir, { recursive: true });
          renameSync(path, join(deadLetterDir, name));
          retryAt.delete(name);
          logger.warn?.(`[watcher] malformed remediation completion quarantined (dead-letter/${name})`);
          return;
        }
        const retry = event.reviewRequested ? null : await decide(event);
        if (retry === false || (Number.isFinite(retry) && retry > 0)) {
          retryAt.set(name, Date.now() + Math.max(RETRY_MS, retry || 0));
          return;
        }
        rmSync(path, { force: true });
        retryAt.delete(name);
      } catch (error) {
        logger.warn?.(`[watcher] remediation completion decision deferred (${error.code || 'read-error'})`);
      }
    })));
    if (ready.length > 4) setImmediate(drain).unref();
  }).catch(error => logger.warn?.(`[watcher] remediation completion queue unavailable (${error.code || 'read-error'})`))
    .finally(() => { current = null; });
  let watcher;
  try {
    mkdirSync(dir, { recursive: true });
    watcher = watch(dir, { persistent: false }, () => { void drain(); });
    watcher.on('error', () => watcher.close());
  } catch { /* Periodic recovery also covers files written during a drain. */ }
  const timer = setInterval(drain, RETRY_MS).unref();
  return { drain, close: () => { closed = true; clearInterval(timer); watcher?.close(); } };
}
