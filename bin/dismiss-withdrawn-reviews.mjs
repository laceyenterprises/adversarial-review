#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { dismissWithdrawnReviews } from '../src/ama/withdrawn-review-dismissal.mjs';

const { values } = parseArgs({ options: Object.fromEntries(
  ['root-dir', 'repo', 'pr', 'head-sha', 'verdict-file'].map((key) => [key, { type: 'string' }])) });
const verdict = values['verdict-file'] ? JSON.parse(readFileSync(values['verdict-file'], 'utf8')) : null;
if (verdict && (verdict.eligible !== true || verdict.trace?.headMatch?.current !== values['head-sha'])) {
  throw new Error('withdrawal revalidation requires eligible exact-head admission');
}
const result = await dismissWithdrawnReviews({ rootDir: values['root-dir'], repo: values.repo,
  prNumber: Number(values.pr), headSha: values['head-sha'],
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
