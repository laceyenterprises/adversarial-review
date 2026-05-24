import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyTicketPipelinePause,
  parseArgs,
  setRepoTicketPipelinePause,
} from '../src/ticket-pipeline-pause.mjs';
import {
  TICKET_PIPELINE_PAUSED_LABEL,
  repoPausePath,
  resolveTicketPipelinePauseRoot,
} from '../src/adapters/operator/linear-triage/index.mjs';

test('parseArgs defaults to PR scope when --pr is present and repo scope otherwise', () => {
  assert.deepEqual(parseArgs([
    '--repo',
    'laceyenterprises/adversarial-review',
    '--pr=149',
    'pause',
    'ticket',
  ]), {
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 149,
    scope: 'pr',
    resume: false,
    reason: 'pause ticket',
  });
  assert.deepEqual(parseArgs([
    '--repo=laceyenterprises/adversarial-review',
    '--scope',
    'repo',
    '--resume',
  ]), {
    repo: 'laceyenterprises/adversarial-review',
    prNumber: null,
    scope: 'repo',
    resume: true,
    reason: 'Operator resumed ticket pipeline.',
  });
});

test('applyTicketPipelinePause creates the label and applies it to one PR', async () => {
  const calls = [];
  const result = await applyTicketPipelinePause({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 149,
    scope: 'pr',
    reason: 'Linear outage',
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(result.prLabelUpdated, true);
  assert.equal(result.repoPauseUpdated, false);
  assert.equal(result.label, TICKET_PIPELINE_PAUSED_LABEL);
  assert.deepEqual(calls, [
    {
      cmd: 'gh',
      args: [
        'label',
        'create',
        TICKET_PIPELINE_PAUSED_LABEL,
        '--repo',
        'laceyenterprises/adversarial-review',
        '--description',
        'Pause adversarial-review Linear ticket pipeline sync for this PR',
        '--color',
        'f9d0c4',
        '--force',
      ],
    },
    {
      cmd: 'gh',
      args: [
        'pr',
        'edit',
        '149',
        '--repo',
        'laceyenterprises/adversarial-review',
        '--add-label',
        TICKET_PIPELINE_PAUSED_LABEL,
      ],
    },
  ]);
});

test('applyTicketPipelinePause supports repo-wide durable pause and resume', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const pause = await applyTicketPipelinePause({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    scope: 'repo',
    reason: 'Linear maintenance',
    requestedAt: '2026-05-24T15:40:00.000Z',
    requestedBy: 'placey',
    env: {},
  });

  assert.equal(pause.repoPauseUpdated, true);
  assert.equal(pause.repoPausePath, repoPausePath(rootDir, 'laceyenterprises/adversarial-review'));
  assert.equal(existsSync(pause.repoPausePath), true);
  const record = JSON.parse(readFileSync(pause.repoPausePath, 'utf8'));
  assert.equal(record.paused, true);
  assert.equal(record.reason, 'Linear maintenance');

  const resume = await applyTicketPipelinePause({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    scope: 'repo',
    resume: true,
    env: {},
  });
  assert.equal(resume.paused, false);
  assert.equal(existsSync(pause.repoPausePath), false);
});

test('repo-wide pause prefers the shared HQ_ROOT checkout when present', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-worktree-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const pauseRootDir = resolveTicketPipelinePauseRoot(rootDir, { HQ_ROOT: hqRoot });
  const pause = await applyTicketPipelinePause({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    scope: 'repo',
    reason: 'Linear outage',
    env: { HQ_ROOT: hqRoot },
  });

  assert.equal(pause.repoPauseRootDir, pauseRootDir);
  assert.equal(pause.repoPausePath, repoPausePath(pauseRootDir, 'laceyenterprises/adversarial-review'));
  assert.equal(existsSync(pause.repoPausePath), true);
});

test('setRepoTicketPipelinePause returns path even when resuming an absent pause', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const result = setRepoTicketPipelinePause({
    rootDir,
    repo: 'laceyenterprises/adversarial-review',
    paused: false,
    env: {},
  });

  assert.equal(result.paused, false);
  assert.equal(result.filePath, repoPausePath(rootDir, 'laceyenterprises/adversarial-review'));
});
