import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, lstatSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preserveUnsafeWorkspaceMetadata } from '../src/workspace-identity.mjs';
import { preserveInvalidResumeWorkspace } from '../src/remediation-git-pr-io.mjs';
import { prepareWorkspaceForJob } from '../src/follow-up-remediation.mjs';

test('FIXTURELEAK-01: resume backups default to the workspace parent', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'identity-backup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const kind of ['redirected', 'symlink', 'invalid-resume']) {
    await t.test(kind, async () => {
      const workspaceDir = join(root, kind);
      if (kind === 'symlink') symlinkSync(join(root, 'missing-target'), workspaceDir);
      else {
        mkdirSync(workspaceDir);
        writeFileSync(join(workspaceDir, '.git'), 'gitdir: synthetic-metadata\n');
      }
      const options = { workspaceDir, jobId: kind, repo: 'fixture/repo',
        execFileImpl: async () => { throw new Error('Git must not run'); }, log: { warn() {} } };
      if (kind === 'invalid-resume') preserveInvalidResumeWorkspace({ ...options, reason: 'fixture' });
      else await preserveUnsafeWorkspaceMetadata(options);
      assert.equal(lstatSync(workspaceDir, { throwIfNoEntry: false }), undefined);
      const backups = readdirSync(root).filter(name => name.startsWith(`${kind}.resume-backup-`));
      assert.equal(backups.length, 1);
      const backup = join(root, backups[0]);
      if (kind === 'symlink') assert.ok(lstatSync(backup).isSymbolicLink());
      else assert.equal(readFileSync(join(backup, '.git'), 'utf8'), 'gitdir: synthetic-metadata\n');
    });
  }
});

test('FIXTURELEAK-01: explicit workspace root wins over inherited environment during recovery', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'identity-caller-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspaceRootDir = join(root, 'caller-workspaces');
  const fakeHqRoot = join(root, 'fake-live');
  const fakeLiveWorkspaces = join(fakeHqRoot, 'adversarial-review', 'follow-up-workspaces');
  mkdirSync(fakeLiveWorkspaces, { recursive: true });
  const workspaceDir = join(workspaceRootDir, 'fixture');
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, '.git'), 'gitdir: synthetic-metadata\n');
  await assert.rejects(prepareWorkspaceForJob({
    rootDir: root, workspaceRootDir, env: { HQ_ROOT: fakeHqRoot },
    job: { jobId: 'fixture', repo: 'fixture/repo', prNumber: 1 },
    execFileImpl: async (command, args) => {
      if (command === 'gh') return { stdout: JSON.stringify({ base: { ref: 'main' }, head: { ref: 'feature' } }) };
      if (args[0] === 'clone') throw new Error('fixture clone stopped');
      throw new Error('unexpected Git command');
    }, log: { warn() {} },
  }), /fixture clone stopped/);
  assert.equal(lstatSync(workspaceDir, { throwIfNoEntry: false }), undefined);
  assert.equal(readdirSync(workspaceRootDir).filter(name => name.startsWith('fixture.resume-backup-')).length, 1);
  assert.deepEqual(readdirSync(fakeLiveWorkspaces), []);
});
