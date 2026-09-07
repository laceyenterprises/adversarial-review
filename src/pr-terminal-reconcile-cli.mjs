#!/usr/bin/env node
//
// Operator-facing lifecycle reconciliation sweep.
//
// TREC-01 item 3. The watcher runs this reconciliation on every poll tick, but
// an operator staring at a phantom `review:queue_starvation` also needs a safe
// way to ask "is this finding real?" immediately. This command is strictly
// diagnostic: it reports what GitHub says about every open row without writing
// anything. The watcher owns terminal mutation because it also queues the
// durable closeout work that must precede any mark.
//
//   adversarial-review reconcile-terminal             # report only
//
// It deliberately does NOT touch thresholds, delete rows, or resolve anything
// that is genuinely still open on GitHub. A PR that GitHub reports open stays
// exactly as it was, so a real backlog keeps alerting.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { fetchPullRequestHeadAndState } from './github-api.mjs';
import {
  reconcileTerminalPrState,
} from './pr-terminal-reconcile.mjs';

const TOOL_ROOT = fileURLToPath(new URL('..', import.meta.url));
const execFileAsync = promisify(execFile);

const USAGE = `\
Usage:
  adversarial-review reconcile-terminal [--root <dir>] [--cap <n>] [--json]

Reconciles reviewed_prs lifecycle state against authoritative GitHub state and
reports any PR that has since become terminal. This command is diagnostic-only
and does not mutate reviews.db.

  --cap <n>   resolve at most n PRs this run
  --json      emit the sweep summary as JSON
`;

export function parseArgs(argv) {
  const options = { rootDir: TOOL_ROOT, cap: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      if (!argv[i + 1]) throw new Error('--root requires a directory');
      options.rootDir = argv[++i];
    } else if (arg === '--cap') {
      const raw = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isFinite(raw) || raw <= 0) throw new Error('--cap requires a positive integer');
      options.cap = raw;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function renderSummary(summary) {
  const lines = [
    `Diagnostic-only reconciliation checked ${summary.checked} open PR(s) against GitHub`
    + ` at ${summary.observedAt}`,
    `  merged:     ${summary.merged}`,
    `  closed:     ${summary.closed}`,
    `  still open: ${summary.stillOpen}`,
  ];
  if (summary.skippedOverCap > 0) {
    lines.push(`  skipped (over --cap): ${summary.skippedOverCap}`);
  }
  if (summary.unresolvedCount > 0) {
    // Never a silent truncation: these are exactly the rows whose age-based
    // findings cannot be trusted, so they are named.
    lines.push(`  UNRESOLVED: ${summary.unresolvedCount} (mirror state unverified)`);
    for (const entry of summary.unresolved) {
      lines.push(`    ${entry.repo}#${entry.prNumber}: ${entry.reason}`);
    }
  }
  if (summary.deferredCount > 0) {
    lines.push(`  deferred (owed work did not persist): ${summary.deferredCount}`);
    for (const entry of summary.deferred) {
      lines.push(`    ${entry.repo}#${entry.prNumber}: ${entry.reason}`);
    }
  }
  return lines.join('\n');
}

export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    stderr.write(`${err.message}\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }

  // Open the ledger at the REQUESTED root rather than importing the
  // `review-state-db.mjs` singleton. That singleton binds to the module's own
  // package root and ignores `--root` entirely, so reusing it here would make
  // `--root /tmp/copy` write the attestation to the copy while mutating the
  // real `data/reviews.db` — a silent write to live state from a command whose
  // whole purpose is to be safe to point at a snapshot.
  //
  // Imported lazily so `--help` and argument errors never need an openable db.
  const { openReviewStateDb } = await import('./review-state.mjs');
  const db = io.db || openReviewStateDb(options.rootDir);
  const stmtGetOpenPRs = db.prepare(
    "SELECT repo, pr_number FROM reviewed_prs WHERE pr_state = 'open'"
  );
  try {
    const summary = await reconcileTerminalPrState({
      rows: io.rows || stmtGetOpenPRs.all(),
      source: 'operator-cli-diagnostic',
      cap: options.cap ?? Number.POSITIVE_INFINITY,
      fetchLiveState: io.fetchLiveState
        || ((repo, prNumber) => fetchPullRequestHeadAndState(repo, prNumber, {
          execFileImpl: io.execFileImpl || execFileAsync,
        })),
      markMerged: () => {},
      markClosed: () => {},
      logger: { error: (msg) => stderr.write(`${msg}\n`), log: () => {} },
    });

    // This command is diagnostic-only and must NOT refresh the attestation: it
    // wrote nothing, so claiming the mirror is freshly verified would suppress
    // the very blindness finding that sent the operator here.

    stdout.write(options.json
      ? `${JSON.stringify(summary, null, 2)}\n`
      : `${renderSummary(summary)}\n`);

    // Non-zero when the sweep could not verify everything, so a scripted caller
    // can tell "mirror is now clean" from "mirror is still partly unverified".
    return summary.unresolvedCount > 0 ? 1 : 0;
  } finally {
    if (!io.db) db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      process.stderr.write(`${err?.stack || err}\n`);
      process.exitCode = 1;
    });
}
