#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { disputeFinding } from '../src/ama/finding-dispute.mjs';
import { primaryChangeRoot } from '../src/ama/primary-change.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { deliverAlert } from '../src/alert-delivery.mjs';
import { loadConfigRuntime } from '../src/config-loader.mjs';
const { values } = parseArgs({ options: Object.fromEntries(
  ['root-dir', 'repo', 'pr', 'head-sha', 'review', 'finding', 'evidence-file'].map((key) => [key, { type: 'string' }])) });
const rootDir = primaryChangeRoot({ rootDir: values['root-dir'] });
const db = openReviewStateDb(rootDir);
try {
  ensureReviewStateSchema(db);
  const result = await disputeFinding({ rootDir, repo: values.repo, prNumber: Number(values.pr),
    headSha: values['head-sha'], reviewRef: values.review, findingNumber: Number(values.finding),
    evidence: readFileSync(values['evidence-file'], 'utf8') }, {
    db, loadedConfig: loadConfigRuntime(),
    get: async (path) => JSON.parse((await execGhWithRetry({ args: ['api', path], timeoutMs: 15000 })).stdout),
    postComment: async (body) => execGhWithRetry({ args: ['api', '--method', 'POST',
      `repos/${values.repo}/issues/${values.pr}/comments`, '-f', `body=${body}`], timeoutMs: 15000 }),
    page: deliverAlert,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.triggered && result.status !== 'pending') process.exitCode = 1;
} finally { db.close(); }
