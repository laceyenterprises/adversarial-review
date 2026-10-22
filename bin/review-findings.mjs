#!/usr/bin/env node
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { backfillReviewFindings, linkFindingRemediation, readReviewFindings } from '../src/review-finding-records.mjs';

// An explicit database is required. There is no implicit production target,
// provider lookup, history fetch or network operation in this command.
export function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!['show', 'backfill', 'link-job'].includes(command)) throw new Error('expected show, backfill or link-job');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--db', '--repo', '--pr', '--limit', '--after-pass-id', '--after-ordinal', '--job', '--workspace', '--round'].includes(key)
      || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`invalid option: ${key}`);
    options[key] = args[i + 1];
  }
  if (!options['--db']) throw new Error('--db is required');
  const integer = (key, fallback) => {
    if (options[key] === undefined) return fallback;
    if (!/^\d+$/.test(options[key]) || !Number.isSafeInteger(Number(options[key]))) throw new Error(`invalid integer: ${key}`);
    return Number(options[key]);
  };
  const db = new Database(resolve(options['--db']), { fileMustExist: true, readonly: command === 'show', timeout: 100 });
  try {
    const filter = { repo: options['--repo'] ?? null, prNumber: integer('--pr', null),
      afterPassId: integer('--after-pass-id', 0), afterOrdinal: integer('--after-ordinal', 0), limit: integer('--limit', 500) };
    if (command === 'show') {
      const findings = readReviewFindings(db, filter);
      const last = findings.at(-1);
      return { findings, nextCursor: last ? { afterPassId: last.pass_id, afterOrdinal: last.ordinal } : null };
    }
    ensureReviewStateSchema(db);
    if (command === 'backfill') return backfillReviewFindings(db, filter);
    if (!options['--job']) throw new Error('--job is required');
    const job = JSON.parse(readFileSync(options['--job'], 'utf8'));
    return linkFindingRemediation(db, { job, workspaceDir: options['--workspace'] ? resolve(options['--workspace']) : null,
      roundNumber: integer('--round', job.remediationPlan?.currentRound) });
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(main())}\n`); }
  catch (error) { process.stderr.write(`review-findings failed: ${error?.stack || error}\n`); process.exitCode = 1; }
}
