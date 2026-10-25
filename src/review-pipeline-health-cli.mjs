#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import { collectReviewLaneLiveness } from './lane-liveness-evidence.mjs';

const USAGE = `\
Usage:
  node src/review-pipeline-health-cli.mjs [--root <dir>] [--hq-root <dir>] [--json | --prometheus | --sentinel] [--now <iso>] [--no-terminal-reconcile] [--lane-liveness]
`;

// The tool root (parent of src/), where this package's `data/reviews.db` lives.
//
// This used to default to `process.cwd()`, which made the health surface report
// a false CLEAN whenever it was invoked from anywhere else. `hq adversarial
// pipeline-health` execs this CLI without `--root`, so running it from the repo
// root resolved the ledger to `<repo>/data/reviews.db`, found nothing, and
// printed an all-zero snapshot with no findings and exit 0 — indistinguishable
// from a healthy idle pipeline. During the 2026-08-22 terminal-Hammer Sev-1 that
// is exactly what an operator saw while two PRs sat 8x over their TTM budget.
// Defaulting to the module's own root makes the common invocation correct;
// `--root` still overrides for callers that vendor the data elsewhere.
const TOOL_ROOT = fileURLToPath(new URL('..', import.meta.url));

function parseArgs(argv) {
  const options = {
    rootDir: TOOL_ROOT,
    hqRoot: process.env.HQ_ROOT || null,
    format: 'json',
    now: null,
    reconcileTerminalState: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      if (!argv[i + 1]) throw new Error('--root requires a directory');
      options.rootDir = argv[++i];
    } else if (arg === '--hq-root') {
      if (!argv[i + 1]) throw new Error('--hq-root requires a directory');
      options.hqRoot = argv[++i];
    } else if (arg === '--json') {
      options.format = 'json';
    } else if (arg === '--prometheus') {
      options.format = 'prometheus';
    } else if (arg === '--sentinel') {
      options.format = 'sentinel';
    } else if (arg === '--now') {
      if (!argv[i + 1]) throw new Error('--now requires an ISO timestamp');
      options.now = argv[++i];
    } else if (arg === '--lane-liveness') {
      options.laneLiveness = true;
    } else if (arg === '--no-terminal-reconcile') {
      options.reconcileTerminalState = false;
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
  if (options.laneLiveness && options.format !== 'json') {
    throw new Error('--lane-liveness supports JSON output only');
  }
  return options;
}

async function main(argv = process.argv.slice(2), io = {}) {
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

  // The full collector imports daemon modules with a writable DB singleton.
  // Keep that graph completely outside the local-only evidence path.
  const health = options.laneLiveness ? null : await import('./review-pipeline-health.mjs');
  const collector = options.laneLiveness ? collectReviewLaneLiveness : health.collectReviewPipelineHealth;
  const snapshot = collector({
    rootDir: options.rootDir,
    ...(options.hqRoot ? { hqRoot: options.hqRoot } : {}),
    now: options.now ? () => new Date(options.now) : () => new Date(),
    reconcileTerminalState: options.reconcileTerminalState,
  });
  if (options.format === 'prometheus') {
    stdout.write(health.renderReviewPipelinePrometheus(snapshot));
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
  process.exitCode = await main();
}

export { main, parseArgs };
