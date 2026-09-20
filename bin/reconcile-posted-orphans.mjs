#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reconcilePostedFailedOrphans } from '../src/orphan-post-reconcile.mjs';
import { openReviewStateDb } from '../src/review-state.mjs';

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, apply: false, limit: 20 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--root requires a value');
      options.root = value;
    }
    else if (argv[index] === '--limit') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--limit requires a value');
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer');
      options.limit = limit;
    }
    else if (argv[index] === '--apply') options.apply = true;
    else if (argv[index] === '--help' || argv[index] === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return options;
}

function listReviewsWithGh(row) {
  const output = execFileSync(
    'gh',
    ['api', `repos/${row.repo}/pulls/${row.pr_number}/reviews`, '--paginate', '--slurp'],
    { encoding: 'utf8', maxBuffer: 25 * 1024 * 1024 }
  );
  const pages = JSON.parse(output);
  return Array.isArray(pages) ? pages.flat() : [];
}

function getPullWithGh(row) {
  const output = execFileSync(
    'gh',
    ['api', `repos/${row.repo}/pulls/${row.pr_number}`],
    { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 }
  );
  return JSON.parse(output);
}

async function main(argv = process.argv.slice(2), io = process) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    io.stderr.write(`error: ${err.message}\n`);
    return 2;
  }
  if (options.help) {
    io.stdout.write('Usage: npm run reconcile-posted-orphans -- [--root <adversarial-review-root>] [--limit <n>] [--apply]\n');
    return 0;
  }
  const db = openReviewStateDb(options.root);
  try {
    const result = await reconcilePostedFailedOrphans({
      db,
      rootDir: options.root,
      apply: options.apply,
      limit: options.limit,
      listReviews: async (row) => listReviewsWithGh(row),
      getPull: async (row) => getPullWithGh(row),
    });
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.results.some((item) => (
      item.action === 'error' ||
      item.action === 'posted-no-artifact' ||
      item.action === 'reconciled-row-only'
    )) ? 1 : 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

export { main, parseArgs };
