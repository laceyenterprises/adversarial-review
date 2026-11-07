import { recordHammerPhase } from './hammer-outcome.mjs';
import { appendAmaAuditAttempt, readAmaAuditEntry } from './audit.mjs';
import { reportHammerProgress } from './hammer-progress.mjs';
import { HAMMER_RETRYABLE_READ_OUTCOMES, hammerPhaseAttempt } from './hammer-phase-outcome.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';

// CLOSERGATES-01: a merge conflict found at closure is repairable work, not a
// terminal outcome. Each conflicting head this run reaches is counted in its
// private run directory. The run may end on `rebase-conflict` only once it has
// repaired conflicts on CONFLICT_REPAIR_BUDGET heads; an unsafe resolution
// still stops at once under its own reason (`conflict-semantic-unsafe`).
export const REPAIRABLE_CONFLICT = 'rebase-conflict';
export const CONFLICT_REPAIR_BUDGET = 3;
export const CONFLICT_REPAIR_EXHAUSTED = 'conflict-repair-exhausted';
const conflictLedger = env => env.HAM_RUN_DIR ? join(env.HAM_RUN_DIR, 'conflict-repairs.json') : null;
function conflictedHeads(env) {
  const path = conflictLedger(env);
  if (!path) return null;
  try {
    const heads = JSON.parse(readFileSync(path, 'utf8')).heads;
    return Array.isArray(heads) ? heads.filter(head => typeof head === 'string') : [];
  } catch { return []; }
}
function noteConflictedHead(env, headSha) {
  const path = conflictLedger(env);
  const heads = conflictedHeads(env);
  if (!path || !headSha || heads.includes(headSha)) return;
  try { writeFileAtomic(path, `${JSON.stringify({ heads: [...heads, headSha] })}\n`, { mode: 0o600 }); }
  catch { /* An unrecorded head only delays exhaustion; it never ends the run. */ }
}
export class RepairableConflictError extends Error {
  constructor(heads) {
    super(`${REPAIRABLE_CONFLICT} is repairable, not terminal (${heads}/${CONFLICT_REPAIR_BUDGET} conflicting heads this run)`);
    this.code = 'HAM_REPAIRABLE_CONFLICT';
  }
}

// Failure recording must work before any GitHub read or merge-lease acquisition.
// Reasons are fixed codes, never transport output (which can contain secrets).
// The terminal-stop progress receipt is written only when the caller declares
// the run's final exit; helper failures the closer may still retry write none.
export function recordHammerEarlyFailure(reason, { env = process.env, headSha, final = false } = {}) {
  if (!/^[a-z][a-z0-9:-]*$/.test(reason || '')) throw new TypeError('invalid hammer failure reason');
  // A later controller step must not terminalize with its previous phase's
  // success. The procedure exports a step identity before non-phase commands.
  if (['published', 'verified', 'ci-settled', 'ci-wait-not-needed'].includes(reason)) {
    const step = env.HAM_PROCEDURE_STEP;
    reason = /^[a-z][a-z0-9-]*$/.test(step || '') ? `${step}-failed` : 'procedure-step-failed';
  }
  const headFor = /^[a-f0-9]{40}$/i.test(headSha || '') ? headSha
    : env.HAM_TARGET_REMEDIATION_SHA || env.HAM_REVIEWED_SHA;
  if (reason === REPAIRABLE_CONFLICT) {
    noteConflictedHead(env, headFor);
    // A phase observation grants repair work, never a terminal audit.
    if (final !== true) return null;
    // A run without its private directory cannot count; keep the old rule.
    const heads = conflictedHeads(env);
    if (heads && heads.length < CONFLICT_REPAIR_BUDGET) throw new RepairableConflictError(heads.length);
    if (heads) reason = CONFLICT_REPAIR_EXHAUSTED;
  }
  try { recordHammerPhase(reason, { env }); } catch { /* Diagnostic capture cannot block the original failure. */ }
  if (final === true) reportHammerProgress('terminal-stop', { env, reason, final });
  const identity = {
    hqRoot: env.HAM_HQ_ROOT || env.HQ_ROOT,
    repo: env.HAM_REPO,
    prNumber: Number(env.HAM_PR_NUMBER),
    headSha: headFor,
  };
  if (!identity.hqRoot || !identity.repo || !identity.prNumber || !identity.headSha) return null;
  const launchRequestId = env.HQ_LAUNCH_REQUEST_ID || null;
  const existing = readAmaAuditEntry(identity.hqRoot, identity.repo, identity.prNumber, identity.headSha);
  const prior = existing?.attempts?.findLast(attempt =>
    (launchRequestId ? attempt.launchRequestId === launchRequestId
      : !attempt.launchRequestId && attempt.attemptPhase === 'hammer-early-exit') &&
    ['succeeded', 'failed-without-merge', 'superseded', 'deferred'].includes(attempt.outcome));
  // A later authoritative fence overrides an observation failure. Generic
  // wrapper exits still preserve the phase's original failure receipt.
  const authoritativeFence = ['controller-cancelled', 'controller-owner-lost', 'head-changed',
    'rebase-conflict', 'github-gate-red', 'predicate-not-eligible', CONFLICT_REPAIR_EXHAUSTED].includes(reason);
  if (prior && !(authoritativeFence && prior.outcome === 'deferred'
    && HAMMER_RETRYABLE_READ_OUTCOMES.has(prior.reason))) return existing;
  return appendAmaAuditAttempt({
    ...identity,
    attempt: hammerPhaseAttempt({ outcome: 'failed-without-merge', reason, launchRequestId,
      attemptPhase: 'hammer-early-exit' }),
    metadata: { closureAuthority: 'ham-terminal-remediation' },
  });
}

export function reportHammerEarlyFailure(reason, options) {
  try { return recordHammerEarlyFailure(reason, options); }
  catch (error) {
    if (error instanceof RepairableConflictError) {
      process.stderr.write(`HAM: ${error.message}; not recorded as a stop\n`);
      return null;
    }
    // Preserve the original failure, but make an unavailable audit explicit.
    process.stderr.write('HAM terminal failure audit unavailable\n');
    return null;
  }
}
