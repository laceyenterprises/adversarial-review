// Synthetic cross-process contention; no host ledger, network or provider use.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noWorkVerdict } from './execution-verdict.mjs';
import { recordHammerRetryDispatch, readHammerRetryCapLedger, refundUnexecutedHammerDispatch } from '../../src/ama/hammer-retry-cap.mjs';
const identity = { repo: 'synthetic/recovery', prNumber: 8 };
if (['child', 'refund-child'].includes(process.argv[2])) {
  const [, , , root, worker, start] = process.argv;
  while (Date.now() < Number(start)) await new Promise(resolve => setTimeout(resolve, 5));
  for (let n = 0; n < 25; n++) {
    for (;;) {
      try {
        if (process.argv[2] === 'refund-child') {
          for (let owner = 0; owner < 4; owner++) {
            const launchRequestId = `lrq_${owner}_${n}`;
            refundUnexecutedHammerDispatch(root, identity, { jobKey: 'review', headSha: 'head',
              launchRequestId, executionVerdict: noWorkVerdict(launchRequestId) });
          }
        } else recordHammerRetryDispatch(root, identity, { jobKey: 'review', headSha: 'head',
          dispatchKey: `${worker}:${n}`, launchRequestId: `lrq_${worker}_${n}` });
        break;
      } catch (error) {
        if (error.code !== 'EBUSY') throw error;
        await new Promise(resolve => setTimeout(resolve, 2));
      }
    }
  }
} else {
  const counts = [];
  for (let run = 0; run < Number(process.argv[2] || 5); run++) {
    const root = mkdtempSync(join(tmpdir(), 'hammer-race-'));
    try {
      const start = Date.now() + 600;
      await Promise.all(Array.from({ length: 4 }, (_, worker) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', root, String(worker), String(start)], { stdio: ['ignore', 'ignore', 'pipe'] });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`synthetic child exit ${code}`)));
      })));
      if (process.argv.includes('--refunds')) {
        await Promise.all(Array.from({ length: 4 }, (_, worker) => new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'refund-child', root, String(worker), String(Date.now() + 600)], { stdio: ['ignore', 'ignore', 'pipe'] });
          child.on('error', reject);
          child.on('exit', code => code === 0 ? resolve() : reject(new Error(`synthetic refund child exit ${code}`)));
        })));
      }
      const ledger = readHammerRetryCapLedger(root, identity);
      counts.push({ count: ledger.attemptCount, receipts: ledger.chargedDispatchKeys.length, refunds: Object.keys(ledger.noWorkRefunds || {}).length, lifetime: ledger.lifetimeAttemptCount });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const expected = process.argv.includes('--refunds') ? 0 : 100;
  const failed = counts.filter(row => row.count !== expected || row.receipts !== 100
    || row.lifetime !== expected || (expected === 0 && row.refunds !== 100)).length;
  console.log(JSON.stringify({ expected, counts, failed }));
  if (failed && process.argv.includes('--assert')) process.exitCode = 1;
}
