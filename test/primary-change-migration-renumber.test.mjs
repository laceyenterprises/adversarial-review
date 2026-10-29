import test from 'node:test';
import assert from 'node:assert/strict';
import { proveMigrationRenumbers } from '../src/ama/migration-renumber.mjs';
import { checkPrimaryChange, fetchPrimaryChange } from '../src/ama/primary-change.mjs';
import { evaluateMergeEligibility } from '../src/ama/merge-eligibility.mjs';
import { migrationRenumberFixture } from './helpers/migration-renumber.mjs';

async function prove(f) {
  f.evidence.migrationRenumberProofs = await proveMigrationRenumbers(f.args, f.evidence);
  return checkPrimaryChange(f.evidence, f.args.headSha);
}

test('MIGRENUMBERDERIVED-01: identifiers, revision tuple and registry renumber are derived and mergeable', async () => {
  const f = migrationRenumberFixture();
  assert.equal(checkPrimaryChange(f.evidence, f.args.headSha).reason, 'primary-change-reverted');
  const result = await prove(f);
  assert.equal(result.ok, true);
  assert.equal(result.derivedChanges[0].classification, 'mechanical-migration-renumber');
  assert.equal(result.derivedChanges[0].path, f.source);
  assert.equal(result.derivedChanges[0].destination, f.destination);
  assert.equal(result.derivedChanges[0].registryPath, f.registryPath);
  const eligibility = evaluateMergeEligibility({ primaryChange: f.evidence, candidateHead: f.args.headSha,
    validatedHead: f.args.headSha, verdict: 'settled-success', requiredChecks: true,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', leaseHeld: true, labels: [],
    branchProtectionRequired: true, requiredGateContext: 'agent-os/adversarial-gate',
    branchProtectionRequiredContexts: ['agent-os/adversarial-gate'] });
  assert.equal(eligibility.eligible, true);
  assert.deepEqual(eligibility.derivedChanges, result.derivedChanges);
});

test('shared production collector adds the proof outside history collection', async () => {
  const f = migrationRenumberFixture();
  const evidence = await fetchPrimaryChange(f.args, { fetchCiCostImpl: async () => f.evidence.ciCost,
    proveDerivedArtifactsImpl: async () => [], proveGeneratedBlocksImpl: async () => [] });
  assert.equal(checkPrimaryChange(evidence, f.args.headSha).ok, true);
  assert.equal(evidence.migrationRenumberProofs.length, 1);
});

for (const [name, modify] of [
  ['changed operation', f => { f.evidence.finalFiles[0].sha = f.blob(f.final.replace('create_table', 'drop_table')); }],
  ['deleted operation', f => { f.evidence.finalFiles[0].sha = f.blob(f.final.replace('    operations.create_table("sample")\n', '')); }],
  ['no registry update', f => { f.evidence.finalFiles[1] = { ...f.evidence.primaryFiles[1] }; }],
  ['missing registry', f => { f.evidence.finalFiles.pop(); }],
  ['unrelated registry edit', f => { f.evidence.finalFiles[1].sha = f.blob(f.registry(43).replace('"sibling"', '"different"')); }],
  ['wrong registry number', f => { f.evidence.finalFiles[1].sha = f.blob(f.registry(44)); }],
  ['commented registry row', f => { f.evidence.finalFiles[1].sha = f.blob(f.registry(43).replace('    (43', '    # (43')); }],
  ['registry row inside SQL string', f => { f.evidence.finalFiles[1].sha = f.blob(`SQL = """\n${f.registry(43)}"""\n`); }],
  ['tuple passed to an operation', f => {
    f.evidence.primaryFiles[1].sha = f.blob('operations.apply((42, "042_create_sample"))\n');
    f.evidence.finalFiles[1].sha = f.blob('operations.apply((43, "043_create_sample"))\n');
  }],
  ['wrong migration identifier', f => { f.evidence.finalFiles[0].sha = f.blob(f.final.replace('revision = "043', 'revision = "044')); }],
  ['wrong predecessor', f => { f.evidence.finalFiles[0].sha = f.blob(f.final.replace('down_revision = "042', 'down_revision = "040')); }],
  ['cross-directory rename', f => { f.evidence.finalFiles[0].filename = 'other/migrations/043_create_sample.py'; }],
  ['different migration name', f => { f.evidence.finalFiles[0].filename = 'app/migrations/043_other.py'; }],
  ['source still present', f => { f.evidence.finalFiles.push(f.evidence.primaryFiles[0]); }],
  ['ambiguous destination', f => { f.evidence.finalFiles.push({ ...f.evidence.finalFiles[0], filename: 'app/migrations/044_create_sample.py' }); }],
  ['unmatched rename metadata', f => { Object.assign(f.evidence.finalFiles[0], { status: 'renamed', previous_filename: 'unrelated.py' }); }],
  ['removed destination', f => { f.evidence.finalFiles[0].status = 'removed'; }],
  ['absent blob', f => { f.evidence.finalFiles[0].sha = 'd'.repeat(40); }],
]) test(`${name} supplies no renumber proof`, async () => {
  const f = migrationRenumberFixture();
  modify(f);
  const result = await prove(f);
  assert.equal(f.evidence.migrationRenumberProofs.length, 0);
  // Some mutations keep the original source; verify the refusal only when
  // the original migration is actually absent from the final comparison.
  if (name !== 'source still present') assert.equal(result.reason, 'primary-change-reverted');
});

test('metadata-looking SQL operation edits are never normalized as identifiers', async () => {
  const original = migrationRenumberFixture();
  const f = migrationRenumberFixture({
    beforeBody: original.original + '\nSQL = """\nrevision = 42\ndown_revision = 41\n"""\n',
    afterBody: original.final + '\nSQL = """\nrevision = 43\ndown_revision = 42\n"""\n',
  });
  assert.equal((await prove(f)).reason, 'primary-change-reverted');
});

test('numeric scalar revisions and versions directory use the same proof', async () => {
  const f = migrationRenumberFixture();
  for (const [files, revision, predecessor] of [[f.evidence.primaryFiles, 42, 41], [f.evidence.finalFiles, 43, 42]]) {
    files[0].filename = files[0].filename.replace('/migrations/', '/migrations/versions/');
    files[0].sha = f.blob(`revision: int = ${revision}\ndown_revision: int = ${predecessor}\n\ndef upgrade():\n    operations.create_table("sample")\n`);
  }
  assert.equal((await prove(f)).ok, true);
});

for (const key of ['headSha', 'primaryHead', 'mergeBase', 'primaryBlob', 'blob', 'primaryRegistryBlob', 'registryBlob']) {
  test(`stale ${key} proof cannot waive the refusal`, async () => {
    const f = migrationRenumberFixture();
    await prove(f);
    f.evidence.migrationRenumberProofs[0][key] = 'f'.repeat(40);
    assert.equal(checkPrimaryChange(f.evidence, f.args.headSha).reason, 'primary-change-reverted');
  });
}

test('unrelated author reversal is still protected alongside a valid renumber', async () => {
  const f = migrationRenumberFixture();
  f.evidence.primaryFiles.push({ filename: 'app/settings.py', status: 'modified', additions: 1, deletions: 1,
    patch: '@@ -1 +1 @@\n-enabled = False\n+enabled = True' });
  assert.equal((await prove(f)).reason, 'primary-change-reverted');
});

test('registry deletion invalidates an earlier renumber proof', async () => {
  const f = migrationRenumberFixture();
  await prove(f);
  f.evidence.finalFiles[1].status = 'removed';
  assert.equal(checkPrimaryChange(f.evidence, f.args.headSha).reason, 'primary-change-reverted');
});

test('capped file evidence and corrupt hash responses supply no renumber authority', async () => {
  const f = migrationRenumberFixture();
  f.evidence.completeFileLists = false;
  f.evidence.finalFiles.push(...Array.from({ length: 300 }, () => ({ filename: 'other.py', status: 'added' })));
  assert.deepEqual(await proveMigrationRenumbers(f.args, f.evidence), []);
  const valid = migrationRenumberFixture();
  valid.args.get = async () => ({ encoding: 'base64', content: Buffer.from('corrupt').toString('base64'), size: 7 });
  assert.deepEqual(await proveMigrationRenumbers(valid.args, valid.evidence), []);
});
