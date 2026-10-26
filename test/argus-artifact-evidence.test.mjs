import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_RECORD_PATH, MAX_ARTIFACT_BYTES, gatherArtifactEvidence } from '../src/argus-artifact-evidence.mjs';
import { createDefaultArgusEvidenceIo, gatherArgusEvidence, summarizeLockfileDelta } from '../src/argus-dependency-evidence.mjs';
import { composeArgusVerdict } from '../src/argus-security-review.mjs';

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
  const reads = [], requests = [];
  const io = {
    existsImpl: () => true,
    fetchFileAtRef: async ({ path: name, ref }) => {
      reads.push({ path: name, ref });
      const side = ref === pr.baseSha ? 'base' : 'head';
      if (name === ARTIFACT_RECORD_PATH) return JSON.stringify(records[side]);
      return name === 'package.json' ? files[side].manifest : files[side].lock;
    },
    fetchProducerPullRequest: async () => ({ merged: true, mergeCommit: 'c'.repeat(40), baseRef: 'main', defaultBranch: 'main' }),
    fetchArtifactAtRef: async ({ repo, path: name, ref }) => { reads.push({ repo, path: name, ref }); return data[name]; },
    runRubric: async ({ requestPath }) => {
      const request = JSON.parse(readFileSync(requestPath, 'utf8'));
      requests.push(request);
      const proof = request.artifactEvidence[path];
      const verified = Boolean(proof.base && proof.head);
      for (const side of ['base', 'head']) {
        if (!proof[side]) continue;
        const binding = proof[side];
        assert.equal(binding.producer.baseRef, 'main');
        assert.equal(binding.producer.defaultBranch, 'main');
        assert.equal(binding.producer.mergeCommit, binding.record.producerCommit);
        for (const kind of ['consumer', 'producer']) {
          const bytes = readFileSync(join(dirname(requestPath), binding[`${kind}File`]));
          assert.equal(createHash('sha256').update(bytes).digest('hex'), binding[`${kind}Sha256`]);
        }
      }
      return { exitCode: verified ? 0 : 3, doc: {
        verdict: verified ? 'approve' : 'block',
        axes: [{ axis: 'provenance', data: { artifactProvenance: { [path]: {
          verified, baseSha256: proof.base?.consumerSha256, headSha256: proof.head?.consumerSha256,
        } } } }],
        findings: verified ? [] : [{ category: 'non_registry_source', severity: 'high', title: 'Missing release proof' }],
      } };
    },
    summarizeChecks: () => 'SUCCESS',
  };
  return { records, files, data, io, reads, requests };
}

// Exercise production GitHub adapters without a token, network or Agent OS.
function githubIo(f, response = () => undefined) {
  return createDefaultArgusEvidenceIo({ env: {}, execGhWithRetryImpl: async ({ args }) => {
    const endpoint = args.at(-1);
    const overridden = response(endpoint);
    if (overridden !== undefined) return { stdout: JSON.stringify(overridden) };
    if (endpoint.includes('/pulls/')) return { stdout: JSON.stringify({ merged: true, merge_commit_sha: 'c'.repeat(40), base: { ref: 'main' } }) };
    if (endpoint === 'repos/example/producer') return { stdout: JSON.stringify({ default_branch: 'main' }) };
    const name = endpoint.split('/contents/')[1]?.split('?')[0];
    assert.ok(f.data[name], `unexpected GitHub request: ${endpoint}`);
    const bytes = f.data[name];
    return { stdout: JSON.stringify({ type: 'file', size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }) };
  } });
}

async function collect(f) {
  const workDir = mkdtempSync(join(tmpdir(), 'argus-artifact-'));
  try {
    return await gatherArgusEvidence({ job, pr, diff: '', workDir, rootDir: '/offline', io: f.io,
      env: { ADVERSARIAL_ARGUS_RUBRIC_PYTHONPATH: '/offline/rubric' } });
  } finally { rmSync(workDir, { recursive: true, force: true }); }
}

test('LAC-2117: exact-head collector -> real Python rubric permits only proven same-producer upgrade', { skip: !existsSync(PYTHONPATH), timeout: 15000 }, async () => {
  const f = fixture();
  f.io.runRubric = async ({ requestPath }) => {
    try { return { exitCode: 0, doc: JSON.parse(execFileSync('python3', ['-m', 'argus_review', 'review', requestPath, '--format', 'json'], { env: { ...process.env, PYTHONPATH }, encoding: 'utf8' })) }; }
    catch (err) { if ([2, 3].includes(err.status)) return { exitCode: err.status, doc: JSON.parse(err.stdout) }; throw err; }
  };
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

test('offline collector/rubric contract pins exact provenance axis and strict verified boolean', async () => {
  const f = fixture();
  const live = githubIo(f);
  f.io.fetchProducerPullRequest = live.fetchProducerPullRequest;
  f.io.fetchArtifactAtRef = live.fetchArtifactAtRef;
  const good = await collect(f);
  assert.equal(good.fatal, null);
  const proof = f.requests[0].artifactEvidence[path];
  assert.deepEqual(good.verifiedArtifactSources, [{ lockfilePath: 'package-lock.json', packagePath: path,
    baseSha256: proof.base.consumerSha256, headSha256: proof.head.consumerSha256 }]);
  const runRubric = f.io.runRubric;
  for (const verified of [false, 'true', 1, undefined]) {
    f.io.runRubric = async (args) => {
      const result = await runRubric(args);
      result.doc.axes[0].data.artifactProvenance[path].verified = verified;
      return result;
    };
    assert.deepEqual((await collect(f)).verifiedArtifactSources, [], `rejects verified=${verified}`);
  }
  f.io.runRubric = async (args) => {
    const result = await runRubric(args);
    result.doc.axes[0].axis = 'another-axis';
    return result;
  };
  assert.deepEqual((await collect(f)).verifiedArtifactSources, []);
});

test('producer authority rejects non-default merges, missing branch authority and wrong commits', async () => {
  for (const producer of [null, { merged: false },
    { merged: true, mergeCommit: 'c'.repeat(40), baseRef: 'scratch', defaultBranch: 'main' },
    { merged: true, mergeCommit: 'c'.repeat(40) },
    { merged: true, mergeCommit: 'c'.repeat(40), baseRef: '', defaultBranch: '' },
    { merged: true, mergeCommit: 'e'.repeat(40), baseRef: 'main', defaultBranch: 'main' }]) {
    const f = fixture();
    f.io.fetchProducerPullRequest = async () => producer;
    const evidence = await collect(f);
    assert.equal(evidence.fatal, null);
    assert.deepEqual(evidence.artifactBindings[0].artifactEvidence[path], {});
    assert.deepEqual(evidence.verifiedArtifactSources, []);
    assert.equal(composeArgusVerdict({ modelReview: { findings: [] }, rubricFindings: evidence.rubricFindings }).verdict, 'block');
  }
  const f = fixture();
  f.records.head.packages['@example/sdk'].producerRepo = 'example/other-producer';
  const evidence = await collect(f);
  assert.ok(evidence.artifactBindings[0].artifactEvidence[path].base);
  assert.equal(evidence.artifactBindings[0].artifactEvidence[path].head, undefined);
  assert.deepEqual(evidence.verifiedArtifactSources, []);
  assert.ok(evidence.rubricFindings.some(x => x.severity === 'high'));
  assert.ok(f.reads.every(x => x.repo !== 'example/other-producer'));
});

test('production GitHub absence and invalid inline contents retain a high instead of fatal', async (t) => {
  const notFound = () => { throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'HTTP 404' }); };
  const cases = [
    ['scratch merge', endpoint => endpoint.includes('/pulls/') ? { merged: true, merge_commit_sha: 'c'.repeat(40), base: { ref: 'scratch' } } : undefined],
    ['missing default branch', endpoint => endpoint === 'repos/example/producer' ? {} : undefined],
    ['producer PR 404', endpoint => endpoint.includes('/pulls/') ? notFound() : undefined],
    ['producer repository 404', endpoint => endpoint === 'repos/example/producer' ? notFound() : undefined],
    ['consumer artifact 404', endpoint => endpoint.includes('consumer/contents/') ? notFound() : undefined],
    ['producer artifact 404', endpoint => endpoint.includes('producer/contents/') ? notFound() : undefined],
    ...[
      ['directory', []], ['non-file', { type: 'dir', encoding: 'base64', size: 0, content: '' }],
      ['encoding none', { type: 'file', encoding: 'none', size: 10, content: '' }],
      ['oversize', { type: 'file', encoding: 'base64', size: MAX_ARTIFACT_BYTES + 1, content: '' }],
      ['size mismatch', { type: 'file', encoding: 'base64', size: 10, content: '' }],
    ].map(([name, doc]) => [name, endpoint => endpoint.includes('/contents/') ? doc : undefined]),
  ];
  for (const [name, response] of cases) await t.test(name, async () => {
    const f = fixture(), live = githubIo(f, response);
    f.io.fetchProducerPullRequest = live.fetchProducerPullRequest;
    f.io.fetchArtifactAtRef = live.fetchArtifactAtRef;
    const evidence = await collect(f);
    assert.equal(evidence.fatal, null);
    assert.deepEqual(evidence.artifactBindings[0].artifactEvidence[path], {});
    assert.deepEqual(evidence.verifiedArtifactSources, []);
    assert.equal(composeArgusVerdict({ modelReview: { findings: [] }, rubricFindings: evidence.rubricFindings }).verdict, 'block');
    assert.equal(f.requests.length, 1, 'rubric still decides absent proof');
  });
});

test('transient producer and artifact reads remain fatal; inline size boundary is enforced', async () => {
  for (const target of ['/pulls/', '/contents/']) {
    const f = fixture(), live = githubIo(f, endpoint => {
      if (endpoint.includes(target)) throw new Error('HTTP 503');
    });
    f.io.fetchProducerPullRequest = live.fetchProducerPullRequest;
    f.io.fetchArtifactAtRef = live.fetchArtifactAtRef;
    const evidence = await collect(f);
    assert.match(evidence.fatal, /artifact evidence read failed: HTTP 503/u);
    assert.equal(f.requests.length, 0);
  }
  const bytes = Buffer.alloc(MAX_ARTIFACT_BYTES);
  const live = githubIo(fixture(), () => ({ type: 'file', encoding: 'base64', size: bytes.length, content: bytes.toString('base64') }));
  assert.deepEqual(await live.fetchArtifactAtRef({ repo: job.repo, path: 'vendor/sdk.tgz', ref: job.headSha }), bytes);
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
