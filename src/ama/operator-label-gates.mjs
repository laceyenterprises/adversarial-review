import { setTimeout as sleep } from 'node:timers/promises';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { adversarialOwnCheckContexts, isAdversarialOwnStatusContext, checkItemState, latestCheckRollupItems, classifyCheckRollup, summarizeChecksConclusion } from '../checks-summary.mjs';
import { writeFileAtomic } from '../atomic-write.mjs';
import { execGhWithRetry } from '../gh-cli.mjs';
import { deliverAlert } from '../alert-delivery.mjs';
import { parseBlockingFindingsSection } from '../kernel/review-findings.mjs';

// LABELGATE-01: label names come from these guards' refusal messages, not
// PR labels. Presence of a label is never proof of authorization or green CI.
export const OPERATOR_LABEL_GATES = Object.freeze([
  { label: 'ci-cost-approved', checks: ['ci-cost-guard', 'ci-cost', 'ci-cost guard'], source: 'scripts/ci-cost-guard.py; src/ama/ci-cost.mjs' },
  { label: 'allow-submodule-pointer-bump', checks: ['submodule-pointer-gate', 'run submodule pointer gate'], source: 'agent-os/scripts/submodule-pointer-gate.py' },
  { label: 'live-pack-edit-approved', checks: ['live-pack-cross-edit', 'live_pack_cross_edit'], source: 'src/live-pack-cross-edit.mjs' },
  { label: 'gym-freeze-port', checks: ['gym-freeze-guard', 'gym-freeze', 'gym freeze guard'], source: 'agent-os/scripts/check-gym-freeze.py (historical blocking mode)' },
].map(gate => Object.freeze({ ...gate, checks: Object.freeze(gate.checks) })));

// REMLABEL-01: use the same registry for review findings and CI refusals.
// Unknown findings remain actionable; label presence never erases a finding
// from an old review. Only a fresh review can observe an operator waiver.
export function classifyOperatorGatedFindings(reviewBody) {
  const findings = parseBlockingFindingsSection(reviewBody);
  const gated = [];
  const actionable = [];
  for (const finding of findings || []) {
    const identity = `${finding.title || ''} ${finding.category || ''}`.toLowerCase();
    const gate = OPERATOR_LABEL_GATES.find(entry => entry.checks.some(check =>
      identity.includes(`[${check}]`) || identity.trim() === check)
      || Object.values(finding).some(value => typeof value === 'string'
        && value.includes(`operator-label-required:${entry.label}`)));
    if (gate) gated.push({ ...finding, check: gate.checks[0], label: gate.label,
      reason: `operator-label-required:${gate.label}` });
    else actionable.push(finding);
  }
  return { gated, actionable, allGated: findings?.length > 0 && actionable.length === 0 };
}

export function operatorGatedRemediationInstructions(reviewBody, classification = classifyOperatorGatedFindings(reviewBody)) {
  const { gated, actionable } = classification;
  if (!gated.length) return '';
  return `\n\n## Operator-gated findings (authoritative)\n`
    + `Only these blocking findings may be remediated: ${JSON.stringify(actionable)}.\n`
    + `The following findings require operator labels: ${JSON.stringify(gated)}.\n`
    + 'Leave their changes in place. Do not edit or restore their guarded files to base, revert the PR, '
    + 'apply labels, or claim these findings as addressed. Report them in blockers[] with the required label, '
    + 'and set reReview.requested = false. If an actionable fix would touch a guarded change, stop and report it.\n';
}

export function operatorLabelGateFailures(rollup, { env = process.env, cfg = null, requiredContexts = [] } = {}) {
  const external = latestCheckRollupItems(rollup).filter(item =>
    !isAdversarialOwnStatusContext(item, adversarialOwnCheckContexts(env)));
  const reported = external.map(item => ({ name: item.context || item.name, conclusion: 'SUCCESS' }));
  if (summarizeChecksConclusion(reported, { env, cfg }) === 'PENDING'
    || classifyCheckRollup(reported, { requiredContexts: (requiredContexts || []).filter(context =>
      !isAdversarialOwnStatusContext({ context }, adversarialOwnCheckContexts(env))) }) === 'PENDING') return [];
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
export async function resolveOperatorLabelGateFailures({ rollup, repo, headSha, execFileImpl, env, signal, cfg = null, requiredContexts = [], retryFailedReads = false }) {
  const none = { gates: [], inconclusive: false };
  const pending = { gates: [], inconclusive: true };
  const external = latestCheckRollupItems(rollup).filter(item =>
    !isAdversarialOwnStatusContext(item, adversarialOwnCheckContexts(env)));
  if (signal?.aborted) return pending;
  if (!repo || !headSha
    || external.some(item => [null, 'PENDING', 'UNKNOWN'].includes(classifyCheckRollup([item])))) return none;
  const reported = external.map(item => ({ name: item.context || item.name, conclusion: 'SUCCESS' }));
  if (summarizeChecksConclusion(reported, { env, cfg }) === 'PENDING'
    || classifyCheckRollup(reported, { requiredContexts: (requiredContexts || []).filter(context =>
      !isAdversarialOwnStatusContext({ context }, adversarialOwnCheckContexts(env))) }) === 'PENDING') return none;
  const candidates = new Map();
  for (const item of external) {
    if (classifyCheckRollup([item]) === 'SUCCESS' || operatorLabelGateFailures([item], { env, cfg: { requiredCheckContexts: [] } }).length) continue;
    const match = String(item.detailsUrl || '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/\d+\/job\/(\d+)(?:\?.*)?$/);
    if (checkItemState(item) !== 'FAILURE' || ![/^repo-guards(?:[-/ ].*)?$/i, /^repo guards$/i].some(pattern =>
        pattern.test(String(item.name || '')) || pattern.test(String(item.workflowName || '')))
      || !match || match[1] !== repo || !execFileImpl) return none;
    candidates.set(item, match[2]);
  }
  if (!candidates.size) return { gates: operatorLabelGateFailures(external, { env }), inconclusive: false };
  let cache = jobCaches.get(execFileImpl);
  if (!cache) { cache = new Map(); jobCaches.set(execFileImpl, cache); }
  const expanded = [];
  const deadline = Date.now() + JOB_READ_BUDGET_MS;
  let reads = 0;
  for (const item of external) {
    const jobId = candidates.get(item);
    if (!jobId) { expanded.push(item); continue; }
    if (signal?.aborted) return pending;
    const key = JSON.stringify([repo, jobId, headSha]);
    let entry = cache.get(key);
    if (entry && (entry.expiresAt <= Date.now() || (retryFailedReads && entry.inconclusive))) { cache.delete(key); entry = null; }
    if (!entry) {
      const remaining = deadline - Date.now();
      if (reads >= MAX_JOB_READS_PER_PASS || remaining <= 0) return pending;
      reads++;
      try {
        const { stdout } = await execGhWithRetry({ execFileImpl, args: ['api', `repos/${repo}/actions/jobs/${jobId}`],
          env, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining),
          timeoutMs: Math.min(JOB_READ_TIMEOUT_MS, remaining), retries: 1, backoffMs: 100,
          refreshGhAuthImpl: async () => ({ skipped: 'bounded label classification' }),
        });
        if (signal?.aborted) return pending;
        const job = JSON.parse(stdout);
        const failures = Array.isArray(job.steps) ? job.steps.filter(step => step.conclusion === 'failure') : [];
        const steps = failures.map(step => ({ name: step.name, conclusion: 'FAILURE' }));
        const gates = job.head_sha === headSha && job.conclusion === 'failure'
          ? operatorLabelGateFailures(steps, { env, cfg: { requiredCheckContexts: [] } }) : [];
        entry = { gates, expiresAt: Infinity };
      } catch {
        if (signal?.aborted) return pending;
        entry = { gates: [], inconclusive: true, expiresAt: Date.now() + FAILED_JOB_READ_TTL_MS };
      }
      if (cache.size >= MAX_JOB_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      cache.set(key, entry);
    }
    if (entry.inconclusive) return pending;
    if (!entry.gates.length) return none;
    expanded.push(...entry.gates.map(gate => ({ name: `${item.name}: ${gate.check}`, conclusion: 'FAILURE',
      description: gate.reason })));
  }
  return { gates: operatorLabelGateFailures(expanded, { env, cfg: { requiredCheckContexts: [] } }), inconclusive: false };
}

// Background dispatch owns this retry window; the serial phase never sleeps.
export async function resolveOperatorLabelGateFailuresWithRetry(args, {
  delaysMs = [], sleepImpl = (ms, signal) => sleep(ms, undefined, signal ? { signal } : {}),
  resolveImpl = resolveOperatorLabelGateFailures,
} = {}) {
  let result = await resolveImpl(args);
  for (const delayMs of delaysMs) {
    if (!result.inconclusive || args.signal?.aborted) break;
    await sleepImpl(delayMs, args.signal);
    if (args.signal?.aborted) break;
    result = await resolveImpl({ ...args, retryFailedReads: true });
  }
  return result;
}

// Separate from dispatch records: this hold must never look like a launch.
// Persist successful delivery across daemon restarts, once per PR head.
const alerted = new Set();
const MAX_ALERTED_ENTRIES = 512;
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Superseded heads and closed PRs need no paging receipt. Old unrelated receipts
// expire after 30 days. Active claims are excluded from this best-effort sweep.
export function sweepOperatorLabelHolds({ rootDir, repo, prNumber, headSha, closed = false }) {
  const dir = join(rootDir, 'data', 'operator-label-holds');
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const path = join(dir, name);
    try {
      try { statSync(`${path}.lock`); continue; } catch (error) { if (error.code !== 'ENOENT') continue; }
      const receipt = JSON.parse(readFileSync(path, 'utf8'));
      const obsolete = receipt.repo === repo && receipt.prNumber === prNumber
        && (closed || receipt.headSha !== headSha);
      if (obsolete || Date.now() - statSync(path).mtimeMs > RECEIPT_RETENTION_MS) {
        unlinkSync(path);
        alerted.delete(path);
      }
    } catch { /* A corrupt or concurrently replaced receipt grants no authority. */ }
  }
}
const PAGE_LOCK_STALE_MS = Math.max(1_000, Number(process.env.OPERATOR_LABEL_PAGE_LOCK_STALE_MS) || 60_000);
export async function holdForOperatorLabels({ rootDir, repo, prNumber, headSha, gates,
  deliverAlertImpl = deliverAlert, postCommentImpl = null, logger = console, now = new Date().toISOString() }) {
  if (!headSha || !gates.length) return null;
  sweepOperatorLabelHolds({ rootDir, repo, prNumber, headSha });
  const key = JSON.stringify([repo, prNumber, headSha]);
  const dir = join(rootDir, 'data', 'operator-label-holds');
  const path = join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  const lockPath = `${path}.lock`;
  const reason = gates[0].reason;
  const result = { dispatched: false, skipMergeAgent: true, recoveryWait: true,
    needsOperator: true, reason, operatorLabelGates: gates };
  // Only the closer pages; concurrent closer observations claim paging with an
  // exclusive file, then re-read the receipt under the claim. Crash recovery
  // retries after the bounded stale-lock window; failed transport also retries.
  let claimed = false;
  try {
    const receiptMatches = prior => prior?.alertedAt && (!postCommentImpl || prior.commentedAt) && prior.repo === repo && prior.prNumber === prNumber
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
    let commentedAt = prior?.commentedAt || null;
    if (postCommentImpl && !commentedAt) {
      try {
        const posted = await postCommentImpl({ repo, prNumber,
          body: `Operator-gated review held: ${gates.map(g => `\`${g.check}\` requires \`${g.label}\``).join('; ')}. `
            + 'Remediation will leave the guarded changes in place. An operator must inspect the finding and, if appropriate, apply the named label, then rerun review. Do not revert the PR to satisfy this finding.' });
        if (posted?.posted) commentedAt = now;
      } catch (error) { logger.warn?.(`Operator-label comment failed: ${error.message}`); }
    }
    if (!alertedAt && !alerted.has(path)) {
      try {
        await deliverAlertImpl(`${repo} PR ${prNumber} head ${headSha}: ${gates.map(g => `${g.check} requires operator label ${g.label}`).join('; ')}. Hold the guarded changes in place. An operator must inspect the refusal and, if appropriate, apply the named label and rerun review or the named check. Remediation must not revert these changes to satisfy the gate.`, {
          event: 'ama_closer.operator_label_required', payload: { repo, prNumber, headSha, reason, gates },
        });
        if (alerted.size >= MAX_ALERTED_ENTRIES) alerted.delete(alerted.values().next().value);
        alerted.add(path);
        alertedAt = now;
      } catch (error) { logger.warn?.(`Operator-label page failed: ${error.message}`); }
    }
    writeFileAtomic(path, JSON.stringify({ repo, prNumber, headSha, reason, gates, alertedAt, commentedAt }, null, 2));
  } catch (error) { logger.warn?.(`Operator-label hold persistence failed: ${error.message}`); }
  finally { if (claimed) { try { unlinkSync(lockPath); } catch { /* stale claim already removed */ } } }
  return result;
}
