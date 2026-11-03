// HAMMEROUTCOME-01: execution proof is run-scoped; process success is not merge success.
import { mkdirSync, writeFileSync, readFileSync, openSync, readSync, closeSync, fstatSync, constants, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolveHqRoot } from '../hq-root.mjs';

export function classifyHammerExit(raw) {
  const reason = String(raw || '');
  const groups = {
    'remediated-and-pushed': ['remediated-and-pushed'],
    'review-blocked': ['review-blocked', 'predicate-not-eligible', 'findings-unresolved'],
    'ci-red': ['ci-red', 'checks-red', 'checks-failed', 'ci-not-green', 'required-checks-failed', 'validation-failed', 'github-gate-red', 'github-gate-not-green'],
    conflict: ['conflict', 'merge-conflict', 'rebase-conflict', 'conflicting'],
    'cycle-exhausted': ['cycle-exhausted', 'hammer-retry-cap-exhausted', 'hammer-wall-clock-exceeded', 'merge-retry-budget-exhausted'],
    'lease-lost': ['lease-lost', 'merge-lease-not-held', 'merge-lease-lost', 'controller-owner-lost', 'lease-owner-lost', 'launch-ended'],
    'token-ceiling': ['token-ceiling', 'hammer-token-ceiling-exceeded'],
    'operator-canceled': ['operator-canceled', 'operator-cancelled', 'cancelled', 'canceled'],
    'provider-capacity': ['provider-capacity', 'provider_capacity', 'rate_limited'],
    crashed: ['crashed', 'worker_crashed', 'registration_lost_after_progress', 'spawn-failed', 'controller-error'],
    'already-merged-by-other': ['already-merged-by-other', 'merged-by-other', 'pr-already-merged'],
  };
  for (const [category, aliases] of Object.entries(groups)) if (aliases.includes(reason)) return category;
  if (reason === 'read-failed' || /(?:read-failed|read-unavailable|read-unconfirmed|probe-failed|probe-invalid|response-invalid|unreadable|observation-unavailable)/.test(reason)) return 'read-failed';
  return 'unclassified';
}

export function recordVerifiedHammerMerge({ live, headSha, executedAt, env = process.env, now = new Date() }) {
  const launchRequestId = env.HQ_LAUNCH_REQUEST_ID || env.LAUNCH_REQUEST_ID;
  const runId = env.HQ_WORKER_RUN_ID;
  if (!/^lrq_[A-Za-z0-9-]+$/.test(launchRequestId || '') || !/^wrun_[A-Za-z0-9-]+$/.test(runId || '')) throw new Error('merge outcome requires run identity');
  const merged = Date.parse(live?.mergedAt);
  const executed = Date.parse(executedAt);
  if (live?.state !== 'MERGED' || live.headRefOid !== headSha || !/^[a-f0-9]{40}$/.test(headSha || '')
      || !/^[a-f0-9]{40}$/.test(live.mergeCommit?.oid || '') || !Number.isFinite(merged)
      || !Number.isFinite(executed) || Math.abs(merged - executed) > 120_000) throw new Error('merge outcome requires recent exact-head GitHub merge proof');
  const receipt = { schemaVersion: 1, launchRequestId, runId, outcome: 'merged',
    headSha, mergeCommitSha: live.mergeCommit.oid, mergedAt: live.mergedAt,
    proof: 'github-exact-head-own-merge', recordedAt: now.toISOString() };
  const directory = join(env.HAM_HQ_ROOT || resolveHqRoot(env), 'dispatch', launchRequestId, 'hammer-progress', runId);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'outcome.json');
  try { writeFileSync(file, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; return JSON.parse(readFileSync(file, 'utf8')); }
  return receipt;
}


export function hammerNoMergeDetails({ hqRoot, launchRequestId, runId, raw }) {
  const receipts = {};
  if (/^lrq_[A-Za-z0-9-]+$/.test(launchRequestId || '') && /^wrun_[A-Za-z0-9-]+$/.test(runId || '')) {
    for (const milestone of ['terminal-stop', 'remediation-pushed', 'last-phase']) {
      let fd;
      try {
        fd = openSync(join(hqRoot, 'dispatch', launchRequestId, 'hammer-progress', runId, `${milestone}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        if (!fstatSync(fd).isFile()) continue;
        const buffer = Buffer.alloc(4097);
        const size = readSync(fd, buffer, 0, buffer.length, 0);
        if (size > 4096) continue;
        const receipt = JSON.parse(buffer.subarray(0, size).toString());
        if (receipt.schemaVersion === 1 && receipt.runId === runId && receipt.launchRequestId === launchRequestId && receipt.milestone === milestone) receipts[milestone] = receipt;
      } catch { /* Missing proof remains explicitly unclassified. */ }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  }
  const lastPhase = String(receipts['terminal-stop']?.reason || receipts['last-phase']?.reason || raw || 'unknown').slice(0, 512);
  let phaseOutcome = classifyHammerExit(lastPhase);
  const headSha = receipts['remediation-pushed']?.headSha;
  if (phaseOutcome === 'unclassified' && /^[a-f0-9]{40}$/.test(headSha || '')) phaseOutcome = 'remediated-and-pushed';
  return { phaseOutcome, lastPhase, ...(headSha ? { pushedHeadSha: headSha } : {}) };
}


// This diagnostic phase can advance; it grants no progress credit or authority.
export function recordHammerPhase(reason, { env = process.env, now = new Date() } = {}) {
  const launchRequestId = env.HQ_LAUNCH_REQUEST_ID || env.LAUNCH_REQUEST_ID;
  const runId = env.HQ_WORKER_RUN_ID;
  if (!/^lrq_[A-Za-z0-9-]+$/.test(launchRequestId || '') || !/^wrun_[A-Za-z0-9-]+$/.test(runId || '')) return null;
  const directory = join(env.HAM_HQ_ROOT || resolveHqRoot(env), 'dispatch', launchRequestId, 'hammer-progress', runId);
  mkdirSync(directory, { recursive: true });
  const receipt = { schemaVersion: 1, launchRequestId, runId, milestone: 'last-phase', at: now.toISOString(), reason: String(reason || 'unknown').slice(0, 512) };
  const temporary = join(directory, `.phase-${randomUUID()}`);
  writeFileSync(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  renameSync(temporary, join(directory, 'last-phase.json'));
  return receipt;
}
