#!/usr/bin/env node
import { filterGitHubBody } from '../src/github-outbound-body.mjs';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { disputeFinding } from '../src/ama/finding-dispute.mjs';
import { assertFindingDisputeOwner } from '../src/ama/finding-dispute-owner.mjs';
import { primaryChangeRoot } from '../src/ama/primary-change.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { requestWatcherWake } from '../src/watcher-wake.mjs';
import { reportHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { closerHelperError, hammerStopOrigin } from '../src/ama/hammer-stop-origin.mjs';
const usage = 'usage: dispute-finding.mjs --root-dir ROOT --repo OWNER/REPO --pr N --head-sha SHA --review NODE_OR_URL --finding BLOCKING_SECTION_POSITION --evidence-file PATH; non-blocking findings use hammer-edit-plan.mjs, kind=non-blocking';
let values;
try {
  ({ values } = parseArgs({ options: Object.fromEntries(
    ['root-dir', 'repo', 'pr', 'head-sha', 'review', 'finding', 'evidence-file'].map((key) => [key, { type: 'string' }])) }));
} catch {
  reportHammerEarlyFailure('helper-input-invalid');
  process.stderr.write(`${usage}\n`);
  process.exit(21);
}
if (!values.repo || !values.pr || !values['head-sha'] || !values.review
  || !values.finding || !values['evidence-file']) {
  reportHammerEarlyFailure('helper-input-invalid');
  process.stderr.write(`${usage}\n`);
  process.exit(21);
}
const rootDir = primaryChangeRoot({ rootDir: values['root-dir'] });
try {
  assertFindingDisputeOwner(rootDir);
} catch (error) {
  reportHammerEarlyFailure('dispute-owner-refused');
  process.stderr.write(`${JSON.stringify({ event: 'ama_finding_dispute_owner_refused', reason: error.message, exitCode: 78 })}\n`);
  process.exit(78);
}
const db = openReviewStateDb(rootDir);
try {
  ensureReviewStateSchema(db);
  let evidence;
  try { evidence = readFileSync(values['evidence-file'], 'utf8'); }
  catch { throw closerHelperError('helper-input-invalid', 'evidence-file must name a readable file containing fenced exact-head evidence'); }
  const result = await disputeFinding({ rootDir, repo: values.repo, prNumber: Number(values.pr),
    headSha: values['head-sha'], reviewRef: values.review, findingNumber: Number(values.finding),
    evidence }, {
    db,
    get: async (path) => JSON.parse((await execGhWithRetry({ args: ['api', path], timeoutMs: 15000 })).stdout),
    postComment: async (body) => JSON.parse((await execGhWithRetry({ args: ['api', '--method', 'POST',
      `repos/${values.repo}/issues/${values.pr}/comments`, '-f', `body=${filterGitHubBody(body, { repo: values.repo, reviewerHeadSha: values['head-sha'], rootDir })}`], timeoutMs: 15000 })).stdout),
    wake: requestWatcherWake,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  // HAMFINAL-01: success means the finding is withdrawn-by-hammer (final).
  if (result.withdrawn !== true) process.exitCode = 1;
} catch (error) {
  if (error.phaseOutcome) {
    reportHammerEarlyFailure(error.phaseOutcome);
    const correctable = hammerStopOrigin(error.phaseOutcome) === 'closer';
    process.stderr.write(error.phaseOutcome === 'dispute-identity-refused'
      ? `${JSON.stringify({ event: 'ama_finding_dispute_identity_refused', reason: error.message, exitCode: 79 })}\n`
      : `${error.message}\n${correctable ? `${usage}\n` : ''}`);
    process.exitCode = correctable ? 21 : error.phaseOutcome === 'dispute-identity-refused' ? 79 : 1;
  } else {
    if (!error.message.includes('trusted HAM provenance')) throw error;
    process.stderr.write(`${JSON.stringify({ event: 'ama_finding_dispute_identity_refused', reason: error.message, exitCode: 79 })}\n`);
    process.exitCode = 79;
  }
} finally { db.close(); }
