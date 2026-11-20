import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHistoryReader } from '../src/ama/history-reader.mjs';
import { proveMigrationRenumbers, verifiedMigrationRenumbers } from '../src/ama/migration-renumber.mjs';
import { checkPrimaryChange } from '../src/ama/primary-change.mjs';

const fixture = gunzipSync(readFileSync(new URL('./fixtures/migration-renumber-11143/history.json.gz', import.meta.url)));
const parent = 'platform/session-ledger/alembic/versions/340_20261119T130000Z_e5570001_successful_rss_index.py';
const ledger = 'platform/session-ledger/src/session_ledger';

function replay({ continued = false } = {}) {
  const { repo, evidence, responses, continuation } = JSON.parse(fixture);
  if (continued) {
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
  return { args, evidence, commit, calls, alterTree, alterBlob, prove, nativeReader, tree };
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

test('a copied proof, a changed binding, and a changed head each lose preservation authority', async () => {
  const f = replay();
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
  const finalSQL = f.evidence.finalFiles.find(entry => entry.filename === proof.sqlDestination);
  finalSQL.sha = proof.blob;
  assert.deepEqual(verifiedMigrationRenumbers(f.evidence, f.args.headSha), []);
  finalSQL.sha = proof.sqlBlob;
  proof.mainIntegration.parent.moduleBlob = proof.moduleBlob;
  assert.deepEqual(verifiedMigrationRenumbers(f.evidence, f.args.headSha), []);
});
