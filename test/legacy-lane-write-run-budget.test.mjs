// LEGACYEXECCAP-01: the wrapped command runs on its own budget, and expiry keeps its output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { runLegacyLaneWrite, LEGACY_PROOF_NOMINAL_MS } from '../src/finalization/legacy-lane-write.mjs';
import { runLegacyPrWrite } from '../src/finalization/legacy-pr-write.mjs';
import { runCommandKeepingOutput } from '../src/run-command-keeping-output.mjs';
import { legacyLaneWriteMain } from '../bin/legacy-lane-write.mjs';
import { legacyPrWriteMain } from '../bin/legacy-pr-write.mjs';

const lane = { repository: 'example/review', base: 'main' };
const at = '2026-10-25T00:00:00.000Z';
const idle = { loadAvg1m: 0, cpuCount: 1 };
function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'legacy-run-'));
  openFinalizationQueueStore({ rootDir }).close();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}
function script(rootDir, body) {
  const file = join(rootDir, `cmd-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, body);
  return [process.execPath, [file]];
}
const write = (rootDir, extra) => runLegacyLaneWrite({ rootDir, ...lane, readConfig: () => ({}), load: idle, ...extra });
const flushLoop = `process.stdout.write('partial-out\\n'); process.stderr.write('partial-err\\n'); setInterval(() => {}, 1000);`;
// The execution deadline is tested after the real child has installed its
// handlers. Controlling the parent's timer avoids racing Node startup on CI;
// signal delivery, output collection and process exit remain real.
function readyScript(rootDir, handler) {
  const ready = join(rootDir, 'ready');
  const term = join(rootDir, 'term');
  const [command, argv] = script(rootDir,
    `import { renameSync, writeFileSync } from 'node:fs'; process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(term)}, 'term'); ${handler} });`
    + flushLoop + `writeFileSync(${JSON.stringify(ready + '.tmp')}, String(process.pid)); renameSync(${JSON.stringify(ready + '.tmp')}, ${JSON.stringify(ready)}); setTimeout(() => process.exit(99), 15000).unref();`);
  return { command, argv, ready, term };
}
async function waitForExit(pid) {
  const deadline = Date.now() + 5000;
  while (true) {
    try { process.kill(pid, 0); }
    catch (error) {
      assert.equal(error.code, 'ESRCH');
      return;
    }
    assert.ok(Date.now() < deadline, 'real child exited after SIGKILL');
    await wait(10);
  }
}
async function waitForMarker(path) {
  const deadline = Date.now() + 10_000;
  while (true) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      if (text) return text;
    }
    assert.ok(Date.now() < deadline, `child did not write ${path}`);
    await wait(10);
  }
}


test('run budget defaults are load-aware, independent of the lane deadline, and below a 300 s caller budget', async t => {
  const rootDir = fixture(t);
  let seen;
  const exec = async (_c, _a, o) => { seen = o; return {}; };
  await write(rootDir, { command: 'x', argv: [], now: () => at, deadline: '2026-10-25T00:00:01Z', exec });
  assert.equal(seen.timeout, 240_000);
  await write(rootDir, { command: 'x', argv: [], now: () => at, deadline: '2026-10-25T00:00:01Z', exec,
    load: { enabled: true, maxMultiplier: 20, loadAvg1m: 1000, cpuCount: 1, cpuBusyPercent: 100 } });
  assert.equal(seen.timeout, 600_000);
  await write(rootDir, { command: 'x', argv: [], now: () => at, deadline: '2026-10-25T00:00:01Z', exec, timeoutMs: 1234 });
  assert.equal(seen.timeout, 1234);
  for (const bad of [0, -1, 1.5, NaN, '5', 3_600_001]) {
    await assert.rejects(write(rootDir, { command: 'x', argv: [], exec: () => assert.fail('no run'), timeoutMs: bad }), TypeError);
  }
});

test('a command that outlives the remaining lane deadline still succeeds with its output', async t => {
  const rootDir = fixture(t);
  const [command, argv] = script(rootDir, `setTimeout(() => { console.log('done'); console.error('note'); }, 400);`);
  const result = await write(rootDir, { command, argv, now: () => at, deadline: '2026-10-25T00:00:00.100Z' });
  assert.equal(result.stdout, 'done\n'); assert.equal(result.stderr, 'note\n');
});

test('an already-spent lane deadline still refuses before running', async t => {
  const rootDir = fixture(t);
  await assert.rejects(write(rootDir, { command: 'x', argv: [], now: () => at, deadline: at, exec: () => assert.fail('no run') }), /deadline/);
});

test('hammer audit diagnostics retain actual output, redact credentials and distinguish timeout from proof refusal', async t => {
  const rootDir = fixture(t);
  const diagnostics = join(rootDir, 'writer.json');
  const buffer = () => ({ text: '', write(value) { this.text += value; } });
  const stderr = buffer();
  const argv = ['--root', rootDir, '--repo', lane.repository, '--base', lane.base, '--diagnostics', diagnostics,
    '--', 'node', 'merge-transport'];
  const status = await legacyLaneWriteMain(argv, { stdout: buffer(), stderr, run: async ({ onPhase }) => {
    onPhase('review-proof');
    onPhase('transport');
    return { ok: false, reason: 'legacy writer command timed out after 10 ms', stdout: 'upstream progress\n',
      stderr: `writer log\n${'.'.repeat(2500)}\nRuleset diagnostic\n${'.'.repeat(8000)}\nHTTP 502 upstream disconnected; Bearer synthetic-secret github_pat_SYNTHETICSECRET` };
  } });
  const receipt = JSON.parse(readFileSync(diagnostics, 'utf8'));
  assert.equal(status, 75);
  assert.equal(receipt.phase, 'transport');
  assert.equal(receipt.write, 'unknown');
  assert.ok(receipt.elapsedMs >= receipt.phaseElapsedMs);
  assert.equal(receipt.stdout, 'upstream progress\n');
  for (const output of [receipt.stderr, stderr.text]) {
    assert.doesNotMatch(output, /\[output truncated\]/);
    assert.match(output, /Ruleset diagnostic/);
    assert.match(output, /HTTP 502 upstream disconnected/);
    assert.doesNotMatch(output, /synthetic-secret|SYNTHETICSECRET/);
  }
  assert.match(stderr.text, /\nlegacy lane write refused: legacy writer command timed out/);
  await legacyLaneWriteMain(argv, { stdout: buffer(), stderr: buffer(), run: async () => ({
    stdout: `begin\n${'🎯'.repeat(5000)}\nend`,
  }) });
  const large = JSON.parse(readFileSync(diagnostics, 'utf8')).stdout;
  assert.match(large, /^begin\n[\s\S]*\[output truncated\][\s\S]*\nend$/);
  assert.ok(Buffer.byteLength(large) <= 16 * 1024);
});

test('expiry sends SIGTERM, keeps partial output and names the timeout', async t => {
  const rootDir = fixture(t);
  const { command, argv, ready } = readyScript(rootDir,
    `process.stdout.write('flushed-on-term\\n'); process.exit(143);`);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = write(rootDir, { command, argv, timeoutMs: 600, killGraceMs: 5000 });
  await waitForMarker(ready);
  t.mock.timers.tick(600);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'legacy writer command timed out after 600 ms');
  assert.match(result.stdout, /partial-out\nflushed-on-term\n/); assert.equal(result.stderr, 'partial-err\n');
});

test('a child that ignores SIGTERM is SIGKILLed after the grace and output is kept', async t => {
  const rootDir = fixture(t);
  const { command, argv, ready, term } = readyScript(rootDir, '');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = write(rootDir, { command, argv, timeoutMs: 300, killGraceMs: 300 });
  const pidText = await waitForMarker(ready);
  assert.match(pidText, /^[1-9][0-9]+$/);
  const pid = Number(pidText);
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  t.mock.timers.tick(300);
  await waitForMarker(term);
  t.mock.timers.tick(299);
  assert.doesNotThrow(() => process.kill(pid, 0), 'child survives until the complete grace expires');
  t.mock.timers.tick(1);
  const result = await pending;
  assert.equal(result.ok, false); assert.match(result.reason, /timed out after 300 ms/);
  assert.equal(result.stdout, 'partial-out\n'); assert.equal(result.stderr, 'partial-err\n');
  await waitForExit(pid);
});

test('runner maps exits like execFile: codes pass through, spawn errors reject, maxBuffer kills', async t => {
  const rootDir = fixture(t);
  const [command, argv] = script(rootDir, `console.log('o'); console.error('e'); process.exit(17);`);
  await assert.rejects(runCommandKeepingOutput(command, argv), e => e.code === 17 && e.stdout === 'o\n' && e.stderr === 'e\n');
  await assert.rejects(runCommandKeepingOutput(join(rootDir, 'missing'), []), e => e.code === 'ENOENT' && e.stdout === '');
  const [big, bigArgv] = script(rootDir, `process.stdout.write('x'.repeat(100)); setInterval(() => {}, 1000);`);
  await assert.rejects(runCommandKeepingOutput(big, bigArgv, { maxBuffer: 10 }), e => e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && e.stdout.length === 10);
});

function streams() {
  const s = { out: '', err: '' };
  return { s, io: { stdout: { write: x => { s.out += x; } }, stderr: { write: x => { s.err += x; } } } };
}
const timedOut = { ok: false, reason: 'legacy writer command timed out after 5 ms', stdout: 'partial\n', stderr: 'cut\n' };

test('lane bin relays a timed-out command output plus one reason line, exits 75, and validates --timeout-ms', async () => {
  const base = ['--root', '/fixture', '--repo', lane.repository, '--base', lane.base];
  const { s, io } = streams();
  assert.equal(await legacyLaneWriteMain([...base, '--', 'cmd'], { ...io, run: async () => timedOut }), 75);
  assert.equal(s.out, 'partial\n'); assert.equal(s.err, 'cut\nlegacy lane write refused: legacy writer command timed out after 5 ms\n');
  let seen;
  assert.equal(await legacyLaneWriteMain([...base, '--timeout-ms', '90000', '--', 'cmd'], { ...streams().io, run: async r => { seen = r; return {}; } }), 0);
  assert.equal(seen.timeoutMs, 90000);
  for (const bad of ['0', '-5', '1.5', 'abc', '1e3', '3600001', '']) {
    assert.equal(await legacyLaneWriteMain([...base, '--timeout-ms', bad, '--', 'cmd'], { ...streams().io, run: () => assert.fail('no run') }), 64, bad);
  }
});

test('PR bin relays a timed-out command output plus one reason line, exits 75, and validates --timeout-ms', async () => {
  const base = ['--root', '/fixture', '--repo', lane.repository, '--pr', '5'];
  const { s, io } = streams();
  assert.equal(await legacyPrWriteMain([...base, '--', 'cmd'], { ...io, run: async () => timedOut }), 75);
  assert.equal(s.out, 'partial\n'); assert.equal(s.err, 'cut\nlegacy PR write deferred: legacy writer command timed out after 5 ms\n');
  let seen;
  assert.equal(await legacyPrWriteMain([...base, '--timeout-ms', '90000', '--', 'cmd'], { ...streams().io, run: async r => { seen = r; return {}; } }), 0);
  assert.equal(seen.timeoutMs, 90000);
  for (const bad of ['0', '-5', '1.5', 'abc', '3600001']) {
    assert.equal(await legacyPrWriteMain([...base, '--timeout-ms', bad, '--', 'cmd'], { ...streams().io, run: () => assert.fail('no run') }), 64, bad);
  }
});

test('runLegacyPrWrite forwards the run-budget override to the lane writer', async () => {
  let seen;
  await runLegacyPrWrite({ rootDir: '/fixture', repository: lane.repository, prNumber: 5, command: 'c', argv: [], timeoutMs: 777,
    readCandidate: async () => ({ prState: 'open', headSha: 'A', baseBranch: 'main' }), run: async a => { seen = a; return {}; } });
  assert.equal(seen.timeoutMs, 777);
});

// The proof can succeed while consuming the remaining command budget.
test('successful review proof that spends the run budget is classified as timeout without transport', async t => {
  const rootDir = fixture(t);
  const monotonicNow = performance.now.bind(performance);
  const result = await write(rootDir, { command: 'never-run', argv: [],
    subject: { target: 'https://github.com/example/review/pull/5', head: 'a'.repeat(40) },
    prNumber: 5, reviewValidatedAt: at, timeoutMs: 1000,
    readReviewProof: async () => {
      t.mock.method(performance, 'now', () => monotonicNow() + 2000);
      return { ok: true };
    },
    exec: () => assert.fail('exhausted run budget must never invoke transport'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'legacy-writer-timeout');
});

test('in-lane proof has a short load-aware abort budget and releases the lane without transport', async t => {
  const rootDir = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [timeoutMs, load, expected] of [
    [240_000, idle, LEGACY_PROOF_NOMINAL_MS],
    // HAMWRITERTIMEOUT-01: no fixed cap; the load-aware 15 s x 20 applies in full.
    [600_000, { enabled: true, maxMultiplier: 20, loadAvg1m: 1000, cpuCount: 1, cpuBusyPercent: 100 }, 300_000],
    // A multiplier beyond the remaining run budget is bounded by that budget.
    [120_000, { enabled: true, maxMultiplier: 20, loadAvg1m: 1000, cpuCount: 1, cpuBusyPercent: 100 }, 120_000],
    [1000, idle, 1000],
  ]) {
    let proofSignal;
    let started;
    const admitted = new Promise(resolve => { started = resolve; });
    const pending = write(rootDir, { command: 'never-run', argv: [], timeoutMs, load,
      subject: { target: 'https://github.com/example/review/pull/5', head: 'a'.repeat(40) },
      prNumber: 5, reviewValidatedAt: at,
      readReviewProof: async ({ signal }) => { proofSignal = signal; started(); return new Promise(() => {}); },
      exec: () => assert.fail('expired proof must never invoke transport'),
    });
    await admitted;
    t.mock.timers.tick(expected - 1);
    assert.equal(proofSignal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal((await pending).reason, 'legacy-writer-timeout');
    assert.equal(proofSignal.aborted, true);
  }
  const result = await write(rootDir, { command: 'next-writer', argv: [], exec: async () => ({ stdout: 'released' }) });
  assert.equal(result.stdout, 'released');
});
