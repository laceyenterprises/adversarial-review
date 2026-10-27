import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const running = new Map();
const directory = rootDir => join(rootDir, 'data', 'primary-change-history');
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
const identity = args => [args.repo, Number(args.prNumber), args.baseSha, args.headSha, args.mergeBase, args.reviewKey || null, args.launchHead || null, 'reversalprov-v5'];
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

export function primaryChangeReadStatus({ rootDir, repo, prNumber, headSha }) {
  const entry = [...running.values()].find(item => item.args.rootDir === rootDir
    && item.args.repo === repo && Number(item.args.prNumber) === Number(prNumber) && item.args.headSha === headSha);
  return entry ? `primary-change read still running, ${Math.floor((Date.now() - entry.startedAt) / 1000)} seconds` : null;
}

export async function storedPrimaryChange(args, compute) {
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
    }
    return history;
  }).finally(() => running.delete(path));
  running.set(path, entry);
  return entry.promise;
}

// Reuse the watcher's existing periodic sweep; no deployment knob. Fixed age
// and count bounds cover closed PRs and obsolete heads without live API reads.
export function sweepPrimaryChangeStore(rootDir, { nowMs = Date.now() } = {}) {
  assertStoreOwner(rootDir);
  let names;
  try { names = readdirSync(directory(rootDir)); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = names.flatMap(name => {
    const path = join(directory(rootDir), name);
    try { return [{ path, modified: statSync(path).mtimeMs }]; } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }).sort((a, b) => b.modified - a.modified);
  const expired = entries.filter((entry, index) => index >= 512 || nowMs - entry.modified > 7 * 86400000);
  for (const entry of expired) {
    assertStoreOwner(rootDir, entry.path);
    rmSync(entry.path, { force: true });
  }
  return expired.map(entry => entry.path);
}
