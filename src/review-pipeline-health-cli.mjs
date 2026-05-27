#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import {
  collectReviewPipelineHealth,
  renderReviewPipelinePrometheus,
} from './review-pipeline-health.mjs';

const USAGE = `\
Usage:
  node src/review-pipeline-health-cli.mjs [--root <dir>] [--json | --prometheus | --sentinel] [--now <iso>]
`;

function parseArgs(argv) {
  const options = {
    rootDir: process.cwd(),
    format: 'json',
    now: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      if (!argv[i + 1]) throw new Error('--root requires a directory');
      options.rootDir = argv[++i];
    } else if (arg === '--json') {
      options.format = 'json';
    } else if (arg === '--prometheus') {
      options.format = 'prometheus';
    } else if (arg === '--sentinel') {
      options.format = 'sentinel';
    } else if (arg === '--now') {
      if (!argv[i + 1]) throw new Error('--now requires an ISO timestamp');
      options.now = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.rootDir) {
    throw new Error('--root requires a directory');
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

  const snapshot = collectReviewPipelineHealth({
    rootDir: options.rootDir,
    now: options.now ? () => new Date(options.now) : () => new Date(),
  });
  if (options.format === 'prometheus') {
    stdout.write(renderReviewPipelinePrometheus(snapshot));
  } else if (options.format === 'sentinel') {
    for (const finding of snapshot.findings) {
      stdout.write(`${JSON.stringify(finding)}\n`);
    }
  } else {
    stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

export { main, parseArgs };
