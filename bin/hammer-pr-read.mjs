#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fetchHammerPr } from '../src/hammer-pr-read.mjs';
const [repo, prNumber, ...args] = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const fields = jsonIndex >= 0 ? args[jsonIndex + 1] : '';
const jqIndex = args.indexOf('--jq');
try {
  const snapshot = await fetchHammerPr(repo, prNumber, { withChecks: jsonIndex < 0 || String(fields).includes('statusCheckRollup'), withReviews: String(fields).split(',').includes('reviews') });
  const json = JSON.stringify(snapshot);
  process.stdout.write(jqIndex < 0 ? `${json}\n` : execFileSync('jq', ['-r', args[jqIndex + 1]], { input: json, encoding: 'utf8' }));
} catch (err) {
  process.stderr.write(`${err.stderr || err.message}\n`);
  process.exitCode = err.signal === 'SIGALRM' ? 142 : Number.isInteger(err.status) ? err.status : Number.isInteger(err.code) ? err.code : 1;
}
