// Read-only post-deploy observation. Never converges schema or claims a lane.
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveQueueOwnerAdapter } from './queue-owner.mjs';
import { queueWaitMs } from './queue-wait.mjs';
import { resolveQueueAdmissionAdapters } from './queue-admission.mjs';
import { resolveQueueHandoffStore } from './queue-handoff-store.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));
export function queueRuntimeBuild() {
  const hash = createHash('sha256');
  for (const file of ['queue-probe.mjs', 'queue-owner.mjs', 'queue-store.mjs', 'queue-wait.mjs', 'ledger-events.mjs', 'ledger-fold.mjs',
    'queue-handoff.mjs', 'queue-handoff-store.mjs', '../ama/closer-queue-handoff.mjs',
    'queue-admission.mjs', 'queue-clean-review.mjs', 'queue-read.mjs', '../ama/merge-eligibility.mjs', '../operator-hold-labels.mjs',
    '../../migrations/20261023_finalization_queue.sql', '../../migrations/20261024_finalization_queue_handoff.sql',
    '../../migrations/20261025_finalization_queue_admission.sql']) {
    hash.update(file).update(readFileSync(join(moduleDir, file)));
  }
  return 'sha256:' + hash.digest('hex');
}

export function probeQueueOwner({ rootDir = resolve(moduleDir, '../..'), now = new Date().toISOString(), load } = {}) {
  const result = { capabilities: { owner: { available: false }, handoff: { available: false }, admission: { available: false } }, runtime: {
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
    const baseline = reference.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    // Later additive migrations do not change the baseline capability. Verify
    // every shipped baseline object by name, including its full definition.
    const sql = `SELECT type,name,sql FROM sqlite_master WHERE name IN (${baseline.map(() => '?').join(',')}) ORDER BY name`;
    if (JSON.stringify(db.prepare(sql).all(...baseline.map(row => row.name))) !== JSON.stringify(baseline)) {
      throw new Error('queue-schema-unavailable-or-incompatible');
    }
    const adapter = resolveQueueOwnerAdapter({ rootDir, db });
    const lanes = db.prepare('SELECT repository,base,generation,route_generation,owner_id,owner_state,heartbeat_at,expires_at,reason,readiness_seq FROM finalization_queue_lane ORDER BY repository,base').all();
    const unresolved = db.prepare('SELECT COUNT(*) AS count FROM finalization_queue_operation WHERE result_json IS NULL').get().count;
    result.observations = { lanes, unresolvedOperations: unresolved, organicOwnershipObserved: lanes.some(l => l.generation > 0) };
    result.capabilities.owner = { available: true, adapter: adapter.name, schema: '20261023_finalization_queue' };
    try {
      reference.exec(readFileSync(new URL('../../migrations/20261024_finalization_queue_handoff.sql', import.meta.url), 'utf8'));
      const handoffSql = "SELECT type,name,sql FROM sqlite_master WHERE name='finalization_queue_handoff' ORDER BY name";
      if (JSON.stringify(db.prepare(handoffSql).all()) !== JSON.stringify(reference.prepare(handoffSql).all())) {
        throw new Error('handoff-schema-unavailable-or-incompatible');
      }
      const receipts = resolveQueueHandoffStore({ db });
      const acknowledgements = db.prepare('SELECT COUNT(*) AS count FROM finalization_queue_handoff').get().count;
      result.observations.handoff = { acknowledgements, organicHandoffObserved: acknowledgements > 0 };
      result.capabilities.handoff = { available: true, adapter: receipts.name, schema: '20261024_finalization_queue_handoff',
        evidenceAdapter: 'composition-required', routing: 'not-installed-by-this-capability' };
    } catch {
      result.capabilities.handoff.reason = 'handoff-schema-or-adapter-unavailable';
    }
    try {
      if (!result.capabilities.handoff.available) throw new Error('handoff unavailable');
      reference.exec(readFileSync(new URL('../../migrations/20261025_finalization_queue_admission.sql', import.meta.url), 'utf8'));
      const admissionSql = "SELECT type,name,sql FROM sqlite_master WHERE name='finalization_queue_clean_review' ORDER BY name";
      if (JSON.stringify(db.prepare(admissionSql).all()) !== JSON.stringify(reference.prepare(admissionSql).all())) {
        throw new Error('admission schema unavailable');
      }
      const adapters = resolveQueueAdmissionAdapters({ db, entries: lane => db.prepare(
        'SELECT payload_json FROM finalization_queue_entry WHERE repository=? AND base=? ORDER BY readiness_seq,entry_id'
      ).all(lane.repository, lane.base).map(row => JSON.parse(row.payload_json)) });
      const counts = db.prepare(`SELECT
        COALESCE(SUM(c.entry_id IS NOT NULL),0) AS clean,
        COALESCE(SUM(h.entry_id IS NOT NULL),0) AS remediated,
        COALESCE(SUM(c.entry_id IS NULL AND h.entry_id IS NULL),0) AS unvalidated,
        COALESCE(SUM(e.phase IN ('acknowledged','ready','rebasing','publishing','waiting-checks','finalizing')),0) AS actionable,
        COALESCE(SUM(e.phase IN ('parked-hold','parked-permission','parked-infrastructure')),0) AS parked,
        COALESCE(SUM(e.phase IN ('merged','closed-observed','returned-to-closer')),0) AS terminal,
        COALESCE(SUM(json_extract(e.payload_json,'$.admission.observedAt') IS NOT NULL),0) AS observed
        FROM finalization_queue_entry e LEFT JOIN finalization_queue_clean_review c USING(entry_id)
        LEFT JOIN finalization_queue_handoff h USING(entry_id)`).get();
      // Verify a bounded recent sample through the actual receipt adapters;
      // totals remain store counts, not a claim that every receipt was audited.
      const sample = db.prepare('SELECT payload_json FROM finalization_queue_entry ORDER BY rowid DESC LIMIT 100').all();
      for (const row of sample) adapters.receipt(JSON.parse(row.payload_json));
      result.observations.admission = { ...counts, sampledReceipts: sample.length, sampleLimit: 100,
        organicAdmissionObserved: counts.observed > 0 };
      result.capabilities.admission = { available: true, adapter: adapters.name, schema: '20261025_finalization_queue_admission',
        liveAdapter: 'composition-required', routing: 'not-installed-by-this-capability' };
    } catch {
      result.capabilities.admission.reason = 'admission-schema-or-adapter-unavailable';
    }
  } catch (error) {
    // Error codes are sufficient for operators; do not echo raw DB paths or
    // arbitrary adapter/auth diagnostics into this public read surface.
    result.capabilities.owner.reason = error.message === 'queue-schema-unavailable-or-incompatible' ? error.message : 'store-or-owner-adapter-unavailable';
    result.capabilities.handoff.reason = result.capabilities.owner.reason;
    result.capabilities.admission.reason = result.capabilities.owner.reason;
  } finally { reference?.close(); db?.close(); }
  return result;
}

export function queueProbeMain(argv = process.argv.slice(2)) {
  let rootDir;
  let capability;
  const usage = 'usage: queue-probe.mjs --capability owner|handoff|admission --json [--root DIR]';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--capability' && ['owner', 'handoff', 'admission'].includes(argv[i + 1])) {
      capability = argv[i + 1];
      i++;
    }
    else if (argv[i] === '--json') continue;
    else if (argv[i] === '--root' && argv[i + 1]) rootDir = argv[++i];
    else throw new Error(usage);
  }
  if (!capability) throw new Error(usage);
  const result = probeQueueOwner({ rootDir });
  process.stdout.write(JSON.stringify(result) + '\n');
  return result.capabilities[capability].available ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = queueProbeMain(); }
  catch { process.stderr.write('invalid queue probe arguments\n'); process.exitCode = 2; }
}
