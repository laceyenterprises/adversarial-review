// Thin shell-writer boundary: preserve the existing entitled command and its
// output while holding the same route/issuance lock as the daemon and queue.
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { DEFAULT_KILL_GRACE_MS, runCommandKeepingOutput } from '../run-command-keeping-output.mjs';
import { loadEffectiveMergeAuthorityConfig } from '../ama/effective-policy.mjs';
import { readCloserReviewProof } from '../ama/closer-review-proof.mjs';
import { routeFinalizationWriter } from './queue-routing-boundary.mjs';
import { queueWaitMs } from './queue-wait.mjs';
import { readQueueEvidence } from './queue-read.mjs';

// The lane deadline bounds only the lock/route WAIT. The wrapped command runs
// on its own budget, sized below a typical 300 s caller budget so this writer's
// expiry fires first and is reported with the command's output.
export const LEGACY_RUN_NOMINAL_MS = 240_000;
export const LEGACY_RUN_CEILING_MS = 600_000;
export const LEGACY_RUN_MAX_MS = 3_600_000;
export const LEGACY_PROOF_NOMINAL_MS = 15_000;
export const LEGACY_PROOF_CEILING_MS = 30_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export function validLegacyRunTimeoutMs(ms) {
  return Number.isSafeInteger(ms) && ms > 0 && ms <= LEGACY_RUN_MAX_MS;
}

export async function runLegacyLaneWrite({ rootDir, repository, base, command, argv, subject = null,
  readConfig = loadEffectiveMergeAuthorityConfig, exec = runCommandKeepingOutput, deadline, now = () => new Date().toISOString(), load,
  timeoutMs, killGraceMs = DEFAULT_KILL_GRACE_MS, prNumber, reviewValidatedAt, readReviewProof = readCloserReviewProof } = {}) {
  if (timeoutMs !== undefined && !validLegacyRunTimeoutMs(timeoutMs)) throw new TypeError('invalid legacy writer run timeout');
  const clock = typeof now === 'function' ? now : () => now;
  deadline ??= new Date(Date.parse(clock()) + loadAwareTimeoutMs(60_000, { ...load, maxMs: 360_000 })).toISOString();
  const cfg = readConfig({ rootDir });
  return routeFinalizationWriter({ rootDir, cfg, lane: { repository, base }, kind: 'closer', subject, legacyDeadline: deadline, now: clock,
    legacy: async () => {
      // Refuse an already-spent lane deadline; it never limits the run itself.
      if (!queueWaitMs(30_000, { ceilingMs: 60_000, deadline, now: clock(), load })) throw new Error('legacy writer deadline expired');
      let timeout = timeoutMs ?? loadAwareTimeoutMs(LEGACY_RUN_NOMINAL_MS, { ...load, maxMs: LEGACY_RUN_CEILING_MS });
      if (reviewValidatedAt !== undefined) {
        const started = performance.now();
        const target = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)$/.exec(subject?.target);
        const targetPr = prNumber ?? (target?.[1]?.toLowerCase() === repository.toLowerCase() ? Number(target[2]) : NaN);
        if (!Number.isSafeInteger(targetPr) || targetPr <= 0) {
          return { ok: false, reason: 'merge-target-unparseable' };
        }
        if (!Number.isFinite(Date.parse(reviewValidatedAt))) {
          return { ok: false, reason: 'terminal-review-evidence-unavailable' };
        }
        // Bound remote evidence while holding the lane; charge it to the run.
        const proofTimeout = Math.min(timeout,
          loadAwareTimeoutMs(LEGACY_PROOF_NOMINAL_MS, { ...load, maxMs: LEGACY_PROOF_CEILING_MS }));
        let proof;
        try {
          proof = await readQueueEvidence({ read: ({ signal }) => readReviewProof({
            repo: repository, prNumber: targetPr, headSha: subject?.head, validatedAt: reviewValidatedAt,
            operatorLogins: cfg.operatorLogins, signal,
          }) }, {}, proofTimeout);
        } catch (error) {
          if (error?.message === 'queue evidence deadline expired') {
            return { ok: false, reason: 'legacy-writer-timeout' };
          }
          /* Missing proof is an observation failure. */
        }
        timeout -= Math.ceil(performance.now() - started);
        if (proof?.ok !== true) {
          return { ok: false, reason: proof?.reason || 'terminal-review-evidence-unavailable',
            ...(proof?.needsOperator ? { needsOperator: true } : {}) };
        }
        if (timeout <= 0) return { ok: false, reason: 'legacy-writer-timeout' };
      }
      const result = await exec(command, argv, { timeout, killSignal: 'SIGTERM', killGraceMs, encoding: 'utf8', maxBuffer: MAX_BUFFER });
      return result?.timedOut
        ? { ok: false, reason: `legacy writer command timed out after ${timeout} ms`, stdout: result.stdout, stderr: result.stderr }
        : result;
    } });
}
