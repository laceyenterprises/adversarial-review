#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { reconcilePostedFailedOrphans } from '../src/orphan-post-reconcile.mjs';

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') options.root = argv[++index];
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

async function main(argv = process.argv.slice(2), io = process) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    io.stderr.write(`error: ${err.message}\n`);
    return 2;
  }
  if (options.help) {
    io.stdout.write('Usage: npm run reconcile-posted-orphans -- [--root <adversarial-review-root>] [--apply]\n');
    return 0;
  }
  const db = new Database(join(options.root, 'data', 'reviews.db'), { readonly: !options.apply });
  try {
    const result = await reconcilePostedFailedOrphans({
      db,
      apply: options.apply,
      listReviews: async (row) => listReviewsWithGh(row),
    });
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.results.some((item) => item.action === 'error') ? 1 : 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

export { main, parseArgs };
