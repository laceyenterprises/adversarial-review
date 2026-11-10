import { withRepositoryStateCycle } from '../repository-state-lock.mjs';
import { canonicalRepositoryArguments } from '../repository-names.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const running = new Map();
const directory = rootDir => join(rootDir, 'data', 'primary-change-history');
const PROGRESS_MAX_BYTES = 256 * 1024 * 1024;
const progressName = name => /^progress-[a-f0-9]{64}$/.test(name);
// PRIMARYRENAME-01: old history records lack commit-level rename proof. Re-read
// those once so a cached refusal cannot strand an otherwise preserved head.
// v2 also recomputes records which omitted builder-originated rename proof.
// HAMREVERSAL-02: recompute stale original-reversal refusals and proofs once
// with context-tolerant, structure-preserving identity and bounded diagnostics.
// REVERSALPROV-01: re-evaluate cached foreign-committer provenance refusals.
// REVERSALPROV-02: recompute insertion and mixed-restoration proofs with
// complete changed-content identities, including previously ambiguous hunks.
// LAC-2101: recompute historical snapshot refusals made before literal
// secondary/brace finding paths could cover the original HAM reversal.
// SAFETYSTOPOWNER-01: discard refusals based only on the first superseding snapshot.
const identity = args => [args.repo, Number(args.prNumber), args.baseSha, args.headSha, args.mergeBase, args.reviewKey || null, args.launchHead || null, 'reversalproof-v6'];
const pathFor = args => join(directory(args.rootDir), `${createHash('sha256').update(JSON.stringify(identity(args))).digest('hex')}.json`);

// Atomic replacement inherits the writer's UID. Never let a worker replace
// daemon-owned evidence (or create private evidence inside the daemon tree).
function assertStoreOwner(rootDir, path = null) {
  if (typeof process.geteuid !== 'function') throw new Error('primary-change store requires an OS effective uid ownership check');
  const uid = process.geteuid();
  const dataDir = join(rootDir, 'data');
  for (const candidate of [dataDir, directory(rootDir), path].filter(Boolean)) {
    let stat;
    try { stat = lstatSync(candidate); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (candidate !== dataDir) continue;
      // Before creating data/, the runtime root is the ownership anchor.
      stat = lstatSync(rootDir);
    }
    if (stat.isSymbolicLink() || stat.uid !== uid) {
      throw new Error(`Primary-change store ${candidate} is owned by uid ${stat.uid}; refusing cross-user or symlink access as uid ${uid}. Run as the canonical daemon owner (sudo -A -H -u <owner>).`);
    }
  }
}

export function primaryChangeStoreOwned(rootDir) {
  try { assertStoreOwner(rootDir); return true; }
  catch { return false; } // No store reads or writes by this caller.
}

function progressDirectory(args) {
  const canonical = canonicalRepositoryArguments(args.rootDir, args);
  const key = [canonical.repo, Number(canonical.prNumber), args.headSha, 'history-progress-v1'];
  if (!/^[0-9a-f]{40}$/i.test(args.headSha || '')) throw new Error('invalid history progress head');
  const digest = createHash('sha256').update(JSON.stringify(key)).digest('hex');
  return { key, dir: join(directory(args.rootDir), `progress-${digest}`) };
}

export function discardHistoryProgress(args) {
  assertStoreOwner(args.rootDir);
  const { dir } = progressDirectory(args);
  assertStoreOwner(args.rootDir, dir);
  rmSync(dir, { force: true, recursive: true });
}

// Checkpoint only completed immutable reads, never verdicts or live metadata.
// A directory per head lets the sweeper evict whole histories independently
// of the completed-record count, with a separate aggregate byte budget.
export async function storedHistoryRead(args, readKey, compute, signal) {
  signal?.throwIfAborted();
  assertStoreOwner(args.rootDir);
  const { key, dir } = progressDirectory(args);
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const path = join(dir, `${digest(readKey)}.json`);
  assertStoreOwner(args.rootDir, dir);
  assertStoreOwner(args.rootDir, path);
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record && Object.hasOwn(record, 'value') && JSON.stringify(record.key) === JSON.stringify(key)
      && JSON.stringify(record.readKey) === JSON.stringify(readKey)) return record.value;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  const value = await compute();
  signal?.throwIfAborted();
  assertStoreOwner(args.rootDir, dir);
  assertStoreOwner(args.rootDir, path);
  mkdirSync(dir, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ key, readKey, value }), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    // Retention follows the last established progress, not directory creation.
    const now = new Date();
    utimesSync(dir, now, now);
  } catch (error) {
    // A concurrent sweep/completed collector can remove disposable progress.
    // The completed read is still valid; retry caching on a later evaluation.
    if (error.code !== 'ENOENT') throw error;
  } finally { rmSync(temporary, { force: true }); }
  return value;
}

// REVERSALPROOF-01: these are verified observations, not head/review caches.
// Keep them outside cache expiry, scoped to this repository, PR and patch.
export async function verifiedReversalRecord(args, patchIdentity, record) {
  assertStoreOwner(args.rootDir);
  return withRepositoryStateCycle(args.rootDir, () => {
    const canonical = canonicalRepositoryArguments(args.rootDir, args);
    const key = [canonical.repo, Number(canonical.prNumber), patchIdentity, 'verified-reversal-v1'];
    const digest = createHash('sha256').update(JSON.stringify(key)).digest('hex');
    const path = join(directory(args.rootDir), `verified-${digest}.json`);
    assertStoreOwner(args.rootDir, path);
    if (record === undefined) {
      try {
        const stored = JSON.parse(readFileSync(path, 'utf8'));
        if (!stored || typeof stored !== 'object') return null;
        return JSON.stringify(stored.key) === JSON.stringify(key) ? stored.record : null;
      } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
      }
    }
    mkdirSync(directory(args.rootDir), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ key, record }), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
    return record;
  });
}

export function primaryChangeReadStatus({ rootDir, repo, prNumber, headSha }) {
  const entry = [...running.values()].find(item => item.args.rootDir === rootDir
    && item.args.repo === repo && Number(item.args.prNumber) === Number(prNumber) && item.args.headSha === headSha);
  return entry ? `primary-change read still running, ${Math.floor((Date.now() - entry.startedAt) / 1000)} seconds` : null;
}

async function storedPrimaryChangeWithinRepositoryState(args, compute) {
  const path = pathFor(args);
  assertStoreOwner(args.rootDir, path);
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
    if ([true, false].includes(history.hasHammerCommits) && !history.readFailed && !history.headMismatch && !history.renameProofReadFailed
      && (!history.hasHammerCommits || history.mergeBase === args.mergeBase)) {
      assertStoreOwner(args.rootDir, path);
      mkdirSync(directory(args.rootDir), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({ key: identity(args), history }), { mode: 0o600, flag: 'wx' });
        renameSync(temporary, path);
      } finally { rmSync(temporary, { force: true }); }
      discardHistoryProgress(args);
    }
    return history;
  }).finally(() => running.delete(path));
  running.set(path, entry);
  return entry.promise;
}

// Reuse the watcher's existing periodic sweep; no deployment knob. Fixed age
// and count bounds cover closed PRs and obsolete heads without live API reads.
export function sweepPrimaryChangeStore(rootDir, { nowMs = Date.now(), progressMaxBytes = PROGRESS_MAX_BYTES } = {}) {
  assertStoreOwner(rootDir);
  let names;
  try { names = readdirSync(directory(rootDir)); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = names.filter(name => !/^verified-[a-f0-9]{64}\.json$/.test(name)).flatMap(name => {
    const path = join(directory(rootDir), name);
    try { return [{ path, progress: progressName(name), modified: statSync(path).mtimeMs }]; } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }).sort((a, b) => b.modified - a.modified);
  let completedCount = 0, progressCount = 0, progressBytes = 0;
  const expired = entries.filter(entry => {
    if (!entry.progress) return completedCount++ >= 512 || nowMs - entry.modified > 7 * 86400000;
    assertStoreOwner(rootDir, entry.path);
    if (nowMs - entry.modified > 7 * 86400000 || progressCount >= 512) return true;
    let bytes = 0;
    try {
      for (const name of readdirSync(entry.path)) {
        const path = join(entry.path, name);
        assertStoreOwner(rootDir, path);
        try { bytes += lstatSync(path).size; } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (progressBytes + bytes > progressMaxBytes) return true;
    progressBytes += bytes;
    progressCount++;
    return false;
  });
  for (const entry of expired) {
    assertStoreOwner(rootDir, entry.path);
    rmSync(entry.path, { force: true, recursive: progressName(basename(entry.path)) });
  }
  return expired.map(entry => entry.path);
}

export async function storedPrimaryChange(args = {}, ...rest) {
  // Ownership refusal must precede even creation of the migration fence.
  assertStoreOwner(args.rootDir, pathFor(args));
  return withRepositoryStateCycle(args.rootDir, () =>
    storedPrimaryChangeWithinRepositoryState(canonicalRepositoryArguments(args.rootDir, args), ...rest));
}
