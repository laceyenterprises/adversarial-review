#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execGhWithRetry } from '../src/gh-cli.mjs';
import { checkHammerEditPlan } from '../src/ama/hammer-edit-plan.mjs';
import { assertFindingDisputeOwner } from '../src/ama/finding-dispute-owner.mjs';
import { loadEffectiveMergeAuthorityConfig } from '../src/ama/effective-policy.mjs';
import { primaryChangeRoot } from '../src/ama/primary-change.mjs';
import { captureReadyFindings } from '../src/findings-backlog.mjs';
import { parseReviewFindings } from '../src/kernel/review-findings.mjs';

async function readReview(repo, pr, reviewId) {
  const { stdout } = await execGhWithRetry({
    hammerToken: true, args: ['api', `repos/${repo}/pulls/${pr}/reviews/${reviewId}`], timeoutMs: 15_000,
  });
  return JSON.parse(stdout);
}

export async function main(argv = process.argv.slice(2), {
  readReviewImpl = readReview, captureImpl = captureReadyFindings,
  loadPolicy = loadEffectiveMergeAuthorityConfig, assertOwner = assertFindingDisputeOwner,
  rootDir = primaryChangeRoot(),
} = {}) {
  const [repo, pr, reviewId, planFile, ...extra] = argv;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^[1-9]\d*$/.test(pr || '')
    || !/^[1-9]\d*$/.test(reviewId || '') || !planFile || extra.length) {
    throw Error('usage: hammer-edit-plan.mjs OWNER/REPO PR REVIEW_ID PLAN_JSON');
  }
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const review = await readReviewImpl(repo, pr, reviewId);
  const policy = loadPolicy({ rootDir });
  if (!policy) throw Error('merge-policy-unavailable');
  const result = checkHammerEditPlan(review, plan, {
    strictNonBlockingRemediation: policy.strictNonBlockingRemediation !== false,
  });
  if (result.action === 'defer') {
    const nonBlocking = parseReviewFindings(review.body).nonBlocking;
    if (nonBlocking.state !== 'known') throw Error('non-blocking-findings-unknown');
    try {
      assertOwner(rootDir);
    } catch (error) {
      error.exitCode = 78;
      throw error;
    }
    const reason = 'Deferred to findings backlog: advisory finding would change reviewed author code.';
    captureImpl({ rootDir, repo, prNumber: Number(pr), headSha: review.commit_id,
      version: createHash('sha256').update(review.body).digest('hex'),
      count: nonBlocking.count,
      deferredFinding: { findingNumber: plan.findingNumber, reason } });
    return { ...result, reason, backlogRecorded: true };
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    // A recorded deferral is handled feedback, but must never authorize an edit.
    process.exitCode = result.action === 'allow' ? 0 : result.action === 'defer' ? 20 : 1;
  } catch (error) {
    process.stderr.write(`hammer edit pre-check failed; do not edit: ${error.message}\n`);
    process.exitCode = error.exitCode || 1;
  }
}
