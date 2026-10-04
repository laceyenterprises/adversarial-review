import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { recordMergeActionBestEffort, writeMergeActionReceipt } from '../src/ama/merge-action-receipt.mjs';

for (const operation of ['fchmodSync', 'fchownSync', 'writeFileSync', 'fsyncSync']) {
  test(`receipt closes its descriptor and removes temporary file when ${operation} fails`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'receipt-failure-'));
    let descriptor;
    try {
      mkdirSync(join(root, '.hq'));
      writeFileSync(join(root, '.hq/config.json'), JSON.stringify({ ownerUser: userInfo().username }));
      const originalOpen = fs.openSync;
      t.mock.method(fs, 'openSync', (...args) => {
        descriptor = originalOpen(...args);
        return descriptor;
      });
      const failure = new Error(`injected ${operation} failure`);
      t.mock.method(fs, operation, () => { throw failure; });
      syncBuiltinESMExports();
      assert.throws(() => writeMergeActionReceipt({ hqRoot: root, repo: 'test/repo',
        prNumber: 7, headSha: 'a'.repeat(40), merged: true }), error => error === failure);
      assert.equal(typeof descriptor, 'number');
      assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
      assert.deepEqual(readdirSync(join(root, 'dispatch/audit/automation-merge-actions')), []);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const producerClass of ['ama-daemon', 'closer-hammer']) {
  test(`${producerClass} appends merge and refusal receipts without overwriting`, () => {
    const root = mkdtempSync(join(tmpdir(), 'ama-receipt-'));
    try {
      mkdirSync(join(root, '.hq'));
      writeFileSync(join(root, '.hq/config.json'), JSON.stringify({ ownerUser: userInfo().username }));
      const args = { hqRoot: root, repo: 'test/repo', prNumber: 7, headSha: 'a'.repeat(40), producerClass };
      const merged = writeMergeActionReceipt({ ...args, merged: true });
      const refused = writeMergeActionReceipt({ ...args, merged: false, reason: 'primary-change-reverted' });
      assert.equal(JSON.parse(readFileSync(merged)).merged, true);
      assert.equal(JSON.parse(readFileSync(refused)).reason, 'primary-change-reverted');
      assert.equal(statSync(merged).mode & 0o777, 0o640);
      assert.equal(readdirSync(join(root, 'dispatch/audit/automation-merge-actions')).length, 2);
      writeFileSync(join(root, '.hq/config.json'), JSON.stringify({ ownerUser: 'different-owner' }));
      assert.throws(() => writeMergeActionReceipt({ ...args, merged: true }), /HQ ownerUser/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('hammer CLI verifies stub gh and writes merge/refusal or isolated-worker requests', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'hammer-receipt-'));
  const cli = new URL('../bin/merge-action-receipt.mjs', import.meta.url);
  try {
    mkdirSync(join(root, '.hq'));
    writeFileSync(join(root, '.hq/config.json'), JSON.stringify({ ownerUser: userInfo().username }));
    const gh = join(root, 'gh');
    writeFileSync(gh, '#!/bin/sh\ncat "$(dirname "$0")/pr.json"\n', { mode: 0o755 });
    writeFileSync(join(root, 'pr.json'), JSON.stringify({ state: 'MERGED', headRefOid: 'a'.repeat(40), mergedAt: new Date().toISOString() }));
    const issuedAt = new Date(Date.now() - 180_000).toISOString();
    const env = { ...process.env, PATH: `${root}:${process.env.PATH}` };
    const args = [cli.pathname, root, 'test/repo', '7', 'a'.repeat(40)];
    writeFileSync(join(root, 'pr.json'), JSON.stringify({ state: 'MERGED', headRefOid: 'a'.repeat(40), mergedAt: issuedAt }));
    assert.equal(spawnSync(process.execPath, [...args, 'merged', '', issuedAt], { env, timeout: 5000 }).status, 0);
    assert.equal(spawnSync(process.execPath, [...args, 'refused', 'primary-change-reverted'], { env }).status, 0);
    assert.equal(readdirSync(join(root, 'dispatch/audit/automation-merge-actions')).length, 2);
    writeFileSync(join(root, 'pr.json'), JSON.stringify({ state: 'OPEN', headRefOid: 'a'.repeat(40) }));
    assert.notEqual(spawnSync(process.execPath, [...args, 'merged'], { env }).status, 0);
    assert.equal(readdirSync(join(root, 'dispatch/audit/automation-merge-actions')).length, 2);
    writeFileSync(join(root, '.hq/config.json'), JSON.stringify({ ownerUser: 'other-owner' }));
    env.HQ_WORKER_ID = 'worker-1';
    env.HQ_LAUNCH_REQUEST_ID = 'lrq-1';
    assert.equal(spawnSync(process.execPath, [...args, 'refused', 'predicate-not-eligible'], { env }).status, 0);
    env.HQ_WORKER_ID = '..';
    assert.notEqual(spawnSync(process.execPath, [...args, 'refused', 'predicate-not-eligible'], { env, timeout: 5000 }).status, 0);
    assert.equal(fs.existsSync(join(root, 'merge-action-requests')), false);
    env.HQ_WORKER_ID = 'worker-1';
    const requests = readdirSync(join(root, 'workers/worker-1/merge-action-requests'));
    assert.equal(requests.length, 1);
    assert.equal(readdirSync(join(root, 'dispatch/audit/automation-merge-actions')).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('API merge seam records verified merges and refused exact-head writes', async () => {
  const { writeAdapterPullRequestMerge } = await import('../src/github-adapter-client.mjs');
  const root = mkdtempSync(join(tmpdir(), 'api-receipt-'));
  try {
    mkdirSync(join(root, '.hq'));
    writeFileSync(join(root, '.hq/config.json'), JSON.stringify({ ownerUser: userInfo().username }));
    let refuse = false;
    const options = { env: { HQ_ROOT: root, GHA_ADAPTER_BIN: '/fixture/github-adapter' },
      execFileImpl: async (bin) => {
        if (bin === 'gh') return { stdout: JSON.stringify({ state: 'MERGED', headRefOid: 'a'.repeat(40), mergedAt: new Date().toISOString() }) };
        if (refuse) throw Object.assign(new Error('head mismatch'), {
          stderr: JSON.stringify({ ok: false, failureClass: 'permanent', error: 'head mismatch' }),
        });
        return { stdout: JSON.stringify({ ok: true }) };
      } };
    await writeAdapterPullRequestMerge('test/repo', 7, { matchHeadCommit: 'a'.repeat(40) }, options);
    refuse = true;
    await assert.rejects(writeAdapterPullRequestMerge('test/repo', 7, { matchHeadCommit: 'a'.repeat(40) }, options), /head mismatch/);
    const actions = readdirSync(join(root, 'dispatch/audit/automation-merge-actions')).map(name => JSON.parse(readFileSync(join(root, 'dispatch/audit/automation-merge-actions', name))));
    assert.equal(actions.length, 1);
    assert.deepEqual(actions.map(a => a.merged).sort(), [true]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const scenario of [
  { name: 'recovers a transient read', failure: 'TLS handshake timeout', failures: 2, attempts: 3, receipts: 1 },
  { name: 'bounds transient read exhaustion', failure: 'TLS handshake timeout', failures: 4, attempts: 3, receipts: 0 },
  { name: 'does not retry permission errors', failure: 'Resource not accessible by integration (HTTP 403)', failures: 1, attempts: 1, receipts: 0 },
]) {
  test(`hammer CLI ${scenario.name}`, async () => {
    const { spawnSync } = await import('node:child_process');
    const root = mkdtempSync(join(tmpdir(), 'hammer-retry-'));
    try {
      mkdirSync(join(root, '.hq'));
      writeFileSync(join(root, '.hq/config.json'), JSON.stringify({ ownerUser: userInfo().username }));
      writeFileSync(join(root, 'pr.json'), JSON.stringify({ state: 'MERGED', headRefOid: 'a'.repeat(40), mergedAt: new Date().toISOString() }));
      writeFileSync(join(root, 'failure'), scenario.failure);
      writeFileSync(join(root, 'gh'), `#!/bin/sh
cd "$(dirname "$0")" || exit 1
attempt=0
if [ -f attempts ]; then attempt=$(cat attempts); fi
attempt=$((attempt + 1))
printf '%s' "$attempt" > attempts
if [ "$attempt" -le ${scenario.failures} ]; then cat failure >&2; exit 1; fi
cat pr.json
`, { mode: 0o755 });
      const result = spawnSync(process.execPath, [new URL('../bin/merge-action-receipt.mjs', import.meta.url).pathname,
        root, 'test/repo', '7', 'a'.repeat(40), 'merged'], {
        env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, timeout: 10_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status === 0, scenario.receipts === 1, String(result.stderr));
      assert.equal(Number(readFileSync(join(root, 'attempts'))), scenario.attempts);
      const directory = join(root, 'dispatch/audit/automation-merge-actions');
      assert.equal(fs.existsSync(directory) ? readdirSync(directory).length : 0, scenario.receipts);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const scenario of [
  { name: 'recovers EIO', code: 'EIO', failures: 2, attempts: 3, receipts: 1 },
  { name: 'bounds timeout exhaustion', code: 'ETIMEDOUT', failures: 4, attempts: 3, receipts: 0 },
  { name: 'does not retry permanent spawn errors', code: 'ENOENT', failures: 1, attempts: 1, receipts: 0 },
  { name: 'rejects another head after recovery', code: 'ECONNRESET', failures: 1, attempts: 2, receipts: 0, headSha: 'b'.repeat(40) },
]) {
  test(`API post-merge verification ${scenario.name} without repeating the merge`, async () => {
    const { writeAdapterPullRequestMerge } = await import('../src/github-adapter-client.mjs');
    const root = mkdtempSync(join(tmpdir(), 'api-retry-'));
    let mergeCalls = 0;
    let viewCalls = 0;
    try {
      mkdirSync(join(root, '.hq'));
      writeFileSync(join(root, '.hq/config.json'), JSON.stringify({ ownerUser: userInfo().username }));
      const result = await writeAdapterPullRequestMerge('test/repo', 7, { matchHeadCommit: 'a'.repeat(40) }, {
        env: { HQ_ROOT: root, GHA_ADAPTER_BIN: '/fixture/github-adapter' },
        execFileImpl: async (bin, args, options) => {
          if (bin !== 'gh') {
            mergeCalls += 1;
            return { stdout: JSON.stringify({ ok: true }) };
          }
          viewCalls += 1;
          assert.deepEqual(args, ['pr', 'view', '7', '--repo', 'test/repo', '--json', 'state,headRefOid,mergedAt']);
          assert.equal(options.timeout, 15_000);
          if (viewCalls <= scenario.failures) throw Object.assign(new Error('injected read failure'), { code: scenario.code });
          return { stdout: JSON.stringify({ state: 'MERGED', headRefOid: scenario.headSha || 'a'.repeat(40), mergedAt: new Date().toISOString() }) };
        },
      });
      assert.equal(result.payload.ok, true);
      assert.equal(mergeCalls, 1);
      assert.equal(viewCalls, scenario.attempts);
      const directory = join(root, 'dispatch/audit/automation-merge-actions');
      assert.equal(fs.existsSync(directory) ? readdirSync(directory).length : 0, scenario.receipts);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const scenario of [
  { name: 'unstructured merge error', error: new Error('head mismatch'), receipts: 0 },
  { name: 'transport timeout', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), receipts: 0 },
  { name: 'structured transient error', error: Object.assign(new Error('adapter failed'), { stderr: JSON.stringify({ ok: false, failureClass: 'transient', error: 'HTTP 503' }) }), receipts: 0 },
  { name: 'already merged at revision', error: Object.assign(new Error('adapter failed'), { stderr: JSON.stringify({ ok: false, failureClass: 'permanent', error: 'already merged', matchHeadCommit: 'a'.repeat(40) }) }), receipts: 0, finalization: true },
  { name: 'returned stale head', payload: { ok: false, failureClass: 'permanent', reason: 'head mismatch' }, receipts: 0 },
  { name: 'returned stale sha', payload: { ok: false, failureClass: 'permanent', reason: 'Head sha did not match pull request head' }, receipts: 0 },
  { name: 'returned unclassified refusal', payload: { ok: false, reason: 'denied' }, receipts: 0 },
  { name: 'returned permanent refusal', payload: { ok: false, failureClass: 'permanent', reason: 'policy denied' }, receipts: 1 },
  { name: 'returned transient failure', payload: { ok: false, error: 'HTTP 503' }, receipts: 0 },
  { name: 'returned transient class without prose', payload: { ok: false, failureClass: 'transient' }, receipts: 0 },
  { name: 'returned transport code without prose', payload: { ok: false, code: 'ECONNRESET' }, receipts: 0 },
  { name: 'returned unsupported operation', payload: { ok: false, failureClass: 'unsupported', code: 'unsupported_command' }, receipts: 0 },
  { name: 'returned idempotent refusal', payload: { ok: false, idempotent: true }, receipts: 0 },
  { name: 'returned already merged', payload: { ok: false, reason: 'already merged' }, receipts: 0 },
  { name: 'caller owns permanent refusal', payload: { ok: false }, receipts: 0, recordReceipt: false },
  { name: 'caller owns thrown permanent refusal', error: Object.assign(new Error('head mismatch'), { stderr: JSON.stringify({ ok: false, failureClass: 'permanent' }) }), receipts: 0, recordReceipt: false },
]) {
  test(`adapter receipt: ${scenario.name}`, async () => {
    const { writeAdapterPullRequestMerge } = await import('../src/github-adapter-client.mjs');
    const root = mkdtempSync(join(tmpdir(), 'adapter-refusal-'));
    try {
      mkdirSync(join(root, '.hq'));
      writeFileSync(join(root, '.hq/config.json'), JSON.stringify({ ownerUser: userInfo().username }));
      const execFileImpl = async () => {
        if (scenario.error) throw scenario.error;
        return { stdout: JSON.stringify(scenario.payload) };
      };
      const options = { hqRoot: root, producerClass: 'closer-hammer',
        logger: { warn() {} }, env: { HQ_ROOT: scenario.finalization ? root : undefined, GHA_ADAPTER_BIN: '/fixture/github-adapter' },
        execFileImpl, recordReceipt: scenario.recordReceipt };
      if (scenario.finalization) {
        const { createGithubAdapterMergeSurface } = await import('../src/finalization/execution-surfaces.mjs');
        const result = await createGithubAdapterMergeSurface(options).merge({
          subjectExternalId: 'test/repo#7', revisionRef: 'a'.repeat(40),
        });
        assert.equal(result.ok, true);
        assert.equal(result.payload.idempotent, true);
      } else {
        const result = writeAdapterPullRequestMerge('test/repo', 7, { matchHeadCommit: 'a'.repeat(40) }, options);
        if (scenario.error) await assert.rejects(result, error => error === scenario.error);
        else await result;
      }
      const directory = join(root, 'dispatch/audit/automation-merge-actions');
      const receipts = fs.existsSync(directory) ? readdirSync(directory) : [];
      assert.equal(receipts.length, scenario.receipts);
      if (receipts.length) {
        const receipt = JSON.parse(readFileSync(join(directory, receipts[0])));
        assert.equal(receipt.merged, false);
        assert.equal(receipt.producerClass, 'closer-hammer');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const reason of ['github-gate-read-failed', 'github-gate-timeout', 'merge-retry-budget-exhausted',
  'primary-change-unknown', 'unclassified-merge-failure', 'merge-confirmation-read-failed-after-merge-accepted']) {
  test(`hammer receipt CLI excludes ${reason}`, async () => {
    const { spawnSync } = await import('node:child_process');
    const root = mkdtempSync(join(tmpdir(), 'hammer-no-refusal-'));
    try {
      const result = spawnSync(process.execPath, [new URL('../bin/merge-action-receipt.mjs', import.meta.url).pathname,
        root, 'test/repo', '7', 'a'.repeat(40), 'refused', reason], { timeout: 5000 });
      assert.equal(result.status, 0, String(result.stderr));
      assert.deepEqual(readdirSync(root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

for (const mode of [0o775, 0o777]) {
  test(`receipt parent mode ${mode.toString(8)} preserves leaf trust`, () => {
    const root = mkdtempSync(join(tmpdir(), 'shared-audit-'));
    try {
      mkdirSync(join(root, '.hq'));
      writeFileSync(join(root, '.hq/config.json'), JSON.stringify({ ownerUser: userInfo().username }));
      mkdirSync(join(root, 'dispatch/audit'), { recursive: true });
      fs.chmodSync(join(root, 'dispatch/audit'), mode);
      const args = { hqRoot: root, repo: 'test/repo', prNumber: 7, headSha: 'a'.repeat(40), merged: true };
      if (mode === 0o777) assert.throws(() => writeMergeActionReceipt(args), /Untrusted/);
      else {
        assert.ok(writeMergeActionReceipt(args));
        fs.chmodSync(join(root, 'dispatch/audit/automation-merge-actions'), 0o775);
        assert.throws(() => writeMergeActionReceipt(args), /Untrusted/);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('repeated publication failure emits one loud alert until recovery', () => {
  const messages = [];
  const args = { hqRoot: '/nonexistent-receipt-test', repo: 'test/repo', prNumber: 7 };
  const logger = { warn() {}, error(message) { messages.push(message); } };
  for (let i = 0; i < 4; i++) assert.equal(recordMergeActionBestEffort(args, logger), null);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /ALERT/);
});

for (const reason of ['stale-head', 'unclassified', 'merge-refused-retryable']) {
  test(`receipt writer rejects ${reason} at shared publication boundary`, () => {
    assert.throws(() => writeMergeActionReceipt({ hqRoot: '/unused', repo: 'test/repo', prNumber: 7,
      headSha: 'a'.repeat(40), merged: false, reason }), /Invalid/);
  });
}
