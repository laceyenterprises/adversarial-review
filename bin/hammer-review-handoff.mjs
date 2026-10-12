#!/usr/bin/env node
// The completed hammer releases closer ownership to the exact-head review CAS.
import { findLiveAmaCloserLease, readAmaCloserLease, rekeyAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { requestReviewRereview } from '../src/review-state.mjs';
import { requestBoundedOrphanReview } from '../src/ama/orphan-review-request.mjs';
import { pathToFileURL } from 'node:url';

export async function handoffHammerReview({ rootDir, repo, prNumber, headSha,
  requestBoundedReviewImpl = requestBoundedOrphanReview, logger = console }) {
  const identity = { repo, prNumber, headSha };
  const live = findLiveAmaCloserLease(rootDir, identity);
  if (live && live.headSha !== headSha) {
    const rekey = rekeyAmaCloserLease({ rootDir, repo, prNumber, fromHeadSha: live.headSha, toHeadSha: headSha });
    if (!rekey.rekeyed) throw new Error(`review handoff lease rekey: ${rekey.reason}`);
  }
  const lease = readAmaCloserLease(rootDir, identity);
  // Admission must see the transfer before the bounded request checks the
  // final-round guards. Keep the transfer on refusal/error: the watcher's
  // bounded handoff wait owns recovery and pages once, without another hammer.
  if (lease && lease.status !== 'handed-to-review') {
    updateAmaCloserLease({ rootDir, ...identity, status: 'handed-to-review' });
  }
  const request = await requestBoundedReviewImpl({ rootDir, ...identity,
    requestRereviewImpl: requestReviewRereview, logger });
  return { outcome: 'handed-to-review', headSha, request };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [rootDir, repo, pr, headSha] = process.argv.slice(2);
  if (!rootDir || !repo || !Number.isInteger(Number(pr)) || !/^[a-f0-9]{40}$/.test(headSha || '')) {
    throw new Error('usage: hammer-review-handoff ROOT REPO PR HEAD');
  }
  const result = await handoffHammerReview({ rootDir, repo, prNumber: Number(pr), headSha });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
