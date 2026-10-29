import test from 'node:test';
import assert from 'node:assert/strict';
import { proveMigrationRenumbers, verifiedMigrationRenumbers } from '../src/ama/migration-renumber.mjs';
import { checkPrimaryChange } from '../src/ama/primary-change.mjs';
import { migration9692Fixture } from './helpers/migration-renumber-9692.mjs';

const wrapper = files => files.find(file => file.filename.includes('f3a01001') && file.filename.endsWith('.py'));
const sql = files => files.find(file => file.filename.includes('f3a01001') && file.filename.endsWith('.sql'));
const module = files => files.find(file => file.filename.endsWith('/r312.py'));
const registry = files => files.find(file => file.filename.endsWith('/alembic_postgres_revisions/__init__.py'));
const slot = entry => Number(entry.path.match(/\/(\d+)_/)[1]);
async function prove(f) {
  f.evidence.migrationRenumberProofs = await proveMigrationRenumbers(f.args, f.evidence);
  return verifiedMigrationRenumbers(f.evidence, f.args.headSha);
}

test('LAC-2127: actual immutable ancestral 309/310/311/309/312 history has independent snapshot and parent proofs', async () => {
  const f = migration9692Fixture();
  const ancestry = await f.args.get(`repos/${f.args.repo}/compare/${f.evidence.primaryHead}...${f.args.headSha}`);
  assert.equal(ancestry.status, 'ahead');
  assert.equal(ancestry.merge_base_commit.sha, f.evidence.primaryHead);
  assert.deepEqual(ancestry.commits.map(c => c.sha), f.evidence.diagnosticCommitRange.map(c => c.sha));
  assert.deepEqual(ancestry.commits.map(c => c.parents.map(p => p.sha)),
    [f.evidence.primaryHead, ...ancestry.commits.slice(0, -1).map(c => c.sha)].map(sha => [sha]));
  const [proof] = await prove(f);
  assert.ok(proof, JSON.stringify(f.evidence.migrationRenumberDiagnostics));
  assert.equal(proof.metadataRepair, true);
  assert.equal(proof.rebased, undefined);
  assert.deepEqual(proof.chain.map(slot), [309, 310, 311, 309, 312]);
  assert.deepEqual(proof.chain.map(c => c.revisionNumber), [309, 309, 311, 312, 312]);
  assert.equal(proof.parentOperations.length, 8);
  assert.ok(proof.parentOperations.every(parent => parent.operations.length === 2));
  assert.equal(checkPrimaryChange(f.evidence, f.args.headSha).ok, true);
  assert.ok(f.calls.length < 512);
});

test('same author filename with metadata-only repair before final increasing rename', async () => {
  const f = migration9692Fixture();
  for (const snapshot of f.snapshots.slice(0, 3)) {
    for (const select of [wrapper, sql]) {
      const file = select(snapshot.files), original = select(f.evidence.primaryFiles);
      f.replaceTreeFile(snapshot.sha, original.filename, original.sha, file.filename);
      Object.assign(file, structuredClone(original));
    }
  }
  const [proof] = await prove(f);
  assert.ok(proof, JSON.stringify(f.evidence.migrationRenumberDiagnostics));
  assert.deepEqual(proof.chain.map(slot), [309, 309, 312]);
  assert.deepEqual(proof.chain.map(c => c.revisionNumber), [309, 312, 312]);
});

for (const index of [0, 1, 2, 3, 4, 5, 6]) {
  for (const [name, select, change] of [
    ['wrapper operations', wrapper, s => s.replace('upgrade_revision(op,', 'other_operation(op,')],
    ['SQL operations', sql, s => s + '\nDROP TABLE unexpected;\n'],
    ...(index >= 3 ? [
      ['module downgrade', module, s => s.replace('DROP TABLE', 'DROP VIEW')],
      ['unrelated registry', registry, s => s.replace('"r308"', '"r307"')],
    ] : []),
  ]) test(`snapshot ${index + 1}: repaired final head cannot hide intermediate ${name}`, async () => {
    const f = migration9692Fixture(), file = select(f.snapshots[index].files);
    const original = f.text(file.sha), changed = change(original);
    assert.notEqual(changed, original);
    file.sha = f.blob(changed);
    assert.deepEqual(await prove(f), []);
    assert.ok(f.evidence.migrationRenumberDiagnostics.length);
  });
}

for (const [name, path] of [
  ['wrapper', 'platform/session-ledger/alembic/versions/311_20261028T210000Z_57d40007_steward_actions_tier_phase.py'],
  ['SQL', 'platform/session-ledger/src/session_ledger/migrations/20261028T210000Z_57d40007_steward_actions_tier_phase.sql'],
  ['module', 'platform/session-ledger/src/session_ledger/alembic_postgres_revisions/r311.py'],
]) test(`parent ${name} operation change cannot borrow a valid revision identifier`, async () => {
  const f = migration9692Fixture();
  const body = name === 'wrapper' ? 'revision = "steward_actions_tier_phase_311"\nSOURCE_NAME = "20261028T210000Z_57d40007_steward_actions_tier_phase.sql"\n\ndef upgrade():\n    dangerous_operation()\n'
    : 'dangerous_operation()\n';
  f.replaceTreeFile(f.snapshots[3].sha, path, f.blob(body));
  assert.deepEqual(await prove(f), []);
  assert.equal(f.evidence.migrationRenumberDiagnostics.at(-1).reason, 'repair-predecessor-unproven');
});

test('registry edit before module introduction is independently refused', async () => {
  const f = migration9692Fixture();
  f.replaceTreeFile(f.snapshots[0].sha, registry(f.evidence.finalFiles).filename, f.blob('_MODULE_NAMES = ()\n'));
  assert.deepEqual(await prove(f), []);
  assert.equal(f.evidence.migrationRenumberDiagnostics.at(-1).reason, 'repair-predecessor-unproven');
});

for (const [name, mutate] of [
  ['declared revision decrease', f => {
    const file = wrapper(f.snapshots[2].files);
    file.sha = f.blob(f.text(file.sha).replace('operator_directive_versions_311', 'operator_directive_versions_310'));
  }],
  ['filename reset without revision advance', f => {
    const file = wrapper(f.snapshots[2].files);
    file.sha = f.blob(f.text(file.sha).replace('operator_directive_versions_311', 'operator_directive_versions_312'));
  }],
  ['unexplained revision identity', f => {
    const file = wrapper(f.snapshots[3].files);
    file.sha = f.blob(f.text(file.sha).replace('operator_directive_versions_312', 'unrelated_312'));
  }],
  ['revision beyond final slot', f => {
    const file = wrapper(f.snapshots[3].files);
    file.sha = f.blob(f.text(file.sha).replace('operator_directive_versions_312', 'operator_directive_versions_313'));
  }],
  ['equal slot with a different filename', f => {
    const file = wrapper(f.snapshots[3].files);
    file.filename = file.filename.replace('/309_', '/311_');
  }],
  ['missing intermediate read', f => {
    delete f.responses[`repos/${f.args.repo}/compare/${f.evidence.baseSha}...${f.snapshots[2].sha}`];
  }],
  ['skipped intermediate snapshot', f => { f.evidence.diagnosticCommitRange.splice(2, 1); }],
  ['non-parent snapshot order', f => {
    const previous = f.evidence.primaryHead, next = f.snapshots[0].sha;
    f.responses[`repos/${f.args.repo}/compare/${previous}...${next}`].total_commits = 2;
  }],
  ['ancestry missing primary merge base', f => {
    delete f.responses[`repos/${f.args.repo}/compare/${f.evidence.primaryHead}...${f.args.headSha}`].merge_base_commit;
  }],
]) test(`ancestral metadata repair refuses ${name}`, async () => {
  const f = migration9692Fixture();
  mutate(f);
  assert.deepEqual(await prove(f), []);
});

for (const [name, mutate] of [
  ['repair flag', f => { delete f.evidence.migrationRenumberProofs[0].metadataRepair; }],
  ['ancestry', f => { delete f.evidence.migrationRenumberAncestry; }],
  ['ancestry head', f => { f.evidence.migrationRenumberAncestry.headSha = 'f'.repeat(40); }],
  ['revision decrease', f => { f.evidence.migrationRenumberProofs[0].chain[3].revisionNumber = 310; }],
  ['parent operation binding', f => { f.evidence.migrationRenumberProofs[0].parentOperations[4].operations = []; }],
  ['snapshot base', f => { f.evidence.migrationRenumberProofs[0].snapshotMergeBase = 'f'.repeat(40); }],
  ['null parent operation', f => { f.evidence.migrationRenumberProofs[0].parentOperations[4].operations[0] = null; }],
  ['parent snapshot completeness', f => { f.evidence.migrationRenumberProofs[0].parentOperations.splice(1, 1); }],
]) test(`consumer refuses damaged ${name}`, async () => {
  const f = migration9692Fixture();
  assert.equal((await prove(f)).length, 1);
  mutate(f);
  assert.deepEqual(verifiedMigrationRenumbers(f.evidence, f.args.headSha), []);
});

test('divergence never authorizes a real declared revision decrease', async () => {
  const f = migration9692Fixture();
  f.responses[`repos/${f.args.repo}/compare/${f.evidence.primaryHead}...${f.args.headSha}`].status = 'diverged';
  const file = wrapper(f.snapshots[2].files);
  file.sha = f.blob(f.text(file.sha).replace('operator_directive_versions_311', 'operator_directive_versions_310'));
  assert.deepEqual(await prove(f), []);
  assert.equal(f.evidence.migrationRenumberDiagnostics.at(-1).reason, 'chain-non-increasing');
});

test('ambiguous predecessor identity refuses the ancestral exception', async () => {
  const f = migration9692Fixture();
  for (const response of Object.values(f.responses)) {
    if (!response.tree) continue;
    const parent = response.tree.find(entry => entry.path === '311_20261028T210000Z_57d40007_steward_actions_tier_phase.py');
    if (parent) response.tree.push({ ...parent, path: '311_20350505T000000Z_steward_actions_tier_phase.py' });
  }
  assert.deepEqual(await prove(f), []);
  assert.equal(f.evidence.migrationRenumberDiagnostics.at(-1).reason, 'repair-predecessor-unproven');
});
