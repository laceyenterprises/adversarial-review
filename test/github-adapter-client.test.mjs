import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  adapterArgs,
  callGitHubAdapter,
  resolveGitHubAdapterBin,
} from '../src/github-adapter-client.mjs';

test('GitHub adapter binary discovery honors configured env vars first', async () => {
  assert.equal(
    await resolveGitHubAdapterBin({
      env: {
        GHA_ADAPTER_BIN: '/tmp/gha-adapter',
        AGENT_OS_GITHUB_ADAPTER_BIN: '/tmp/agent-os-adapter',
      },
      canExecute: async () => false,
    }),
    '/tmp/gha-adapter'
  );

  assert.equal(
    await resolveGitHubAdapterBin({
      env: { AGENT_OS_GITHUB_ADAPTER_BIN: '/tmp/agent-os-adapter' },
      canExecute: async () => false,
    }),
    '/tmp/agent-os-adapter'
  );
});

test('GitHub adapter binary discovery checks the superproject module path', async () => {
  const cwd = '/tmp/superproject';
  const expected = path.resolve(cwd, 'modules/github-adapter/bin/github-adapter');
  assert.equal(
    await resolveGitHubAdapterBin({
      cwd,
      env: {},
      canExecute: async (candidate) => candidate === expected,
    }),
    expected
  );
});

test('GitHub adapter call builds stable args and unwraps ok/data envelopes', async () => {
  const calls = [];
  const result = await callGitHubAdapter('pr-rollup', {
    repo: 'owner/repo',
    prNumber: 7,
    headSha: 'abc',
    labelName: 'operator-approved',
    limit: 5,
    withLabels: false,
  }, {
    env: { GHA_ADAPTER_BIN: '/tmp/adapter' },
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: '{"ok":true,"data":{"number":7}}' };
    },
  });

  assert.deepEqual(adapterArgs('pr-rollup', {
    repo: 'owner/repo',
    prNumber: 7,
    headSha: 'abc',
    labelName: 'operator-approved',
    limit: 5,
    withLabels: false,
  }), [
    'pr-rollup',
    '--repo', 'owner/repo',
    '--pr', '7',
    '--head-sha', 'abc',
    '--label', 'operator-approved',
    '--limit', '5',
    '--no-labels',
  ]);
  assert.equal(result.available, true);
  assert.deepEqual(result.data, { number: 7 });
  assert.equal(calls[0].command, '/tmp/adapter');
});
