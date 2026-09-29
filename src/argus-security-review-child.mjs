#!/usr/bin/env node
// ARGUSDRAIN-01 — review one claimed Argus job in its own process.
//
//   node src/argus-security-review-child.mjs --root <rootDir> --job <jobPath>
//
// The watcher's drain spawns this per claimed job so the model harness (signal
// handlers, token proxies, credential checkouts) never runs inside the watcher.
// It reads the claimed record, never writes the queue, and prints exactly one
// `ARGUS_REVIEW_OUTCOME {json}` line for the drain to apply. Any failure is
// reported as a `retry` outcome, so a crash here costs an attempt, never a job.

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { ARGUS_REVIEW_OUTCOME_PREFIX } from './argus-security-drain.mjs';
import { readArgusJob } from './argus-security-queue.mjs';
import { reviewArgusJob } from './argus-security-review.mjs';
import { createDefaultArgusReviewDeps } from './argus-security-review-deps.mjs';

// Everything but the outcome line goes to stderr, so the harness's own logging
// cannot be mistaken for it.
const logger = {
  log: (...args) => console.error(...args),
  warn: (...args) => console.error(...args),
  error: (...args) => console.error(...args),
};

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function emit(outcome) {
  process.stdout.write(`${ARGUS_REVIEW_OUTCOME_PREFIX}${JSON.stringify(outcome)}\n`);
}

async function main() {
  const rootDir = argValue('--root');
  const jobPath = argValue('--job');
  if (!rootDir || !jobPath) throw new Error('usage: argus-security-review-child.mjs --root <dir> --job <path>');
  const job = readArgusJob(jobPath);
  const workDir = join(rootDir, 'data', 'argus-security-work', job.jobId);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  try {
    emit(await reviewArgusJob({
      job,
      deps: createDefaultArgusReviewDeps({ rootDir, env: process.env, logger }),
      workDir,
      logger,
    }));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  emit({ kind: 'retry', error: `argus review child: ${err?.message || err}` });
});
