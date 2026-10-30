#!/usr/bin/env node
import Database from 'better-sqlite3';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { runFindingBatches } from '../src/findings-batch.mjs';
import { summarizeFindingBacklog } from '../src/findings-backlog.mjs';

// Operator-only: explicit target and submission concurrency, no implicit live DB.
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--root', '--db', '--concurrency', '--batch-size'].includes(key)
      || !argv[i + 1] || argv[i + 1].startsWith('--') || options[key]) throw Error(`invalid option: ${key}`);
    options[key] = argv[i + 1];
  }
  if (!options['--root'] || !options['--db'] || !options['--concurrency']) {
    throw Error('--root, --db and --concurrency are required');
  }
  for (const key of ['--concurrency', '--batch-size']) {
    if (options[key] !== undefined && (!/^[1-9]\d*$/.test(options[key])
      || !Number.isSafeInteger(Number(options[key])))) throw Error(`invalid ${key}`);
  }
  const rootDir = resolve(options['--root']);
  if (resolve(options['--db']) !== join(rootDir, 'data', 'reviews.db')) throw Error('--db must match --root/data/reviews.db');
  const db = new Database(resolve(options['--db']), { fileMustExist: true, timeout: 5000 });
  try {
    ensureReviewStateSchema(db);
    const result = await runFindingBatches({ ...dependencies, db, rootDir,
      concurrency: Number(options['--concurrency']),
      ...(options['--batch-size'] ? { batchSize: Number(options['--batch-size']) } : {}) });
    return { ...result, backlog: summarizeFindingBacklog(db) };
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await main())}\n`); }
  catch (error) { process.stderr.write(`findings batch backfill failed: ${error.message}\n`); process.exitCode = 1; }
}
