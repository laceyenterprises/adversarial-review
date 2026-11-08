#!/usr/bin/env node
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { backfillFindingGrades, readFindingGrades } from '../src/review-finding-grades.mjs';

// Explicit path only; reads never migrate or write the database.
export function main(argv = process.argv.slice(2), write = text => process.stdout.write(text)) {
  const [command, ...args] = argv;
  if (!['show', 'export', 'backfill'].includes(command)) throw new Error('expected show, export or backfill');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--db', '--finding-id', '--repo', '--after-grade-id', '--limit'].includes(args[i])
      || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`invalid option: ${args[i]}`);
    options[args[i]] = args[i + 1];
  }
  if (!options['--db']) throw new Error('--db is required');
  const integer = (key, fallback) => {
    if (options[key] === undefined) return fallback;
    if (!/^\d+$/.test(options[key]) || !Number.isSafeInteger(Number(options[key]))) throw new Error(`invalid integer: ${key}`);
    return Number(options[key]);
  };
  const db = new Database(resolve(options['--db']), { readonly: command !== 'backfill', fileMustExist: true });
  try {
    if (command === 'backfill') {
      ensureReviewStateSchema(db);
      const result = backfillFindingGrades(db);
      write(`${JSON.stringify(result)}\n`);
      return result;
    }
    const grades = readFindingGrades(db, { findingId: options['--finding-id'] ?? null,
      repo: options['--repo'] ?? null, afterGradeId: integer('--after-grade-id', 0), limit: integer('--limit', 500) });
    const result = { grades, nextCursor: grades.at(-1)?.grade_id ?? null };
    if (command === 'export') for (const grade of grades) write(`${JSON.stringify(grade)}\n`);
    else write(`${JSON.stringify(result)}\n`);
    return result;
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { process.stderr.write(`review-grades failed: ${error.message}\n`); process.exitCode = 1; }
}
