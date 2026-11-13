#!/usr/bin/env node
// QWV-04: closer outcomes from the one authoritative store, and whether the
// reviewer_passes closer rows agree with it (see src/ama/closer-pass-projection.mjs).
//   closer-outcome-status.mjs [--root-dir DIR] [--since 30d|ISO] [--apply]
// Read-only by default. --apply rewrites the closer rows that disagree.
// Prints one JSON object; exits 64 on a usage error.
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { refreshCloserPassStatuses, summarizeCloserOutcomes } from '../src/ama/closer-pass-projection.mjs';

const DEFAULT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function parseSince(raw, nowMs) {
  const days = /^(\d+)d$/.exec(raw || '');
  if (days) return new Date(nowMs - Number(days[1]) * 24 * 60 * 60 * 1000).toISOString();
  const ms = Date.parse(raw || '');
  if (!Number.isFinite(ms)) throw Object.assign(new Error(`--since must be <n>d or an ISO time: ${raw}`), { usage: true });
  return new Date(ms).toISOString();
}

export function main(args = process.argv.slice(2), { nowMs = Date.now(), print = console.log } = {}) {
  let rootDir = DEFAULT_ROOT;
  let sinceArg = '30d';
  let apply = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--root-dir' && args[i + 1]) rootDir = resolve(args[++i]);
    else if (args[i] === '--since' && args[i + 1]) sinceArg = args[++i];
    else if (args[i] === '--apply') apply = true;
    else if (args[i] === '--json') { /* JSON is the only output */ }
    else throw Object.assign(new Error(`Unknown or incomplete argument: ${args[i]}`), { usage: true });
  }
  const since = parseSince(sinceArg, nowMs);
  const result = summarizeCloserOutcomes(rootDir, { since });
  const db = new Database(join(rootDir, 'data', 'reviews.db'), { readonly: !apply, fileMustExist: true });
  try {
    if (apply) db.pragma('busy_timeout = 5000');
    result.reviewerPasses = refreshCloserPassStatuses(db, rootDir, { since, dryRun: !apply });
  } finally {
    db.close();
  }
  print(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    console.error(error.message);
    process.exitCode = error.usage ? 64 : 1;
  }
}
