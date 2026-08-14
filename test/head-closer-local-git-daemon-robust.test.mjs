import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchVerifiedCommitFromLocalGit,
  getHeadCloserCommitSuppression,
  fetchHeadCloserVerifiedCommit,
  isTerminalCloserCommitIdentity,
} from '../src/head-closer-commit-suppression.mjs';

const HAMMER_MESSAGE = [
  'HAM remediate final adversarial findings',
  '',
  'Worker-Class: hammer',
  'Worker-Ticket: HAM',
  'Reviewed-Head: fd1ece516ecded50e2233e18cab0c07acf682ad5',
  'Closed-By: hammer (adversarial-pipe-mode)',
  'Remediated-Findings: 2 addressed (1 blocking, 1 non-blocking)',
].join('\n');

const HEAD_SHA = 'e95ce0c267ede587f453925aad6ca508f6856339';
const PARENT_SHA = '7097a3c3a0000000000000000000000000000000';
const SECOND_PARENT_SHA = '8097a3c3a0000000000000000000000000000000';

// A fake `git` execFileImpl that answers the exact commands the local reader issues.
function makeFakeGit({ message = HAMMER_MESSAGE, parent = PARENT_SHA, files = ['modules/worker-pool/lib/hq-drs.sh'], failObjectRead = false } = {}) {
  const calls = [];
  const impl = async (file, args) => {
    calls.push(args.join(' '));
    assert.equal(file, 'git');
    const joined = args.join(' ');
    if (failObjectRead && (joined.includes('show') || joined.includes('diff-tree'))) {
      const err = new Error(`fatal: bad object ${HEAD_SHA}`);
      throw err;
    }
    if (joined.includes('--format=%H %P')) return { stdout: `${HEAD_SHA} ${parent}\n` };
    if (joined.includes('--format=%x00%B')) return { stdout: `\0${message}\n` };
    if (joined.includes('diff-tree')) return { stdout: `${files.join('\n')}\n` };
    if (joined.includes('fetch')) return { stdout: '' };
    throw new Error(`unexpected git args: ${joined}`);
  };
  impl.calls = calls;
  return impl;
}

const throwingGh = async () => {
  throw new Error('gh api repos/.../commits/<sha> failed (daemon context, no interactive auth)');
};

test('fetchVerifiedCommitFromLocalGit: parses sha/parent/message/files from local git', async () => {
  const git = makeFakeGit();
  const commit = await fetchVerifiedCommitFromLocalGit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: git,
  });
  assert.equal(commit.sha, HEAD_SHA);
  assert.equal(commit.parents[0].sha, PARENT_SHA);
  assert.match(commit.message, /Closed-By: hammer \(adversarial-pipe-mode\)/);
  assert.equal(commit.files[0].filename, 'modules/worker-pool/lib/hq-drs.sh');
  // The Closed-By trailer must resolve to the terminal closer identity.
  assert.equal(isTerminalCloserCommitIdentity(commit).suppressed, true);
});

test('fetchVerifiedCommitFromLocalGit: preserves every merge parent from local git', async () => {
  const git = makeFakeGit({ parent: `${PARENT_SHA} ${SECOND_PARENT_SHA}` });
  const commit = await fetchVerifiedCommitFromLocalGit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: git,
  });
  assert.deepEqual(commit.parents, [
    { sha: PARENT_SHA },
    { sha: SECOND_PARENT_SHA },
  ]);
});

test('fetchVerifiedCommitFromLocalGit: extracts identity hashes from warning-prefixed output', async () => {
  const git = makeFakeGit();
  const originalImpl = git;
  const warningGit = async (file, args) => {
    const joined = args.join(' ');
    if (joined.includes('--format=%H %P')) {
      originalImpl.calls.push(args.join(' '));
      return {
        stdout: [
          'warning: ignoring suspicious replacement ref',
          `${HEAD_SHA} ${PARENT_SHA} ${SECOND_PARENT_SHA}`,
          '',
        ].join('\n'),
      };
    }
    return originalImpl(file, args);
  };
  warningGit.calls = originalImpl.calls;
  const commit = await fetchVerifiedCommitFromLocalGit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: warningGit,
  });
  assert.equal(commit.sha, HEAD_SHA);
  assert.deepEqual(commit.parents, [
    { sha: PARENT_SHA },
    { sha: SECOND_PARENT_SHA },
  ]);
});

test('fetchVerifiedCommitFromLocalGit: strips stdout diagnostics before commit body delimiter', async () => {
  const git = makeFakeGit();
  const originalImpl = git;
  const warningGit = async (file, args) => {
    const joined = args.join(' ');
    if (joined.includes('--format=%x00%B')) {
      originalImpl.calls.push(args.join(' '));
      return {
        stdout: [
          'warning: ignoring suspicious replacement ref',
          `\0${HAMMER_MESSAGE}`,
          '',
        ].join('\n'),
      };
    }
    return originalImpl(file, args);
  };
  warningGit.calls = originalImpl.calls;
  const commit = await fetchVerifiedCommitFromLocalGit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: warningGit,
  });
  assert.equal(commit.message, HAMMER_MESSAGE);
  assert.equal(commit.commit.message, HAMMER_MESSAGE);
  assert.equal(isTerminalCloserCommitIdentity(commit).suppressed, true);
});

test('fetchVerifiedCommitFromLocalGit: retries transient local git subprocess failures', async () => {
  const git = makeFakeGit();
  const attemptsByCommand = new Map();
  const flakyGit = async (file, args) => {
    const joined = args.join(' ');
    const attempts = (attemptsByCommand.get(joined) || 0) + 1;
    attemptsByCommand.set(joined, attempts);
    if ((joined.includes('--format=%H %P') || joined.includes('diff-tree')) && attempts === 1) {
      throw Object.assign(new Error('Input/output error'), { code: 'EIO' });
    }
    return git(file, args);
  };
  const sleeps = [];
  const commit = await fetchVerifiedCommitFromLocalGit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: flakyGit,
    retryBackoffMs: [1, 2],
    sleepImpl: async (ms) => { sleeps.push(ms); },
    logger: { warn() {}, debug() {} },
  });
  assert.equal(commit.sha, HEAD_SHA);
  assert.equal(commit.files[0].filename, 'modules/worker-pool/lib/hq-drs.sh');
  assert.deepEqual(sleeps, [1, 1]);
});

test('fetchVerifiedCommitFromLocalGit does not fetch missing commits from daemon-owned checkouts', async () => {
  const git = makeFakeGit({ failObjectRead: true });
  const commit = await fetchVerifiedCommitFromLocalGit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: git,
    logger: { warn() {}, debug() {} },
  });
  assert.equal(commit, null);
  assert.equal(git.calls.some((call) => call.includes(' fetch ')), false);
});

test('regression: getHeadCloserCommitSuppression recognizes the closer identity from LOCAL git even when gh throws (daemon failure)', async () => {
  const git = makeFakeGit();
  const result = await getHeadCloserCommitSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: git,
    execGhWithRetryImpl: throwingGh, // simulate the daemon-context gh failure that starved the resume
    logger: { warn() {}, debug() {} },
  });
  assert.equal(result.suppressed, true);
  assert.equal(result.reason, 'closer-commit-trailer');
});

test('fetchHeadCloserVerifiedCommit prefers local git (returns the closer commit without touching gh)', async () => {
  const git = makeFakeGit();
  let ghCalled = false;
  const commit = await fetchHeadCloserVerifiedCommit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: git,
    execGhWithRetryImpl: async () => { ghCalled = true; throw new Error('should not reach gh'); },
    logger: { warn() {}, debug() {} },
  });
  assert.equal(ghCalled, false);
  assert.equal(commit.sha, HEAD_SHA);
  assert.match(commit.message, /Closed-By: hammer/);
});

test('fetchHeadCloserVerifiedCommit falls back to gh when local git has no closer identity', async () => {
  const external = makeFakeGit({ message: 'just a normal external push\n\nSigned-off-by: someone' });
  let ghCalled = false;
  const commit = await fetchHeadCloserVerifiedCommit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: external,
    execGhWithRetryImpl: async () => {
      ghCalled = true;
      return {
        stdout: JSON.stringify({
          sha: HEAD_SHA,
          commit: { message: 'remote verified closer by login' },
          committer: { login: 'merge-agent-lacey' },
          parents: [{ sha: PARENT_SHA }],
          files: [{ filename: 'src/changed.mjs' }],
        }),
      };
    },
    logger: { warn() {}, debug() {} },
  });
  assert.equal(ghCalled, true);
  assert.equal(commit.committer, 'merge-agent-lacey');
  assert.equal(commit.parentSha, PARENT_SHA);
  assert.deepEqual(commit.changedFiles, ['src/changed.mjs']);
});

test('fallback: when the commit is absent locally, getHeadCloserCommitSuppression falls back to the gh probe', async () => {
  const git = makeFakeGit({ failObjectRead: true });
  let ghCalled = false;
  const gh = async ({ args }) => {
    ghCalled = true;
    assert.ok(args.includes('--jq'));
    return {
      stdout: JSON.stringify({
        sha: HEAD_SHA,
        message: HAMMER_MESSAGE,
        committerLogin: null,
      }),
    };
  };
  const result = await getHeadCloserCommitSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: git,
    execGhWithRetryImpl: gh,
    logger: { warn() {}, debug() {} },
  });
  assert.equal(ghCalled, true);
  assert.equal(result.suppressed, true);
});

test('safety: an external (non-closer) commit at a local head is NOT suppressed, and still consults gh for a committer.login-only identity', async () => {
  const external = makeFakeGit({ message: 'just a normal external push\n\nSigned-off-by: someone' });
  let ghCalled = false;
  const gh = async () => {
    ghCalled = true;
    // gh sees a plain external commit too — no closer identity.
    return { stdout: JSON.stringify({ sha: HEAD_SHA, message: 'external', committerLogin: 'some-human' }) };
  };
  const result = await getHeadCloserCommitSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: external,
    execGhWithRetryImpl: gh,
    logger: { warn() {}, debug() {} },
  });
  // local git found no closer trailer -> fell through to gh -> gh found no closer identity either.
  assert.equal(ghCalled, true);
  assert.equal(result.suppressed, false);
});
