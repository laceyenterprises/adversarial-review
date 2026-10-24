import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireMergeLease, acquireDaemonMergeLease, releaseMergeLease, renewMergeLease,
  reclaimIfStale, readMergeLeaseHistory, mergeLeaseHistoryFilePath, MERGE_LEASE_HISTORY_LIMIT,
} from '../src/ama/merge-lease.mjs';

const at = second => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'lease-history-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return { rootDir, repo: 'fixture/repo', base: 'main', holderPr: 1,
    holderHead: 'a'.repeat(40), holderPid: 123, holderHost: 'synthetic-host', pidAliveFn: () => true };
}

test('history persists grant, renewal and fenced release with original acquisition time', t => {
  const args = fixture(t);
  const held = acquireDaemonMergeLease({ ...args, now: at(0) });
  const renewed = renewMergeLease({ ...args, ...held.lease, now: at(2) });
  assert.equal(renewed.renewed, true);
  assert.equal(releaseMergeLease({ ...args, ...held.lease, now: at(3) }).released, false);
  assert.equal(releaseMergeLease({ ...args, ...renewed.lease, now: at(4) }).released, true);
  const rows = readMergeLeaseHistory(args.rootDir, args);
  assert.deepEqual(rows.map(r => r.event), ['grant', 'renew', 'requeue', 'release']);
  for (const row of rows) {
    assert.equal(row.holderRole, 'daemon');
    assert.equal(row.holderHead, args.holderHead);
    assert.equal(row.holderPid, 123);
    assert.equal(row.acquiredAt, at(0));
  }
  assert.equal(rows[2].releasedAt, at(4));
  assert.equal(rows[3].reason, 'holder-release');
});

for (const dead of [true, false]) test(`history records ${dead ? 'dead holder steal' : 'foreign deadline expiry'}`, t => {
  const args = fixture(t);
  acquireMergeLease({ ...args, now: at(0), deadlineSeconds: 1 });
  const result = reclaimIfStale({ ...args, now: at(30), host: dead ? args.holderHost : 'other-synthetic-host',
    pidAliveFn: () => !dead });
  assert.equal(result.reclaimed, true);
  const rows = readMergeLeaseHistory(args.rootDir, args);
  assert.equal(rows.at(-1).event, dead ? 'steal' : 'expiry');
  assert.equal(rows.at(-1).releasedAt, at(30));
  assert.equal(rows.at(-1).reason, dead ? 'dead-holder-pid' : 'past-deadline');
  assert.equal(acquireMergeLease({ ...args, holderPr: 2, now: at(31) }).acquired, true);
});

test('history retains only its bounded JSONL tail', t => {
  const args = fixture(t);
  const held = acquireMergeLease({ ...args, now: at(0) });
  const row = readMergeLeaseHistory(args.rootDir, args)[0];
  writeFileSync(mergeLeaseHistoryFilePath(args.rootDir, args),
    Array.from({ length: MERGE_LEASE_HISTORY_LIMIT }, (_, i) => JSON.stringify({ ...row, eventId: `fixture-${i}` })).join('\n') + '\n');
  releaseMergeLease({ ...args, ...held.lease, now: at(1) });
  const rows = readMergeLeaseHistory(args.rootDir, args);
  assert.equal(rows.length, MERGE_LEASE_HISTORY_LIMIT);
  assert.equal(rows[0].eventId, 'fixture-2');
  assert.equal(rows.at(-1).event, 'release');
});
