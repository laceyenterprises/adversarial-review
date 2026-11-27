#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { runLegacyPrWrite } from '../src/finalization/legacy-pr-write.mjs';
import { validLegacyRunTimeoutMs } from '../src/finalization/legacy-lane-write.mjs';
import { redactPublicSafeText } from '../src/adapters/comms/github-pr-comments/redaction.mjs';

function safeDiagnostic(value) {
  return redactPublicSafeText(value.replace(/\bgithub_pat_\w+/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(?:GH_TOKEN|GITHUB_TOKEN)\s*[:=]\s*\S+/gi, '[REDACTED_GITHUB_TOKEN]'), Infinity);
}

export async function legacyPrWriteMain(argv, { run = runLegacyPrWrite, stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = {};
  const keys = { '--root': 'rootDir', '--repo': 'repository', '--pr': 'prNumber', '--head': 'head', '--timeout-ms': 'timeoutMs' };
  let i = 0;
  for (; i < argv.length && argv[i] !== '--'; i += 2) {
    if (!keys[argv[i]] || !argv[i + 1]) return 64;
    options[keys[argv[i]]] = argv[i + 1];
  }
  options.prNumber = Number(options.prNumber);
  if (!options.rootDir || !options.repository || !Number.isSafeInteger(options.prNumber) || options.prNumber < 1
    || argv[i] !== '--' || !argv[i + 1]) return 64;
  if (options.timeoutMs !== undefined) {
    options.timeoutMs = /^[0-9]+$/.test(options.timeoutMs) ? Number(options.timeoutMs) : NaN;
    if (!validLegacyRunTimeoutMs(options.timeoutMs)) return 64;
  }
  try {
    const result = await run({ ...options, command: argv[i + 1], argv: argv.slice(i + 2) });
    if (result?.ok === false) {
      stdout.write(result.stdout || ''); stderr.write(result.stderr || '');
      stderr.write(`legacy PR write deferred: ${result.reason}\n`); return 75;
    }
    stdout.write(result.stdout || ''); stderr.write(result.stderr || ''); return 0;
  } catch (error) {
    stdout.write(error?.stdout || '');
    const childStderr = String(error?.stderr ?? '');
    let message = String(error?.message ?? error);
    // Child-process errors can embed the entire stderr in their message.
    if (childStderr && message !== childStderr && message.endsWith(childStderr)) {
      message = message.slice(0, -childStderr.length);
    }
    const tail = safeDiagnostic(childStderr).trimEnd().slice(-800);
    if (tail) stderr.write(`${tail}\n`);
    stderr.write(`legacy PR write unavailable; reconcile before retry: ${safeDiagnostic(message).trim().slice(0, 1000)}\n`);
    return Number.isInteger(error?.code) ? error.code : 75;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await legacyPrWriteMain(process.argv.slice(2));
