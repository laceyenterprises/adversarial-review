import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeControllerIdentity } from '../src/controller-process-census.mjs';
import { probeQueueOwner } from '../src/finalization/queue-probe.mjs';
import { createCleanReviewService } from '../src/finalization/queue-clean-review.mjs';
import { createQueueHandoffService } from '../src/finalization/queue-handoff-store.mjs';
import { openFinalizationQueueStore } from './helpers/queue-fixture-store.mjs';
import { queueCleanFixture } from './helpers/queue-clean-fixture.mjs';
import { handoffTime, queueHandoffFixture } from './helpers/queue-handoff-fixture.mjs';

test('unsupported census verbs never start a helper or allocate a timeout', () => {
  for (const verb of ['serve', '', undefined, 'GROUP']) {
    assert.throws(() => nativeControllerIdentity(verb, 123, {
      execFileSyncImpl() { assert.fail('invalid verb spawned a process'); },
      timeoutImpl() { assert.fail('invalid verb reached timeout allocation'); },
    }), error => error.code === 'EINVAL' && /controller process census unavailable:/.test(error.message));
  }
});

test('invalid historical receipt stays observable without disabling installed admission', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'batch-probe-'));
  const store = openFinalizationQueueStore({ rootDir });
  t.after(() => { store.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const now = handoffTime(0);
  const { h, e } = queueCleanFixture();
  const service = createCleanReviewService({ store, now: () => now,
    load: { enabled: false }, evidenceAdapter: { read: async () => e } });
  await service.submit(h);
  const probe = () => probeQueueOwner({ rootDir, now, load: { enabled: false } });
  const healthy = probe();
  assert.equal(healthy.capabilities.admission.available, true);
  assert.equal(healthy.observations.admission.invalidSampledReceipts, undefined);
  store.db.prepare("UPDATE finalization_queue_clean_review SET evidence_json='{}'").run();
  const damaged = probe();
  assert.equal(damaged.capabilities.admission.available, true);
  assert.equal(damaged.observations.admission.sampledReceipts, 1);
  assert.equal(damaged.observations.admission.invalidSampledReceipts, 1);
  assert.equal(damaged.observations.admission.clean, 1);
  store.db.prepare("UPDATE finalization_queue_clean_review SET evidence_json='{'").run();
  assert.equal(probe().observations.admission.invalidSampledReceipts, 1);
  // Schema failures remain capability failures.
  store.db.exec('DROP TABLE finalization_queue_clean_review');
  const missingSchema = probe();
  assert.equal(missingSchema.capabilities.admission.available, false);
  assert.equal(missingSchema.capabilities.admission.reason, 'admission-schema-or-adapter-unavailable');
});

test('invalid historical handoff provenance and acknowledgements remain observable', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'batch-probe-'));
  const store = openFinalizationQueueStore({ rootDir });
  t.after(() => { store.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const now = handoffTime(0);
  const { h, e } = queueHandoffFixture();
  await createQueueHandoffService({ store, now: () => now,
    load: { enabled: false }, evidenceAdapter: { read: async () => e } }).submit(h);
  const probe = () => probeQueueOwner({ rootDir, now, load: { enabled: false } });
  assert.equal(probe().observations.admission.invalidSampledReceipts, undefined);
  e.identities.ok = false;
  store.db.prepare('UPDATE finalization_queue_handoff SET evidence_json=?').run(JSON.stringify(e));
  const invalidEvidence = probe();
  assert.equal(invalidEvidence.capabilities.admission.available, true);
  assert.equal(invalidEvidence.observations.admission.invalidSampledReceipts, 1);
  store.db.prepare("UPDATE finalization_queue_handoff SET ack_json='{}'").run();
  const invalidAck = probe();
  assert.equal(invalidAck.capabilities.admission.available, true);
  assert.equal(invalidAck.observations.admission.invalidSampledReceipts, 1);
});

for (const fault of [new TypeError('unexpected adapter bug'), Object.assign(new Error('storage failure'), { code: 'SQLITE_IOERR' })]) {
  test(`unexpected receipt read error fails admission capability: ${fault.message}`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'batch-probe-'));
    const store = openFinalizationQueueStore({ rootDir });
    t.after(() => { store.close(); rmSync(rootDir, { recursive: true, force: true }); });
    const now = handoffTime(0);
    const { h, e } = queueCleanFixture();
    await createCleanReviewService({ store, now: () => now,
      load: { enabled: false }, evidenceAdapter: { read: async () => e } }).submit(h);
    const prepare = Database.prototype.prepare;
    let receiptReads = 0;
    t.mock.method(Database.prototype, 'prepare', function (sql, ...args) {
      const statement = prepare.call(this, sql, ...args);
      if (!sql.startsWith('SELECT c.*,e.payload_json')) return statement;
      return { get() { receiptReads += 1; throw fault; } };
    });
    const result = probeQueueOwner({ rootDir, now, load: { enabled: false } });
    assert.equal(receiptReads, 1);
    assert.equal(result.capabilities.owner.available, true);
    assert.equal(result.capabilities.admission.available, false);
    assert.equal(result.capabilities.admission.reason, 'admission-schema-or-adapter-unavailable');
    assert.equal(result.observations.admission, undefined);
  });
}
