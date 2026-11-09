#!/usr/bin/env node
// Bound one helper, scale once, and retry only an explicitly read-only timeout.
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_TIMER_DELAY_MS } from '../src/load-aware-timeout.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Audit loading probes Git for service provenance. A successful wrapped command
// must not acquire additional Git operations or publication side effects.
async function reportFailure(reason, options) {
  try {
    const { reportHammerEarlyFailure } = await import('../src/ama/hammer-terminal-audit.mjs');
    return reportHammerEarlyFailure(reason, options);
  } catch {
    // An unavailable diagnostic dependency cannot replace the wrapped status.
    process.stderr.write('HAM helper failure audit unavailable\n');
    return null;
  }
}

export function helperBudget(nominal, ceiling) {
  try {
    const value = Number(execFileSync(process.execPath,
      [join(here, 'load-aware-timeout.mjs'), String(nominal), String(ceiling)],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'inherit'] }));
    if (Number.isInteger(value) && value >= nominal && value <= ceiling) return value;
  } catch { /* Sizing failure retains the bounded nominal, never an empty alarm. */ }
  return nominal;
}

// The child stays in the controller's group. Give it TERM cleanup, then KILL;
// wait for exit before retrying. File-backed output prevents an orphan pipe
// from defeating the bound, and prevents partial attempt output from mixing.
async function execute(command, args, { seconds, env, directory }) {
  const out = openSync(join(directory, 'stdout'), 'w', 0o600);
  const err = openSync(join(directory, 'stderr'), 'w', 0o600);
  let child;
  try {
    child = spawn(command, args, { env, stdio: ['inherit', out, err] });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  let timedOut = false;
  let hardStop;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    hardStop = setTimeout(() => child.kill('SIGKILL'), 5000);
  }, seconds * 1000);
  try {
    return await new Promise(resolve => {
      child.once('error', error => resolve({
        code: error.code === 'ENOENT' ? 127 : 1, timedOut, spawnError: error.message,
      }));
      child.once('close', (code, signal) => resolve({
        code: timedOut ? 124 : (code ?? (signal ? 128 + constants.signals[signal] : 1)), timedOut,
      }));
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(hardStop);
  }
}

export async function runHelperStep({ mode, step, nominal, ceiling, command, args = [], env = process.env }, {
  budget = helperBudget,
  report = reportFailure,
  stdout = text => process.stdout.write(text),
  stderr = text => process.stderr.write(text),
} = {}) {
  if (!['read', 'mutation', 'read:report', 'mutation:report'].includes(mode) || !/^[a-z][a-z0-9-]*$/.test(step || '')
    || !Number.isSafeInteger(nominal) || nominal <= 0 || !Number.isSafeInteger(ceiling)
    || ceiling < nominal || ceiling > Math.floor(MAX_TIMER_DELAY_MS / 1000)
    || !command) throw new TypeError('invalid hammer helper step');
  // Callers own retries, tolerated writes and semantic stops unless they
  // explicitly delegate terminal reporting. Child reports stay provisional.
  const reportsFailure = mode.endsWith(':report');
  const attempts = mode.startsWith('read') ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const seconds = budget(nominal, ceiling);
    if (!Number.isFinite(seconds) || seconds < nominal || seconds > ceiling) {
      throw new TypeError('invalid hammer helper budget');
    }
    const multiplierMilli = Math.round(seconds / nominal * 1000);
    stderr(`HAM helper step=${step} attempt=${attempt}/${attempts} budget=${seconds}s loadMultiplier=${seconds / nominal}\n`);
    const directory = mkdtempSync(join(env.TMPDIR || tmpdir(), 'ham-helper-'));
    try {
      const reasonFile = join(directory, 'failure-reason');
      const result = await execute(command, args, { seconds, directory,
        env: { ...env, HAM_HELPER_FAILURE_FILE: reasonFile } });
      const output = readFileSync(join(directory, 'stdout'), 'utf8');
      const errors = readFileSync(join(directory, 'stderr'), 'utf8')
        + (result.spawnError ? `${result.spawnError}\n` : '');
      stderr(errors);
      const timeout = result.timedOut || [124, 142].includes(result.code)
        || (result.code === 1 && /\b(?:ETIMEDOUT|timed out|timeout)\b/i.test(
          errors.replace(/^\[load-aware-timeout\].*$/gm, '')));
      if (result.code === 0) {
        stdout(output);
        return 0;
      }
      // Local shell construction is not an observation of GitHub. Retry only
      // read-only commands, then yield to the existing closer retry owner.
      const commandError = mode.startsWith('read') && (result.code === 127
        || ([1, 2].includes(result.code)
          && /(?:\bbash:|\beval:|:\s*line \d+:)[^\n]*(?:syntax error|unexpected EOF while looking for matching)/i.test(errors)));
      if (commandError) {
        stderr('HAM helper failure reason=hammer-command-error; correct the command and retry this read\n');
        if (attempt < attempts) continue;
        if (reportsFailure) await report('hammer-command-error', { env });
        return 75;
      }
      if (timeout && attempt < attempts) continue;
      // Keep API publication receipts even on failure. Never replay a mutation.
      stdout(output);
      let reason = `${step}-failed`;
      try { reason = readFileSync(reasonFile, 'utf8').trim(); } catch { /* No child audit. */ }
      if (timeout) reason = `${step}-timeout:budget-${seconds}s:load-${multiplierMilli}-milli:attempts-${attempt}`;
      stderr(`HAM helper failure reason=${reason}\n`);
      // 20 = semantic stop; 21 = repairable conflict. Their owners have already
      // selected the outcome, possibly at a newer head than the dispatch head.
      if (reportsFailure && ![20, 21].includes(result.code)) await report(reason, { env });
      return result.code;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const [mode, step, nominal, ceiling, command, ...args] = process.argv.slice(2);
  try {
    process.exitCode = await runHelperStep({ mode, step, nominal: Number(nominal),
      ceiling: Number(ceiling), command, args });
  } catch {
    if (mode?.endsWith(':report')) await reportFailure('helper-step-unavailable');
    process.stderr.write('HAM helper-step-unavailable\n');
    process.exitCode = 1;
  }
}
