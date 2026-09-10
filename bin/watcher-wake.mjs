#!/usr/bin/env node
/**
 * Fire the watcher wake hook.
 *
 * HAM and other short-lived workers use this to nudge the long-running watcher
 * after they make a PR immediately actionable, without re-implementing the
 * wake-file atomic write contract in shell.
 */

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { requestWatcherWake } from '../src/watcher-wake.mjs';

const USAGE = `\
Usage:
  watcher-wake --root-dir <path> --repo <owner/name> --pr <n>
               [--head-sha <sha>] [--reason <text>]
               [--requested-at <iso>] [--request-id <id>]

Options:
  --root-dir      adversarial-review root directory
  --repo          repository in owner/name form
  --pr            pull request number
  --pr-number     alias for --pr
  --head-sha      optional PR head SHA for per-head wake rate caps
  --head          alias for --head-sha
  --reason        wake reason; defaults to hammer-pr-eligible
  --requested-at  optional deterministic timestamp
  --request-id    optional deterministic request id
`;

function usageError(stderr, message) {
  stderr.write(`error: ${message}\n${USAGE}`);
  return 64;
}

function parseCliArgs(argv) {
  return parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      'root-dir': { type: 'string' },
      repo: { type: 'string' },
      pr: { type: 'string' },
      'pr-number': { type: 'string' },
      'head-sha': { type: 'string' },
      head: { type: 'string' },
      reason: { type: 'string' },
      'requested-at': { type: 'string' },
      'request-id': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
}

function isSafeRepo(value) {
  const match = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)$/.exec(value);
  if (!match) return false;
  return match.slice(1).every((part) => part !== '.' && part !== '..');
}

function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const requestWatcherWakeImpl = deps.requestWatcherWakeImpl || requestWatcherWake;

  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    return usageError(stderr, err?.message || 'invalid arguments');
  }

  const { values } = parsed;
  if (values.help) {
    stdout.write(USAGE);
    return 0;
  }

  const rootDir = String(values['root-dir'] || '').trim();
  const repo = String(values.repo || '').trim();
  const prRaw = String(values.pr || values['pr-number'] || '').trim();
  const headSha = String(values['head-sha'] || values.head || '').trim();
  const reason = String(values.reason || 'hammer-pr-eligible').trim();
  const requestedAt = String(values['requested-at'] || '').trim();
  const requestId = String(values['request-id'] || '').trim();

  if (!rootDir) return usageError(stderr, '--root-dir is required');
  if (!isSafeRepo(repo)) {
    return usageError(stderr, '--repo must be shaped owner/name');
  }
  const prNumber = Number(prRaw);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return usageError(stderr, '--pr must be a positive integer');
  }
  if (!reason || /[\r\n]/.test(reason)) {
    return usageError(stderr, '--reason must be a single non-empty line');
  }

  try {
    const result = requestWatcherWakeImpl({
      rootDir,
      repo,
      prNumber,
      reason,
      ...(headSha ? { headSha } : {}),
      ...(requestedAt ? { requestedAt } : {}),
      ...(requestId ? { requestId } : {}),
    });
    stdout.write(`${JSON.stringify({
      requested: true,
      filePath: result.filePath,
      payload: result.payload,
    })}\n`);
    return 0;
  } catch (err) {
    stderr.write(`watcher-wake-error: ${err?.message || err}\n`);
    return 70;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

export { main };
