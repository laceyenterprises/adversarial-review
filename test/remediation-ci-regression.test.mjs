import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inspectRemediationCiRegression,
  summarizeExternalChecks,
} from '../src/remediation-ci-regression.mjs';

const EMPTY_CFG = { requiredCheckContexts: [] };

test('summarizeExternalChecks ignores the adversarial self-gate and reports external CI failures', () => {
  const summary = summarizeExternalChecks([
    {
      __typename: 'StatusContext',
      context: 'agent-os/adversarial-gate',
      state: 'FAILURE',
      targetUrl: 'https://example.invalid/self-gate',
    },
    {
      __typename: 'CheckRun',
      name: 'Ruff',
      conclusion: 'FAILURE',
      workflowName: 'repo-guards',
      detailsUrl: 'https://example.invalid/ruff',
    },
    {
      __typename: 'CheckRun',
      name: 'unit tests',
      conclusion: 'SUCCESS',
    },
  ], { cfg: EMPTY_CFG });

  assert.equal(summary.conclusion, 'FAILURE');
  assert.equal(summary.totalExternalChecks, 2);
  assert.deepEqual(summary.pendingChecks, []);
  assert.deepEqual(summary.failedChecks, [{
    name: 'Ruff',
    state: 'FAILURE',
    workflowName: 'repo-guards',
    detailsUrl: 'https://example.invalid/ruff',
  }]);
});

test('summarizeExternalChecks treats unreported external states as pending', () => {
  const summary = summarizeExternalChecks([
    {
      __typename: 'CheckRun',
      name: 'repo-guards',
      status: 'IN_PROGRESS',
    },
    {
      __typename: 'StatusContext',
      context: 'custom/adversarial-gate',
      state: 'SUCCESS',
    },
  ], {
    cfg: EMPTY_CFG,
    env: { ADV_GATE_STATUS_CONTEXT: 'custom/adversarial-gate' },
  });

  assert.equal(summary.conclusion, 'PENDING');
  assert.equal(summary.totalExternalChecks, 1);
  assert.equal(summary.pendingChecks[0].name, 'repo-guards');
  assert.deepEqual(summary.failedChecks, []);
});

test('inspectRemediationCiRegression fetches PR checks and returns failed state details', async () => {
  const calls = [];
  const result = await inspectRemediationCiRegression({
    repo: 'laceyenterprises/agent-os',
    prNumber: 6599,
    cfg: EMPTY_CFG,
    execFileImpl: async (bin, args) => {
      calls.push({ bin, args });
      return {
        stdout: JSON.stringify({
          headRefOid: 'abc123',
          statusCheckRollup: [
            { __typename: 'CheckRun', name: 'repo-guards', conclusion: 'FAILURE' },
          ],
        }),
      };
    },
    log: { warn() {} },
  });

  assert.equal(calls[0].bin, 'gh');
  assert.deepEqual(calls[0].args, [
    'pr',
    'view',
    '6599',
    '--repo',
    'laceyenterprises/agent-os',
    '--json',
    'headRefOid,statusCheckRollup',
  ]);
  assert.equal(result.state, 'failed');
  assert.equal(result.headSha, 'abc123');
  assert.equal(result.failedChecks[0].name, 'repo-guards');
});
