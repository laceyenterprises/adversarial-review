#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { dismissWithdrawnReviews } from '../src/ama/withdrawn-review-dismissal.mjs';

const { values } = parseArgs({ options: Object.fromEntries(
  ['root-dir', 'repo', 'pr', 'head-sha', 'verdict-file'].map((key) => [key, { type: 'string' }])) });
const verdict = values['verdict-file'] ? JSON.parse(readFileSync(values['verdict-file'], 'utf8')) : null;
const headSha = values['head-sha'];
const headMatch = verdict?.trace?.headMatch;
if (verdict && (verdict.eligible !== true || headMatch?.current !== headSha)) {
  throw new Error('withdrawal revalidation requires eligible exact-head admission');
}
const terminal = verdict?.trace?.hamTerminalRemediation;
// Terminal remediation sets headMatch.ok even when current !== reviewed.
// Use that trace only to select a candidate. Cleanup still requires
// the authenticated GitHub event, and the writer still checks live review proof.
const terminalReviewedHead = headMatch?.ok === true && terminal?.ok === true
  && terminal.terminalReviewProof?.ok === true && terminal.remediationHead === headSha
  && Array.isArray(terminal.waived) && terminal.waived.includes('blocking-findings-present')
  ? headMatch.reviewed : null;
const result = await dismissWithdrawnReviews({ rootDir: values['root-dir'], repo: values.repo,
  prNumber: Number(values.pr), headSha, terminalReviewedHead,
  expectedWithdrawnIdentities: verdict?.trace?.verdict?.hammerAdjudication?.withdrawnIdentities || [] }, {
  get: async (path) => {
    const list = path.includes('?per_page=');
    const { stdout } = await execGhWithRetry({
      args: ['api', ...(list ? ['--paginate', '--slurp'] : []), path], timeoutMs: 15000,
    });
    const data = JSON.parse(stdout);
    if (list && (!Array.isArray(data) || !data.every(Array.isArray))) throw new Error('invalid paginated list');
    return list ? data.flat() : data;
  },
  dismiss: async (path, message) => {
    await execGhWithRetry({ args: ['api', '--method', 'PUT', path, '-f', `message=${message}`], timeoutMs: 15000 });
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
