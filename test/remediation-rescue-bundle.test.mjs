import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const restoreDir = mkdtempSync(join(tmpdir(), 'remediation-rescue-restore-'));
  try {
    git(workspaceDir, ['init']);
    git(workspaceDir, ['config', 'user.name', 'Test Remediator']);
    git(workspaceDir, ['config', 'user.email', 'test-remediator@example.invalid']);
    writeFileSync(join(workspaceDir, 'fix.txt'), 'validated fix\n', 'utf8');
    git(workspaceDir, ['add', 'fix.txt']);
    git(workspaceDir, ['commit', '-m', 'validated remediation']);
    const headSha = git(workspaceDir, ['rev-parse', 'HEAD']);

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

    rmSync(workspaceDir, { recursive: true, force: true });
    git(restoreDir, ['init']);
    git(restoreDir, ['fetch', rescue.bundlePath, headSha]);
    const restoredSha = git(restoreDir, ['rev-parse', 'FETCH_HEAD^{commit}']);
    assert.equal(restoredSha, headSha);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(restoreDir, { recursive: true, force: true });
  }
});
