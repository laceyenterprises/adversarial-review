#!/usr/bin/env node
// Compatibility entry point for already-rendered prompts. New prompts never
// hand hammer heads to review; an old invocation releases for another hammer.
import { findLiveAmaCloserLease, rekeyAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { pathToFileURL } from 'node:url';

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
  const [rootDir, repo, pr, headSha] = process.argv.slice(2);
  if (!rootDir || !repo || !Number.isInteger(Number(pr)) || !/^[a-f0-9]{40}$/.test(headSha || '')) {
    throw new Error('usage: hammer-review-handoff ROOT REPO PR HEAD');
  }
  const result = await handoffHammerReview({ rootDir, repo, prNumber: Number(pr), headSha });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
