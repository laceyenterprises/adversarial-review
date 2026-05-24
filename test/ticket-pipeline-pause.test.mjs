import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyTicketPipelinePause,
  ensureRepoPauseRootConfirmed,
  parseArgs,
  setRepoTicketPipelinePause,
} from '../src/ticket-pipeline-pause.mjs';
import {
  TICKET_PIPELINE_PAUSED_LABEL,
  persistTicketPipelinePauseRootStatus,
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
    rootDir: path.join(path.dirname(new URL(import.meta.url).pathname), '..'),
    confirmLiveRoot: false,
    reason: 'pause ticket',
  });
  assert.deepEqual(parseArgs([
    '--repo=laceyenterprises/adversarial-review',
    '--scope',
    'repo',
    '--root',
    '/srv/adversarial-review',
    '--confirm-live-root',
    '--resume',
  ]), {
    repo: 'laceyenterprises/adversarial-review',
    prNumber: null,
    scope: 'repo',
    resume: true,
    rootDir: '/srv/adversarial-review',
    confirmLiveRoot: true,
    reason: 'Operator resumed ticket pipeline.',
  });
});

test('ensureRepoPauseRootConfirmed refuses unconfirmed repo-scope writes and returns the resolved root once confirmed', () => {
  const worktreeRoot = mkdtempSync(path.join(tmpdir(), 'adversarial-review-worktree-'));
  assert.throws(
    () => ensureRepoPauseRootConfirmed({
      rootDir: worktreeRoot,
      scope: 'repo',
      env: {},
    }),
    /--confirm-live-root/
  );
  assert.equal(
    ensureRepoPauseRootConfirmed({
      rootDir: worktreeRoot,
      scope: 'repo',
      confirmLiveRoot: true,
      env: {},
    }),
    worktreeRoot
  );
});

test('ensureRepoPauseRootConfirmed refuses repo-scope writes that diverge from daemon root status', () => {
  const worktreeRoot = mkdtempSync(path.join(tmpdir(), 'adversarial-review-worktree-'));
  const daemonHqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  persistTicketPipelinePauseRootStatus(worktreeRoot, {
    env: { HQ_ROOT: daemonHqRoot },
    recordedAt: '2026-05-24T16:40:00.000Z',
    pid: 111,
  });

  assert.throws(
    () => ensureRepoPauseRootConfirmed({
      rootDir: worktreeRoot,
      scope: 'repo',
      confirmLiveRoot: true,
      env: {},
    }),
    /pause root mismatch/
  );
  assert.equal(
    ensureRepoPauseRootConfirmed({
      rootDir: worktreeRoot,
      scope: 'repo',
      confirmLiveRoot: true,
      env: { HQ_ROOT: daemonHqRoot },
    }),
    resolveTicketPipelinePauseRoot(worktreeRoot, { HQ_ROOT: daemonHqRoot })
  );
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

test('applyTicketPipelinePause treats absent PR label as successful resume', async () => {
  const calls = [];
  const result = await applyTicketPipelinePause({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 149,
    scope: 'pr',
    resume: true,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      const err = new Error('HTTP 422: label does not exist');
      err.stderr = 'label does not exist';
      throw err;
    },
  });

  assert.equal(result.prLabelUpdated, true);
  assert.equal(calls.length, 1);
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
