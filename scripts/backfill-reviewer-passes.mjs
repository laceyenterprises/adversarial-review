#!/usr/bin/env node

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backfillReviewerPasses } from '../src/reviewer-pass-tokens.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `\
Usage:
  node scripts/backfill-reviewer-passes.mjs [--root-dir <path>] [--ledger-target <target>] [--ledger-db <deprecated-path>] [--codex-session-root <path>] [--claude-session-root <path>] [--transcript-fallback] [--dry-run] [--json]
`;

function parseArgs(argv) {
  const args = {
    rootDir: ROOT,
    ledgerTarget: null,
    codexSessionRoots: [],
    claudeSessionRoots: [],
    transcriptFallback: false,
    dryRun: false,
    json: false,
  };
  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === '--root-dir') {
      idx += 1;
      if (!argv[idx]) throw new Error('--root-dir requires a value');
      args.rootDir = argv[idx];
    } else if (arg === '--ledger-target' || arg === '--ledger-db') {
      idx += 1;
      if (!argv[idx]) throw new Error(`${arg} requires a value`);
      if (arg === '--ledger-db') {
        args.ledgerTarget = {
          backend: 'sqlite',
          path: argv[idx],
          source: 'deprecated-ledger-db-path',
          deprecatedAlias: true,
        };
        args.ledgerDbDeprecated = true;
      } else {
        args.ledgerTarget = argv[idx];
        args.ledgerDbDeprecated = false;
      }
    } else if (arg === '--codex-session-root') {
      idx += 1;
      if (!argv[idx]) throw new Error('--codex-session-root requires a value');
      args.codexSessionRoots.push(argv[idx]);
      args.transcriptFallback = true;
    } else if (arg === '--claude-session-root') {
      idx += 1;
      if (!argv[idx]) throw new Error('--claude-session-root requires a value');
      args.claudeSessionRoots.push(argv[idx]);
      args.transcriptFallback = true;
    } else if (arg === '--transcript-fallback') {
      args.transcriptFallback = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return args;
}

function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      stdout.write(USAGE);
      return 0;
    }
    if (args.ledgerDbDeprecated) {
      stderr.write('warning: --ledger-db is deprecated; use --ledger-target instead\n');
    }
    const result = backfillReviewerPasses(args.rootDir, {
      ledgerTarget: args.ledgerTarget,
      codexSessionRoots: args.codexSessionRoots,
      claudeSessionRoots: args.claudeSessionRoots,
      transcriptFallback: args.transcriptFallback,
      dryRun: args.dryRun,
    });
    if (args.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(
        `reviewer_passes backfill dry_run=${args.dryRun ? 'true' : 'false'} ` +
        `considered=${result.considered} ` +
        `would_insert_or_update=${result.wouldInsertOrUpdate} ` +
        `unique_pass_keys=${result.uniquePassKeys} ` +
        `inserted_or_updated=${result.insertedOrUpdated} ` +
        `token_matched=${result.tokenMatched} ` +
        `worker_log_matched=${result.workerLogMatched} ` +
        `transcript_matched=${result.transcriptMatched} ` +
        `claude_transcript_matched=${result.claudeTranscriptMatched} ` +
        `skipped=${result.skipped}\n`
      );
    }
    return 0;
  } catch (err) {
    stderr.write(`error: ${err.message}\n\n${USAGE}`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

export { main, parseArgs };
