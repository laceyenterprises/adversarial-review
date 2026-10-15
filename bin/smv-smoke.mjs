#!/usr/bin/env node
// Registered parent runner and local callers execute this same disposable canary.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const declaration = JSON.parse(readFileSync(join(root, 'post-merge-verify.json')));
const mode = process.env.SMV_MODE || 'sandbox';
const started = performance.now();
const commit = process.env.SMV_COMMIT || execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
const scratch = mkdtempSync(join(tmpdir(), 'smv-'));
const steps = [];
let child;
const signalGroup = () => { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } } };
const interrupted = () => { process.exitCode = 1; signalGroup(); };
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, interrupted);
try {
  if (!['sandbox', 'host'].includes(mode)) throw new Error('unknown SMV mode');
  if (mode === 'host' && (process.env.SMV_HOST_CANARY_APPROVED !== '1' || process.env.HQ_WORKER_ID)) throw new Error('host canary requires SRE approval outside a worker');
  const fakeBin = join(scratch, 'bin');
  mkdirSync(fakeBin);
  for (const name of ['gh', 'hq', 'codex', 'claude', 'gemini', 'curl', 'ssh']) writeFileSync(join(fakeBin, name), '#!/bin/sh\necho "SMV: unexpected external boundary" >&2\nexit 78\n', { mode: 0o755 });
  for (const step of declaration.steps) {
    if (process.exitCode) throw new Error('SMV interrupted; no further steps launched');
    const at = performance.now();
    const mirror = join(scratch, step.id); mkdirSync(mirror);
    for (const entry of readdirSync(root)) if (!['.git', 'data'].includes(entry)) symlinkSync(join(root, entry), join(mirror, entry));
    let stdout = '', stderr = '', timedOut = false;
    child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', join(mirror, 'test/helpers/smv-scenario.mjs'), step.id], {
      cwd: mirror, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: [fakeBin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), HOME: scratch,
        TMPDIR: scratch, LANG: 'C', AGENT_OS_CONFIG_PATH: join(scratch, 'absent.yaml'),
        AGENT_OS_SESSION_LEDGER_VDB: 'false', AGENT_OS_SESSION_LEDGER_POSTGRES_RUNTIME: 'off',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' },
    });
    const timer = setTimeout(() => { timedOut = true; signalGroup(); }, Math.min(step.budgetSeconds * 1000 - 1000, 155000 - (performance.now() - started)));
    child.stdout.on('data', b => { stdout = (stdout + b).slice(-16000); });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
    // Kill remaining group members when the leader exits, before waiting on pipes.
    child.once('exit', signalGroup);
    let code;
    try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
    finally { clearTimeout(timer); signalGroup(); child = null; }
    let evidence;
    try { evidence = JSON.parse(stdout.trim().split('\n').at(-1)); } catch { evidence = { error: stderr || stdout || 'no evidence' }; }
    const row = { ...step, verdict: code === 0 && !timedOut && evidence.ok === true ? 'pass' : 'fail',
      durationSeconds: (performance.now() - at) / 1000, observed: evidence, expected: 'all assertions pass', evidence,
      exclusions: declaration.modes[mode].exclusions };
    steps.push(row); process.stdout.write(`${JSON.stringify(row)}\n`);
  }
} catch (error) {
  for (const step of declaration.steps.filter(s => !steps.some(row => row.id === s.id))) {
    const row = { ...step, verdict: 'fail', durationSeconds: 0, observed: error.message, expected: 'safe canary completed', evidence: { error: error.message }, exclusions: [] };
    steps.push(row); process.stdout.write(`${JSON.stringify(row)}\n`);
  }
} finally {
  signalGroup(); rmSync(scratch, { recursive: true, force: true });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, interrupted);
}
const durationSeconds = (performance.now() - started) / 1000;
const verdict = !process.exitCode && durationSeconds <= 180 && steps.every(s => s.verdict === 'pass') ? 'pass' : 'fail';
process.stdout.write(`${JSON.stringify({ module: declaration.module, mode, commit, verdict, durationSeconds, steps })}\n`);
process.exitCode = verdict === 'pass' ? 0 : 1;
