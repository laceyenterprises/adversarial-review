#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { disputeFinding } from '../src/ama/finding-dispute.mjs';
import { assertFindingDisputeOwner } from '../src/ama/finding-dispute-owner.mjs';
import { primaryChangeRoot } from '../src/ama/primary-change.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { deliverAlert } from '../src/alert-delivery.mjs';
import { loadConfigRuntime } from '../src/config-loader.mjs';
const { values } = parseArgs({ options: Object.fromEntries(
  ['root-dir', 'repo', 'pr', 'head-sha', 'review', 'finding', 'evidence-file'].map((key) => [key, { type: 'string' }])) });
const rootDir = primaryChangeRoot({ rootDir: values['root-dir'] });
try {
  assertFindingDisputeOwner(rootDir);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ event: 'ama_finding_dispute_owner_refused', reason: error.message, exitCode: 78 })}\n`);
  process.exit(78);
}
const db = openReviewStateDb(rootDir);
try {
  ensureReviewStateSchema(db);
  const result = await disputeFinding({ rootDir, repo: values.repo, prNumber: Number(values.pr),
    headSha: values['head-sha'], reviewRef: values.review, findingNumber: Number(values.finding),
    evidence: readFileSync(values['evidence-file'], 'utf8') }, {
    db, loadedConfig: loadConfigRuntime(),
    get: async (path) => JSON.parse((await execGhWithRetry({ args: ['api', path], timeoutMs: 15000 })).stdout),
    postComment: async (body) => JSON.parse((await execGhWithRetry({ args: ['api', '--method', 'POST',
      `repos/${values.repo}/issues/${values.pr}/comments`, '-f', `body=${body}`], timeoutMs: 15000 })).stdout),
    page: deliverAlert,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.triggered && !['pending', 'already-pending'].includes(result.status) && result.reason !== 'review-in-flight') process.exitCode = 1;
} catch (error) {
  if (!error.message.includes('trusted HAM provenance')) throw error;
  process.stderr.write(`${JSON.stringify({ event: 'ama_finding_dispute_identity_refused', reason: error.message, exitCode: 79 })}\n`);
  process.exitCode = 79;
} finally { db.close(); }
