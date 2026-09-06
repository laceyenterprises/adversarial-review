#!/usr/bin/env node
// RSP-01 operator surface — "is the depth failover lever engaged right now, and
// what has it cost?"
//
// Depth-triggered failover that is invisible is indistinguishable from the
// monoculture it replaces. This prints the live queue depth, the configured
// threshold, whether the lever is engaged, and the number of non-primary reviews
// the lever actually bought — none of which should require grepping a 245 MB
// watcher log.
//
//   node bin/review-queue-depth.mjs [--json] [--root <dir>]

import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIRST_PASS_REVIEW_QUEUE_DEPTH_UNIT,
  REVIEW_QUEUE_DEPTH_FAILOVER_CFG_KEY,
  firstPassSpilloverPlan,
  readReviewQueueDepthFailoverReport,
  resolveFirstPassReviewQueueDepthFailoverThreshold,
  reviewQueueDepthFailoverReportPath,
} from '../src/review-queue-depth.mjs';
// The production depth SQL, imported rather than restated — and imported from
// the side-effect-free statements leaf, not from `review-state-db.mjs`, whose
// module body opens the process-wide DB handle and runs schema bootstrap on
// import. An operator will point `--root` at a LIVE deployed tree, and a
// diagnostic reporter must not migrate a database a running watcher owns. Hence
// the leaf import plus our own read-only handle below.
import { SQL_COUNT_OPEN_AWAITING_FIRST_PASS_REVIEW } from '../src/review-state-statements.mjs';

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { json: false, root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--root') args.root = argv[++i] || DEFAULT_ROOT;
  }
  return args;
}

function main() {
  const { json, root } = parseArgs(process.argv.slice(2));

  // Read-only, so this is safe to point at a live deployed tree.
  let depth = null;
  const db = new Database(join(root, 'data', 'reviews.db'), { readonly: true });
  try {
    depth = Number(db.prepare(SQL_COUNT_OPEN_AWAITING_FIRST_PASS_REVIEW).get()?.n ?? 0);
  } finally {
    db.close();
  }

  const threshold = resolveFirstPassReviewQueueDepthFailoverThreshold();
  const plan = firstPassSpilloverPlan({ depth, threshold });
  const report = readReviewQueueDepthFailoverReport(root);
  const payload = {
    knob: REVIEW_QUEUE_DEPTH_FAILOVER_CFG_KEY,
    depthUnit: FIRST_PASS_REVIEW_QUEUE_DEPTH_UNIT,
    reportPath: reviewQueueDepthFailoverReportPath(root),
    ...plan,
    cost: report.cost,
    engagedSince: report.engagedSince,
    engagedAtDepth: report.engagedAtDepth,
    lastTransition: report.lastTransition,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const state = !plan.armed ? 'DISARMED' : plan.engaged ? 'ENGAGED' : 'ARMED (not engaged)';
  process.stdout.write(
    `first-pass review queue depth : ${depth}\n`
    + `unit                          : ${FIRST_PASS_REVIEW_QUEUE_DEPTH_UNIT}\n`
    + `knob                          : ${REVIEW_QUEUE_DEPTH_FAILOVER_CFG_KEY}\n`
    + `threshold                     : ${threshold === null ? '(unset — disarmed)' : threshold}\n`
    + `state                         : ${state}\n`
    + `spill slots (graded)          : ${plan.spillSlots}\n`
    + `engaged since                 : ${report.engagedSince || '-'} (at depth ${report.engagedAtDepth ?? '-'})\n`
    + `cost: spillover reviews total : ${report.cost.spilloverReviewsTotal}\n`
    + `cost: by worker class         : ${JSON.stringify(report.cost.byWorkerClass)}\n`
    + `cost: this engagement         : ${report.cost.currentEngagementSpilloverReviews}\n`
    + `cost: last engagement         : ${report.cost.lastEngagementSpilloverReviews ?? '-'}\n`
    + `last transition               : ${report.lastTransition ? JSON.stringify(report.lastTransition) : '-'}\n`
    + `report                        : ${reviewQueueDepthFailoverReportPath(root)}\n`
  );
}

main();
