// The worker class a merge-agent dispatch runs on.
//
// `roles.merge_agent_worker_class` names the class. CLOSERREUSE-01 (SEV2
// 2026-09-29): this host pins it to `hammer`, a codex harness, and the
// watcher's AMA recovery fallback kept dispatching it through the codex weekly
// cap. Every fallback hammer crashed or was refused as `harness_unhealthy`
// (agent-os#7348, #7349). The AMA closer already avoided that: HHR resolves
// its class through fleet-quota grounding and
// `roles.adversarial.merge_authority.worker_class_fallback`
// (src/ama/harness-fallback.mjs). The merge-agent now resolves through the
// same resolver and the same fallback list. While openai/oauth is grounded,
// `hammer` dispatches as `hammer-claude`, and it returns to `hammer` once
// openai recovers.
//
// One difference from the closer: when the configured class is grounded and
// no fallback is available, the closer still dispatches on the primary ("a
// doomed spawn is no worse"). The merge-agent is itself the fallback lane, so
// it defers instead. It never dispatches a hard- or soft-grounded class: fallback
// candidates are screened on both (`screenSoftGroundedFallbacks`), where the
// closer screens them on hard grounding only. A deferral is recorded durably
// (first seen, count) and escalates once as `merge_agent.harness_grounded_deferral`
// after 30 minutes, so the last-resort lane cannot stall silently. An
// unreadable or ambiguous quota status is not grounding; both paths keep the
// primary then.

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCloserDispatchHarness } from './ama/harness-fallback.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { loadConfigCached } from './config-loader.mjs';
import { MODULE_CONFIG_PATH, resolveDefaultMergeAgentWorkerClass } from './role-config.mjs';

// Worker class used for merge-orchestration dispatch. Default is the
// `merge-agent` stub adapter; operators pin to a real model class
// (`codex`, `claude-code`) via env when the merge-agent surface is being
// validated against live models, or during a budget-squeeze where the
// stub's behavior needs to be substituted by a known-working coding
// worker class.
export const DEFAULT_MERGE_AGENT_WORKER_CLASS = 'merge-agent';
export const MERGE_AGENT_WORKER_CLASS_ENV = 'ADVERSARIAL_REVIEW_MERGE_AGENT_WORKER_CLASS';
export const ALLOWED_MERGE_AGENT_WORKER_CLASSES = Object.freeze([
  'merge-agent',
  'codex',
  'claude-code',
]);
export const MERGE_AGENT_HARNESS_GROUNDED_REASON = 'merge-agent-harness-grounded';

// Cascade-aware merge-agent worker class resolver. Consults config.yaml
// FIRST (module → top → *.local) and env LAST per SPEC §3. The top-level
// canonical key `roles.merge_agent_worker_class` overrides the module's
// `merge_agent.worker_class` via the SPEC §10.2 `__aliases` block. The
// loader fails loud on enum violations, env-alias conflicts, and YAML 1.2
// boolean-coercion attempts.
//
// The `_isMergeAgentConfigError` flag and `configKey` / `requestedValue`
// shape on the error are preserved for downstream callers that key off
// them (e.g. the dispatch refusal path).
// CFG-02 round-1 review B6 fix (2026-05-30): requestedValue defaults
// to null so downstream templating doesn't render the multi-value
// diagnostic blob the loader puts in err.got for env-alias conflicts.
// (B1 mislabel fix deferred — see follow-up-remediation.mjs for the
// matching rationale.)
export function resolveMergeAgentWorkerClass(env = process.env, opts = {}) {
  try {
    return resolveDefaultMergeAgentWorkerClass({ env, ...opts });
  } catch (err) {
    if (err && err.name === 'AgentOSConfigError') {
      err.isMergeAgentConfigError = true;
      err.configKey = err.envName || MERGE_AGENT_WORKER_CLASS_ENV;
      err.requestedValue = null;
    }
    throw err;
  }
}

// The closer's fallback list (schema default `[hammer-claude]`). A config that
// cannot be read gives no fallback, which still never dispatches a grounded
// class: the primary's grounding is probed either way.
export function mergeAgentFallbackWorkerClasses(env = process.env, { logger = console } = {}) {
  try {
    const cfg = loadConfigCached({ env, modulePaths: [MODULE_CONFIG_PATH] }).getMergeAuthorityConfig();
    return Array.isArray(cfg?.workerClassFallback) ? cfg.workerClassFallback : [];
  } catch (err) {
    if (err instanceof ReferenceError) throw err;
    logger?.warn?.(
      '[merge-agent] could not read roles.adversarial.merge_authority.worker_class_fallback; '
        + `no harness fallback for this dispatch: ${err?.message || err}`,
    );
    return [];
  }
}

// A merge-agent-harness-grounded deferral outliving this window escalates once.
// Same threshold as the merge-agent stuck alert.
export const MERGE_AGENT_HARNESS_DEFERRAL_ESCALATE_AFTER_MS = 30 * 60 * 1000;
export const MERGE_AGENT_HARNESS_DEFERRAL_EVENT = 'merge_agent.harness_grounded_deferral';

function safeSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

export function mergeAgentHarnessDeferralFilePath(dir, job) {
  const safeRepo = safeSegment(String(job?.repo ?? '').replace(/\//g, '__'));
  const safeSha = safeSegment(String(job?.headSha || 'no-sha'));
  return join(dir, `${safeRepo}-pr-${Number(job?.prNumber)}-${safeSha}.json`);
}

function readDeferralRecord(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Durable record of a merge-agent-harness-grounded deferral for one (PR, head).
 * `firstDeferredAt` survives every later tick; once the deferral is older than
 * `escalateAfterMs` the `merge_agent.harness_grounded_deferral` event is logged
 * at warn level exactly once (`escalatedAt`). A non-deferred resolution clears
 * the record. Best-effort: a write failure is logged and never blocks the tick.
 *
 * @returns {object|null} the record written, or null when cleared or unwritable.
 */
export function trackMergeAgentHarnessDeferral({
  dir,
  job,
  harness,
  now = new Date().toISOString(),
  escalateAfterMs = MERGE_AGENT_HARNESS_DEFERRAL_ESCALATE_AFTER_MS,
  logger = console,
} = {}) {
  if (!dir || !job) return null;
  const filePath = mergeAgentHarnessDeferralFilePath(dir, job);
  try {
    if (!harness?.deferred) {
      rmSync(filePath, { force: true });
      return null;
    }
    const existing = readDeferralRecord(filePath);
    const firstDeferredAt = existing?.firstDeferredAt || now;
    const record = {
      repo: job.repo,
      prNumber: Number(job.prNumber),
      headSha: job.headSha || null,
      reason: harness.reason,
      workerClass: harness.workerClass || null,
      provider: harness.provider || null,
      groundedBy: harness.groundedBy || null,
      primaryState: harness.primaryState || null,
      firstDeferredAt,
      lastDeferredAt: now,
      deferralCount: Number(existing?.deferralCount || 0) + 1,
      escalatedAt: existing?.escalatedAt || null,
    };
    const ageMs = Date.parse(now) - Date.parse(firstDeferredAt);
    if (!record.escalatedAt && Number.isFinite(ageMs) && ageMs >= escalateAfterMs) {
      record.escalatedAt = now;
      logger?.warn?.(JSON.stringify({
        event: MERGE_AGENT_HARNESS_DEFERRAL_EVENT,
        repo: record.repo,
        prNumber: record.prNumber,
        headSha: record.headSha,
        workerClass: record.workerClass,
        provider: record.provider,
        groundedBy: record.groundedBy,
        firstDeferredAt,
        deferralCount: record.deferralCount,
        ageMinutes: Math.floor(ageMs / 60_000),
      }));
    }
    writeFileAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } catch (err) {
    logger?.warn?.(`[merge-agent] could not update harness deferral record ${filePath}: ${err?.message || err}`);
    return null;
  }
}

// The dispatch-record fields that say which class actually ran and why, so an
// operator can see a pinned class was substituted (the closer record's shape).
export function mergeAgentHarnessRecordFields(harness) {
  if (!harness) return { dispatchWorkerClass: null, harness: null };
  return {
    dispatchWorkerClass: harness.workerClass || null,
    harness: {
      fellBack: harness.fellBack === true,
      from: harness.from || null,
      to: harness.to || null,
      provider: harness.provider || null,
      groundedBy: harness.groundedBy || null,
      reason: harness.reason || null,
    },
  };
}

/**
 * @param {object} args
 * @param {string} args.workerClass  The configured merge-agent class.
 * @param {object} [args.deferral]  `{ dir, job, now }`: track a grounded
 *   deferral durably (trackMergeAgentHarnessDeferral). Omitted: no record.
 * @returns {Promise<object>} resolveCloserDispatchHarness's result, plus
 *   `deferred: true` and `reason: 'merge-agent-harness-grounded'` when the
 *   class is grounded and nothing can take its place.
 */
export async function resolveMergeAgentDispatchHarness({
  workerClass,
  env = process.env,
  hqPath,
  execFileImpl,
  logger = console,
  fallbackWorkerClasses = mergeAgentFallbackWorkerClasses(env, { logger }),
  resolveHarnessImpl = resolveCloserDispatchHarness,
  deferral = null,
} = {}) {
  const result = await resolveHarness({
    workerClass, env, hqPath, execFileImpl, logger, fallbackWorkerClasses, resolveHarnessImpl,
  });
  if (!deferral) return result;
  const deferralRecord = trackMergeAgentHarnessDeferral({ ...deferral, harness: result, logger });
  return deferralRecord ? { ...result, deferralRecord } : result;
}

async function resolveHarness({
  workerClass, env, hqPath, execFileImpl, logger, fallbackWorkerClasses, resolveHarnessImpl,
}) {
  let harness;
  try {
    harness = await resolveHarnessImpl({
      workerClass,
      fallbackWorkerClasses,
      hqPath,
      execFileImpl,
      env,
      probeWithoutFallbacks: true,
      screenSoftGroundedFallbacks: true,
    });
  } catch (err) {
    // Fail open, like the closer: a resolver fault is not proof of grounding.
    harness = { workerClass, fellBack: false, reason: 'harness-fallback-resolver-error', error: String(err?.message || err) };
  }
  if (harness?.fellBack === true && harness.workerClass) {
    logger?.warn?.(
      `[merge-agent] harness fallback: ${harness.from} -> ${harness.to} `
        + `(${harness.provider} ${harness.groundedBy || 'hard'}-grounded, state=${harness.primaryState}); `
        + `returns to ${harness.from} when ${harness.provider} recovers`,
    );
    return { ...harness, deferred: false };
  }
  if (harness?.groundedBy) {
    return {
      ...harness,
      workerClass,
      deferred: true,
      reason: MERGE_AGENT_HARNESS_GROUNDED_REASON,
      harnessReason: harness.reason,
    };
  }
  return { ...harness, workerClass, deferred: false };
}
