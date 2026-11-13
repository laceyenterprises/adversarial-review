#!/usr/bin/env node
// QWV-04: export, verify and (only then) drop the reviews.db hand-repair residue.
//   ar-residue-export.mjs [--root-dir DIR] [--hq-root DIR] [--date YYYY-MM-DD] [--table NAME]...
//                         [--execute [--drop]]
// Default is a dry run: print the plan, write nothing. --execute exports to
// $HQ_ROOT/archive/ar-residue/<UTC date>/ and verifies by re-reading.
// --execute --drop re-verifies that export against the live store, then drops
// the tables and removes the zero-byte DB files and fossil directory it lists.
// Prints one JSON object; exits 2 on a refusal and 64 on a usage error.
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dropResidue, exportResidue, planResidue, ResidueRefusal } from '../src/ar-residue.mjs';

const DEFAULT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function usage(message) {
  return Object.assign(new Error(message), { usage: true });
}

export function main(args = process.argv.slice(2), { env = process.env, now = new Date(), print = console.log } = {}) {
  let arRoot = DEFAULT_ROOT;
  let hqRoot = env.HQ_ROOT || null;
  let date = now.toISOString().slice(0, 10);
  const tables = [];
  let execute = false;
  let drop = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--root-dir' && args[i + 1]) arRoot = resolve(args[++i]);
    else if (args[i] === '--hq-root' && args[i + 1]) hqRoot = resolve(args[++i]);
    else if (args[i] === '--date' && args[i + 1]) date = args[++i];
    else if (args[i] === '--table' && args[i + 1]) tables.push(args[++i]);
    else if (args[i] === '--execute') execute = true;
    else if (args[i] === '--drop') drop = true;
    else if (args[i] === '--dry-run') { /* the default */ }
    else throw usage(`Unknown or incomplete argument: ${args[i]}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw usage(`--date must be YYYY-MM-DD: ${date}`);
  if (drop && !execute) throw usage('--drop requires --execute');
  if (execute && !hqRoot) throw usage('--execute needs --hq-root or HQ_ROOT');
  const archiveDir = hqRoot ? join(hqRoot, 'archive', 'ar-residue', date) : null;
  let result;
  try {
    if (!execute) result = { mode: 'dry-run', archiveDir, ...planResidue({ arRoot, tables }) };
    else if (!drop) result = { mode: 'export', archiveDir, ...exportResidue({ arRoot, archiveDir, tables, now }) };
    else result = { mode: 'drop', ...dropResidue({ arRoot, archiveDir }) };
  } catch (error) {
    if (!(error instanceof ResidueRefusal)) throw error;
    result = { mode: drop ? 'drop' : execute ? 'export' : 'dry-run', refused: error.reason, ...error.detail };
  }
  print(JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = main();
    if (result.refused) process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.usage ? 64 : 1;
  }
}
