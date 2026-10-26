import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_RECORD_PATH, gatherArtifactEvidence } from '../src/argus-artifact-evidence.mjs';
import { gatherArgusEvidence, summarizeLockfileDelta } from '../src/argus-dependency-evidence.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHONPATH = resolve(realpathSync(HERE), '../../agent-os/modules/argus/lib/python');
const path = 'node_modules/@example/sdk';
const job = { repo: 'example/consumer', prNumber: 1550, headSha: 'd'.repeat(40), reasons: [] };
const pr = { baseSha: 'b'.repeat(40), changedFiles: ['package-lock.json'] };

function fixture() {
  const generated = {};
  for (const [side, version] of [['base', '0.8.0'], ['head', '0.9.0']]) {
    const content = Buffer.from(JSON.stringify({ name: '@example/sdk', version }));
    const header = Buffer.alloc(512);
    header.write('package/package.json');
    header.write('0000644\0', 100);
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write(`${header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0')}\0 `, 148);
    const data = gzipSync(Buffer.concat([header, content, Buffer.alloc(512 - content.length), Buffer.alloc(1024)]));
    generated[side] = { bytes: data.toString('base64'), version,
      sha256: createHash('sha256').update(data).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(data).digest('base64')}` };
  }
  const records = {}, files = {}, data = {};
  for (const side of ['base', 'head']) {
    const f = generated[side];
    const local = `vendor/sdk-${f.version}.tgz`;
    const record = { producerRepo: 'example/producer', producerPr: 9435, producerCommit: 'c'.repeat(40), producerPath: `sdk/sdk-${f.version}.tgz`, sha256: f.sha256 };
    records[side] = { schemaVersion: 1, packages: { '@example/sdk': record } };
    files[side] = {
      manifest: JSON.stringify({ dependencies: { '@example/sdk': `file:${local}` } }),
      lock: JSON.stringify({ lockfileVersion: 3, packages: { [path]: { version: f.version, resolved: `file:${local}`, integrity: f.integrity } } }),
    };
    data[local] = Buffer.from(f.bytes, 'base64');
    data[record.producerPath] = data[local];
  }
  const reads = [];
  const io = {
    existsImpl: () => true,
    fetchFileAtRef: async ({ path: name, ref }) => {
      reads.push({ path: name, ref });
      const side = ref === pr.baseSha ? 'base' : 'head';
      if (name === ARTIFACT_RECORD_PATH) return JSON.stringify(records[side]);
      return name === 'package.json' ? files[side].manifest : files[side].lock;
    },
    fetchProducerPullRequest: async () => ({ merged: true, mergeCommit: 'c'.repeat(40) }),
    fetchArtifactAtRef: async ({ repo, path: name, ref }) => { reads.push({ repo, path: name, ref }); return data[name]; },
    runRubric: async ({ requestPath }) => {
      try { return { exitCode: 0, doc: JSON.parse(execFileSync('python3', ['-m', 'argus_review', 'review', requestPath, '--format', 'json'], { env: { ...process.env, PYTHONPATH }, encoding: 'utf8' })) }; }
      catch (err) { if ([2, 3].includes(err.status)) return { exitCode: err.status, doc: JSON.parse(err.stdout) }; throw err; }
    },
    summarizeChecks: () => 'SUCCESS',
  };
  return { records, files, data, io, reads };
}

test('LAC-2117: exact-head collector -> real Python rubric permits only proven same-producer upgrade', { skip: !existsSync(PYTHONPATH), timeout: 15000 }, async () => {
  const f = fixture();
  const workDir = mkdtempSync(join(tmpdir(), 'argus-artifact-'));
  try {
    const collect = () => gatherArgusEvidence({ job, pr, diff: '', workDir, rootDir: '/offline', io: f.io, env: { ADVERSARIAL_ARGUS_RUBRIC_PYTHONPATH: PYTHONPATH } });
    const good = await collect();
    assert.equal(good.fatal, null);
    assert.equal(good.rubricFindings.filter(x => x.severity === 'high').length, 0);
    assert.equal(good.verifiedArtifactSources.length, 1);
    assert.match(good.artifactBindings[0].artifactEvidence[path].head.consumerSha256, /^[a-f0-9]{64}$/u);
    assert.ok(f.reads.some(x => x.repo === 'example/consumer' && x.ref === job.headSha && x.path === 'vendor/sdk-0.9.0.tgz'));
    assert.ok(f.reads.some(x => x.repo === 'example/producer' && x.ref === 'c'.repeat(40) && x.path === 'sdk/sdk-0.9.0.tgz'));
    delete f.records.base.packages['@example/sdk'];
    const absent = await collect();
    assert.ok(absent.rubricFindings.some(x => x.category === 'non_registry_source' && x.severity === 'high'));
    assert.equal(absent.verifiedArtifactSources.length, 0);
  } finally { rmSync(workDir, { recursive: true, force: true }); }
});

test('collector requires merged exact producer commit and confines paths', async () => {
  const f = fixture();
  const root = mkdtempSync(join(tmpdir(), 'argus-artifact-'));
  try {
    f.io.fetchProducerPullRequest = async () => ({ merged: false });
    const proof = await gatherArtifactEvidence({ job, pr, dir: '', treeRoot: root, files: f.files, io: f.io });
    assert.deepEqual(proof[path], {});
    f.records.head.packages['@example/sdk'].producerPath = '../secret';
    f.io.fetchProducerPullRequest = async () => { throw new Error('must not read invalid path'); };
    delete f.records.base.packages['@example/sdk'];
    const invalid = await gatherArtifactEvidence({ job, pr, dir: '', treeRoot: root, files: f.files, io: f.io });
    assert.deepEqual(invalid[path], {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lock facts include integrity-only and install-script-only sibling changes', () => {
  const before = { version: '1', resolved: 'file:vendor/sdk.tgz', integrity: 'sha512-old' };
  const baseLock = { packages: { [path]: before } };
  const delta = summarizeLockfileDelta({ baseLock, headLock: { packages: { [path]: { ...before, integrity: '', hasInstallScript: true } } } });
  assert.deepEqual(delta.changed, ['@example/sdk']);
  assert.deepEqual(delta.missingIntegrityIncoming, ['@example/sdk']);
  assert.deepEqual(delta.installScriptsAdded, ['@example/sdk']);
});
