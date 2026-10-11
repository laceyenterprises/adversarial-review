import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { adversarialOwnCheckContexts, isAdversarialOwnStatusContext, checkItemState, latestCheckRollupItems } from '../checks-summary.mjs';
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
  const failed = latestCheckRollupItems(rollup).filter(item =>
    !isAdversarialOwnStatusContext(item, adversarialOwnCheckContexts(env))).filter(item =>
    ['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED', 'STARTUP_FAILURE', 'STALE'].includes(checkItemState(item)));
  if (!failed.length) return [];
  const gates = failed.map(item => {
    const check = String(item.context || item.name || '').trim();
    const evidence = String(item.output?.summary || item.description || '');
    const gate = OPERATOR_LABEL_GATES.find(g => g.checks.includes(check.toLowerCase())
      || (checkItemState(item) === 'FAILURE' && (evidence.includes(`operator-label-required:${g.label}`)
        || evidence.split('\n').some(line => line.includes(g.label)
          && /\b(?:apply|requires?|without)\b/i.test(line) && /\blabel\b/i.test(line)))));
    // Cancellation, timeout, etc. do not prove an operator-label refusal.
    return gate && ['FAILURE', 'ERROR', 'ACTION_REQUIRED'].includes(checkItemState(item))
      ? { check, label: gate.label, reason: `operator-label-required:${gate.label}` } : null;
  });
  return gates.every(Boolean) ? gates : [];
}

// GitHub rollups name composite jobs, not the failing guard. Resolve their
// failed steps from the exact-head job API; unrelated failed steps prevent a
// label-only classification. An unreadable/stale job never creates a hold.
const JOB_READ_TIMEOUT_MS = Math.max(1_000, Number(process.env.OPERATOR_LABEL_JOB_READ_TIMEOUT_MS) || 10_000);
export async function resolveOperatorLabelGateFailures({ rollup, repo, headSha, execFileImpl, env }) {
  const expanded = [];
  for (const item of latestCheckRollupItems(rollup)) {
    if (checkItemState(item) !== 'FAILURE' || operatorLabelGateFailures([item], { env }).length) {
      expanded.push(item);
      continue;
    }
    const match = String(item.detailsUrl || '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/\d+\/job\/(\d+)(?:\?.*)?$/);
    if (!match || match[1] !== repo || !execFileImpl) { expanded.push(item); continue; }
    try {
      const { stdout } = await execFileImpl('gh', ['api', `repos/${repo}/actions/jobs/${match[2]}`], {
        timeout: JOB_READ_TIMEOUT_MS, maxBuffer: 1024 * 1024,
      });
      const job = JSON.parse(stdout);
      const failures = Array.isArray(job.steps) ? job.steps.filter(step => step.conclusion === 'failure') : [];
      const steps = failures.map(step => ({ name: step.name, conclusion: 'FAILURE' }));
      if (job.head_sha !== headSha || job.conclusion !== 'failure' || !operatorLabelGateFailures(steps, { env }).length) {
        expanded.push(item);
      } else {
        expanded.push(...steps.map(step => ({ ...step, name: `${item.name}: ${step.name}`,
          description: `operator-label-required:${operatorLabelGateFailures([step], { env })[0].label}` })));
      }
    } catch { expanded.push(item); }
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
    mkdirSync(dir, { recursive: true });
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > PAGE_LOCK_STALE_MS) unlinkSync(lockPath);
    } catch { /* no stale lock */ }
    try { closeSync(openSync(lockPath, 'wx')); claimed = true; }
    catch (error) { if (error.code === 'EEXIST') return result; throw error; }
    let prior;
    try { prior = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first observation */ }
    let alertedAt = prior?.alertedAt || null;
    if (!alertedAt && !alerted.has(path)) {
      try {
        await deliverAlertImpl(`${repo} PR ${prNumber} head ${headSha}: ${gates.map(g => `${g.check} requires operator label ${g.label}`).join('; ')}. Hammer and remediation held.`, {
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
