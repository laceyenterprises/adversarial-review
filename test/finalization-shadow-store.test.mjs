import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  openFinalizationShadowStore,
  openReadOnlyFinalizationShadowStore,
} from '../src/finalization/shadow-store.mjs';
import { shadowObserve } from '../src/finalization/shadow-recorder.mjs';
import {
  checksSettled,
  revisionAdvanced,
  verdictRecorded,
} from '../src/finalization/ledger-events.mjs';

const REF = { domainId: 'code-pr', subjectExternalId: 'owner/repo#7' };
const t = (n) => new Date(Date.parse('2026-07-17T00:00:00.000Z') + n * 60000).toISOString();

function memStore() {
  return openFinalizationShadowStore({ db: new Database(':memory:') });
}

function cleanObs(observedAt) {
  return shadowObserve({
    subject: REF,
    events: [
      revisionAdvanced(REF, { at: t(0), revisionRef: 'sha-A', sourceRef: 'push-A' }),
      checksSettled(REF, { at: t(1), revisionRef: 'sha-A', conclusion: 'success', requiredChecksPresent: true, sourceRef: 'suite-A' }),
      verdictRecorded(REF, { at: t(2), revisionRef: 'sha-A', stageId: 's', role: 'r', verdictKind: 'approved', sourceRef: 'rev-A' }),
    ],
    v1Action: 'merged',
    observedAt,
  });
}

test('append assigns an id and read round-trips the full observation', () => {
  const store = memStore();
  const stored = store.append(cleanObs(t(3)));
  assert.equal(typeof stored.id, 'number');

  const [read] = store.read();
  assert.equal(read.id, stored.id);
  assert.equal(read.subjectKey.subjectExternalId, 'owner/repo#7');
  assert.equal(read.v1Action.kind, 'merged');
  assert.equal(read.v2Decision.kind, 'finalize-now');
  assert.equal(read.classification.relation, 'agree');
  assert.equal(read.foldError, false);
  assert.equal(read.dispositionOverride, null);
  store.close();
});

test('read windows observations by tick time', () => {
  const store = memStore();
  store.append(cleanObs(t(0)));
  store.append(cleanObs(t(100)));
  store.append(cleanObs(t(200)));

  const windowed = store.read({ from: t(50), to: t(150) });
  assert.equal(windowed.length, 1);
  assert.equal(windowed[0].observedAt, t(100));

  assert.equal(store.read().length, 3, 'no window returns all');
  store.close();
});

test('annotate records a human override that read surfaces', () => {
  const store = memStore();
  const stored = store.append(cleanObs(t(3)));
  const annotated = store.annotate(stored.id, {
    disposition: 'open',
    note: 're-opening: v1 merge looks premature, investigate v2 fold',
    principal: 'operator',
    at: t(4),
  });
  assert.equal(annotated.dispositionOverride.disposition, 'open');

  const [read] = store.read();
  assert.equal(read.dispositionOverride.disposition, 'open');
  assert.equal(read.dispositionOverride.principal, 'operator');
  store.close();
});

test('annotate rejects a bad disposition', () => {
  const store = memStore();
  const stored = store.append(cleanObs(t(3)));
  assert.throws(() => store.annotate(stored.id, { disposition: 'maybe', at: t(4) }), /resolved.*open/);
  store.close();
});

test('the shadow store is append-only telemetry — read preserves append order within a tick', () => {
  const store = memStore();
  const a = store.append(cleanObs(t(3)));
  const b = store.append(cleanObs(t(3)));
  const rows = store.read();
  assert.deepEqual(rows.map((r) => r.id), [a.id, b.id]);
  store.close();
});

test('the reporting store reads through a query-only database handle', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'shadow-store-readonly-'));
  const writable = openFinalizationShadowStore({ rootDir });
  writable.append(cleanObs(t(3)));
  writable.close();

  const reporting = openReadOnlyFinalizationShadowStore({ rootDir });
  assert.equal(reporting.read().length, 1);
  assert.throws(
    () => reporting.db.prepare('DELETE FROM finalization_shadow').run(),
    /readonly|read-only/i,
  );
  reporting.close();
});
