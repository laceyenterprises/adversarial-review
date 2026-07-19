// ARC-18 (cluster 19): the reviewer spawn/settle state machine, extracted
// verbatim from watcher.mjs. This is the core reviewer state machine —
// spawnReviewer + the gated pipeline entry point + settleReviewerAttempt +
// evaluateRoundBudgetForReview — plus the cluster-exclusive outage-signal and
// log-preview helpers those functions call. The two shared mutable session
// collections live in ./reviewer-session-registry.mjs so this cluster and the
// fence/sigterm cluster mutate the same live references.
//
// Threading/re-derivation (never import from watcher.mjs):
//  - ROOT / ADVERSARIAL_REVIEW_STATE_DIR / REVIEWER_LEASE_RECOVERY_ENABLED /
//    INFRA_AUTO_RECOVER_CAP are re-derived here from the same inputs
//    (config.json + reviewer-lease defaults).
//  - resolveReviewerIdentity + REVIEWER_IDENTITY_BY_BOT_TOKEN_ENV and the
//    QUOTA_EXHAUSTED_BACKOFF_MS resolver stay in watcher (still used there /
//    exported) and are re-derived here as byte-identical copies.
//  - WATCHER_PRIMARY_DOMAIN_ID stays in watcher and is threaded: spawnReviewer's
//    `domainId` default is null and pollOnce always passes domainId.
//  - markWatcherReviewHeartbeat stays in watcher (references the mutable
//    watcherHeartbeat singleton and is used elsewhere) and is threaded into
//    settleReviewerAttempt as the injected `markReviewHeartbeat` param.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { reviewerRuntimeState } from './reviewer-runtime-adapter.mjs';
import {
  inFlightReviewerSessions,
  activeReviewerSpawns,
} from './reviewer-session-registry.mjs';
import {
  resolveAgyReviewerSubprocessTimeoutMs,
  resolveReviewerTimeoutMs,
} from './reviewer-timeout.mjs';
import { resolveGeminiRuntime } from './role-config.mjs';
import {
  beginReviewerPass,
  completeReviewerPass,
  readBestReviewerEvidenceTokenUsage,
  tagTokenUsage,
} from './reviewer-pass-tokens.mjs';
import { writeReviewerTokenUsageArtifactBestEffort } from './reviewer-runtime-support.mjs';
import {
  deleteSpawnRecord,
  resolveAdversarialReviewStateDir,
  upsertSpawnRecord,
} from './reviewer-fence.mjs';
import { loadRoleRegistry } from './role-registry.mjs';
import { resolveDomainPipeline } from './domain-pipeline.mjs';
import { runGatedReviewPipeline } from './watcher-review-pipeline.mjs';
import {
  db,
  stmtUpdatePipelineStageStates,
  stmtMarkPosted,
  stmtMarkFailed,
  stmtReleaseReviewLease,
  stmtMarkFailedQuota,
  stmtReleaseReviewLeaseQuota,
  stmtMarkOutageTransient,
  stmtMarkCascadeFailed,
  stmtMarkPendingUpstream,
  stmtGetReviewRow,
} from './review-state-db.mjs';
import { resolveReviewCycleCapConfig } from './review-cycle-cap.mjs';
import { loadConfigCached } from './config-loader.mjs';
import { recordSuccessfulReviewCycleVerdict } from './review-cycle-cap-actions.mjs';
import {
  clearCascadeState,
  formatTransientFailureBreakdown,
  recordCascadeFailure,
} from './reviewer-cascade.mjs';
import { PROVIDER_OVERLOADED_FAILURE_CLASS } from './adapters/reviewer-runtime/cli-direct/classification.mjs';
import { QUOTA_EXHAUSTED_FAILURE_CLASS, resolveQuotaResetIso } from './quota-exhaustion.mjs';
import {
  resolveRoundBudgetForJob,
  summarizePRRemediationLedger,
} from './follow-up-jobs.mjs';
import {
  DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS,
  resolveReviewerLeaseRecoveryEnabled,
} from './reviewer-lease.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADVERSARIAL_REVIEW_STATE_DIR = resolveAdversarialReviewStateDir(ROOT, process.env);
// ARC-18: REVIEWER_LEASE_RECOVERY_ENABLED and INFRA_AUTO_RECOVER_CAP remain
// watcher module consts referenced elsewhere in watcher.mjs; they are re-derived
// here from the same inputs (config.json + reviewer-lease defaults) so this leaf
// module avoids a src->watcher circular import while preserving their values.
const REVIEWER_LEASE_RECOVERY_ENABLED = resolveReviewerLeaseRecoveryEnabled({
  watcherConfig: JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')),
});
const INFRA_AUTO_RECOVER_CAP = DEFAULT_REVIEWER_LEASE_RECOVERY_MAX_ATTEMPTS;

// ARC-18: resolveReviewerIdentity + its identity map stay in watcher (still used
// there and exported); re-derived here as a byte-identical copy for spawnReviewer.
const REVIEWER_IDENTITY_BY_BOT_TOKEN_ENV = Object.freeze({
  GH_CLAUDE_REVIEWER_TOKEN: 'claude-reviewer-lacey',
  GH_CODEX_REVIEWER_TOKEN: 'codex-reviewer-lacey',
  GH_GEMINI_REVIEWER_TOKEN: 'gemini-reviewer-lacey',
});

function resolveReviewerIdentity({ reviewerModel, botTokenEnv } = {}) {
  if (REVIEWER_IDENTITY_BY_BOT_TOKEN_ENV[botTokenEnv]) {
    return REVIEWER_IDENTITY_BY_BOT_TOKEN_ENV[botTokenEnv];
  }
  const normalizedModel = String(reviewerModel || '').trim().toLowerCase();
  if (normalizedModel === 'codex') return 'codex-reviewer-lacey';
  if (normalizedModel === 'gemini') return 'gemini-reviewer-lacey';
  return 'claude-reviewer-lacey';
}

// ARC-18: QUOTA_EXHAUSTED_BACKOFF_MS stays in watcher (used at the pollOnce
// quota-hold path) and is exported; re-derived here as a byte-identical copy for
// resolveReviewerOutageSignal + settleReviewerAttempt.
const DEFAULT_QUOTA_EXHAUSTED_BACKOFF_MS = 15 * 60 * 1000;
function resolveQuotaExhaustedBackoffMs(env = process.env) {
  const raw = env.ADVERSARIAL_QUOTA_EXHAUSTED_FALLBACK_BACKOFF_MS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_QUOTA_EXHAUSTED_BACKOFF_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_QUOTA_EXHAUSTED_BACKOFF_MS;
  return Math.floor(parsed);
}
const QUOTA_EXHAUSTED_BACKOFF_MS = resolveQuotaExhaustedBackoffMs();

// LAC-545: head+tail preview for diagnostic log lines. For short payloads
// (under 800 chars) emit verbatim; for longer ones, the first 400 +
// `…<truncated N chars>…` + last 400. Newlines are collapsed to a single
// space so the line stays grep-able. The intent is to surface enough of
// codex's actual output to a) classify the failure mode and b) feed the
// sanitizer's rejection signature back into a real fix.
function previewLogText(text, { head = 400, tail = 400 } = {}) {
  const normalized = String(text ?? '').replace(/\r?\n+/g, ' ').trim();
  if (!normalized) return '<empty>';
  if (normalized.length <= head + tail) return normalized;
  const elided = normalized.length - head - tail;
  return `${normalized.slice(0, head)} …<truncated ${elided} chars>… ${normalized.slice(-tail)}`;
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    return { __unreadableJson: true };
  }
}

function mainCatchupOutageSignal({ env = process.env } = {}) {
  const hqRoot = env.HQ_ROOT || env.AGENT_OS_HQ_ROOT || join(homedir(), 'agent-os-hq');
  const state = readJsonFile(join(hqRoot, 'main-catchup', '.state.json'));
  if (!state || typeof state !== 'object') return null;
  if (state.__unreadableJson) {
    return { reason: 'deploy-wedge', detail: 'state-unreadable', retryAfter: null };
  }
  const freezeClass = state.freezeClass
    || state.pendingFreeze?.freezeClass
    || state.pendingPgSchemaGateFreeze?.freezeClass
    || state.pendingRecovery?.freezeClass
    || null;
  if (freezeClass) {
    return { reason: 'deploy-wedge', detail: String(freezeClass), retryAfter: null };
  }
  if (
    state.currentState === 'frozen' ||
    state.currentState === 'deploy-freeze' ||
    state.pendingPgSchemaGateFreeze ||
    state.pendingPgSchemaSelfHeal ||
    state.pendingRecovery?.classification?.freezeClass
  ) {
    return { reason: 'deploy-wedge', detail: String(state.currentState || 'main-catchup-freeze'), retryAfter: null };
  }
  return null;
}

function classifyOutageText(text) {
  const lower = String(text || '').toLowerCase();
  if (
    /\boauth[-_ ]?broker\b|\bbroker\b/.test(lower) &&
    (
      /\b(?:econnrefused|econnreset|etimedout|eai_again|enotfound)\b/.test(lower) ||
      /connection (?:refused|reset|timed out|aborted)/.test(lower) ||
      /fetch failed|body timeout|broker returned http 5\d\d|broker.*unavailable|shared secret.*unavailable/.test(lower)
    )
  ) {
    return { reason: 'broker-unavailable', detail: 'reviewer-token-broker-unavailable' };
  }
  if (
    /\b(?:gh|github|api\.github\.com|graphql)\b/.test(lower) &&
    (
      /\b(?:econnrefused|econnreset|etimedout|eai_again|enotfound)\b/.test(lower) ||
      /connection (?:refused|reset|timed out|aborted)/.test(lower) ||
      /tls handshake|temporary failure|temporarily unavailable|network is unreachable/.test(lower) ||
      /\bhttp\s*5\d\d\b|service unavailable|gateway timeout|secondary rate limit|too many requests/.test(lower)
    )
  ) {
    return { reason: 'github-unavailable', detail: 'github-unavailable' };
  }
  return null;
}

function resolveReviewerOutageSignal({
  failureClass,
  fullOutput = '',
  failureAt,
  env = process.env,
  nowMs = Date.now(),
  quotaResetIso = null,
} = {}) {
  const failureAtMs = Date.parse(failureAt || '');
  const anchorMs = Number.isNaN(failureAtMs) ? nowMs : failureAtMs;
  if (failureClass === QUOTA_EXHAUSTED_FAILURE_CLASS) {
    return {
      active: true,
      reason: 'quota-outage',
      failureClass,
      retryAfter: quotaResetIso || new Date(anchorMs + QUOTA_EXHAUSTED_BACKOFF_MS).toISOString(),
      quotaResetIso,
    };
  }
  const textSignal = classifyOutageText(fullOutput);
  if (textSignal) {
    return {
      active: true,
      failureClass: textSignal.reason,
      retryAfter: new Date(anchorMs + 5 * 60_000).toISOString(),
      ...textSignal,
    };
  }
  const deploySignal = mainCatchupOutageSignal({ env });
  if (deploySignal) {
    return {
      ...deploySignal,
      active: true,
      failureClass: 'deploy-wedge',
      retryAfter: deploySignal.retryAfter || new Date(anchorMs + 5 * 60_000).toISOString(),
    };
  }
  return { active: false, reason: null, failureClass: null, retryAfter: null, quotaResetIso: null };
}

// ── Reviewer spawning ────────────────────────────────────────────────────────

async function spawnReviewer({
  repo,
  prNumber,
  reviewerModel,
  botTokenEnv,
  linearTicketId,
  labels = [],
  builderTag,
  reviewerHeadSha,
  reviewAttemptNumber,
  reviewDbAttemptNumber,
  completedRemediationRounds,
  passKind = 'first-pass',
  maxRemediationRounds,
  advisoryFindings = [],
  reviewerSessionUuid,
  reviewerTimeoutMs = resolveReviewerTimeoutMs(),
  workspacePath = null,
  crossModelReviewWaived = false,
  crossModelReviewWaiverReason = null,
  onReviewerPgid = () => {},
  domainId = null, // ARC-18: WATCHER_PRIMARY_DOMAIN_ID stays in watcher; threaded by callers (pollOnce always passes domainId in spawnReviewerArgs). Default is never read.
  reviewerRuntimeAdapterOverride = null,
}) {
  const activeReviewerRuntimeAdapter = reviewerRuntimeAdapterOverride || reviewerRuntimeState.adapter;
  const finalRound = (
    Number.isFinite(reviewAttemptNumber) &&
    Number.isFinite(maxRemediationRounds) &&
    reviewAttemptNumber > maxRemediationRounds
  );
  const roundLabel = Number.isFinite(reviewAttemptNumber)
    ? ` attempt=${reviewAttemptNumber}/${1 + Number(maxRemediationRounds || 0)}${finalRound ? ' [FINAL — lenient threshold]' : ''}`
    : '';
  console.log(`[watcher] Spawning reviewer for ${repo}#${prNumber} (model: ${reviewerModel})${roundLabel}`);

  const reviewerSpawnToken = randomUUID();
  const reviewerIdentity = resolveReviewerIdentity({ reviewerModel, botTokenEnv });
  const spawnRecord = {
    spawnToken: reviewerSpawnToken,
    repo,
    pr: prNumber,
    identity: reviewerIdentity,
    botTokenEnv,
    reviewerSessionUuid,
    spawnedAt: new Date().toISOString(),
  };
  try {
    activeReviewerSpawns.set(reviewerSpawnToken, spawnRecord);
    upsertSpawnRecord(ADVERSARIAL_REVIEW_STATE_DIR, spawnRecord);
    inFlightReviewerSessions.add(reviewerSessionUuid);
    const startedAt = new Date().toISOString();
    beginReviewerPass(ROOT, {
      repo,
      prNumber,
      attemptNumber: reviewDbAttemptNumber ?? reviewAttemptNumber ?? 0,
      reviewerClass: reviewerModel,
      reviewerModel,
      passKind,
      workspacePath: workspacePath || ROOT,
      startedAt,
      // LAC-1559: record the head this pass reviewed so the completed-rereview
      // budget counter keys per (repo, pr, head) — a head move re-arms review.
      headSha: reviewerHeadSha || null,
      metadata: {
        reviewerSessionUuid,
        reviewerModel,
        reviewAttemptNumber,
        completedRemediationRounds,
        maxRemediationRounds,
      },
    });

    // The reviewer-runtime adapter (LAC-563) owns the spawn contract:
    // canonical OAuth env-strip, atomic run-state records, process-group
    // isolation, failure classification. The `forbiddenFallbacks` arg is
    // additive opt-in beyond the canonical 8-env set the adapter always
    // strips when `oauthStripEnforced: true`.
    const effectiveReviewerTimeoutMs = (
      String(reviewerModel || '').toLowerCase() === 'gemini' &&
      resolveGeminiRuntime({ env: process.env }) === 'antigravity'
    )
      ? resolveAgyReviewerSubprocessTimeoutMs(process.env, { reviewerTimeoutMs })
      : reviewerTimeoutMs;

    const result = await activeReviewerRuntimeAdapter.spawnReviewer({
      model: reviewerModel,
      prompt: '',
      subjectContext: {
        domainId,
        repo,
        prNumber,
        reviewerModel,
        botTokenEnv,
        linearTicketId,
        labels,
        builderTag,
        reviewerHeadSha,
        reviewAttemptNumber,
        reviewDbAttemptNumber,
        completedRemediationRounds,
        maxRemediationRounds,
        advisoryFindings,
        reviewerSessionUuid,
        reviewerSpawnToken,
        crossModelReviewWaived,
        crossModelReviewWaiverReason,
      },
      timeoutMs: effectiveReviewerTimeoutMs,
      sessionUuid: reviewerSessionUuid,
      forbiddenFallbacks: ['api-key', 'anthropic-api-key'],
      onReviewerPgid,
    });
    if (result.stdoutTail) console.log(`[reviewer:${prNumber}] ${String(result.stdoutTail).trim()}`);
    if (result.stderrTail) console.error(`[reviewer:${prNumber}] stderr: ${String(result.stderrTail).trim()}`);
    try {
      const endedAt = new Date().toISOString();
      const tokenUsage = tagTokenUsage(result.tokenUsage || readBestReviewerEvidenceTokenUsage({
        adapterSessionKey: result.reattachToken || reviewerSessionUuid,
        sessionKeys: [
          reviewerSessionUuid,
          result.reattachToken,
          result.sessionUuid,
        ],
        workspacePath: workspacePath || ROOT,
        startedAt,
        endedAt,
        reviewerModel,
        rootDir: ROOT,
      }), 'guardrail');
      let reviewerTokenUsageArtifact = null;
      if (tokenUsage) {
        reviewerTokenUsageArtifact = writeReviewerTokenUsageArtifactBestEffort({
          workspacePath: workspacePath || ROOT,
          repo,
          prNumber,
          attemptNumber: reviewDbAttemptNumber ?? reviewAttemptNumber ?? 0,
          passKind,
          reviewerClass: reviewerModel,
          reviewerModel,
          status: result.ok ? 'completed' : (result.failureClass === 'cancelled' ? 'cancelled' : 'failed'),
          startedAt,
          endedAt,
          tokenUsage,
          source: tokenUsage?.source || null,
          metadata: {
            reviewerSessionUuid,
            reattachToken: result.reattachToken || null,
          },
        }, { repo, prNumber, reviewerSessionUuid });
      }
      completeReviewerPass(ROOT, {
        repo,
        prNumber,
        attemptNumber: reviewDbAttemptNumber ?? reviewAttemptNumber ?? 0,
        passKind,
        status: result.ok ? 'completed' : (result.failureClass === 'cancelled' ? 'cancelled' : 'failed'),
        endedAt,
        tokenUsage,
        tokenSource: tokenUsage?.source || 'unknown',
        metadata: {
          reviewerSessionUuid,
          reattachToken: result.reattachToken || null,
          failureClass: result.failureClass || null,
          tokenUsageNoUsageReason: result.tokenUsageNoUsageReason || null,
          reviewerTokenUsageArtifact,
        },
      });
    } catch (err) {
      console.warn(
        `[watcher] reviewer_pass_token_update_failed repo=${repo} pr=${prNumber} ` +
        `session=${reviewerSessionUuid}: ${err?.message || err}`
      );
    }
    return result;
  } catch (err) {
    try {
      const tokenUsage = err?.tokenUsage && typeof err.tokenUsage === 'object'
        ? tagTokenUsage(err.tokenUsage, 'guardrail')
        : null;
      completeReviewerPass(ROOT, {
        repo,
        prNumber,
        attemptNumber: reviewDbAttemptNumber ?? reviewAttemptNumber ?? 0,
        passKind,
        status: 'failed',
        endedAt: new Date().toISOString(),
        tokenUsage,
        tokenSource: tokenUsage?.source || null,
        metadata: {
          reviewerSessionUuid,
          reviewerModel,
          tokenUsageNoUsageReason: tokenUsage
            ? null
            : (err?.tokenUsageNoUsageReason || null),
          error: err?.message || String(err),
        },
      });
    } catch (settleErr) {
      console.warn(
        `[watcher] reviewer_pass_token_update_failed repo=${repo} pr=${prNumber} ` +
        `session=${reviewerSessionUuid}: ${settleErr?.message || settleErr}`
      );
    }
    throw err;
  } finally {
    inFlightReviewerSessions.delete(reviewerSessionUuid);
    activeReviewerSpawns.delete(reviewerSpawnToken);
    deleteSpawnRecord(ADVERSARIAL_REVIEW_STATE_DIR, reviewerSpawnToken);
  }
}

// ARC-13: the gated two-stage pipeline entry point invoked from the review-drive
// seam when `domains/<id>.json` sets `pipeline.enabled: true` (default OFF). It
// loads the role registry (only reached on the enabled path — boot stays
// roster-free otherwise), compiles the domain's pipeline, drives each stage
// through the same `spawnReviewer` the v1 path uses (per-stage prompt set
// selected by the stage role's `promptSet`-named domain), and posts the Win 2
// rollup through a github-pr-comments adapter. It returns a `spawnReviewer`-
// shaped result so the caller's unchanged settle/round-budget/hammer accounting
// treats the pipeline pass exactly like a single review.
async function runWatcherGatedReviewPipeline({
  domainConfig,
  domainId,
  repoPath,
  prNumber,
  reviewerHeadSha,
  riskClass,
  reviewAttemptNumber,
  spawnReviewerArgs,
  stageStates = [],
}) {
  const roleRegistry = loadRoleRegistry({ env: process.env });
  const resolvedPipeline = resolveDomainPipeline(domainConfig, { roleRegistry });
  // Lazy-import the comms adapter: statically importing it at the top of
  // watcher.mjs forms a module cycle (comms → pr-comments → follow-up-jobs →
  // watcher) that breaks a named binding when the watcher loads first. This path
  // only runs on the enabled gate, so a dynamic import here is free of that cost.
  const { createGitHubPRCommentsAdapter } = await import('./adapters/comms/github-pr-comments/index.mjs');
  const comms = createGitHubPRCommentsAdapter({
    rootDir: ROOT,
    env: process.env,
    workerClass: spawnReviewerArgs.reviewerModel,
    // Post the aggregate rollup under the reviewer's own bot identity.
    resolveGhToken: () => ({ tokenEnvName: spawnReviewerArgs.botTokenEnv }),
  });
  const rollupDeliveryKey = {
    domainId,
    subjectExternalId: `${repoPath}#${prNumber}`,
    revisionRef: reviewerHeadSha,
    round: Number.isFinite(reviewAttemptNumber) ? reviewAttemptNumber : 0,
    // A distinct delivery kind so the aggregate rollup never collides with the
    // per-stage review deliveries the reviewer runtime records under `review`.
    kind: 'pipeline-rollup',
  };
  const result = await runGatedReviewPipeline({
    resolvedPipeline,
    stageStates,
    currentRevisionRef: reviewerHeadSha,
    riskClass,
    observedAt: new Date().toISOString(),
    spawnReviewer,
    spawnReviewerArgs,
    comms,
    rollupDeliveryKey,
  });
  // Persist every completed driver pass, including pending ones, so retries at
  // the same revision retain clean upstream verdicts and resume downstream.
  stmtUpdatePipelineStageStates.run(
    JSON.stringify(result.pipeline.stageStates), repoPath, prNumber,
  );
  return result;
}

function parsePipelineStageStates(value) {
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function settleReviewerAttempt({
  rootDir = ROOT,
  repoPath,
  prNumber,
  result,
  failureAt = new Date().toISOString(),
  maxRemediationRounds,
  leaseRecoveryEnabled = REVIEWER_LEASE_RECOVERY_ENABLED,
  statements = {
    markPosted: stmtMarkPosted,
    markFailed: stmtMarkFailed,
    releaseReviewLease: stmtReleaseReviewLease,
    markFailedQuota: stmtMarkFailedQuota,
    releaseReviewLeaseQuota: stmtReleaseReviewLeaseQuota,
    markOutageTransient: stmtMarkOutageTransient,
    markCascadeFailed: stmtMarkCascadeFailed,
    markPendingUpstream: stmtMarkPendingUpstream,
    getReviewRow: stmtGetReviewRow,
  },
  log = console,
  // ARC-18: markWatcherReviewHeartbeat stays in watcher (it closes over the
  // mutable watcherHeartbeat singleton and is used elsewhere); threaded in here.
  // The no-op default matches production behavior when the heartbeat is unset.
  markReviewHeartbeat = () => {},
}) {
  if (result.ok) {
    const postedAt = new Date().toISOString();
    statements.markPosted.run(postedAt, repoPath, prNumber);
    markReviewHeartbeat({ repo: repoPath, pr_number: prNumber, posted_at: postedAt });
    try {
      const currentRow = typeof statements.getReviewRow?.get === 'function'
        ? statements.getReviewRow.get(repoPath, prNumber)
        : null;
      const { windowHours } = resolveReviewCycleCapConfig({
        loadConfigImpl: loadConfigCached,
        logger: log,
      });
      recordSuccessfulReviewCycleVerdict({
        db,
        repoPath,
        prNumber,
        headSha: currentRow?.reviewer_head_sha || null,
        postedAt,
        result,
        windowHours,
        logger: log,
      });
    } catch (err) {
      log?.warn?.(
        `[watcher] review-cycle-count bookkeeping skipped for ${repoPath}#${prNumber}: ${err?.message || err}`
      );
    }
    clearCascadeState(rootDir, { repo: repoPath, prNumber });
    return;
  }

  const failureClass = result.failureClass || 'unknown';

  // LAC-545: every reviewer failure now logs its captured stderr/stdout
  // with the failure class. Previously these were swallowed by the
  // classifier — the silent-stall on every `[claude-code]` PR codex
  // reviewer attempt was invisible until forensic instrumentation got
  // bolted on. Mirror the success-path `[reviewer:<N>] stderr: ...`
  // shape so success and failure produce parallel diagnostic lines.
  const failureStderrText = String(result.stderr || '').trim();
  const failureStdoutText = String(result.stdout || '').trim();
  if (failureStderrText) {
    log.warn(
      `[reviewer:${prNumber}] stderr (failure-class=${failureClass}): ${previewLogText(failureStderrText)}`
    );
  }
  if (failureStdoutText) {
    log.warn(
      `[reviewer:${prNumber}] stdout (failure-class=${failureClass}): ${previewLogText(failureStdoutText)}`
    );
  }

  const transientFailureClasses = new Set([
    'cascade',
    'reviewer-timeout',
    'launchctl-bootstrap',
    'daemon-bounce',
    PROVIDER_OVERLOADED_FAILURE_CLASS,
  ]);
  const defaultFailureMessages = {
    cascade: 'Reviewer hit a LiteLLM/upstream cascade failure; watcher backoff engaged.',
    [PROVIDER_OVERLOADED_FAILURE_CLASS]: 'Reviewer hit a provider/backend overload (HTTP 529 or capacity signal); watcher backoff engaged.',
    'quota-exhausted': 'Reviewer hit a hard provider usage cap; holding until the cap window clears (HRR graceful degradation).',
    'reviewer-timeout': 'Reviewer command timed out before posting; watcher backoff engaged.',
    'launchctl-bootstrap': 'Claude launchctl session bootstrap failed; watcher backoff engaged.',
    'daemon-bounce': 'Reviewer runtime could not reattach after daemon bounce; watcher backoff engaged.',
    bug: 'Reviewer failed due to an invocation or implementation bug.',
    unknown: 'Unknown reviewer failure',
  };
  const failureMessage = String(result.error || '').trim() || defaultFailureMessages[failureClass] || defaultFailureMessages.unknown;
  const classifiedMessage = `[${failureClass}] ${failureMessage}`;
  if (transientFailureClasses.has(failureClass)) {
    if (typeof statements.getReviewRow?.get !== 'function') {
      throw new Error('settleReviewerAttempt requires statements.getReviewRow.get for transient infra cap enforcement');
    }
    const currentRow = statements.getReviewRow.get(repoPath, prNumber);
    const infraRecoverAttempts = Number(currentRow?.infra_auto_recover_attempts || 0);
    const cascadeState = recordCascadeFailure(rootDir, {
      repo: repoPath,
      prNumber,
      failedAt: failureAt,
      failureClass,
    });
    if (infraRecoverAttempts >= INFRA_AUTO_RECOVER_CAP) {
      statements.markCascadeFailed.run(
        failureAt,
        `${classifiedMessage}; infra auto-recovery cap exhausted (${infraRecoverAttempts}/${INFRA_AUTO_RECOVER_CAP}).`,
        repoPath,
        prNumber
      );
      log.warn(
        `[watcher] Reviewer ${failureClass} failure on #${prNumber} exhausted infra auto-recovery cap ` +
        `(${infraRecoverAttempts}/${INFRA_AUTO_RECOVER_CAP}); leaving terminal evidence for operator inspection`
      );
      return;
    }
    statements.markPendingUpstream.run(failureAt, classifiedMessage, repoPath, prNumber);
    const breakdown = formatTransientFailureBreakdown(cascadeState.transientFailureBreakdown);
    log.warn(
      `[watcher] PR #${prNumber} marked pending-upstream after ${cascadeState.consecutiveTransientFailures} transient reviewer failures (${breakdown}); ` +
      `infra auto-recovery ${infraRecoverAttempts + 1}/${INFRA_AUTO_RECOVER_CAP}; will resume when the reviewer lane recovers`
    );
    log.warn(
      `[watcher] Reviewer ${failureClass} failure on #${prNumber} (consecutiveTransient=${cascadeState.consecutiveTransientFailures}); backing off ${cascadeState.backoffMinutes}m`
    );
    return;
  }

  const fullFailureOutput = [result.error, result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n');
  const failureAtMs = Date.parse(failureAt);
  const quotaResetIso = failureClass === QUOTA_EXHAUSTED_FAILURE_CLASS
    ? resolveQuotaResetIso(fullFailureOutput, {
      nowMs: Number.isNaN(failureAtMs) ? null : failureAtMs,
    })
    : null;
  const outageSignal = resolveReviewerOutageSignal({
    failureClass,
    fullOutput: fullFailureOutput,
    failureAt,
    quotaResetIso,
  });
  if (outageSignal.active) {
    if (failureClass === QUOTA_EXHAUSTED_FAILURE_CLASS && !quotaResetIso) {
      log.warn(
        `[watcher] Quota-exhausted reviewer failure on #${prNumber} with NO parseable provider reset time; ` +
          `falling back to the ${Math.round(QUOTA_EXHAUSTED_BACKOFF_MS / 60000)}m default hold window`
      );
    }
    recordCascadeFailure(rootDir, {
      repo: repoPath,
      prNumber,
      failedAt: failureAt,
      failureClass: outageSignal.failureClass || outageSignal.reason,
      nextRetryAfter: outageSignal.retryAfter,
    });
    statements.markOutageTransient.run(
      failureAt,
      `[outage-transient:${outageSignal.reason}] ${classifiedMessage}`,
      quotaResetIso,
      repoPath,
      prNumber
    );
    const updatedOutageRow = statements.getReviewRow.get(repoPath, prNumber);
    log.warn(
      `[watcher] Reviewer failure on #${prNumber} coincided with ${outageSignal.reason}; ` +
        `paused until ${outageSignal.retryAfter || 'next healthy poll'} without charging attempt budget ` +
        `(attempts=${updatedOutageRow?.review_attempts ?? 'unknown'})`
    );
    return;
  }
  clearCascadeState(rootDir, { repo: repoPath, prNumber });
  const terminalFailureStatement = leaseRecoveryEnabled
    ? statements.releaseReviewLease
    : statements.markFailed;
  terminalFailureStatement.run(failureAt, classifiedMessage, repoPath, prNumber);
  const updatedRow = statements.getReviewRow.get(repoPath, prNumber);
  if (failureClass === 'bug') {
    log.warn(
      `[watcher] Reviewer bug-class failure on #${prNumber} (attempt ${updatedRow.review_attempts}/${1 + Number(maxRemediationRounds || 0)})`
    );
  } else {
    log.warn(
      `[watcher] Reviewer unknown-class failure on #${prNumber}; counting against attempt budget (${updatedRow.review_attempts}/${1 + Number(maxRemediationRounds || 0)})`
    );
  }
}

function evaluateRoundBudgetForReview({
  rootDir = ROOT,
  repo,
  prNumber,
  linearTicketId,
  reviewStatus,
  reviewAttempts = 0,
  log = console.log,
}) {
  // Convergence loop, post-2026-05-06:
  // The rereview is ALWAYS allowed to fire after a remediation round —
  // the cap on the convergence loop lives on the *remediation* side
  // (`claimNextFollowUpJob` refuses when `currentRound >= maxRounds`),
  // not on the *rereview* side. Rationale: the reviewer's verdict is
  // the only signal that can replace a stale `Request changes`, so
  // skipping the rereview after remediation strands the PR even when
  // the remediator addressed the findings. The previous gate
  // (round-budget-exhausted) hid converged remediations behind a
  // halt-without-rereview state — exactly what the 2026-05-06 PR #267
  // verification surfaced.
  //
  // This function is retained (and still returns the round-counters
  // for caller observability) so the callsite shape is unchanged.
  if (reviewStatus !== 'pending' || Number(reviewAttempts) <= 0) {
    return { skip: false };
  }

  const ledger = summarizePRRemediationLedger(rootDir, { repo, prNumber });
  const resolution = resolveRoundBudgetForJob({
    linearTicketId,
    riskClass: ledger.latestRiskClass,
  }, { rootDir });
  const latestMaxRoundsValue = ledger.latestMaxRounds;
  const latestMaxRounds = Number(latestMaxRoundsValue);
  const hasLatestMaxRounds = latestMaxRoundsValue !== null && latestMaxRoundsValue !== undefined;
  const roundBudget = hasLatestMaxRounds &&
    Number.isInteger(latestMaxRounds) &&
    latestMaxRounds > resolution.roundBudget
    ? latestMaxRounds
    : resolution.roundBudget;

  return {
    skip: false,
    completedRoundsForPR: ledger.completedRoundsForPR,
    roundBudget,
    riskClass: resolution.riskClass,
  };
}

export {
  spawnReviewer,
  runWatcherGatedReviewPipeline,
  parsePipelineStageStates,
  settleReviewerAttempt,
  evaluateRoundBudgetForReview,
};
