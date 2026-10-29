import { createHash } from 'node:crypto';

export function migrationRenumberFixture(options = {}) {
  const headSha = 'c'.repeat(40), primaryHead = 'a'.repeat(40), mergeBase = 'b'.repeat(40);
  const source = 'app/migrations/042_create_sample.py';
  const destination = options.destination || 'app/migrations/043_create_sample.py';
  const registryPath = 'app/migrations/__init__.py';
  const body = (revision, predecessor) => `"""Create sample.\nRevision ID: ${revision}_create_sample\nRevises: ${predecessor}_prior\n"""\nfrom sample import operations\n\nrevision = "${revision}_create_sample"\ndown_revision = "${predecessor}_prior"\nREVISION = (${Number(revision)}, "create_sample")\n\ndef upgrade():\n    operations.create_table("sample")\n\ndef downgrade():\n    operations.drop_table("sample")\n`;
  const registryBase = 'REVISIONS = [\n    (41, "prior"),\n    (42, "sibling"),\n';
  const registry = revision => `${registryBase}    (${revision}, "${String(revision).padStart(3, '0')}_create_sample"),\n]\n`;
  const blobs = new Map();
  const blob = text => {
    const bytes = Buffer.from(text);
    const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    blobs.set(sha, { encoding: 'base64', content: bytes.toString('base64'), size: bytes.length });
    return sha;
  };
  const added = (filename, text) => ({ filename, status: 'added', sha: blob(text),
    additions: text.trimEnd().split('\n').length, deletions: 0,
    patch: `@@ -0,0 +1,${text.trimEnd().split('\n').length} @@\n${text.trimEnd().split('\n').map(line => '+' + line).join('\n')}` });
  const registered = revision => ({ filename: registryPath, status: 'modified', sha: blob(registry(revision)),
    additions: 1, deletions: 0,
    patch: `@@ -1,4 +1,5 @@\n REVISIONS = [\n     (41, "prior"),\n     (42, "sibling"),\n+    (${revision}, "${String(revision).padStart(3, '0')}_create_sample"),\n ]` });
  const original = options.beforeBody ?? body('042', '041');
  const final = options.afterBody ?? body('043', '042');
  const evidence = { headSha, primaryHead, mergeBase, hasHammerCommits: true, completeFileLists: true,
    ciCost: { headSha, ok: true }, primaryFiles: [added(source, original), registered(42)],
    finalFiles: [added(destination, final), registered(options.noRegistry ? 42 : 43)] };
  const repair = { sha: headSha, parents: [{ sha: primaryHead }],
    commit: { message: 'Rebase migration\n\nWorker-Class: hammer' },
    files: [{ filename: source, status: 'removed' }, ...evidence.finalFiles] };
  const calls = [];
  const get = async path => {
    calls.push(path);
    if (path.includes('/git/blobs/')) {
      const result = blobs.get(path.split('/git/blobs/')[1]);
      if (!result) throw new Error('Missing synthetic blob');
      return result;
    }
    if (path.endsWith('/pulls/1')) return { head: { sha: headSha }, base: { sha: mergeBase } };
    if (path.endsWith(`${mergeBase}...${headSha}`)) return { files: evidence.finalFiles, filesComplete: true,
      merge_base_commit: { sha: mergeBase }, total_commits: 2,
      commits: [{ sha: primaryHead, commit: { message: 'Add migration' } }, repair] };
    if (path.endsWith(`${mergeBase}...${primaryHead}`)) return { files: evidence.primaryFiles,
      filesComplete: true, merge_base_commit: { sha: mergeBase } };
    if (path.endsWith(`/commits/${headSha}`)) return repair;
    if (path.includes('/reviews') || path.includes('/comments')) return [];
    throw new Error(`Unexpected synthetic read: ${path}`);
  };
  return { evidence, args: { repo: 'fixture/repo', prNumber: 1, headSha, get }, calls, blob,
    source, destination, registryPath, body, registry, original, final };
}

export function alembicRenumberFixture({ steps = 1 } = {}) {
  const f = migrationRenumberFixture();
  const directory = 'sample/alembic/versions/';
  const moduleDirectory = 'sample/src/sample/schema_revisions/';
  const timestamp = number => `203104${String(number - 60).padStart(2, '0')}120000`;
  const wrapper = number => `${directory}${number}_${timestamp(number)}_b7_create_sample.py`;
  const module = number => `${moduleDirectory}r${number}.py`;
  const registryPath = `${moduleDirectory}__init__.py`;
  const pinPath = 'sample/tests/test_schema.py';
  const predecessor = number => `prior_${number === 71 ? 'oak' : 'elm'}_${number - 1}`;
  const body = number => `"""Create sample.\nRevision ID: create_sample_${number}\nRevises: ${predecessor(number)}\n"""\nfrom sample.schema import upgrade_revision, downgrade_revision\n\nrevision = "create_sample_${number}"\ndown_revision = "${predecessor(number)}"\nSOURCE_NAME = "${timestamp(number)}_b7_create_sample.sql"\n\ndef upgrade():\n    upgrade_revision(op, SOURCE_NAME)\n\ndef downgrade():\n    downgrade_revision(op, SOURCE_NAME)\n`;
  const moduleBody = number => `REVISION = (${number}, "create_sample")\n\ndef upgrade(op):\n    op.execute("CREATE TABLE sample (id int)")\n\ndef downgrade(op):\n    op.execute("DROP TABLE sample")\n`;
  const registry = number => `_MODULE_NAMES = [\n    "r70",\n    "r${number}",\n]\n`;
  const file = (filename, text, status = 'added') => ({ filename, status, sha: f.blob(text),
    additions: text.trimEnd().split('\n').length, deletions: 0,
    patch: `@@ -0,0 +1,${text.trimEnd().split('\n').length} @@\n${text.trimEnd().split('\n').map(line => '+' + line).join('\n')}` });
  const files = number => [file(wrapper(number), body(number)), file(module(number), moduleBody(number)),
    file(registryPath, registry(number), 'modified'), file(pinPath, `assert head == "create_sample_${number}"\n`, 'modified')];
  const snapshots = Array.from({ length: steps }, (_, index) => ({
    sha: (index + 12).toString(16).repeat(40), files: files(72 + index), number: 72 + index,
  }));
  const headSha = snapshots.at(-1).sha;
  Object.assign(f.evidence, { headSha, primaryFiles: files(71), finalFiles: snapshots.at(-1).files,
    diagnosticCommitRange: snapshots.map(({ sha }) => ({ sha })) });
  f.evidence.ciCost.headSha = headSha;
  const commits = snapshots.map((snapshot, index) => ({ sha: snapshot.sha,
    parents: [{ sha: index ? snapshots[index - 1].sha : f.evidence.primaryHead }],
    commit: { message: 'Renumber migration\n\nWorker-Class: hammer' }, files: snapshot.files }));
  const oldGet = f.args.get;
  f.args.headSha = headSha;
  f.args.get = async path => {
    if (path.includes('/git/trees/')) {
      const head = path.split('/git/trees/')[1].split('?')[0];
      const number = head === f.evidence.primaryHead ? 71 : snapshots.find(item => item.sha === head)?.number;
      if (!number) throw new Error('Unknown synthetic tree');
      return { truncated: false, tree: [{ path: `${directory}${number - 1}_prior_${number === 71 ? 'oak' : 'elm'}.py`, type: 'blob',
        sha: f.blob(`revision = "${predecessor(number)}"\n`) }] };
    }
    if (path.endsWith('/pulls/1')) return { head: { sha: headSha }, base: { sha: f.evidence.mergeBase } };
    const snapshot = snapshots.find(item => path.endsWith(`${f.evidence.mergeBase}...${item.sha}`));
    if (snapshot) return { files: snapshot.sha === headSha ? f.evidence.finalFiles : snapshot.files,
      filesComplete: true, merge_base_commit: { sha: f.evidence.mergeBase }, total_commits: commits.length + 1,
      commits: [{ sha: f.evidence.primaryHead, commit: { message: 'Add sample schema' } }, ...commits] };
    const commit = commits.find(item => path.endsWith(`/commits/${item.sha}`));
    if (commit) return commit;
    return oldGet(path);
  };
  return { ...f, source: wrapper(71), destination: wrapper(71 + steps), registryPath,
    modulePath: module(71), moduleDestination: module(71 + steps), body, moduleBody, registry,
    snapshots, file };
}
