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
