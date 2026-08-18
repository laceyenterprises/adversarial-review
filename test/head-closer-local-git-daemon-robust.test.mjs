import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fetchVerifiedCommitFromLocalGit,
  getHeadCloserCommitSuppression,
  fetchHeadCloserVerifiedCommit,
  isTerminalCloserCommitIdentity,
} from '../src/head-closer-commit-suppression.mjs';

// The local closer-commit reader resolves a repo SLUG (`owner/name`) to the
// daemon's checkout at `${HQ_ROOT}/repos/<name>` — running `git -C owner/name`
// directly is the bug this file guards against. Give it real temp checkouts so
// the slug-based calls below resolve to an existing directory (git is mocked, so
// the dir only needs to exist).
const originalHqRoot = process.env.HQ_ROOT;
const tempRoots = [];
const TEST_HQ_ROOT = mkdtempSync(join(tmpdir(), 'closer-hqroot-'));
tempRoots.push(TEST_HQ_ROOT);
for (const name of ['agent-os', 'finch', 'adversarial-review']) {
  mkdirSync(join(TEST_HQ_ROOT, 'repos', name), { recursive: true });
}
process.env.HQ_ROOT = TEST_HQ_ROOT;

after(() => {
  if (originalHqRoot === undefined) {
    delete process.env.HQ_ROOT;
  } else {
    process.env.HQ_ROOT = originalHqRoot;
  }
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

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
function makeFakeGit({
  message = HAMMER_MESSAGE,
  parent = PARENT_SHA,
  files = ['modules/worker-pool/lib/hq-drs.sh'],
  failObjectRead = false,
  missingUntilFetch = false,
  failShaFetch = false,
  failPullRefFetch = false,
  transientShaFetchFailures = 0,
  transientPullRefFetchFailures = 0,
} = {}) {
  const calls = [];
  let fetched = false;
  let shaFetchAttempts = 0;
  let pullRefFetchAttempts = 0;
  const impl = async (file, args) => {
    calls.push(args.join(' '));
    assert.equal(file, 'git');
    const joined = args.join(' ');
    if (joined.includes('fetch --quiet --no-tags origin')) {
      if (joined.includes(`origin ${HEAD_SHA}`)) {
        shaFetchAttempts += 1;
        if (shaFetchAttempts <= transientShaFetchFailures) {
          throw Object.assign(new Error('TLS handshake timeout'), { code: 'ETIMEDOUT' });
        }
      }
      if (joined.includes('+refs/pull/')) {
        pullRefFetchAttempts += 1;
        if (pullRefFetchAttempts <= transientPullRefFetchFailures) {
          throw Object.assign(new Error('remote end hung up unexpectedly'), { code: 'ECONNRESET' });
        }
      }
      if (joined.includes(`origin ${HEAD_SHA}`) && failShaFetch) {
        throw new Error(`fatal: couldn't find remote ref ${HEAD_SHA}`);
      }
      if (joined.includes('+refs/pull/') && failPullRefFetch) {
        throw new Error('fatal: couldn\'t find remote ref refs/pull/5348/head');
      }
      fetched = true;
      return { stdout: '' };
    }
    if ((failObjectRead || (missingUntilFetch && !fetched)) && (joined.includes('show') || joined.includes('diff-tree'))) {
      const err = new Error(`fatal: bad object ${HEAD_SHA}`);
      err.stderr = `fatal: bad object ${HEAD_SHA}`;
      throw err;
    }
    if (joined.includes('--format=%H %P')) return { stdout: `${HEAD_SHA} ${parent}\n` };
    if (joined.includes('--format=%B')) return { stdout: `${message}\n` };
    if (joined.includes('diff-tree')) return { stdout: `${files.join('\n')}\n` };
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

test('fetchVerifiedCommitFromLocalGit: removes leading git diagnostics from commit message output', async () => {
  const git = makeFakeGit({
    message: [
      'warning: ignoring suspicious replacement ref',
      'hint: run git maintenance',
      HAMMER_MESSAGE,
    ].join('\n'),
  });
  const commit = await fetchVerifiedCommitFromLocalGit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: git,
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

test('fetchVerifiedCommitFromLocalGit fetches a missing commit by sha, then reads identity', async () => {
  const git = makeFakeGit({ missingUntilFetch: true });
  const commit = await fetchVerifiedCommitFromLocalGit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: git,
    logger: { warn() {}, debug() {} },
  });
  assert.equal(commit.sha, HEAD_SHA);
  assert.equal(isTerminalCloserCommitIdentity(commit).suppressed, true);
  assert.ok(
    git.calls.some((call) => call.includes(`fetch --quiet --no-tags origin ${HEAD_SHA}`)),
    'missing local object should be fetched directly by sha',
  );
});

test('fetchVerifiedCommitFromLocalGit retries transient sha fetch failures before reading identity', async () => {
  const git = makeFakeGit({ missingUntilFetch: true, transientShaFetchFailures: 1 });
  const sleeps = [];
  const commit = await fetchVerifiedCommitFromLocalGit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: git,
    retryBackoffMs: [3, 7],
    sleepImpl: async (ms) => { sleeps.push(ms); },
    logger: { warn() {}, debug() {} },
  });
  assert.equal(commit.sha, HEAD_SHA);
  assert.deepEqual(sleeps, [3]);
  assert.equal(
    git.calls.filter((call) => call.includes(`fetch --quiet --no-tags origin ${HEAD_SHA}`)).length,
    2,
  );
  assert.equal(
    git.calls.some((call) => call.includes('+refs/pull/5348/head')),
    false,
    'transient sha fetch recovery should not fall through to pull-ref fetch',
  );
});

test('fetchVerifiedCommitFromLocalGit does not treat exhausted transient sha fetch as bare-sha rejection', async () => {
  const git = makeFakeGit({ missingUntilFetch: true, transientShaFetchFailures: 3 });
  const sleeps = [];
  const commit = await fetchVerifiedCommitFromLocalGit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: git,
    retryBackoffMs: [3, 7],
    sleepImpl: async (ms) => { sleeps.push(ms); },
    logger: { warn() {}, debug() {} },
  });
  assert.equal(commit, null);
  assert.deepEqual(sleeps, [3, 7]);
  assert.equal(
    git.calls.filter((call) => call.includes(`fetch --quiet --no-tags origin ${HEAD_SHA}`)).length,
    3,
  );
  assert.equal(
    git.calls.some((call) => call.includes('+refs/pull/5348/head')),
    false,
    'exhausted transient sha fetch must not be reclassified as an unresolvable sha',
  );
});

test('fetchVerifiedCommitFromLocalGit falls back to pull-ref fetch when bare sha fetch is rejected', async () => {
  const git = makeFakeGit({ missingUntilFetch: true, failShaFetch: true });
  const commit = await fetchVerifiedCommitFromLocalGit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: git,
    logger: { warn() {}, debug() {} },
  });
  assert.equal(commit.sha, HEAD_SHA);
  assert.ok(
    git.calls.some((call) => call.includes('fetch --quiet --no-tags origin +refs/pull/5348/head:refs/remotes/origin/pr/5348')),
    'bare sha rejection should fall back to the PR head ref',
  );
});

test('fetchVerifiedCommitFromLocalGit retries transient pull-ref fetch after permanent bare-sha rejection', async () => {
  const git = makeFakeGit({
    missingUntilFetch: true,
    failShaFetch: true,
    transientPullRefFetchFailures: 1,
  });
  const sleeps = [];
  const commit = await fetchVerifiedCommitFromLocalGit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: git,
    retryBackoffMs: [5, 9],
    sleepImpl: async (ms) => { sleeps.push(ms); },
    logger: { warn() {}, debug() {} },
  });
  assert.equal(commit.sha, HEAD_SHA);
  assert.deepEqual(sleeps, [5]);
  assert.equal(
    git.calls.filter((call) => call.includes('fetch --quiet --no-tags origin +refs/pull/5348/head:refs/remotes/origin/pr/5348')).length,
    2,
  );
});

test('fetchVerifiedCommitFromLocalGit does not fetch missing commits from daemon-owned checkouts', async () => {
  const git = makeFakeGit({ missingUntilFetch: true });
  const commit = await fetchVerifiedCommitFromLocalGit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    execFileImpl: git,
    getuidImpl: () => Number.MAX_SAFE_INTEGER,
    logger: { warn() {}, debug() {} },
  });
  assert.equal(commit, null);
  assert.equal(
    git.calls.some((call) => call.includes('fetch --quiet --no-tags origin')),
    false,
    'cross-user local checkout reads must not mutate daemon-owned git state',
  );
});

test('fetchHeadCloserVerifiedCommit forwards local checkout ownership injections', async () => {
  const sentinels = {
    getuidImpl: () => Number.MAX_SAFE_INTEGER,
    statImpl: async () => ({ uid: Number.MAX_SAFE_INTEGER }),
  };
  let forwarded;
  await fetchHeadCloserVerifiedCommit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    fetchVerifiedCommitFromLocalGitImpl: async (options) => {
      forwarded = options;
      return null;
    },
    execGhWithRetryImpl: async () => ({
      stdout: JSON.stringify({
        sha: HEAD_SHA,
        commit: { message: 'remote verified closer by login' },
        committer: { login: 'merge-agent-lacey' },
        parents: [{ sha: PARENT_SHA }],
      }),
    }),
    ...sentinels,
    logger: { warn() {}, debug() {} },
  });
  assert.equal(forwarded.getuidImpl, sentinels.getuidImpl);
  assert.equal(forwarded.statImpl, sentinels.statImpl);
});

test('getHeadCloserCommitSuppression forwards local checkout ownership injections', async () => {
  const sentinels = {
    getuidImpl: () => Number.MAX_SAFE_INTEGER,
    statImpl: async () => ({ uid: Number.MAX_SAFE_INTEGER }),
  };
  let forwarded;
  await getHeadCloserCommitSuppression({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 5348,
    headSha: HEAD_SHA,
    fetchVerifiedCommitFromLocalGitImpl: async (options) => {
      forwarded = options;
      return null;
    },
    execGhWithRetryImpl: async () => ({
      stdout: JSON.stringify({
        sha: HEAD_SHA,
        message: 'external',
        committerLogin: 'some-human',
      }),
    }),
    ...sentinels,
    logger: { warn() {}, debug() {} },
  });
  assert.equal(forwarded.getuidImpl, sentinels.getuidImpl);
  assert.equal(forwarded.statImpl, sentinels.statImpl);
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

test('fallback: when local fetch cannot make the commit readable, getHeadCloserCommitSuppression falls back to gh without noisy local-read error', async () => {
  const git = makeFakeGit({ failObjectRead: true, failShaFetch: true, failPullRefFetch: true });
  let ghCalled = false;
  const debugMessages = [];
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
    logger: { warn() {}, debug(message) { debugMessages.push(message); } },
  });
  assert.equal(ghCalled, true);
  assert.equal(result.suppressed, true);
  assert.equal(
    debugMessages.some((message) => String(message).includes('local closer-commit read failed')),
    false,
  );
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

// --- repo-slug → local-checkout resolution (the `git -C <slug>` bug) ----------

test('resolves a repo SLUG to ${HQ_ROOT}/repos/<name> for git -C (never the raw slug)', async () => {
  const git = makeFakeGit();
  await fetchVerifiedCommitFromLocalGit({
    repoPath: 'laceyenterprises/finch',
    prNumber: 8,
    headSha: HEAD_SHA,
    execFileImpl: git,
  });
  assert.ok(git.calls.length > 0, 'git should have been invoked');
  const checkout = join(TEST_HQ_ROOT, 'repos', 'finch');
  for (const c of git.calls) {
    assert.ok(
      c.startsWith(`-C ${checkout} `),
      `git must run in the resolved checkout dir, got: ${c}`,
    );
  }
});

test('an existing directory passed as repoPath is used as-is', async () => {
  const git = makeFakeGit();
  const dir = join(TEST_HQ_ROOT, 'repos', 'agent-os');
  await fetchVerifiedCommitFromLocalGit({
    repoPath: dir,
    prNumber: 1,
    headSha: HEAD_SHA,
    execFileImpl: git,
  });
  for (const c of git.calls) {
    assert.ok(c.startsWith(`-C ${dir} `), `expected -C ${dir}, got: ${c}`);
  }
});

test('a repo with NO local checkout returns null WITHOUT invoking git (quiet fallback to gh)', async () => {
  const git = makeFakeGit();
  const commit = await fetchVerifiedCommitFromLocalGit({
    repoPath: 'laceyenterprises/not-cloned-here',
    prNumber: 99,
    headSha: HEAD_SHA,
    execFileImpl: git,
  });
  assert.equal(commit, null);
  assert.equal(git.calls.length, 0, 'git must not run against a nonexistent checkout');
});

test('explicit hqRoot override resolves the slug (production defaults to process.env.HQ_ROOT)', async () => {
  const otherRoot = mkdtempSync(join(tmpdir(), 'closer-other-root-'));
  tempRoots.push(otherRoot);
  mkdirSync(join(otherRoot, 'repos', 'agent-os'), { recursive: true });
  const git = makeFakeGit();
  await fetchVerifiedCommitFromLocalGit({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 2,
    headSha: HEAD_SHA,
    hqRoot: otherRoot,
    execFileImpl: git,
  });
  const checkout = join(otherRoot, 'repos', 'agent-os');
  for (const c of git.calls) {
    assert.ok(c.startsWith(`-C ${checkout} `), `expected -C ${checkout}, got: ${c}`);
  }
});
