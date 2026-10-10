#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { dismissWithdrawnReviews } from '../src/ama/withdrawn-review-dismissal.mjs';

const { values } = parseArgs({ options: Object.fromEntries(
  ['root-dir', 'repo', 'pr', 'head-sha'].map((key) => [key, { type: 'string' }])) });
const result = await dismissWithdrawnReviews({ rootDir: values['root-dir'], repo: values.repo,
  prNumber: Number(values.pr), headSha: values['head-sha'] }, {
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
