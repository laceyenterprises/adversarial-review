#!/usr/bin/env node
import Database from 'better-sqlite3';
import { retireExpiredFindings, summarizeFindingBacklog } from '../src/findings-backlog.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { backfillReviewFindings, linkFindingRemediation, readReviewFindings } from '../src/review-finding-records.mjs';
import { DEFAULT_BACKFILL_WRITE_DUTY_CYCLE, parseWriteDutyCycle } from '../src/backfill-write-pacer.mjs';

// An explicit database is required. There is no implicit production target,
// provider lookup, history fetch or network operation in this command.
export function main(argv = process.argv.slice(2), writeProgress = text => process.stderr.write(text)) {
  const [command, ...args] = argv;
  if (!['show', 'backlog', 'backfill', 'link-job', 'retire-expired'].includes(command)) {
    throw new Error('expected show, backlog, backfill, link-job or retire-expired');
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (key === '--apply' && command === 'retire-expired' && !options[key]) {
      options[key] = true;
      i--;
      continue;
    }
    const allowed = command === 'retire-expired' ? ['--db', '--repo', '--limit', '--reason']
      : ['--db', '--repo', '--pr', '--limit', '--after-pass-id', '--after-ordinal', '--job', '--workspace', '--round',
        ...(command === 'backfill' ? ['--max-write-duty-cycle'] : [])];
    if (!allowed.includes(key) || options[key]
      || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`invalid option: ${key}`);
    options[key] = args[i + 1];
  }
  if (!options['--db']) throw new Error('--db is required');
  // Validate before opening the database: an invalid pace must not migrate it.
  const maxWriteDutyCycle = parseWriteDutyCycle(options['--max-write-duty-cycle'] ?? DEFAULT_BACKFILL_WRITE_DUTY_CYCLE);
  const integer = (key, fallback) => {
    if (options[key] === undefined) return fallback;
    if (!/^\d+$/.test(options[key]) || !Number.isSafeInteger(Number(options[key]))) throw new Error(`invalid integer: ${key}`);
    return Number(options[key]);
  };
  const db = new Database(resolve(options['--db']), { fileMustExist: true,
    readonly: ['show', 'backlog'].includes(command) || (command === 'retire-expired' && !options['--apply']), timeout: 100 });
  try {
    if (command === 'retire-expired') return retireExpiredFindings(db, {
      repo: options['--repo'], reason: options['--reason'], limit: integer('--limit', 100),
      apply: Boolean(options['--apply']),
    });
    const filter = { repo: options['--repo'] ?? null, prNumber: integer('--pr', null),
      afterPassId: integer('--after-pass-id', 0), afterOrdinal: integer('--after-ordinal', 0), limit: integer('--limit', 500) };
    if (command === 'backlog') return summarizeFindingBacklog(db);
    if (command === 'show') {
      const findings = readReviewFindings(db, filter);
      const last = findings.at(-1);
      return { findings, nextCursor: last ? { afterPassId: last.pass_id, afterOrdinal: last.ordinal } : null };
    }
    ensureReviewStateSchema(db);
    if (command === 'backfill') {
      const progress = { committedPasses: 0, committedInserted: 0, lastPassId: null };
      try {
        return backfillReviewFindings(db, { ...filter, maxWriteDutyCycle, onPass(pass) {
          progress.committedPasses += 1;
          progress.committedInserted += pass.inserted;
          progress.lastPassId = pass.passId;
          writeProgress(`${JSON.stringify({ event: 'backfill-pass', ...pass, ...progress })}\n`);
        } });
      } catch (error) {
        writeProgress(`${JSON.stringify({ event: 'backfill-failed', ...progress })}\n`);
        throw error;
      }
    }
    if (!options['--job']) throw new Error('--job is required');
    const job = JSON.parse(readFileSync(options['--job'], 'utf8'));
    return linkFindingRemediation(db, { job, workspaceDir: options['--workspace'] ? resolve(options['--workspace']) : null,
      roundNumber: integer('--round', job.remediationPlan?.currentRound), historicalProjection: true });
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(main())}\n`); }
  catch (error) { process.stderr.write(`review-findings failed: ${error?.stack || error}\n`); process.exitCode = 1; }
}
