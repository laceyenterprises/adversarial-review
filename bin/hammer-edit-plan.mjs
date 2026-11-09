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

const usage = 'usage: hammer-edit-plan.mjs OWNER/REPO PR REVIEW_ID PLAN_JSON [--reviewed-head SHA]';
export const EDIT_PLAN_USAGE = `${usage}
Use the controller-pinned reviewed SHA (--reviewed-head or HAM_REVIEWED_SHA).
Omitted, non-string or empty reviewedHead values are filled from that pin.
For a cited review on another head, set reviewedHead to that review's commit_id.
Accepted plan shapes (coordinates refer to the reviewed head):
Blocking reversal:
\`\`\`json
{"kind":"blocking","findingNumber":1,"path":"src/example.mjs","startLine":2,"endLine":2,"editKind":"author-lines"}
\`\`\`
Uncited CI repair:
\`\`\`json
{"path":"test/example.test.mjs","startLine":2,"endLine":2,"editKind":"in-place","requiredCiRepair":true}
\`\`\`
Additive fix:
\`\`\`json
{"kind":"non-blocking","findingNumber":1,"editKind":"additive"}
\`\`\`
Strict non-blocking fix:
\`\`\`json
{"kind":"non-blocking","findingNumber":1,"path":"src/example.mjs","startLine":2,"endLine":2,"editKind":"author-lines"}
\`\`\`
Blocking in-place repair uses the blocking shape with editKind "in-place".
Only exit 0 from a plan check permits an edit; help performs no plan check.
`;

async function readReview(repo, pr, reviewId) {
  const { stdout } = await execGhWithRetry({
    hammerToken: true, args: ['api', `repos/${repo}/pulls/${pr}/reviews/${reviewId}`], timeoutMs: 15_000,
  });
  return JSON.parse(stdout);
}

export function editPlanExitCode(result) {
  return { allow: 0, defer: 20, correct: 21 }[result.action] ?? 1;
}

export async function main(argv = process.argv.slice(2), {
  readReviewImpl = readReview, captureImpl = captureReadyFindings,
  loadPolicy = loadEffectiveMergeAuthorityConfig, assertOwner = assertFindingDisputeOwner,
  rootDir, env = process.env,
} = {}) {
  const [repo, pr, reviewId, planFile, ...extra] = argv;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^[1-9]\d*$/.test(pr || '')
    || !/^[1-9]\d*$/.test(reviewId || '') || !planFile
    || (extra.length && (extra.length !== 2 || extra[0] !== '--reviewed-head'))) {
    throw Error(usage);
  }
  const pin = extra.length ? extra[1] : env.HAM_REVIEWED_SHA;
  const reviewedHead = typeof pin === 'string' ? pin.toLowerCase() : pin;
  if (typeof reviewedHead !== 'string' || !/^[a-f0-9]{40}$/.test(reviewedHead)) {
    return { action: 'stop', reason: 'review-evidence-invalid' };
  }
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { action: 'stop', reason: 'review-evidence-invalid' };
  }
  plan.reviewedHead = typeof plan.reviewedHead === 'string' && plan.reviewedHead.trim()
    ? plan.reviewedHead.toLowerCase() : reviewedHead;
  if (!/^[a-f0-9]{40}$/.test(plan.reviewedHead)) {
    return { action: 'stop', reason: 'review-evidence-invalid' };
  }
  rootDir ??= primaryChangeRoot();
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
    const argv = process.argv.slice(2);
    if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
      process.stdout.write(EDIT_PLAN_USAGE);
    } else {
      const result = await main(argv);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      // A recorded deferral is handled feedback, but must never authorize an edit.
      process.exitCode = editPlanExitCode(result);
    }
  } catch (error) {
    process.stderr.write(`hammer edit pre-check failed; do not edit: ${error.message}\n`);
    process.exitCode = error.exitCode || 1;
  }
}
