#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { readPrBuilderProvenance } from '../src/session-ledger-read-adapter.mjs';
import { builderClassFromTitle } from '../src/adapters/subject/github-pr/title-tagging.mjs';
import { reconcileBuilderClass } from '../src/builder-provenance-routing.mjs';
import { main as retriggerReview } from '../src/retrigger-review.mjs';

export async function fetchPrState(repo, pr, options = {}) {
  const { stdout } = await execGhWithRetry({ ...options,
    args: ['pr', 'view', String(pr), '--repo', repo, '--json', 'state,headRefOid,title'],
  });
  return JSON.parse(stdout);
}

export async function main(argv, {
  fetchPr = fetchPrState,
  readProvenance = readPrBuilderProvenance,
  retrigger = retriggerReview,
  stdout = process.stdout,
} = {}) {
  const { values } = parseArgs({ args: argv, options: {
    repo: { type: 'string' }, pr: { type: 'string' }, reason: { type: 'string' },
    apply: { type: 'boolean' }, 'root-dir': { type: 'string' },
  } });
  const pr = Number(values.pr);
  if (!values.repo || !Number.isInteger(pr) || pr <= 0 || (values.apply && !values.reason?.trim())) {
    throw new Error('Usage: --repo owner/repo --pr N [--apply --reason TEXT] [--root-dir PATH]');
  }
  const live = await fetchPr(values.repo, pr);
  if (live.state !== 'OPEN') throw new Error('refusing to reroute a terminal PR');
  const provenance = readProvenance({ repo: values.repo, prNumber: pr, headSha: live.headRefOid, rootDir: values['root-dir'] });
  const result = reconcileBuilderClass({ builderClass: builderClassFromTitle(live.title) }, provenance);
  if (result.finding?.name !== 'builder_class_mismatch') throw new Error('no confirmed ledger/title builder mismatch');
  stdout.write(`${JSON.stringify({ headSha: live.headRefOid, ...result.finding, apply: !!values.apply })}\n`);
  if (!values.apply) return 0;
  // Existing audited retrigger preserves holds, refuses active workers, and
  // binds the request to this exact head. The watcher resolves the new route.
  return retrigger(['--repo', values.repo, '--pr', String(pr), '--exact-head-now',
    '--head-sha', live.headRefOid, '--no-bump-budget', '--reason', values.reason,
    ...(values['root-dir'] ? ['--root-dir', values['root-dir']] : [])]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
