#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fetchHammerPr, writeHammerFullReviews } from '../src/hammer-pr-read.mjs';
const [repo, prNumber, ...args] = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const fields = jsonIndex >= 0 ? args[jsonIndex + 1] : '';
const jqIndex = args.indexOf('--jq');
try {
  if (args.includes('--full-review')) {
    process.stdout.write(await writeHammerFullReviews(repo, prNumber));
  } else {
    const snapshot = await fetchHammerPr(repo, prNumber, { withChecks: jsonIndex < 0 || String(fields).includes('statusCheckRollup'), withReviews: String(fields).split(',').includes('reviews') });
    const json = JSON.stringify(snapshot);
    process.stdout.write(jqIndex < 0 ? `${json}\n` : execFileSync('jq', ['-r', args[jqIndex + 1]], { input: json, encoding: 'utf8' }));
  }
} catch (err) {
  const message = err.budgetDeferred === true ? 'GitHub rate limit budget deferred' : err.stderr || err.message;
  process.stderr.write(`${message}\n`);
  process.exitCode = err.signal === 'SIGALRM' ? 142 : Number.isInteger(err.status) ? err.status : Number.isInteger(err.code) ? err.code : 1;
}
