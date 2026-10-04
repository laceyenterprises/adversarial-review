#!/usr/bin/env node
// Workers append requests in their own sandbox. Only HQ-owner teardown publishes.
import { chmodSync, chownSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isExecutedMergeRefusal, writeMergeActionReceipt } from '../src/ama/merge-action-receipt.mjs';
import { execGhWithRetry } from '../src/gh-cli.mjs';

const [hqRoot, repo, number, headSha, outcome, reason = '', executedAt = new Date().toISOString()] = process.argv.slice(2);
if (!['merged', 'refused'].includes(outcome)) throw new Error('Invalid receipt outcome');
if (outcome === 'refused' && !isExecutedMergeRefusal(reason)) process.exit(0);
const record = { repo, prNumber: Number(number), headSha, merged: outcome === 'merged',
  reason: reason || null, executedAt: executedAt || new Date().toISOString(), producerClass: 'closer-hammer',
  actor: 'hammer', action: 'gh pr merge', receiptProtocol: 'OPSEV1-03' };
if (record.merged) {
  const { stdout } = await execGhWithRetry({
    args: ['pr', 'view', number, '--repo', repo, '--json', 'state,headRefOid,mergedAt'],
    timeoutMs: 15_000,
  });
  const live = JSON.parse(stdout);
  if (live.state !== 'MERGED' || live.headRefOid !== headSha || !live.mergedAt
    || Math.abs(Date.parse(live.mergedAt) - Date.parse(record.executedAt)) > 120_000) {
    throw new Error('Merge-action requires a verified recent exact-head merge');
  }
}
try {
  writeMergeActionReceipt({ hqRoot, ...record });
} catch (error) {
  if (!error.message.includes('must run as HQ ownerUser')) throw error;
  const workerId = process.env.HQ_WORKER_ID;
  const launchRequestId = process.env.HQ_LAUNCH_REQUEST_ID || process.env.LAUNCH_REQUEST_ID;
  if (!workerId || !/^[\w.-]+$/.test(workerId) || /^\.+$/.test(workerId) || !launchRequestId) throw error;
  const directory = join(hqRoot, 'workers', workerId, 'merge-action-requests');
  mkdirSync(directory, { recursive: true, mode: 0o750 });
  chmodSync(directory, 0o750);
  const request = join(directory, `${randomUUID()}.json`);
  const temporary = join(directory, `.request-${randomUUID()}`);
  try {
    writeFileSync(temporary, JSON.stringify({ ...record, launchRequestId }), { flag: 'wx', mode: 0o640 });
    chmodSync(temporary, 0o640);
    chownSync(temporary, process.getuid(), lstatSync(hqRoot).gid);
    renameSync(temporary, request);
  } finally {
    try { unlinkSync(temporary); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
  }
}
