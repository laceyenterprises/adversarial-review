import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runLegacyPrWrite } from '../src/finalization/legacy-pr-write.mjs';
import { readQueueEvidence } from '../src/finalization/queue-read.mjs';
import { readLivePullRequestIdentity } from '../src/github-pr-identity.mjs';
import { fetchMergeAgentCandidate } from '../src/merge-agent-candidate.mjs';
import { createGithubOwnerTokenSelector, githubOwnerTokens, githubTargetOwner } from '../src/github-owner-token.mjs';
import { currentGitHubBudgetScope } from '../src/rate-limit-throttle.mjs';

const owner = JSON.parse(readFileSync(new URL('../config.json', import.meta.url))).org ?? 'fixture-owner';
const repository = `${owner}/fixture`;
const prNumber = 5;
const head = 'a'.repeat(40);
const base = 'Release/Stable';
const identity = { number: prNumber, repository: repository.toUpperCase(), baseBranch: base,
  state: 'open', headSha: head, merged_at: null };
const env = { GH_TOKEN: 'synthetic-fixture-token', GHO_API_CALL_LOG_DISABLE: '1' };
const result = value => ({ stdout: JSON.stringify(value), stderr: '' });

test('a writer hold observes the current branch ref and ignores the PR snapshot base SHA', async () => {
  const stale = 'b'.repeat(40);
  const live = 'c'.repeat(40);
  for (const [branch, fallback, expected] of [
    [{ ref: `refs/heads/${base}`, object: { type: 'commit', sha: live } }, null, live],
    [{ ref: 'refs/heads/foreign', object: { type: 'commit', sha: live } }, { name: 'foreign', commit: { sha: live } }, null],
    [null, { name: base, commit: { sha: live } }, live],
    [null, null, null],
  ]) {
    const calls = [];
    const pr = await readLivePullRequestIdentity(repository, prNumber, {
      includeBaseSha: true, env, timeoutMs: 10000,
      execFileImpl: async (_, args) => {
        calls.push(args[1]);
        if (calls.length === 1) return result({ ...identity, baseSha: stale });
        const response = calls.length === 2 ? branch : fallback;
        if (!response) throw new Error('ref unavailable');
        return result(response);
      },
    });
    assert.deepEqual(calls, [`repos/${repository}/pulls/${prNumber}`, `repos/${repository}/git/ref/heads/${base}`,
      ...(branch?.ref === `refs/heads/${base}` ? [] : [`repos/${repository}/branches/Release%2FStable`])]);
    assert.equal(pr.baseSha, expected);
  }
});

function fixtureRoot(t) {
  const path = mkdtempSync(join(tmpdir(), 'legacy-pr-identity-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function crossOwnerFixture(t, mint) {
  const original = { ...githubOwnerTokens };
  Object.assign(githubOwnerTokens, createGithubOwnerTokenSelector({ readHomeOwner: () => owner, mint }));
  t.after(() => Object.assign(githubOwnerTokens, original));
  const targetOwner = owner.toLowerCase() === 'other-org' ? 'another-org' : 'other-org';
  return { targetOwner, targetRepository: `${targetOwner}/fixture`,
    targetEnv: { ...env, GITHUB_REVIEWER_TOKEN_ENV: 'GH_CODEX_REVIEWER_TOKEN' } };
}

test('cross-owner identity read mints the target token and passes it only to the child', async t => {
  const mints = [];
  const { targetOwner, targetRepository, targetEnv } = crossOwnerFixture(t, async options => {
    mints.push(options);
    return { token: 'synthetic-owner-token', expiresAtMs: Date.now() + 3600000 };
  });
  let calls = 0;
  const candidate = await readLivePullRequestIdentity(targetRepository, prNumber, {
    env: targetEnv, timeoutMs: 10000,
    execFileImpl: async (_, args, child) => {
      calls++;
      assert.equal(args[1], `repos/${targetRepository}/pulls/${prNumber}`);
      assert.equal(child.env.GH_TOKEN, 'synthetic-owner-token');
      assert.equal(child.env.GITHUB_TOKEN, 'synthetic-owner-token');
      assert.equal(currentGitHubBudgetScope().urgent, false);
      return result({ ...identity, repository: targetRepository });
    },
  });
  assert.deepEqual(candidate, { prState: 'open', headSha: head, baseBranch: base });
  assert.equal(calls, 1);
  assert.equal(mints.length, 1);
  assert.equal(mints[0].owner, targetOwner);
  assert.equal(mints[0].role, 'codex-reviewer');
  assert.equal(targetEnv.GH_TOKEN, env.GH_TOKEN);
  assert.equal(targetEnv.GITHUB_TOKEN, undefined);
});

test('evidence expiry during a shared owner mint prevents a late PR transport launch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { targetRepository, targetEnv } = crossOwnerFixture(t, async () => {
    entered.resolve();
    await release.promise;
    return { token: 'synthetic-late-owner-token', expiresAtMs: Date.now() + 3600000 };
  });
  let remote;
  const read = readQueueEvidence({ read: options => {
    remote = readLivePullRequestIdentity(targetRepository, prNumber, { ...options, env: targetEnv,
      execFileImpl: () => assert.fail('expired owner mint started a PR read') });
    return remote;
  } }, {}, 10000);
  const rejected = assert.rejects(read, /queue evidence deadline expired/);
  try {
    assert.equal(await Promise.race([entered.promise.then(() => 'entered'), read]), 'entered');
    t.mock.timers.tick(10000);
    await rejected;
    release.resolve();
    await assert.rejects(remote, { name: 'AbortError' });
  } finally {
    release.resolve();
    await Promise.allSettled([remote]);
  }
});

test('full open candidate can persist a hold after an abandoned read; native identity needs one read', { timeout: 10000 }, async t => {
  const rootDir = fixtureRoot(t);
  const holdDir = join(rootDir, 'data/stacked-base-holds');
  const guardEntered = Promise.withResolvers();
  const releaseGuard = Promise.withResolvers();
  const fullReads = [];
  let candidate;
  const started = performance.now();
  const legacyRead = readQueueEvidence({ read: () => {
    candidate = fetchMergeAgentCandidate(repository, prNumber, { rootDir, env, logger: { warn() {} },
      fetchCachedAdversarialGateBranchProtectionImpl: async () => { fullReads.push('branch protection'); return { ok: true }; },
      execFileImpl: async (_, args, opts) => {
        assert.equal(opts.signal, undefined);
        if (args[0] === 'pr') {
          fullReads.push('PR snapshot');
          return result({ state: 'OPEN', baseRefName: base, headRefOid: head });
        }
        assert.deepEqual(args, ['api', `repos/${repository}/pulls/${prNumber}`]);
        fullReads.push('stacked-base PR');
        guardEntered.resolve();
        await releaseGuard.promise;
        return result({}); // malformed enrichment produces a real local read-failed hold
      } });
    return candidate;
  } }, {}, 100);
  let deadlineMs;
  const rejected = assert.rejects(legacyRead.catch(error => {
    deadlineMs = Math.round(performance.now() - started);
    throw error;
  }), /queue evidence deadline expired/);
  const nativeReads = [];
  const beforeIdentity = performance.now();
  try {
    const receipt = await runLegacyPrWrite({ rootDir, repository, prNumber, head, command: 'fixture',
      argv: ['merge', '--match-head-commit', head],
      readCandidate: (repo, number, options) => {
        assert.equal(options.rootDir, rootDir);
        assert.ok(options.signal instanceof AbortSignal);
        assert.ok(options.timeoutMs >= 5000 && options.timeoutMs <= 30000);
        return readLivePullRequestIdentity(repo, number, { ...options, env, execFileImpl: async (command, args, child) => {
          nativeReads.push(args[1]);
          assert.equal(command, 'gh');
          assert.deepEqual(args.slice(0, 3), ['api', `repos/${repository}/pulls/${prNumber}`, '--jq']);
          assert.equal(githubTargetOwner(args), owner.toLowerCase());
          assert.equal(child.signal, options.signal);
          assert.ok(child.timeout > 0 && child.timeout <= options.timeoutMs);
          return result(identity);
        } });
      },
      run: ({ repository: repo, base: branch, subject, argv }) => {
        assert.equal(repo, repository);
        assert.equal(branch, base);
        assert.deepEqual(subject, { prNumber, head });
        assert.deepEqual(argv, ['merge', '--match-head-commit', head]);
        return 'issued';
      },
    });
    const identityMs = Math.round(performance.now() - beforeIdentity);
    assert.equal(receipt, 'issued');
    await rejected;
    assert.equal(await Promise.race([guardEntered.promise.then(() => 'entered'), candidate]), 'entered');
    assert.equal(existsSync(holdDir), false);
    releaseGuard.resolve();
    assert.equal((await candidate).stackedBaseHold.reason, 'stacked-base-read-failed');
    assert.deepEqual(fullReads.slice().sort(), ['PR snapshot', 'branch protection', 'stacked-base PR']);
    assert.equal(nativeReads.length, 1);
    const holds = readdirSync(holdDir).length;
    assert.equal(holds, 1);
    t.diagnostic(`offline fixture: full read timed out at ${deadlineMs} ms (${fullReads.length} reads, ${holds} late hold); identity returned at ${identityMs} ms (${nativeReads.length} read)`);
  } finally {
    releaseGuard.resolve();
    await Promise.allSettled([rejected, candidate]);
  }
});

test('closed, merged, moved and malformed identities refuse before the lane writer', async () => {
  for (const patch of [
    { state: 'closed' }, { state: 'closed', merged_at: '2026-11-20T00:00:00Z' },
    { headSha: 'b'.repeat(40) }, { headSha: null }, { headSha: head.slice(1) },
    { baseBranch: null }, { baseBranch: 'refs/heads/main' }, { baseBranch: 'bad..ref' },
    { repository: 'another-owner/fixture' }, { number: prNumber + 1 },
    { state: 'unknown' }, { merged_at: undefined }, { merged_at: '2026-11-20T00:00:00Z' },
  ]) {
    const refused = await runLegacyPrWrite({ repository, prNumber, head,
      readCandidate: (repo, number, options) => readLivePullRequestIdentity(repo, number, { ...options, env,
        execFileImpl: async () => result({ ...identity, ...patch }) }),
      run: () => assert.fail('invalid identity reached lane writer'),
    });
    const terminalOrMoved = patch.state === 'closed' || patch.headSha === 'b'.repeat(40);
    assert.deepEqual(refused, { ok: false,
      reason: terminalOrMoved ? 'terminal-pr-or-head-changed' : 'malformed-or-mismatched-identity' });
  }
  for (const execFileImpl of [async () => { throw new Error('unreadable PR'); }, async () => ({ stdout: '{' })]) {
    await assert.rejects(runLegacyPrWrite({ repository, prNumber, head,
      readCandidate: (repo, number, options) => readLivePullRequestIdentity(repo, number, { ...options, env, execFileImpl }),
      run: () => assert.fail('unreadable identity reached lane writer'),
    }), /unreadable PR|JSON|position/);
  }
});

test('evidence expiry aborts the transport and discards a late identity response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let remote, calls = 0, signal;
  const read = readQueueEvidence({ read: options => {
    signal = options.signal;
    remote = readLivePullRequestIdentity(repository, prNumber, { ...options, env,
      execFileImpl: async (_, __, child) => {
        calls++;
        assert.equal(child.signal, signal);
        entered.resolve();
        await release.promise;
        return result(identity);
      } });
    return remote;
  } }, {}, 10000);
  const rejected = assert.rejects(read, /queue evidence deadline expired/);
  try {
    assert.equal(await Promise.race([entered.promise.then(() => 'entered'), read]), 'entered');
    t.mock.timers.tick(10000);
    await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(calls, 1);
    release.resolve();
    await assert.rejects(remote, { name: 'AbortError' });
    await assert.rejects(readLivePullRequestIdentity(repository, prNumber, { timeoutMs: 100, signal, env,
      execFileImpl: () => assert.fail('pre-aborted read started') }), { name: 'AbortError' });
  } finally {
    release.resolve();
    await Promise.allSettled([remote]);
  }
});

test('native default reader uses the scoped identity read in the PR writer CLI', async t => {
  const rootDir = fixtureRoot(t);
  const bin = fileURLToPath(new URL('../bin/legacy-pr-write.mjs', import.meta.url));
  const request = `repos/${repository}/pulls/${prNumber}`;
  // The isolated PATH contains only a fixture gh. Any extra read or wrong
  // target fails the run, including the former candidate snapshot command.
  writeFileSync(join(rootDir, 'gh'), `#!/bin/sh
if [ "$1" != api ] || [ "$2" != '${request}' ] || [ "$3" != --jq ]; then exit 91; fi
printf '%s\\n' '${JSON.stringify(identity)}'
`, { mode: 0o700 });
  const args = ['--preserve-symlinks', '--preserve-symlinks-main', bin,
    '--root', rootDir, '--repo', repository, '--pr', String(prNumber), '--head', head,
    '--', process.execPath, '-e', 'console.log(process.argv[1])', head];
  const response = await promisify(execFile)(process.execPath, args, {
    env: { ...env, PATH: rootDir }, timeout: 10000,
  });
  assert.equal(response.stdout.trim(), head);
  writeFileSync(join(rootDir, 'gh'), `#!/bin/sh
printf '%s\\n' '${JSON.stringify({ ...identity, repository: `${owner}/renamed` })}'
`, { mode: 0o700 });
  await assert.rejects(promisify(execFile)(process.execPath, args, {
    env: { ...env, PATH: rootDir }, timeout: 10000,
  }), error => {
    assert.equal(error.code, 75);
    assert.equal(error.stdout, '');
    assert.match(error.stderr, /legacy PR write deferred: malformed-or-mismatched-identity/);
    return true;
  });
});

test('two live identity reads still use the native lane issuance lock', async t => {
  const rootDir = fixtureRoot(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let reads = 0, commands = 0;
  const write = options => runLegacyPrWrite({ rootDir, repository, prNumber, head, command: 'fixture', argv: [head],
    readCandidate: (repo, number, options) => readLivePullRequestIdentity(repo, number, { ...options, env,
      execFileImpl: async () => { reads++; return result(identity); } }),
    readConfig: () => ({}), ...options,
  });
  const first = write({ exec: async (command, argv) => {
    commands++;
    assert.deepEqual([command, argv], ['fixture', [head]]);
    entered.resolve();
    await release.promise;
    return { stdout: 'first command' };
  } });
  try {
    assert.equal(await Promise.race([entered.promise.then(() => 'entered'), first]), 'entered');
    const blocked = await write({ deadline: new Date(0).toISOString(), exec: () => assert.fail('concurrent issuance') });
    assert.equal(blocked.reason, 'owner-operation-in-flight');
    assert.equal(blocked.outcome, 'lane-busy');
    assert.equal(commands, 1);
    assert.equal(reads, 2);
  } finally { release.resolve(); await first; }
});
