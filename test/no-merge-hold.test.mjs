import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyNoMergeHold,
  parseArgs,
} from '../src/no-merge-hold.mjs';
import { NO_MERGE_HOLD_LABEL } from '../src/follow-up-merge-agent.mjs';

test('parseArgs supports apply and resume modes', () => {
  assert.deepEqual(parseArgs([
    '--repo',
    'laceyenterprises/agent-os',
    '--pr=401',
    'freeze',
  ]), {
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    resume: false,
    reason: 'freeze',
  });
  assert.deepEqual(parseArgs([
    '--repo=laceyenterprises/agent-os',
    '--pr',
    '401',
    '--resume',
  ]), {
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    resume: true,
    reason: 'Operator released no-merge hold.',
  });
});

test('applyNoMergeHold creates the repo label, applies it to the PR, and writes receipt', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const calls = [];
  const result = await applyNoMergeHold({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    reason: 'release freeze',
    requestedAt: '2026-05-24T16:05:00.000Z',
    requestedBy: 'placey',
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(result.held, true);
  assert.equal(result.label, NO_MERGE_HOLD_LABEL);
  assert.deepEqual(calls, [
    {
      cmd: 'gh',
      args: [
        'label',
        'create',
        NO_MERGE_HOLD_LABEL,
        '--repo',
        'laceyenterprises/agent-os',
        '--description',
        'Operator hold: block merge-agent and adversarial gate for this PR',
        '--color',
        'd93f0b',
        '--force',
      ],
    },
    {
      cmd: 'gh',
      args: [
        'pr',
        'edit',
        '401',
        '--repo',
        'laceyenterprises/agent-os',
        '--add-label',
        NO_MERGE_HOLD_LABEL,
      ],
    },
  ]);
  assert.equal(existsSync(result.receiptPath), true);
  const receipt = JSON.parse(readFileSync(result.receiptPath, 'utf8'));
  assert.equal(receipt.kind, 'adversarial-review-no-merge-hold');
  assert.equal(receipt.held, true);
  assert.equal(receipt.reason, 'release freeze');
});

test('applyNoMergeHold removes the label on resume without recreating it', async () => {
  const calls = [];
  const result = await applyNoMergeHold({
    rootDir: mkdtempSync(path.join(tmpdir(), 'adversarial-review-')),
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    resume: true,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(result.held, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(-2), ['--remove-label', NO_MERGE_HOLD_LABEL]);
});
