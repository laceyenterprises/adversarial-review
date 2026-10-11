import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { adversarialOwnCheckContexts, isAdversarialOwnStatusContext, checkItemState, latestCheckRollupItems, classifyCheckRollup } from '../checks-summary.mjs';
import { writeFileAtomic } from '../atomic-write.mjs';
import { deliverAlert } from '../alert-delivery.mjs';

// LABELGATE-01: label names come from these guards' refusal messages, not
// PR labels. Presence of a label is never proof of authorization or green CI.
export const OPERATOR_LABEL_GATES = Object.freeze([
  { label: 'ci-cost-approved', checks: ['ci-cost-guard', 'ci-cost', 'ci-cost guard'], source: 'scripts/ci-cost-guard.py; src/ama/ci-cost.mjs' },
  { label: 'allow-submodule-pointer-bump', checks: ['submodule-pointer-gate', 'run submodule pointer gate'], source: 'agent-os/scripts/submodule-pointer-gate.py' },
  { label: 'live-pack-edit-approved', checks: ['live-pack-cross-edit', 'live_pack_cross_edit'], source: 'src/live-pack-cross-edit.mjs' },
  { label: 'gym-freeze-port', checks: ['gym-freeze-guard', 'gym-freeze', 'gym freeze guard'], source: 'agent-os/scripts/check-gym-freeze.py (historical blocking mode)' },
].map(gate => Object.freeze({ ...gate, checks: Object.freeze(gate.checks) })));

export function operatorLabelGateFailures(rollup, { env = process.env } = {}) {
  const external = latestCheckRollupItems(rollup).filter(item =>
    !isAdversarialOwnStatusContext(item, adversarialOwnCheckContexts(env)));
  // A pending sibling can still report a repairable failure. Wait for it before
  // treating this as an exclusively operator-label closure hold.
  if (external.some(item => [null, 'PENDING', 'UNKNOWN'].includes(classifyCheckRollup([item])))) return [];
  const failed = external.filter(item =>
    ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED', 'STARTUP_FAILURE', 'STALE'].includes(checkItemState(item)));
  if (!failed.length) return [];
  const gates = failed.map(item => {
    const check = String(item.context || item.name || '').trim();
    const evidence = String(item.output?.summary || item.description || '');
    const refusalFor = g => evidence.includes(`operator-label-required:${g.label}`)
      || evidence.split('\n').some(line => line.includes(g.label)
        && /\b(?:apply|requires?|without)\b/i.test(line) && /\blabel\b/i.test(line));
    const gate = OPERATOR_LABEL_GATES.find(g =>
      (g.checks.includes(check.toLowerCase()) && (!evidence.trim() || refusalFor(g)))
      || (checkItemState(item) === 'FAILURE' && refusalFor(g)));
    // Cancellation, timeout, etc. do not prove an operator-label refusal.
    return gate && ['FAILURE', 'ERROR', 'ACTION_REQUIRED'].includes(checkItemState(item))
      ? { check, label: gate.label, reason: `operator-label-required:${gate.label}` } : null;
  });
  return gates.every(Boolean) ? gates : [];
}

// Only the registered repo-guards job family contains composite label gates.
// Other failed jobs, pending siblings, and unreadable/stale jobs cannot hold.
const JOB_READ_TIMEOUT_MS = 3_000;
const JOB_READ_BUDGET_MS = 5_000;
const MAX_JOB_READS_PER_PASS = 2;
const MAX_JOB_CACHE_ENTRIES = 512;
const FAILED_JOB_READ_TTL_MS = 60_000;
// Scope caches to the reader (including injected offline readers). Completed
// steps are immutable per repo/job/head; negative transport reads retry later.
const jobCaches = new WeakMap();
export async function resolveOperatorLabelGateFailures({ rollup, repo, headSha, execFileImpl, env, signal }) {
  const external = latestCheckRollupItems(rollup).filter(item =>
    !isAdversarialOwnStatusContext(item, adversarialOwnCheckContexts(env)));
  if (!repo || !headSha || signal?.aborted
    || external.some(item => [null, 'PENDING', 'UNKNOWN'].includes(classifyCheckRollup([item])))) return [];
  const candidates = new Map();
  for (const item of external) {
    if (classifyCheckRollup([item]) === 'SUCCESS' || operatorLabelGateFailures([item], { env }).length) continue;
    const match = String(item.detailsUrl || '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/\d+\/job\/(\d+)(?:\?.*)?$/);
    if (checkItemState(item) !== 'FAILURE' || !/^repo-guards(?:[-/ ].*)?$/i.test(String(item.name || ''))
      || !match || match[1] !== repo || !execFileImpl) return [];
    candidates.set(item, match[2]);
  }
  if (!candidates.size) return operatorLabelGateFailures(external, { env });
  let cache = jobCaches.get(execFileImpl);
  if (!cache) { cache = new Map(); jobCaches.set(execFileImpl, cache); }
  const expanded = [];
  const deadline = Date.now() + JOB_READ_BUDGET_MS;
  let reads = 0;
  for (const item of external) {
    const jobId = candidates.get(item);
    if (!jobId) { expanded.push(item); continue; }
    if (signal?.aborted) return [];
    const key = JSON.stringify([repo, jobId, headSha]);
    let entry = cache.get(key);
    if (entry && entry.expiresAt <= Date.now()) { cache.delete(key); entry = null; }
    if (!entry) {
      const remaining = deadline - Date.now();
      if (reads >= MAX_JOB_READS_PER_PASS || remaining <= 0) return [];
      reads++;
      try {
        const { stdout } = await execFileImpl('gh', ['api', `repos/${repo}/actions/jobs/${jobId}`], {
          timeout: Math.min(JOB_READ_TIMEOUT_MS, remaining), maxBuffer: 1024 * 1024, signal,
        });
        if (signal?.aborted) return [];
        const job = JSON.parse(stdout);
        const failures = Array.isArray(job.steps) ? job.steps.filter(step => step.conclusion === 'failure') : [];
        const steps = failures.map(step => ({ name: step.name, conclusion: 'FAILURE' }));
        const gates = job.head_sha === headSha && job.conclusion === 'failure'
          ? operatorLabelGateFailures(steps, { env }) : [];
        entry = { gates, expiresAt: Infinity };
      } catch {
        if (signal?.aborted) return [];
        entry = { gates: [], expiresAt: Date.now() + FAILED_JOB_READ_TTL_MS };
      }
      if (cache.size >= MAX_JOB_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      cache.set(key, entry);
    }
    if (!entry.gates.length) return [];
    expanded.push(...entry.gates.map(gate => ({ name: `${item.name}: ${gate.check}`, conclusion: 'FAILURE',
      description: gate.reason })));
  }
  return operatorLabelGateFailures(expanded, { env });
}

// Separate from dispatch records: this hold must never look like a launch.
// Persist successful delivery across daemon restarts, once per PR head.
const alerted = new Set();
const PAGE_LOCK_STALE_MS = Math.max(1_000, Number(process.env.OPERATOR_LABEL_PAGE_LOCK_STALE_MS) || 60_000);
export async function holdForOperatorLabels({ rootDir, repo, prNumber, headSha, gates,
  deliverAlertImpl = deliverAlert, logger = console, now = new Date().toISOString() }) {
  if (!headSha || !gates.length) return null;
  const key = JSON.stringify([repo, prNumber, headSha]);
  const dir = join(rootDir, 'data', 'operator-label-holds');
  const path = join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  const lockPath = `${path}.lock`;
  const reason = gates[0].reason;
  const result = { dispatched: false, skipMergeAgent: true, recoveryWait: true,
    needsOperator: true, reason, operatorLabelGates: gates };
  // Closer and remediation run in different processes. Claim paging with an
  // exclusive file, then re-read the receipt under the claim. Crash recovery
  // retries after the bounded stale-lock window; failed transport also retries.
  let claimed = false;
  try {
    const receiptMatches = prior => prior?.alertedAt && prior.repo === repo && prior.prNumber === prNumber
      && prior.headSha === headSha && prior.reason === reason && JSON.stringify(prior.gates) === JSON.stringify(gates);
    try { if (receiptMatches(JSON.parse(readFileSync(path, 'utf8')))) return result; } catch { /* no matching receipt */ }
    mkdirSync(dir, { recursive: true });
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > PAGE_LOCK_STALE_MS) unlinkSync(lockPath);
    } catch { /* no stale lock */ }
    try { closeSync(openSync(lockPath, 'wx')); claimed = true; }
    catch (error) { if (error.code === 'EEXIST') return result; throw error; }
    let prior;
    try { prior = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first observation */ }
    if (receiptMatches(prior)) return result;
    let alertedAt = prior?.alertedAt || null;
    if (!alertedAt && !alerted.has(path)) {
      try {
        await deliverAlertImpl(`${repo} PR ${prNumber} head ${headSha}: ${gates.map(g => `${g.check} requires operator label ${g.label}`).join('; ')}. Closure held; review remediation remains available. Inspect the refusal; if an override is appropriate, apply the label, then rerun the named check. Otherwise restore the guarded change to its base state.`, {
          event: 'ama_closer.operator_label_required', payload: { repo, prNumber, headSha, reason, gates },
        });
        alerted.add(path);
        alertedAt = now;
      } catch (error) { logger.warn?.(`Operator-label page failed: ${error.message}`); }
    }
    writeFileAtomic(path, JSON.stringify({ repo, prNumber, headSha, reason, gates, alertedAt }, null, 2));
  } catch (error) { logger.warn?.(`Operator-label hold persistence failed: ${error.message}`); }
  finally { if (claimed) { try { unlinkSync(lockPath); } catch { /* stale claim already removed */ } } }
  return result;
}
