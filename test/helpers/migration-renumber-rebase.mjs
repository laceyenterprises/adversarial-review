import { createHash } from 'node:crypto';

// Synthetic SQL-backed author snapshot and three rewritten hammer histories.
export function rebasedRenumberFixture({ staged = false, sql = '-- Synthetic operation.\nCREATE TABLE sample (id int);\n' } = {}) {
  const hash = text => createHash('sha1').update(text).digest('hex');
  const objects = new Map(), trees = new Map(), calls = [];
  const blob = text => {
    const bytes = Buffer.from(text);
    const sha = hash(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
    objects.set(sha, { encoding: 'base64', content: bytes.toString('base64'), size: bytes.length });
    return sha;
  };
  const file = (filename, text, status = 'added') => ({ filename, status, sha: blob(text),
    additions: text.trimEnd().split('\n').length, deletions: 0,
    patch: `@@ -0,0 +1,${text.trimEnd().split('\n').length} @@\n${text.trimEnd().split('\n').map(line => '+' + line).join('\n')}` });
  const directory = 'sample/alembic/versions/';
  const moduleDirectory = 'sample/src/sample/schema_revisions/';
  const registryPath = `${moduleDirectory}__init__.py`;
  const timestamp = n => `203504${String(n - 308).padStart(2, '0')}T120000Z`;
  const name = n => `${timestamp(n)}_b7_create_sample.sql`;
  const wrapper = n => `${directory}${n}_${timestamp(n)}_b7_create_sample.py`;
  const sqlPath = n => `sample/src/sample/migrations/${name(n)}`;
  const body = n => `revision = "create_sample_${n}"\ndown_revision = "prior_${n - 1}"\nSOURCE_NAME = "${name(n)}"\n\ndef upgrade():\n    upgrade_revision(op, SOURCE_NAME)\n\ndef downgrade():\n    downgrade_revision(op, SOURCE_NAME)\n`;
  const moduleBody = n => `from ._types import PostgresMigration\n\nMIGRATION = PostgresMigration(\n    revision="create_sample_${n}",\n    down_revision="prior_${n - 1}",\n    source_name="${name(n)}",\n    raw_sql=${JSON.stringify(sql)},\n    downgrade_sql=(\n        "DROP TABLE sample",\n    ),\n)\n`;
  const registry = n => `_MODULE_NAMES = (\n${Array.from({ length: n - 307 }, (_, i) => `    "r${308 + i}",\n`).join('')})\n`;
  const tree = files => {
    const root = {};
    for (const f of files) {
      const parts = f.filename.split('/');
      let node = root;
      for (const part of parts.slice(0, -1)) node = node[part] ||= {};
      node[parts.at(-1)] = f.sha;
    }
    const store = node => {
      const entries = Object.entries(node).map(([path, value]) => ({ path,
        type: typeof value === 'string' ? 'blob' : 'tree', sha: typeof value === 'string' ? value : store(value) }));
      const sha = hash(JSON.stringify(entries));
      trees.set(sha, { truncated: false, tree: entries });
      return sha;
    };
    return store(root);
  };
  const predecessor = n => file(`${directory}${n - 1}_prior.py`, `revision = "prior_${n - 1}"\n`);
  const primaryFiles = [file(wrapper(309), body(309)), file(sqlPath(309), sql)];
  const primaryHead = tree([...primaryFiles, predecessor(309)]);
  const mergeBase = tree([file(registryPath, registry(308))]);
  const plan = staged ? [[310, 309, 309, false], [311, 311, 311, false], [311, 311, 311, false],
    [309, 312, 312, true], [312, 312, 312, true], [312, 312, 312, true]]
    : [310, 311, 312].map(n => [n, n, n, true]);
  const snapshots = plan.map(([number, revision, sourceNumber, hasModule], index) => {
    const ordinal = Math.max(number, revision);
    const base = tree([file(registryPath, registry(ordinal - 1)), predecessor(ordinal)]);
    const wrapperBody = body(ordinal).replace(`create_sample_${ordinal}`, `create_sample_${revision}`)
      .replace(name(ordinal), name(sourceNumber));
    const files = [file(wrapper(number), wrapperBody), file(sqlPath(sourceNumber), sql),
      ...(hasModule ? [file(`${moduleDirectory}r${ordinal}.py`, moduleBody(ordinal)),
        file(registryPath, registry(ordinal), 'modified')] : [])];
    const treeSha = tree([...files, predecessor(ordinal)]), sha = hash(`synthetic observation ${index}`);
    trees.set(sha, trees.get(treeSha));
    return { number, base, files, sha };
  });
  const headSha = snapshots.at(-1).sha, baseSha = snapshots.at(-1).base;
  const evidence = { headSha, primaryHead, mergeBase, baseSha, primaryFiles,
    finalFiles: snapshots.at(-1).files, hasHammerCommits: true, completeFileLists: true,
    ciCost: { headSha, ok: true }, diagnosticCommitRange: snapshots.map(({ sha }) => ({ sha })) };
  const get = async path => {
    calls.push(path);
    const object = /\/git\/(blobs|trees)\/([0-9a-f]{40})(\?recursive=1)?$/.exec(path);
    if (object) {
      if (object[3]) return { truncated: false, tree: Array.from({ length: 10001 }, () => ({ path: 'unrelated.txt', type: 'blob' })) };
      const value = (object[1] === 'blobs' ? objects : trees).get(object[2]);
      if (!value) throw new Error('Missing synthetic object');
      return value;
    }
    const comparison = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path);
    if (comparison) {
      const snapshot = snapshots.find(s => s.sha === comparison[2]);
      if (comparison[1] === primaryHead) return { status: 'diverged', ahead_by: 34, behind_by: 2 };
      if (snapshot) return { status: 'ahead', merge_base_commit: { sha: snapshot.base }, files: snapshot.files, filesComplete: true };
    }
    throw new Error(`Unexpected synthetic read: ${path}`);
  };
  get.metadata = get;
  return { evidence, args: { repo: 'fixture/repo', headSha, get }, snapshots, blob, calls, body, moduleBody, registry, sql, file };
}
