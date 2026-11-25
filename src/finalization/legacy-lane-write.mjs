// Thin shell-writer boundary: preserve the existing entitled command and its
// output while holding the same route/issuance lock as the daemon and queue.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
// HAMWRITERTIMEOUT-01: the in-lane review-proof read is sized once from this
// nominal by host load. Its only ceiling is the run budget still remaining, so
// a fixed cap can never undercut the load-aware value (a 5.6x multiplier asks
// for 84 s; a 30 s cap turned that into a timeout after a passed predicate).
export const LEGACY_PROOF_NOMINAL_MS = 15_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export function validLegacyRunTimeoutMs(ms) {
  return Number.isSafeInteger(ms) && ms > 0 && ms <= LEGACY_RUN_MAX_MS;
}

export async function runLegacyLaneWrite({ rootDir, repository, base, command, argv, subject = null,
  readConfig = loadEffectiveMergeAuthorityConfig, exec = runCommandKeepingOutput, deadline, now = () => new Date().toISOString(), load,
  timeoutMs, killGraceMs = DEFAULT_KILL_GRACE_MS, prNumber, reviewValidatedAt, readReviewProof = readCloserReviewProof,
  onPhase = () => {} } = {}) {
  if (timeoutMs !== undefined && !validLegacyRunTimeoutMs(timeoutMs)) throw new TypeError('invalid legacy writer run timeout');
  const clock = typeof now === 'function' ? now : () => now;
  deadline ??= new Date(Date.parse(clock()) + loadAwareTimeoutMs(60_000, { ...load, maxMs: 360_000 })).toISOString();
  const cfg = readConfig({ rootDir });
  return routeFinalizationWriter({ rootDir, cfg, lane: { repository, base }, kind: 'closer', subject, legacyDeadline: deadline, now: clock,
    legacy: async () => {
      // Refuse an already-spent lane deadline; it never limits the run itself.
      if (!queueWaitMs(30_000, { ceilingMs: 60_000, deadline, now: clock(), load })) {
        if (reviewValidatedAt !== undefined) return { ok: false, reason: 'legacy-writer-timeout' };
        throw new Error('legacy writer deadline expired');
      }
      let timeout = timeoutMs ?? loadAwareTimeoutMs(LEGACY_RUN_NOMINAL_MS, { ...load, maxMs: LEGACY_RUN_CEILING_MS });
      if (reviewValidatedAt !== undefined) {
        onPhase('review-proof');
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
        // Follow the load-aware value up to the remaining run budget. An
        // exhausted budget never starts transport (checked after the read).
        const proofTimeout = Math.min(timeout,
          loadAwareTimeoutMs(LEGACY_PROOF_NOMINAL_MS, { ...load, maxMs: timeout }));
        let proof;
        try {
          proof = await readQueueEvidence({ read: ({ signal }) => readReviewProof({
            repo: repository, prNumber: targetPr, rootDir, headSha: subject?.head, validatedAt: reviewValidatedAt,
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
      const meteredMerge = reviewValidatedAt !== undefined
        && basename(argv[0] || '') === 'metered-gh.mjs' && argv[1] === 'exec-hammer'
        && argv[2] === 'pr' && argv[3] === 'merge';
      // Only the wrapper receives the path. Its gh child cannot write evidence
      // through stdout or stderr. A missing record or timeout proves no outcome.
      const scratch = meteredMerge ? mkdtempSync(join(tmpdir(), 'ham-transport-')) : null;
      const evidencePath = scratch && join(scratch, 'evidence');
      const readEvidence = () => {
        try { return evidencePath ? JSON.parse(readFileSync(evidencePath, 'utf8')) : null; }
        catch { return null; }
      };
      onPhase(meteredMerge ? 'preparation' : 'transport');
      try {
        const result = await exec(command, argv, { timeout, killSignal: 'SIGTERM', killGraceMs, encoding: 'utf8', maxBuffer: MAX_BUFFER,
          ...(evidencePath ? { env: { ...process.env, HAM_MERGE_TRANSPORT_EVIDENCE: evidencePath } } : {}) });
        if (meteredMerge) {
          const evidence = readEvidence();
          if (evidence?.value === 'transport') onPhase('transport', evidence.spawnedAt);
          else onPhase('writer-unconfirmed');
        }
        return result?.timedOut
          ? { ok: false, reason: `legacy writer command timed out after ${timeout} ms`, stdout: result.stdout, stderr: result.stderr,
            ...(reviewValidatedAt !== undefined ? { mergeOutcomeUnknown: true } : {}) }
          : result;
      } catch (error) {
        const evidence = readEvidence();
        if (Number.isInteger(error.code) && !error.signal) {
          if (evidence?.value === 'not-spawned') return { ok: false, reason: 'merge-command-not-spawned',
            mergeNotInvoked: true, stdout: error.stdout, stderr: error.stderr };
          if (evidence?.value === 'stale-credential-rejected' || evidence?.value === 'refreshed-credential-rejected') {
            onPhase('transport', evidence.spawnedAt);
            return { ok: false, reason: evidence.value, stdout: error.stdout, stderr: error.stderr };
          }
        }
        if (meteredMerge) {
          if (evidence?.value === 'transport') onPhase('transport', evidence.spawnedAt);
          else onPhase('writer-unconfirmed');
        }
        throw error;
      } finally {
        if (scratch) rmSync(scratch, { recursive: true, force: true });
      }
    } });
}
