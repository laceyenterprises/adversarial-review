// Read-only post-deploy observation. Never converges schema or claims a lane.
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveQueueOwnerAdapter } from './queue-owner.mjs';
import { queueWaitMs } from './queue-wait.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
export function queueRuntimeBuild() {
  const hash = createHash('sha256');
  for (const file of ['queue-probe.mjs', 'queue-owner.mjs', 'queue-store.mjs', 'queue-wait.mjs', 'ledger-events.mjs', 'ledger-fold.mjs', '../../migrations/20261023_finalization_queue.sql']) {
    hash.update(file).update(readFileSync(join(moduleDir, file)));
  }
  return 'sha256:' + hash.digest('hex');
}

export function probeQueueOwner({ rootDir = resolve(moduleDir, '../..'), now = new Date().toISOString(), load } = {}) {
  const result = { capabilities: { owner: { available: false } }, runtime: {
    build: queueRuntimeBuild(), pid: process.pid, observedAt: now, checkout: realpathSync(resolve(moduleDir, '../..')),
  }, observations: null };
  let db;
  let reference;
  try {
    rootDir = realpathSync(rootDir);
    db = new Database(join(rootDir, 'data', 'reviews.db'), { readonly: true, fileMustExist: true });
    db.pragma(`busy_timeout = ${queueWaitMs(1_000, { ceilingMs: 5_000, deadline: new Date(Date.parse(now) + 5_000).toISOString(), now, load })}`);
    // Compare the deployed schema with the shipped migration, including unique
    // constraints and indexes, using only a disposable in-memory reference DB.
    reference = new Database(':memory:');
    reference.exec(readFileSync(new URL('../../migrations/20261023_finalization_queue.sql', import.meta.url), 'utf8'));
    const sql = "SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'finalization_queue_%' OR name LIKE 'idx_finalization_queue_%' ORDER BY name";
    if (JSON.stringify(db.prepare(sql).all()) !== JSON.stringify(reference.prepare(sql).all())) {
      throw new Error('queue-schema-unavailable-or-incompatible');
    }
    const adapter = resolveQueueOwnerAdapter({ rootDir, db });
    const lanes = db.prepare('SELECT repository,base,generation,route_generation,owner_id,owner_state,heartbeat_at,expires_at,reason,readiness_seq FROM finalization_queue_lane ORDER BY repository,base').all();
    const unresolved = db.prepare('SELECT COUNT(*) AS count FROM finalization_queue_operation WHERE result_json IS NULL').get().count;
    result.observations = { lanes, unresolvedOperations: unresolved, organicOwnershipObserved: lanes.some(l => l.generation > 0) };
    result.capabilities.owner = { available: true, adapter: adapter.name, schema: '20261023_finalization_queue' };
  } catch (error) {
    // Error codes are sufficient for operators; do not echo raw DB paths or
    // arbitrary adapter/auth diagnostics into this public read surface.
    result.capabilities.owner.reason = error.message === 'queue-schema-unavailable-or-incompatible' ? error.message : 'store-or-owner-adapter-unavailable';
  } finally { reference?.close(); db?.close(); }
  return result;
}

export function queueProbeMain(argv = process.argv.slice(2)) {
  let rootDir;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--capability' && argv[i + 1] === 'owner') i++;
    else if (argv[i] === '--json') continue;
    else if (argv[i] === '--root' && argv[i + 1]) rootDir = argv[++i];
    else throw new Error('usage: queue-probe.mjs --capability owner --json [--root DIR]');
  }
  const result = probeQueueOwner({ rootDir });
  process.stdout.write(JSON.stringify(result) + '\n');
  return result.capabilities.owner.available ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = queueProbeMain(); }
  catch { process.stderr.write('invalid queue probe arguments\n'); process.exitCode = 2; }
}
