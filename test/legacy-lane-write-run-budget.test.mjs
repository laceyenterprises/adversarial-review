// LEGACYEXECCAP-01: the wrapped command runs on its own budget, and expiry keeps its output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFinalizationQueueStore } from '../src/finalization/queue-store.mjs';
import { runLegacyLaneWrite } from '../src/finalization/legacy-lane-write.mjs';
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

test('expiry sends SIGTERM, keeps partial output and names the timeout', async t => {
  const rootDir = fixture(t);
  const [command, argv] = script(rootDir, `process.on('SIGTERM', () => { process.stdout.write('flushed-on-term\\n'); process.exit(143); });${flushLoop}`);
  const result = await write(rootDir, { command, argv, timeoutMs: 600, killGraceMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'legacy writer command timed out after 600 ms');
  assert.match(result.stdout, /partial-out\nflushed-on-term\n/); assert.equal(result.stderr, 'partial-err\n');
});

test('a child that ignores SIGTERM is SIGKILLed after the grace and output is kept', async t => {
  const rootDir = fixture(t);
  const [command, argv] = script(rootDir, `process.on('SIGTERM', () => {});${flushLoop}`);
  const started = Date.now();
  const result = await write(rootDir, { command, argv, timeoutMs: 300, killGraceMs: 300 });
  assert.equal(result.ok, false); assert.match(result.reason, /timed out after 300 ms/);
  assert.equal(result.stdout, 'partial-out\n'); assert.equal(result.stderr, 'partial-err\n');
  assert.ok(Date.now() - started >= 600, 'waited the grace before SIGKILL');
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
