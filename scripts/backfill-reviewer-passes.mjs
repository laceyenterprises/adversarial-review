#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { openReviewStateDb } from '../src/review-state.mjs';
import { backfillReviewerPassesFromWorkspaces } from '../src/reviewer-passes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(join(__dirname, '..'));

const USAGE = `\
Usage:
  node scripts/backfill-reviewer-passes.mjs [--root <path>] [--workspace-root <path>] [--transcript-root <path> ...] [--dry-run] [--json]
`;

function parseArgs(argv) {
  const opts = {
    rootDir: ROOT,
    workspaceRoot: null,
    transcriptRoots: [],
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') opts.rootDir = argv[++i];
    else if (arg === '--workspace-root') opts.workspaceRoot = argv[++i];
    else if (arg === '--transcript-root') opts.transcriptRoots.push(argv[++i]);
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return opts;
}

function defaultTranscriptRoots() {
  return [
    join(process.env.HOME || '', '.claude', 'projects'),
    join(process.env.HOME || '', '.codex', 'sessions'),
  ].filter(Boolean);
}

function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    stdout.write(USAGE);
    return 0;
  }
  const transcriptRoots = opts.transcriptRoots.length > 0
    ? opts.transcriptRoots
    : defaultTranscriptRoots();

  const db = openReviewStateDb(opts.rootDir);
  try {
    const result = backfillReviewerPassesFromWorkspaces(db, {
      rootDir: opts.rootDir,
      workspaceRoot: opts.workspaceRoot,
      transcriptRoots,
      dryRun: opts.dryRun,
    });
    const payload = {
      ...result,
      rootDir: opts.rootDir,
      workspaceRoot: opts.workspaceRoot || join(opts.rootDir, 'data', 'follow-up-jobs', 'workspaces'),
      transcriptRoots,
    };
    if (opts.json) {
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      stdout.write(
        `Backfill inspected ${payload.inspectedWorkspaces} workspaces; ` +
        `${payload.populatedRows} reviewer_passes rows ${opts.dryRun ? 'would be written' : 'written'}.\n`
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

export { main, parseArgs };
