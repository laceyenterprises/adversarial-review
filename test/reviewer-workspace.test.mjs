import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  ReviewerSnapshotBaseError,
  auditReviewerSubprocess,
  changedStatusPaths,
  configureReviewerWorkspaceAudit,
  extractArchiveOnce,
  garbageCollectSnapshots,
  isReviewerSnapshotBaseError,
  prepareReviewerSnapshot,
  prepareReviewerHarnessCwd,
  prepareReviewerWorkspace,
  resolveCheckoutHead,
  resolveReviewerWorkspaceStateDir,
} from '../src/reviewer-workspace.mjs';
import { materializeReviewerHead } from '../src/reviewer-repo-checkout.mjs';
import { resolveRepoCheckoutDir } from '../src/argus-dependency-evidence.mjs';
import { recordReviewerWorkspaceMode } from '../src/reviewer-workspace-telemetry.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(root, name) {
  const repo = join(root, name);
  mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'reviewer-test@example.invalid');
  git(repo, 'config', 'user.name', 'Reviewer Test');
  writeFileSync(join(repo, 'tracked.txt'), 'base\n');
  git(repo, 'add', 'tracked.txt');
  git(repo, 'commit', '-qm', 'base');
  return repo;
}

function removeFixture(root) {
  try { execFileSync('chmod', ['-R', 'u+w', root]); } catch {}
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

test('reviewer and Argus match repository identity for both deploy checkouts and configured clones', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reviewer-repo-identity-')));
  try {
    const superproject = makeRepo(root, 'superproject');
    const toolsDir = join(superproject, 'tools');
    mkdirSync(toolsDir);
    const rootDir = makeRepo(toolsDir, 'review-service');
    const clones = join(root, 'clones');
    const ownerDir = join(clones, 'example');
    mkdirSync(ownerDir, { recursive: true });
    const targetClone = makeRepo(ownerDir, 'public-target');
    git(superproject, 'remote', 'add', 'origin', 'git@github.com:example/superproject.git');
    git(rootDir, 'remote', 'add', 'origin', 'https://github.com/example/review-service.git');
    git(targetClone, 'remote', 'add', 'origin', 'ssh://git@github.com/example/public-target.git');
    const lookup = repo => resolveRepoCheckoutDir({ repo, rootDir, env: {
      ...process.env, ADVERSARIAL_REVIEWER_CLONE_ROOT: clones, GIT_DIR: join(superproject, '.git'),
    } });

    assert.equal(await lookup('Example/Review-Service'), rootDir);
    assert.equal(await lookup('example/superproject'), superproject);
    assert.equal(await lookup('example/public-target'), targetClone);
    assert.equal(await lookup('other-owner/review-service'), null);
    git(targetClone, 'remote', 'set-url', 'origin', 'git@github.com:example/private-sibling.git');
    assert.equal(await lookup('example/public-target'), null);
    symlinkSync(superproject, join(ownerDir, 'missing-target'));
    const checkoutDir = await lookup('example/missing-target');
    assert.equal(checkoutDir, null);
    const empty = await prepareReviewerWorkspace({
      repo: 'example/missing-target', checkoutDir, stateDir: join(root, 'state'),
      headSha: git(superproject, 'rev-parse', 'HEAD'),
    });
    assert.equal(empty.diffOnly, true);
    assert.deepEqual(readdirSync(empty.snapshotDir), []);
    assert.equal(statSync(empty.snapshotDir).mode & 0o222, 0);
  } finally {
    removeFixture(root);
  }
});

test('canonical origins preserve the native mixed-case clone path and withhold userinfo', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'reviewer-origin-')));
  try {
    const cloneRoot = join(root, 'clones');
    const ownerDir = join(cloneRoot, 'MixedOwner');
    mkdirSync(ownerDir, { recursive: true });
    const checkout = makeRepo(ownerDir, 'MixedRepo');
    const rootDir = makeRepo(root, 'service');
    const repo = 'MixedOwner/MixedRepo';
    const secret = 'fixture-secret-never-printed';
    const signals = [];
    const env = { ...process.env, ADVERSARIAL_REVIEWER_CLONE_ROOT: cloneRoot, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    const lookup = () => resolveRepoCheckoutDir({ repo, rootDir, env, onUnavailable: cause => signals.push(cause) });
    const setOrigin = url => git(checkout, 'config', 'remote.origin.url', url);
    for (const url of [`https://x-access-token:${secret}@github.com/mixedowner/mixedrepo.git/`,
      'ssh://github.com/MixedOwner/MixedRepo/', 'ssh://git@github.com/MixedOwner/MixedRepo.git',
      'git@github.com:MixedOwner/MixedRepo.git']) {
      setOrigin(url);
      assert.equal(await lookup(), checkout);
    }
    assert.deepEqual(signals, []);
    for (const url of [`https://github.com:${secret}@other.invalid/MixedOwner/MixedRepo`,
      'git@github-alias:MixedOwner/MixedRepo.git', 'https://github.com/MixedOwner/MixedRepo?extra',
      'https://github.com/MixedOwner/%4DixedRepo', 'https://github.com:443/MixedOwner/MixedRepo',
      'https://github.com/MixedOwner/MixedRepo/../MixedRepo', 'https://github.com/Other/MixedRepo']) {
      setOrigin(url);
      assert.equal(await lookup(), null);
    }
    git(checkout, 'config', 'url.git@github.com:.insteadOf', 'git@github-alias:');
    setOrigin('git@github-alias:MixedOwner/MixedRepo.git');
    assert.equal(await lookup(), null);
    git(checkout, 'config', 'url.git@foreign.invalid:.insteadOf', 'git@github.com:');
    setOrigin('git@github.com:MixedOwner/MixedRepo.git');
    assert.equal(await lookup(), null);
    assert.ok(signals.includes('origin-unverified'));
    assert.doesNotMatch(JSON.stringify(signals), new RegExp(secret));
    const warnings = [];
    const fallback = await prepareReviewerWorkspace({
      repo, stateDir: join(root, 'state'), headSha: 'a'.repeat(40),
      checkoutUnavailable: signals.at(-1), log: { warn: message => warnings.push(message) },
    });
    assert.equal(fallback.diffOnlyCause, 'origin-unverified');
    assert.match(warnings.join(' '), /cause=origin-unverified/);
    assert.doesNotMatch(warnings.join(' '), new RegExp(secret));
  } finally { removeFixture(root); }
});

test('a configured clone fetches and archives the requested commit without moving its checkout', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reviewer-exact-repo-')));
  try {
    const source = makeRepo(root, 'source');
    const rootDir = makeRepo(root, 'review-service');
    const defaultHead = git(source, 'rev-parse', 'HEAD');
    const cloneRoot = join(root, 'clones');
    const targetClone = join(cloneRoot, 'example', 'target');
    mkdirSync(join(cloneRoot, 'example'), { recursive: true });
    git(root, 'clone', '-q', source, targetClone);
    git(targetClone, 'remote', 'set-url', 'origin', 'git@github.com:example/target.git');
    writeFileSync(join(source, 'tracked.txt'), 'reviewed head\n');
    git(source, 'commit', '-qam', 'target change');
    const headSha = git(source, 'rev-parse', 'HEAD');
    const repo = 'example/target';
    const checkoutDir = await resolveRepoCheckoutDir({
      repo, rootDir, env: { ...process.env, ADVERSARIAL_REVIEWER_CLONE_ROOT: cloneRoot },
    });
    let fetches = 0;
    const execFileImpl = async (command, args, options) => {
      const localArgs = [...args];
      if (localArgs.includes('fetch')) {
        assert.deepEqual(localArgs.slice(-2), ['origin', headSha]);
        localArgs[localArgs.length - 2] = source;
        fetches++;
      }
      return { stdout: execFileSync(command, localArgs, { ...options, encoding: 'utf8' }) };
    };
    const stateDir = join(root, 'state');
    const snapshot = await prepareReviewerWorkspace({ repo, checkoutDir, stateDir, headSha, execFileImpl, pinSnapshot: false });
    assert.equal(fetches, 1);
    assert.equal(snapshot.diffOnly, false);
    assert.equal(snapshot.headSha, headSha);
    assert.equal(readFileSync(join(snapshot.snapshotDir, 'tracked.txt'), 'utf8'), 'reviewed head\n');
    assert.equal(git(targetClone, 'rev-parse', 'HEAD'), defaultHead);
    assert.equal(readFileSync(join(targetClone, 'tracked.txt'), 'utf8'), 'base\n');
    const missing = await prepareReviewerWorkspace({
      repo, checkoutDir, stateDir, headSha: 'f'.repeat(40), pinSnapshot: false,
      execFileImpl: async () => { throw new Error('missing object'); },
    });
    assert.equal(missing.diffOnly, true);
    assert.equal(missing.diffOnlyCause, 'head-fetch-failed');
    assert.equal(missing.alertDegradation, true);
    assert.equal(missing.checkoutDir, null);
    assert.deepEqual(readdirSync(missing.snapshotDir), []);
  } finally {
    removeFixture(root);
  }
});

test('PR settings stay outside harness cwd and escaping PR links fall back to diff-only', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reviewer-untrusted-config-')));
  try {
    const checkoutDir = makeRepo(root, 'target');
    mkdirSync(join(checkoutDir, '.claude'));
    writeFileSync(join(checkoutDir, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch compromised' }] }] } }));
    for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.mcp.json']) {
      writeFileSync(join(checkoutDir, name), 'PR-controlled harness input');
    }
    git(checkoutDir, 'add', '.');
    git(checkoutDir, 'commit', '-qm', 'untrusted harness configuration');
    const args = { repo: 'example/target', checkoutDir, stateDir: join(root, 'state'), pinSnapshot: false };
    const snapshot = await prepareReviewerWorkspace({ ...args, headSha: git(checkoutDir, 'rev-parse', 'HEAD') });
    assert.equal(snapshot.diffOnly, false);
    assert.notEqual(snapshot.subprocessCwd, snapshot.snapshotDir);
    assert.deepEqual(readdirSync(snapshot.subprocessCwd), []);
    assert.ok(existsSync(join(snapshot.snapshotDir, '.claude', 'settings.json')));
    assert.ok(existsSync(join(snapshot.snapshotDir, 'CLAUDE.md')));
    symlinkSync('/etc/hosts', join(checkoutDir, 'escape'));
    git(checkoutDir, 'add', 'escape');
    git(checkoutDir, 'commit', '-qm', 'escaping PR symlink');
    const warnings = [];
    const fallback = await prepareReviewerWorkspace({ ...args, headSha: git(checkoutDir, 'rev-parse', 'HEAD'),
      log: { warn: message => warnings.push(message) } });
    assert.equal(fallback.diffOnly, true);
    assert.equal(fallback.diffOnlyCause, 'escaping-link');
    assert.equal(fallback.alertDegradation, false);
    assert.deepEqual(readdirSync(fallback.subprocessCwd), []);
    assert.match(warnings.join(' '), /reviewer_workspace_degraded.+cause=escaping-link/);
    const cache = join(args.stateDir, 'reviewer-snapshots');
    assert.equal(readdirSync(join(cache, readdirSync(cache)[0])).some(name => name.startsWith('.build-')), false);
  } finally { removeFixture(root); }
});

test('workspace mode counts are per repository and pages are limited to operational transitions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-modes-'));
  try {
    const checkoutDir = makeRepo(root, 'source');
    const args = { repo: 'example/target', stateDir: join(root, 'state'), pinSnapshot: false,
      headSha: git(checkoutDir, 'rev-parse', 'HEAD'), log: { warn() {}, info() {} } };
    const initial = await prepareReviewerWorkspace(args);
    assert.equal(initial.diffOnlyCause, 'no-checkout');
    assert.equal(initial.alertDegradation, false);
    await prepareReviewerWorkspace({ ...args, checkoutDir });
    writeFileSync(join(checkoutDir, 'tracked.txt'), 'different head');
    git(checkoutDir, 'commit', '-qam', 'change');
    const archiveFailure = await prepareReviewerWorkspace({ ...args, checkoutDir, headSha: git(checkoutDir, 'rev-parse', 'HEAD'),
      extractArchiveImpl: async () => { throw new Error('synthetic archive failure'); } });
    assert.equal(archiveFailure.diffOnlyCause, 'archive-unavailable');
    assert.equal(archiveFailure.alertDegradation, true);
    assert.equal((await prepareReviewerWorkspace(args)).alertDegradation, false);
    await prepareReviewerWorkspace({ ...args, checkoutDir });
    assert.equal((await prepareReviewerWorkspace(args)).alertDegradation, false);
    await prepareReviewerWorkspace({ ...args, repo: 'example/other' });
    const modes = join(args.stateDir, 'reviewer-workspace-audit', 'modes');
    const readMode = name => JSON.parse(readFileSync(join(modes, readdirSync(modes).find(file => file.startsWith(name) && file.endsWith('.json'))), 'utf8'));
    assert.deepEqual(readMode('example_target').diffOnlyCounts, {
      'no-checkout': 3, 'origin-unverified': 0, 'head-fetch-failed': 0, 'archive-unavailable': 1, 'escaping-link': 0,
    });
    assert.equal(readMode('example_other').diffOnlyCounts['no-checkout'], 1);

    const record = (cause, nowMs) => recordReviewerWorkspaceMode({ auditDir: join(root, 'audit'), repoKey: 'target', cause, nowMs });
    record(null, 1);
    assert.deepEqual(record('escaping-link', 2), { diffOnlyCount: 1, degraded: true, alert: false });
    assert.equal(record('head-fetch-failed', 3).alert, true);
    record(null, 4);
    assert.equal(record('origin-unverified', 5).alert, false);
    record(null, 6);
    assert.equal(record('origin-unverified', 24 * 60 * 60 * 1000 + 3).alert, true);
  } finally { removeFixture(root); }
});

test('owned harness cwd survives live owners and groups, then is reclaimed after signal termination', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'reviewer-harness-lifetime-')));
  const workspaceModule = new URL('../src/reviewer-workspace.mjs', import.meta.url).href;
  const processModule = new URL('../src/process-group-spawn.mjs', import.meta.url).href;
  const runner = spawn(process.execPath, ['--input-type=module', '-e', `
    import { prepareReviewerHarnessCwd, auditReviewerSubprocess } from ${JSON.stringify(workspaceModule)};
    import { spawnCapturedProcessGroup } from ${JSON.stringify(processModule)};
    const { cwd } = prepareReviewerHarnessCwd(process.argv[1]);
    await auditReviewerSubprocess(({ onSpawn }) => spawnCapturedProcessGroup(process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'], { cwd, onSpawn: group => {
        onSpawn(group);
        process.send({ cwd, pgid: group.pgid });
      } }), cwd);
  `, root], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(runner, 'exit');
  let pgid;
  try {
    const [{ cwd, pgid: group }] = await Promise.race([
      once(runner, 'message'),
      exited.then(() => { throw new Error('fixture reviewer exited before reporting its cwd'); }),
    ]);
    pgid = group;
    const sweep = () => prepareReviewerHarnessCwd(root).release();
    assert.deepEqual(readdirSync(cwd), []);
    sweep();
    assert.equal(existsSync(cwd), true);
    runner.kill('SIGTERM');
    assert.deepEqual(await exited, [null, 'SIGTERM']);
    sweep();
    assert.equal(existsSync(cwd), true);
    process.kill(-pgid, 'SIGTERM');
    const { pidInUse } = await import('../src/reviewer-harness-cwd.mjs');
    for (let i = 0; i < 100 && pidInUse(-pgid); i++) await delay(20);
    assert.equal(pidInUse(-pgid), false);
    const pending = join(dirname(cwd), 'pending-fixture');
    writeFileSync(pending, '');
    sweep();
    assert.equal(existsSync(cwd), true);
    rmSync(pending);
    sweep();
    assert.equal(existsSync(dirname(cwd)), false);
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
    await exited;
    if (pgid) {
      try { process.kill(-pgid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
    }
    removeFixture(root);
  }
});

test('harness startup rejects symlinked state into a checkout and ancestor project settings', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'reviewer-harness-ancestry-')));
  try {
    const checkout = makeRepo(root, 'source');
    const alias = join(root, 'alias');
    symlinkSync(checkout, alias);
    const args = { repo: 'example/target', stateDir: join(root, 'state'), headSha: 'a'.repeat(40) };
    await assert.rejects(prepareReviewerWorkspace({
      ...args, env: { ADVERSARIAL_REVIEW_WORKSPACE_STATE_DIR: join(alias, 'state') },
    }), /outside the source checkout/);
    writeFileSync(join(root, '.mcp.json'), '{}');
    await assert.rejects(prepareReviewerWorkspace(args), /outside project settings and instructions/);
    await assert.rejects(prepareReviewerWorkspace({
      ...args, checkoutDir: checkout, headSha: git(checkout, 'rev-parse', 'HEAD'),
    }), /outside project settings and instructions/);
  } finally { removeFixture(root); }
});

test('head fetch retries transient errors, preserves caller env and accepts SHA-256', async () => {
  for (const failure of [Object.assign(new Error('RPC failed'), { stderr: 'RPC failed' }),
    Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' })]) {
    let fetches = 0;
    let present = false;
    const sha = 'a'.repeat(64);
    const execFileImpl = async (_command, args, options) => {
      assert.equal(options.env.REVIEWER_FETCH_TEST, 'caller-env');
      assert.equal(options.env.GIT_DIR, undefined);
      if (args.includes('fetch')) {
        assert.ok(args.includes('--no-auto-maintenance'));
        fetches++;
        if (fetches === 1) throw failure;
        present = true;
        return { stdout: '' };
      }
      if (!present) throw new Error('missing commit');
      return { stdout: sha };
    };
    assert.equal(await materializeReviewerHead('/checkout', sha, execFileImpl,
      { REVIEWER_FETCH_TEST: 'caller-env', GIT_DIR: '/foreign' }), true);
    assert.equal(fetches, 2);
  }
});

test('head fetch bounds retry exhaustion and does not retry permanent failures', async () => {
  for (const [message, expected] of [['RPC failed', 3], ['repository not found', 1]]) {
    let fetches = 0;
    const warnings = [];
    assert.equal(await materializeReviewerHead('/checkout', 'a'.repeat(40), async (_command, args) => {
      if (args.includes('fetch')) { fetches++; throw new Error(message); }
      throw new Error('missing commit');
    }, {}, { warn: message => warnings.push(message) }), false);
    assert.equal(fetches, expected);
    assert.match(warnings.join(' '), /cause=head-fetch-failed/);
  }
});

test('Agent OS and adversarial-review snapshots are outside and read-only relative to their source checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-two-repos-'));
  try {
    const stateDir = join(root, 'state');
    for (const name of ['agent-os', 'adversarial-review']) {
      const checkoutDir = makeRepo(root, name);
      const snapshot = await prepareReviewerSnapshot({ repo: `laceyenterprises/${name}`, checkoutDir, stateDir });
      assert.notEqual(snapshot.snapshotDir, checkoutDir);
      assert.equal(readFileSync(join(snapshot.snapshotDir, 'tracked.txt'), 'utf8'), 'base\n');
      assert.equal(statSync(snapshot.snapshotDir).mode & 0o222, 0);
      assert.throws(() => writeFileSync(join(snapshot.snapshotDir, 'write.txt'), 'nope'), /EACCES|EPERM/);
      assert.equal(git(checkoutDir, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all'), '');
    }
  } finally {
    removeFixture(root);
  }
});

test('repo-local review ledger keeps reviewer snapshots and audit outside both live checkouts', async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'reviewer-workspace-live-default-')));
  try {
    const agentOs = makeRepo(root, 'agent-os');
    const toolsDir = join(agentOs, 'tools');
    mkdirSync(toolsDir);
    const reviewRepo = makeRepo(toolsDir, 'adversarial-review');
    const external = join(root, 'hq', 'adversarial-review', 'reviewer-workspace');
    for (const [repo, checkoutDir] of [
      ['laceyenterprises/agent-os', agentOs],
      ['laceyenterprises/adversarial-review', reviewRepo],
    ]) {
      const stateDir = join(reviewRepo, 'data');
      const workspaceStateDir = resolveReviewerWorkspaceStateDir({
        stateDir, checkoutDir, env: { HQ_ROOT: join(root, 'hq') },
      });
      assert.equal(workspaceStateDir, external);
      assert.equal(resolveReviewerWorkspaceStateDir({
        stateDir: external, checkoutDir, env: {}, homeDir: join(root, 'home'),
      }), external);
      assert.equal(resolveReviewerWorkspaceStateDir({
        stateDir, checkoutDir, env: {}, homeDir: join(root, 'home'),
      }), join(root, 'home', '.agent-os', 'adversarial-review', 'reviewer-workspace'));
      const snapshot = await prepareReviewerSnapshot({ repo, checkoutDir, stateDir: workspaceStateDir });
      assert.ok(snapshot.snapshotDir.startsWith(external));
      assert.ok(!snapshot.snapshotDir.startsWith(agentOs));
    }
  } finally {
    removeFixture(root);
  }
});

test('clone-root snapshot with default state stays outside the service checkout and superproject', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reviewer-clone-default-state-')));
  try {
    const superproject = makeRepo(root, 'agent-os');
    const toolsDir = join(superproject, 'tools');
    mkdirSync(toolsDir);
    const serviceCheckoutDir = makeRepo(toolsDir, 'adversarial-review');
    const cloneRoot = join(root, 'clones');
    const cloneOwner = join(cloneRoot, 'example');
    mkdirSync(cloneOwner, { recursive: true });
    const checkoutDir = makeRepo(cloneOwner, 'target');
    const stateDir = join(serviceCheckoutDir, 'data');
    const env = { ADVERSARIAL_REVIEWER_CLONE_ROOT: cloneRoot, HQ_ROOT: join(root, 'hq') };
    const snapshot = await prepareReviewerWorkspace({
      repo: 'example/target', checkoutDir, serviceCheckoutDir, stateDir,
      headSha: git(checkoutDir, 'rev-parse', 'HEAD'), env, pinSnapshot: false,
    });
    assert.equal(snapshot.diffOnly, false);
    assert.equal(snapshot.stateDir, join(root, 'hq', 'adversarial-review', 'reviewer-workspace'));
    assert.ok(snapshot.snapshotDir.startsWith(`${snapshot.stateDir}/`));
    assert.ok(!snapshot.snapshotDir.startsWith(`${superproject}/`));
    assert.ok(!snapshot.snapshotDir.startsWith(`${checkoutDir}/`));
    assert.throws(() => git(snapshot.snapshotDir, 'rev-parse', '--show-toplevel'));
    assert.throws(() => resolveReviewerWorkspaceStateDir({
      stateDir, checkoutDir, serviceCheckoutDir,
      env: { ...env, ADVERSARIAL_REVIEW_WORKSPACE_STATE_DIR: join(superproject, 'data') },
    }), /outside the source checkout/);
  } finally {
    removeFixture(root);
  }
});

test('reviewer workspace state override inside the checkout fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-invalid-root-'));
  try {
    const checkoutDir = join(root, 'checkout');
    mkdirSync(checkoutDir);
    assert.throws(() => resolveReviewerWorkspaceStateDir({
      stateDir: join(checkoutDir, 'data'), checkoutDir,
      env: { ADVERSARIAL_REVIEW_WORKSPACE_STATE_DIR: join(checkoutDir, 'cache') },
    }), /outside the source checkout/);
  } finally {
    removeFixture(root);
  }
});

test('snapshot build failure is fail-closed and does not produce a cache entry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-failure-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    await assert.rejects(
      prepareReviewerSnapshot({
        repo: 'laceyenterprises/agent-os',
        checkoutDir,
        stateDir,
        extractArchiveImpl: async () => { throw new Error('synthetic archive failure'); },
      }),
      /reviewer snapshot unavailable.*synthetic archive failure/,
    );
    const cacheRoot = join(stateDir, 'reviewer-snapshots');
    const cachedTrees = existsSync(cacheRoot)
      ? execFileSync('find', [cacheRoot, '-mindepth', '2', '-maxdepth', '2', '-type', 'd', '!', '-name', '.build-*'], { encoding: 'utf8' }).trim()
      : '';
    assert.equal(cachedTrees, '');
  } finally {
    removeFixture(root);
  }
});

test('snapshot build cleanup does not chmod or traverse symlink targets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-symlink-cleanup-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    const outsideDir = join(root, 'outside-target');
    const outsideFile = join(outsideDir, 'secret.txt');
    mkdirSync(outsideDir);
    writeFileSync(outsideFile, 'secret\n');
    chmodSync(outsideDir, 0o755);
    chmodSync(outsideFile, 0o644);

    await assert.rejects(
      prepareReviewerSnapshot({
        repo: 'laceyenterprises/agent-os',
        checkoutDir,
        stateDir,
        extractArchiveImpl: async (source, destination) => {
          assert.equal(source, checkoutDir);
          symlinkSync(outsideDir, join(destination, 'escape'));
        },
      }),
      (err) => {
        assert.equal(err instanceof ReviewerSnapshotBaseError, true);
        assert.equal(isReviewerSnapshotBaseError(err), true);
        assert.equal(err.linkPath, 'escape');
        assert.equal(err.linkTarget, outsideDir);
        assert.match(err.message, /snapshot contains link escaping its root/);
        return true;
      },
    );

    assert.equal(statSync(outsideDir).mode & 0o777, 0o755);
    assert.equal(statSync(outsideFile).mode & 0o777, 0o644);
  } finally {
    removeFixture(root);
  }
});

test('escaping symlink in the base checkout is an infrastructure error, not a PR verdict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-base-link-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    symlinkSync('../outside', join(checkoutDir, 'escape'));
    git(checkoutDir, 'add', 'escape');
    git(checkoutDir, 'commit', '-qm', 'base symlink');
    const baseHead = git(checkoutDir, 'rev-parse', 'HEAD');
    await assert.rejects(
      prepareReviewerSnapshot({ repo: 'laceyenterprises/agent-os', checkoutDir, stateDir: join(root, 'state') }),
      (err) => {
        assert.equal(err instanceof ReviewerSnapshotBaseError, true);
        assert.equal(err.failureClass, 'reviewer-snapshot-base-invalid');
        assert.equal(err.headSha, baseHead);
        assert.equal(err.linkPath, 'escape');
        assert.equal(err.prNumber, undefined);
        return true;
      },
    );
  } finally {
    removeFixture(root);
  }
});

test('archive extraction rejects instead of hanging when a child exits via signal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-archive-signal-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const largePath = join(checkoutDir, 'large.bin');
    writeFileSync(largePath, Buffer.alloc(8 * 1024 * 1024, 1));
    git(checkoutDir, 'add', 'large.bin');
    git(checkoutDir, 'commit', '-qm', 'large payload');
    const badDestination = join(root, 'not-a-directory');
    writeFileSync(badDestination, 'nope\n');

    const result = await Promise.race([
      extractArchiveOnce(checkoutDir, badDestination, git(checkoutDir, 'rev-parse', 'HEAD'))
        .then(() => ({ status: 'resolved' }), (err) => ({ status: 'rejected', err })),
      new Promise((resolve) => { setTimeout(() => resolve({ status: 'timeout' }), 2000); }),
    ]);

    assert.equal(result.status, 'rejected');
    assert.match(result.err.message, /git archive snapshot failed/);
    assert.doesNotMatch(result.err.message, /git=null|tar=null/);
  } finally {
    removeFixture(root);
  }
});

test('resolveCheckoutHead retries transient git failures', async () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  let attempts = 0;
  const result = await resolveCheckoutHead('/tmp/transient-checkout', async (cmd, args, options) => {
    attempts += 1;
    assert.equal(cmd, 'git');
    assert.deepEqual(args, ['--no-optional-locks', 'rev-parse', '--verify', 'HEAD']);
    assert.equal(options.cwd, '/tmp/transient-checkout');
    if (attempts === 1) {
      const err = new Error('fatal: unable to access repository: Input/output error');
      err.code = 'EIO';
      err.stderr = 'fatal: unable to access repository: Input/output error';
      throw err;
    }
    return { stdout: `${sha}\n` };
  });

  assert.equal(result, sha);
  assert.equal(attempts, 2);
});

test('snapshot archive extraction retries transient git failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-archive-retry-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    let attempts = 0;
    const snapshot = await prepareReviewerSnapshot({
      repo: 'laceyenterprises/agent-os',
      checkoutDir,
      stateDir,
      extractArchiveImpl: async (source, destination) => {
        attempts += 1;
        if (attempts === 1) {
          const err = new Error('git archive snapshot failed: EIO');
          err.code = 'EIO';
          throw err;
        }
        execFileSync('sh', ['-c', 'git --no-optional-locks archive --format=tar HEAD | tar -x -C "$1"', '_', destination], { cwd: source });
      },
    });

    assert.equal(attempts, 2);
    assert.equal(readFileSync(join(snapshot.snapshotDir, 'tracked.txt'), 'utf8'), 'base\n');
  } finally {
    removeFixture(root);
  }
});

test('snapshot cache reuses a HEAD, builds a new HEAD, and garbage-collects stale snapshots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-cache-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    let builds = 0;
    const first = await prepareReviewerSnapshot({
      repo: 'laceyenterprises/agent-os', checkoutDir, stateDir,
      extractArchiveImpl: async (source, destination) => { builds += 1; execFileSync('sh', ['-c', 'git --no-optional-locks archive --format=tar HEAD | tar -x -C "$1"', '_', destination], { cwd: source }); },
    });
    const reuseNowMs = Date.UTC(2026, 0, 2, 3, 4, 5);
    utimesSync(first.snapshotDir, new Date(0), new Date(0));
    utimesSync(join(first.snapshotDir, '.reviewer-snapshot.json'), new Date(0), new Date(0));
    const second = await prepareReviewerSnapshot({ repo: 'laceyenterprises/agent-os', checkoutDir, stateDir });
    assert.equal(second.snapshotDir, first.snapshotDir);
    assert.equal(second.reused, true);
    assert.equal(builds, 1);
    const touched = await prepareReviewerSnapshot({
      repo: 'laceyenterprises/agent-os',
      checkoutDir,
      stateDir,
      nowMs: reuseNowMs,
    });
    assert.equal(touched.snapshotDir, first.snapshotDir);
    assert.equal(touched.reused, true);
    assert.ok(Math.abs(statSync(first.snapshotDir).mtimeMs - reuseNowMs) < 1500);
    assert.ok(Math.abs(statSync(join(first.snapshotDir, '.reviewer-snapshot.json')).mtimeMs - reuseNowMs) < 1500);

    writeFileSync(join(checkoutDir, 'tracked.txt'), 'next\n');
    git(checkoutDir, 'add', 'tracked.txt');
    git(checkoutDir, 'commit', '-qm', 'next');
    chmodSync(first.snapshotDir, 0o755);
    utimesSync(first.snapshotDir, new Date(0), new Date(0));
    const third = await prepareReviewerSnapshot({ repo: 'laceyenterprises/agent-os', checkoutDir, stateDir, maxAgeMs: 1 });
    assert.notEqual(third.snapshotDir, first.snapshotDir);
    assert.equal(existsSync(first.snapshotDir), false);
  } finally {
    removeFixture(root);
  }
});

test('snapshot garbage collection ignores entries concurrently removed before stat', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-gc-race-'));
  try {
    const repoCacheDir = join(root, 'repo-cache');
    const staleDir = join(repoCacheDir, 'stale-head');
    const currentDir = join(repoCacheDir, 'current-head');
    mkdirSync(staleDir, { recursive: true });
    mkdirSync(currentDir, { recursive: true });
    const removed = garbageCollectSnapshots(repoCacheDir, 'current-head', {
      nowMs: Date.UTC(2026, 0, 2),
      maxAgeMs: 1,
      statSyncImpl(entryPath) {
        if (entryPath === staleDir) {
          const err = new Error('concurrently removed');
          err.code = 'ENOENT';
          throw err;
        }
        return statSync(entryPath);
      },
    });

    assert.deepEqual(removed, []);
  } finally {
    removeFixture(root);
  }
});

test('snapshot garbage collection logs an inaccessible stale entry and preserves review availability', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-gc-permission-'));
  try {
    const staleDir = join(root, 'stale-head');
    mkdirSync(staleDir);
    const warnings = [];
    const removed = garbageCollectSnapshots(root, 'current-head', {
      statSyncImpl() {
        const err = new Error('permission denied');
        err.code = 'EPERM';
        throw err;
      },
      log: { warn: (message) => warnings.push(message) },
    });
    assert.deepEqual(removed, []);
    assert.equal(existsSync(staleDir), true);
    assert.match(warnings[0], /snapshot cache cleanup failed.*permission denied/);
  } finally {
    removeFixture(root);
  }
});

test('snapshot build recovers from an invalid existing cache directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-invalid-cache-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    let builds = 0;
    const extractArchiveImpl = async (source, destination) => {
      builds += 1;
      execFileSync('sh', ['-c', 'git --no-optional-locks archive --format=tar HEAD | tar -x -C "$1"', '_', destination], { cwd: source });
    };
    const first = await prepareReviewerSnapshot({
      repo: 'laceyenterprises/agent-os',
      checkoutDir,
      stateDir,
      extractArchiveImpl,
    });
    execFileSync('chmod', ['-R', 'u+w', first.snapshotDir]);
    writeFileSync(join(first.snapshotDir, '.reviewer-snapshot.json'), `${JSON.stringify({ schemaVersion: 1, headSha: first.headSha })}\n`);
    execFileSync('chmod', ['-R', 'a-w', first.snapshotDir]);

    const recovered = await prepareReviewerSnapshot({
      repo: 'laceyenterprises/agent-os',
      checkoutDir,
      stateDir,
      extractArchiveImpl,
    });
    const marker = JSON.parse(readFileSync(join(recovered.snapshotDir, '.reviewer-snapshot.json'), 'utf8'));
    assert.equal(recovered.snapshotDir, first.snapshotDir);
    assert.equal(recovered.reused, false);
    assert.equal(builds, 2);
    assert.equal(marker.headSha, recovered.headSha);
    assert.equal(readFileSync(join(recovered.snapshotDir, 'tracked.txt'), 'utf8'), 'base\n');
  } finally {
    removeFixture(root);
  }
});

test('workspace escape audit records post-probe errors without false escape paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-post-probe-failure-'));
  const originalConsoleError = console.error;
  const errors = [];
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    const auditDir = join(stateDir, 'reviewer-workspace-audit');
    console.error = (...args) => { errors.push(args.map(String).join(' ')); };
    configureReviewerWorkspaceAudit({
      repo: 'laceyenterprises/agent-os', prNumber: 7029, reviewerModel: 'gemini',
      headSha: 'abc126', checkoutDir, stateDir,
    });

    await auditReviewerSubprocess(async ({ onSpawn }) => {
      onSpawn({ pid: process.pid });
      rmSync(checkoutDir, { recursive: true, force: true });
      return { conversationId: 'agy-post-probe-failure' };
    });

    assert.equal(existsSync(join(auditDir, 'reviewer-workspace-escapes.jsonl')), false);
    const auditErrors = readFileSync(join(auditDir, 'reviewer-workspace-audit-errors.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(auditErrors.length, 1);
    assert.equal(auditErrors[0].event, 'reviewer_workspace_escape_audit_error');
    assert.equal(auditErrors[0].phase, 'post');
    assert.equal(auditErrors[0].agyConversationId, 'agy-post-probe-failure');
    assert.ok(errors.some((line) => line.includes('workspace escape state probe failed')));
  } finally {
    console.error = originalConsoleError;
    configureReviewerWorkspaceAudit(null);
    removeFixture(root);
  }
});

for (const extra of ['none', 'untracked', 'modified', 'overlapping', 'staged-overlap', 'deleted-recreated', 'renamed-overlap', 'diff-failure']) {
  test(`checkout HEAD movement explains deploy paths and preserves ${extra} writes`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-head-move-'));
    const originalConsoleError = console.error;
    const records = [];
    try {
      const checkoutDir = makeRepo(root, 'repo');
      const stateDir = join(root, 'state');
      const auditDir = join(stateDir, 'reviewer-workspace-audit');
      writeFileSync(join(checkoutDir, 'extra.txt'), 'base extra\n');
      git(checkoutDir, 'add', 'extra.txt');
      git(checkoutDir, 'commit', '-qm', 'fixture base');
      const beforeHead = git(checkoutDir, 'rev-parse', 'HEAD');
      writeFileSync(join(checkoutDir, 'tracked.txt'), 'deployed content\n');
      git(checkoutDir, 'add', 'tracked.txt');
      if (extra === 'deleted-recreated') git(checkoutDir, 'rm', 'extra.txt');
      if (extra === 'renamed-overlap') git(checkoutDir, 'mv', 'extra.txt', 'renamed\nfile.txt');
      git(checkoutDir, 'commit', '-qm', 'fixture deploy');
      const afterHead = git(checkoutDir, 'rev-parse', 'HEAD');
      git(checkoutDir, 'reset', '--hard', beforeHead);
      console.error = (line) => { if (line.startsWith('{')) records.push(JSON.parse(line)); };
      configureReviewerWorkspaceAudit({
        repo: 'example/repository', prNumber: 1, reviewerModel: 'fixture',
        headSha: 'review-head', checkoutDir, stateDir,
      });
      await auditReviewerSubprocess(async ({ onSpawn }) => {
        onSpawn({ pid: process.pid });
        git(checkoutDir, 'reset', '--hard', afterHead);
        if (extra === 'untracked') writeFileSync(join(checkoutDir, 'new.txt'), 'reviewer write\n');
        if (extra === 'modified') writeFileSync(join(checkoutDir, 'extra.txt'), 'reviewer write\n');
        if (extra === 'overlapping' || extra === 'staged-overlap') {
          writeFileSync(join(checkoutDir, 'tracked.txt'), 'reviewer write\n');
          if (extra === 'staged-overlap') git(checkoutDir, 'add', 'tracked.txt');
        }
        if (extra === 'deleted-recreated') writeFileSync(join(checkoutDir, 'extra.txt'), 'reviewer write\n');
        if (extra === 'renamed-overlap') writeFileSync(join(checkoutDir, 'renamed\nfile.txt'), 'reviewer write\n');
        if (extra === 'diff-failure') {
          writeFileSync(join(checkoutDir, 'new.txt'), 'reviewer write\n');
          // Only the old commit object is removed; HEAD and post-state probes
          // remain readable, but the deployment diff cannot be established.
          rmSync(join(checkoutDir, '.git', 'objects', beforeHead.slice(0, 2), beforeHead.slice(2)));
        }
        return { conversationId: 'fixture-conversation' };
      });
      const escapes = records.filter((record) => record.event === 'reviewer_workspace_escape');
      const headMoves = records.filter((record) => record.event === 'reviewer_workspace_head_moved');
      if (extra === 'none') {
        assert.deepEqual(escapes, []);
        assert.equal(existsSync(join(auditDir, 'reviewer-workspace-escapes.jsonl')), false);
        assert.equal(headMoves.length, 1);
        assert.equal(headMoves[0].checkoutHeadBefore, beforeHead);
        assert.equal(headMoves[0].checkoutHeadAfter, afterHead);
        assert.equal(headMoves[0].explainedPathCount, 1);
      } else {
        assert.equal(escapes.length, 1);
        assert.deepEqual(headMoves, []);
        const event = escapes[0];
        assert.equal(event.checkoutHeadBefore, beforeHead);
        assert.equal(event.checkoutHeadAfter, afterHead);
        assert.equal(event.ambiguous, extra === 'diff-failure');
        assert.equal(event.attribution, extra === 'diff-failure' ? 'checkout-head-moved' : 'unattributed');
        const expectedPaths = {
          untracked: ['new.txt'], modified: ['extra.txt'], overlapping: ['tracked.txt'],
          'staged-overlap': ['tracked.txt'], 'deleted-recreated': ['extra.txt'],
          'renamed-overlap': ['renamed\nfile.txt'], 'diff-failure': ['new.txt', 'tracked.txt'],
        };
        assert.deepEqual(event.paths, expectedPaths[extra]);
        assert.equal(event.agyConversationId, 'fixture-conversation');
        assert.deepEqual(JSON.parse(readFileSync(join(auditDir, 'reviewer-workspace-escapes.jsonl'), 'utf8').trim()), event);
      }
      assert.equal(existsSync(join(auditDir, `live-${process.pid}`)), false);
    } finally {
      console.error = originalConsoleError;
      configureReviewerWorkspaceAudit(null);
      removeFixture(root);
    }
  });
}

for (const probe of ['commit', 'worktree', 'exhausted', 'permanent']) {
  test(`checkout HEAD diff handles ${probe} probe failures with bounded retries`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-diff-retry-'));
    const originalPath = process.env.PATH;
    const originalConsoleError = console.error;
    const records = [];
    try {
      const checkoutDir = makeRepo(root, 'repo');
      const stateDir = join(root, 'state');
      const beforeHead = git(checkoutDir, 'rev-parse', 'HEAD');
      writeFileSync(join(checkoutDir, 'tracked.txt'), 'deployed content\n');
      git(checkoutDir, 'commit', '-qam', 'fixture deploy');
      const afterHead = git(checkoutDir, 'rev-parse', 'HEAD');
      git(checkoutDir, 'reset', '--hard', beforeHead);

      const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      const binDir = join(root, 'bin');
      const counterPath = join(root, 'attempts');
      mkdirSync(binDir);
      // Inject failures at the subprocess boundary without changing audit APIs.
      writeFileSync(join(binDir, 'git'), `#!${process.execPath}
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const counter = ${JSON.stringify(counterPath)};
if (args[1] === 'diff' && args.length === ${probe === 'worktree' ? 9 : 10}) {
  const attempts = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 1;
  writeFileSync(counter, String(attempts));
  if (attempts <= ${probe === 'exhausted' ? 3 : probe === 'permanent' ? 1 : 2}) {
    console.error(${JSON.stringify(probe === 'permanent' ? 'fatal: bad object fixture' : 'fatal: index.lock: Resource temporarily unavailable')});
    process.exit(128);
  }
}
try { execFileSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }); }
catch (err) { process.exit(err.status || 1); }
`, { mode: 0o755 });
      process.env.PATH = `${binDir}:${originalPath}`;
      console.error = (line) => { if (line.startsWith('{')) records.push(JSON.parse(line)); };
      configureReviewerWorkspaceAudit({
        repo: 'example/repository', prNumber: 1, reviewerModel: 'fixture',
        headSha: 'review-head', checkoutDir, stateDir,
      });
      await auditReviewerSubprocess(async () => {
        git(checkoutDir, 'reset', '--hard', afterHead);
      });

      const failed = probe === 'exhausted' || probe === 'permanent';
      assert.equal(Number(readFileSync(counterPath, 'utf8')), probe === 'permanent' ? 1 : 3);
      assert.equal(records.length, 1);
      assert.equal(records[0].event, failed ? 'reviewer_workspace_escape' : 'reviewer_workspace_head_moved');
      const escapePath = join(stateDir, 'reviewer-workspace-audit', 'reviewer-workspace-escapes.jsonl');
      assert.equal(existsSync(escapePath), failed);
      if (failed) {
        assert.equal(records[0].ambiguous, true);
        assert.equal(records[0].attribution, 'checkout-head-moved');
        assert.deepEqual(records[0].paths, ['tracked.txt']);
        assert.deepEqual(JSON.parse(readFileSync(escapePath, 'utf8')), records[0]);
      } else {
        assert.equal(records[0].explainedPathCount, 1);
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      console.error = originalConsoleError;
      configureReviewerWorkspaceAudit(null);
      removeFixture(root);
    }
  });
}

for (const dirt of ['stale checkout', 'modified', 'untracked']) {
  test(`checkout advance explains submodule pointer changes with ${dirt} submodule worktree`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-submodule-'));
    const originalConsoleError = console.error;
    const records = [];
    try {
      const checkoutDir = makeRepo(root, 'repo');
      const submoduleSource = makeRepo(root, 'submodule-source');
      const stateDir = join(root, 'state');
      const submoduleDir = join(checkoutDir, 'dependency');
      git(checkoutDir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', submoduleSource, 'dependency');
      git(checkoutDir, 'commit', '-qam', 'add submodule');
      const beforeHead = git(checkoutDir, 'rev-parse', 'HEAD');
      writeFileSync(join(submoduleSource, 'tracked.txt'), 'new dependency\n');
      git(submoduleSource, 'commit', '-qam', 'update dependency');
      const newPointer = git(submoduleSource, 'rev-parse', 'HEAD');
      git(checkoutDir, 'update-index', '--cacheinfo', `160000,${newPointer},dependency`);
      git(checkoutDir, 'commit', '-qm', 'deploy dependency pointer');
      const afterHead = git(checkoutDir, 'rev-parse', 'HEAD');
      git(checkoutDir, 'reset', '--hard', beforeHead);
      console.error = (line) => { if (line.startsWith('{')) records.push(JSON.parse(line)); };
      configureReviewerWorkspaceAudit({
        repo: 'example/repository', prNumber: 1, reviewerModel: 'fixture',
        headSha: 'review-head', checkoutDir, stateDir,
      });
      await auditReviewerSubprocess(async () => {
        git(checkoutDir, 'reset', '--hard', afterHead);
        if (dirt === 'modified') writeFileSync(join(submoduleDir, 'tracked.txt'), 'build noise\n');
        if (dirt === 'untracked') writeFileSync(join(submoduleDir, 'build.txt'), 'build noise\n');
        // Unrelated parent-checkout writes must still survive the subtraction.
        writeFileSync(join(checkoutDir, 'escaped.txt'), 'reviewer write\n');
      });
      assert.equal(records.length, 1);
      assert.equal(records[0].event, 'reviewer_workspace_escape');
      assert.equal(records[0].ambiguous, false);
      assert.deepEqual(records[0].paths, ['escaped.txt']);
      assert.deepEqual(JSON.parse(readFileSync(join(stateDir, 'reviewer-workspace-audit', 'reviewer-workspace-escapes.jsonl'), 'utf8')), records[0]);
    } finally {
      console.error = originalConsoleError;
      configureReviewerWorkspaceAudit(null);
      removeFixture(root);
    }
  });
}

test('workspace audit bounds reads of large untracked files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-large-file-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    const largePath = join(checkoutDir, 'large.bin');
    writeFileSync(largePath, 'x');
    truncateSync(largePath, 9 * 1024 * 1024);
    chmodSync(largePath, 0o000);
    configureReviewerWorkspaceAudit({
      repo: 'laceyenterprises/agent-os', prNumber: 1129, reviewerModel: 'claude',
      headSha: 'pr-head', checkoutDir, stateDir,
    });
    await auditReviewerSubprocess(async ({ onSpawn }) => {
      onSpawn({ pid: process.pid });
      chmodSync(largePath, 0o600);
    });
    const auditDir = join(stateDir, 'reviewer-workspace-audit');
    const event = JSON.parse(readFileSync(join(auditDir, 'reviewer-workspace-escapes.jsonl'), 'utf8').trim());
    assert.deepEqual(event.paths, ['large.bin']);
    assert.equal(existsSync(join(auditDir, 'reviewer-workspace-audit-errors.jsonl')), false);
  } finally {
    configureReviewerWorkspaceAudit(null);
    removeFixture(root);
  }
});

test('workspace escape audit preserves EPERM live pid records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-eperm-audit-'));
  const originalKill = process.kill;
  const otherPid = 987654;
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    const auditDir = join(stateDir, 'reviewer-workspace-audit');
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, `live-${otherPid}`), '{}\n');
    process.kill = (pid, signal) => {
      if (pid === otherPid && signal === 0) {
        const err = new Error('operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return originalKill(pid, signal);
    };
    configureReviewerWorkspaceAudit({
      repo: 'laceyenterprises/agent-os', prNumber: 7027, reviewerModel: 'gemini',
      headSha: 'abc124', checkoutDir, stateDir,
    });
    await auditReviewerSubprocess(async ({ onSpawn }) => {
      onSpawn({ pid: process.pid });
      writeFileSync(join(checkoutDir, 'escaped.txt'), 'escape\n');
      return { stdout: 'done' };
    });
    const log = readFileSync(join(auditDir, 'reviewer-workspace-escapes.jsonl'), 'utf8');
    const event = JSON.parse(log.trim());
    assert.deepEqual(event.otherLiveReviewerPids, [otherPid]);
    assert.equal(existsSync(join(auditDir, `live-${otherPid}`)), true);
  } finally {
    process.kill = originalKill;
    configureReviewerWorkspaceAudit(null);
    removeFixture(root);
  }
});

test('workspace escape audit detects writes to an already-dirty tracked file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-dirty-escape-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    writeFileSync(join(checkoutDir, 'tracked.txt'), 'dirty before\n');
    assert.match(git(checkoutDir, '--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=all'), /tracked\.txt/);
    configureReviewerWorkspaceAudit({
      repo: 'laceyenterprises/agent-os', prNumber: 7028, reviewerModel: 'gemini',
      headSha: 'abc125', checkoutDir, stateDir,
    });
    await auditReviewerSubprocess(async ({ onSpawn }) => {
      onSpawn({ pid: process.pid });
      writeFileSync(join(checkoutDir, 'tracked.txt'), 'dirty after\n');
      return { stdout: 'done' };
    });
    const log = readFileSync(join(stateDir, 'reviewer-workspace-audit', 'reviewer-workspace-escapes.jsonl'), 'utf8');
    const event = JSON.parse(log.trim());
    assert.deepEqual(event.paths, ['tracked.txt']);
  } finally {
    configureReviewerWorkspaceAudit(null);
    removeFixture(root);
  }
});

test('checkout writes during a model subprocess produce a durable reviewer_workspace_escape event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-workspace-escape-'));
  try {
    const checkoutDir = makeRepo(root, 'repo');
    const stateDir = join(root, 'state');
    configureReviewerWorkspaceAudit({
      repo: 'laceyenterprises/agent-os', prNumber: 7026, reviewerModel: 'gemini',
      headSha: 'abc123', checkoutDir, stateDir,
    });
    await auditReviewerSubprocess(async ({ onSpawn }) => {
      onSpawn({ pid: process.pid });
      writeFileSync(join(checkoutDir, 'escaped.txt'), 'escape\n');
      return { stdout: 'done' };
    });
    const log = readFileSync(join(stateDir, 'reviewer-workspace-audit', 'reviewer-workspace-escapes.jsonl'), 'utf8');
    const event = JSON.parse(log.trim());
    assert.equal(event.event, 'reviewer_workspace_escape');
    assert.equal(event.subprocessPid, process.pid);
    assert.deepEqual(event.paths, ['escaped.txt']);
    assert.ok(event.window.startedAt);
    assert.ok(event.window.endedAt);
  } finally {
    configureReviewerWorkspaceAudit(null);
    removeFixture(root);
  }
});

test('changedStatusPaths only splits arrow notation for rename or copy status lines', () => {
  assert.deepEqual(changedStatusPaths([], ['?? added -> file.txt']), ['added -> file.txt']);
  assert.deepEqual(changedStatusPaths([], ['R  old.txt -> new.txt']), ['new.txt', 'old.txt']);
});

test('snapshot cache evicts least recently used entries for count and byte limits', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-cache-limits-'));
  try {
    for (const [index, name] of ['old', 'middle', 'current'].entries()) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, 'content'), '1234567890');
      utimesSync(join(root, name), new Date(1000 + index), new Date(1000 + index));
    }
    assert.deepEqual(garbageCollectSnapshots(root, 'current', {
      nowMs: 2000, maxAgeMs: Infinity, maxCount: 2, maxBytes: Infinity,
    }), [join(root, 'old')]);
    assert.deepEqual(garbageCollectSnapshots(root, 'current', {
      nowMs: 2000, maxAgeMs: Infinity, maxCount: 2, maxBytes: 10,
    }), [join(root, 'middle')]);
    assert.equal(existsSync(join(root, 'current')), true);
  } finally { removeFixture(root); }
});

test('snapshot GC accounts for trusted marker bytes and walks legacy or invalid markers without following links', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-cache-marker-'));
  try {
    const checkoutDir = makeRepo(root, 'target');
    const outside = join(root, 'outside');
    writeFileSync(outside, 'unrelated');
    symlinkSync('tracked.txt', join(checkoutDir, '.reviewer-snapshot.json'));
    git(checkoutDir, 'add', '.reviewer-snapshot.json');
    git(checkoutDir, 'commit', '-qm', 'reserved marker symlink');
    const args = { repo: 'example/target', checkoutDir, stateDir: join(root, 'state') };
    const older = await prepareReviewerSnapshot({ ...args, nowMs: 1 });
    const markerPath = join(older.snapshotDir, '.reviewer-snapshot.json');
    const olderMarker = JSON.parse(readFileSync(markerPath, 'utf8'));
    assert.equal(olderMarker.treeBytes, Buffer.byteLength('base\n'));
    assert.equal(readFileSync(join(older.snapshotDir, 'tracked.txt'), 'utf8'), 'base\n');
    const olderSize = olderMarker.treeBytes + statSync(markerPath).size;
    rmSync(join(checkoutDir, '.reviewer-snapshot.json'));
    mkdirSync(join(checkoutDir, 'nested'));
    writeFileSync(join(checkoutDir, 'nested', 'file'), 'current');
    git(checkoutDir, 'add', '-A');
    git(checkoutDir, 'commit', '-qm', 'current');
    const current = await prepareReviewerSnapshot({ ...args, nowMs: 2 });
    const currentMarker = join(current.snapshotDir, '.reviewer-snapshot.json');
    const currentSize = statSync(currentMarker).size + JSON.parse(readFileSync(currentMarker, 'utf8')).treeBytes;
    // A current tree with unreadable descendants still contributes cached bytes.
    const nested = join(current.snapshotDir, 'nested');
    chmodSync(nested, 0o000);
    const gc = maxBytes => garbageCollectSnapshots(dirname(current.snapshotDir), current.headSha, {
      maxBytes, maxCount: Infinity, maxAgeMs: Infinity, log: { warn() { assert.fail('unexpected cache tree walk'); } },
    });
    assert.deepEqual(gc(olderSize + currentSize), []);
    assert.deepEqual(gc(olderSize + currentSize - 1), [older.snapshotDir]);
    chmodSync(nested, 0o555);

    const legacy = join(dirname(current.snapshotDir), 'legacy');
    mkdirSync(legacy);
    symlinkSync(outside, join(legacy, 'link'));
    const legacyMarker = join(legacy, '.reviewer-snapshot.json');
    for (const treeBytes of [undefined, -1, Number.MAX_SAFE_INTEGER]) {
      writeFileSync(legacyMarker, JSON.stringify({ schemaVersion: 2, headSha: 'legacy', treeBytes }), { mode: 0o444, flag: 'wx' });
      const total = currentSize + statSync(legacyMarker).size + Buffer.byteLength(outside);
      assert.deepEqual(gc(total), []);
      rmSync(legacyMarker);
    }
    symlinkSync(outside, legacyMarker);
    assert.deepEqual(gc(currentSize), [legacy]);
    assert.equal(readFileSync(outside, 'utf8'), 'unrelated');
  } finally { removeFixture(root); }
});

test('snapshot cache preserves snapshots pinned by a live reviewer', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-cache-pin-'));
  try {
    mkdirSync(join(root, 'active'));
    mkdirSync(join(root, '.leases', 'active'), { recursive: true });
    writeFileSync(join(root, '.leases', 'active', String(process.pid)), '');
    assert.deepEqual(garbageCollectSnapshots(root, 'current', {
      maxAgeMs: 0, maxCount: 0, maxBytes: 0,
    }), []);
    assert.equal(existsSync(join(root, 'active')), true);
  } finally { removeFixture(root); }
});

test('snapshot cache environment knobs have bounded defaults and reject invalid values', async () => {
  const { resolveSnapshotCacheLimits } = await import('../src/reviewer-workspace.mjs');
  assert.deepEqual(resolveSnapshotCacheLimits({}), { maxCount: 8, maxBytes: 4 * 1024 ** 3 });
  assert.deepEqual(resolveSnapshotCacheLimits({
    ADVERSARIAL_REVIEWER_SNAPSHOT_MAX_COUNT: '2', ADVERSARIAL_REVIEWER_SNAPSHOT_MAX_GB: '1',
  }), { maxCount: 2, maxBytes: 1024 ** 3 });
  assert.deepEqual(resolveSnapshotCacheLimits({
    ADVERSARIAL_REVIEWER_SNAPSHOT_MAX_COUNT: '-1', ADVERSARIAL_REVIEWER_SNAPSHOT_MAX_GB: 'invalid',
  }), { maxCount: 8, maxBytes: 4 * 1024 ** 3 });
});

test('snapshot cache recovers garbage left by a dead collector', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-cache-garbage-'));
  try {
    const garbage = join(root, '.gc-2147483647-old-00000000-0000-0000-0000-000000000000');
    mkdirSync(garbage);
    writeFileSync(join(garbage, 'content'), 'left behind');
    assert.deepEqual(garbageCollectSnapshots(root, 'current', { maxAgeMs: Infinity }), [garbage]);
    assert.equal(existsSync(garbage), false);
  } finally { removeFixture(root); }
});


test('checkout identity follows the first fetch URL with secondary origins', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reviewer-multiple-origins-')));
  try {
    const checkout = makeRepo(root, 'target');
    git(checkout, 'remote', 'add', 'origin', 'git@github.com:example/target.git');
    git(checkout, 'config', '--add', 'remote.origin.url', 'https://github.com/other/secondary.git');
    assert.equal(await resolveRepoCheckoutDir({ repo: 'example/target', rootDir: checkout }), checkout);
    assert.equal(await resolveRepoCheckoutDir({ repo: 'other/secondary', rootDir: checkout }), null);
  } finally { removeFixture(root); }
});

test('trusted home MCP settings do not become project harness settings', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'reviewer-home-mcp-')));
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    writeFileSync(join(home, '.mcp.json'), '{}');
    const module = new URL('../src/reviewer-workspace.mjs', import.meta.url).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { readdirSync } from 'node:fs';
      import { join } from 'node:path';
      import { prepareReviewerHarnessCwd } from ${JSON.stringify(module)};
      const result = prepareReviewerHarnessCwd(join(process.argv[1], 'state'));
      assert.deepEqual(readdirSync(result.cwd), []);
    `, home], { env: { ...process.env, HOME: home }, timeout: 10_000 });
  } finally { removeFixture(root); }
});
