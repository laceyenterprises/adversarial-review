import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isHamWorkerTicket } from '../src/ama/ham-provenance.mjs';
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
  for (const ticket of ['HAM', 'AMA-PR-42']) {
    assert.equal(isTerminalCloserCommitIdentity({ author, message: `repair\n\nWorker-Ticket: ${ticket}` }).suppressed, true);
  }
  assert.equal(isTerminalCloserCommitIdentity({ author, message: 'repair\n\nWorker-Ticket: HAMMER' }).suppressed, false);
  assert.equal(isTerminalCloserCommitIdentity({ message: 'repair\n\nClosed-By: hammer' }).suppressed, true);
});

test('IDENTBASE-01: watcher remote probe reads author plus HAM trailer, ignoring committer', async () => {
  for (const [authorLogin, message, expected] of [
    ['lacey-codex-agent[bot]', 'worker fix', false],
    ['lacey-codex-agent[bot]', 'worker fix\n\nWorker-Ticket: HAM', false],
    ['the-hammer-lacey[bot]', 'repair\n\nWorker-Ticket: HAM', true],
    ['the-hammer-lacey[bot]', 'repair\n\nWorker-Ticket: HAM-123', false],
    ['the-hammer-lacey[bot]', 'repair\n\nWorker-Ticket: AMA-PR-42', true],
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

// This deliberately injects unsupported metadata to exercise the defensive guard;
// production cloneRemediationWorkspace always creates a standalone clone.
test('IDENTBASE-01: linked worktree is refused before shared config or hooks are written', async () => {
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
    const commonConfig = git('-C', base, 'config', '--local', '--list');
    await assert.rejects(prepareWorkspaceForJob({
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
    }), /requires standalone Git metadata/);
    assert.equal(git('-C', base, 'config', '--local', '--list'), commonConfig);
    assert.equal(existsSync(join(base, '.git', 'hooks', 'commit-msg')), false);
    assert.equal(git('-C', base, 'config', '--local', 'user.name').trim(), 'Foreign Closer');
    assert.equal(git('-C', base, 'config', '--local', 'user.email').trim(), 'closer@example.invalid');
    assert.equal(git('-C', sibling, 'config', 'user.name').trim(), 'Foreign Closer');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('HAM worker tickets use the documented exact forms', () => {
  for (const ticket of ['HAM', 'ham', ' AMA-PR-42 ', 'ama-pr-1']) {
    assert.equal(isHamWorkerTicket(ticket), true, ticket);
  }
  for (const ticket of [null, '', 'HAM-123', 'HAM anything', 'HAMMER', 'AMA-PR-x', 'AMA-PR-42-extra']) {
    assert.equal(isHamWorkerTicket(ticket), false, String(ticket));
    assert.equal(isTerminalCloserCommitIdentity({
      author: { login: 'the-hammer-lacey[bot]' }, message: `repair\n\nWorker-Ticket: ${ticket}`,
    }).suppressed, false);
  }
});

test('IDENTBASE-01: production standalone clone receives worktree-scoped remediation identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'identbase-clone-'));
  const base = join(root, 'base');
  const git = (...args) => execFileSync('git', args, {
    encoding: 'utf8', env: { ...process.env,
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
  });
  try {
    git('init', '--quiet', '-b', 'main', base);
    git('-C', base, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture');
    git('-C', base, 'config', '--local', 'user.name', 'Foreign Closer');
    const result = await prepareWorkspaceForJob({
      rootDir: root, env: {}, workerClass: 'codex',
      job: { jobId: 'identbase-clone', repo: 'fixture/repo', prNumber: 1 },
      execFileImpl: async (command, args) => {
        if (command === 'gh') return { stdout: JSON.stringify({
          base: { ref: 'main' }, head: { ref: 'feature', repo: { full_name: 'fixture/repo' } },
        }) };
        if (args[0] === 'clone') {
          assert.ok(args.includes('--no-checkout'));
          return { stdout: git('clone', '--no-checkout', '--single-branch', '--branch', 'main', base, args.at(-1)) };
        }
        if (args[2] === 'config') return { stdout: git(...args) };
        return { stdout: '', stderr: '' };
      }, log() {},
    });
    assert.equal(git('-C', result.workspaceDir, 'rev-parse', '--git-dir').trim(), '.git');
    assert.equal(git('-C', result.workspaceDir, 'rev-parse', '--git-common-dir').trim(), '.git');
    assert.equal(git('-C', result.workspaceDir, 'config', '--worktree', 'user.name').trim(), 'Codex Remediation Worker');
    assert.equal(git('-C', result.workspaceDir, 'config', '--worktree', 'user.email').trim(), 'codex-remediation-worker@laceyenterprises.com');
    assert.equal(git('-C', base, 'config', '--local', 'user.name').trim(), 'Foreign Closer');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
