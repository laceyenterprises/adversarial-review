import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main } from '../bin/merge-lease.mjs';
import { acquireMergeLease, mergeLeaseAttemptsFilePath } from '../src/ama/merge-lease.mjs';
import { rereviewWakePendingPath } from '../src/rereview-wake.mjs';

const cli = fileURLToPath(new URL('../bin/merge-lease.mjs', import.meta.url));
const repo = 'fixture/repo';
const base = 'main';
const now = new Date().toISOString();

function fixture(t, count = 24000) {
  const rootDir = mkdtempSync(join(tmpdir(), 'cli-output-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const attempts = Array.from({ length: count }, (_, i) => ({
    pr: i + 1, head: i.toString(16).padStart(40, '0'), attempts: 1, retryable: i % 3,
    firstAttemptAt: now, lastAttemptAt: now,
  }));
  const path = mergeLeaseAttemptsFilePath(rootDir, { repo, base });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, updatedAt: now, attempts })}\n`);
  return { rootDir, path, attempts, args: ['status', '--repo', repo, '--base', base, '--root-dir', rootDir] };
}

// Real OS pipes, no exec maxBuffer and no inherited credentials/configuration.
// The deadline kills and reaps the child even when the consumer never drains.
async function run(args, { slow = false, file, legacy = false, brokenPipe = false, entry = cli,
  stalled = false, timeout = 15000 } = {}) {
  const nodeArgs = legacy
    ? ['--input-type=module', '-e', `import { main } from ${JSON.stringify(new URL('../bin/merge-lease.mjs', import.meta.url).href)}; process.exit(await main(process.argv.slice(1)));`, ...args]
    : [entry, ...args];
  const childHome = mkdtempSync(join(tmpdir(), 'cli-output-home-'));
  const fd = file ? openSync(file, 'w') : undefined;
  let child;
  try {
    child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', ...nodeArgs], {
      cwd: dirname(cli),
      env: { PATH: dirname(process.execPath), TMPDIR: tmpdir(), HOME: childHome,
        USERPROFILE: childHome, HQ_ROOT: join(childHome, 'hq'),
        AGENT_OS_HQ_ROOT: join(childHome, 'hq'), GH_CONFIG_DIR: join(childHome, 'gh') },
      stdio: ['ignore', fd ?? 'pipe', 'pipe'],
      timeout, killSignal: 'SIGKILL',
    });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const chunks = [];
  let stderr = '';
  let resumeTimer;
  if (brokenPipe) child.stdout.destroy();
  else if (stalled) child.stdout.pause();
  else if (child.stdout) {
    child.stdout.on('data', chunk => {
      chunks.push(chunk);
      if (slow) {
        child.stdout.pause();
        resumeTimer = setTimeout(() => child.stdout.resume(), 5);
      }
    });
    if (slow) {
      child.stdout.pause();
      resumeTimer = setTimeout(() => child.stdout.resume(), 150);
    }
  }
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stderr, stdout: Buffer.concat(chunks).toString() }));
    });
  } finally {
    clearTimeout(resumeTimer);
    rmSync(childHome, { recursive: true, force: true });
  }
}

async function expectedOutput(args, inspectedAt) {
  let stdout = '';
  assert.equal(await main(args, {
    nowIso: () => inspectedAt,
    stdout: { write: chunk => { stdout += chunk; } },
  }), 0);
  return stdout;
}

test('legacy forced exit loses large JSON on a slow pipe but completes to a regular file', async t => {
  const f = fixture(t);
  const file = join(f.rootDir, 'legacy.json');
  const regular = await run(f.args, { legacy: true, file });
  assert.equal(regular.code, 0);
  const full = readFileSync(file, 'utf8');
  assert.ok(Buffer.byteLength(full) > 4 * 1024 * 1024);
  assert.equal(full, await expectedOutput(f.args, JSON.parse(full).inspectedAt));
  const piped = await run(f.args, { legacy: true, slow: true });
  assert.equal(piped.code, 0);
  assert.equal(piped.signal, null);
  assert.equal(piped.stderr, '');
  assert.ok(Buffer.byteLength(piped.stdout) < Buffer.byteLength(full));
  assert.throws(() => JSON.parse(piped.stdout), SyntaxError);
  t.diagnostic(`forced exit: ${Buffer.byteLength(piped.stdout)} of ${Buffer.byteLength(full)} bytes`);
});

for (const command of ['status', 'list']) {
  test(`${command} delivers every JSON byte to fast/slow pipes and a regular file without mutating history`, async t => {
    const f = fixture(t);
    const before = readFileSync(f.path);
    f.args[0] = command;
    for (const mode of [{}, { slow: true }, { file: join(f.rootDir, 'fixed.json') }]) {
      const result = await run(f.args, mode);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, '');
      const output = mode.file ? readFileSync(mode.file, 'utf8') : result.stdout;
      const parsed = JSON.parse(output);
      assert.equal(output, await expectedOutput(f.args, parsed.inspectedAt));
      assert.equal(parsed.attempts.length, f.attempts.length);
      assert.deepEqual(parsed.attempts.map(({ ageSeconds, ...entry }) => {
        assert.ok(Number.isFinite(ageSeconds));
        return entry;
      }), f.attempts);
      assert.deepEqual(readFileSync(f.path), before);
    }
  });
}

test('closed stdout is a nonzero failure, not a successful partial JSON receipt', async t => {
  const f = fixture(t);
  const result = await run(f.args, { brokenPipe: true });
  assert.equal(result.signal, null);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /EPIPE/);
});

test('a consumer that never reads remains subject to the caller subprocess deadline', async t => {
  const f = fixture(t);
  const result = await run(f.args, { stalled: true, timeout: 1500 });
  assert.equal(result.code, null);
  assert.equal(result.signal, 'SIGKILL');
});

test('rereview-wake status also drains large backlog JSON to a slow pipe', async t => {
  const f = fixture(t, 0);
  const source = 'fixture-source-'.repeat(200);
  for (let prNumber = 1; prNumber <= 200; prNumber++) {
    const path = rereviewWakePendingPath(f.rootDir, { repo, prNumber, reason: 'operator' });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ repo, prNumber, reason: 'operator', source,
      requestedAt: now, state: 'requested' }));
  }
  const result = await run(['status', '--root-dir', f.rootDir, '--json'], {
    entry: fileURLToPath(new URL('../bin/rereview-wake.mjs', import.meta.url)), slow: true,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.ok(Buffer.byteLength(result.stdout) > 512 * 1024);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.pending, 200);
  assert.equal(parsed.entries.length, 200);
  assert.ok(parsed.entries.every(entry => entry.source === source));
});

test('finite sibling entrypoints drain help output and exit without retained handles', async () => {
  for (const path of ['bin/ama-check.mjs', 'bin/ama-audit.mjs', 'bin/rereview-wake.mjs',
    'bin/watcher-wake.mjs', 'bin/quota-rearm.mjs', 'src/retrigger-review.mjs', 'src/retrigger-remediation.mjs']) {
    const result = await run(['--help'], { entry: fileURLToPath(new URL(`../${path}`, import.meta.url)), slow: true });
    assert.equal(result.code, 0, `${path}: ${result.stderr}`);
    assert.equal(result.signal, null, path);
    assert.match(result.stdout, /[Uu]sage:/, path);
  }
});

test('real entrypoint preserves usage, parked, contention and corrupt-input exit codes', async t => {
  const f = fixture(t, 0);
  const usage = await run(['status']);
  assert.equal(usage.code, 64);
  assert.match(usage.stderr, /--repo is required/);
  const acquire = ['acquire', ...f.args.slice(1), '--pr', '1', '--head', 'head', '--owner-pid', String(process.pid), '--wait', '0'];
  acquireMergeLease({ rootDir: f.rootDir, repo, base, holderPr: 2, holderHead: 'held',
    holderPid: process.pid, holderHost: hostname(), now });
  const contended = await run(acquire);
  assert.equal(contended.code, 75, contended.stderr);
  assert.equal(JSON.parse(contended.stdout).timedOut, true);
  writeFileSync(f.path, JSON.stringify({ schemaVersion: 1, attempts: [{ pr: 1, head: 'head',
    attempts: 5, retryable: 0, firstAttemptAt: now, lastAttemptAt: now }] }));
  const parked = await run(acquire);
  assert.equal(parked.code, 70, parked.stderr);
  assert.equal(JSON.parse(parked.stdout).parked, true);
  writeFileSync(f.path, '{invalid');
  const corrupt = await run(f.args);
  assert.equal(corrupt.code, 75);
  assert.equal(corrupt.stdout, '');
  assert.match(corrupt.stderr, /retryable runtime failure/);
});
