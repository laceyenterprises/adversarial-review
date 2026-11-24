#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { runLegacyLaneWrite, validLegacyRunTimeoutMs } from '../src/finalization/legacy-lane-write.mjs';
import { redactPublicSafeText } from '../src/adapters/comms/github-pr-comments/redaction.mjs';

function safeOutput(value) {
  const safe = redactPublicSafeText(String(value || '').replace(/\bgithub_pat_\w+/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(?:GH_TOKEN|GITHUB_TOKEN)\s*[:=]\s*\S+/gi, '[REDACTED_GITHUB_TOKEN]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''), Infinity);
  const limit = 16 * 1024;
  if (Buffer.byteLength(safe) <= limit) return safe;
  const bytes = Buffer.from(safe);
  const marker = '\n[output truncated]\n';
  const prefix = bytes.subarray(0, 4096).toString().replace(/\uFFFD+$/, '');
  const suffix = bytes.subarray(-(limit - 4096 - marker.length)).toString().replace(/^\uFFFD+/, '');
  return `${prefix}${marker}${suffix}`;
}

export async function legacyLaneWriteMain(argv, { stdout = process.stdout, stderr = process.stderr, run = runLegacyLaneWrite } = {}) {
  const options = {};
  const keys = { '--root': 'rootDir', '--repo': 'repository', '--base': 'base', '--deadline-ms': 'deadline',
    '--timeout-ms': 'timeoutMs', '--review-validated-at': 'reviewValidatedAt', '--pr': 'prNumber', '--diagnostics': 'diagnostics' };
  let i = 0;
  for (; i < argv.length && argv[i] !== '--'; i += 2) {
    if (!keys[argv[i]] || !argv[i + 1]) return 64;
    options[keys[argv[i]]] = argv[i + 1];
  }
  if (!options.rootDir || !options.repository || !options.base || argv[i] !== '--' || !argv[i + 1]) return 64;
  if (options.deadline !== undefined) {
    const ms = Number(options.deadline);
    if (!Number.isSafeInteger(ms) || !Number.isFinite(new Date(ms).getTime())) return 64;
    options.deadline = new Date(ms).toISOString();
  }
  if (options.timeoutMs !== undefined) {
    options.timeoutMs = /^[0-9]+$/.test(options.timeoutMs) ? Number(options.timeoutMs) : NaN;
    if (!validLegacyRunTimeoutMs(options.timeoutMs)) return 64;
  }
  if (options.prNumber !== undefined) {
    options.prNumber = /^[1-9][0-9]*$/.test(options.prNumber) ? Number(options.prNumber) : NaN;
    if (!Number.isSafeInteger(options.prNumber)) return 64;
  }
  const { diagnostics, ...runOptions } = options;
  const started = performance.now();
  let phase = 'lane-admission', phaseStarted = started;
  const output = (stream, text) => stream.write(diagnostics ? safeOutput(text) : text || '');
  function record(exitCode, reason, result, write) {
    if (!diagnostics) return;
    try {
      writeFileSync(diagnostics, JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started),
        phaseElapsedMs: Math.round(performance.now() - phaseStarted), exitCode, reason: safeOutput(reason), write,
        stdout: safeOutput(result?.stdout), stderr: safeOutput(result?.stderr) }), { mode: 0o600 });
    } catch {
      stderr.write('legacy writer diagnostics unavailable\n');
    }
  }
  try {
    const commandArgs = argv.slice(i + 2);
    const headIndex = commandArgs.indexOf('--match-head-commit');
    const result = await run({ ...runOptions, onPhase: name => { phase = name; phaseStarted = performance.now(); },
      subject: { target: commandArgs.find(arg => /^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/[0-9]+$/.test(arg)) ?? null,
      head: headIndex >= 0 ? commandArgs[headIndex + 1] ?? null : null }, command: argv[i + 1], argv: argv.slice(i + 2) });
    if (result?.ok === false) {
      record(75, result.reason, result, phase === 'transport' ? 'unknown' : 'not-invoked');
      output(stdout, result.stdout); output(stderr, result.stderr);
      if (result.stderr && !result.stderr.endsWith('\n')) stderr.write('\n');
      stderr.write(`legacy lane write refused: ${result.reason}${result.reason === 'owner-operation-in-flight' && result.outcome === 'lane-busy' ? `; lane-busy; waited ${result.waitedMs ?? 0}ms` : ''}\n`);
      return 75;
    }
    record(0, 'command-returned', result, 'acknowledged');
    output(stdout, result?.stdout); output(stderr, result?.stderr); return 0;
  } catch (error) {
    const status = Number.isInteger(error.code) ? error.code : Number.isInteger(error.status) ? error.status : 75;
    const stderrText = error.stderr || `${error.message || 'legacy lane write failed; reconciliation may be required'}\n`;
    record(status, 'writer-error', { stdout: error.stdout, stderr: stderrText }, phase === 'transport' ? 'unknown' : 'not-invoked');
    output(stdout, error.stdout);
    output(stderr, stderrText);
    return status;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await legacyLaneWriteMain(process.argv.slice(2));
