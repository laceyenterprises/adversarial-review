import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { writeMergeActionReceipt } from '../src/ama/merge-action-receipt.mjs';

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
    writeFileSync(gh, '#!/bin/sh\nprintf \'%s\\n\' "$STUB_PR"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${root}:${process.env.PATH}`,
      STUB_PR: JSON.stringify({ state: 'MERGED', headRefOid: 'a'.repeat(40), mergedAt: new Date().toISOString() }) };
    const args = [cli.pathname, root, 'test/repo', '7', 'a'.repeat(40)];
    assert.equal(spawnSync(process.execPath, [...args, 'merged'], { env }).status, 0);
    assert.equal(spawnSync(process.execPath, [...args, 'refused', 'primary-change-reverted'], { env }).status, 0);
    assert.equal(readdirSync(join(root, 'dispatch/audit/automation-merge-actions')).length, 2);
    env.STUB_PR = JSON.stringify({ state: 'OPEN', headRefOid: 'a'.repeat(40) });
    assert.notEqual(spawnSync(process.execPath, [...args, 'merged'], { env }).status, 0);
    assert.equal(readdirSync(join(root, 'dispatch/audit/automation-merge-actions')).length, 2);
    writeFileSync(join(root, '.hq/config.json'), JSON.stringify({ ownerUser: 'other-owner' }));
    env.HQ_WORKER_ID = 'worker-1';
    env.HQ_LAUNCH_REQUEST_ID = 'lrq-1';
    assert.equal(spawnSync(process.execPath, [...args, 'refused', 'predicate-not-eligible'], { env }).status, 0);
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
        if (refuse) throw new Error('head mismatch');
        return { stdout: JSON.stringify({ ok: true }) };
      } };
    await writeAdapterPullRequestMerge('test/repo', 7, { matchHeadCommit: 'a'.repeat(40) }, options);
    refuse = true;
    await assert.rejects(writeAdapterPullRequestMerge('test/repo', 7, { matchHeadCommit: 'a'.repeat(40) }, options), /head mismatch/);
    const actions = readdirSync(join(root, 'dispatch/audit/automation-merge-actions')).map(name => JSON.parse(readFileSync(join(root, 'dispatch/audit/automation-merge-actions', name))));
    assert.equal(actions.length, 2);
    assert.deepEqual(actions.map(a => a.merged).sort(), [false, true]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
