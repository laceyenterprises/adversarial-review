// ASR-04 backfill — recover the rows that were already dropped.
//
// The route change only helps PRs the watcher has not seen yet. Every PR it
// already terminated is still sitting in `reviews.db` with
// `review_status='unroutable-bot-author'`, still unreviewed, and still invisible
// to every queue and pager in the pipeline. `adversarial-review#909` and `#910`
// are the two live examples: 14 hours, no reviewer, no retry, no escalation, on
// a major bump of the native driver behind `reviews.db` itself.
//
// What this does is narrow on purpose: a VOCABULARY migration, nothing else.
// It flips the terminal status to `argus-security-queued` and clears
// `argus_classified_head_sha`, which is exactly the state the live route reads
// as "enqueue this on the next tick". It does NOT write a queue job, because it
// has no head SHA it can trust — the row's stored `revision_ref` may be stale by
// weeks, and a job keyed on a stale head would bind a security review to a tree
// nobody is merging. The watcher reads the live head; let it enqueue.
//
// So the ordering guarantee is: this makes the row live, the next watcher tick
// makes it queued. Both halves are idempotent, and the live route recovers the
// same rows on its own (see the ASR-04 branch in pollonce-phases.mjs) — this is
// the operator's immediate lever, not the only path.
//
// Scope is open PRs only. A merged or closed row carrying the old status is
// history, not a stranding; rewriting it would churn state no gate reads, on the
// exact class of already-terminal PR this pipeline has been burned by acting on
// before.

import { parseArgs } from 'node:util';

import { ARGUS_SECURITY_QUEUED_STATUS } from './argus-security-route.mjs';

const BACKFILL_NOTE =
  'Recovered by the ASR-04 backfill: this PR was terminated `unroutable-bot-author` '
  + 'before the Argus security route existed. The watcher enqueues its security '
  + 'review against the live head on the next tick.';

/**
 * Flip every open `unroutable-bot-author` row to the Argus-routed status.
 *
 * @param {object}  opts
 * @param {object}  opts.selectStatement   rows to recover.
 * @param {object}  opts.updateStatement   the guarded write.
 * @param {boolean} [opts.dryRun]          report what would change, write nothing.
 * @returns {{scanned: number, recovered: number, skipped: number, rows: Array}}
 *   `skipped` counts rows whose guarded UPDATE matched nothing — a concurrent
 *   watcher tick recovered them first, which is a success, not a failure.
 */
export function backfillUnroutableBotAuthorRows({
  selectStatement,
  updateStatement,
  dryRun = false,
  note = BACKFILL_NOTE,
} = {}) {
  const rows = selectStatement.all();
  const summary = { scanned: rows.length, recovered: 0, skipped: 0, rows: [] };

  for (const row of rows) {
    const entry = {
      repo: row.repo,
      prNumber: row.pr_number,
      revisionRef: row.revision_ref || null,
      from: 'unroutable-bot-author',
      to: ARGUS_SECURITY_QUEUED_STATUS,
      recovered: false,
    };
    if (dryRun) {
      summary.rows.push(entry);
      continue;
    }
    // The UPDATE re-asserts `review_status='unroutable-bot-author'` in its WHERE
    // clause, so a row a live tick already recovered between the SELECT and here
    // is left exactly as the watcher wrote it rather than being stamped twice.
    const result = updateStatement.run(note, row.repo, row.pr_number);
    entry.recovered = result.changes === 1;
    if (entry.recovered) summary.recovered += 1;
    else summary.skipped += 1;
    summary.rows.push(entry);
  }

  return summary;
}

const USAGE = `\
Usage:
  npm run argus:backfill -- [--dry-run] [--json]

Recovers open PRs stranded in terminal review_status='unroutable-bot-author'
(ASR-04). Each becomes '${ARGUS_SECURITY_QUEUED_STATUS}', which the watcher
enqueues to the Argus security queue against the PR's live head on its next
tick. Idempotent: re-running it after every row is recovered is a no-op.
`;

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  // Imported lazily so `backfillUnroutableBotAuthorRows` stays unit-testable
  // without opening reviews.db at module scope.
  const { stmtBackfillUnroutableBotToArgusQueued, stmtSelectOpenUnroutableBotRows } =
    await import('./review-state-db.mjs');

  const summary = backfillUnroutableBotAuthorRows({
    selectStatement: stmtSelectOpenUnroutableBotRows,
    updateStatement: stmtBackfillUnroutableBotToArgusQueued,
    dryRun: values['dry-run'],
  });

  if (values.json) {
    console.log(JSON.stringify({ dryRun: values['dry-run'], ...summary }, null, 2));
    return 0;
  }

  if (summary.scanned === 0) {
    console.log('[argus-backfill] no open PRs are stranded in terminal `unroutable-bot-author`.');
    return 0;
  }

  for (const row of summary.rows) {
    const verb = values['dry-run'] ? 'would recover' : (row.recovered ? 'recovered' : 'already recovered');
    console.log(`[argus-backfill] ${verb} ${row.repo}#${row.prNumber} → ${ARGUS_SECURITY_QUEUED_STATUS}`);
  }
  console.log(
    `[argus-backfill] scanned=${summary.scanned} recovered=${summary.recovered} ` +
      `already-recovered=${summary.skipped}${values['dry-run'] ? ' (dry run: nothing written)' : ''}`
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`[argus-backfill] failed: ${err?.message || err}`);
      process.exitCode = 1;
    });
}
