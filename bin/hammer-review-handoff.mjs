#!/usr/bin/env node
// The completed hammer releases closer ownership to the exact-head review CAS.
import { findLiveAmaCloserLease, readAmaCloserLease, rekeyAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { requestReviewRereview } from '../src/review-state.mjs';
import { requestBoundedOrphanReview } from '../src/ama/orphan-review-request.mjs';

const [rootDir, repo, pr, headSha] = process.argv.slice(2);
if (!rootDir || !repo || !Number.isInteger(Number(pr)) || !/^[a-f0-9]{40}$/.test(headSha || '')) {
  throw new Error('usage: hammer-review-handoff ROOT REPO PR HEAD');
}
const prNumber = Number(pr);
const identity = { repo, prNumber, headSha };
const live = findLiveAmaCloserLease(rootDir, identity);
if (live && live.headSha !== headSha) {
  const rekey = rekeyAmaCloserLease({ rootDir, repo, prNumber, fromHeadSha: live.headSha, toHeadSha: headSha });
  if (!rekey.rekeyed) throw new Error(`review handoff lease rekey: ${rekey.reason}`);
}
const lease = readAmaCloserLease(rootDir, identity);
if (lease && lease.status !== 'handed-to-review') {
  updateAmaCloserLease({ rootDir, ...identity, status: 'handed-to-review' });
}
const request = await requestBoundedOrphanReview({ rootDir, ...identity,
  requestRereviewImpl: requestReviewRereview, logger: console });
process.stdout.write(`${JSON.stringify({ outcome: 'handed-to-review', headSha, request })}\n`);
