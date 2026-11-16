import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openFinalizationShadowStore, openReadOnlyFinalizationShadowStore } from '../src/finalization/shadow-store.mjs';
import { shadowPatternKey } from '../src/finalization/shadow-pattern.mjs';
import { buildShadowReport, buildMlrPromotionGate, effectiveDisposition } from '../src/finalization/shadow-report.mjs';
import { finalizationMain } from '../src/finalization-cli.mjs';

const at = n => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
const audit = n => ({ principal: 'synthetic-reviewer', note: 'Synthetic review rationale.', at: at(n) });
const application = { principal: 'synthetic-applier', at: at(3), apply: true };
const observation = (changes = {}) => ({
  subjectKey: { domainId: 'code-pr', subjectExternalId: 'example/project#1' },
  revisionRef: 'synthetic-head', observedAt: at(0),
  v1Action: { kind: 'remediate', detail: 'remediate:live-owner' },
  v2Decision: { kind: 'wait', reason: 'no verdict at current revision' },
  classification: { relation: 'diverge', direction: 'open', class: 'unclassified', disposition: 'open' },
  live: { source: 'synthetic' }, foldError: false, ...changes,
});
function fixture(t, disk = false) {
  if (disk) {
    const rootDir = mkdtempSync(join(tmpdir(), 'shadow-apply-'));
    const store = openFinalizationShadowStore({ rootDir });
    t.after(() => { store.close(); rmSync(rootDir, { recursive: true, force: true }); });
    return { store, rootDir };
  }
  const db = new Database(':memory:');
  t.after(() => db.close());
  return { store: openFinalizationShadowStore({ db }) };
}
function pattern(store, changes = {}) {
  const sample = store.read()[0];
  return store.addPattern({ ...audit(1), key: shadowPatternKey(sample), kind: 'equivalent', evidenceSampleIds: [sample.id], ...changes });
}

for (const disk of [false, true]) test(`apply, report, supersede and atomic revoke (${disk ? 'disk' : 'memory'})`, async t => {
  const { store, rootDir } = fixture(t, disk);
  store.append(observation());
  store.append(observation({ queue: { source: 'synthetic' }, live: undefined, dedupeKey: 'synthetic-queue' }));
  const reviewed = pattern(store);
  const read = openReadOnlyFinalizationShadowStore(rootDir ? { rootDir } : { db: store.db });
  const before = store.read();
  const plan = read.planPatternApplication(reviewed.id, { at: at(3) });
  read.close();
  assert.equal(plan.matched, 2);
  assert.equal('written' in plan, false);
  assert.deepEqual(store.read(), before);
  assert.deepEqual(await store.applyPatternToExisting(reviewed.id, { at: at(3) }), plan);
  const result = await store.applyPatternToExisting(reviewed.id, application);
  assert.equal(result.written, 2);
  assert.deepEqual(result.sampleIds, before.map(row => row.id));
  for (const row of store.read()) {
    assert.equal(effectiveDisposition(row), 'resolved');
    assert.deepEqual(row.dispositionOverride, {
      disposition: 'resolved', direction: 'benign', principal: application.principal, at: at(3),
      note: `pattern #${reviewed.id} (equivalent) applied to existing divergence: ${reviewed.note}`,
      source: 'pattern-apply-existing', pattern: { id: reviewed.id, key: reviewed.key, kind: reviewed.kind,
        principal: reviewed.principal, note: reviewed.note, ticketRef: null, createdAt: at(1) },
    });
  }
  const report = buildShadowReport({ observations: store.read(), now: at(4) });
  assert.equal(report.openDivergences, 0);
  assert.equal(report.patterns[0].byPatternExisting, 2);
  assert.equal(report.patterns[0].byIndividualOverride, 0);
  assert.equal(report.divergences[0].tag, `pattern #${reviewed.id}: equivalent (existing)`);
  const rerun = await store.applyPatternToExisting(reviewed.id, application);
  assert.equal(rerun.written, 0);
  assert.equal(rerun.alreadyApplied, 2);
  const applied = store.read()[0].dispositionOverride;
  const captured = store.append(observation({ observedAt: at(2) }));
  store.db.exec(`CREATE TRIGGER fail_reopen BEFORE UPDATE ON finalization_shadow
    WHEN NEW.id = 2 BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END`);
  assert.throws(() => store.revokePattern(reviewed.id, audit(4)), /synthetic rollback/);
  assert.equal(store.listPatterns()[0].revocation, null);
  assert.deepEqual(store.read()[0].dispositionOverride, applied);
  store.db.exec('DROP TRIGGER fail_reopen');
  const human = { ...audit(4), disposition: 'resolved', direction: 'benign' };
  store.annotate(2, human);
  store.revokePattern(reviewed.id, audit(5));
  assert.deepEqual(store.read()[0].dispositionOverride, { ...applied, disposition: 'open', revocation: audit(5) });
  assert.deepEqual(store.read()[1].dispositionOverride, human);
  assert.deepEqual(store.read().find(row => row.id === captured.id), captured);
  assert.equal(effectiveDisposition(store.read()[0]), 'open');
  const replacement = pattern(store, { ...audit(6), kind: 'v2-defect', ticketRef: 'EXAMPLE-42' });
  assert.equal((await store.applyPatternToExisting(replacement.id, { ...application, at: at(7) })).written, 1);
  const latest = store.read()[0].dispositionOverride;
  assert.equal(latest.direction, 'v2-suspect');
  assert.equal(latest.pattern.id, replacement.id);
  assert.deepEqual(latest.supersedes, { ...applied, disposition: 'open', revocation: audit(5) });
  store.revokePattern(replacement.id, audit(8));
  assert.deepEqual(store.read()[0].dispositionOverride, { ...latest, disposition: 'open', revocation: audit(8) });
});

test('eligibility skips errors, overrides, captures, closed, expiry and nonmatching keys', async t => {
  const { store } = fixture(t);
  store.append(observation());
  store.append(observation({ foldError: true }));
  store.append(observation({ classification: { ...observation().classification, class: 'fold-error' } }));
  const human = store.append(observation());
  store.annotate(human.id, { ...audit(0), disposition: 'open', direction: 'open' });
  const otherOverride = store.append(observation());
  store.annotate(otherOverride.id, { ...audit(0), disposition: 'open', direction: 'open', source: 'other' });
  store.append(observation({ v2Decision: { kind: 'wait', reason: 'checks patience expired' } }));
  store.append(observation({ observedAt: at(5) }));
  store.append(observation({ observedAt: at(6) }));
  store.append(observation({ classification: { ...observation().classification, disposition: 'resolved' } }));
  store.append(observation({ classification: { ...observation().classification, relation: 'agree' } }));
  const reviewed = pattern(store, { expiresAt: at(5), kind: 'policy' });
  const captured = store.append(observation({ observedAt: at(2) }));
  store.annotate(captured.id, { ...audit(2), disposition: 'open', direction: 'open',
    source: 'pattern-apply-existing', revocation: audit(2) });
  const plan = store.planPatternApplication(reviewed.id, { at: at(3) });
  assert.equal(plan.matched, 1);
  assert.deepEqual(plan.skipped, { foldError: 2, override: 2, captured: 1, notOpen: 2, expired: 2 });
  const before = store.read();
  assert.equal((await store.applyPatternToExisting(reviewed.id, application)).written, 1);
  assert.equal(store.read()[0].dispositionOverride.direction, 'benign');
  assert.deepEqual(store.read().slice(1), before.slice(1));
  for (const invalidAt of [at(0), at(5), 'invalid']) {
    assert.throws(() => store.planPatternApplication(reviewed.id, { at: invalidAt }));
    await assert.rejects(store.applyPatternToExisting(reviewed.id, { ...application, at: invalidAt }));
  }
  store.revokePattern(reviewed.id, audit(4));
  assert.throws(() => store.planPatternApplication(reviewed.id, { at: at(4) }), /revoked/);
  await assert.rejects(store.applyPatternToExisting(reviewed.id, { ...application, at: at(4) }), /revoked/);
});

test('500-row batches yield without holding the disk write lock; interrupted apply resumes', async t => {
  const { store, rootDir } = fixture(t, true);
  store.db.transaction(() => { for (let i = 0; i < 1001; i++) store.append(observation()); })();
  const reviewed = pattern(store);
  store.db.exec(`CREATE TRIGGER interrupt_apply BEFORE UPDATE ON finalization_shadow
    WHEN NEW.id = 750 BEGIN SELECT RAISE(ABORT, 'synthetic interruption'); END`);
  const other = openFinalizationShadowStore({ rootDir });
  t.after(() => other.close());
  let yielded = false;
  setImmediate(() => {
    assert.equal(other.read().filter(row => row.dispositionOverride).length, 500);
    other.annotate(1001, { ...audit(3), disposition: 'open', direction: 'open' });
    yielded = true;
  });
  await assert.rejects(store.applyPatternToExisting(reviewed.id, application), /synthetic interruption/);
  assert.equal(yielded, true);
  assert.equal(store.read().filter(row => row.dispositionOverride?.source === 'pattern-apply-existing').length, 500);
  store.db.exec('DROP TRIGGER interrupt_apply');
  const resumed = await store.applyPatternToExisting(reviewed.id, application);
  assert.equal(resumed.alreadyApplied, 500);
  assert.equal(resumed.written, 500);
  assert.equal(resumed.skipped.override, 1);
  assert.equal(resumed.sampleIds.length, 10);
});

test('revoke reopens all 5000 synthetic applied rows', async t => {
  const { store } = fixture(t, true);
  store.db.transaction(() => { for (let i = 0; i < 5000; i++) store.append(observation()); })();
  const reviewed = pattern(store);
  assert.equal((await store.applyPatternToExisting(reviewed.id, application)).written, 5000);
  const start = performance.now();
  store.revokePattern(reviewed.id, audit(4));
  const elapsed = performance.now() - start;
  // Keep timing diagnostic: shared-runner contention is not a correctness failure.
  t.diagnostic(`5000-row atomic revoke elapsed: ${elapsed.toFixed(2)} ms`);
  assert.equal(store.read().filter(row => row.dispositionOverride.revocation && effectiveDisposition(row) === 'open').length, 5000);
});

test('promotion gate ignores additive presentation counts and override provenance', async t => {
  const { store } = fixture(t);
  store.append(observation());
  const reviewed = pattern(store);
  await store.applyPatternToExisting(reviewed.id, application);
  const rows = store.read();
  const report = buildShadowReport({ observations: rows, now: at(4) });
  const withoutCount = { ...report, patterns: report.patterns.map(({ byPatternExisting, ...counts }) => counts) };
  assert.deepEqual(withoutCount.promotionGate, report.promotionGate);
  assert.deepEqual(buildMlrPromotionGate(rows, at(4)), buildMlrPromotionGate(rows.map(row => ({ ...row,
    dispositionOverride: { ...audit(3), disposition: 'resolved', direction: 'benign' } })), at(4)));
  store.revokePattern(reviewed.id, audit(5));
  assert.equal(buildMlrPromotionGate(store.read(), at(6)).openDivergences, 1);
});

test('CLI defaults to read-only dry-run, validates flags and awaits apply before close', async t => {
  const { store, rootDir } = fixture(t, true);
  store.append(observation());
  const reviewed = pattern(store);
  let text = '', errors = '', reads = 0, writes = 0;
  const io = { now: at(3), stdout: { write: value => { text += value; } }, stderr: { write: value => { errors += value; } },
    openPatternReadStore: options => { reads++; return openReadOnlyFinalizationShadowStore(options); },
    openPatternStore: options => { writes++; return openFinalizationShadowStore(options); } };
  const args = ['shadow-pattern', 'apply-existing', '--root', rootDir, '--id', String(reviewed.id)];
  for (const flags of [[], ['--dry-run']]) {
    text = '';
    assert.equal(await finalizationMain([...args, ...flags], io), 0);
    assert.equal(JSON.parse(text).matched, 1);
    assert.equal(store.read()[0].dispositionOverride, null);
  }
  assert.equal(reads, 2);
  assert.equal(writes, 0);
  text = '';
  assert.equal(await finalizationMain([...args, '--apply', '--principal', application.principal], io), 0);
  assert.equal(JSON.parse(text).written, 1);
  assert.equal(writes, 1);
  for (const flags of [['--apply'], ['--apply', '--principal', ' '], ['--apply', '--dry-run'], ['--dry-run', '--dry-run'],
    ['--principal', 'synthetic-applier'], ['--id', '0'], ['--wat']]) {
    assert.equal(await finalizationMain([...args, ...flags], io), 2);
  }
  assert.equal(await finalizationMain(['shadow-pattern', 'apply-existing', '--id', '999', '--root', rootDir], io), 1);
  assert.match(errors, /pattern missing/);
});


test('runtime keys ignore cached keys; revoke isolates other patterns and preserves unreadable overrides', async t => {
  const { store } = fixture(t);
  const first = store.append(observation());
  const second = store.append(observation({ v2Decision: { kind: 'wait', reason: 'checks patience expired' } }));
  const malformed = store.append(observation());
  const sqlClass = store.append(observation());
  store.db.prepare("UPDATE finalization_shadow SET payload_json=json_set(payload_json,'$.patternKey','stale-cache') WHERE id=?").run(first.id);
  store.db.prepare('UPDATE finalization_shadow SET disposition_override_json=? WHERE id=?').run('unreadable synthetic override', malformed.id);
  store.db.prepare("UPDATE finalization_shadow SET divergence_class='fold-error' WHERE id=?").run(sqlClass.id);
  const reviewed = pattern(store);
  const other = store.addPattern({ ...audit(1), key: shadowPatternKey(second), kind: 'policy', evidenceSampleIds: [second.id] });
  const result = await store.applyPatternToExisting(reviewed.id, application);
  assert.equal(result.written, 1);
  assert.equal(result.skipped.override, 1);
  assert.equal(result.skipped.foldError, 1);
  assert.equal((await store.applyPatternToExisting(other.id, application)).written, 1);
  const retained = store.read().find(row => row.id === second.id);
  store.revokePattern(reviewed.id, audit(4));
  assert.deepEqual(store.read().find(row => row.id === second.id), retained);
  assert.equal(store.db.prepare('SELECT disposition_override_json FROM finalization_shadow WHERE id=?').get(malformed.id).disposition_override_json,
    'unreadable synthetic override');
});

test('a concurrent revocation between batches prevents subsequent resolution', async t => {
  const { store, rootDir } = fixture(t, true);
  store.db.transaction(() => { for (let i = 0; i < 501; i++) store.append(observation()); })();
  const reviewed = pattern(store);
  const other = openFinalizationShadowStore({ rootDir });
  t.after(() => other.close());
  setImmediate(() => other.revokePattern(reviewed.id, audit(4)));
  await assert.rejects(store.applyPatternToExisting(reviewed.id, application), /revoked/);
  const rows = store.read();
  assert.equal(rows.filter(row => row.dispositionOverride?.revocation).length, 500);
  assert.equal(rows[500].dispositionOverride, null);
  assert.ok(rows.every(row => effectiveDisposition(row) === 'open'));
});

test('both CLI entrypoints await application and return store errors as exit 1', t => {
  const { store, rootDir } = fixture(t, true);
  store.append(observation());
  const reviewed = pattern(store);
  for (const entry of ['../src/cli.mjs', '../src/finalization-cli.mjs']) {
    const args = entry.endsWith('/cli.mjs') ? ['finalization'] : [];
    const run = spawnSync(process.execPath, [fileURLToPath(new URL(entry, import.meta.url)), ...args,
      'shadow-pattern', 'apply-existing', '--root', rootDir, '--id', String(reviewed.id), '--apply',
      '--principal', 'synthetic-cli-applier'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.written + result.alreadyApplied, 1);
    assert.equal(store.read()[0].dispositionOverride.principal, 'synthetic-cli-applier');
    const missing = spawnSync(process.execPath, [fileURLToPath(new URL(entry, import.meta.url)), ...args,
      'shadow-pattern', 'apply-existing', '--root', rootDir, '--id', '999'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(missing.status, 1, missing.stderr);
  }
});
