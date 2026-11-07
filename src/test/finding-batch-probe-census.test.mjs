// Kept in src to honor this finding batch's source-only edit scope.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeControllerIdentity } from '../controller-process-census.mjs';
import { probeQueueOwner } from '../finalization/queue-probe.mjs';
import { createCleanReviewService } from '../finalization/queue-clean-review.mjs';
import { openFinalizationQueueStore } from '../../test/helpers/queue-fixture-store.mjs';
import { queueCleanFixture } from '../../test/helpers/queue-clean-fixture.mjs';
import { handoffTime } from '../../test/helpers/queue-handoff-fixture.mjs';

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
  // Schema failures remain capability failures.
  store.db.exec('DROP TABLE finalization_queue_clean_review');
  const missingSchema = probe();
  assert.equal(missingSchema.capabilities.admission.available, false);
  assert.equal(missingSchema.capabilities.admission.reason, 'admission-schema-or-adapter-unavailable');
});
