// Read-only post-deploy observation. Never converges schema or claims a lane.
import Database from 'better-sqlite3';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveQueueOwnerAdapter } from './queue-owner.mjs';
import { queueWaitMs } from './queue-wait.mjs';
import { resolveQueueAdmissionAdapters } from './queue-admission.mjs';
import { resolveQueueHandoffStore } from './queue-handoff-store.mjs';
import { resolveQueueChecksAdapter } from './queue-checks.mjs';
import { resolveQueueGitAdapter } from './queue-git.mjs';
import { resolveQueueMergeAdapter } from './queue-merge.mjs';
import { QUEUE_DELIVERY_KINDS } from './queue-delivery.mjs';
import { readRoutingConfig, verifyRoutingSchema } from './queue-status.mjs';
import { resolveQueueRoutingStore, resolveLaneRoute } from './queue-routing.mjs';
import { resolveQueueShadowAdapter } from './queue-shadow.mjs';

import { queueRuntimeBuild } from './queue-build.mjs';
export { queueRuntimeBuild } from './queue-build.mjs';

const moduleDir = dirname(fileURLToPath(import.meta.url));

export function probeQueueOwner({ rootDir = resolve(moduleDir, '../..'), now = new Date().toISOString(), load, configPath, readConfig = readRoutingConfig } = {}) {
  const result = { capabilities: { owner: { available: false }, handoff: { available: false }, admission: { available: false }, rebase: { available: false }, checks: { available: false }, merge: { available: false }, shadow: { available: false }, routing: { available: false } }, runtime: {
    build: queueRuntimeBuild(), role: 'read-only-observer', pid: process.pid, observedAt: now, checkout: realpathSync(resolve(moduleDir, '../..')),
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
    try {
      if (!result.capabilities.admission.available) throw new Error('admission unavailable');
      reference.exec(readFileSync(new URL('../../migrations/20261026_finalization_queue_checks.sql', import.meta.url), 'utf8'));
      const sql = "SELECT type,name,sql FROM sqlite_master WHERE name='finalization_queue_check_page' ORDER BY name";
      if (JSON.stringify(db.prepare(sql).all()) !== JSON.stringify(reference.prepare(sql).all())) throw new Error('checks schema unavailable');
      const adapter = resolveQueueChecksAdapter({ db });
      const observed = adapter.read();
      result.observations.checks = { ...observed, organicChecksObserved: observed.observations.some(e => e.checks?.complete === true),
        organicParkingObserved: observed.observations.some(e => e.infrastructure != null) };
      result.capabilities.checks = { available: true, adapter: adapter.name, schema: '20261026_finalization_queue_checks',
        reader: 'exact-candidate-check-reader-v1', transport: 'entitled-gh-read-v1',
        livePolicyCredentialsAndPager: 'composition-required', routing: 'not-installed-by-this-capability' };
    } catch { result.capabilities.checks.reason = 'checks-store-or-parking-adapter-unavailable'; }
    try {
      if (!result.capabilities.admission.available) throw new Error('admission unavailable');
      const adapter = resolveQueueGitAdapter({ rootDir });
      const resolved = adapter.probe({ timeoutMs: queueWaitMs(1_000, { ceilingMs: 5_000,
        deadline: new Date(Date.parse(now) + 5_000).toISOString(), now, load }) });
      const counts = db.prepare(`SELECT COUNT(*) AS prepared,
        COALESCE(SUM(json_extract(payload_json,'$.rebase.publication.sourceRef') IS NOT NULL),0) AS published
        FROM finalization_queue_entry WHERE json_extract(payload_json,'$.rebase.workspace') IS NOT NULL`).get();
      const observations = db.prepare(`SELECT entry_id,phase,
        json_extract(payload_json,'$.expectedOldHead') AS oldHead,
        json_extract(payload_json,'$.candidate') AS candidate,
        json_extract(payload_json,'$.exactBase') AS exactBase,
        json_extract(payload_json,'$.rebase.publication') AS publication
        FROM finalization_queue_entry WHERE json_extract(payload_json,'$.rebase.workspace') IS NOT NULL
        ORDER BY COALESCE(json_extract(payload_json,'$.rebase.publication.observedAt'),
          json_extract(payload_json,'$.updatedAt')) DESC, rowid DESC LIMIT 100`).all().map(row => ({ ...row, publication: row.publication ? JSON.parse(row.publication) : null }));
      result.observations.rebase = { ...counts, observations, sampleLimit: 100, organicPublicationObserved: counts.published > 0 };
      result.capabilities.rebase = { available: true, ...resolved, schema: '20261023_finalization_queue',
        liveAdapter: 'composition-required', credentialRunner: 'composition-required', routing: 'not-installed-by-this-capability' };
    } catch {
      result.capabilities.rebase.reason = 'rebase-store-or-git-proof-adapter-unavailable';
    }
    try {
      if (!result.capabilities.checks.available) throw new Error('checks unavailable');
      reference.exec(readFileSync(new URL('../../migrations/20261027_finalization_queue_merge.sql', import.meta.url), 'utf8'));
      const sql = "SELECT type,name,sql FROM sqlite_master WHERE tbl_name IN ('finalization_queue_merge_receipt','finalization_queue_delivery') AND name NOT LIKE 'sqlite_%' ORDER BY name";
      if (JSON.stringify(db.prepare(sql).all()) !== JSON.stringify(reference.prepare(sql).all())) throw new Error('merge schema unavailable');
      const adapter = resolveQueueMergeAdapter({ db });
      const observed = adapter.read();
      result.observations.merge = { ...observed, organicMergeObserved: observed.receipts > 0,
        pendingDeliveryObserved: observed.pending > 0 };
      result.capabilities.merge = { available: true, adapter: adapter.name, schema: '20261027_finalization_queue_merge',
        mergeSurface: 'guarded-squash-merge-v1', deliveryKinds: [...QUEUE_DELIVERY_KINDS],
        liveIdentityMergeAndDeliveryAdapters: 'composition-required', routing: 'not-installed-by-this-capability' };
    } catch { result.capabilities.merge.reason = 'merge-store-or-receipt-adapter-unavailable'; }
    try {
      if (!result.capabilities.admission.available) throw new Error('admission unavailable');
      for (const migration of ['20260718_finalization_shadow', '20261028_finalization_queue_shadow']) {
        reference.exec(readFileSync(new URL(`../../migrations/${migration}.sql`, import.meta.url), 'utf8'));
      }
      // The original writable shadow store predates migration-based convergence;
      // its CREATE TABLE whitespace/comments differ from the migration bytes.
      const indexes = database => database.prepare("SELECT name,sql FROM sqlite_master WHERE tbl_name='finalization_shadow' AND type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all().map(row => ({ name: row.name, sql: row.sql.replace(/\s+/g, '') }));
      if (JSON.stringify(db.pragma('table_info(finalization_shadow)')) !== JSON.stringify(reference.pragma('table_info(finalization_shadow)'))
        || JSON.stringify(indexes(db)) !== JSON.stringify(indexes(reference))) throw new Error('shadow schema unavailable');
      const adapter = resolveQueueShadowAdapter({ db });
      const latest = db.prepare(`SELECT observed_at,payload_json FROM finalization_shadow
        WHERE json_extract(payload_json,'$.queue.source')='organic' AND observed_at <= ?
        ORDER BY observed_at DESC,id DESC LIMIT 1`).get(now);
      const queue = latest ? JSON.parse(latest.payload_json).queue : null;
      if (queue && (queue.mode !== adapter.mode || !queue.consumer?.id || !queue.consumer?.build)) throw new Error('shadow consumer evidence unavailable');
      const counts = db.prepare(`SELECT COUNT(*) AS observations,
        COALESCE(SUM(json_extract(payload_json,'$.queue.source')='organic'),0) AS organic,
        COALESCE(SUM(fold_error=1),0) AS unknown
        FROM finalization_shadow WHERE json_extract(payload_json,'$.queue') IS NOT NULL`).get();
      result.shadow = { mode: queue?.mode ?? adapter.mode, consumer: queue?.consumer ?? null,
        lastObservationAt: latest?.observed_at ?? null, lastObservationUnknown: queue?.error != null,
        noMutation: true, ...counts, organicEvidence: latest ? 'observed' : 'pending',
        composition: 'explicit-consumer-required; no production routing installed' };
      result.capabilities.shadow = { available: true, adapter: adapter.name, schema: '20261028_finalization_queue_shadow' };
    } catch { result.capabilities.shadow.reason = 'shadow-store-or-read-adapter-unavailable'; }
    try {
      if (!result.capabilities.merge.available) throw new Error('merge unavailable');
      verifyRoutingSchema(db);
      const config = readConfig({ rootDir, configPath });
      // Validation/defaults are exercised even before the first organic lane.
      resolveLaneRoute(config, { repository: 'example/review', base: 'main' });
      const adapter = resolveQueueRoutingStore({ db });
      result.observations.routing = { lanes: lanes.map(lane => ({ ...resolveLaneRoute(config, lane), ...adapter.read(lane) })),
        organicRoutingObserved: lanes.some(lane => adapter.read(lane).route?.runtime != null),
        composition: 'queue admission/execution adapters must be composed before promotion; uncomposed routes refuse execution' };
      result.capabilities.routing = { available: true, adapter: adapter.name, schema: '20261029_finalization_queue_routing',
        selector: 'roles.adversarial.merge_authority.lane_routes', defaultExecutor: 'legacy' };
    } catch { result.capabilities.routing.reason = 'routing-store-config-or-adapter-unavailable'; }
  } catch (error) {
    // Error codes are sufficient for operators; do not echo raw DB paths or
    // arbitrary adapter/auth diagnostics into this public read surface.
    result.capabilities.owner.reason = error.message === 'queue-schema-unavailable-or-incompatible' ? error.message : 'store-or-owner-adapter-unavailable';
    result.capabilities.handoff.reason = result.capabilities.owner.reason;
    result.capabilities.admission.reason = result.capabilities.owner.reason;
    result.capabilities.rebase.reason = result.capabilities.owner.reason;
    result.capabilities.checks.reason = result.capabilities.owner.reason;
    result.capabilities.merge.reason = result.capabilities.owner.reason;
    result.capabilities.shadow.reason = result.capabilities.owner.reason;
    result.capabilities.routing.reason = result.capabilities.owner.reason;
  } finally { reference?.close(); db?.close(); }
  return result;
}

export function queueProbeMain(argv = process.argv.slice(2), { stdout = process.stdout, probe = probeQueueOwner } = {}) {
  let rootDir;
  let capability;
  let configPath;
  const usage = 'usage: queue-probe.mjs --capability owner|handoff|admission|rebase|checks|merge|shadow|routing --json [--root DIR] [--config FILE]';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--capability' && ['owner', 'handoff', 'admission', 'rebase', 'checks', 'merge', 'shadow', 'routing'].includes(argv[i + 1])) {
      capability = argv[i + 1];
      i++;
    }
    else if (argv[i] === '--json') continue;
    else if (argv[i] === '--config' && argv[i + 1]) configPath = argv[++i];
    else if (argv[i] === '--root' && argv[i + 1]) rootDir = argv[++i];
    else throw new Error(usage);
  }
  if (!capability) throw new Error(usage);
  const result = probe({ rootDir, configPath });
  stdout.write(JSON.stringify(result) + '\n');
  return result.capabilities[capability].available ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = queueProbeMain(); }
  catch { process.stderr.write('invalid queue probe arguments\n'); process.exitCode = 2; }
}
