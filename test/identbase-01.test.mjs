import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkspaceForJob } from '../src/follow-up-remediation.mjs';
import { isTerminalCloserCommitIdentity, getHeadCloserCommitSuppression } from '../src/head-closer-commit-suppression.mjs';

test('IDENTBASE-01: foreign closer committer never suppresses a worker author', () => {
  for (const message of ['worker fix', 'worker fix\n\nWorker-Ticket: HAM-123']) {
    assert.equal(isTerminalCloserCommitIdentity({
      author: { login: 'lacey-codex-agent[bot]' },
      committer: { login: 'the-hammer-lacey[bot]' },
      commit: { message },
    }).suppressed, false);
  }
});

test('IDENTBASE-01: closer author needs HAM provenance; explicit closure trailers still suppress', () => {
  const author = { login: 'the-hammer-lacey[bot]' };
  assert.equal(isTerminalCloserCommitIdentity({ author, message: 'ordinary commit' }).suppressed, false);
  for (const ticket of ['HAM', 'HAM-123']) {
    assert.equal(isTerminalCloserCommitIdentity({ author, message: `repair\n\nWorker-Ticket: ${ticket}` }).suppressed, true);
  }
  assert.equal(isTerminalCloserCommitIdentity({ author, message: 'repair\n\nWorker-Ticket: HAMMER' }).suppressed, false);
  assert.equal(isTerminalCloserCommitIdentity({ message: 'repair\n\nClosed-By: hammer' }).suppressed, true);
});

test('IDENTBASE-01: watcher remote probe reads author plus HAM trailer, ignoring committer', async () => {
  for (const [authorLogin, message, expected] of [
    ['lacey-codex-agent[bot]', 'worker fix', false],
    ['the-hammer-lacey[bot]', 'repair\n\nWorker-Ticket: HAM-123', true],
  ]) {
    const result = await getHeadCloserCommitSuppression({
      repoPath: 'fixture/repo', headSha: 'a'.repeat(40),
      fetchVerifiedCommitFromLocalGitImpl: async () => null,
      execGhWithRetryImpl: async ({ args }) => {
        assert.match(args.at(-1), /authorLogin:\.author\.login/);
        return { stdout: JSON.stringify({ authorLogin, message, committerLogin: 'the-hammer-lacey[bot]' }) };
      },
    });
    assert.equal(result.suppressed, expected);
  }
});

test('IDENTBASE-01: remediation identity writes only the linked worktree config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'identbase-writer-'));
  const base = join(root, 'base');
  const sibling = join(root, 'sibling');
  const git = (...args) => execFileSync('git', args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  });
  try {
    git('init', '--quiet', '-b', 'main', base);
    git('-C', base, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture');
    git('-C', base, 'config', '--local', 'user.name', 'Foreign Closer');
    git('-C', base, 'config', '--local', 'user.email', 'closer@example.invalid');
    git('-C', base, 'worktree', 'add', '--detach', sibling);
    const result = await prepareWorkspaceForJob({
      rootDir: root,
      workerClass: 'codex',
      job: { jobId: 'identbase-fixture', repo: 'fixture/repo', prNumber: 1 },
      execFileImpl: async (command, args) => {
        if (command === 'gh') return { stdout: JSON.stringify({
          base: { ref: 'main' }, head: { ref: 'feature', repo: { full_name: 'fixture/repo' } },
        }) };
        if (command === 'git' && args[0] === 'clone') {
          git('-C', base, 'worktree', 'add', '-b', 'feature', args.at(-1));
        } else if (command === 'git' && args[2] === 'config') {
          return { stdout: git(...args) };
        }
        return { stdout: '', stderr: '' };
      },
      log() {},
    });
    assert.equal(git('-C', base, 'config', '--local', 'user.name').trim(), 'Foreign Closer');
    assert.equal(git('-C', base, 'config', '--local', 'user.email').trim(), 'closer@example.invalid');
    assert.equal(git('-C', sibling, 'config', 'user.name').trim(), 'Foreign Closer');
    assert.equal(git('-C', result.workspaceDir, 'config', '--worktree', 'user.name').trim(), 'Codex Remediation Worker');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
