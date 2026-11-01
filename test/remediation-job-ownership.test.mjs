import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findActiveRemediationJob } from '../src/ama/active-remediation-job.mjs';
import { remediationJobOwnership, REMEDIATION_HEARTBEAT_GRACE_MS } from '../src/remediation-job-ownership.mjs';

const NOW = '2026-01-01T01:00:00.000Z';
const subject = { repo: 'example/project', prNumber: 42 };

function fixture(t, status, worker = {}) {
  const root = mkdtempSync(join(tmpdir(), 'remediation-ownership-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const job = { ...subject, jobId: 'synthetic-job', status, createdAt: '2026-01-01T00:00:00.000Z',
    lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
    remediationWorker: { processId: 123, spawnedAt: '2026-01-01T00:00:00.000Z', ...worker } };
  const dir = join(root, 'data', 'follow-up-jobs', 'in-progress');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, 'data', 'follow-up-jobs', 'workspaces', job.jobId), { recursive: true });
  writeFileSync(join(dir, 'example__project-pr-42-synthetic.json'), JSON.stringify(job));
  return root;
}

test('a completed record in an active bucket and its leftover workspace never own closure', t => {
  const root = fixture(t, 'completed');
  assert.equal(findActiveRemediationJob(root, subject, { now: NOW }), null);
});

test('a dead remediation worker past grace does not own closure', t => {
  const root = fixture(t, 'in_progress');
  assert.equal(findActiveRemediationJob(root, subject, { now: NOW,
    verifyIdentityImpl: () => ({ match: false, gone: true }) }), null);
});

test('a worker with matching live process identity still owns closure', t => {
  const root = fixture(t, 'in_progress');
  assert.equal(findActiveRemediationJob(root, subject, { now: NOW,
    verifyIdentityImpl: () => ({ match: true }) })?.jobId,
  'synthetic-job');
});

test('fresh progress heartbeat retains a remote worker only for the bounded grace', () => {
  const now = Date.parse(NOW);
  const job = { status: 'in_progress', lastHeartbeatAt: NOW, remediationWorker: { dispatchMode: 'hq' } };
  assert.equal(remediationJobOwnership(job, { now }).live, true);
  assert.equal(remediationJobOwnership(job, { now: now + REMEDIATION_HEARTBEAT_GRACE_MS }).live, false);
  assert.equal(remediationJobOwnership({ ...job, status: 'completed' }, { now }).live, false);
  assert.equal(remediationJobOwnership({ ...job, remediationWorker: { state: 'completed' } }, { now }).live, false);
});

test('PID reuse, missing process evidence, a queued job and a future heartbeat cannot retain ownership', () => {
  for (const job of [
    { status: 'in_progress', remediationWorker: { processId: 123, spawnedAt: '2026-01-01T00:00:00Z' } },
    { status: 'pending', workspaceDir: '/synthetic/workspace' },
    { status: 'in_progress', lastHeartbeatAt: '2026-01-01T02:00:00Z' },
  ]) {
    assert.equal(remediationJobOwnership(job, { now: NOW, verifyIdentityImpl: () => ({ match: false }) }).live, false);
  }
});
