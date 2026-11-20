import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHistoryReader } from '../src/ama/history-reader.mjs';
import { proveMigrationRenumbers, verifiedMigrationRenumbers } from '../src/ama/migration-renumber.mjs';
import { checkPrimaryChange } from '../src/ama/primary-change.mjs';

const fixture = name => gunzipSync(readFileSync(new URL(`./fixtures/migration-renumber-11143/${name}.json.gz`, import.meta.url)));
const initial = fixture('history');
const subsequent = fixture('subsequent-main');
const parent = 'platform/session-ledger/alembic/versions/340_20261119T130000Z_e5570001_successful_rss_index.py';
const ledger = 'platform/session-ledger/src/session_ledger';

function replay({ continued = false, subsequentMain = false } = {}) {
  const { repo, evidence, responses, continuation } = JSON.parse(initial);
  if (continued || subsequentMain) {
    if (subsequentMain) {
      const later = JSON.parse(subsequent);
      continuation.push(...later.continuation);
      evidence.baseSha = evidence.comparisonMergeBase = later.base;
      Object.assign(responses, later.responses);
    }
    evidence.headSha = continuation.at(-1);
    evidence.diagnosticCommitRange.push(...continuation.map(sha => ({ sha })));
  }
  const prefix = `repos/${repo}/`;
  const calls = [];
  const get = async path => {
    calls.push(path);
    const value = responses[path];
    if (!value) throw new Error(`Uncaptured immutable read ${path}`);
    if (typeof value.text === 'string') {
      const data = Buffer.from(value.text);
      return { encoding: 'base64', size: data.length, content: data.toString('base64') };
    }
    if (value.oversizedTreeEntryCount) return { truncated: value.truncated, tree: Array(value.oversizedTreeEntryCount) };
    return value;
  };
  const commit = head => responses[`${prefix}git/commits/${head}`];
  const setCommit = (sha, tree, parents) => {
    responses[`${prefix}git/commits/${sha}`] = { sha, tree: { sha: tree }, parents: parents.map(sha => ({ sha })) };
  };
  const setComparison = (base, head, status, mergeBase = base) => {
    responses[`${prefix}compare/${base}...${head}`] = { status, merge_base_commit: { sha: mergeBase } };
  };
  const tree = ref => responses[`${prefix}git/trees/${ref}`].tree;
  const alterTree = (head, path, edit) => {
    const parts = path.split('/');
    const copy = (sha, index) => {
      const entries = structuredClone(tree(sha));
      const name = parts[index];
      if (index === parts.length - 1) edit(entries, name);
      else {
        const entry = entries.find(item => item.path === name);
        entry.sha = copy(entry.sha, index + 1);
      }
      const body = Buffer.concat(entries.sort((a, b) => Buffer.compare(
        Buffer.from(a.path + (a.type === 'tree' ? '/' : '')),
        Buffer.from(b.path + (b.type === 'tree' ? '/' : '')),
      )).map(entry => Buffer.concat([
        Buffer.from(`${entry.mode.replace(/^0+/, '')} ${entry.path}\0`), Buffer.from(entry.sha, 'hex'),
      ])));
      const changed = createHash('sha1').update(`tree ${body.length}\0`).update(body).digest('hex');
      responses[`${prefix}git/trees/${changed}`] = { truncated: false, tree: entries };
      return changed;
    };
    const root = copy(commit(head).tree.sha, 0);
    commit(head).tree.sha = root;
    responses[`${prefix}git/trees/${head}`] = responses[`${prefix}git/trees/${root}`];
  };
  const alterBlob = (head, path, transform) => alterTree(head, path, (entries, name) => {
    const entry = entries.find(item => item.path === name);
    const old = responses[`${prefix}git/blobs/${entry.sha}`].text;
    const text = transform(old), data = Buffer.from(text);
    assert.notEqual(text, old);
    entry.sha = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
    responses[`${prefix}git/blobs/${entry.sha}`] = { text };
    if (head === evidence.headSha) {
      const file = evidence.finalFiles.find(item => item.filename === path);
      if (file) file.sha = entry.sha;
    }
  });
  const args = { repo, headSha: evidence.headSha, get };
  const prove = async () => {
    evidence.migrationRenumberProofs = await proveMigrationRenumbers(args, evidence);
    return verifiedMigrationRenumbers(evidence, args.headSha);
  };
  const nativeReader = () => createHistoryReader({
    execGhWithRetryImpl: async ({ args: argv }) => ({ stdout: JSON.stringify(await get(argv[1])) }),
  });
  return { args, evidence, commit, calls, alterTree, alterBlob, prove, nativeReader, tree, setCommit, setComparison };
}

test('certifies the immutable 11143 two-parent integration and consumes its exact preservation paths', async () => {
  const f = replay();
  assert.equal(checkPrimaryChange(f.evidence, f.args.headSha).reason, 'primary-change-reverted');
  assert.deepEqual(f.commit(f.args.headSha).parents.map(p => p.sha), [
    '72250e9cd3026fe33f56626786743bbff6e3900c', '283d06e47679a91f6802f729a418746608f1e180',
  ]);
  f.args.get = f.nativeReader();
  const [proof] = await f.prove();
  assert.ok(proof, JSON.stringify(f.evidence.migrationRenumberDiagnostics));
  assert.deepEqual(proof.chain.map(entry => entry.revisionNumber), [340, 341]);
  assert.deepEqual(proof.mainIntegration.snapshots.map(entry => entry.integrated), [false, false, false, true]);
  assert.equal(proof.mainIntegration.parent.revision, 'successful_rss_index_339');
  assert.equal(proof.mainIntegration.parent.blob, '1ad28b4f4a86c4ebf31793cea306685648ef4cff');
  assert.equal(proof.mainIntegration.parent.moduleBlob, 'ae006bef5e4b6c270749ecea15f4fd87defabdd6');
  assert.equal(proof.primarySqlBlob, '41d730aa7930408ac743273a122d41556e0211c5');
  assert.equal(proof.sqlBlob, proof.primarySqlBlob);
  const answer = checkPrimaryChange(f.evidence, f.args.headSha);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.derivedChanges, [proof]);
  assert.ok(f.calls.length < 100, `read ${f.calls.length} objects`);
});

test('certifies the same migration at the two actual first-parent continuation snapshots', async () => {
  const f = replay({ continued: true });
  const [proof] = await f.prove();
  assert.ok(proof, JSON.stringify(f.evidence.migrationRenumberDiagnostics));
  assert.deepEqual(proof.mainIntegration.snapshots.map(entry => entry.integrated), [false, false, false, true, true, true]);
  assert.equal(proof.headSha, '375e755c091bdccc06f404b1fe43838386891499');
});

test('certifies the actual second main integration at the full Agent OS #11143 head', async () => {
  const f = replay({ subsequentMain: true });
  const initialReplay = replay();
  const [initialProof] = await initialReplay.prove();
  assert.equal(checkPrimaryChange(f.evidence, f.args.headSha).reason, 'primary-change-reverted');
  f.args.get = f.nativeReader();
  assert.equal(f.args.headSha, '45f25a244b3e99e84bcd7c03498dc9f06850bd4a');
  const [source, main] = f.commit(f.args.headSha).parents.map(p => p.sha);
  assert.equal(source, '72a4f711531785e5a75c31b43ff7de26317cdaf7');
  assert.equal(main, '8adcc49518a67a49b170f325b0230262a3095693');
  const compare = await f.args.get.metadata(`repos/${f.args.repo}/compare/${main}...${f.args.headSha}`);
  assert.equal(compare.merge_base_commit.sha, main);

  const [proof] = await f.prove();
  assert.ok(proof, JSON.stringify(f.evidence.migrationRenumberDiagnostics));
  assert.deepEqual(proof.mainIntegration.parent, initialProof.mainIntegration.parent);
  assert.deepEqual(proof.mainIntegration.additionalMainParents, [{
    sha: main, tree: f.commit(main).tree.sha, parents: f.commit(main).parents.map(p => p.sha),
  }]);
  assert.equal(proof.mainIntegration.comparisonMergeBase, main);
  assert.deepEqual(proof.mainIntegration.snapshots.map(entry => entry.sha), f.evidence.diagnosticCommitRange.map(entry => entry.sha));
  assert.deepEqual(proof.mainIntegration.snapshots.at(-1).parents, [source, main]);
  assert.deepEqual(proof.chain.map(entry => entry.revisionNumber), [340, 341]);
  assert.equal(proof.sqlBlob, initialProof.sqlBlob);
  const answer = checkPrimaryChange(f.evidence, f.args.headSha);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.derivedChanges, [proof]);
  assert.ok(f.calls.length < 100, `read ${f.calls.length} objects`);
});

const advancedBase = 'f'.repeat(40);
const rssMain = '283d06e47679a91f6802f729a418746608f1e180';
for (const comparisonMergeBase of [rssMain, advancedBase]) {
  test(`a non-RSS first integration reaches snapshot proof with comparison base ${comparisonMergeBase}`, async () => {
    const f = replay();
    f.commit(f.args.headSha).parents[1].sha = advancedBase;
    f.evidence.comparisonMergeBase = comparisonMergeBase;
    assert.deepEqual(await f.prove(), []);
    // The historical RSS declaration/slot mismatch still prevents a general
    // certificate, but the ordinary proof must run and explain its own refusal.
    assert.ok(f.calls.includes(`repos/${f.args.repo}/git/trees/${f.evidence.primaryHead}?recursive=1`));
    const reasons = f.evidence.migrationRenumberDiagnostics.map(entry => entry.reason);
    assert.ok(reasons.includes('snapshot-body-mismatch'), JSON.stringify(reasons));
    assert.equal(reasons.at(-1), 'final-snapshot-unproven');
    assert.ok(!reasons.includes('main-integration-unproven'));
  });
}

function advanceObservedBase(f, status, mergeBase) {
  f.setComparison(rssMain, advancedBase, 'ahead');
  f.setComparison(f.evidence.comparisonMergeBase, advancedBase, status, mergeBase);
  f.evidence.baseSha = advancedBase;
}

test('accepts an unchanged migration parent independently proved in the ancestry of a newer observed main', async () => {
  const f = replay({ subsequentMain: true });
  advanceObservedBase(f, 'ahead');
  const [proof] = await f.prove();
  assert.ok(proof, JSON.stringify(f.evidence.migrationRenumberDiagnostics));
  assert.equal(proof.mainIntegration.observedBase, advancedBase);
  assert.notEqual(proof.mainIntegration.comparisonMergeBase, advancedBase);
});

test('proves every later main parent in order and refuses a changed earlier parent even if the last is unchanged', async () => {
  const f = replay({ subsequentMain: true });
  const { headSha, baseSha } = f.evidence;
  const thirdMerge = 'e'.repeat(40);
  f.setCommit(advancedBase, f.commit(baseSha).tree.sha, [baseSha]);
  f.setCommit(thirdMerge, f.commit(headSha).tree.sha, [headSha, advancedBase]);
  advanceObservedBase(f, 'ahead');
  f.setComparison(advancedBase, advancedBase, 'identical');
  f.evidence.comparisonMergeBase = advancedBase;
  f.args.headSha = f.evidence.headSha = thirdMerge;
  f.evidence.diagnosticCommitRange.push({ sha: thirdMerge });

  const [proof] = await f.prove();
  assert.ok(proof, JSON.stringify(f.evidence.migrationRenumberDiagnostics));
  assert.deepEqual(proof.mainIntegration.additionalMainParents.map(commit => commit.sha), [baseSha, advancedBase]);
  f.alterBlob(baseSha, `${ledger}/alembic_postgres_revisions/r340.py`,
    text => text.replace('concurrent_index_only=True', 'concurrent_index_only=False'));
  assert.deepEqual(await f.prove(), []);
  assert.equal(checkPrimaryChange(f.evidence, thirdMerge).reason, 'primary-change-reverted');
});

for (const [label, edit] of [
  ['an unchanged migration parent outside trusted main ancestry', f => advanceObservedBase(f, 'diverged', rssMain)],
  ['an ahead comparison with the wrong merge base', f => advanceObservedBase(f, 'ahead', rssMain)],
  ['an observed comparison base different from the last second parent', f => { f.evidence.comparisonMergeBase = rssMain; }],
  ['an unchanged but stale main parent', f => { f.commit(f.args.headSha).parents[1].sha = rssMain; }],
  ['an octopus merge', f => { f.commit(f.args.headSha).parents.push({ sha: rssMain }); }],
  ['out-of-order first-parent history', f => {
    const range = f.evidence.diagnosticCommitRange;
    [range[6], range[7]] = [range[7], range[6]];
  }],
  ['an unreadable later main parent', f => { f.commit(f.evidence.baseSha).tree = null; }],
  ['a changed later main migration tree with an unchanged candidate tree', f => {
    f.alterTree(f.evidence.baseSha, parent, (entries, name) => entries.push({
      ...entries.find(entry => entry.path === name), path: '900_extra.py',
    }));
  }],
  ['an intermediate child operation restored by the second merge', f => {
    const source = f.commit(f.args.headSha).parents[0].sha;
    f.alterBlob(source, `${ledger}/alembic_postgres_revisions/r341.py`, text => text.replace('CREATE TABLE', 'CREATE VIEW'));
  }],
]) test(`refuses ${label} after the certified RSS integration`, async () => {
  const f = replay({ subsequentMain: true });
  edit(f);
  assert.deepEqual(await f.prove(), []);
  assert.equal(checkPrimaryChange(f.evidence, f.args.headSha).reason, 'primary-change-reverted');
});

for (const [label, path, transform] of [
  ['parent wrapper', parent, text => text.replace('op.execute', 'op.other')],
  ['parent SQL', `${ledger}/migrations/20261119T130000Z_e5570001_successful_rss_index.sql`, text => `${text}\nDROP TABLE unexpected;\n`],
  ['parent helper', `${ledger}/alembic_postgres_revisions/r340.py`, text => text.replace('concurrent_index_only=True', 'concurrent_index_only=False')],
  ['child wrapper', parent.replace('340_20261119T130000Z_e5570001_successful_rss_index', '341_20261119T130001Z_1d007001_dirty_queue'),
    text => text.replace('downgrade_revision(op,', 'other_operation(op,')],
  ['child SQL', `${ledger}/migrations/20261119T130001Z_1d007001_dirty_queue.sql`, text => `${text}\nDROP TABLE unexpected;\n`],
  ['child helper', `${ledger}/alembic_postgres_revisions/r341.py`, text => text.replace('CREATE TABLE', 'CREATE VIEW')],
  ['registry', `${ledger}/alembic_postgres_revisions/__init__.py`, text => text.replace('"r340",', '"r338",')],
]) test(`refuses changed ${label} even when the final file list agrees with its tree`, async () => {
  const f = replay();
  f.alterBlob(f.args.headSha, path, transform);
  assert.deepEqual(await f.prove(), []);
  assert.equal(checkPrimaryChange(f.evidence, f.args.headSha).ok, false);
});

for (const [label, change] of [
  ['missing parent', (entries, name) => entries.splice(entries.findIndex(item => item.path === name), 1)],
  ['arbitrarily named duplicate parent', (entries, name) => entries.push({
    ...entries.find(item => item.path === name), path: '107_unrelated_name.py',
  })],
]) test(`refuses a final tree with ${label}`, async () => {
  const f = replay();
  f.alterTree(f.args.headSha, parent, change);
  assert.deepEqual(await f.prove(), []);
});

for (const [label, edit] of [
  ['wrong repo', f => { f.args.repo = 'other/agent-os'; }],
  ['wrong requested head', f => { f.args.headSha = f.evidence.primaryHead; }],
  ['wrong merge parent', f => { f.commit(f.args.headSha).parents[1].sha = f.evidence.mergeBase; }],
  ['missing merge parent', f => { f.commit(f.args.headSha).parents.pop(); }],
  ['skipped history', f => { f.evidence.diagnosticCommitRange.splice(1, 1); }],
  ['history read failure', f => { f.evidence.historyReadFailed = true; }],
  ['unreadable intermediate commit', f => { f.commit(f.evidence.diagnosticCommitRange[1].sha).tree = null; }],
  ['an incomplete tree marked complete', f => { f.tree(f.commit(f.args.headSha).tree.sha).pop(); }],
  ['intermediate module operation restored at final', f => {
    f.alterBlob(f.evidence.diagnosticCommitRange[1].sha, `${ledger}/alembic_postgres_revisions/r340.py`,
      text => text.replace('CREATE TABLE', 'CREATE VIEW'));
  }],
  ['actual removal of the child migration', f => {
    f.evidence.finalFiles.find(file => file.filename.endsWith('_dirty_queue.py')).status = 'removed';
  }],
  ['wrong final pathname', f => {
    f.evidence.finalFiles.find(file => file.filename.endsWith('_dirty_queue.py')).filename =
      'different/alembic/versions/341_20261119T130001Z_1d007001_dirty_queue.py';
  }],
]) test(`refuses ${label}`, async () => {
  const f = replay();
  edit(f);
  assert.deepEqual(await f.prove(), []);
});

for (const [reason, edit] of [
  ['main-integration-ancestry-invalid', f => { f.commit(f.args.headSha).tree = null; }],
  ['main-integration-source-name-mismatch', f => {
    const path = f.evidence.finalFiles.find(file => file.filename.endsWith('_dirty_queue.py')).filename;
    f.alterBlob(f.args.headSha, path, text => text.replace(/SOURCE_NAME = "[^"]+"/, 'SOURCE_NAME = "wrong.sql"'));
  }],
  ['main-integration-blob-missing', f => {
    f.alterTree(f.args.headSha, `${ledger}/migrations/20261119T130001Z_1d007001_dirty_queue.sql`,
      (entries, name) => entries.splice(entries.findIndex(entry => entry.path === name), 1));
  }],
  ['main-integration-directory-missing', f => {
    f.alterTree(f.args.headSha, `${ledger}/migrations`,
      (entries, name) => entries.splice(entries.findIndex(entry => entry.path === name), 1));
  }],
]) test(`classifies structural refusal as ${reason}`, async () => {
  const f = replay();
  edit(f);
  assert.deepEqual(await f.prove(), []);
  const answer = checkPrimaryChange(f.evidence, f.args.headSha);
  assert.equal(answer.reason, 'primary-change-reverted');
  assert.ok(answer.migrationRenumberDiagnostics.some(entry => entry.reason === reason), JSON.stringify(answer));
  assert.ok(!answer.migrationRenumberDiagnostics.some(entry => entry.reason === 'snapshot-read-failed'));
});

test('a transport failure retains the read-failure diagnostic', async () => {
  const f = replay(), get = f.args.get;
  f.args.get = path => {
    if (path.includes('/git/commits/')) throw new Error('fixture transport unavailable');
    return get(path);
  };
  assert.deepEqual(await f.prove(), []);
  assert.equal(f.evidence.migrationRenumberDiagnostics.at(-1).reason, 'snapshot-read-failed');
});

for (const [label, clone] of [
  ['spread evidence', evidence => ({ ...evidence })],
  ['round-tripped evidence', evidence => JSON.parse(JSON.stringify(evidence))],
  ['cloned proof', evidence => ({ ...evidence, migrationRenumberProofs: structuredClone(evidence.migrationRenumberProofs) })],
]) test(`${label} exposes its unbound certificate in the native refusal`, async () => {
  const f = replay({ subsequentMain: true });
  const [proof] = await f.prove();
  assert.ok(proof);
  const evidence = clone(f.evidence);
  delete evidence.migrationRenumberDiagnostics;
  const answer = checkPrimaryChange(evidence, f.args.headSha);
  assert.equal(answer.reason, 'primary-change-reverted');
  assert.deepEqual(answer.migrationRenumberDiagnostics, [{
    proven: false, reason: 'main-integration-certificate-unbound', headSha: f.args.headSha, path: proof.path,
  }]);
  assert.ok(!('migrationRenumberDiagnostics' in answer.missingEvidence));
  for (let i = 0; i < 130; i++) verifiedMigrationRenumbers(evidence, f.args.headSha);
  assert.equal(evidence.migrationRenumberDiagnostics.length, 128);
  assert.equal(checkPrimaryChange(f.evidence, f.args.headSha).ok, true);
});

test('a copied proof, a changed binding, and a changed head each lose preservation authority', async () => {
  const f = replay({ subsequentMain: true });
  const [proof] = await f.prove();
  assert.ok(proof, JSON.stringify(f.evidence.migrationRenumberDiagnostics));
  assert.deepEqual(verifiedMigrationRenumbers(f.evidence, f.evidence.primaryHead), []);
  assert.deepEqual(verifiedMigrationRenumbers(structuredClone(f.evidence), f.args.headSha), []);
  f.evidence.migrationRenumberProofs = [structuredClone(proof)];
  assert.deepEqual(verifiedMigrationRenumbers(f.evidence, f.args.headSha), []);
  f.evidence.migrationRenumberProofs = [proof];
  f.evidence.repository = 'other/agent-os';
  assert.deepEqual(verifiedMigrationRenumbers(f.evidence, f.args.headSha), []);
  delete f.evidence.repository;
  f.evidence.comparisonMergeBase = rssMain;
  assert.deepEqual(verifiedMigrationRenumbers(f.evidence, f.args.headSha), []);
  f.evidence.comparisonMergeBase = proof.mainIntegration.comparisonMergeBase;
  const finalSQL = f.evidence.finalFiles.find(entry => entry.filename === proof.sqlDestination);
  finalSQL.sha = proof.blob;
  assert.deepEqual(verifiedMigrationRenumbers(f.evidence, f.args.headSha), []);
  finalSQL.sha = proof.sqlBlob;
  proof.mainIntegration.parent.moduleBlob = proof.moduleBlob;
  assert.deepEqual(verifiedMigrationRenumbers(f.evidence, f.args.headSha), []);
});
