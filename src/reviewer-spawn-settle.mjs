import { buildReviewerAttribution } from './reviewer-attribution.mjs';
import { readCorporateCodexQuotaCooldown, recordCorporateCodexQuotaCooldown } from './codex-account-routing.mjs';
import { readReviewerEvidenceInWorker } from './reviewer-token-ledger-lookup.mjs';
import { openReviewStateDb } from './review-state.mjs';
import { reviewerCredentialKey, recordCorporateClaudeQuotaCooldown } from './claude-account-routing.mjs';
import { resolveHqRoot } from './hq-root.mjs';
import { REVIEWER_BUILD_ID } from './reviewer-timeout-budget.mjs';
import { selectReviewerTokenAccount, updateReviewerTokenLease, recordReviewerAccountQuotaFailure } from './reviewer-token-pool.mjs';
import { journalReviewerTokenLease, forgetReviewerTokenLease, markReviewerTokenLeaseActive } from './reviewer-token-leases.mjs';
import { readReviewerRunRecord, TERMINAL_RUN_STATES } from './adapters/reviewer-runtime/run-state.mjs';
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
import { deliverAlert } from './alert-delivery.mjs';
import { parseReviewerModelUnavailable } from './adapters/reviewer-runtime/cli-direct/classification.mjs';
import { randomUUID } from 'node:crypto';
import { parseReviewerQuotaExhaustion } from './reviewer-quota-signal.mjs';
import { startGeminiQuotaCooldown } from './gemini-quota-cooldown.mjs';
import { readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { reviewerRuntimeState } from './reviewer-runtime-adapter.mjs';
import {
  inFlightReviewerSessions,
  activeReviewerSpawns,
} from './reviewer-session-registry.mjs';
import {
  resolveGeminiReviewerProcessTimeoutMs,
  resolveReviewerTimeoutMs,
} from './reviewer-timeout.mjs';
import {
  CODEX_BUILDER_REVIEW_REFUSAL, reviewerRefusesBuilder, isCrossModelReviewWaived, normalizeReviewerModel,
} from './adapters/subject/github-pr/routing.mjs';
import { resolveRemediationModel } from './adapters/agent-runtime/local/remediation.mjs';
import { loadRoleConfig, resolveGeminiRuntime } from './role-config.mjs';
import {
  AGY_IDENTITY_UNAVAILABLE_FAILURE_CLASS,
  getAgyReviewerIdentityPool,
  runWithAgyReviewerIdentity,
  readReviewerGeminiQuotaCooldown,
  readReviewerGeminiPoolAvailability,
} from './agy-reviewer-identities.mjs';
import {
  isGroundedProviderState,
  harnessCapFromStatuses,
  parseHqFleetQuotaStatus,
  providerForQuotaHarness,
} from './fleet-quota-status.mjs';
import {
  beginReviewerPass,
  completeReviewerPass,
  normalizeReviewerClass,
  nextReviewerPassAttemptNumber,
  tagTokenUsage,
} from './reviewer-pass-tokens.mjs';
import { writeReviewerTokenUsageArtifactBestEffort } from './reviewer-runtime-support.mjs';
import {
  deleteSpawnRecord,
  resolveAdversarialReviewStateDir,
  upsertSpawnRecord,
} from './reviewer-fence.mjs';
import { loadRoleRegistry } from './role-registry.mjs';
import { resolveRoleRegistryFromDomain } from './domain-policy.mjs';
import { isPipelineEnabled, resolveDomainPipeline } from './domain-pipeline.mjs';
import { runGatedReviewPipeline } from './watcher-review-pipeline.mjs';
import {
  db,
  stmtUpdatePipelineStageStates,
  stmtMarkPosted,
  stmtReleaseUnsettledPostedReview,
  stmtMarkFailed,
  stmtReleaseReviewLease,
  stmtMarkFailedQuota,
  stmtReleaseReviewLeaseQuota,
  stmtMarkOutageTransient,
  stmtMarkReviewerCredentialOutage,
  stmtPromoteReviewerCredentialOutage,
  stmtRearmReviewerCredentialOutage,
  stmtMarkCascadeFailed,
  stmtMarkPendingUpstream,
  stmtMarkTokenRefreshHold,
  stmtGetReviewRow,
  stmtReleaseReviewerClaim,
  stmtReleaseLegacyStaleReviewerClaim,
} from './review-state-db.mjs';
import { fetchPullRequestHeadAndState } from './github-api.mjs';
import { isTransientGhError } from './gh-cli.mjs';
import { resolveReviewCycleCapConfig } from './review-cycle-cap.mjs';
import { loadConfigCached } from './config-loader.mjs';
import { recordSuccessfulReviewCycleVerdict } from './review-cycle-cap-actions.mjs';
import { withSqliteBusyRetry, withSqliteBusyRetrySync } from './sqlite-busy-retry.mjs';
import {
  clearCascadeState,
  clearReviewerCredentialOutage,
  formatTransientFailureBreakdown,
  recordCascadeFailure,
  recordReviewerCredentialFailure,
  recordTokenRefreshHold,
  shouldPauseReviewerModel,
  releaseReviewerCredentialProbe,
} from './reviewer-cascade.mjs';
import {
  PROVIDER_OVERLOADED_FAILURE_CLASS,
  REVIEWER_EMPTY_OUTPUT_FAILURE_CLASS,
  ATTESTATION_SIGN_FAILED_FAILURE_CLASS,
  HCP_UNAVAILABLE_FAILURE_CLASS,
  TOKEN_REFRESH_PENDING_FAILURE_CLASS,
} from './adapters/reviewer-runtime/cli-direct/classification.mjs';
import { INFRA_RUNTIME_MISSING_LIBRARY_FAILURE_CLASS } from './runtime-missing-library.mjs';
import { QUOTA_EXHAUSTED_FAILURE_CLASS, resolveQuotaResetIso } from './quota-exhaustion.mjs';
import { classifyGitHubReviewCreateFailure } from './reviewer-failure-classification.mjs';
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
const REVIEWER_LEDGER_LOOKUP_DELAYS_MS = Object.freeze([25, 75]);
const REVIEW_POST_FRESHNESS_RETRY_DELAYS_MS = Object.freeze([100, 250]);

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

function resolveReviewerQuotaCheckEnabled(env = process.env) {
  return loadRoleConfig({
    env,
    contextKey: 'reviewer.quota_check_enabled',
  }).get('reviewer.quota_check_enabled', true);
}

function resolveReviewerQuotaStatusDir(env = process.env) {
  const configured = loadRoleConfig({
    env,
    contextKey: 'reviewer.quota_status_dir',
  }).get('reviewer.quota_status_dir', null);
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  const hqRoot = resolveHqRoot(env);
  return join(hqRoot, 'quota');
}

async function readReviewerQuotaDecision({
  reviewerModel,
  codexBrokerProvider = 'codex',
  claudeBrokerProvider = 'claude-code',
  env = process.env,
  readdirImpl = readdir,
  readFileImpl = readFile,
} = {}) {
  try {
    if (!resolveReviewerQuotaCheckEnabled(env)) {
      return { available: true, state: 'disabled', provider: null };
    }
    const provider = providerForQuotaHarness(reviewerModel);
    if (!provider) {
      return { available: true, state: 'unknown-harness', provider: null };
    }

    const statusDir = resolveReviewerQuotaStatusDir(env);
    const files = await readdirImpl(statusDir);
    const statuses = [];
    for (const file of files) {
      if (!file.startsWith(`${provider}-`) || !file.endsWith('.status.json')) continue;
      const authPath = file.slice(provider.length + 1, -'.status.json'.length);
      try {
        const payload = JSON.parse(await readFileImpl(join(statusDir, file), 'utf8'));
        statuses.push({
          ...payload,
          provider,
          authPath: String(payload?.authPath || payload?.auth_path || authPath).trim().toLowerCase(),
          state: String(payload?.state || '').trim().toLowerCase(),
        });
      } catch {
        // A malformed or transiently unreadable record is ambiguous. Keep
        // looking for a valid record; if none exists, the decision fails open.
      }
    }
    const corporateAccount = reviewerModel === 'codex'
      ? codexBrokerProvider === 'codex-corp'
      : normalizeReviewerModel(reviewerModel) === 'claude' && claudeBrokerProvider === 'claude-code-corp';
    const accountAuthPath = corporateAccount ? 'oauth-corp' : 'oauth';
    const accountStatuses = statuses.filter((entry) => corporateAccount
      ? entry.authPath === accountAuthPath : entry.authPath !== 'oauth-corp');
    const status = accountStatuses.find((entry) => entry.authPath === accountAuthPath) || accountStatuses[0];
    if (!status) {
      return { available: true, state: 'missing-provider-status', provider };
    }
    const cap = harnessCapFromStatuses(parseHqFleetQuotaStatus(JSON.stringify({ providerStatuses: accountStatuses })), {
      harness: corporateAccount ? (reviewerModel === 'codex' ? 'codex-corp' : 'claude-reviewer-corp') : reviewerModel,
      model: reviewerModel === 'codex'
        ? resolveRemediationModel('codex-reviewer', { env, pin: env.CODEX_MODEL_ID || null, fallbackModel: null }).resolvedModel
        : null,
    });
    return { available: !cap.capped, capped: cap.capped, state: cap.state, resetAt: cap.resetAt, provider };
  } catch {
    return {
      available: true,
      state: 'probe-error',
      provider: providerForQuotaHarness(reviewerModel),
    };
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyLedgerLookupError(err) {
  const message = `${String(err?.code || '')}\n${String(err?.message || err || '')}`.toLowerCase();
  if (message.includes('sqlite_busy') || message.includes('database is locked') || message.includes('database is busy')) {
    return 'sqlite-busy';
  }
  if (message.includes('sqlite_locked')) return 'sqlite-locked';
  return 'lookup-failed';
}

function isTransientLedgerLookupError(err) {
  return ['sqlite-busy', 'sqlite-locked'].includes(classifyLedgerLookupError(err));
}

async function readReviewerLedgerEvidenceWithRetry({
  readImpl,
  args,
  sleepImpl = sleepMs,
  delaysMs = REVIEWER_LEDGER_LOOKUP_DELAYS_MS,
} = {}) {
  let lastError = null;
  let lastUsage = null;
  let attempts = 0;
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    attempts += 1;
    try {
      const usage = await readImpl(args);
      if (usage) {
        lastUsage = usage;
        if (!args?.launchRequestId || usage.workerRunId) {
          return { usage, attempts, lastError: null };
        }
      }
      lastError = 'worker-run-not-yet-visible';
    } catch (err) {
      lastError = classifyLedgerLookupError(err);
      if (!isTransientLedgerLookupError(err)) break;
    }
    if (attempt < delaysMs.length) await sleepImpl(delaysMs[attempt]);
  }
  return { usage: lastUsage, attempts, lastError };
}

async function fetchReviewerPostFreshnessWithRetry({
  fetchImpl,
  repo,
  prNumber,
  sleepImpl = sleepMs,
  delaysMs = REVIEW_POST_FRESHNESS_RETRY_DELAYS_MS,
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return await fetchImpl(repo, prNumber);
    } catch (err) {
      lastError = err;
      if (!isTransientGhError(err) || attempt >= delaysMs.length) throw err;
      await sleepImpl(delaysMs[attempt]);
    }
  }
  throw lastError;
}

function readDurableReviewerPostedAt({ rootDir = ROOT, repo, prNumber, reviewerHeadSha, reviewerModel, attemptNumber, passKind }) {
  const stateDb = rootDir === ROOT ? db : openReviewStateDb(rootDir);
  try {
    return stateDb.prepare(`SELECT body_captured_at FROM reviewer_passes
      WHERE repo = ? AND pr_number = ? AND head_sha = ? AND reviewer_model = ?
      AND attempt_number = ? AND pass_kind = ? AND gh_comment_id IS NOT NULL
      AND gh_comment_id <> ''`).get(
      repo, prNumber, reviewerHeadSha, reviewerModel, attemptNumber, passKind,
    )?.body_captured_at;
  } finally {
    if (stateDb !== db) stateDb.close();
  }
}

async function defaultPostGitHubReviewWithCapture(args) {
  const { postGitHubReviewWithCapture } = await import('./reviewer.mjs');
  return postGitHubReviewWithCapture(args);
}

function shouldPostAdapterReviewBody(result) {
  return result?.reviewBodyDelivery === 'caller-post';
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

function resultWithGitHubPostFailure(result, err) {
  const detail = [err?.message, err?.stdout, err?.stderr]
    .filter(Boolean)
    .join('\n')
    .trim();
  return {
    ...result,
    ok: false,
    failureClass: 'review-post',
    stderrTail: previewLogText([result?.stderrTail, detail].filter(Boolean).join('\n')),
    stdoutTail: result?.stdoutTail || null,
    error: detail || err?.message || String(err),
  };
}

function formatFailureDiagnosticText(result = {}) {
  const sections = [];
  const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : null;
  const signal = typeof result.signal === 'string' && result.signal.trim()
    ? result.signal.trim()
    : null;
  if (exitCode !== null || signal) {
    sections.push(`exit: code=${exitCode === null ? 'unknown' : exitCode}${signal ? ` signal=${signal}` : ''}`);
  }
  const stderr = String(result.stderr || result.stderrTail || '').trim();
  const stdout = String(result.stdout || result.stdoutTail || '').trim();
  if (stderr) sections.push(`stderr tail:\n${stderr}`);
  if (stdout) sections.push(`stdout tail:\n${stdout}`);
  return sections.join('\n').trim();
}

function appendFailureDiagnostics(message, result = {}) {
  const base = String(message || '').trim();
  const diagnostics = formatFailureDiagnosticText(result);
  if (!diagnostics) return base;
  const combined = [base, diagnostics].filter(Boolean).join('\n');
  return truncateCodePoints(combined, 12000);
}

function truncateCodePoints(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return Array.from(text).slice(0, maxLength).join('');
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
  const hqRoot = resolveHqRoot(env);
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
  // RTOK-01: a rejected GitHub credential is a FLEET-WIDE auth outage, not this
  // PR's reviewer failing. The reviewer's bot token is a broker-minted GitHub
  // App installation token that GitHub expires after one hour; when the watcher
  // process outlives its mint, every `gh` call it makes returns 401 for every PR
  // simultaneously. `gh-cli.mjs` now forces a re-mint and retries once, so
  // reaching here means the credential is still rejected AFTER a fresh mint.
  //
  // Before this branch that failure carried no recognizable class, fell through
  // to the terminal path, and was logged as "Reviewer unknown-class failure on
  // #NNNN; counting against attempt budget (3/4)" -- so a single auth outage
  // permanently burned the retry budget of every PR the watcher touched while it
  // lasted (PRs #6366-#6370, stranded with zero reviews). Routing it through the
  // outage signal holds the PR at `pending-upstream` WITHOUT charging
  // review_attempts, exactly as a provider quota outage is held, so the PRs
  // resume on their own once the credential recovers.
  //
  // Deliberately narrow. It requires BOTH a GitHub context token AND an explicit
  // rejected-credential signal, so an ordinary review failure -- including a
  // reviewer that merely mentions a number -- still counts against the budget as
  // it always has. 403 is excluded: on a valid token that is a permissions or
  // rate-limit signal, not an expired credential.
  if (
    /\b(?:gh|github|api\.github\.com|graphql|github-auth-outage)\b/.test(lower) &&
    (
      /\bbad credentials\b/.test(lower) ||
      /\bhttp\s*401\b/.test(lower) ||
      /\b401\b[^\n]*\bunauthorized\b/.test(lower) ||
      /\brequires authentication\b/.test(lower) ||
      /\bgithub-auth-outage\b/.test(lower)
    )
  ) {
    return { reason: 'github-auth-outage', detail: 'github-auth-outage' };
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
  env = null,
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
  const deploySignal = env ? mainCatchupOutageSignal({ env }) : null;
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

function recordGeminiQuotaCooldown({ rootDir, env, result, identityUser, pool }) {
  // Typed runtime evidence owns classification; text only supplies the reset.
  const diagnostic = [result.error, result.stderr, result.stderrTail].filter(Boolean).join('\n');
  const signal = parseReviewerQuotaExhaustion({ stderr: diagnostic });
  signal.resetAt ||= resolveQuotaResetIso(diagnostic);
  // Key the record by the pool's configured HQ owner, the same name every
  // reader uses, rather than the OS account that happens to run this process.
  const hqOwner = configuredHqOwner(pool);
  return startGeminiQuotaCooldown({ rootDir, env, signal, identityUser, ...(hqOwner ? { hqOwner } : {}) });
}

function configuredHqOwner(pool) {
  try {
    return pool?.plan?.()?.hqOwner || null;
  } catch {
    return null;
  }
}

async function spawnReviewer(args) {
  if (reviewerRefusesBuilder(args.builderTag, args.reviewerModel)) return spawnReviewerOnceWithAccount(args);
  if (normalizeReviewerModel(args.reviewerModel) !== 'gemini') return spawnReviewerOnce(args);
  const rootDir = args.rootDir || ROOT;
  const env = args.quotaCheckEnv || args.env || process.env;
  const fallback = args.geminiQuotaFallbackRoute;
  const canFallback = fallback && !fallback.quotaBlocked && normalizeReviewerModel(fallback.reviewerModel) !== 'gemini';
  const runFallback = async (quotaResult = null) => {
    const credentialKey = reviewerCredentialKey(fallback.reviewerModel, args.claudeAccountSelection?.provider);
    const gate = shouldPauseReviewerModel(rootDir, credentialKey);
    if (gate.paused) {
      // Keep the triggering quota hold (and both retry budgets) while the
      // fallback credential is held. Do not manufacture an OAuth failure.
      if (quotaResult) args.onPostOperationSettled?.(quotaResult);
      return quotaResult || {
        ok: false,
        failureClass: QUOTA_EXHAUSTED_FAILURE_CLASS,
        effectiveReviewerModel: args.reviewerModel,
        error: `Gemini quota cooldown active; ${fallback.reviewerModel} credential outage hold`,
      };
    }
    let runtimeStarted = false;
    try {
      const reviewerSessionUuid = randomUUID();
      // Transfer the durable claim before any fallback process can post.
      await args.onGeminiQuotaFallback?.({ ...fallback, reviewerSessionUuid });
      return await spawnReviewerOnce({
        ...args,
        reviewerSessionUuid,
        pipelineGeminiSeats: 0,
        reviewerModel: fallback.reviewerModel,
        botTokenEnv: fallback.botTokenEnv,
        codexBrokerProvider: fallback.codexBrokerProvider || 'codex',
        afhReviewerFallback: fallback.afhReviewerFallback || null,
        crossModelReviewWaived: isCrossModelReviewWaived(args.builderTag, fallback.reviewerModel),
        crossModelReviewWaiverReason: fallback.crossModelReviewWaiverReason || null,
        // The Gemini row is terminal by now. Allocate only a ledger attempt;
        // the logical review/remediation round and delivery claim stay intact.
        ...(quotaResult ? {
          reviewDbAttemptNumber: nextReviewerPassAttemptNumber(rootDir, {
            repo: args.repo,
            prNumber: args.prNumber,
            passKind: args.passKind || 'first-pass',
            fallbackReviewAttempts: args.reviewDbAttemptNumber ?? args.reviewAttemptNumber ?? 0,
          }),
        } : {}),
        onReviewerRuntimeStarted: () => { runtimeStarted = true; args.onReviewerRuntimeStarted?.(); },
      });
    } finally {
      if (gate.probe && !runtimeStarted) {
        releaseReviewerCredentialProbe(rootDir, credentialKey, gate);
      }
    }
  };
  if (canFallback && readReviewerGeminiQuotaCooldown({
    rootDir, env, pool: args.agyReviewerIdentityPool || getAgyReviewerIdentityPool(),
    adapter: args.reviewerRuntimeAdapterOverride || reviewerRuntimeState.adapter,
  })) {
    return runFallback();
  }
  const result = await spawnReviewerOnce({
    ...args,
    onPostOperationSettled: (result) => {
      if (!result.ok && (result.failureClass === 'reviewer-model-unavailable'
        || (canFallback && result.failureClass === QUOTA_EXHAUSTED_FAILURE_CLASS))) return;
      args.onPostOperationSettled?.(result);
    },
  });
  if (!result.ok && result.failureClass === 'reviewer-model-unavailable') {
    const diagnostic = [result.error, result.stderr, result.stderrTail].filter(Boolean).join('\n');
    const detail = result.failureDetail || parseReviewerModelUnavailable(diagnostic) || { refusedModel: 'unknown', availableModels: [] };
    console.warn(`[watcher] reviewer-model-unavailable: ${diagnostic}`);
    try {
      await (args.deliverAlertImpl || deliverAlert)(
        `Adversarial reviewer model refused: ${detail.refusedModel}\nAvailable models:\n${detail.availableModels.join('\n')}\nUpdate the configured reviewer model.`,
        { event: 'reviewer.model_unavailable', payload: detail, env: args.env || process.env },
      );
    } catch (error) {
      console.warn(`[watcher] Failed to queue model-unavailable alert: ${error.message}`);
    }
    if (canFallback) return runFallback(result);
    args.onPostOperationSettled?.(result);
    return result;
  }
  if (!result.ok && result.failureClass === QUOTA_EXHAUSTED_FAILURE_CLASS) {
    // The runtime owns classification. Text here is used only to recover a
    // reset timestamp after typed quota evidence, never to select fallback.
    recordGeminiQuotaCooldown({
      rootDir, env, result, identityUser: result.agyIdentityUser,
      pool: args.agyReviewerIdentityPool || getAgyReviewerIdentityPool(),
    });
    if (canFallback) {
      console.info(`[watcher] reviewer-selection ${args.repo}#${args.prNumber} → ${fallback.reviewerModel} (Gemini quota exhausted; immediate fallback)`);
      return runFallback(result);
    }
    return result;
  }
  return result;
}

async function spawnReviewerOnce(args) {
  const log = args.log || args.logger || console;
  const recordArmFallback = reason => {
    try { log.info?.(`[watcher] osg-reviewer reason=${reason}`); } catch {}
  };
  // Family eligibility precedes account admission, including direct callers.
  if (reviewerRefusesBuilder(args.builderTag, args.reviewerModel)) return spawnReviewerOnceWithAccount(args);
  const sessionUuid = args.reviewerSessionUuid || randomUUID();
  const env = args.quotaCheckEnv || process.env;
  const arm = args.reviewerArm?.harness === normalizeReviewerModel(args.reviewerModel) ? args.reviewerArm : null;
  const runtimeId = (args.reviewerRuntimeAdapterOverride || reviewerRuntimeState.adapter)?.describe?.()?.id;
  const defaultArgs = () => {
    const route = args.reviewerArmDefaultRoute;
    return { ...args, reviewerSessionUuid: sessionUuid, reviewerArm: null, reviewerArmDefaultRoute: null,
      ...(route ? { reviewerModel: route.reviewerModel, botTokenEnv: route.botTokenEnv,
        codexBrokerProvider: route.codexBrokerProvider || 'codex', claudeAccountSelection: null } : {}) };
  };
  const runDefault = async () => {
    const next = defaultArgs();
    if (arm && next.reviewerModel !== args.reviewerModel) {
      await args.onReviewerArmFallback?.({ reviewerModel: next.reviewerModel,
        codexBrokerProvider: next.codexBrokerProvider, reviewerSessionUuid: sessionUuid });
    }
    return spawnReviewer(next);
  };
  if (arm && runtimeId !== 'cli-direct') {
    recordArmFallback('runtime-unsupported');
    return runDefault();
  }
  let receipt;
  try {
    receipt = await (args.selectReviewerTokenAccountImpl || selectReviewerTokenAccount)({
      reviewerModel: args.reviewerModel, requestId: sessionUuid, acquire: true, env,
      rootDir: args.rootDir || ROOT,
      ...(arm ? { model: arm.model } : {}),
    });
  } catch (error) {
    if (!arm) throw error;
    recordArmFallback('error-account-unavailable');
    return runDefault();
  }
  if (arm && (receipt?.hold || !receipt?.lease || receipt.tokenAccountId !== arm.account)) {
    if (receipt?.lease) {
      try {
        await (args.updateReviewerTokenLeaseImpl || updateReviewerTokenLease)(receipt, 'release', { env, rootDir: args.rootDir || ROOT });
      } catch { recordArmFallback('error-account-release'); }
    }
    recordArmFallback('account-changed');
    return runDefault();
  }
  if (receipt?.hold) {
    const result = { ok: false, failureClass: 'reviewer-account-held',
      effectiveReviewerModel: args.reviewerModel, reviewerSessionUuid: sessionUuid,
      error: receipt.reason };
    args.onPostOperationSettled?.(result);
    return result;
  }
  const rootDir = args.rootDir || ROOT;
  if (receipt) {
    try { journalReviewerTokenLease(rootDir, sessionUuid, receipt.identity, receipt.lease); }
    catch (error) {
      try { await (args.updateReviewerTokenLeaseImpl || updateReviewerTokenLease)(receipt, 'release', { env }); }
      catch { console.warn('[watcher] reviewer account release unavailable after journal write failure'); }
      throw error;
    }
  }
  if (receipt && !(args.accountBindingRuntimeIds || ['cli-direct', 'acpx']).includes(runtimeId)) {
    // These runtimes do not yet carry an execution binding to their credential
    // owner. Never claim the selected token was used by an unbound dispatch.
    try {
      await (args.updateReviewerTokenLeaseImpl || updateReviewerTokenLease)(receipt, 'release', { env, rootDir });
      forgetReviewerTokenLease(rootDir, sessionUuid);
    } catch { console.warn('[watcher] reviewer account release unavailable for unsupported runtime; journal retained'); }
    const result = { ok: false, failureClass: 'reviewer-account-held', effectiveReviewerModel: args.reviewerModel,
      reviewerSessionUuid: sessionUuid, error: 'reviewer-runtime-account-binding-unsupported' };
    args.onPostOperationSettled?.(result);
    return result;
  }
  if (receipt) {
    args = { ...args, reviewerSessionUuid: sessionUuid, reviewerAccountReceipt: receipt,
      ...(normalizeReviewerModel(args.reviewerModel) === 'claude'
        ? { claudeAccountSelection: receipt } : { codexBrokerProvider: receipt.provider }) };
  }
  const corporateClaude = normalizeReviewerModel(args.reviewerModel) === 'claude'
    && args.claudeAccountSelection?.provider === 'claude-code-corp';
  const withAccount = result => ({ ...result,
    ...(corporateClaude ? { claudeBrokerProvider: 'claude-code-corp' } : {}),
    ...(receipt ? { reviewerAccountReceipt: receipt } : {}),
  });
  let renewal = Promise.resolve();
  const updateLease = async operation => {
    const value = await (args.updateReviewerTokenLeaseImpl || updateReviewerTokenLease)(receipt, operation, { env, rootDir });
    if (operation === 'release') forgetReviewerTokenLease(rootDir, sessionUuid);
    return value;
  };
  if (receipt) markReviewerTokenLeaseActive(rootDir, sessionUuid, true);
  const timer = receipt ? setInterval(() => {
    renewal = renewal.then(() => updateLease('renew')).catch(() => {
      console.warn('[watcher] reviewer account lease renewal unavailable; retaining original binding');
    });
  }, 60_000) : null;
  try {
    const result = withAccount(await spawnReviewerOnceWithAccount({ ...args,
      onReviewerPgid: pgid => {
        if (receipt) {
          try { journalReviewerTokenLease(rootDir, sessionUuid, receipt.identity, receipt.lease, pgid); }
          catch { console.warn('[watcher] reviewer lease PGID journal write unavailable; retaining acquisition intent'); }
        }
        args.onReviewerPgid?.(pgid);
      },
      ...(args.onPostOperationSettled ? {
        onPostOperationSettled: result => args.onPostOperationSettled(withAccount(result)),
      } : {}),
    }));
    // Adapter resolution confirms process drain. An exception is uncertain and
    // deliberately retains occupancy for recovery/operator inspection.
    if (receipt) {
      clearInterval(timer);
      await renewal;
      try {
        const record = readReviewerRunRecord(args.rootDir || ROOT, sessionUuid);
        // Duplicate spawn/reattach responses can resolve while the original
        // process is still active. Retain its global slot in that case.
        if (!record || TERMINAL_RUN_STATES.has(record.state)) await updateLease('release');
      }
      catch { console.warn('[watcher] reviewer account lease release unavailable; retaining receipt for recovery'); }
    }
    return result;
  } finally {
    if (timer) clearInterval(timer);
    if (receipt) markReviewerTokenLeaseActive(rootDir, sessionUuid, false);
  }
}

async function spawnReviewerOnceWithAccount({
  repo,
  prNumber,
  reviewerModel,
  botTokenEnv,
  linearTicketId,
  labels = [],
  builderTag,
  branch = null,
  reviewerHeadSha,
  reviewAttemptNumber,
  reviewDbAttemptNumber,
  completedRemediationRounds,
  passKind = 'first-pass',
  dispatchPassKind = passKind,
  pipelineGeminiSeats = 0,
  maxRemediationRounds,
  advisoryFindings = [],
  reviewerSessionUuid,
  reviewerTimeoutMs = resolveReviewerTimeoutMs(),
  workspacePath = null,
  rootDir = ROOT,
  crossModelReviewWaived = false,
  crossModelReviewWaiverReason = null,
  afhReviewerFallback = null,
  codexBrokerProvider = 'codex',
  claudeAccountSelection = null,
  reviewerAccountReceipt = null,
  reviewerArm = null,
  onReviewerPgid = () => {},
  onReviewerRuntimeStarted = () => {},
  domainId = null, // ARC-18: WATCHER_PRIMARY_DOMAIN_ID stays in watcher; threaded by callers (pollOnce always passes domainId in spawnReviewerArgs). Default is never read.
  reviewerRuntimeAdapterOverride = null,
  postGitHubReviewWithCaptureImpl = defaultPostGitHubReviewWithCapture,
  readBestReviewerEvidenceTokenUsageImpl = readReviewerEvidenceInWorker,
  ledgerLookupSleepImpl = sleepMs,
  quotaCheckEnv = process.env,
  readReviewerQuotaDecisionImpl = readReviewerQuotaDecision,
  beginReviewerPassImpl = beginReviewerPass,
  completeReviewerPassImpl = completeReviewerPass,
  fetchPullRequestHeadAndStateImpl = fetchPullRequestHeadAndState,
  freshnessCheckSleepImpl = sleepMs,
  onPostOperationSettled = null,
  readDurablePostedAtImpl = readDurableReviewerPostedAt,
  agyReviewerIdentityPool = getAgyReviewerIdentityPool(),
}) {
  if (reviewerRefusesBuilder(builderTag, reviewerModel)) {
    return {
      ok: false, effectiveReviewerModel: reviewerModel, failureClass: 'bug',
      routingRefusal: true, error: normalizeReviewerModel(reviewerModel) === 'claude'
        ? 'Claude-family reviewer cannot review a Claude-family builder'
        : normalizeReviewerModel(reviewerModel) === 'gemini'
          ? 'Gemini-family reviewer cannot review a Gemini-family builder' : CODEX_BUILDER_REVIEW_REFUSAL,
    };
  }
  const activeReviewerRuntimeAdapter = reviewerRuntimeAdapterOverride || reviewerRuntimeState.adapter;
  const normalizedReviewerClass = normalizeReviewerClass(reviewerModel);
  const finalRound = (
    Number.isFinite(reviewAttemptNumber) &&
    Number.isFinite(maxRemediationRounds) &&
    reviewAttemptNumber > maxRemediationRounds
  );
  const roundLabel = Number.isFinite(reviewAttemptNumber)
    ? ` attempt=${reviewAttemptNumber}/${1 + Number(maxRemediationRounds || 0)}${finalRound ? ' [FINAL — lenient threshold]' : ''}`
    : '';
  console.log(`[watcher] Spawning reviewer for ${repo}#${prNumber} (model: ${reviewerModel})${roundLabel}`
    + (normalizeReviewerModel(reviewerModel) === 'claude'
      ? ` claude_account=${claudeAccountSelection?.provider === 'claude-code-corp' ? 'corporate' : 'primary'}`
      : normalizeReviewerModel(reviewerModel) === 'codex'
        ? ` codex_account=${codexBrokerProvider === 'codex-corp' ? 'corporate' : 'personal'}`
          + ` reason=${codexBrokerProvider === 'codex-corp' ? 'corporate-first-account-ready' : 'corporate-unavailable-personal-ready'}` : ''));

  let quotaDecision;
  const claudeBrokerProvider = claudeAccountSelection?.provider || 'claude-code';
  try {
    const corporateCodexCooldown = normalizeReviewerModel(reviewerModel) === 'codex'
      && codexBrokerProvider === 'codex-corp'
      && readCorporateCodexQuotaCooldown(rootDir, { env: quotaCheckEnv });
    quotaDecision = corporateCodexCooldown
      ? { available: false, capped: true, state: 'corporate-quota-cooldown', provider: 'openai', resetAt: corporateCodexCooldown.resetAt }
      : await readReviewerQuotaDecisionImpl({
        reviewerModel,
        codexBrokerProvider,
        claudeBrokerProvider,
        env: quotaCheckEnv,
      });
    if (normalizeReviewerModel(reviewerModel) === 'gemini' && quotaDecision.state !== 'disabled') {
      const poolAvailability = await readReviewerGeminiPoolAvailability({
        pool: agyReviewerIdentityPool, adapter: activeReviewerRuntimeAdapter,
      });
      if (poolAvailability) quotaDecision = { ...poolAvailability, provider: 'google' };
    }
  } catch {
    quotaDecision = {
      available: true,
      state: 'probe-error',
      provider: providerForQuotaHarness(reviewerModel),
    };
  }
  if (normalizeReviewerModel(reviewerModel) === 'claude' && claudeAccountSelection?.hold) {
    quotaDecision = { available: false, capped: true, state: claudeAccountSelection.reason, provider: 'anthropic' };
  }
  if (!quotaDecision.available && (quotaDecision.capped || isGroundedProviderState(quotaDecision.state))) {
    if (normalizeReviewerModel(reviewerModel) === 'codex' && codexBrokerProvider === 'codex-corp'
      && quotaDecision.state !== 'corporate-quota-cooldown') {
      try { recordCorporateCodexQuotaCooldown(rootDir, { env: quotaCheckEnv, resetAt: quotaDecision.resetAt }); }
      catch (error) { console.warn(`[watcher] corporate Codex quota cooldown persistence failed: ${error.message}`); }
    }
    const attemptNumber = reviewDbAttemptNumber ?? reviewAttemptNumber ?? 0;
    const startedAt = new Date().toISOString();
    const metadata = {
      ...(reviewerAccountReceipt ? { reviewerAccountReceipt } : {}),
      reviewerSessionUuid,
      reviewerModel,
      reviewAttemptNumber,
      completedRemediationRounds,
      maxRemediationRounds,
      quotaExhaustedSkip: true,
      quotaReason: 'known-exhausted-provider-status',
      quotaState: quotaDecision.state,
      quotaProvider: quotaDecision.provider,
      failureClass: QUOTA_EXHAUSTED_FAILURE_CLASS,
    };
    beginReviewerPassImpl(rootDir, {
      repo,
      prNumber,
      attemptNumber,
      reviewerClass: normalizedReviewerClass,
      reviewerModel,
      passKind,
      workspacePath: workspacePath || rootDir,
      startedAt,
      headSha: reviewerHeadSha || null,
      metadata,
    });
    await withSqliteBusyRetry(() => completeReviewerPassImpl(rootDir, {
      repo,
      prNumber,
      attemptNumber,
      passKind,
      status: 'skipped',
      endedAt: new Date().toISOString(),
      metadata,
    }), { label: `reviewer-pass-skip:${repo}#${prNumber}`, log: console });
    console.log(
      `[watcher] reviewer spawn skipped for ${repo}#${prNumber} ` +
      `(model: ${reviewerModel}, provider: ${quotaDecision.provider}, state: ${quotaDecision.state})`,
    );
    return {
      ok: false,
      effectiveReviewerModel: reviewerModel,
      reason: 'primary-reviewer-quota-capped',
      failureClass: QUOTA_EXHAUSTED_FAILURE_CLASS,
      transient: true,
      quotaState: quotaDecision.state,
      quotaProvider: quotaDecision.provider,
    };
  }

  const reviewerSpawnToken = randomUUID();
  const reviewerIdentity = resolveReviewerIdentity({ reviewerModel, botTokenEnv });
  let reviewerAttribution = reviewerAccountReceipt
    ? buildReviewerAttribution({ reviewerModel, reviewerAccountReceipt }) : null;
  const spawnRecord = {
    ...(reviewerAccountReceipt ? { reviewerAccountReceipt } : {}),
    spawnToken: reviewerSpawnToken,
    repo,
    pr: prNumber,
    reviewerModel,
    passKind,
    dispatchPassKind,
    pipelineGeminiSeats,
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
    beginReviewerPassImpl(rootDir, {
      repo,
      prNumber,
      attemptNumber: reviewDbAttemptNumber ?? reviewAttemptNumber ?? 0,
      reviewerClass: normalizedReviewerClass,
      reviewerModel,
      passKind,
      workspacePath: workspacePath || rootDir,
      startedAt,
      // LAC-1559: record the head this pass reviewed so the completed-rereview
      // budget counter keys per (repo, pr, head) — a head move re-arms review.
      headSha: reviewerHeadSha || null,
      metadata: {
        ...(reviewerAccountReceipt ? { reviewerAccountReceipt, reviewerAttribution } : {}),
        branch,
        builderTag,
        reviewerBuildId: REVIEWER_BUILD_ID,
        reviewerSessionUuid,
        reviewerModel,
        reviewAttemptNumber,
        completedRemediationRounds,
        maxRemediationRounds,
        ...(afhReviewerFallback ? { afhReviewerFallback } : {}),
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
      ? Math.max(reviewerTimeoutMs, resolveGeminiReviewerProcessTimeoutMs())
      : reviewerTimeoutMs;

    // CCX-08: a Gemini review leases one agy reviewer identity for its whole
    // run; with one identity (the HQ owner) this calls straight through.
    let agyIdentityUser;
    let result = await runWithAgyReviewerIdentity({
      reviewerModel,
      adapter: activeReviewerRuntimeAdapter,
      pool: agyReviewerIdentityPool,
    }, async (agyIdentity, agyIdentityLease) => {
      agyIdentityUser = agyIdentityLease?.user;
      reviewerAttribution = buildReviewerAttribution({ reviewerModel, reviewerAccountReceipt,
        agyHolderLease: agyIdentityLease });
      onReviewerRuntimeStarted();
      const runtimeResult = await activeReviewerRuntimeAdapter.spawnReviewer({
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
          branch,
          reviewerHeadSha,
          reviewAttemptNumber,
          reviewDbAttemptNumber,
          completedRemediationRounds,
          passKind,
          maxRemediationRounds,
          advisoryFindings,
          reviewerSessionUuid,
          reviewerSpawnToken,
          crossModelReviewWaived,
          crossModelReviewWaiverReason,
          afhReviewerFallback,
          codexBrokerProvider,
          claudeBrokerProvider,
          reviewerAccountReceipt,
          ...(reviewerArm?.harness === normalizeReviewerModel(reviewerModel) ? { reviewerArm } : {}),
          reviewerAttribution,
          ...(agyIdentity ? { agyIdentity } : {}),
          // Persisted in the run record so a restarted watcher keeps this
          // identity out while this review still runs.
          ...(agyIdentityLease ? { agyHolderLease: agyIdentityLease, agyIdentityLease } : {}),
        },
        timeoutMs: effectiveReviewerTimeoutMs,
        sessionUuid: reviewerSessionUuid,
        forbiddenFallbacks: ['api-key', 'anthropic-api-key'],
        onReviewerPgid,
      });
      if (reviewerAccountReceipt && !runtimeResult.ok && runtimeResult.failureClass === QUOTA_EXHAUSTED_FAILURE_CLASS) {
        try { recordReviewerAccountQuotaFailure(rootDir, reviewerAccountReceipt, { env: quotaCheckEnv,
          resetAt: resolveQuotaResetIso([runtimeResult.error, runtimeResult.stderr, runtimeResult.stderrTail].filter(Boolean).join('\n')) }); }
        catch (error) { console.warn(`[watcher] reviewer account quota cooldown persistence failed: ${error.message}`); }
      }
      if (normalizeReviewerModel(reviewerModel) === 'codex' && codexBrokerProvider === 'codex-corp'
        && !runtimeResult.ok && runtimeResult.failureClass === QUOTA_EXHAUSTED_FAILURE_CLASS) {
        try { recordCorporateCodexQuotaCooldown(rootDir, { env: quotaCheckEnv,
          resetAt: resolveQuotaResetIso([runtimeResult.error, runtimeResult.stderr, runtimeResult.stderrTail].filter(Boolean).join('\n')) }); }
        catch (error) { console.warn(`[watcher] corporate Codex quota cooldown persistence failed: ${error.message}`); }
      }
      if (normalizeReviewerModel(reviewerModel) === 'claude' && claudeBrokerProvider === 'claude-code-corp'
        && !runtimeResult.ok && runtimeResult.failureClass === QUOTA_EXHAUSTED_FAILURE_CLASS) {
        try { recordCorporateClaudeQuotaCooldown(rootDir, { env: quotaCheckEnv,
          resetAt: resolveQuotaResetIso([runtimeResult.error, runtimeResult.stderr, runtimeResult.stderrTail].filter(Boolean).join('\n')) }); }
        catch (error) { console.warn(`[watcher] corporate Claude quota cooldown persistence failed: ${error.message}`); }
      }
      if (normalizeReviewerModel(reviewerModel) === 'gemini' && !runtimeResult.ok
        && runtimeResult.failureClass === QUOTA_EXHAUSTED_FAILURE_CLASS) {
        // Persist before releasing the identity or admission capacity so the
        // next queued review cannot lease the identity that just hit its quota.
        recordGeminiQuotaCooldown({
          rootDir, env: quotaCheckEnv, result: runtimeResult, identityUser: agyIdentityUser, pool: agyReviewerIdentityPool,
        });
      }
      return runtimeResult;
    });
    result = { ...result, effectiveReviewerModel: reviewerModel, ...(agyIdentityUser ? { agyIdentityUser } : {}) };
    if (
      result.ok &&
      shouldPostAdapterReviewBody(result) &&
      typeof result.reviewBody === 'string' &&
      result.reviewBody.trim()
    ) {
      try {
        let staleReviewOutput = false;
        if (reviewerHeadSha) {
          try {
            const freshPR = await fetchReviewerPostFreshnessWithRetry({
              fetchImpl: fetchPullRequestHeadAndStateImpl,
              repo,
              prNumber,
              sleepImpl: freshnessCheckSleepImpl,
            });
            const freshHeadSha = freshPR?.headRefOid || null;
            if (freshHeadSha && String(freshHeadSha) !== String(reviewerHeadSha)) {
              const staleMessage =
                `reviewer output for ${repo}#${prNumber} targeted stale head ` +
                `${String(reviewerHeadSha).slice(0, 12)}; current head is ${String(freshHeadSha).slice(0, 12)}`;
              console.warn(`[watcher] ${staleMessage}; discarding review before GitHub post`);
              result = {
                ...result,
                ok: false,
                failureClass: 'stale-review-head',
                error: staleMessage,
                reviewerSessionUuid,
                stdout: result.stdout || result.stdoutTail || null,
                stderr: result.stderr || result.stderrTail || null,
              };
              staleReviewOutput = true;
            }
          } catch (err) {
            console.warn(
              `[watcher] reviewer post freshness check failed for ${repo}#${prNumber}; proceeding with post: ` +
              `${err?.message || err}`
            );
          }
        }
        if (!staleReviewOutput) {
          const captureAttemptNumber = Number.isFinite(Number(reviewDbAttemptNumber))
            ? Number(reviewDbAttemptNumber)
            : Number(reviewAttemptNumber);
          await postGitHubReviewWithCaptureImpl({
            reviewerAttribution,
            rootDir,
            repo,
            prNumber,
            attemptNumber: captureAttemptNumber,
            reviewerModel,
            reviewerHeadSha: reviewerHeadSha || null,
            reviewBody: result.reviewBody,
            botTokenEnv,
            passKind,
            reviewerSpawnToken,
            reviewerIdentity,
            log: console,
          });
          console.log(`[reviewer] Review posted to ${repo}#${prNumber}`);
        }
      } catch (err) {
        console.error(`[reviewer] GITHUB POST FAILED for ${repo}#${prNumber}:`, err?.message || err);
        result = resultWithGitHubPostFailure(result, err);
      }
    }
    if (result.ok) {
      try {
        const postedAt = readDurablePostedAtImpl({ rootDir, repo, prNumber, reviewerHeadSha,
          reviewerModel: result.effectiveReviewerModel || reviewerModel,
          attemptNumber: reviewDbAttemptNumber ?? reviewAttemptNumber ?? 0, passKind });
        if (postedAt) result.durablePostedAt = Date.parse(postedAt);
      } catch (error) {
        console.warn(`[watcher] durable post timestamp unavailable for ${repo}#${prNumber}: ${error.message}`);
      }
    }
    // The runtime (including its identity lease) has finished. Accounting below
    // must not keep a dead process counted by the next admission drain.
    activeReviewerSpawns.delete(reviewerSpawnToken);
    deleteSpawnRecord(ADVERSARIAL_REVIEW_STATE_DIR, reviewerSpawnToken);
    // RPL-02 admission/settlement split. The callback synchronously commits the
    // reviewed_prs transition before the pool releases scarce reviewer
    // capacity. postGitHubReviewWithCapture has already completed its bounded
    // transport retry/reconciliation path, so success and failure both have a
    // durable restart-visible disposition at this boundary.
    if (typeof onPostOperationSettled === 'function') {
      try {
        onPostOperationSettled(result);
      } catch (err) {
        console.warn(
          `[reviewer] post-operation settlement callback failed for ${repo}#${prNumber}; ` +
            `deferring to caller settlement path: ${err?.message || err}`
        );
      }
    }
    if (result.stdoutTail) console.log(`[reviewer:${prNumber}] ${String(result.stdoutTail).trim()}`);
    if (result.stderrTail) console.error(`[reviewer:${prNumber}] stderr: ${String(result.stderrTail).trim()}`);
    const settlementStartedAt = Date.now();
    try {
      const endedAt = new Date().toISOString();
      // Read the reviewer token-usage evidence and persist the artifact in an
      // ISOLATED try/catch. These read/write evidence files on disk and can
      // throw; a failure here must NOT skip completeReviewerPass below, or the
      // on-disk reviewer-pass artifact would stay stuck in 'running' forever.
      // On failure we settle the pass with null token usage instead.
      let tokenUsage = null;
      let reviewerTokenUsageArtifact = null;
      // `reattachToken` is an adapter/idempotency handle. It may resemble an
      // LRQ, but it is neither proof of a real worker launch nor a safe
      // launch_request_id lookup key. Adapters that know a real launch id must
      // surface it explicitly as result.launchRequestId.
      const launchRequestId = result.launchRequestId || null;
      // WCW attribution: the reviewer worker's real ledger run_id, captured from
      // the RAW token usage before tagTokenUsage()/normalizeTokenUsage() drops it
      // (the normalized token-usage shape intentionally carries only counters,
      // not attribution). Populates reviewer_passes.worker_run_id at settle.
      let resolvedWorkerRunId = null;
      let workerRunAttribution = null;
      try {
        let rawTokenUsage = result.tokenUsage || null;
        if (!rawTokenUsage?.workerRunId || !rawTokenUsage?.rateLimits?.length || !rawTokenUsage?.model) {
          const ledgerStartedAt = Date.now();
          const ledgerLookup = await readReviewerLedgerEvidenceWithRetry({
            readImpl: readBestReviewerEvidenceTokenUsageImpl,
            sleepImpl: ledgerLookupSleepImpl,
            args: {
              // SDK/os-dispatch reattaches by app-contract request_id, but the
              // session ledger attributes worker_runs by launch_request_id.
              launchRequestId,
              adapterSessionKey: result.reattachToken || reviewerSessionUuid,
              sessionKeys: [
                reviewerSessionUuid,
                result.reattachToken,
                result.sessionUuid,
              ].filter(Boolean),
              workspacePath: workspacePath || rootDir,
              startedAt,
              endedAt,
              reviewerModel,
              rootDir,
            },
          });
          console.log(`[watcher] reviewer settlement timing repo=${repo} pr=${prNumber} step=token-ledger-lookup elapsed_ms=${Date.now() - ledgerStartedAt} attempts=${ledgerLookup.attempts}`);
          const ledgerTokenUsage = ledgerLookup.usage;
          if (ledgerLookup.lastError && ledgerLookup.lastError !== 'worker-run-not-yet-visible') {
            console.warn(
              `[watcher] reviewer_pass_token_ledger_lookup_failed repo=${repo} pr=${prNumber} ` +
              `session=${reviewerSessionUuid} attempts=${ledgerLookup.attempts}: ${ledgerLookup.lastError}`
            );
          }
          if (ledgerTokenUsage) {
            rawTokenUsage = rawTokenUsage
              ? {
                  ...rawTokenUsage,
                  workerRunId: rawTokenUsage.workerRunId || ledgerTokenUsage.workerRunId || null,
                  model: rawTokenUsage.model || ledgerTokenUsage.model || null,
                  rateLimits: rawTokenUsage.rateLimits?.length
                    ? rawTokenUsage.rateLimits : (ledgerTokenUsage.rateLimits || []),
                  partial: rawTokenUsage.partial || ledgerTokenUsage.partial || false,
                }
              : ledgerTokenUsage;
          }
          workerRunAttribution = {
            state: ledgerTokenUsage?.workerRunId ? 'resolved' : (launchRequestId ? 'pending' : 'not-applicable'),
            launchRequestId,
            workerRunId: ledgerTokenUsage?.workerRunId || null,
            lookupAttempts: ledgerLookup.attempts,
            lastError: ledgerLookup.lastError,
            retryable: Boolean(launchRequestId && !ledgerTokenUsage?.workerRunId),
            ...(!launchRequestId && !ledgerTokenUsage?.workerRunId
              ? { reason: 'missing-launch-request-id' }
              : {}),
          };
        }
        resolvedWorkerRunId = rawTokenUsage?.workerRunId || null;
        if (!workerRunAttribution) {
          workerRunAttribution = {
            state: 'resolved',
            launchRequestId,
            workerRunId: resolvedWorkerRunId,
            lookupAttempts: 0,
            lastError: null,
            retryable: false,
          };
        } else if (resolvedWorkerRunId && workerRunAttribution.state !== 'resolved') {
          workerRunAttribution = {
            ...workerRunAttribution,
            state: 'resolved',
            workerRunId: resolvedWorkerRunId,
            lastError: null,
            retryable: false,
          };
        }
        tokenUsage = tagTokenUsage(rawTokenUsage, 'guardrail');
        if (tokenUsage) {
          const artifactStartedAt = Date.now();
          reviewerTokenUsageArtifact = writeReviewerTokenUsageArtifactBestEffort({
            workspacePath: workspacePath || rootDir,
            repo,
            prNumber,
            attemptNumber: reviewDbAttemptNumber ?? reviewAttemptNumber ?? 0,
            passKind,
            reviewerClass: normalizedReviewerClass,
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
          console.log(`[watcher] reviewer settlement timing repo=${repo} pr=${prNumber} step=token-artifact elapsed_ms=${Date.now() - artifactStartedAt}`);
        }
      } catch (tokenErr) {
        console.warn(
          `[watcher] reviewer_pass_token_read_failed repo=${repo} pr=${prNumber} ` +
          `session=${reviewerSessionUuid}: ${tokenErr?.message || tokenErr}`
        );
        tokenUsage = null;
        reviewerTokenUsageArtifact = null;
        // NOTE: deliberately do NOT reset resolvedWorkerRunId here. It is
        // extracted from the raw token usage BEFORE tagTokenUsage()/the artifact
        // write, so if only those later steps throw (e.g. malformed token
        // counts) the run_id is already valid — discarding it would lose WCW
        // attribution for no reason. If the read itself threw, it stays null.
      }
      const passCompletionStartedAt = Date.now();
      await withSqliteBusyRetry(() => completeReviewerPassImpl(rootDir, {
        repo,
        prNumber,
        attemptNumber: reviewDbAttemptNumber ?? reviewAttemptNumber ?? 0,
        passKind,
        status: result.ok ? 'completed' : (result.failureClass === 'cancelled' ? 'cancelled' : 'failed'),
        endedAt,
        tokenUsage,
        tokenSource: tokenUsage?.source || 'unknown',
        // WCW attribution: persist the reviewer worker's real ledger run_id
        // (resolved from launchRequestId above). Null on the cli-direct path
        // (no worker run) and when the ledger read cannot resolve — COALESCE in
        // the writer keeps the column honest rather than storing a wrong id.
        workerRunId: resolvedWorkerRunId,
        metadata: {
          ...(reviewerAttribution ? { reviewerAttribution } : {}),
          ...(reviewerAccountReceipt ? { reviewerAccountReceipt } : {}),
          reviewerSessionUuid,
          launchRequestId,
          reattachToken: result.reattachToken || null,
          branch,
          builderTag,
          workerRunAttribution,
          failureClass: result.failureClass || null,
          failureDetail: result.failureDetail || parseReviewerModelUnavailable([result.error, result.stderr, result.stderrTail].filter(Boolean).join('\n')),
          failureMessage: result.ok ? null : (result.error || result.stderr || result.stderrTail || null),
          tokenUsageNoUsageReason: result.tokenUsageNoUsageReason || null,
          reviewerTokenUsageArtifact,
        },
      }), { label: `reviewer-pass-settle:${repo}#${prNumber}`, log: console });
      console.log(`[watcher] reviewer settlement timing repo=${repo} pr=${prNumber} step=pass-completion elapsed_ms=${Date.now() - passCompletionStartedAt}`);
    } catch (err) {
      console.warn(
        `[watcher] reviewer_pass_token_update_failed repo=${repo} pr=${prNumber} ` +
        `session=${reviewerSessionUuid}: ${err?.message || err}`
      );
    }
    console.log(`[watcher] reviewer settlement timing repo=${repo} pr=${prNumber} step=token-artifacts-pass-completion elapsed_ms=${Date.now() - settlementStartedAt}`);
    return result;
  } catch (err) {
    try {
      const rawErrTokenUsage = err?.tokenUsage && typeof err.tokenUsage === 'object'
        ? err.tokenUsage
        : null;
      // Isolate tagTokenUsage exactly as the success path does: a failure on
      // malformed token counts must NOT skip completeReviewerPassImpl below, or
      // the reviewer pass would stay stuck in 'running' forever. The raw run_id
      // (read directly below) is unaffected by a normalization failure.
      let tokenUsage = null;
      try {
        tokenUsage = rawErrTokenUsage ? tagTokenUsage(rawErrTokenUsage, 'guardrail') : null;
      } catch {
        tokenUsage = null;
      }
      await withSqliteBusyRetry(() => completeReviewerPassImpl(rootDir, {
        repo,
        prNumber,
        attemptNumber: reviewDbAttemptNumber ?? reviewAttemptNumber ?? 0,
        passKind,
        status: 'failed',
        endedAt: new Date().toISOString(),
        tokenUsage,
        tokenSource: tokenUsage?.source || null,
        // WCW attribution: read the run_id from the raw error token usage before
        // tagTokenUsage() normalization drops it (usually null on this path).
        workerRunId: rawErrTokenUsage?.workerRunId || null,
        metadata: {
          ...(reviewerAttribution ? { reviewerAttribution } : {}),
          ...(reviewerAccountReceipt ? { reviewerAccountReceipt } : {}),
          reviewerSessionUuid,
          reviewerModel,
          tokenUsageNoUsageReason: tokenUsage
            ? null
            : (err?.tokenUsageNoUsageReason || null),
          error: err?.message || String(err),
        },
      }), { label: `reviewer-pass-settle:${repo}#${prNumber}`, log: console });
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

// CCX-08: reserve the largest simultaneous Gemini panel, not the sum of
// sequential stages. Single-identity deployments retain their old admission
// behavior. A compilation failure is still reported by the pipeline spawn.
function domainPipelineGeminiSeatCount(domainConfig, { env = process.env, roleRegistry = null, identityPool = getAgyReviewerIdentityPool() } = {}) {
  if (!identityPool.plan().multi || !isPipelineEnabled(domainConfig)) return 0;
  try {
    const registry = roleRegistry || resolveRoleRegistryFromDomain(domainConfig, {
      fallbackRoleRegistry: loadRoleRegistry({ env }),
    });
    const { stages } = resolveDomainPipeline(domainConfig, { roleRegistry: registry });
    return Math.max(0, ...stages.map(({ panelRoles }) => panelRoles.filter(({ role }) => (
      String(role?.workerClass || role?.persona || '').trim().toLowerCase() === 'gemini'
    )).length));
  } catch {
    return 0;
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
  const roleRegistry = resolveRoleRegistryFromDomain(domainConfig, {
    fallbackRoleRegistry: loadRoleRegistry({ env: process.env }),
  });
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
  reviewerSessionUuid = result?.reviewerSessionUuid ?? null,
  reviewerHeadSha = null,
  env = null,
  failureAt = new Date().toISOString(),
  maxRemediationRounds,
  reviewerModel = null,
  leaseRecoveryEnabled = REVIEWER_LEASE_RECOVERY_ENABLED,
  statements = {
    markPosted: stmtMarkPosted,
    releaseUnsettledPostedReview: stmtReleaseUnsettledPostedReview,
    markFailed: stmtMarkFailed,
    releaseReviewerClaim: stmtReleaseReviewerClaim,
    releaseLegacyStaleReviewerClaim: stmtReleaseLegacyStaleReviewerClaim,
    releaseReviewLease: stmtReleaseReviewLease,
    markFailedQuota: stmtMarkFailedQuota,
    releaseReviewLeaseQuota: stmtReleaseReviewLeaseQuota,
    markOutageTransient: stmtMarkOutageTransient,
    markReviewerCredentialOutage: stmtMarkReviewerCredentialOutage,
    promoteReviewerCredentialOutage: stmtPromoteReviewerCredentialOutage,
    rearmReviewerCredentialOutage: stmtRearmReviewerCredentialOutage,
    markCascadeFailed: stmtMarkCascadeFailed,
    markPendingUpstream: stmtMarkPendingUpstream,
    markTokenRefreshHold: stmtMarkTokenRefreshHold,
    getReviewRow: stmtGetReviewRow,
  },
  log = console,
  // ARC-18: markWatcherReviewHeartbeat stays in watcher (it closes over the
  // mutable watcherHeartbeat singleton and is used elsewhere); threaded in here.
  // The no-op default matches production behavior when the heartbeat is unset.
  markReviewHeartbeat = () => {},
}) {
  reviewerModel = result.effectiveReviewerModel || reviewerModel;
  if (result.failureClass === 'reviewer-account-held') {
    reviewerSessionUuid = result.reviewerSessionUuid || reviewerSessionUuid;
    log.warn(`[watcher] reviewer-account-held repo=${repoPath} pr=${prNumber} reason=${result.error || 'unknown'}`);
    try { recordCascadeFailure(rootDir, { repo: repoPath, prNumber, failureClass: 'reviewer-account-held',
      reviewerModel, headSha: reviewerHeadSha, failureReason: result.error || 'unknown' }); }
    catch { log.warn('[watcher] reviewer account hold backoff persistence failed'); }
    withSqliteBusyRetrySync(
      () => statements.releaseReviewerClaim.run(reviewerSessionUuid, repoPath, prNumber),
      { label: `reviewer-account-held:${repoPath}#${prNumber}`, log },
    );
    return;
  }
  if (result.ok) {
    const postedAt = Number.isFinite(result.durablePostedAt)
      ? new Date(result.durablePostedAt).toISOString() : new Date().toISOString();
    const reviewedHead = String(reviewerHeadSha || '').trim();
    const posted = reviewedHead ? withSqliteBusyRetrySync(
      () => statements.markPosted.run(postedAt, reviewedHead, repoPath, prNumber, reviewerSessionUuid, reviewedHead),
      { label: `reviewer-settle-posted:${repoPath}#${prNumber}`, log }
    ) : { changes: 0 };
    if (posted.changes !== 1) {
      const released = withSqliteBusyRetrySync(
        () => statements.releaseUnsettledPostedReview.run(reviewedHead || null, repoPath, prNumber, reviewerSessionUuid),
        { label: `reviewer-settle-unmatched-post:${repoPath}#${prNumber}`, log }
      );
      const reason = reviewedHead ? 'posted-settlement-claim-mismatch' : 'posted-settlement-missing-reviewed-head';
      log.warn?.(`[watcher] ${reason} repo=${repoPath} pr=${prNumber} `
        + `released_to_pending=${released.changes === 1} without charging review attempts or recovery budget`);
      return { posted: false, reason };
    }
    let recoveredOutage = null;
    try {
      recoveredOutage = reviewerModel ? clearReviewerCredentialOutage(rootDir, reviewerCredentialKey(reviewerModel, result.claudeBrokerProvider)) : null;
    } catch (error) {
      log?.warn?.(`[watcher] Credential outage clear failed for ${reviewerModel}: ${error?.message || error}`);
    }
    if ((recoveredOutage?.active || recoveredOutage?.exhausted) &&
        typeof statements.rearmReviewerCredentialOutage?.run === 'function') {
      withSqliteBusyRetrySync(
        () => statements.rearmReviewerCredentialOutage.run(
          `[outage-transient:reviewer-credential:${String(recoveredOutage.reviewerModel || reviewerModel).toLowerCase()}]%`
        ),
        { label: `reviewer-credential-outage-rearm:${reviewerModel}`, log }
      );
    }
    withSqliteBusyRetrySync(() => {
      markReviewHeartbeat({ repo: repoPath, pr_number: prNumber, posted_at: postedAt });
    }, { label: `reviewer-settle-posted-heartbeat:${repoPath}#${prNumber}`, log });
    try {
      withSqliteBusyRetrySync(() => {
        const currentRow = typeof statements.getReviewRow?.get === 'function'
          ? statements.getReviewRow.get(repoPath, prNumber)
          : null;
        if (currentRow && currentRow.reviewer_head_sha !== reviewedHead) {
          log?.log?.(`[watcher] review-cycle-count retains settled head repo=${repoPath} pr=${prNumber} head=${reviewedHead}`);
        }
        const { windowHours } = resolveReviewCycleCapConfig({
          loadConfigImpl: loadConfigCached,
          logger: log,
        });
        recordSuccessfulReviewCycleVerdict({
          db,
          repoPath,
          prNumber,
          headSha: reviewedHead,
          postedAt,
          result,
          windowHours,
          logger: log,
        });
      }, { label: `reviewer-settle-cycle-count:${repoPath}#${prNumber}`, log });
    } catch (err) {
      log?.warn?.(
        `[watcher] review-cycle-count bookkeeping skipped for ${repoPath}#${prNumber}: ${err?.message || err}`
      );
    }
    clearCascadeState(rootDir, { repo: repoPath, prNumber });
    return;
  }

  const fullFailureOutput = [result.error, result.stdout, result.stderr]
    .filter(Boolean)
    .join('\n');
  const reviewCreateFailure = classifyGitHubReviewCreateFailure(fullFailureOutput);
  const failureClass = reviewCreateFailure?.failureClass || result.failureClass || 'unknown';

  const routingRefusal = failureClass === 'bug'
    && (result.routingRefusal === true || result.error === CODEX_BUILDER_REVIEW_REFUSAL);
  if (routingRefusal || failureClass === 'stale-review-head') {
    // Claim identity comes from dispatch, not the runtime adapter's result.
    // Failure/lease statements charge attempts and cannot handle head churn.
    let releaseResult = typeof statements.releaseReviewerClaim?.run === 'function'
      ? withSqliteBusyRetrySync(
        () => statements.releaseReviewerClaim.run(reviewerSessionUuid, repoPath, prNumber),
        { label: `reviewer-settle-release-claim:${repoPath}#${prNumber}`, log }
      )
      : { changes: 0 };
    if (!routingRefusal && releaseResult.changes === 0 && reviewerHeadSha &&
        typeof statements.releaseLegacyStaleReviewerClaim?.run === 'function') {
      releaseResult = withSqliteBusyRetrySync(
        () => statements.releaseLegacyStaleReviewerClaim.run(repoPath, prNumber, reviewerHeadSha),
        { label: `reviewer-settle-release-legacy-stale-claim:${repoPath}#${prNumber}`, log }
      );
    }
    log.warn(
      `[watcher] Reviewer ${routingRefusal ? 'routing refusal' : 'stale output'} for ${repoPath}#${prNumber}; ` +
      `released claim=${releaseResult.changes === 1 ? 'yes' : 'no'} ` +
      (routingRefusal ? 'deferred without charging review attempts' : 'for current-head re-review')
    );
    return;
  }

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
    'oauth-broken',
    'reviewer-timeout',
    'launchctl-bootstrap',
    'daemon-bounce',
    'reviewer-output',
    'github-review-create-transient',
    ATTESTATION_SIGN_FAILED_FAILURE_CLASS,
    HCP_UNAVAILABLE_FAILURE_CLASS,
    PROVIDER_OVERLOADED_FAILURE_CLASS,
    REVIEWER_EMPTY_OUTPUT_FAILURE_CLASS,
    // A host fault, not a review outcome: retried on the bounded infra
    // auto-recovery path and never charged to review_attempts.
    INFRA_RUNTIME_MISSING_LIBRARY_FAILURE_CLASS,
    // CCX-08: no agy reviewer identity could be leased; no reviewer ran.
    AGY_IDENTITY_UNAVAILABLE_FAILURE_CLASS,
  ]);
  const defaultFailureMessages = {
    cascade: 'Reviewer hit a LiteLLM/upstream cascade failure; watcher backoff engaged.',
    [PROVIDER_OVERLOADED_FAILURE_CLASS]: 'Reviewer hit a provider/backend overload (HTTP 529 or capacity signal); watcher backoff engaged.',
    [REVIEWER_EMPTY_OUTPUT_FAILURE_CLASS]: 'Reviewer runtime returned empty output before posting; watcher backoff engaged.',
    [INFRA_RUNTIME_MISSING_LIBRARY_FAILURE_CLASS]: 'Reviewer process died in dyld: the host runtime is missing a shared library (Homebrew upgrade?); watcher backoff engaged. Run `hq doctor dylib-drift`.',
    'quota-exhausted': 'Reviewer hit a hard provider usage cap; holding until the cap window clears (HRR graceful degradation).',
    'oauth-broken': 'Reviewer OAuth credentials are unavailable; watcher backoff engaged until credentials recover.',
    [TOKEN_REFRESH_PENDING_FAILURE_CLASS]: 'Claude reviewer token refresh is pending; held until the next token rotation.',
    'reviewer-timeout': 'Reviewer command timed out before posting; watcher backoff engaged.',
    [AGY_IDENTITY_UNAVAILABLE_FAILURE_CLASS]: 'No agy reviewer identity was ready and free to lease; the reviewer did not run; watcher backoff engaged.',
    'launchctl-bootstrap': 'Claude launchctl session bootstrap failed; watcher backoff engaged.',
    'daemon-bounce': 'Reviewer runtime could not reattach after daemon bounce; watcher backoff engaged.',
    'reviewer-output': 'Reviewer runtime produced an unparseable review artifact; watcher retry engaged.',
    'github-review-create-transient': 'GitHub rejected review creation with a transient status; watcher backoff engaged.',
    'github-review-create-terminal': 'GitHub rejected review creation with a terminal status.',
    [ATTESTATION_SIGN_FAILED_FAILURE_CLASS]: 'Reviewed attestation signing failed after review production; watcher retry engaged.',
    [HCP_UNAVAILABLE_FAILURE_CLASS]: 'HCP is unavailable for reviewed attestation signing; watcher backoff engaged.',
    bug: 'Reviewer failed due to an invocation or implementation bug.',
    unknown: 'Unknown reviewer failure',
  };
  const baseFailureMessage = String(result.error || '').trim() || defaultFailureMessages[failureClass] || defaultFailureMessages.unknown;
  const failureMessage = appendFailureDiagnostics(baseFailureMessage, result);
  const classifiedMessage = `[${failureClass}] ${failureMessage}`;

  if (failureClass === 'reviewer-model-unavailable') {
    // Immediate fallback was already tried by spawnReviewer. A deterministic
    // refusal left here needs configuration repair, not another poll-time spawn.
    withSqliteBusyRetrySync(
      () => statements.markFailed.run(failureAt, classifiedMessage, repoPath, prNumber),
      { label: `reviewer-model-terminal:${repoPath}#${prNumber}`, log },
    );
    log.warn(`[watcher] Terminal reviewer model refusal on ${repoPath} PR ${prNumber}: ${failureMessage}`);
    return;
  }

  // A size ceiling is deterministic for this head; never release it to pending,
  // even during a coincident provider outage or with lease recovery enabled.
  if (failureClass === 'reviewer-prompt-too-large' || failureClass === 'reviewer-chunk-budget-exceeded') {
    withSqliteBusyRetrySync(
      () => statements.markFailed.run(failureAt, classifiedMessage, repoPath, prNumber),
      { label: `reviewer-size-terminal:${repoPath}#${prNumber}`, log },
    );
    log.warn(`[watcher] Terminal oversized review failure on ${repoPath} PR ${prNumber}: ${failureMessage}`);
    return;
  }

  let oauthCredentialState = null;
  if (failureClass === 'oauth-broken') {
    try {
      oauthCredentialState = recordReviewerCredentialFailure(rootDir, {
        reviewerModel: reviewerCredentialKey(reviewerModel, result.claudeBrokerProvider),
        repo: repoPath,
        prNumber,
        failedAt: failureAt,
      });
    } catch (error) {
      log?.warn?.(`[watcher] Credential outage write failed for ${reviewerModel}: ${error?.message || error}; charging normal infra recovery`);
    }
    if (oauthCredentialState?.active) {
      const outageMessage = `[outage-transient:${oauthCredentialState.reason}] ${classifiedMessage}`;
      const markCredentialOutage = statements.markReviewerCredentialOutage || statements.markOutageTransient;
      withSqliteBusyRetrySync(
        () => markCredentialOutage.run(failureAt, outageMessage, ...(statements.markReviewerCredentialOutage ? [] : [null]), repoPath, prNumber),
        { label: `reviewer-settle-credential-hold:${repoPath}#${prNumber}`, log }
      );
      if (typeof statements.promoteReviewerCredentialOutage?.run === 'function') {
        withSqliteBusyRetrySync(
          () => statements.promoteReviewerCredentialOutage.run(outageMessage, oauthCredentialState.reviewerModel),
          { label: `reviewer-credential-outage-promote:${oauthCredentialState.reviewerModel}`, log }
        );
      }
      recordCascadeFailure(rootDir, {
        repo: repoPath, prNumber, failedAt: failureAt, failureClass, failureReason: failureMessage, reviewerModel,
      });
      log.warn(
        `[watcher] Reviewer oauth-broken failure on #${prNumber}; model-scoped credential outage active across ` +
        `${oauthCredentialState.distinctPrCount} PRs; holding without charging infra recovery`
      );
      return;
    }
  }
  if (failureClass === TOKEN_REFRESH_PENDING_FAILURE_CLASS) {
    // TOKDZ-01: the broker token is waiting on a rotation. That says nothing
    // about this PR, so hold it until the rotation (bounded; route selection
    // re-routes once the bound passes) without charging review_attempts or
    // infra_auto_recover_attempts, and never go terminal.
    if (typeof statements.markTokenRefreshHold?.run !== 'function') {
      throw new Error('settleReviewerAttempt requires statements.markTokenRefreshHold for token-refresh holds');
    }
    const { tokenRefreshHold: hold } = recordTokenRefreshHold(rootDir, {
      repo: repoPath,
      prNumber,
      failedAt: failureAt,
      failureReason: failureMessage,
      refusalText: fullFailureOutput,
      reviewerModel: reviewerModel || 'claude',
    });
    withSqliteBusyRetrySync(
      () => statements.markTokenRefreshHold.run(failureAt, classifiedMessage, repoPath, prNumber),
      { label: `reviewer-settle-token-refresh-hold:${repoPath}#${prNumber}`, log }
    );
    log.warn(
      `[watcher] Reviewer token-refresh-pending refusal on #${prNumber} held without charging attempts ` +
      `(refusal ${hold.refusals}; expected rotation ${hold.expectedRotationAt || 'unknown'}; ` +
      `retry after ${hold.holdUntil}; re-route after ${hold.maxHoldUntil})`
    );
    return;
  }
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
      failureReason: failureMessage,
      reviewerModel,
      headSha: reviewerHeadSha || currentRow?.reviewer_head_sha,
      reviewerBuildId: REVIEWER_BUILD_ID,
      row: currentRow,
    });
    if (infraRecoverAttempts >= INFRA_AUTO_RECOVER_CAP) {
      const repeatExhaustion = infraRecoverAttempts > INFRA_AUTO_RECOVER_CAP;
      const exhaustionLabel = repeatExhaustion
        ? `REPEAT infra auto-recovery cap exhaustion after reset (${infraRecoverAttempts}/${INFRA_AUTO_RECOVER_CAP})`
        : `infra auto-recovery cap exhausted (${infraRecoverAttempts}/${INFRA_AUTO_RECOVER_CAP})`;
      withSqliteBusyRetrySync(
        () => statements.markCascadeFailed.run(
          failureAt,
          `${classifiedMessage}\nSystem: ${exhaustionLabel}.`,
          repoPath,
          prNumber
        ),
        { label: `reviewer-settle-cascade-failed:${repoPath}#${prNumber}`, log }
      );
      log.warn(
        `[watcher] Reviewer ${failureClass} failure on #${prNumber} ${repeatExhaustion ? 'REPEAT-exhausted' : 'exhausted'} infra auto-recovery cap ` +
        `(${infraRecoverAttempts}/${INFRA_AUTO_RECOVER_CAP}); leaving terminal evidence for operator inspection`
      );
      return;
    }
    withSqliteBusyRetrySync(
      () => statements.markPendingUpstream.run(failureAt, classifiedMessage, repoPath, prNumber),
      { label: `reviewer-settle-pending-upstream:${repoPath}#${prNumber}`, log }
    );
    const breakdown = formatTransientFailureBreakdown(cascadeState.transientFailureBreakdown);
    log.warn(
      `[watcher] PR #${prNumber} marked pending-upstream after ${cascadeState.consecutiveTransientFailures} transient reviewer failures (${breakdown}); ` +
      `infra auto-recovery ${infraRecoverAttempts + 1}/${INFRA_AUTO_RECOVER_CAP}; will resume when the reviewer lane recovers`
    );
    if (oauthCredentialState) {
      log.warn(
        `[watcher] Reviewer oauth-broken failure on #${prNumber}; ` +
        (oauthCredentialState.exhausted
          ? `credential outage probe cap exhausted (${oauthCredentialState.probeFailures} failed probes)`
          : `credential outage threshold not met (${oauthCredentialState.distinctPrCount} distinct PRs)`) +
        ', charging infra recovery'
      );
    }
    log.warn(
      `[watcher] Reviewer ${failureClass} failure on #${prNumber} (consecutiveTransient=${cascadeState.consecutiveTransientFailures}); backing off ${cascadeState.backoffMinutes}m`
    );
    return;
  }

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
    env,
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
      failureReason: failureMessage,
      nextRetryAfter: outageSignal.retryAfter,
      reviewerModel,
    });
    withSqliteBusyRetrySync(
      () => statements.markOutageTransient.run(
        failureAt,
        `[outage-transient:${outageSignal.reason}] ${classifiedMessage}`,
        quotaResetIso,
        repoPath,
        prNumber
      ),
      { label: `reviewer-settle-outage-transient:${repoPath}#${prNumber}`, log }
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
  const terminalFailureStatement = leaseRecoveryEnabled && result.preventLeaseRecovery !== true
    ? statements.releaseReviewLease
    : statements.markFailed;
  withSqliteBusyRetrySync(
    () => terminalFailureStatement.run(failureAt, classifiedMessage, repoPath, prNumber),
    { label: `reviewer-settle-terminal:${repoPath}#${prNumber}`, log }
  );
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
  _log = console.log,
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
  domainPipelineGeminiSeatCount,
  spawnReviewer,
  runWatcherGatedReviewPipeline,
  parsePipelineStageStates,
  settleReviewerAttempt,
  evaluateRoundBudgetForReview,
  truncateCodePoints,
};
