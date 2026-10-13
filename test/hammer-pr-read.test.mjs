import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchHammerPr } from '../src/hammer-pr-read.mjs';
import { classifyCheckRollup } from '../src/checks-summary.mjs';

const head = 'a'.repeat(40);
const pr = { state: 'open', head: { sha: head }, labels: [], mergeable: true };

test('REST snapshot preserves the lease green assertion for runs and contexts', async () => {
  const snapshot = await fetchHammerPr('fixture/repo', 42, { read: async path => {
    if (path.includes('/check-runs?')) return { check_runs: ['success', 'neutral', 'skipped'].map(conclusion => ({
      name: conclusion, status: 'completed', conclusion,
    })) };
    if (path.includes('/statuses?')) return [{ context: 'external', state: 'success' }];
    assert.equal(path, 'repos/fixture/repo/pulls/42');
    return pr;
  } });
  assert.equal(classifyCheckRollup(snapshot.checks), 'SUCCESS');
  const source = readFileSync(new URL('../bin/hammer-verify-head.sh', import.meta.url), 'utf8');
  const filter = source.match(/if jq -e --arg head "\$POST_REMEDIATION_SHA"\s+'([^']+)'/)[1];
  const green = value => spawnSync('jq', ['-e', '--arg', 'head', head, filter], {
    input: JSON.stringify(value), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(green(snapshot).status, 0);
  for (const value of [{ ...snapshot, headRefOid: 'b'.repeat(40) }, { ...snapshot, statusCheckRollup: [] },
    { ...snapshot, statusCheckRollup: [{ __typename: 'CheckRun', status: 'QUEUED', conclusion: null }] },
    { ...snapshot, statusCheckRollup: [{ __typename: 'StatusContext', state: 'FAILURE' }] }]) {
    assert.equal(green(value).status, 1);
  }
});

test('commit statuses paginate individual contexts past 100 entries', async () => {
  const calls = [];
  const snapshot = await fetchHammerPr('fixture/repo', 42, { read: async path => {
    calls.push(path);
    assert.ok(calls.length <= 4, 'pagination must terminate');
    if (path.includes('/check-runs?')) return { check_runs: [] };
    if (path.endsWith('/statuses?per_page=100&page=1')) return Array.from({ length: 100 }, (_, i) => ({ context: `context-${i}`, state: 'success' }));
    if (path.endsWith('/statuses?per_page=100&page=2')) return [{ context: 'last', state: 'pending' }];
    assert.equal(path, 'repos/fixture/repo/pulls/42');
    return pr;
  } });
  assert.equal(snapshot.checks.length, 101);
  assert.equal(snapshot.checks.at(-1).state, 'PENDING');
  assert.equal(classifyCheckRollup(snapshot.checks), 'PENDING');
  assert.equal(calls.length, 4);
});

test('hammer PR CLI preserves synchronous jq exit status', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-pr-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'gh'), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(pr)}'\n`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/hammer-pr-read.mjs', import.meta.url)),
    'fixture/repo', '42', '--json', 'headRefOid', '--jq', 'halt_error(7)'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GHO_RATE_LIMIT_SHARED_STATE_PATH: join(dir, 'budget.json') },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 7, result.stderr);
});

test('hammer PR CLI preserves alarm status for bounded visibility retries', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-pr-alarm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nkill -ALRM $$\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/hammer-pr-read.mjs', import.meta.url)),
    'fixture/repo', '42', '--json', 'headRefOid'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GHO_RATE_LIMIT_SHARED_STATE_PATH: join(dir, 'budget.json') },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 142, result.stderr);
});
