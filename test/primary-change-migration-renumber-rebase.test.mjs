import test from 'node:test';
import assert from 'node:assert/strict';
import { proveMigrationRenumbers } from '../src/ama/migration-renumber.mjs';
import { checkPrimaryChange, fetchPrimaryChange } from '../src/ama/primary-change.mjs';
import { alembicRenumberFixture, migrationRenumberFixture } from './helpers/migration-renumber.mjs';
import { rebasedRenumberFixture } from './helpers/migration-renumber-rebase.mjs';

async function prove(f) {
  f.evidence.migrationRenumberProofs = await proveMigrationRenumbers(f.args, f.evidence);
  return checkPrimaryChange(f.evidence, f.args.headSha);
}

test('MIGRENUMBERDERIVED-03: diverged protected SQL author head, large tree and 309 -> 310 -> 311 -> 312', async () => {
  const f = rebasedRenumberFixture();
  const ancestry = await f.args.get(`repos/fixture/repo/compare/${f.evidence.primaryHead}...${f.args.headSha}`);
  assert.equal(ancestry.status, 'diverged');
  const result = await prove(f);
  assert.equal(result.ok, true, JSON.stringify(f.evidence.migrationRenumberDiagnostics));
  assert.deepEqual(result.derivedChanges[0].chain.map(entry => Number(entry.path.match(/\/(\d+)_/)[1])), [309, 310, 311, 312]);
  assert.equal(result.derivedChanges[0].moduleOrigin, 'author-sql');
  assert.ok(f.calls.some(path => /\/git\/trees\/[a-f0-9]+$/.test(path)));
  assert.equal(f.calls.filter(path => path.endsWith('?recursive=1')).length, 1);
});

for (const [name, modify] of [
  ['wrapper operation', f => { f.evidence.finalFiles[0].sha = f.blob(f.body(312).replace('upgrade_revision(', 'other_operation(')); }],
  ['SQL operation', f => { f.evidence.finalFiles[1].sha = f.blob(f.sql.replace('CREATE TABLE', 'DROP TABLE')); }],
  ['module SQL operation', f => { f.evidence.finalFiles[2].sha = f.blob(f.moduleBody(312).replace('CREATE TABLE', 'DROP TABLE')); }],
  ['module executable suffix', f => { f.evidence.finalFiles[2].sha = f.blob(f.moduleBody(312) + 'dangerous_call()\n'); }],
  ['module executable argument', f => { f.evidence.finalFiles[2].sha = f.blob(f.moduleBody(312).replace('"DROP TABLE sample"', 'dangerous_call()')); }],
  ['intermediate downgrade', f => { f.snapshots[1].files[2].sha = f.blob(f.moduleBody(311).replace('DROP TABLE sample', 'DROP TABLE other')); }],
  ['registry unrelated entry', f => { f.evidence.finalFiles[3].sha = f.blob(f.registry(312).replace('r308', 'r307')); }],
  ['registry duplicate', f => { f.evidence.finalFiles[3].sha = f.blob(f.registry(312).replace('"r312",', '"r312",\n    "r312",')); }],
  ['missing module', f => { f.evidence.finalFiles.splice(2, 1); }],
]) test(`SQL-backed rebases still refuse ${name}`, async () => {
  const f = rebasedRenumberFixture();
  modify(f);
  const result = await prove(f);
  assert.equal(result.reason, 'primary-change-reverted');
  assert.ok(result.migrationRenumberDiagnostics.some(d => d.proven === false));
});

for (const field of ['primarySqlBlob', 'sqlBlob', 'moduleBlob', 'registryBlob', 'sqlDestination', 'moduleDestination']) {
  test(`SQL-backed proof remains bound to ${field}`, async () => {
    const f = rebasedRenumberFixture();
    assert.equal((await prove(f)).ok, true);
    f.evidence.migrationRenumberProofs[0][field] = 'f'.repeat(40);
    assert.equal(checkPrimaryChange(f.evidence, f.args.headSha).reason, 'primary-change-reverted');
  });
}

test('slow reader records a deadline through collector and predicate diagnostics', async () => {
  const f = migrationRenumberFixture(), get = f.args.get;
  const evidence = await fetchPrimaryChange({ ...f.args,
    get: path => path.includes('/git/blobs/') ? new Promise(() => {}) : get(path),
    signal: AbortSignal.timeout(25),
  }, { fetchCiCostImpl: async () => f.evidence.ciCost,
    proveDerivedArtifactsImpl: async () => [], proveGeneratedBlocksImpl: async () => [] });
  const result = checkPrimaryChange(evidence, f.args.headSha);
  assert.equal(result.reason, 'primary-change-reverted');
  assert.equal(result.migrationRenumberDiagnostics.at(-1).reason, 'deadline-exceeded');
  assert.doesNotMatch(result.missingEvidence.summary, /deadline-exceeded/);
  assert.equal(result.missingEvidence.migrationRenumberDiagnostics, undefined);
});

for (const [name, mutate] of [
  ['empty', f => { f.evidence.diagnosticCommitRange = []; }],
  ['too long', f => { f.evidence.diagnosticCommitRange = Array(65).fill({ sha: f.args.headSha }); }],
  ['wrong head', f => { f.evidence.diagnosticCommitRange = [{ sha: 'f'.repeat(40) }]; }],
  ['malformed entry', f => { f.evidence.diagnosticCommitRange = [{ sha: 'bad' }, { sha: f.args.headSha }]; }],
]) test(`invalid ${name} range records its reason before reads`, async () => {
  const f = migrationRenumberFixture();
  mutate(f);
  assert.deepEqual(await proveMigrationRenumbers(f.args, f.evidence), []);
  assert.equal(f.evidence.migrationRenumberDiagnostics[0].reason, 'range-invalid');
  assert.equal(f.calls.length, 0);
});

test('paired-module snapshots retain author bytes while their merge bases move', async () => {
  const f = alembicRenumberFixture({ steps: 3 }), get = f.args.get;
  f.args.get = async path => {
    const value = await get(path);
    return path.includes('/compare/') ? { ...value, merge_base_commit: { sha: 'f'.repeat(40) } } : value;
  };
  assert.equal((await prove(f)).ok, true);
});

test('missing snapshot merge base has a distinct recorded reason', async () => {
  const f = alembicRenumberFixture({ steps: 3 }), get = f.args.get;
  f.args.get = async path => {
    const value = await get(path);
    return path.includes('/compare/') ? { ...value, merge_base_commit: null } : value;
  };
  assert.equal((await prove(f)).reason, 'primary-change-reverted');
  assert.equal(f.evidence.migrationRenumberDiagnostics.at(-1).reason, 'snapshot-merge-base-invalid');
});

test('non-increasing ancestral history remains refused with a chain reason', async () => {
  const f = alembicRenumberFixture({ steps: 3 }), get = f.args.get;
  [f.evidence.diagnosticCommitRange[0], f.evidence.diagnosticCommitRange[1]] =
    [f.evidence.diagnosticCommitRange[1], f.evidence.diagnosticCommitRange[0]];
  f.args.get = path => path.endsWith(`${f.evidence.primaryHead}...${f.args.headSha}`)
    ? { status: 'ahead' } : get(path);
  assert.equal((await prove(f)).reason, 'primary-change-reverted');
  assert.equal(f.evidence.migrationRenumberDiagnostics.at(-1).reason, 'chain-non-increasing');
});

test('staged module introduction and filename reset retain all byte-verified observations after divergence', async () => {
  const f = rebasedRenumberFixture({ staged: true });
  const result = await prove(f);
  assert.equal(result.ok, true, JSON.stringify(f.evidence.migrationRenumberDiagnostics));
  const proof = result.derivedChanges[0];
  assert.equal(proof.rebased, true);
  assert.deepEqual(proof.chain.map(entry => Number(entry.path.match(/\/(\d+)_/)[1])), [309, 310, 311, 309, 312]);
  delete f.evidence.migrationRenumberAncestry;
  assert.equal(checkPrimaryChange(f.evidence, f.args.headSha).reason, 'primary-change-reverted');
});

test('an intermediate module body change at the author filename is still refused', async () => {
  const f = rebasedRenumberFixture({ staged: true });
  f.snapshots[3].files[2].sha = f.blob(f.moduleBody(312).replace('DROP TABLE sample', 'DROP TABLE other'));
  assert.equal((await prove(f)).reason, 'primary-change-reverted');
  assert.equal(f.evidence.migrationRenumberDiagnostics.at(-1).reason, 'snapshot-proof-missing');
});

test('immutable read budget exhaustion records its reason and never exceeds 512 reads', async () => {
  const f = rebasedRenumberFixture(), get = f.args.get;
  f.evidence.diagnosticCommitRange = [...Array.from({ length: 63 }, (_, i) => ({ sha: i.toString(16).padStart(40, '0') })),
    { sha: f.args.headSha }];
  let reads = 0;
  const wrapped = async path => {
    reads++;
    if (path.includes('/compare/')) return { files: f.evidence.finalFiles, filesComplete: true,
      merge_base_commit: { sha: f.evidence.baseSha } };
    const tree = /\/git\/trees\/([0-9a-f]{40})\?recursive=1$/.exec(path);
    if (tree) {
      const n = tree[1] === f.evidence.primaryHead ? 308 : 311;
      return { truncated: false, tree: Array.from({ length: 8 }, (_, i) => ({ type: 'blob',
        path: `sample/alembic/versions/${n}_2035010${i + 1}T120000Z_prior.py`,
        sha: f.blob(`revision = "prior_${n}"\n# ${tree[1]} ${i}\n`) })) };
    }
    return get(path);
  };
  wrapped.metadata = wrapped;
  f.args.get = wrapped;
  assert.equal((await prove(f)).reason, 'primary-change-reverted');
  assert.equal(f.evidence.migrationRenumberDiagnostics.at(-1).reason, 'read-budget-exhausted');
  assert.equal(reads, 512);
});

test('final declared revision must still match the final filename slot', async () => {
  const f = rebasedRenumberFixture();
  f.evidence.finalFiles[0].sha = f.blob(f.body(312).replace('create_sample_312', 'create_sample_309'));
  assert.equal((await prove(f)).reason, 'primary-change-reverted');
  assert.equal(f.evidence.migrationRenumberDiagnostics[0].reason, 'snapshot-body-mismatch');
});

test('SQL origin cannot waive an author-owned registry change', async () => {
  const f = rebasedRenumberFixture();
  f.evidence.primaryFiles.push(f.file(f.evidence.finalFiles[3].filename, f.registry(309), 'modified'));
  assert.equal((await prove(f)).reason, 'primary-change-reverted');
});

test('snapshot file truncation is recorded separately from a missing proof', async () => {
  const f = alembicRenumberFixture({ steps: 3 }), get = f.args.get;
  f.args.get = async path => {
    const value = await get(path);
    return path.includes('/compare/') ? { ...value, files: Array(300).fill({}), filesComplete: false } : value;
  };
  assert.equal((await prove(f)).reason, 'primary-change-reverted');
  assert.equal(f.evidence.migrationRenumberDiagnostics.at(-1).reason, 'snapshot-files-incomplete');
});

test('SQL origin cannot replace a protected author module', async () => {
  const f = rebasedRenumberFixture();
  f.evidence.primaryFiles.push(f.file('sample/src/sample/schema_revisions/r309.py', f.moduleBody(309)));
  assert.equal((await prove(f)).reason, 'primary-change-reverted');
});

for (const [name, sql, encode] of [
  ['escaped slash', '-- /\nCREATE TABLE sample (id int);\n', text => text.replace('/', '\\/')],
  ['surrogate escape pair', '-- 😀\nCREATE TABLE sample (id int);\n', text => text.replace('😀', '\\ud83d\\ude00')],
]) test(`SQL module refuses Python-incompatible JSON ${name}`, async () => {
  const f = rebasedRenumberFixture({ sql });
  f.evidence.finalFiles[2].sha = f.blob(encode(f.moduleBody(312)));
  assert.equal((await prove(f)).reason, 'primary-change-reverted');
});

test('SQL modules preserve shared Python/JSON escapes and literal Unicode', async () => {
  const f = rebasedRenumberFixture({ sql: '-- \\/ \\uD800 😀 \" \t\b\f\r\nCREATE TABLE sample (id int);\n' });
  assert.equal((await prove(f)).ok, true);
});

for (const original of [false, true]) test(`SQL-only snapshot after module introduction is refused (original=${original})`, async () => {
  const f = rebasedRenumberFixture();
  f.snapshots[1].files = original ? f.evidence.primaryFiles : f.snapshots[1].files.slice(0, 2);
  assert.equal((await prove(f)).reason, 'primary-change-reverted');
  assert.equal(f.evidence.migrationRenumberDiagnostics.at(-1).reason, 'snapshot-proof-missing');
});

test('no migration candidates means no timer, reads or proof diagnostics', async t => {
  const f = migrationRenumberFixture();
  f.evidence.primaryFiles = [];
  t.mock.method(globalThis, 'setTimeout', () => assert.fail('non-candidate must not size or start a timer'));
  assert.deepEqual(await proveMigrationRenumbers(f.args, f.evidence), []);
  assert.deepEqual(f.evidence.migrationRenumberDiagnostics, []);
  assert.equal(f.calls.length, 0);
});

test('migration proof failures cannot crowd region history out of refusal evidence', () => {
  const f = migrationRenumberFixture();
  f.evidence.finalFiles = [];
  const path = f.evidence.primaryFiles[0].filename;
  f.evidence.primaryPathChanges = [{ path, start: 1, end: 2,
    commits: [{ sha: 'e'.repeat(40), author: 'fixture-author', pipelineRepair: false }] }];
  const baseline = checkPrimaryChange(f.evidence, f.args.headSha);
  f.evidence.migrationRenumberDiagnostics = Array.from({ length: 128 }, () => ({
    proven: false, reason: 'snapshot-read-failed', headSha: f.args.headSha, detail: 'transient read failure'.repeat(12),
  }));
  const result = checkPrimaryChange(f.evidence, f.args.headSha);
  assert.equal(result.reason, 'primary-change-reverted');
  assert.deepEqual(result.missingEvidence, baseline.missingEvidence);
  assert.match(result.missingEvidence.summary, /region history:.*fixture-author/);
  assert.equal(result.migrationRenumberDiagnostics.length, 128);
});
