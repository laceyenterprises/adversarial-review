#!/usr/bin/env node

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backfillReviewBodies, formatSummary } from '../src/backfill-review-bodies.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `\
Usage:
  node scripts/backfill-review-bodies.mjs [--root-dir <path>] [--dry-run] [--apply] [--repo <owner/name>] [--limit <n>] [--since <ISO>] [--pass <bodies|closeouts|all>]
`;

function parseArgs(argv) {
  const args = {
    rootDir: ROOT,
    apply: false,
    repo: null,
    limit: null,
    since: null,
    pass: 'all',
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === '--root-dir') {
      idx += 1;
      if (!argv[idx]) throw new Error('--root-dir requires a value');
      args.rootDir = argv[idx];
    } else if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--dry-run') {
      args.apply = false;
    } else if (arg === '--repo') {
      idx += 1;
      if (!argv[idx]) throw new Error('--repo requires a value');
      args.repo = argv[idx];
    } else if (arg === '--limit') {
      idx += 1;
      if (!argv[idx]) throw new Error('--limit requires a value');
      args.limit = argv[idx];
    } else if (arg === '--since') {
      idx += 1;
      if (!argv[idx]) throw new Error('--since requires a value');
      args.since = argv[idx];
    } else if (arg === '--pass') {
      idx += 1;
      if (!argv[idx]) throw new Error('--pass requires a value');
      args.pass = argv[idx];
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return args;
}

async function main(argv = process.argv.slice(2), io = {}, deps = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      stdout.write(USAGE);
      return 0;
    }

    const lines = [];
    const log = (line) => lines.push(String(line));
    const summary = await backfillReviewBodies(args.rootDir, {
      repo: args.repo,
      limit: args.limit,
      since: args.since,
      pass: args.pass,
      apply: args.apply,
      now: deps.now,
      execFileImpl: deps.execFileImpl,
      env: deps.env,
      log,
    });
    if (lines.length > 0) stdout.write(`${lines.join('\n')}\n`);
    stdout.write(`${formatSummary(summary, { apply: args.apply })}\n`);
    return 0;
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${USAGE}`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

export { main, parseArgs };
