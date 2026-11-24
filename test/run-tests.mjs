import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { constants, tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SERIAL_TEST_FILES, orderFiles, planPrShards, workerCount, suiteTimeoutMs } from './helpers/parallel-plan.mjs';
import { fixtureGitEnv } from './helpers/fixture-git-env.mjs';
import { reclaimAbandonedSandboxes, SANDBOX_OWNER_MARKER } from './helpers/runner-sandbox.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(testDir);
const checkoutDataDir = path.join(repoRoot, 'data');
const callerTmpDir = tmpdir();
// Leave room under the macOS 104-byte Unix socket path limit for nested fixtures.
// Restricted workers can require every fixture to remain under an owned parent.
// Such callers must choose a parent compatible with their selected tests' sockets.
const tempBase = process.env.ADVERSARIAL_REVIEW_TEST_TEMP_BASE
  || (Buffer.byteLength(realpathSync(callerTmpDir)) > 60 ? '/tmp' : callerTmpDir);
let sandboxRoot;

function makeWorkerRoot(index) {
  const root = path.join(sandboxRoot, `file-${String(index).padStart(6, '0')}`);
  mkdirSync(root);
  // Keep fixtures outside the symlinked package's ESM scope.
  mkdirSync(path.join(sandboxRoot, `t${index}`));
  mkdirSync(path.join(root, 'compile-cache'));
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (['data', '.git', 'tmp', 'compile-cache', 'config.json'].includes(entry.name)) continue;
    symlinkSync(path.join(repoRoot, entry.name), path.join(root, entry.name),
      entry.isDirectory() ? 'dir' : 'file');
  }
  // Legacy transports use arbitrary fixture owners. Give each worker and its
  // CLI descendants a real no-org config instead of propagating a module
  // override through NODE_OPTIONS. Routing tests supply their own home owner.
  const configPath = path.join(repoRoot, 'config.json');
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  delete config.org;
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  return root;
}

function listFiles(rootDir) {
  try {
    return new Map(readdirSync(rootDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
      .map((entryPath) => [
        path.relative(rootDir, entryPath),
        createHash('sha256').update(
          lstatSync(entryPath).isSymbolicLink()
            ? Buffer.from(readlinkSync(entryPath))
            : readFileSync(entryPath),
        ).digest('hex'),
      ]));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
}

function testFiles() {
  const topLevel = readdirSync(testDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `test/${name}`);
  const adaptersDir = path.join(testDir, 'adapters');
  const adapters = readdirSync(adaptersDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `test/adapters/${name}`);
  return [...topLevel, ...adapters].sort();
}

async function testPlan(files, requested, base, shardIndex, durations) {
  if (requested.length > 0 && base !== undefined) {
    throw new Error('Choose either a diff base or explicit test files');
  }
  if (base !== undefined) {
    const { planAffectedTests } = await import('./helpers/affected-tests.mjs');
    const selection = planAffectedTests(repoRoot, files, base);
    const shards = shardIndex === undefined ? null : planPrShards(selection.files, files, durations);
    return {
      ...selection,
      selectedCount: selection.files.length,
      files: shards ? shards[Number(shardIndex)] : selection.files,
      shard: shards ? `${Number(shardIndex) + 1}/${shards.length}` : undefined,
    };
  }
  if (requested.length === 0) return { mode: 'full', reason: 'no diff base supplied', files };
  const selected = files.filter(file => requested.some(name => (
    path.resolve(repoRoot, name) === path.resolve(repoRoot, file) || path.basename(file) === name
  )));
  if (selected.length !== requested.length) {
    throw new Error(`Expected ${requested.length} test files, found ${selected.length}`);
  }
  return { mode: 'explicit', reason: 'test files supplied on the command line', files: selected };
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { base: { type: 'string' }, 'dry-run': { type: 'boolean' } },
});
const base = values.base ?? (process.env.AR_TEST_PR_BASE || undefined);
const shardIndex = process.env.AR_TEST_PR_SHARD || undefined;
if (shardIndex !== undefined && (base === undefined || !['0', '1'].includes(shardIndex))) {
  throw new Error('AR_TEST_PR_SHARD requires a diff base and must be 0 or 1');
}
const timingHints = path.join(testDir, 'fixtures', 'suite-durations.json');
const durations = existsSync(timingHints) ? JSON.parse(readFileSync(timingHints, 'utf8')) : {};
const plan = await testPlan(testFiles(), positionals, base, shardIndex, durations);
if (values['dry-run']) {
  console.log(JSON.stringify({ base, ...plan }, null, 2));
  process.exit(0);
}
const selectedCount = plan.selectedCount ?? plan.files.length;
console.error(`Test selection: ${plan.mode} (${plan.reason}); ${selectedCount} files`
  + `${plan.shard ? `, shard ${plan.shard} runs ${plan.files.length}` : ''}.`);
if (plan.files.length === 0) process.exit(0);

const checkoutDataExistedBefore = existsSync(checkoutDataDir);
const checkoutDataBefore = listFiles(checkoutDataDir);
const signalHandlers = new Map();
let child;
let timeout;
let forceKillTimeout;
let receivedSignal;
let timedOut = false;

function signalTestGroup(signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    // Some platforms report EPERM rather than ESRCH for an exited group.
    // A refusal while the child is still running must remain an error.
    if (error.code === 'EPERM' && (child.exitCode !== null || child.signalCode !== null)) return;
    if (error.code !== 'ESRCH') throw error;
  }
}

function terminateChild(signal) {
  signalTestGroup(signal);
  forceKillTimeout ??= setTimeout(() => signalTestGroup('SIGKILL'), 5_000);
}

function cleanupSandbox() {
  if (!sandboxRoot) return;
  rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  sandboxRoot = undefined;
}

// Explicit process.exit() and unhandled asynchronous errors outside the runner's
// try block can terminate the process without executing its finally block.
// Exit hooks must be synchronous: stop the test group before removing its files.
process.once('exit', () => {
  try {
    try {
      if (child?.exitCode === null && child?.signalCode === null) signalTestGroup('SIGKILL');
    } finally {
      cleanupSandbox();
    }
  } catch (error) {
    console.error('Test sandbox cleanup failed:', error);
  }
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  const handler = () => {
    receivedSignal ??= signal;
    if (child) terminateChild(signal);
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

try {
  const { reclaimed, failed } = reclaimAbandonedSandboxes(tempBase);
  console.error(`Test sandbox cleanup: reclaimed ${reclaimed} abandoned sandbox(es), failed ${failed}.`);
  sandboxRoot = realpathSync(mkdtempSync(path.join(tempBase, 'art-')));
  writeFileSync(path.join(sandboxRoot, SANDBOX_OWNER_MARKER), JSON.stringify({ version: 1, pid: process.pid }), {
    flag: 'wx', mode: 0o600,
  });
  const sandboxTmpDir = path.join(sandboxRoot, 'tmp');
  mkdirSync(sandboxTmpDir);
  const coordinatorHqRoot = path.join(sandboxTmpDir, 'coordinator-hq');
  const coordinatorHome = path.join(sandboxTmpDir, 'coordinator-home');
  mkdirSync(coordinatorHqRoot);
  mkdirSync(coordinatorHome);
  // Include this run's random sandbox name so concurrent suites cannot trip the guard.
  const fixtureProbePrefix = `adversarial-review-tmp-probe-${path.basename(sandboxRoot)}-`;
  const selected = plan.files;
  const serialFiles = orderFiles(selected.filter(file => SERIAL_TEST_FILES.has(file)), durations);
  const parallelFiles = orderFiles(selected.filter(file => !SERIAL_TEST_FILES.has(file)), durations);
  const files = [...serialFiles, ...parallelFiles];
  const paths = Object.fromEntries(files.map((file, index) => [file, path.join(makeWorkerRoot(index), file)]));
  const concurrency = workerCount(parallelFiles.length);
  const deadlineMs = suiteTimeoutMs(parallelFiles.length);
  const logDir = path.join(sandboxRoot, 'logs');
  mkdirSync(logDir);
  const configPath = path.join(sandboxRoot, 'parallel-config.json');
  writeFileSync(configPath, JSON.stringify({
    files, paths, parallelFiles, concurrency, serialFiles, logDir,
    reportPath: process.env.AR_TEST_TIMINGS ? path.resolve(process.env.AR_TEST_TIMINGS) : undefined,
    checkpointPath: process.env.AR_TEST_CHECKPOINT ? path.resolve(process.env.AR_TEST_CHECKPOINT) : undefined,
    nodeArgs: [
      '--preserve-symlinks', '--preserve-symlinks-main',
      ...['child-leak-guard', 'rate-limit-state-isolation', 'load-aware-timeout-fixture', 'temp-sandbox-guard']
        .flatMap((name) => ['--import', path.join('test', 'helpers', `${name}.mjs`)]),
    ],
  }));
  console.error(`Test plan: ${files.length} files, ${serialFiles.length} exclusive, ${concurrency} parallel workers in measured order.`);
  // Tests own their CLI fixture; an omitted stub must not use host credentials.
  const fixtureBin = path.join(sandboxRoot, 'fixture-bin');
  mkdirSync(fixtureBin);
  writeFileSync(path.join(fixtureBin, 'gh'), '#!/bin/sh\necho "offline fixture: inject a GitHub executor or fake gh" >&2\nexit 78\n', { mode: 0o755 });
  writeFileSync(path.join(fixtureBin, 'codex'), '#!/bin/sh\necho "offline fixture: inject a catalog executor or fake codex" >&2\nexit 78\n', { mode: 0o755 });
  // Home-derived defaults must not be bypassed by inherited auth/session or
  // config paths. Worker run-as users also belong to fixtures, not the host.
  // Refresh commands can mint credentials too, and a known expiry lets a closer
  // skip its refresh. Tests set their own synthetic auth inputs rather than
  // inheriting tokens, their launch commands or their expiries.
  const inheritedStatePaths = new Set([
    // Diff selection applies only to this coordinator. Several test fixtures
    // invoke their own runner with a different repo or explicit file list.
    'AR_TEST_PR_BASE', 'AR_TEST_PR_SHARD',
    'AR_TEST_TIMINGS', 'AR_TEST_CHECKPOINT', 'AR_TEST_SHARD_CONFIG', 'NODE_COMPILE_CACHE', 'NODE_TEST_CONTEXT',
    'CODEX_HOME', 'CODEX_SOURCE_HOME', 'CODEX_AUTH_PATH', 'GEMINI_HOME',
    'GEMINI_OAUTH_CREDS_PATH', 'CLAUDE_CONFIG_DIR',
    'CODEX_SESSION_ROOTS', 'CODEX_SESSION_ROOT',
    'CLAUDE_SESSION_ROOTS', 'CLAUDE_SESSION_ROOT', 'CLAUDE_PROJECTS_ROOT',
    'AGENT_OS_CONFIG_PATH', 'AGENT_OS_ROOT', 'AGENT_OS_DEPLOY_CHECKOUT',
    'ADVERSARIAL_REVIEW_WORKSPACE_STATE_DIR',
    'AGENT_OS_REVIEWER_QUOTA_STATUS_DIR', 'ADVERSARIAL_REVIEW_QUOTA_STATUS_DIR',
    'AGENT_OS_WORKER_RUN_AS_USER', 'HQ_WORKER_RUN_AS_USER',
    // Live-read switches belong to the worker; offline fixtures opt in explicitly.
    'ADVERSARIAL_DISPATCH_READS_ENABLED', 'ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED',
    'HQ_LAUNCH_REQUEST_ID', 'LAUNCH_REQUEST_ID', 'AGENT_OS_WORKER_LRQ_ID',
    'AGENT_OS_WORKER_SPAWN_MARKER', 'HAM_CONTROLLER_RECORD', 'HAM_CONTROLLER_TOKEN',
    'HAM_CONTROLLER_PID', 'HAM_CONTROLLER_FD',
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ]);
  // Live Hammer head, lease and audit state belongs to the owning controller.
  // Synthetic phase fixtures must supply their own state instead of inheriting it.
  const testEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !inheritedStatePaths.has(key)
    && !key.startsWith('HCP_') && !key.startsWith('HAM_') && !/^(?:GH_.*TOKEN|GITHUB_.*TOKEN|.*_GH_TOKEN)(?:_REFRESH_COMMAND|_EXPIRES_AT)?$/.test(key)));
  child = spawn(process.execPath, [path.join(testDir, 'helpers', 'parallel-runner.mjs'), configPath], {
    cwd: sandboxRoot,
    env: fixtureGitEnv({
      ...testEnv,
      // The preload replaces these again in each test-file process. Even the
      // node:test coordinator must never inherit the caller's live roots.
      HQ_ROOT: coordinatorHqRoot,
      AGENT_OS_HQ_ROOT: coordinatorHqRoot,
      AGENT_OS_DEPLOY_CHECKOUT: path.join(sandboxTmpDir, 'deploy-checkout'),
      GIT_CEILING_DIRECTORIES: sandboxRoot,
      HOME: coordinatorHome,
      USERPROFILE: coordinatorHome,
      GH_CONFIG_DIR: path.join(sandboxRoot, 'gh-config'),
      ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT: sandboxRoot,
      ADVERSARIAL_REVIEW_TEST_TMP_PROBE_PREFIX: fixtureProbePrefix,
      TMPDIR: sandboxTmpDir,
      TMP: sandboxTmpDir,
      TEMP: sandboxTmpDir,
      PATH: [fixtureBin, path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--preserve-symlinks', '--preserve-symlinks-main'].filter(Boolean).join(' '),
    }),
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    detached: process.platform !== 'win32',
  });
  const unfinished = new Set(files);
  const active = new Set();
  child.on('message', ({ file, phase }) => {
    if (!unfinished.has(file)) return;
    if (phase === 'started') active.add(file);
    if (phase === 'completed') {
      unfinished.delete(file);
      active.delete(file);
    }
  });
  const childExit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  if (child.pid) {
    const marker = path.join(sandboxRoot, SANDBOX_OWNER_MARKER);
    writeFileSync(`${marker}.next`, JSON.stringify({ version: 1, pid: process.pid, group: child.pid }), {
      flag: 'wx', mode: 0o600,
    });
    renameSync(`${marker}.next`, marker);
  }

  if (receivedSignal) terminateChild(receivedSignal);
  timeout = setTimeout(() => {
    timedOut = true;
    terminateChild('SIGTERM');
    console.error(`Test deadline reached with ${unfinished.size - active.size} files waiting to start.`
      + ` Active test files: ${[...active].sort().join(', ') || '(none reported)'}.`);
  }, deadlineMs);
  const result = await childExit;

  const checkoutDataAfter = listFiles(checkoutDataDir);
  const leakedFiles = [...checkoutDataAfter].filter(([file, hash]) => checkoutDataBefore.get(file) !== hash).map(([file]) => file);
  if (leakedFiles.length > 0 || (!checkoutDataExistedBefore && existsSync(checkoutDataDir))) {
    console.error(`Test suite wrote into the checkout data directory:\n${leakedFiles.join('\n') || '(directory created)'}`);
    process.exitCode = 1;
  } else if (timedOut) {
    throw Object.assign(new Error(`Test suite timed out after ${deadlineMs / 1000} seconds`), { code: 'ETIMEDOUT' });
  } else if (process.exitCode !== 1) {
    process.exitCode = result.status ?? 1;
  }
  if (receivedSignal) process.exitCode = 128 + constants.signals[receivedSignal];
} finally {
  clearTimeout(timeout);
  clearTimeout(forceKillTimeout);
  try {
    if (receivedSignal || timedOut || (child?.exitCode === null && child?.signalCode === null)) {
      signalTestGroup('SIGKILL');
    }
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    cleanupSandbox();
  }
}
