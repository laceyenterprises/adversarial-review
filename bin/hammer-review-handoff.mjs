#!/usr/bin/env node
// Compatibility entry point for already-rendered prompts. New prompts never
// hand hammer heads to review; an old invocation releases for another hammer.
import { findLiveAmaCloserLease, readAmaCloserLease, rekeyAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { pathToFileURL } from 'node:url';

async function handoffExactHead({ rootDir, repo, prNumber, headSha }) {
  const { fetchHammerPr } = await import('../src/hammer-pr-read.mjs');
  const { requestBoundedOrphanReview } = await import('../src/ama/orphan-review-request.mjs');
  const { getReviewRow, openReviewStateDb, requestReviewRereview } = await import('../src/review-state.mjs');
  const { appendAmaAuditAttempt } = await import('../src/ama/audit.mjs');
  const { headSha: liveHead, state, isDraft } = await fetchHammerPr(repo, prNumber, { withChecks: false });
  const identity = { repo, prNumber, headSha };
  const lrq = process.env.HQ_LAUNCH_REQUEST_ID || process.env.AGENT_OS_WORKER_LRQ_ID || process.env.LAUNCH_REQUEST_ID;
  if (liveHead !== headSha || state !== 'OPEN' || isDraft !== false || !lrq) {
    throw new Error('Exact-head review handoff lost its PR or launch binding');
  }
  let lease = readAmaCloserLease(rootDir, identity);
  if (!lease) {
    const live = findLiveAmaCloserLease(rootDir, identity);
    if (live?.lease?.lrqId !== lrq) throw new Error('Exact-head review handoff lost its closer lease');
    const rekey = rekeyAmaCloserLease({ rootDir, repo, prNumber, fromHeadSha: live.headSha, toHeadSha: headSha });
    if (!rekey.rekeyed) throw new Error(`Exact-head review handoff could not rekey: ${rekey.reason}`);
    lease = rekey.lease;
  }
  if (lease.lrqId !== lrq || !['dispatched', 'handed-to-review'].includes(lease.status)) {
    throw new Error('Exact-head review handoff lost its closer lease');
  }
  if (lease.status === 'dispatched') {
    updateAmaCloserLease({ rootDir, ...identity, status: 'handed-to-review', expectedLease: lease });
  }
  const request = await requestBoundedOrphanReview({ rootDir, ...identity, requestRereviewImpl: requestReviewRereview,
    decisionReasons: ['final-gate-rebase-patch-changed'] });
  if (!request?.triggered) {
    const db = openReviewStateDb(rootDir);
    let row;
    try { row = getReviewRow(db, identity); } finally { db.close(); }
    const pending = row?.revision_ref === headSha
      && ['pending', 'pending-upstream', 'ci-blocked', 'reviewing'].includes(row.review_status);
    const posted = row?.reviewer_head_sha === headSha && row.review_status === 'posted';
    if (!pending && !posted) throw new Error(`Exact-head review request refused: ${request?.reason || 'unconfirmed'}`);
  }
  appendAmaAuditAttempt({ ...identity, hqRoot: process.env.HAM_HQ_ROOT || process.env.HQ_ROOT,
    attempt: { outcome: 'superseded', reason: 'exact-head-review-required', launchRequestId: lrq },
    metadata: { closureAuthority: 'ham-terminal-remediation' } });
  return { outcome: 'exact-head-review-required', headSha };
}

export { handoffExactHead };

export async function handoffHammerReview({ rootDir, repo, prNumber, headSha }) {
  const identity = { repo, prNumber, headSha };
  const live = findLiveAmaCloserLease(rootDir, identity);
  if (live && live.headSha !== headSha) {
    const rekey = rekeyAmaCloserLease({ rootDir, repo, prNumber, fromHeadSha: live.headSha, toHeadSha: headSha });
    if (!rekey.rekeyed) throw new Error(`hammer retry lease rekey: ${rekey.reason}`);
  }
  if (live) updateAmaCloserLease({ rootDir, ...identity, status: 'terminal', terminalOutcome: 'failed-without-merge' });
  return { outcome: 'hammer-retry-required', headSha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [rootDir, repo, pr, headSha, mode] = process.argv.slice(2);
  if (!rootDir || !repo || !Number.isInteger(Number(pr)) || !/^[a-f0-9]{40}$/.test(headSha || '')) {
    throw new Error('usage: hammer-review-handoff ROOT REPO PR HEAD');
  }
  const handoff = mode === '--exact-head' ? handoffExactHead : handoffHammerReview;
  const result = await handoff({ rootDir, repo, prNumber: Number(pr), headSha });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
