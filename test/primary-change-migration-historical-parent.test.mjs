import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { proveMigrationRenumbers } from '../src/ama/migration-renumber.mjs';
import { checkPrimaryChange } from '../src/ama/primary-change.mjs';

const repo = 'laceyenterprises/agent-os';
const ledger = 'platform/session-ledger';
const versions = `${ledger}/alembic/versions`;
const source = `${ledger}/src/session_ledger`;
const modules = `${source}/alembic_postgres_revisions`;
const registry = `${modules}/__init__.py`;
const rssMain = '283d06e47679a91f6802f729a418746608f1e180';
const rss = 'successful_rss_index_339';
const rssName = '20261119T130000Z_e5570001_successful_rss_index';
const operator = 'operator_completion_reason_341';
const operatorName = '20261120T120000Z_c09e0001_operator_completion_reason';
const indexName = '20261120T140000Z_4f3214e8_dag_slice_history_index';
const wrapper = (slot, name) => `${versions}/${slot}_${name}.py`;
const modulePath = slot => `${modules}/r${slot}.py`;
const sqlPath = name => `${source}/migrations/${name}.sql`;
const indexSql = 'CREATE INDEX sample_slice ON sample (id) WHERE settled IS TRUE;\n';
const indexRevision = slot => `dag_slice_history_index_${slot}`;

function migrationFiles(slot, name, revision, down, sql = indexSql) {
  return {
    [wrapper(slot, name)]: `"""Index migration."""\nrevision = "${revision}"\ndown_revision = "${down}"\nSOURCE_NAME = "${name}.sql"\n\ndef upgrade():\n    upgrade_revision(SOURCE_NAME)\n`,
    [modulePath(slot)]: `from ._types import PostgresMigration\n\nMIGRATION = PostgresMigration(\n    revision="${revision}",\n    down_revision="${down}",\n    source_name="${name}.sql",\n    raw_sql="""${sql}""",\n    downgrade_sql=("DROP INDEX sample_slice",),\n)\n`,
    [sqlPath(name)]: sql,
  };
}

function fixture() {
  const old = 'a'.repeat(40), author = 'b'.repeat(40), prior = 'c'.repeat(40),
    base = 'd'.repeat(40), head = 'e'.repeat(40);
  const objects = new Map();
  const hash = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
  const store = (kind, sha, data) => { objects.set(`git/${kind}/${sha}`, data); return sha; };
  const blob = text => {
    const bytes = Buffer.from(text);
    return store('blobs', hash('blob', bytes), { encoding: 'base64', size: bytes.length, content: bytes.toString('base64') });
  };
  const tree = files => {
    const entries = [];
    for (const name of [...new Set(Object.keys(files).map(path => path.split('/')[0]))].sort()) {
      entries.push(Object.hasOwn(files, name) ? { path: name, mode: '100644', type: 'blob', sha: blob(files[name]) }
        : { path: name, mode: '040000', type: 'tree', sha: tree(Object.fromEntries(Object.entries(files)
          .filter(([path]) => path.startsWith(`${name}/`)).map(([path, text]) => [path.slice(name.length + 1), text]))) });
    }
    const bytes = Buffer.concat(entries.map(({ path, mode, sha }) => Buffer.concat([
      Buffer.from(`${mode.replace(/^0+/, '')} ${path}\0`), Buffer.from(sha, 'hex'),
    ])));
    return store('trees', hash('tree', bytes), { truncated: false, tree: entries });
  };
  const oldFiles = { ...migrationFiles(339, 'dag_launch_payload_index', 'dag_launch_payload_index_339', 'prior_338'),
    ...migrationFiles(340, rssName, rss, 'dag_launch_payload_index_339'),
    [registry]: '_MODULE_NAMES = [\n    "r339",\n    "r340",\n]\n' };
  const add = (files, slot, added) => ({ ...files, ...added,
    [registry]: files[registry].replace('\n]\n', `\n    "r${slot}",\n]\n`) });
  const anchorFiles = { ...oldFiles };
  const authorFiles = add(oldFiles, 341, migrationFiles(341, indexName, indexRevision(341), rss));
  const baseFiles = add(oldFiles, 341, migrationFiles(341, operatorName, operator, rss));
  const headFiles = add(baseFiles, 342, migrationFiles(342, indexName, indexRevision(342), operator));
  const snapshots = new Map([[rssMain, anchorFiles], [old, oldFiles], [author, authorFiles],
    [prior, { ...authorFiles }], [base, baseFiles], [head, headFiles]]);
  const parents = new Map([[prior, [author]], [head, [prior, base]]]);
  const files = (current, paths) => paths.filter(path => Object.hasOwn(current, path)).map(filename => ({ filename,
    status: filename === registry ? 'modified' : 'added', sha: blob(current[filename]) }));
  const authorPaths = [wrapper(341, indexName), modulePath(341), sqlPath(indexName), registry];
  const finalPaths = [wrapper(342, indexName), modulePath(342), sqlPath(indexName), registry, wrapper(341, operatorName),
    modulePath(341), sqlPath(operatorName)];
  const evidence = { headSha: head, primaryHead: author, mergeBase: old, comparisonMergeBase: base, baseSha: base,
    baseRef: 'main', completeFileLists: true, hasHammerCommits: true, ciCost: { ok: true, headSha: head },
    diagnosticCommitRange: [{ sha: prior }, { sha: head }] };
  const compares = new Map([[`${rssMain}...${old}`, ['ahead', rssMain]], [`${old}...${base}`, ['ahead', old]],
    [`${base}...${base}`, ['identical', base]], [`${base}...${author}`, ['diverged', old]],
    [`${base}...${head}`, ['ahead', base]]]);
  const get = async path => {
    const local = path.slice(`repos/${repo}/`.length);
    if (local.startsWith('compare/')) {
      const [status, mergeBase] = compares.get(local.slice('compare/'.length));
      return { status, merge_base_commit: { sha: mergeBase } };
    }
    if (!objects.has(local)) throw new Error(`Uncaptured read ${path}`);
    return objects.get(local);
  };
  const args = { repo, headSha: head, get };
  const prove = async (edit = () => {}) => {
    for (const [sha, current] of snapshots) {
      store('commits', sha, { sha, tree: { sha: tree(current) }, parents: (parents.get(sha) || []).map(sha => ({ sha })) });
      store('trees', `${sha}?recursive=1`, { truncated: false, tree: Object.entries(current).map(([path, text]) =>
        ({ path, type: 'blob', sha: blob(text) })) });
    }
    evidence.primaryFiles = files(authorFiles, authorPaths);
    evidence.finalFiles = files(headFiles, finalPaths);
    edit(evidence, objects);
    evidence.migrationRenumberProofs = await proveMigrationRenumbers(args, evidence);
    return checkPrimaryChange(evidence, args.headSha);
  };
  return { args, evidence, prove, snapshots, parents, compares, oldFiles, authorFiles, baseFiles, headFiles, old, author, prior, base, head };
}

test('certifies a slot 341 → 342 snapshot with the historical RSS predecessor at slot 340', async () => {
  const f = fixture();
  const answer = await f.prove();
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const [proof] = answer.derivedChanges;
  assert.deepEqual(proof.chain.map(visit => visit.revisionNumber), [341, 342]);
  assert.equal(proof.mainIntegration.historicalParent.revision, rss);
  assert.equal(proof.mainIntegration.historicalParent.path, wrapper(340, rssName));
  assert.equal(proof.mainIntegration.parent.revision, operator);
  assert.equal(proof.primarySqlBlob, proof.sqlBlob);
  assert.equal(proof.primaryRegistryBlob, proof.mainIntegration.parent.registryBlob);
  assert.deepEqual(proof.mainIntegration.snapshots.map(({ integrated }) => integrated), [false, true]);
});

for (const [name, modify] of [
  ['a changed SQL predicate in both the SQL and helper', ({ headFiles }) => {
    headFiles[sqlPath(indexName)] = indexSql.replace('TRUE', 'FALSE');
    headFiles[modulePath(342)] = headFiles[modulePath(342)].replace('TRUE', 'FALSE');
  }],
  ['a changed helper SQL payload', ({ headFiles }) => {
    headFiles[modulePath(342)] = headFiles[modulePath(342)].replace('TRUE', 'FALSE');
  }],
  ['a changed downgrade operation', ({ headFiles }) => {
    headFiles[modulePath(342)] = headFiles[modulePath(342)].replace('DROP INDEX', 'DROP TABLE');
  }],
  ['a changed wrapper operation', ({ headFiles }) => {
    headFiles[wrapper(342, indexName)] = headFiles[wrapper(342, indexName)].replace('upgrade_revision(', 'other_operation(');
  }],
  ['an edited intermediate operation that is restored at the final head', f => {
    f.snapshots.get(f.prior)[modulePath(341)] += 'operation()\n';
  }],
  ['a forged RSS alias in slot 339', f => {
    for (const files of [f.oldFiles, f.authorFiles, f.snapshots.get(f.prior), f.baseFiles, f.headFiles]) {
      files[wrapper(339, rssName)] = files[wrapper(340, rssName)];
    }
  }],
  ['an altered historical helper retained in the old, author and final trees', f => {
    for (const files of [f.oldFiles, f.authorFiles, f.snapshots.get(f.prior), f.baseFiles, f.headFiles]) {
      files[modulePath(340)] += 'operation()\n';
    }
  }],
  ['a changed operator module in the final tree', ({ headFiles }) => {
    headFiles[modulePath(341)] += 'operation()\n';
  }],
  ['an operator helper that disagrees with the trusted SQL', ({ baseFiles, headFiles }) => {
    baseFiles[modulePath(341)] = headFiles[modulePath(341)] = baseFiles[modulePath(341)].replace('TRUE', 'FALSE');
  }],
  ['a down revision that skips slot 341', ({ headFiles }) => {
    headFiles[wrapper(342, indexName)] = headFiles[wrapper(342, indexName)].replace(operator, rss);
    headFiles[modulePath(342)] = headFiles[modulePath(342)].replace(operator, rss);
  }],
  ['an unsupported tuple down revision', ({ headFiles }) => {
    headFiles[wrapper(342, indexName)] = headFiles[wrapper(342, indexName)].replace(`"${operator}"`, `("${operator}", "other")`);
  }],
  ['a forged child revision alias', ({ headFiles }) => {
    headFiles[wrapper(342, indexName)] = headFiles[wrapper(342, indexName)].replace(indexRevision(342), '342');
    headFiles[modulePath(342)] = headFiles[modulePath(342)].replace(indexRevision(342), '342');
  }],
  ['a registry reorder', ({ headFiles }) => {
    headFiles[registry] = headFiles[registry].replace('"r341",\n    "r342",', '"r342",\n    "r341",');
  }],
  ['an extra registry entry', ({ headFiles }) => {
    headFiles[registry] = headFiles[registry].replace('"r342",', '"r342",\n    "r343",');
  }],
  ['an untrusted second parent', f => { f.parents.set(f.head, [f.prior, f.old]); }],
  ['a comparison base outside observed main', f => {
    f.evidence.baseSha = 'f'.repeat(40);
    f.compares.set(`${f.base}...${f.evidence.baseSha}`, ['diverged', f.old]);
  }],
  ['an incomplete first-parent range', f => { f.evidence.diagnosticCommitRange.shift(); }],
  ['a different requested head', f => { f.args.headSha = 'f'.repeat(40); }],
]) test(`historical predecessor proof refuses ${name}`, async () => {
  const f = fixture();
  modify(f);
  assert.equal((await f.prove()).ok, false);
  assert.deepEqual(f.evidence.migrationRenumberProofs, []);
});

for (const [name, edit] of [
  ['a short file list without completeness evidence', evidence => { evidence.completeFileLists = false; }],
  ['an omitted operator module', evidence => {
    evidence.finalFiles = evidence.finalFiles.filter(file => file.filename !== modulePath(341));
  }],
  ['an omitted child SQL file', evidence => {
    evidence.finalFiles = evidence.finalFiles.filter(file => file.filename !== sqlPath(indexName));
  }],
  ['a duplicate file entry', evidence => { evidence.primaryFiles.push({ ...evidence.primaryFiles[0] }); }],
  ['a compare SHA that differs from the tree', evidence => {
    evidence.finalFiles.find(file => file.filename === modulePath(342)).sha = evidence.primaryFiles[1].sha;
  }],
  ['a truncated immutable tree', (evidence, objects) => {
    const tree = objects.get(`git/commits/${evidence.headSha}`).tree.sha;
    objects.get(`git/trees/${tree}`).truncated = true;
  }],
  ['an omitted tree entry despite a completeness marker', (evidence, objects) => {
    const tree = objects.get(`git/commits/${evidence.headSha}`).tree.sha;
    objects.get(`git/trees/${tree}`).tree.pop();
  }],
  ['a blob whose bytes fail its object hash', (evidence, objects) => {
    const sha = evidence.finalFiles.find(file => file.filename === sqlPath(indexName)).sha;
    const data = objects.get(`git/blobs/${sha}`);
    data.content = Buffer.from('x'.repeat(data.size)).toString('base64');
  }],
]) test(`historical predecessor proof refuses ${name}`, async () => {
  const f = fixture();
  assert.equal((await f.prove(edit)).ok, false);
  assert.deepEqual(f.evidence.migrationRenumberProofs, []);
});

test('historical predecessor certificate requires the original proof and evidence objects at the same head', async () => {
  const f = fixture();
  assert.equal((await f.prove()).ok, true);
  const [proof] = f.evidence.migrationRenumberProofs;
  assert.equal(checkPrimaryChange({ ...f.evidence }, f.head).ok, false);
  assert.equal(checkPrimaryChange(f.evidence, f.prior).ok, false);
  f.evidence.migrationRenumberProofs = [structuredClone(proof)];
  assert.equal(checkPrimaryChange(f.evidence, f.head).ok, false);
  f.evidence.migrationRenumberProofs = [proof];
  proof.mainIntegration.historicalParent.revision = operator;
  assert.equal(checkPrimaryChange(f.evidence, f.head).ok, false);
  assert.equal(f.evidence.migrationRenumberDiagnostics.at(-1).reason, 'main-integration-certificate-unbound');
});
