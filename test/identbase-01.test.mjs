import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, mkdirSync, symlinkSync, readdirSync, lstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preserveUnsafeWorkspaceMetadata } from '../src/workspace-identity.mjs';
import { hamCommitIdentityMatches, isHamWorkerTicket } from '../src/ama/ham-provenance.mjs';
import { prepareWorkspaceForJob } from '../src/follow-up-remediation.mjs';
import { isTerminalCloserCommitIdentity, getHeadCloserCommitSuppression, normalizeVerifiedCloserCommit } from '../src/head-closer-commit-suppression.mjs';

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

test('IDENTBASE-01: watcher remote probe checks both linked identities', async () => {
  for (const [authorLogin, committerLogin, message, expected] of [
    ['lacey-codex-agent[bot]', 'the-hammer-lacey[bot]', 'worker fix', false],
    ['lacey-codex-agent[bot]', 'the-hammer-lacey[bot]', 'worker fix\n\nWorker-Ticket: HAM', false],
    ['the-hammer-lacey[bot]', 'the-hammer-lacey[bot]', 'repair\n\nWorker-Ticket: HAM', true],
    ['the-hammer-lacey[bot]', 'some-human-contributor', 'repair\n\nWorker-Ticket: HAM', false],
    ['the-hammer-lacey[bot]', null, 'repair\n\nWorker-Ticket: HAM', true],
    [null, 'the-hammer-lacey[bot]', 'repair\n\nWorker-Ticket: HAM', false],
    ['the-hammer-lacey[bot]', 'the-hammer-lacey[bot]', 'repair\n\nWorker-Ticket: HAM-123', false],
    ['the-hammer-lacey[bot]', 'the-hammer-lacey[bot]', 'repair\n\nWorker-Ticket: AMA-PR-42', true],
  ]) {
    const result = await getHeadCloserCommitSuppression({
      repoPath: 'fixture/repo', headSha: 'a'.repeat(40),
      fetchVerifiedCommitFromLocalGitImpl: async () => null,
      execGhWithRetryImpl: async ({ args }) => {
        assert.match(args.at(-1), /authorLogin:\.author\.login/);
        assert.match(args.at(-1), /committerLogin:\.committer\.login/);
        return { stdout: JSON.stringify({ authorLogin, message, committerLogin }) };
      },
    });
    assert.equal(result.suppressed, expected);
  }
});

test('remote closure trailers cannot suppress linked foreign or unidentified commits', async () => {
  for (const trailer of ['Closed-By: hammer', 'Closer: merge-agent-lacey']) {
    for (const [authorLogin, committerLogin, expected] of [
      ['lacey-codex-agent[bot]', 'the-hammer-lacey[bot]', false],
      ['the-hammer-lacey[bot]', 'some-human-contributor', false],
      ['the-hammer-lacey[bot]', null, true],
      [null, 'the-hammer-lacey[bot]', false],
      [null, null, false],
    ]) {
      const message = `repair\n\n${trailer}`;
      const result = await getHeadCloserCommitSuppression({
        repoPath: 'fixture/repo', headSha: 'a'.repeat(40),
        fetchVerifiedCommitFromLocalGitImpl: async () => null,
        execGhWithRetryImpl: async () => ({ stdout: JSON.stringify({ authorLogin, committerLogin, message }) }),
      });
      assert.equal(result.suppressed, expected, `${trailer}: ${authorLogin}/${committerLogin}`);
      // Normalized GitHub evidence must not lose a known foreign identity.
      const normalized = normalizeVerifiedCloserCommit({
        author: { login: authorLogin }, committer: { login: committerLogin }, message,
      });
      assert.equal(isTerminalCloserCommitIdentity(normalized, { requireLinkedIdentity: true }).suppressed, expected);
    }
  }
});

test('local terminal trailers retain offline suppression; remote legacy HAM needs full provenance', async () => {
  const message = 'repair\n\nWorker-Class: hammer\nWorker-Ticket: AMA-PR-42\nClosed-By: hammer (adversarial-pipe-mode)';
  const local = await getHeadCloserCommitSuppression({
    repoPath: 'fixture/repo', headSha: 'a'.repeat(40),
    fetchVerifiedCommitFromLocalGitImpl: async () => ({ message }),
    execGhWithRetryImpl: async () => { throw new Error('local suppression must remain offline'); },
  });
  assert.equal(local.suppressed, true);
  const remote = await getHeadCloserCommitSuppression({
    repoPath: 'fixture/repo', headSha: 'a'.repeat(40),
    fetchVerifiedCommitFromLocalGitImpl: async () => null,
    execGhWithRetryImpl: async () => ({ stdout: JSON.stringify({ message, committerLogin: 'the-hammer-lacey[bot]' }) }),
  });
  assert.equal(remote.suppressed, true);
});

test('HAM identity rejects linked foreign identities even with full terminal trailers', () => {
  const message = 'repair\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nClosed-By: hammer (adversarial-pipe-mode)';
  for (const [author, committer, expected] of [
    ['the-hammer-lacey[bot]', 'some-human-contributor', false],
    ['codex-worker-bot', 'the-hammer-lacey[bot]', false],
    ['the-hammer-lacey[bot]', 'merge-agent-lacey', true],
    ['the-hammer-lacey[bot]', null, true],
    [null, 'the-hammer-lacey[bot]', true],
    [null, null, false],
  ]) {
    for (const wrap of [value => value, value => ({ login: value })]) {
      assert.equal(hamCommitIdentityMatches({ author: wrap(author), committer: wrap(committer), message }), expected);
    }
  }
  for (const trailer of ['Worker-Class: hammer', 'Worker-Ticket: HAM', 'Closed-By: hammer (adversarial-pipe-mode)']) {
    assert.equal(hamCommitIdentityMatches({ author: null, committer: 'the-hammer-lacey[bot]',
      message: message.replace(trailer, '') }), false, trailer);
  }
});

test('closer identity accepts normalized strings and rejects foreign committers', () => {
  for (const [committer, expected] of [['the-hammer-lacey[bot]', true], [null, true], ['some-human-contributor', false]]) {
    const raw = { author: { login: 'the-hammer-lacey[bot]' }, committer: { login: committer },
      commit: { message: 'repair\n\nWorker-Ticket: HAM' } };
    assert.equal(isTerminalCloserCommitIdentity(raw).suppressed, expected);
    assert.equal(isTerminalCloserCommitIdentity(normalizeVerifiedCloserCommit(raw)).suppressed, expected);
  }
});

test('merge-agent finalize commits with production PR tickets remain reviewable', () => {
  const commit = { author: { login: 'merge-agent-lacey' }, committer: { login: 'merge-agent-lacey' },
    message: 'Finalize PR\n\nWorker-Class: merge-agent\nWorker-Ticket: PR-1223' };
  assert.deepEqual(isTerminalCloserCommitIdentity(commit), { suppressed: false, reason: null });
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


test('generic hammer trailer is not a linked GitHub closer login', () => {
  for (const author of ['hammer', 'HAMMER']) {
    assert.equal(isTerminalCloserCommitIdentity({ author: { login: author },
      message: 'repair\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nClosed-By: hammer (adversarial-pipe-mode)',
    }).suppressed, false);
  }
  assert.equal(isTerminalCloserCommitIdentity({ message: 'repair\n\nClosed-By: hammer' }).suppressed, true);
});

test('every reversal-authorizing split commit is instructed to carry verifier provenance', () => {
  const prompt = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  const block = prompt.match(/Every commit carrying `Reversal-Authorized-By`,[\s\S]*?```text\n([\s\S]*?)```/);
  assert.ok(block);
  assert.match(block[0], /including each split commit/);
  assert.equal(hamCommitIdentityMatches({ committer: { login: 'the-hammer-lacey[bot]' }, message: `repair\n\n${block[1].trim()}` }), true);
});

test('workspace symlink is preserved without Git touching its target, even when broken', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'identbase-symlink-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const broken of [false, true]) {
    const target = join(root, broken ? 'absent' : 'target');
    if (!broken) mkdirSync(target);
    const jobId = broken ? 'broken' : 'existing';
    const workspaceDir = join(root, jobId);
    symlinkSync(target, workspaceDir);
    assert.equal(await preserveUnsafeWorkspaceMetadata({ workspaceDir, workspaceRootDir: root,
      jobId, repo: 'fixture/repo', execFileImpl: async () => { throw new Error('must not call git'); }, log: { warn() {} },
    }), 'workspace-symlink');
    assert.equal(lstatSync(workspaceDir, { throwIfNoEntry: false }), undefined);
    assert.ok(lstatSync(join(root, readdirSync(root).find(name => name.startsWith(`${jobId}.resume-backup-`)))).isSymbolicLink());
    assert.equal(existsSync(target), !broken);
  }
});

test('unknown remote with leftover registrations is preserved for daemon recovery', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'identbase-unknown-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspaceDir = join(root, 'job');
  mkdirSync(join(workspaceDir, '.git', 'worktrees'), { recursive: true });
  assert.equal(await preserveUnsafeWorkspaceMetadata({ workspaceDir, workspaceRootDir: root,
    jobId: 'job', repo: 'fixture/repo', execFileImpl: async () => { throw new Error('missing origin'); }, log: { warn() {} },
  }), 'leftover-worktree-registrations');
  assert.equal(existsSync(workspaceDir), false);
  assert.ok(readdirSync(root).some(name => name.startsWith('job.resume-backup-')));
});
