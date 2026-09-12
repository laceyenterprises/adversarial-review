#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import {
  collectReviewLatencyReport,
  renderReviewLatencyReport,
} from './review-latency-report.mjs';

const USAGE = `\
Usage:
  node src/review-latency-cli.mjs report [--root <dir>] [--since <24h>] [--json] [--now <iso>]
`;

const TOOL_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {
    command,
    rootDir: TOOL_ROOT,
    since: '24h',
    json: false,
    now: null,
    help: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--root') {
      if (!rest[i + 1]) throw new Error('--root requires a directory');
      options.rootDir = rest[++i];
    } else if (arg === '--since') {
      if (!rest[i + 1]) throw new Error('--since requires a duration');
      options.since = rest[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--now') {
      if (!rest[i + 1]) throw new Error('--now requires an ISO timestamp');
      options.now = rest[++i];
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown latency argument: ${arg}`);
    }
  }
  if (options.command !== 'report' && !options.help) {
    throw new Error(`Unknown latency command: ${options.command || '<none>'}`);
  }
  if (options.now && Number.isNaN(Date.parse(options.now))) {
    throw new Error('--now must be an ISO timestamp');
  }
  return options;
}

function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  try {
    const report = collectReviewLatencyReport({
      rootDir: options.rootDir,
      since: options.since,
      now: options.now ? () => new Date(options.now) : () => new Date(),
    });
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderReviewLatencyReport(report));
    return 0;
  } catch (err) {
    stderr.write(`error: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

export { main, parseArgs };
