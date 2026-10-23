#!/usr/bin/env node
// NXA-02 rollout owner surface: classify live next-action shadow disagreements.
//
// Read-only and bounded: reads at most --max-bytes from the end of the shadow
// log (never the whole history), never writes, and exits 0 whatever the
// evidence says. Dispositions live in the rollout owner's own private JSON file
// ({ "<caseKey>": "candidate-mistake" | "expected-correction" | ... }), outside
// this repository. --aggregate prints anonymous counts only, for publication.
//
//   node bin/next-action-disagreements.mjs [--root <dir>] [--file <log>]
//     [--dispositions <json>] [--max-bytes <n>] [--limit <n>] [--source <name>] [--aggregate]
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextActionShadowLogPath } from '../src/pr-next-action-shadow.mjs';
import { NEXT_ACTION_REPORT_DEFAULT_BYTES, classifyDisagreements, readDispositions,
  readShadowLogTail } from '../src/next-action-disagreements.mjs';

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { root: DEFAULT_ROOT, file: null, dispositions: null, maxBytes: NEXT_ACTION_REPORT_DEFAULT_BYTES,
    limit: 200, source: null, aggregate: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--aggregate') args.aggregate = true;
    else if (['--root', '--file', '--dispositions', '--max-bytes', '--limit', '--source'].includes(flag)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      if (flag === '--root') args.root = value;
      else if (flag === '--file') args.file = value;
      else if (flag === '--dispositions') args.dispositions = value;
      else if (flag === '--max-bytes') args.maxBytes = Number(value);
      else if (flag === '--limit') args.limit = Number(value);
      else args.source = value;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const file = args.file || nextActionShadowLogPath(args.root);
  const tail = readShadowLogTail(file, { maxBytes: args.maxBytes });
  const report = classifyDisagreements(tail.lines, { dispositions: readDispositions(args.dispositions),
    aggregate: args.aggregate, limit: args.limit, source: args.source });
  report.scanned = { ...report.scanned, bytes: tail.bytes, truncated: tail.truncated, missing: tail.missing,
    ...(args.aggregate ? {} : { file }) };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
