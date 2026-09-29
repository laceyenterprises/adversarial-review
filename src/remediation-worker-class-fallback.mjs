// Cap-aware remediation worker-class fallback (the remediation-dispatch analogue
// of the AMA closer HHR harness-fallback in ./ama/harness-fallback.mjs).
//
// SEV (2026-08-19): the remediation-worker class is routed by builder-tag writer
// diversity (`pickRemediationWorkerClass`): a [claude-code] PR routes to `codex`
// to remediate. When codex's OpenAI-OAuth quota is EXHAUSTED, that routed codex
// worker cannot spawn — it quota-holds and the PR sits un-remediated (observed on
// #5542 while codex was capped until 2026-08-20). The merge/hammer path already
// auto-falls-back (`roles.adversarial.merge_authority.worker_class_fallback`), but
// the remediation path did not, so an operator had to hand-pin
// `ADVERSARIAL_REVIEW_DEFAULT_REMEDIATOR=claude-code` and un-pin it on recovery.
//
// This module removes the hard-pin churn: when the routed primary harness is
// CAPPED, fall back to the first declared fallback class that is not. It
// AUTO-REVERTS: the check runs on every claim, so the routed primary is used
// again the moment its provider recovers.
//
// REMFALLBACK-01 (SEV3 agent-os#7327, 2026-09-29): AR#859 only recognized a hard
// provider-level ground, so a gpt-6-sol weekly cap — reported as openai
// `unknown` with `model_only_exhaustion` — kept every codex-routed remediation
// respawning codex hourly until the retry budget parked it. "Capped" now means
// any of, and never a guess:
//   - the provider is hard-grounded (exhausted / suspended / grounded);
//   - the routed MODEL is exhausted (its `models[]` row, or the provider's
//     `model_only_exhaustion` signature);
//   - AFH-02 soft-grounds the provider;
//   - the job's own quota hold recorded a provider reset later than one hold
//     window from now (job-local, so it survives an unreadable fleet status).
// Degraded / unknown states alone still do not cap, and an unreadable status
// with no job-local evidence keeps the primary (fail-open, matching HHR).
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

import {
  harnessCapFromStatuses,
  parseHqFleetQuotaStatus,
  providerForQuotaHarness,
} from './fleet-quota-status.mjs';
import { resolveRemediatorFallback } from './role-config.mjs';
import { MAX_QUOTA_HOLD_WINDOW_MS, remediatorQuotaEvidence } from './remediation-quota-evidence.mjs';
import {
  resolveClaudeRemediationModel,
  resolveCodexRemediationModel,
  resolveGeminiRemediationModel,
} from './adapters/agent-runtime/local/remediation.mjs';
import { resolveConfiguredNonBlockingCodexModel } from './adapters/agent-runtime/local/non-blocking-codex-model.mjs';

const execFileAsync = promisify(execFileCb);
const FLEET_QUOTA_STATUS_TIMEOUT_MS = 20_000;

// The fallback chain is declared config (REMFALLBACK-01):
// `roles.remediator_fallback`, schema-registered in the Node, Python and shell
// loaders, with the default in the schema rather than in code. Candidate
// availability is checked against fleet quota before selection, so a grounded
// Claude route can recover on Codex and the normal cross-model route returns
// when Claude recovers. The AR#859 env toggle
// `ADVERSARIAL_REVIEW_REMEDIATOR_WORKER_CLASS_FALLBACK` is an alias of the key;
// `[]` (or an empty env value) disables the fallback.
export function remediationWorkerClassFallback(env = process.env, { topPath, loaderImpl } = {}) {
  return resolveRemediatorFallback({ env, topPath, loaderImpl });
}

function resolveHqPath(env = process.env) {
  return String(env?.AGENT_OS_HQ_BIN || env?.HQ_BIN || 'hq').trim() || 'hq';
}

// Cap state of one remediator class at claim time. Fleet evidence that the
// class is capped wins. Otherwise the job's own quota evidence applies unless a
// good probe landed after that hold was recorded (the cap cleared early). A
// reset inside one hold window does not reroute: the class keeps the job and
// holds until the reset ("a short hold keeps codex").
function classCapState(workerClass, { evidence, statuses, model }) {
  const fleet = statuses ? harnessCapFromStatuses(statuses, { harness: workerClass, model }) : null;
  if (fleet?.capped) {
    return { capped: true, capSource: fleet.capSource, state: fleet.state, model: fleet.model, resetAt: fleet.resetAt, available: false };
  }
  const local = evidence.get(workerClass) || null;
  const clearedByFleet = Boolean(local && fleet?.available)
    && Date.parse(String(fleet.lastGoodAt || '')) > Date.parse(String(local.requeuedAt || ''));
  const state = fleet ? fleet.state : 'unverified';
  if (local && !clearedByFleet) {
    return local.pastHoldWindow
      ? { capped: true, capSource: 'provider-reset-past-hold-window', state, model, resetAt: local.resetAt, available: false }
      : { capped: false, resetsWithinHoldWindow: true, state, model, resetAt: local.resetAt, available: false };
  }
  return { capped: false, state, model, resetAt: null, available: fleet ? fleet.available : null };
}

// A capped class with nothing to take its place is held, never respawned: until
// its reset when that is known and inside one hold window, else for one window.
function holdUntilFor(cap, nowMs) {
  const ceilingMs = nowMs + MAX_QUOTA_HOLD_WINDOW_MS;
  const resetMs = Date.parse(String(cap?.resetAt || ''));
  return new Date(Number.isFinite(resetMs) && resetMs > nowMs ? Math.min(resetMs, ceilingMs) : ceilingMs).toISOString();
}

function modelOf(modelForClass, workerClass) {
  if (typeof modelForClass !== 'function') return null;
  try {
    return modelForClass(workerClass) || null;
  } catch {
    return null;
  }
}

async function readFleetQuotaStatuses({ env, hqPath, execFileImpl }) {
  if (typeof execFileImpl !== 'function') return { statuses: null, error: 'fleet-quota-status-not-wired' };
  try {
    const result = await execFileImpl(hqPath, ['fleet', 'quota', 'status', '--json'], {
      env,
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
      timeout: FLEET_QUOTA_STATUS_TIMEOUT_MS,
    });
    const stdout = typeof result === 'string' ? result : String(result?.stdout || '');
    return { statuses: parseHqFleetQuotaStatus(stdout), error: null };
  } catch (err) {
    // Fail-open: a status we cannot read is not authoritative grounding.
    return { statuses: null, error: String(err?.message || err) };
  }
}

/**
 * @param {Object} args
 * @param {string} args.primary — the routed remediation worker_class (from pickRemediationWorkerClass).
 * @param {string[]=} args.fallbackWorkerClasses — ordered fallback classes (roles.remediator_fallback).
 * @param {Object=} args.job — the claimed job; its quota holds are job-local cap evidence.
 * @param {number=} args.nowMs
 * @param {Function=} args.modelForClass — class → the model it would run, for model-level caps.
 * @param {Object=} args.env
 * @param {string=} args.hqPath
 * @param {Function|null=} args.execFileImpl — DI for `hq fleet quota status --json`;
 *   null skips the fleet read so only job-local evidence applies.
 * @returns {Promise<{ workerClass: string, fellBack: boolean, hold: boolean, reason: string,
 *   from?: string, to?: string, capSource?: string, primaryState?: string, resetAt?: string,
 *   holdUntil?: string, candidateState?: string,
 *   skipped?: Array<{ workerClass: string, reason: string }>, error?: string }>}
 */
export async function resolveRemediationWorkerClassWithFallback({
  primary,
  fallbackWorkerClasses,
  job = null,
  nowMs = Date.now(),
  modelForClass = null,
  env = process.env,
  hqPath = resolveHqPath(env),
  execFileImpl = execFileAsync,
} = {}) {
  const primaryClass = String(primary || '').trim().toLowerCase();
  const fallbacks = [...new Set((Array.isArray(fallbackWorkerClasses) ? fallbackWorkerClasses : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean))];
  const base = { workerClass: primaryClass, fellBack: false, hold: false };

  if (!primaryClass) {
    return { ...base, reason: 'no-fallback-configured' };
  }
  if (!providerForQuotaHarness(primaryClass)) {
    // The routed harness has no tracked provider — we cannot authoritatively
    // ground it, so never fall back (mirrors HHR 'primary-provider-untracked').
    return { ...base, reason: 'primary-provider-untracked' };
  }

  const evidence = remediatorQuotaEvidence(job, { nowMs });
  const { statuses, error } = await readFleetQuotaStatuses({ env, hqPath, execFileImpl });
  // Model lookups only matter against fleet `models[]` rows.
  const capOf = (workerClass) => classCapState(workerClass, {
    evidence,
    statuses,
    model: statuses ? modelOf(modelForClass, workerClass) : null,
  });

  const primaryCap = capOf(primaryClass);
  if (!primaryCap.capped) {
    if (primaryCap.resetsWithinHoldWindow) {
      return {
        ...base,
        hold: true,
        holdUntil: holdUntilFor(primaryCap, nowMs),
        reason: 'primary-resets-within-hold-window',
        capSource: 'provider-reset-within-hold-window',
        primaryState: primaryCap.state,
        resetAt: primaryCap.resetAt,
      };
    }
    const reason = statuses === null
      ? 'fleet-quota-status-unavailable'
      : primaryCap.available ? 'primary-available' : 'primary-not-grounded';
    return {
      ...base,
      reason,
      primaryState: primaryCap.state,
      ...(statuses === null && error ? { error } : {}),
    };
  }

  const skipped = [];
  for (const candidate of fallbacks) {
    if (candidate === primaryClass) continue;
    if (!providerForQuotaHarness(candidate)) {
      skipped.push({ workerClass: candidate, reason: 'provider-untracked' });
      continue;
    }
    const cap = capOf(candidate);
    const refusal = cap.capped
      ? `capped:${cap.capSource}`
      : cap.resetsWithinHoldWindow
        ? 'resets-within-hold-window'
        // A readable fleet status must confirm quota; an unreadable one leaves
        // the candidate unverified, which beats respawning a known-capped primary.
        : statuses && !cap.available ? `unavailable:${cap.state}` : null;
    if (refusal) {
      skipped.push({ workerClass: candidate, reason: refusal });
      continue;
    }
    return {
      workerClass: candidate,
      fellBack: true,
      hold: false,
      from: primaryClass,
      to: candidate,
      reason: 'primary-grounded-fallback',
      capSource: primaryCap.capSource,
      primaryState: primaryCap.state,
      resetAt: primaryCap.resetAt,
      candidateState: statuses ? cap.state : 'unverified',
      skipped,
    };
  }

  // Nothing can take the job. Respawning the capped primary is a guaranteed
  // failure, so the caller holds it instead and re-resolves on the next claim.
  return {
    ...base,
    hold: true,
    holdUntil: holdUntilFor(primaryCap, nowMs),
    reason: fallbacks.some((candidate) => candidate !== primaryClass) ? 'no-available-fallback' : 'no-fallback-configured',
    capSource: primaryCap.capSource,
    primaryState: primaryCap.state,
    resetAt: primaryCap.resetAt,
    skipped,
  };
}

// The model each remediator class would spawn with, for model-level caps.
function remediatorModelForClass(workerClass, { job, env }) {
  if (workerClass === 'codex') {
    return job?.nonBlockingOnly === true
      ? resolveConfiguredNonBlockingCodexModel(env).resolvedModel
      : resolveCodexRemediationModel(env);
  }
  if (workerClass === 'claude-code') return resolveClaudeRemediationModel(env).resolvedModel;
  if (workerClass === 'gemini') return resolveGeminiRemediationModel(env);
  return null;
}

// REMFALLBACK-01 item 2: the consume path's single call. It runs on EVERY claim,
// not only at job creation, so a held job moves to the fallback on its next
// claim. `resolveImpl` is the daemon's fleet-status-aware resolver; without one
// (unit tests, direct callers) only the job's own quota evidence applies.
export async function resolveClaimedRemediatorRouting({
  job,
  primary,
  env = process.env,
  nowMs = Date.now(),
  resolveImpl = null,
  topPath,
  loaderImpl,
  log = console,
} = {}) {
  const resolver = resolveImpl
    || ((args) => resolveRemediationWorkerClassWithFallback({ ...args, execFileImpl: null }));
  const routing = await resolver({
    primary,
    fallbackWorkerClasses: remediationWorkerClassFallback(env, { topPath, loaderImpl }),
    job,
    nowMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
    env,
    modelForClass: (workerClass) => remediatorModelForClass(workerClass, { job, env }),
  });
  if (routing?.fellBack) {
    log.warn?.(
      `[follow-up-remediation] remediation-worker-class cap-fallback: ` +
        `routed=${routing.from} -> ${routing.workerClass} ` +
        `(routed remediator capped: ${routing.capSource || routing.primaryState}` +
        `${routing.resetAt ? `, resets ${routing.resetAt}` : ''}); ` +
        `auto-reverts when the routed harness recovers`
    );
  }
  return routing;
}

// `remediationWorker` audit for a fallback spawn: the class it replaced, why,
// and the candidates passed over. Empty when the routed class runs.
export function remediatorFallbackAudit(routing) {
  if (!routing?.fellBack) return {};
  return {
    fallbackFrom: routing.from,
    fallbackReason: routing.capSource || routing.reason,
    fallbackResolution: {
      reason: routing.reason,
      capSource: routing.capSource || null,
      primaryState: routing.primaryState || null,
      resetAt: routing.resetAt || null,
      candidateState: routing.candidateState || null,
      skipped: routing.skipped || [],
    },
  };
}
