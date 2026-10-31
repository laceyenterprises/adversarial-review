#!/usr/bin/env node
// Read-only observation, never lease admission or merge authority.
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectMergeLease, readMergeLeaseHistory } from '../src/ama/merge-lease.mjs';

export function hammerLeaseState({ rootDir, repo, base, pr, head }, {
  inspect = inspectMergeLease, history = readMergeLeaseHistory,
} = {}) {
  if (!Number.isSafeInteger(pr) || pr <= 0 || !/^[a-f0-9]{40}$/i.test(head || '')) {
    throw new Error('invalid PR/head');
  }
  const normalizedHead = String(head).toLowerCase();
  const { holder } = inspect({ rootDir, repo, base });
  if (holder) {
    if (!Number.isSafeInteger(holder.holderPr) || holder.holderPr <= 0
      || !/^[a-f0-9]{40}$/i.test(holder.holderHead || '') || !holder.leaseId) {
      throw new Error('invalid holder');
    }
    // A rebase may change this PR's head while its lease still names the
    // acquisition head. Conservatively report held across that transition.
    // Expiry/dead PID does not prove release; only the release path does.
    if (holder.holderPr === pr) return 'held';
  }
  const latest = history(rootDir, { repo, base })
    .filter(row => row.holderPr === pr && typeof row.holderHead === 'string'
      && row.holderHead.toLowerCase() === normalizedHead).at(-1);
  return latest?.releasedAt ? 'released' : 'none';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: {
      'root-dir': { type: 'string', default: fileURLToPath(new URL('..', import.meta.url)) },
      repo: { type: 'string' }, base: { type: 'string' },
      pr: { type: 'string' }, head: { type: 'string' },
    } });
    const state = hammerLeaseState({
      rootDir: values['root-dir'], repo: values.repo, base: values.base,
      pr: Number(values.pr), head: values.head,
    });
    process.stdout.write(`${state}\n`);
  } catch {
    process.stderr.write('lease-state-unavailable: cannot establish current PR/head lease state\n');
    process.exitCode = 1;
  }
}
