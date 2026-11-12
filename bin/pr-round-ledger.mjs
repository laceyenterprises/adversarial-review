#!/usr/bin/env node
// REVIEWROUNDLEDGER-01 — read or write a PR's round ledger.
//
//   pr-round-ledger.mjs show   --repo owner/name --pr N [--root-dir DIR] [--json]
//   pr-round-ledger.mjs record --repo owner/name --pr N --kind hq-pr-update --round-id ID
//                              [--head-sha SHA] [--charged-to pipeline|operator]
//                              [--actor NAME] [--reason TEXT] [--root-dir DIR]
//   pr-round-ledger.mjs void   --repo owner/name --pr N --round-id ID [--reason TEXT] [--root-dir DIR]
//
// `record` is the hook for producers outside this repository (an in-place HQ
// PR-update). Follow-up, hammer and operator-retrigger rounds are recorded by
// their own code paths, so the CLI accepts only `hq-pr-update`. `show` prints the
// same PR-wide count the follow-up daemon and the watcher enforce.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { summarizePRRemediationLedger } from '../src/follow-up-jobs.mjs';
import { DEFAULT_ROUND_BUDGET_BY_RISK } from '../src/kernel/convergence-budget.mjs';
import {
  CHARGED_TO, PR_ROUND_KINDS, formatPrRoundLedgerSummary, readPrRoundLedger, recordPrRound, voidPrRound,
} from '../src/pr-round-ledger.mjs';

const DEFAULT_ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_RECORD_KINDS = new Set([PR_ROUND_KINDS.HQ_PR_UPDATE]);
const USAGE = `usage:
  pr-round-ledger.mjs show   --repo owner/name --pr N [--root-dir DIR] [--json]
  pr-round-ledger.mjs record --repo owner/name --pr N --kind hq-pr-update --round-id ID
                             [--head-sha SHA] [--charged-to pipeline|operator] [--actor NAME] [--reason TEXT]
  pr-round-ledger.mjs void   --repo owner/name --pr N --round-id ID [--reason TEXT]
`;

export function buildPrRoundLedgerView(rootDir, { repo, prNumber }) {
  const ledger = summarizePRRemediationLedger(rootDir, { repo, prNumber });
  const summary = ledger.prRoundLedger || { remediationRoundsUsed: 0, reviewPasses: 0, operatorCharged: 0,
    byKind: {}, budget: null };
  // The enforced count is the max of the job-derived floor and the ledger.
  const used = Number(ledger.completedRoundsForPR || 0);
  const budget = summary.budget ?? DEFAULT_ROUND_BUDGET_BY_RISK[ledger.latestRiskClass] ?? null;
  return {
    repo,
    prNumber,
    remediationRoundsUsed: used,
    budget,
    budgetReached: budget !== null && used >= budget,
    riskClass: ledger.latestRiskClass || null,
    reviewPasses: summary.reviewPasses,
    operatorCharged: summary.operatorCharged,
    byKind: summary.byKind,
    ledgerRemediationRounds: summary.remediationRoundsUsed,
    summary: formatPrRoundLedgerSummary({ ...summary, budget, remediationRoundsUsed: used }),
    entries: readPrRoundLedger(rootDir, { repo, prNumber }).map(entry => ({
      roundId: entry.roundId, kind: entry.kind, chargedTo: entry.chargedTo, voided: entry.voided,
      headSha: entry.headSha, recordedAt: entry.firstRecordedAt || entry.recordedAt,
    })),
  };
}

export function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({ args: rest, options: {
      repo: { type: 'string' }, pr: { type: 'string' }, kind: { type: 'string' },
      'round-id': { type: 'string' }, 'head-sha': { type: 'string' }, 'charged-to': { type: 'string' },
      actor: { type: 'string' }, reason: { type: 'string' }, 'root-dir': { type: 'string' },
      json: { type: 'boolean', default: false },
    } }));
  } catch (err) {
    stderr.write(`error: ${err.message}\n${USAGE}`);
    return 64;
  }
  const repo = values.repo || '';
  const prNumber = Number.parseInt(values.pr || '', 10);
  if (!['show', 'record', 'void'].includes(command)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo) || !(prNumber > 0)) {
    stderr.write(USAGE);
    return 64;
  }
  const rootDir = values['root-dir'] ? resolve(values['root-dir']) : DEFAULT_ROOT_DIR;
  try {
    if (command === 'show') {
      const view = buildPrRoundLedgerView(rootDir, { repo, prNumber });
      stdout.write(values.json ? `${JSON.stringify(view)}\n` : `${repo}#${prNumber}: ${view.summary}\n`);
      return 0;
    }
    if (!values['round-id']) {
      stderr.write(`error: --round-id is required\n${USAGE}`);
      return 64;
    }
    if (command === 'void') {
      const result = voidPrRound(rootDir, { repo, prNumber, roundId: values['round-id'], reason: values.reason || null });
      stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    if (!CLI_RECORD_KINDS.has(values.kind)) {
      stderr.write(`error: --kind must be one of ${[...CLI_RECORD_KINDS].join(', ')}\n`);
      return 64;
    }
    // A round from outside the pipeline that lands after the budget is spent
    // is not the pipeline's free round: charge it to the operator by default.
    const before = buildPrRoundLedgerView(rootDir, { repo, prNumber });
    const chargedTo = values['charged-to'] || (before.budgetReached ? CHARGED_TO.OPERATOR : CHARGED_TO.PIPELINE);
    const result = recordPrRound(rootDir, { repo, prNumber, roundId: values['round-id'], kind: values.kind,
      chargedTo, headSha: values['head-sha'] || null, actor: values.actor || null, reason: values.reason || null,
      source: 'pr-round-ledger-cli' });
    const view = buildPrRoundLedgerView(rootDir, { repo, prNumber });
    stdout.write(`${JSON.stringify({ recorded: result.recorded, roundId: result.entry.roundId,
      chargedTo: result.entry.chargedTo, remediationRoundsUsed: view.remediationRoundsUsed, budget: view.budget,
      budgetReached: view.budgetReached, summary: view.summary })}\n`);
    return 0;
  } catch (err) {
    stderr.write(`error: ${err?.message || err}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
