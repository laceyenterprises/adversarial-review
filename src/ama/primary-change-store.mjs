import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const running = new Map();
const directory = rootDir => join(rootDir, 'data', 'primary-change-history');
const identity = args => [args.repo, Number(args.prNumber), args.baseSha, args.headSha, args.mergeBase, args.reviewKey || null, args.launchHead || null];
const pathFor = args => join(directory(args.rootDir), `${createHash('sha256').update(JSON.stringify(identity(args))).digest('hex')}.json`);

export function primaryChangeReadStatus({ rootDir, repo, prNumber, headSha }) {
  const entry = [...running.values()].find(item => item.args.rootDir === rootDir
    && item.args.repo === repo && Number(item.args.prNumber) === Number(prNumber) && item.args.headSha === headSha);
  return entry ? `primary-change read still running, ${Math.floor((Date.now() - entry.startedAt) / 1000)} seconds` : null;
}

export async function storedPrimaryChange(args, compute) {
  const path = pathFor(args);
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (JSON.stringify(record.key) === JSON.stringify(identity(args))
      && record.history?.headSha === args.headSha
      && (!record.history.builderBoundary || !args.builderHead || record.history.builderBoundary === args.builderHead)
      && [true, false].includes(record.history.hasHammerCommits)
      && (!record.history.hasHammerCommits || record.history.mergeBase === args.mergeBase)) return record.history;
  } catch { /* Missing/corrupt evidence is recomputed, never accepted. */ }
  if (running.has(path)) {
    const history = await running.get(path).promise;
    if (history.builderBoundary && args.builderHead && history.builderBoundary !== args.builderHead) {
      return storedPrimaryChange(args, compute);
    }
    return history;
  }
  const entry = { args, startedAt: Date.now() };
  entry.promise = Promise.resolve().then(compute).then(history => {
    if ([true, false].includes(history.hasHammerCommits) && !history.readFailed && !history.headMismatch
      && (!history.hasHammerCommits || history.mergeBase === args.mergeBase)) {
      mkdirSync(directory(args.rootDir), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ key: identity(args), history }), { mode: 0o600 });
        renameSync(temporary, path);
      } finally { rmSync(temporary, { force: true }); }
    }
    return history;
  }).finally(() => running.delete(path));
  running.set(path, entry);
  return entry.promise;
}

// Reuse the watcher's existing periodic sweep; no deployment knob. Fixed age
// and count bounds cover closed PRs and obsolete heads without live API reads.
export function sweepPrimaryChangeStore(rootDir, { nowMs = Date.now() } = {}) {
  let entries;
  try { entries = readdirSync(directory(rootDir)).map(name => {
    const path = join(directory(rootDir), name);
    return { path, modified: statSync(path).mtimeMs };
  }).sort((a, b) => b.modified - a.modified); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const expired = entries.filter((entry, index) => index >= 512 || nowMs - entry.modified > 7 * 86400000);
  for (const entry of expired) rmSync(entry.path, { force: true });
  return expired.map(entry => entry.path);
}
