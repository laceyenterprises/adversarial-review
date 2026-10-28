import { installDispatchFileProducerFixture } from './helpers/dispatch-files-fixture.mjs';
installDispatchFileProducerFixture();
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selectCodexReviewerAccount, selectCodexWorkerAccount } from '../src/codex-account-routing.mjs';
import { parseHqFleetQuotaSnapshot, quotaStatusesFromSnapshot } from '../src/fleet-quota-status.mjs';
import { resolveRemediationModel } from '../src/adapters/agent-runtime/local/remediation.mjs';
import { readLaunchRequestStatusFromLedger } from '../src/session-ledger-read-adapter.mjs';
import { launchRequestMeaning, launchRequestInFlight, launchRequestOwned } from '../src/ama/launch-request-status.mjs';
import { assertProducerContract, recordedFixture, fixtureProvenance, sha256, sdkSnapshotBytes } from './helpers/recorded-producer-fixtures.mjs';

test('recorded fixtures verify release, snapshot, capture and byte hashes offline', () => {
  const sdk = fixtureProvenance.recorded.sdk;
  assert.equal(sha256(readFileSync(new URL(`../${sdk.file}`, import.meta.url))), sdk.sha256);
  assert.equal(sha256(sdkSnapshotBytes), sdk.snapshotSha256);
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const dependency = lock.packages['node_modules/@agent-os/app-sdk'];
  const runtime = fixtureProvenance.recorded.dispatchLookupSdk;
  const bytes = readFileSync(new URL(`../${runtime.file}`, import.meta.url));
  assert.equal(dependency.version, runtime.version);
  assert.equal(dependency.resolved, `file:${runtime.file}`);
  assert.equal(sha256(bytes), runtime.sha256);
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, runtime.integrity);
  assert.equal(dependency.integrity, runtime.integrity);
  for (const name of Object.keys(fixtureProvenance.recorded.producers)) recordedFixture(name);
});

for (const name of ['github-token-refresh', 'fleet-quota-status', 'worker-class-show', 'launch-request-row']) {
  test(`${name}: corrupt fixture bytes fail the pin with a producer/version diagnostic`, () => {
    assert.throws(() => recordedFixture(name, {
      readFileImpl: () => Buffer.from('synthetic-corruption-must-not-appear'),
    }), error => {
      assert.equal(error.message, `${name} contract ${fixtureProvenance.recorded.producers[name].contractVersion}: recorded producer fixture drift`);
      assert.doesNotMatch(error.stack, /synthetic-corruption-must-not-appear/);
      assert.equal(error.cause, undefined);
      return true;
    });
  });
}

function checkFleet(value) {
  assertProducerContract('fleet-quota-status', () => {
    const snapshot = parseHqFleetQuotaSnapshot(JSON.stringify(value));
    const statuses = quotaStatusesFromSnapshot(snapshot);
    assert.equal(statuses[0].provider, 'openai');
    assert.equal(statuses[0].state, 'ok');
    // The recorder anonymizes account-map keys. Unknown account evidence must
    // hold, even with an available provider; do not invent admission evidence.
    for (const select of [selectCodexReviewerAccount, selectCodexWorkerAccount]) {
      const route = select(snapshot);
      assert.equal(route.hold, true);
      assert.equal(route.reason, 'codex-account-evidence-unknown');
    }
  });
}

test('quota routers consume the recorded fleet serializer output', () => {
  checkFleet(recordedFixture('fleet-quota-status'));
});

function checkWorkerClass(t, value) {
  assertProducerContract('worker-class-show', () => {
    const root = mkdtempSync(join(tmpdir(), 'recorded-worker-class-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'registry'));
    // The fake public owner projects this recorded class specification;
    // application code receives only its public registry response.
    writeFileSync(join(root, 'registry/worker-classes.json'), JSON.stringify({ classes: { [value.className]: value.spec } }));
    const result = resolveRemediationModel(value.className, {
      env: { HQ_ROOT: root, AGENT_OS_DEPLOY_CHECKOUT: root }, fallbackModel: null,
    });
    assert.equal(result.modelSource, 'registry');
    assert.equal(result.resolvedModel, 'synthetic-string');
  });
}

test('worker-class model reads consume the recorded spec through the public owner projection', t => {
  checkWorkerClass(t, recordedFixture('worker-class-show'));
});

function checkLaunch(value) {
  assertProducerContract('launch-request-row', () => {
    // The row snapshot seam avoids a live database and exercises the same row
    // selection and status policies used by the ledger-backed consumer.
    const probe = readLaunchRequestStatusFromLedger({
      launchRequestId: value.launch_request_id,
      launchSnapshot: { ok: true, rows: [value], target: { backend: 'sqlite', path: ':memory:' } }, env: {},
    });
    assert.equal(probe.ok, true);
    assert.equal(probe.row.launch_request_id, 'synthetic-id');
    const meaning = launchRequestMeaning(probe.row);
    assert.equal(meaning.status, 'requested');
    assert.equal(meaning.terminal, false);
    assert.equal(meaning.succeeded, false);
    assert.equal(launchRequestInFlight(probe), true);
    assert.equal(launchRequestOwned(probe), true);
  });
}

test('launch-request reads preserve the recorded requested row and ownership', () => {
  checkLaunch(recordedFixture('launch-request-row'));
});

for (const [name, mutate, check] of [
  ['fleet-quota-status', value => { value.providerStatuses = []; }, (_t, value) => checkFleet(value)],
  ['worker-class-show', value => { value.spec.defaultModel = null; }, checkWorkerClass],
  ['launch-request-row', value => { value.status = 'unknown-future'; }, (_t, value) => checkLaunch(value)],
]) test(`${name}: negative fixture mutation fails with producer/version and no payload`, t => {
  const value = recordedFixture(name);
  mutate(value);
  assert.throws(() => check(t, value), error => {
    assert.equal(error.message, `${name} contract ${fixtureProvenance.recorded.producers[name].contractVersion}: recorded producer fixture drift`);
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(error.stack, /synthetic-string|synthetic-id/);
    return true;
  });
  // A failed negative case must never mutate shared release evidence.
  recordedFixture(name);
});

test('SDK refresh is deterministic, preserves historical evidence and rejects corrupt recordings before writing', t => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PYTHON')));
  const options = { encoding: 'utf8', timeout: 10000, env };
  const probe = spawnSync('python3', ['-I', '-c', 'import sys'], options);
  if (probe.error || probe.status !== 0) return t.skip('python3 is optional; no working refresh interpreter');
  const root = mkdtempSync(join(tmpdir(), 'recorded-refresh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixtures = join(root, 'test/fixtures/producer-contracts');
  mkdirSync(fixtures, { recursive: true });
  mkdirSync(join(root, 'scripts/contracts'), { recursive: true });
  mkdirSync(join(root, 'vendor'));
  const script = join(root, 'scripts/contracts/refresh-recorded.py');
  copyFileSync(new URL('../scripts/contracts/refresh-recorded.py', import.meta.url), script);
  const sdk = fixtureProvenance.recorded.sdk;
  const archive = join(root, sdk.file);
  copyFileSync(new URL(`../${sdk.file}`, import.meta.url), archive);
  const manifestPath = join(fixtures, 'provenance.json');
  const run = () => spawnSync('python3', ['-I', script, archive, sdk.releaseRevision], options);
  for (const removeTree of [false, true]) {
    if (removeTree) rmSync(fixtures, { recursive: true });
    const fresh = run();
    assert.ifError(fresh.error);
    assert.equal(fresh.status, 0, fresh.stderr);
    const initialized = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(initialized.recorded.producers, fixtureProvenance.recorded.producers);
    assert.deepEqual(initialized.producerHashes, fixtureProvenance.producerHashes);
  }
  writeFileSync(manifestPath, JSON.stringify(fixtureProvenance));
  const releasedPath = join(fixtures, 'released-provenance.json');
  writeFileSync(releasedPath, 'separately maintained');
  const first = run();
  assert.ifError(first.error);
  assert.equal(first.status, 0, first.stderr);
  const paths = ['provenance.json', ...Object.values(fixtureProvenance.recorded.producers).map(record => record.file)];
  const before = paths.map(path => readFileSync(join(fixtures, path)));
  const second = run();
  assert.ifError(second.error);
  assert.equal(second.status, 0, second.stderr);
  paths.forEach((path, i) => assert.deepEqual(readFileSync(join(fixtures, path)), before[i]));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(manifest.files, fixtureProvenance.files);
  assert.equal(readFileSync(releasedPath, 'utf8'), 'separately maintained');
  // Rewrite only the sanitized example, retaining its old contentHash. The
  // refresher must identify drift without publishing or echoing that payload.
  const corrupt = spawnSync('python3', ['-I', '-c', `import io,json,sys,tarfile
path=sys.argv[1]
with tarfile.open(path) as source:
    entries=[(member,source.extractfile(member).read()) for member in source if member.isfile()]
with tarfile.open(path,'w:gz') as output:
    for member,data in entries:
        if member.name=='package/src/producer-contracts-v1.json':
            bundle=json.loads(data)
            producer=bundle['producers']['github-token-refresh']
            example=next(e for e in producer['examples'] if e.get('provenance')=='producer-recorded')
            example['value']='synthetic-payload-must-not-appear'
            data=json.dumps(bundle).encode()
        member.size=len(data)
        output.addfile(member,io.BytesIO(data))
`, archive], options);
  assert.ifError(corrupt.error);
  assert.equal(corrupt.status, 0, corrupt.stderr);
  const rejected = run();
  assert.ifError(rejected.error);
  assert.notEqual(rejected.status, 0);
  const version = fixtureProvenance.recorded.producers['github-token-refresh'].contractVersion;
  assert.ok(rejected.stderr.includes(`github-token-refresh contract ${version}: content hash mismatch`));
  assert.doesNotMatch(rejected.stdout + rejected.stderr, /synthetic-payload-must-not-appear/);
  paths.forEach((path, i) => assert.deepEqual(readFileSync(join(fixtures, path)), before[i]));
});

test('SDK refresh hashes Unicode JSON and token strings with UTF-8 bytes', t => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PYTHON')));
  const options = { encoding: 'utf8', timeout: 10000, env };
  const probe = spawnSync('python3', ['-I', '-c', 'import sys'], options);
  if (probe.error || probe.status !== 0) return t.skip('python3 is optional; no working refresh interpreter');
  const root = mkdtempSync(join(tmpdir(), 'recorded-refresh-unicode-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixtures = join(root, 'test/fixtures/producer-contracts');
  mkdirSync(fixtures, { recursive: true });
  writeFileSync(join(fixtures, 'provenance.json'), '{}');
  mkdirSync(join(root, 'scripts/contracts'), { recursive: true });
  const script = join(root, 'scripts/contracts/refresh-recorded.py');
  copyFileSync(new URL('../scripts/contracts/refresh-recorded.py', import.meta.url), script);
  const archive = join(root, 'sdk.tgz');
  const bundle = JSON.parse(sdkSnapshotBytes);
  const expected = new Map();
  for (const [name, record] of Object.entries(fixtureProvenance.recorded.producers)) {
    const producer = bundle.producers[name];
    // Labelled consumer mutations: sorted keys match the producer's canonical
    // JSON; BMP and supplementary characters exercise raw UTF-8 in both paths.
    const value = name === 'github-token-refresh' ? 'élève 東京 😀\n' : { author: 'Zoë', note: '東京 😀' };
    producer.examples.find(entry => entry.provenance === 'producer-recorded').value = value;
    producer.recording.contentHash = sha256(JSON.stringify(value));
    expected.set(record.file, { name, value, hash: producer.recording.contentHash });
  }
  const packed = spawnSync('python3', ['-I', '-c', `import io,sys,tarfile
with tarfile.open(sys.argv[1], 'w:gz') as archive:
    for name, data in [('package/package.json', b'{"version":"0.4.0"}'),
                       ('package/src/producer-contracts-v1.json', sys.stdin.buffer.read())]:
        member = tarfile.TarInfo(name)
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
`, archive], { ...options, input: JSON.stringify(bundle) });
  assert.ifError(packed.error);
  assert.equal(packed.status, 0, packed.stderr);
  const refreshed = spawnSync('python3', ['-I', script, archive, fixtureProvenance.recorded.sdk.releaseRevision], options);
  assert.ifError(refreshed.error);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const manifest = JSON.parse(readFileSync(join(fixtures, 'provenance.json'), 'utf8'));
  for (const [file, { name, value, hash }] of expected) {
    const bytes = readFileSync(join(fixtures, file));
    assert.deepEqual(bytes, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
    assert.equal(sha256(bytes), manifest.recorded.producers[name].sha256);
    assert.equal(manifest.producerHashes[name], hash);
  }
});
