import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { preserveRemediationHeadBundle } from '../src/follow-up-remediation.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('validated unpushed remediation commit is recoverable after worktree removal', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'remediation-rescue-root-'));
  const hqRoot = mkdtempSync(join(tmpdir(), 'remediation-rescue-hq-'));
  const workspaceDir = mkdtempSync(join(tmpdir(), 'remediation-rescue-worktree-'));
  const remoteDir = mkdtempSync(join(tmpdir(), 'remediation-rescue-remote-'));
  const restoreDir = mkdtempSync(join(tmpdir(), 'remediation-rescue-restore-'));
  try {
    git(workspaceDir, ['init']);
    git(workspaceDir, ['config', 'user.name', 'Test Remediator']);
    git(workspaceDir, ['config', 'user.email', 'test-remediator@example.invalid']);
    writeFileSync(join(workspaceDir, 'base.txt'), 'reviewed base\n', 'utf8');
    git(workspaceDir, ['add', 'base.txt']);
    git(workspaceDir, ['commit', '-m', 'reviewed base']);
    git(remoteDir, ['init', '--bare']);
    git(workspaceDir, ['remote', 'add', 'origin', remoteDir]);
    git(workspaceDir, ['push', '-u', 'origin', 'HEAD:main']);

    writeFileSync(join(workspaceDir, 'fix.txt'), 'validated fix\n', 'utf8');
    git(workspaceDir, ['add', 'fix.txt']);
    git(workspaceDir, ['commit', '-m', 'validated remediation']);
    const headSha = git(workspaceDir, ['rev-parse', 'HEAD']);
    const rescueRoot = join(hqRoot, 'remediation-rescue');
    mkdirSync(rescueRoot, { recursive: true });
    const staleBundle = join(rescueRoot, 'stale.bundle');
    writeFileSync(staleBundle, 'stale full-history bundle\n', 'utf8');
    const staleTime = new Date('2026-09-01T20:00:00.000Z');
    utimesSync(staleBundle, staleTime, staleTime);

    const rescue = await preserveRemediationHeadBundle({
      rootDir,
      hqRoot,
      job: {
        jobId: 'job-auth',
        repo: 'laceyenterprises/agent-os',
        prNumber: 6755,
      },
      workspaceDir,
      reason: 'github-auth-operational-blocker',
      now: () => '2026-09-13T20:00:00.000Z',
    });

    assert.equal(rescue.ok, true);
    assert.equal(rescue.headSha, headSha);
    assert.equal(existsSync(rescue.bundlePath), true);
    assert.equal(existsSync(staleBundle), false);

    rmSync(workspaceDir, { recursive: true, force: true });
    git(restoreDir, ['init']);
    git(restoreDir, ['remote', 'add', 'origin', remoteDir]);
    git(restoreDir, ['fetch', 'origin', 'main']);
    git(restoreDir, ['fetch', rescue.bundlePath, headSha]);
    const restoredSha = git(restoreDir, ['rev-parse', 'FETCH_HEAD^{commit}']);
    assert.equal(restoredSha, headSha);
    assert.equal(git(restoreDir, ['rev-list', '--count', 'FETCH_HEAD', '--not', 'origin/main']), '1');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
    rmSync(restoreDir, { recursive: true, force: true });
  }
});

test('rescue bundle fallback stays under ignored data when HQ_ROOT is unavailable', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'remediation-rescue-root-'));
  const workspaceDir = mkdtempSync(join(tmpdir(), 'remediation-rescue-worktree-'));
  const previousHqRoot = process.env.HQ_ROOT;
  try {
    delete process.env.HQ_ROOT;
    git(workspaceDir, ['init']);
    git(workspaceDir, ['config', 'user.name', 'Test Remediator']);
    git(workspaceDir, ['config', 'user.email', 'test-remediator@example.invalid']);
    writeFileSync(join(workspaceDir, 'fix.txt'), 'validated fix\n', 'utf8');
    git(workspaceDir, ['add', 'fix.txt']);
    git(workspaceDir, ['commit', '-m', 'validated remediation']);

    const rescue = await preserveRemediationHeadBundle({
      rootDir,
      job: {
        jobId: 'job-auth',
        repo: 'laceyenterprises/agent-os',
        prNumber: 6755,
      },
      workspaceDir,
      reason: 'github-auth-operational-blocker',
      now: () => '2026-09-13T20:00:00.000Z',
    });

    assert.equal(rescue.ok, true);
    assert.equal(rescue.bundlePath.startsWith(join(rootDir, 'data', 'remediation-rescue')), true);
    assert.equal(existsSync(join(rootDir, 'remediation-rescue')), false);
  } finally {
    if (previousHqRoot === undefined) {
      delete process.env.HQ_ROOT;
    } else {
      process.env.HQ_ROOT = previousHqRoot;
    }
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
