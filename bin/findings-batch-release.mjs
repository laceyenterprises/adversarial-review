#!/usr/bin/env node
import Database from 'better-sqlite3';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { prepareDispatchReadContext } from '../src/dispatch-read-client.mjs';
import { operatorReleaseFindingBatch, validateOperatorRelease } from '../src/findings-batch-release.mjs';

const USAGE = 'usage: findings-batch-release --root <root> --db <db> --batch <id> --mode retry|drop --reason <text> [--accept-unreadable-custody] [--apply]';

// Operator-only (FINDINGSBATCHSTRAND-01): explicit target, read-only preview
// unless --apply. Refuses while any launch that could write the batch is live.
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (['--apply', '--accept-unreadable-custody'].includes(key) && !flags.has(key)) { flags.add(key); continue; }
    if (!['--root', '--db', '--batch', '--mode', '--reason'].includes(key)
      || argv[i + 1] === undefined || argv[i + 1].startsWith('--') || options[key] !== undefined) {
      throw Error(`invalid option: ${key}\n${USAGE}`);
    }
    options[key] = argv[++i];
  }
  for (const key of ['--root', '--db', '--batch', '--mode', '--reason']) {
    if (!options[key]) throw Error(`${key} is required\n${USAGE}`);
  }
  const args = validateOperatorRelease({ batchId: options['--batch'], mode: options['--mode'], reason: options['--reason'] });
  const rootDir = resolve(options['--root']);
  if (resolve(options['--db']) !== join(rootDir, 'data', 'reviews.db')) throw Error('--db must match --root/data/reviews.db');
  const env = dependencies.env ?? process.env;
  // The keyed read uses the review app's own session and grants.
  if (!dependencies.readLaunches) await prepareDispatchReadContext({ env });
  const apply = flags.has('--apply');
  const db = new Database(resolve(options['--db']), { fileMustExist: true, timeout: 5000, readonly: !apply });
  try {
    if (apply) ensureReviewStateSchema(db);
    return await operatorReleaseFindingBatch({ ...dependencies, ...args, db, rootDir, env, apply,
      acceptUnreadableCustody: flags.has('--accept-unreadable-custody') });
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.refused) process.exitCode = 2;
  } catch (error) { process.stderr.write(`findings batch release failed: ${error.message}\n`); process.exitCode = 1; }
}
