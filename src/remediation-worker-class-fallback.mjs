import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { resolvePooledWorkerRouting } from './worker-token-pool.mjs';
import { FLEET_QUOTA_STATUS_TIMEOUT_MS } from './fleet-quota-status.mjs';
import { selectClaudeAccountLaneFromSnapshot } from './claude-account-routing.mjs';
import { codexWorkerLaneFromSnapshot, isAutomaticCodexAccountPolicy } from './codex-account-routing.mjs';
// LANEFAILOVER-01: automatic Codex claims use the configured account order
// and hold on unknown evidence. Pins/non-Codex retain the cross-model fallback
// contract below, including its job-local evidence and infrastructure repair.
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
//
// Cross-model review stays intact: a fallback remediator writes the commits the
// PR's next round reviews, so a candidate whose model family could review that
// round is skipped, by the same `isCrossModelReviewWaived` rule reviewer
// selection uses to keep a builder from reviewing its own work. The routed
// primary itself (builder-tag route or operator pin) is not second-guessed.
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

import {
  harnessCapFromStatuses,
  parseHqFleetQuotaSnapshot,
  quotaStatusesFromSnapshot,
  providerForQuotaHarness,
} from './fleet-quota-status.mjs';
import { resolveRemediatorFallback, codexWorkerAccountPolicy } from './role-config.mjs';
import { MAX_QUOTA_HOLD_WINDOW_MS, remediatorQuotaEvidence } from './remediation-quota-evidence.mjs';
import {
  resolveClaudeRemediationModel,
  resolveCodexRemediationModel,
  resolveGeminiRemediationModel,
  resolveRemediationModel,
  ensureWorkerRegistryReady,
} from './adapters/agent-runtime/local/remediation.mjs';
import { resolveConfiguredNonBlockingCodexModel } from './adapters/agent-runtime/local/non-blocking-codex-model.mjs';
import {
  isCrossModelReviewWaived,
  normalizeReviewerModel,
  routeSubject,
} from './adapters/subject/github-pr/routing.mjs';

export function normalizeRemediationWorkerClass(workerClassInput) {
  const workerClass = String(workerClassInput || '').trim().toLowerCase();
  if (!workerClass) return null;
  switch (workerClass) {
    case 'remediator-codex':
    case 'remediator-codex-corp':
    case 'remediator-claude':
    case 'remediator-claude-corp':
      return workerClass;
    case 'codex':
    case 'codex-remediation':
      return 'codex';
    case 'claude':
    case 'claude-code':
    case 'claude-code-remediation':
      return 'claude-code';
    case 'gemini':
    case 'gemini-remediation':
      return 'gemini';
    default:
      return null;
  }
}

const execFileAsync = promisify(execFileCb);

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
  const evidenceClass = workerClass === 'remediator-claude' ? 'claude-code' : workerClass;
  const local = evidence.get(evidenceClass) || null;
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
  } catch (error) {
    if (error.code === 'registry-unavailable') throw error;
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
      timeout: loadAwareTimeoutMs(FLEET_QUOTA_STATUS_TIMEOUT_MS),
    });
    const stdout = typeof result === 'string' ? result : String(result?.stdout || '');
    const snapshot = parseHqFleetQuotaSnapshot(stdout);
    return { statuses: quotaStatusesFromSnapshot(snapshot), snapshot, error: null };
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
 * @param {string[]=} args.reviewerModels — models that may review the PR's next round
 *   (nextRoundReviewerModels); a fallback of one of their families is skipped.
 * @param {Object=} args.env
 * @param {'personal-first'|'corporate-first'|'pinned'=} args.codexAccountPolicy — dispatch wrappers preserve operator pins.
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
  ensureWorkerRegistryReadyImpl = ensureWorkerRegistryReady,
  reviewerModels = [],
  env = process.env,
  hqPath = resolveHqPath(env),
  execFileImpl = execFileAsync,
  codexAccountPolicy = 'corporate-first',
  selectAccountImpl,
} = {}) {
  await ensureWorkerRegistryReadyImpl({env});
  modelForClass ??= (workerClass) => remediatorModelForClass(workerClass, { job, env });
  let primaryClass = String(primary || '').trim().toLowerCase();
  const fallbacks = [...new Set((Array.isArray(fallbackWorkerClasses) ? fallbackWorkerClasses : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean))];
  const base = { workerClass: primaryClass, fellBack: false, hold: false };
  const lastInfrastructureRetry = job?.remediationPlan?.retryHistory?.findLast(entry =>
    entry.round === job.remediationPlan.currentRound && entry.retryMetadata?.code === 'infrastructure-refund');
  const preferCrossFamily = Boolean(lastInfrastructureRetry?.retryMetadata?.harnessSpecific
    && (lastInfrastructureRetry.retryMetadata.workerClass === primaryClass
      || (lastInfrastructureRetry.retryMetadata.reason === 'codex-tool-host-unavailable'
        && ['codex', 'remediator-codex'].includes(primaryClass))));
  const pooled = await resolvePooledWorkerRouting({ primary: primaryClass, fallbackWorkerClasses: fallbacks,
    kind: 'remediator', env, modelForClass, reviewerModels, selectAccountImpl, preferCrossFamily,
    infrastructureReason: lastInfrastructureRetry?.retryMetadata?.reason });
  if (pooled) return { ...pooled, ...(pooled.hold ? { holdUntil: holdUntilFor(null, nowMs) } : {}) };

  if (!primaryClass) {
    return { ...base, reason: 'no-fallback-configured' };
  }
  if (!providerForQuotaHarness(primaryClass)) {
    // The routed harness has no tracked provider — we cannot authoritatively
    // ground it, so never fall back (mirrors HHR 'primary-provider-untracked').
    return { ...base, reason: 'primary-provider-untracked' };
  }

  const evidence = remediatorQuotaEvidence(job, { nowMs });
  const { statuses, snapshot, error } = await readFleetQuotaStatuses({ env, hqPath, execFileImpl });
  await ensureWorkerRegistryReadyImpl({env});
  // Model lookups only matter against fleet `models[]` rows.
  const capOf = (workerClass) => classCapState(workerClass, {
    evidence,
    statuses,
    model: statuses ? modelOf(modelForClass, workerClass) : null,
  });

  const automaticCodex = isAutomaticCodexAccountPolicy(codexAccountPolicy)
    && ['codex', 'remediator-codex'].includes(primaryClass);
  const personalCap = automaticCodex ? capOf('codex') : null;
  const corporateCap = automaticCodex ? capOf('remediator-codex-corp') : null;
  const codexAccount = automaticCodex
    ? codexWorkerLaneFromSnapshot(snapshot, {
      workerClass: primaryClass, policy: codexAccountPolicy,
      ...(statuses ? { statuses } : {}), model: modelOf(modelForClass, primaryClass),
      // Only job-local exhaustion supplements the shared selector. Re-projecting
      // fleet caps here would turn stale quota into fresh exhaustion evidence.
      personalExhausted: personalCap.capSource === 'provider-reset-past-hold-window'
        || personalCap.resetsWithinHoldWindow === true,
      corporateExhausted: corporateCap.capSource === 'provider-reset-past-hold-window'
        || corporateCap.resetsWithinHoldWindow === true,
    }) : null;
  if (codexAccount?.hold || (codexAccount && codexAccount.workerClass !== primaryClass)) {
    return { ...base, ...codexAccount,
      fellBack: codexAccount.workerClass !== primaryClass, from: primaryClass, to: codexAccount.workerClass,
      ...(codexAccount.hold ? { holdUntil: holdUntilFor(null, nowMs) } : {}),
    };
  }
  if (codexAccount) Object.assign(base, codexAccount);

  const accountLane = (name) => snapshot ? selectClaudeAccountLaneFromSnapshot(snapshot, {
    statuses,
    blockedWorkerClasses: ['remediator-claude', 'remediator-claude-corp'].filter(name => capOf(name).capped),
    workerClass: ['claude', 'claude-code'].includes(name) ? 'remediator-claude' : name,
    model: modelOf(modelForClass, name),
  }) : null;
  const primaryAccount = accountLane(primaryClass);
  if (primaryAccount?.reason === 'claude-account-evidence-unknown'
    || (!snapshot && primaryClass === 'remediator-claude-corp')) {
    return { ...base, hold: true, holdUntil: holdUntilFor(null, nowMs),
      reason: primaryAccount?.reason || 'fleet-quota-status-unavailable' };
  }
  if (primaryAccount && !primaryAccount.hold) {
    primaryClass = primaryAccount.workerClass;
    Object.assign(base, { workerClass: primaryClass, fellBack: primaryClass !== primary,
      from: primary, to: primaryClass });
  }
  const primaryCap = primaryAccount?.hold
    ? { ...capOf(primaryClass), capped: true, available: false, capSource: primaryAccount.reason }
    : capOf(primaryClass);
  const lastRetry = job?.remediationPlan?.retryHistory?.findLast((entry) =>
    entry.round === job.remediationPlan.currentRound && entry.retryMetadata?.code === 'infrastructure-refund');
  const infrastructureFallback = lastRetry?.retryMetadata?.code === 'infrastructure-refund'
    && lastRetry.retryMetadata.harnessSpecific
    && (lastRetry.retryMetadata.workerClass === primaryClass
      || (lastRetry.retryMetadata.reason === 'codex-tool-host-unavailable'
        && ['codex', 'remediator-codex-corp'].includes(primaryClass)));
  if (!primaryCap.capped && (!infrastructureFallback || primaryCap.resetsWithinHoldWindow)) {
    if (primaryCap.resetsWithinHoldWindow) {
      return {
        ...base,
        hold: true,
        holdUntil: holdUntilFor(primaryCap, nowMs),
        reason: 'primary-resets-within-hold-window',
        capSource: 'provider-reset-within-hold-window',
        primaryState: primaryCap.state,
        model: primaryCap.model || null,
        resetAt: primaryCap.resetAt,
      };
    }
    const reason = statuses === null
      ? 'fleet-quota-status-unavailable'
      : primaryCap.available ? 'primary-available' : 'primary-not-grounded';
    return {
      ...base,
      reason: base.reason || reason,
      primaryState: primaryCap.state,
      ...(statuses === null && error ? { error } : {}),
    };
  }

  const skipped = [];
  for (let candidate of fallbacks) {
    if (candidate === primaryClass) continue;
    const account = accountLane(candidate);
    if (account?.hold) {
      skipped.push({ workerClass: candidate, reason: account.reason });
      continue;
    }
    if (account) candidate = account.workerClass;
    if (!providerForQuotaHarness(candidate)) {
      skipped.push({ workerClass: candidate, reason: 'provider-untracked' });
      continue;
    }
    const ownReviewer = (Array.isArray(reviewerModels) ? reviewerModels : [])
      .find((reviewerModel) => isCrossModelReviewWaived(candidate, reviewerModel));
    // The corporate twin continues the routed Codex writer; it inherits the
    // primary's diversity decision rather than introducing a new writer family.
    const corporateContinuation = candidate === 'remediator-codex-corp'
      && ['codex', 'remediator-codex'].includes(primaryClass);
    if (ownReviewer && !corporateContinuation) {
      skipped.push({ workerClass: candidate, reason: `reviews-next-round:${ownReviewer}` });
      continue;
    }
    const cap = capOf(candidate);
    if (candidate === 'remediator-codex-corp' && cap.available !== true) {
      skipped.push({ workerClass: candidate, reason: `unavailable:${cap.state}` });
      continue;
    }
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
      reason: infrastructureFallback ? 'infrastructure-fallback' : 'primary-grounded-fallback',
      capSource: infrastructureFallback ? lastRetry.retryMetadata.reason : primaryCap.capSource,
      primaryState: primaryCap.state,
      resetAt: primaryCap.resetAt,
      candidateState: statuses ? cap.state : 'unverified',
      skipped,
    };
  }

  // Infrastructure fallback is a preference. An uncapped primary may have
  // recovered; never create a quota hold solely because its harness failed.
  if (infrastructureFallback && !primaryCap.capped && !primaryCap.resetsWithinHoldWindow) {
    return { ...base, reason: 'infrastructure-fallback-unavailable', primaryState: primaryCap.state, skipped };
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
    model: primaryCap.model || null,
    resetAt: primaryCap.resetAt,
    skipped,
  };
}

// REMFALLBACK-01 item 4: the models that may review this PR's next round. That
// is the reviewer of the round being remediated (which already reflects any
// reviewer fallback in force, e.g. gemini while codex is capped), plus the
// route reviewer selection gives the PR's builder, with and without its primary
// reviewer quota-capped (the gemini fallback layer).
export function nextRoundReviewerModels(job, { env = process.env, topPath, loaderImpl } = {}) {
  const models = new Set();
  const add = (value) => {
    const model = normalizeReviewerModel(value);
    if (model) models.add(model);
  };
  add(job?.reviewerModel);
  const builderClass = String(job?.builderTag || '').trim().toLowerCase();
  for (const primaryReviewerQuotaCapped of builderClass ? [false, true] : []) {
    try {
      add(routeSubject(
        { builderClass, domainId: job?.domainId || 'code-pr' },
        { env, topPath, loaderImpl, primaryReviewerQuotaCapped },
      )?.reviewerModel);
    } catch {
      // A broken reviewer route leaves the recorded reviewer as the constraint.
    }
  }
  return [...models];
}

// The model each remediator class would spawn with, for model-level caps.
function remediatorModelForClass(workerClass, { job, env }) {
  if (['codex', 'remediator-codex', 'remediator-codex-corp'].includes(workerClass)) {
    return job?.nonBlockingOnly === true
      ? resolveConfiguredNonBlockingCodexModel(env).resolvedModel
      : workerClass === 'remediator-codex'
        ? resolveRemediationModel(workerClass, { env, fallbackModel: null }).resolvedModel
        : resolveCodexRemediationModel(env);
  }
  if (workerClass === 'remediator-claude') return resolveRemediationModel(workerClass, { env, fallbackModel: null }).resolvedModel;
  if (['claude-code', 'remediator-claude-corp'].includes(workerClass)) return resolveClaudeRemediationModel(env).resolvedModel;
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
  ensureWorkerRegistryReadyImpl = ensureWorkerRegistryReady,
  topPath,
  loaderImpl,
  log = console,
} = {}) {
  const resolver = resolveImpl
    || ((args) => resolveRemediationWorkerClassWithFallback({ ...args, execFileImpl: null }));
  let accountPolicy = resolveImpl
    ? codexWorkerAccountPolicy('roles.remediator', primary, { env, topPath, loaderImpl }) : 'pinned';
  if (isAutomaticCodexAccountPolicy(accountPolicy)
    && !['codex', 'claude-code', 'clio-agent'].includes(String(job?.builderTag || '').trim().toLowerCase())) {
    accountPolicy = codexWorkerAccountPolicy('roles.registry.remediator.workerClass', primary, { env, topPath, loaderImpl });
  }
  await ensureWorkerRegistryReadyImpl({env});
  const routing = await resolver({
    primary,
    codexAccountPolicy: accountPolicy,
    ensureWorkerRegistryReadyImpl,
    fallbackWorkerClasses: remediationWorkerClassFallback(env, { topPath, loaderImpl }),
    job,
    nowMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
    env,
    modelForClass: (workerClass) => remediatorModelForClass(workerClass, { job, env }),
    reviewerModels: nextRoundReviewerModels(job, { env, topPath, loaderImpl }),
  });
  if (routing?.fellBack && !routing.authPath) {
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
// and the candidates passed over. Pooled proposals are diagnostic only; the
// dispatcher's account receipt, rather than this preflight, identifies the run.
export function remediatorFallbackAudit(routing) {
  const proposal = routing?.pooled ? { accountProposal: {
    identity: routing.identity, tokenAccountId: routing.tokenAccountId || null,
    brokerProvider: routing.brokerProvider || null, reason: routing.reason,
    evidenceGeneration: routing.evidenceGeneration || null,
  } } : {};
  if (!routing?.fellBack) return proposal;
  return {
    ...proposal,
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
