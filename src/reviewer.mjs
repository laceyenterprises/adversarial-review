/**
 * LAC-12 + LAC-13: Reviewer Agent + Linear Integration
 *
 * One-shot: fetch PR diff → adversarial review → post GitHub comment → update Linear.
 *
 * Called by watcher.mjs as a child process:
 *   node src/reviewer.mjs '<JSON args>'
 *
 * Args JSON shape:
 *   { repo, prNumber, reviewerModel, botTokenEnv, linearTicketId, reviewerSessionUuid }
 *
 * ── Auth Policy (NON-NEGOTIABLE) ────────────────────────────────────────────
 * Claude reviews MUST use OAuth (claude CLI), never ANTHROPIC_API_KEY.
 * Codex reviews MUST use OAuth (codex CLI), never OPENAI_API_KEY.
 * If OAuth credentials are missing or expired → STOP and alert Paul via Clio.
 * API key fallback is intentionally NOT implemented here. On Darwin,
 * Claude is launched via `launchctl asuser`, so the wrapped command also
 * explicitly unsets API-key env vars inside the target process.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { writeFileAtomic } from './atomic-write.mjs';
import { apiStatusFromError, recordApiCall } from './api-telemetry.mjs';
import { awaitThrottleIfNeeded } from './rate-limit-throttle.mjs';
import { getCachedDiff, putCachedDiff } from './diff-cache.mjs';
import {
  createFollowUpJob,
  resolveRoundBudgetForJob,
  summarizePRRemediationLedger,
} from './follow-up-jobs.mjs';
import {
  buildObviousDocsGuidance,
  extractLinkedRepoDocs,
  fetchLinkedSpecContents,
  parseGitHubBlobPath,
} from './prompt-context.mjs';
import { captureReviewerBodyAfterPost } from './review-body-capture.mjs';
import { resolveReviewerAppToken } from './reviewer-broker-refresh.mjs';
import { preflightGeminiReviewerToken } from './gemini-reviewer-preflight.mjs';
import { materializePerWorkerCodexAuth } from './codex-per-worker-auth.mjs';
import { clearPendingReviewsForSelf } from './reviewer-pre-write.mjs';
import {
  openReviewerFence,
  resolveAdversarialReviewStateDir,
  resolveSigtermFenceGraceSeconds,
} from './reviewer-fence.mjs';
import { resolveProgressTimeoutMs, resolveReviewerTimeoutMs } from './reviewer-timeout.mjs';
import { spawnCapturedProcessGroup } from './process-group-spawn.mjs';
import { extractReviewVerdict, looksLikeRuntimeJunk, normalizeReviewVerdict, normalizeWhitespace, sanitizeCodexReviewPayload } from './kernel/verdict.mjs';
import { loadStagePrompt, pickReviewerStage } from './kernel/prompt-stage.mjs';
import { createLinearTriageAdapter } from './adapters/operator/linear-triage/index.mjs';
import { OAUTH_ENV_STRIP_LIST, scrubOAuthFallbackEnv } from './secret-source/env.mjs';
import { fetchPullRequestReviewContext } from './github-api.mjs';

const execFileAsync = promisify(execFile);
const REVIEW_POST_RETRY_DELAYS_MS = [0];
const LOCAL_REVIEW_SHADOW_LABEL = 'run-local-review-shadow';
const DEFAULT_LOCAL_REVIEW_SHADOW_MODEL = 'ollama/qwen2.5-coder:32b';
const DEFAULT_LOCAL_REVIEW_SHADOW_TIMEOUT_MS = 120_000;

const MODEL_FAMILY_BY_BUILDER_TAG = Object.freeze({
  '[codex]': 'codex',
  '[claude-code]': 'claude',
  '[clio-agent]': 'codex',
});

const LOCAL_REVIEW_SHADOW_MODEL_METADATA = Object.freeze({
  'ollama/qwen2.5-coder:32b': { family: 'qwen', displayName: 'Qwen2.5 Coder 32B (local OSS)' },
  'ollama/deepseek-coder-v2:latest': { family: 'deepseek', displayName: 'DeepSeek Coder V2 (local OSS)' },
  'ollama/codestral:22b': { family: 'mistral', displayName: 'Codestral 22B (local OSS)' },
  'vllm/qwen2.5-coder-32b-instruct': { family: 'qwen', displayName: 'Qwen2.5 Coder 32B (local OSS)' },
});

const REVIEWER_IDENTITY_BY_BOT_TOKEN_ENV = Object.freeze({
  GH_CLAUDE_REVIEWER_TOKEN: 'claude-reviewer-lacey',
  GH_CODEX_REVIEWER_TOKEN: 'codex-reviewer-lacey',
  GH_GEMINI_REVIEWER_TOKEN: 'gemini-reviewer-lacey',
});

function resolveReviewerIdentityForBotTokenEnv(botTokenEnv, fallbackIdentity = null) {
  return REVIEWER_IDENTITY_BY_BOT_TOKEN_ENV[botTokenEnv] || fallbackIdentity || botTokenEnv;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logStructuredEvent(log, event) {
  const sink = log || console;
  sink.log?.(JSON.stringify(event));
}

function hasLabel(labels, labelName) {
  const wanted = String(labelName || '').trim().toLowerCase();
  return Array.isArray(labels) && labels.some((label) => {
    const value = typeof label === 'string' ? label : label?.name;
    return String(value || '').trim().toLowerCase() === wanted;
  });
}

function safePathSegment(value, fallback = 'unknown') {
  const safe = String(value || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return safe || fallback;
}

function localReviewShadowDir(rootDir = ROOT) {
  return join(rootDir, 'data', 'local-review-shadow');
}

function buildLocalReviewShadowKey({ repo, prNumber, headSha, label = LOCAL_REVIEW_SHADOW_LABEL }) {
  return [
    safePathSegment(repo),
    `pr-${safePathSegment(prNumber)}`,
    safePathSegment(headSha || 'unknown-head'),
    safePathSegment(label),
  ].join('__');
}

function localReviewShadowRequestPath(rootDir, requestKey) {
  return join(localReviewShadowDir(rootDir), 'requests', `${requestKey}.json`);
}

function localReviewShadowArtifactPath(rootDir, requestKey) {
  return join(localReviewShadowDir(rootDir), 'artifacts', `${requestKey}.md`);
}

function readJsonFileIfPresent(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJsonFileAtomic(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function resolveHostedReviewerFamily(reviewerModel) {
  const key = String(reviewerModel || '').trim().toLowerCase();
  if (key === 'claude') return 'claude';
  if (key === 'codex') return 'codex';
  if (key === 'gemini') return 'gemini';
  return null;
}

function resolveBuilderFamily(builderTag) {
  return MODEL_FAMILY_BY_BUILDER_TAG[String(builderTag || '').trim()] || null;
}

function resolveLocalReviewShadowModel(env = process.env) {
  return String(env.ADVERSARIAL_LOCAL_REVIEW_SHADOW_MODEL || env.LOCAL_REVIEW_SHADOW_MODEL || DEFAULT_LOCAL_REVIEW_SHADOW_MODEL).trim();
}

function resolveLocalReviewShadowTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env.ADVERSARIAL_LOCAL_REVIEW_SHADOW_TIMEOUT_MS || env.LOCAL_REVIEW_SHADOW_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOCAL_REVIEW_SHADOW_TIMEOUT_MS;
}

function resolveLocalReviewShadowBaseUrl(env = process.env) {
  const raw = String(env.ADVERSARIAL_LOCAL_REVIEW_SHADOW_LITELLM_URL || env.LITELLM_BASE_URL || '').trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

function resolveLocalReviewShadowModelMetadata(model, modelMetadataByModel = LOCAL_REVIEW_SHADOW_MODEL_METADATA) {
  return modelMetadataByModel[String(model || '').trim()] || null;
}

function evaluateLocalReviewShadowEligibility({
  labels = [],
  builderTag,
  hostedReviewerModel,
  env = process.env,
  modelMetadataByModel = LOCAL_REVIEW_SHADOW_MODEL_METADATA,
} = {}) {
  if (!hasLabel(labels, LOCAL_REVIEW_SHADOW_LABEL)) {
    return { eligible: false, reason: 'label-absent' };
  }

  const localModel = resolveLocalReviewShadowModel(env);
  const localMetadata = resolveLocalReviewShadowModelMetadata(localModel, modelMetadataByModel);
  const localFamily = localMetadata?.family || null;
  const builderFamily = resolveBuilderFamily(builderTag);
  const hostedReviewerFamily = resolveHostedReviewerFamily(hostedReviewerModel);

  if (!localFamily) {
    return {
      eligible: false,
      reason: 'local-family-missing',
      localModel,
      builderFamily,
      hostedReviewerFamily,
    };
  }
  if (!builderFamily) {
    return {
      eligible: false,
      reason: 'builder-family-unproven',
      localModel,
      localFamily,
      builderFamily,
      hostedReviewerFamily,
    };
  }
  if (!hostedReviewerFamily) {
    return {
      eligible: false,
      reason: 'hosted-reviewer-family-unproven',
      localModel,
      localFamily,
      builderFamily,
      hostedReviewerFamily,
    };
  }
  if (localFamily === builderFamily || localFamily === hostedReviewerFamily) {
    return {
      eligible: false,
      reason: 'same-family-comparison',
      localModel,
      localFamily,
      builderFamily,
      hostedReviewerFamily,
    };
  }

  return {
    eligible: true,
    localModel,
    localFamily,
    localDisplayName: localMetadata.displayName,
    builderFamily,
    hostedReviewerFamily,
  };
}

function createOrLoadLocalReviewShadowRequest({
  rootDir = ROOT,
  repo,
  prNumber,
  headSha,
  labels = [],
  builderTag,
  hostedReviewerModel,
  env = process.env,
  now = () => new Date().toISOString(),
  log = console,
} = {}) {
  const eligibility = evaluateLocalReviewShadowEligibility({
    labels,
    builderTag,
    hostedReviewerModel,
    env,
  });

  logStructuredEvent(log, {
    type: 'local-review-shadow',
    phase: 'eligibility',
    repo,
    prNumber,
    headSha: headSha || null,
    label: LOCAL_REVIEW_SHADOW_LABEL,
    hostedReviewerModel,
    builderTag: builderTag || null,
    eligible: eligibility.eligible,
    reason: eligibility.reason || null,
    localModel: eligibility.localModel || null,
    localFamily: eligibility.localFamily || null,
    builderFamily: eligibility.builderFamily || null,
    hostedReviewerFamily: eligibility.hostedReviewerFamily || null,
  });

  if (!eligibility.eligible) {
    return { requested: false, eligibility };
  }

  const requestKey = buildLocalReviewShadowKey({
    repo,
    prNumber,
    headSha,
    label: LOCAL_REVIEW_SHADOW_LABEL,
  });
  const requestPath = localReviewShadowRequestPath(rootDir, requestKey);
  const artifactPath = localReviewShadowArtifactPath(rootDir, requestKey);
  const existing = readJsonFileIfPresent(requestPath);
  if (existing) {
    return {
      requested: true,
      request: existing,
      requestPath,
      artifactPath,
      existing: true,
      eligibility,
    };
  }

  const request = {
    kind: 'local-review-shadow-request',
    version: 1,
    requestKey,
    repo,
    prNumber: Number(prNumber),
    headSha: headSha || null,
    label: LOCAL_REVIEW_SHADOW_LABEL,
    builderTag: builderTag || null,
    builderFamily: eligibility.builderFamily,
    hostedReviewerModel,
    hostedReviewerFamily: eligibility.hostedReviewerFamily,
    localModel: eligibility.localModel,
    localDisplayName: eligibility.localDisplayName,
    localFamily: eligibility.localFamily,
    status: 'requested',
    hostedReviewPosted: false,
    createdAt: now(),
    updatedAt: now(),
    artifactPath,
    nonGating: true,
  };
  writeJsonFileAtomic(requestPath, request);
  logStructuredEvent(log, {
    type: 'local-review-shadow',
    phase: 'request-recorded',
    repo,
    prNumber,
    headSha: headSha || null,
    requestKey,
    requestPath,
  });
  return { requested: true, request, requestPath, artifactPath, existing: false, eligibility };
}

function buildLocalReviewShadowPrompt({ diff, extraContext = '', hostedReviewerModel, repo, prNumber }) {
  return [
    'You are a local OSS model producing a non-gating shadow review artifact.',
    'Do not claim to be Codex, Claude, Gemini, or the official adversarial reviewer.',
    'Do not produce a merge-blocking verdict. Focus on independent observations that may help operators compare reviewer behavior.',
    `Repository: ${repo}`,
    `PR: #${prNumber}`,
    `Hosted reviewer already posted: ${hostedReviewerModel}`,
    '',
    extraContext || '',
    '',
    'PR diff:',
    '```diff',
    diff,
    '```',
  ].join('\n');
}

async function runLocalReviewShadowViaLiteLLM({
  request,
  diff,
  extraContext = '',
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
} = {}) {
  const baseUrl = resolveLocalReviewShadowBaseUrl(env);
  if (!baseUrl) {
    return {
      ok: false,
      retryable: true,
      reason: 'litellm-base-url-missing',
      message: 'ADVERSARIAL_LOCAL_REVIEW_SHADOW_LITELLM_URL or LITELLM_BASE_URL is not set',
      completedAt: now(),
    };
  }
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      retryable: true,
      reason: 'fetch-unavailable',
      message: 'global fetch is unavailable',
      completedAt: now(),
    };
  }

  const timeoutMs = resolveLocalReviewShadowTimeoutMs(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const prompt = buildLocalReviewShadowPrompt({
    diff,
    extraContext,
    hostedReviewerModel: request.hostedReviewerModel,
    repo: request.repo,
    prNumber: request.prNumber,
  });

  try {
    const token = String(env.ADVERSARIAL_LOCAL_REVIEW_SHADOW_LITELLM_TOKEN || env.LITELLM_API_KEY || '').trim();
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: request.localModel,
        messages: [
          { role: 'system', content: 'Produce a concise non-gating local OSS model shadow code review.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        retryable: response.status >= 429 || response.status >= 500,
        reason: 'litellm-http-error',
        status: response.status,
        message: text.slice(0, 1000),
        completedAt: now(),
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return {
        ok: false,
        retryable: true,
        reason: 'litellm-invalid-json',
        message: err.message,
        completedAt: now(),
      };
    }
    const content = String(parsed?.choices?.[0]?.message?.content || '').trim();
    if (!content) {
      return {
        ok: false,
        retryable: true,
        reason: 'litellm-empty-output',
        message: 'LiteLLM returned no message content',
        completedAt: now(),
      };
    }
    return {
      ok: true,
      reviewText: content,
      usage: parsed?.usage || null,
      completedAt: now(),
      timeoutMs,
    };
  } catch (err) {
    return {
      ok: false,
      retryable: true,
      reason: err?.name === 'AbortError' ? 'local-shadow-timeout' : 'litellm-request-failed',
      message: err?.message || String(err),
      completedAt: now(),
      timeoutMs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function renderLocalReviewShadowArtifact({ request, reviewText, completedAt }) {
  return [
    '## Local Review Shadow (non-gating)',
    '',
    `Provenance: generated by local OSS model \`${request.localModel}\` via LiteLLM.`,
    `Scope: shadow comparison artifact only; this is not the hosted adversarial reviewer verdict and does not affect the merge gate.`,
    `Hosted reviewer already posted: \`${request.hostedReviewerModel}\`.`,
    `Request key: \`${request.requestKey}\`.`,
    `Completed at: ${completedAt}.`,
    '',
    reviewText.trim(),
    '',
  ].join('\n');
}

async function reconcileLocalReviewShadow({
  rootDir = ROOT,
  request,
  requestPath,
  artifactPath,
  hostedReviewPosted = false,
  hostedReviewPostedAt = null,
  diff,
  extraContext = '',
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
  log = console,
} = {}) {
  if (!request?.requestKey) {
    return { completed: false, reason: 'request-missing' };
  }

  const effectiveRequestPath = requestPath || localReviewShadowRequestPath(rootDir, request.requestKey);
  const effectiveArtifactPath = artifactPath || request.artifactPath || localReviewShadowArtifactPath(rootDir, request.requestKey);
  const current = readJsonFileIfPresent(effectiveRequestPath) || request;

  if (existsSync(effectiveArtifactPath)) {
    const updated = {
      ...current,
      status: 'completed',
      hostedReviewPosted: current.hostedReviewPosted || Boolean(hostedReviewPosted),
      hostedReviewPostedAt: current.hostedReviewPostedAt || hostedReviewPostedAt || null,
      artifactPath: effectiveArtifactPath,
      updatedAt: now(),
    };
    writeJsonFileAtomic(effectiveRequestPath, updated);
    return { completed: true, alreadyCompleted: true, artifactPath: effectiveArtifactPath, request: updated };
  }

  if (!hostedReviewPosted && !current.hostedReviewPosted) {
    return { completed: false, reason: 'hosted-review-not-posted' };
  }

  const marked = {
    ...current,
    hostedReviewPosted: true,
    hostedReviewPostedAt: current.hostedReviewPostedAt || hostedReviewPostedAt || now(),
    status: 'running',
    updatedAt: now(),
  };
  writeJsonFileAtomic(effectiveRequestPath, marked);
  logStructuredEvent(log, {
    type: 'local-review-shadow',
    phase: 'run-started',
    repo: marked.repo,
    prNumber: marked.prNumber,
    headSha: marked.headSha,
    requestKey: marked.requestKey,
    localModel: marked.localModel,
  });

  const result = await runLocalReviewShadowViaLiteLLM({
    request: marked,
    diff,
    extraContext,
    env,
    fetchImpl,
    now,
  });

  if (!result.ok) {
    const failed = {
      ...marked,
      status: result.retryable ? 'retryable-skip' : 'skipped',
      lastError: {
        reason: result.reason,
        message: result.message,
        status: result.status || null,
        retryable: Boolean(result.retryable),
        at: result.completedAt,
      },
      updatedAt: now(),
    };
    writeJsonFileAtomic(effectiveRequestPath, failed);
    log.warn?.(`[reviewer] WARNING local-review-shadow skipped for ${marked.repo}#${marked.prNumber}: ${result.reason} ${result.message || ''}`.trim());
    logStructuredEvent(log, {
      type: 'local-review-shadow',
      phase: 'run-skipped',
      repo: marked.repo,
      prNumber: marked.prNumber,
      headSha: marked.headSha,
      requestKey: marked.requestKey,
      reason: result.reason,
      retryable: Boolean(result.retryable),
    });
    return { completed: false, reason: result.reason, retryable: Boolean(result.retryable), request: failed };
  }

  const artifact = renderLocalReviewShadowArtifact({
    request: marked,
    reviewText: result.reviewText,
    completedAt: result.completedAt,
  });
  writeFileAtomic(effectiveArtifactPath, artifact, { mode: 0o600 });
  const completed = {
    ...marked,
    status: 'completed',
    artifactPath: effectiveArtifactPath,
    completedAt: result.completedAt,
    usage: result.usage,
    updatedAt: now(),
  };
  writeJsonFileAtomic(effectiveRequestPath, completed);
  logStructuredEvent(log, {
    type: 'local-review-shadow',
    phase: 'artifact-recorded',
    repo: marked.repo,
    prNumber: marked.prNumber,
    headSha: marked.headSha,
    requestKey: marked.requestKey,
    artifactPath: effectiveArtifactPath,
  });
  return { completed: true, artifactPath: effectiveArtifactPath, request: completed };
}

async function spawnWithInput(command, args, {
  env,
  cwd,
  input = '',
  timeout = 0,
  progressTimeout = resolveProgressTimeoutMs(env),
  killGraceMs,
  maxBuffer = 10 * 1024 * 1024,
  signal,
} = {}) {
  return spawnCapturedProcessGroup(command, args, {
    env,
    cwd,
    input,
    timeout,
    progressTimeout,
    killGraceMs,
    maxBuffer,
    signal,
  });
}

async function spawnCaptured(command, args, {
  env,
  cwd,
  timeout = 0,
  progressTimeout = resolveProgressTimeoutMs(env),
  killGraceMs,
  maxBuffer = 10 * 1024 * 1024,
  signal,
} = {}) {
  return spawnWithInput(command, args, {
    env,
    cwd,
    input: '',
    timeout,
    progressTimeout,
    killGraceMs,
    maxBuffer,
    signal,
  });
}

// ── CLI paths ────────────────────────────────────────────────────────────────

// Claude Code CLI — runs as the current user.
// Must NOT have ANTHROPIC_API_KEY in env when validating or invoking,
// otherwise the CLI may report API-key auth instead of its native login state.
const DEFAULT_CLAUDE_CLI = '/opt/homebrew/bin/claude';
const CLAUDE_CLI = resolveClaudeCliPath();
const LAUNCHCTL = '/bin/launchctl';
const ENV_BIN = '/usr/bin/env';
const CLAUDE_STRIPPED_ENV_VARS = OAUTH_ENV_STRIP_LIST;

// ACPX-local Codex adapter path. The reviewer keeps wrapper-owned completion
// semantics: ACPX/Codex does the work, and the outer wrapper owns parsing /
// posting / downstream side effects. Today the handoff is ACPX stdout capture;
// explicit file-artifact handoff remains a valid future refinement.
const MAINTAINER_ACPX_CLI = join(homedir(), '.openclaw', 'tools', 'acpx', 'node_modules', '.bin', 'acpx');

// Raw Codex CLI is still used only for login-status probing.
const CODEX_CLI = resolveCodexCliPath();

// Native Gemini CLI — used for adversarial reviews when reviewerModel='gemini'.
// Like Claude/Codex, it MUST authenticate via OAuth (~/.gemini/oauth_creds.json);
// GEMINI_API_KEY / GOOGLE_API_KEY are scrubbed from the env before invoking.
const GEMINI_CLI = resolveGeminiCliPath();

// OPENAI_API_KEY is stripped from env so Codex cannot fall back to API-key auth.

function resolveClaudeAuthProbeTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env.CLAUDE_AUTH_PROBE_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000;
}

function findOnPath(binaryName, pathValue = process.env.PATH || '') {
  for (const dir of pathValue.split(':').filter(Boolean)) {
    const candidate = join(dir, binaryName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveClaudeCliPath(env = process.env) {
  return env.CLAUDE_CLI_PATH || env.CLAUDE_CLI || findOnPath('claude', env.PATH) || DEFAULT_CLAUDE_CLI;
}

function resolveCodexCliPath(env = process.env) {
  return env.CODEX_CLI_PATH || env.CODEX_CLI || findOnPath('codex', env.PATH) || 'codex';
}

function resolveGeminiCliPath(env = process.env) {
  return env.GEMINI_CLI_PATH || env.GEMINI_CLI || findOnPath('gemini', env.PATH) || 'gemini';
}

function resolveAcpxCliPath({ env = process.env, preferLocalAcpx = false } = {}) {
  if (env.ACPX_CLI) return env.ACPX_CLI;
  if (env.ACPX_CLI_PATH) return env.ACPX_CLI_PATH;
  const fromPath = findOnPath('acpx', env.PATH);
  if (fromPath) return fromPath;
  return preferLocalAcpx ? MAINTAINER_ACPX_CLI : 'acpx';
}

// ── OAuth credential checks ──────────────────────────────────────────────────

/**
 * Verify Claude auth is available through the CLI's native login state.
 *
 * IMPORTANT: strip ANTHROPIC_API_KEY from env before probing, otherwise
 * `claude auth status` may report API-key mode and mask the real login state.
 */
async function assertClaudeOAuth() {
  if (!existsSync(CLAUDE_CLI)) {
    throw new OAuthError('claude', `claude CLI not found at ${CLAUDE_CLI}`);
  }

  const { env } = scrubOAuthFallbackEnv(process.env);

  let stdout = '';
  let stderr = '';
  try {
    ({ stdout, stderr } = await spawnClaude(
      ['auth', 'status'],
      { env, timeout: resolveClaudeAuthProbeTimeoutMs(env) }
    ));
  } catch (err) {
    if (err?.isLaunchctlSessionError) {
      throw err;
    }
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    const msg = `${err.message || ''}\n${stdout}\n${stderr}`.toLowerCase();
    if (msg.includes('"loggedin": false') || msg.includes('not logged in') || msg.includes('login required') || msg.includes('unauthorized')) {
      throw new OAuthError('claude', `Claude CLI reports not logged in: ${(stdout || stderr || err.message).trim()}`);
    }
    throw new OAuthError('claude', `Claude auth probe failed: ${(stdout || stderr || err.message).trim()}`);
  }

  const text = `${stdout || ''}\n${stderr || ''}`.toLowerCase();
  if (text.includes('"loggedin": false') || text.includes('not logged in') || text.includes('login required')) {
    throw new OAuthError('claude', `Claude CLI reports not logged in: ${(stdout || stderr).trim()}`);
  }
}

async function spawnClaude(args, options = {}) {
  const {
    execFileImpl = execFileAsync,
    platform = process.platform,
    uid = typeof process.getuid === 'function' ? process.getuid() : null,
    ...execOptions
  } = options;

  if (platform === 'darwin') {
    if (!Number.isInteger(uid) || uid <= 0) {
      throw new Error('Cannot resolve a non-root user uid for launchctl asuser');
    }

    try {
      const command = LAUNCHCTL;
      const commandArgs = [
        'asuser',
        String(uid),
        ENV_BIN,
        ...CLAUDE_STRIPPED_ENV_VARS.flatMap((name) => ['-u', name]),
        CLAUDE_CLI,
        ...args,
      ];
      if (execFileImpl === execFileAsync) {
        return await spawnCapturedProcessGroup(command, commandArgs, execOptions);
      }
      return await execFileImpl(command, commandArgs, execOptions);
    } catch (err) {
      const details = formatChildProcessFailureDetails(err);
      if (!isClaudeLoggedOutStatus(details) && isLaunchctlSessionFailure(details)) {
        throw new LaunchctlSessionError(details.trim(), { cause: err, stdout: err?.stdout, stderr: err?.stderr });
      }
      throw err;
    }
  }

  if (execFileImpl === execFileAsync) {
    return spawnCapturedProcessGroup(CLAUDE_CLI, args, execOptions);
  }
  return execFileImpl(CLAUDE_CLI, args, execOptions);
}

function resolveCodexAuthPath() {
  // CODEX_AUTH_PATH env var allows explicit override. CODEX_HOME supports
  // local/manual runs only when it points at a usable OAuth auth.json.
  // Prefer the current operator's default auth location before falling back
  // to the legacy split-user bridge where the watcher runs as airlock but
  // Codex OAuth belongs to placey.
  if (process.env.CODEX_AUTH_PATH) return process.env.CODEX_AUTH_PATH;
  if (process.env.CODEX_HOME) {
    const codexHomeAuth = join(process.env.CODEX_HOME, 'auth.json');
    if (isCodexOAuthAuthFile(codexHomeAuth)) return codexHomeAuth;
  }
  if (process.env.HOME) {
    const homeAuth = join(process.env.HOME, '.codex', 'auth.json');
    if (existsSync(homeAuth) || !existsSync('/Users/placey/.codex/auth.json')) return homeAuth;
  }
  return '/Users/placey/.codex/auth.json';
}

function isCodexOAuthAuthFile(authPath) {
  if (!existsSync(authPath)) return false;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(authPath, 'utf8'));
  } catch {
    return false;
  }
  return (
    (parsed?.auth_mode || '').toLowerCase() === 'chatgpt' &&
    Boolean(parsed?.tokens?.access_token) &&
    Boolean(parsed?.tokens?.refresh_token)
  );
}

/**
 * Verify the intended Codex auth.json exists, is readable, and is OAuth/chatgpt mode.
 * This reads the file directly rather than trusting CLI commands that may be unavailable.
 */
function assertCodexAuthReadable() {
  const authPath = resolveCodexAuthPath();
  if (!existsSync(authPath)) {
    throw new OAuthError('codex', `OAuth auth.json missing: ${authPath}`);
  }

  let raw;
  try {
    raw = readFileSync(authPath, 'utf8');
  } catch (err) {
    throw new OAuthError('codex', `cannot read ${authPath}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OAuthError('codex', `invalid auth.json at ${authPath}: ${err.message}`);
  }

  if ((parsed?.auth_mode || '').toLowerCase() !== 'chatgpt') {
    throw new OAuthError('codex', `Codex auth file is not OAuth/chatgpt mode (found: ${parsed?.auth_mode}): ${authPath}`);
  }

  if (!parsed?.tokens?.access_token || !parsed?.tokens?.refresh_token) {
    throw new OAuthError('codex', `Codex auth.json missing required OAuth tokens: ${authPath}`);
  }

  return authPath;
}

async function assertCodexOAuth() {
  if (!existsSync(CODEX_CLI)) {
    throw new OAuthError('codex', `codex CLI not found at ${CODEX_CLI}`);
  }

  // Verify auth.json is readable and contains valid OAuth tokens.
  // This is more reliable than CLI probes, which may not support `login status`.
  assertCodexAuthReadable();
}

// ── Gemini OAuth checks ──────────────────────────────────────────────────────

/**
 * Resolve the Gemini OAuth credential file. Mirrors the worker adapter
 * contract (`modules/worker-pool/lib/adapters/acpx-gemini.sh`): a pinned
 * HOME holds a private `~/.gemini/oauth_creds.json`. GEMINI_OAUTH_CREDS_PATH
 * overrides explicitly; GEMINI_HOME (when set) points at the `.gemini` dir.
 */
function resolveGeminiOAuthCredsPath(env = process.env) {
  if (env.GEMINI_OAUTH_CREDS_PATH) return env.GEMINI_OAUTH_CREDS_PATH;
  const geminiHome = env.GEMINI_HOME || join(env.HOME || homedir(), '.gemini');
  return join(geminiHome, 'oauth_creds.json');
}

/**
 * Verify the Gemini OAuth creds file exists, is readable, and carries an
 * access token. Reads the file directly rather than trusting CLI probes,
 * matching assertCodexAuthReadable.
 */
function assertGeminiAuthReadable(env = process.env) {
  const credsPath = resolveGeminiOAuthCredsPath(env);
  if (!existsSync(credsPath)) {
    throw new OAuthError('gemini', `OAuth oauth_creds.json missing: ${credsPath}`);
  }

  let raw;
  try {
    raw = readFileSync(credsPath, 'utf8');
  } catch (err) {
    throw new OAuthError('gemini', `cannot read ${credsPath}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OAuthError('gemini', `invalid oauth_creds.json at ${credsPath}: ${err.message}`);
  }

  if (!parsed?.access_token) {
    throw new OAuthError('gemini', `Gemini oauth_creds.json missing access_token: ${credsPath}`);
  }

  return credsPath;
}

async function assertGeminiOAuth(env = process.env) {
  if (!existsSync(GEMINI_CLI)) {
    throw new OAuthError('gemini', `gemini CLI not found at ${GEMINI_CLI}`);
  }

  // Verify oauth_creds.json is readable and carries an access token.
  assertGeminiAuthReadable(env);
}

/**
 * Custom error class for OAuth failures — triggers Clio alert in main().
 */
class OAuthError extends Error {
  constructor(model, reason) {
    super(`[OAuth] ${model} credentials unavailable: ${reason}`);
    this.model = model;
    this.isOAuthError = true;
  }
}

class LaunchctlSessionError extends Error {
  constructor(reason, { cause, stdout = '', stderr = '' } = {}) {
    super(`Claude launchctl session bootstrap failed: ${reason}`);
    this.name = 'LaunchctlSessionError';
    this.cause = cause;
    this.stdout = stdout;
    this.stderr = stderr;
    this.isLaunchctlSessionError = true;
  }
}

// ── Utility functions ────────────────────────────────────────────────────────

function stripCodexRuntimeNoise(text) {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');

  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    return !(
      /^warning:\s+proceeding, even though we could not update path:/i.test(trimmed) ||
      /^reading prompt from stdin/i.test(trimmed) ||
      /^reading additional input from stdin/i.test(trimmed) ||
      /^openai codex v/i.test(trimmed) ||
      /^model:/i.test(trimmed) ||
      /^cwd:/i.test(trimmed) ||
      /^approval:/i.test(trimmed) ||
      /^sandbox:/i.test(trimmed) ||
      /^reasoning:/i.test(trimmed)
    );
  });

  return filtered.join('\n').trim();
}

function previewText(text, limit = 200) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '<empty>';
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

// LAC-545: forensic preservation of codex outputs that the sanitizer
// rejects. Persists into `data/codex-review-rejected/` with a stable
// `<owner>__<repo>__pr-<N>__<iso>.md` name. The directory is gitignored
// so the forensic snapshots don't accumulate into the repo. Capped at
// 50 KB per file so a runaway codex output can't fill the disk.
const REJECTED_CODEX_OUTPUT_CAP_BYTES = 50 * 1024;

function persistRejectedCodexOutput({ repo, prNumber, rejectionReason, rawReviewText }) {
  // Resolve the persistence directory relative to this module so the
  // path is stable whether the watcher is running from a worktree or
  // from the deploy checkout.
  const rootDir = join(
    fileURLToPath(import.meta.url),
    '..',
    '..',
    'data',
    'codex-review-rejected'
  );
  mkdirSync(rootDir, { recursive: true });
  const safeRepo = String(repo || 'unknown')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 80);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${safeRepo}__pr-${prNumber}__${ts}.md`;
  const filePath = join(rootDir, fileName);
  const header = [
    `<!-- LAC-545 forensic dump of codex output that sanitizeCodexReviewPayload rejected -->`,
    `<!-- repo: ${repo} -->`,
    `<!-- prNumber: ${prNumber} -->`,
    `<!-- rejectedAt: ${new Date().toISOString()} -->`,
    `<!-- rejectionReason: ${String(rejectionReason || '').slice(0, 400)} -->`,
    `<!-- rawLengthBytes: ${Buffer.byteLength(String(rawReviewText || ''), 'utf8')} -->`,
    '',
  ].join('\n');
  const truncated = String(rawReviewText || '').slice(0, REJECTED_CODEX_OUTPUT_CAP_BYTES);
  const truncationNotice = String(rawReviewText || '').length > REJECTED_CODEX_OUTPUT_CAP_BYTES
    ? `\n\n<!-- truncated to ${REJECTED_CODEX_OUTPUT_CAP_BYTES} bytes -->\n`
    : '';
  writeFileSync(filePath, `${header}${truncated}${truncationNotice}`, { encoding: 'utf8', mode: 0o600 });
  console.error(`[reviewer] persisted rejected codex output: ${filePath}`);
  return filePath;
}

function formatChildProcessFailureDetails(err) {
  return [
    err?.message || '',
    `code=${err?.code ?? '<none>'} exitCode=${err?.exitCode ?? '<none>'} signal=${err?.signal ?? '<none>'} killed=${err?.killed === true}`,
    err?.stdout ? `stdout:\n${err.stdout}` : '',
    err?.stderr ? `stderr:\n${err.stderr}` : '',
  ].filter(Boolean).join('\n');
}

function isLaunchctlSessionFailure(text) {
  return /(launchctl|bootstrap failed|could not find domain|input\/output error|not privileged to set domain|gui\/\d+)/i.test(String(text ?? ''));
}

function isClaudeLoggedOutStatus(text) {
  return /"loggedin"\s*:\s*false|"authmethod"\s*:\s*"none"/i.test(String(text ?? ''));
}

// ── Adversarial prompt (NON-NEGOTIABLE) ──────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const REVIEWER_PROMPT_SET = 'code-pr';
const ADVERSARIAL_PROMPT = loadStagePrompt({
  rootDir: ROOT,
  promptSet: REVIEWER_PROMPT_SET,
  actor: 'reviewer',
  stage: 'first',
});

const ADVERSARIAL_PROMPT_FINAL_ROUND = loadStagePrompt({
  rootDir: ROOT,
  promptSet: REVIEWER_PROMPT_SET,
  actor: 'reviewer',
  stage: 'last',
});
const ADVERSARIAL_PROMPT_FINAL_ROUND_ADDENDUM = readFileSync(
  join(ROOT, 'prompts', REVIEWER_PROMPT_SET, 'reviewer.last.addendum.md'),
  'utf8',
).trim();

function buildReviewerPromptPrefix({
  isFinalRound = false,
  stage,
  reviewAttemptNumber,
  completedRemediationRounds,
  maxRemediationRounds,
} = {}) {
  const inferredCompletedRemediationRounds = completedRemediationRounds ?? (
    Number.isFinite(Number(reviewAttemptNumber)) ? Number(reviewAttemptNumber) - 1 : undefined
  );
  const selectedStage = stage || (
    isFinalRound
      ? 'last'
      : (reviewAttemptNumber !== undefined || completedRemediationRounds !== undefined || maxRemediationRounds !== undefined)
        ? pickReviewerStage({
            reviewAttemptNumber,
            completedRemediationRounds: inferredCompletedRemediationRounds,
            maxRemediationRounds,
          })
        : 'first'
  );

  return loadStagePrompt({
    rootDir: ROOT,
    promptSet: REVIEWER_PROMPT_SET,
    actor: 'reviewer',
    stage: selectedStage,
  });
}

// Compute whether the current review attempt is the final one allowed
// under the bounded remediation cap. Convention:
//   reviewAttemptNumber=1 = initial review, no remediation done yet
//   reviewAttemptNumber=N = N-1 remediation rounds completed
// So when reviewAttemptNumber > maxRemediationRounds, the reviewer is
// looking at the work after the last remediation cycle and there are
// no more rounds left to fix anything blocked here. That is the
// "lenient threshold" round.
function isFinalReviewRound({ reviewAttemptNumber, maxRemediationRounds }) {
  const attempt = Number(reviewAttemptNumber);
  const cap = Number(maxRemediationRounds);
  if (!Number.isFinite(attempt) || attempt <= 0) return false;
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return attempt > cap;
}

function parseDiffFiles(diffText) {
  const diff = String(diffText ?? '').replace(/\r\n/g, '\n');
  const matches = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  return matches.map((match, index) => {
    const oldPath = match[1];
    const newPath = match[2];
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? (matches[index + 1].index ?? diff.length) : diff.length;
    return {
      oldPath,
      newPath,
      path: newPath === '/dev/null' ? oldPath : newPath,
      patch: diff.slice(start, end),
    };
  });
}

function deriveSpecTouchProject(path) {
  const normalizedPath = String(path ?? '');
  let match = normalizedPath.match(/^(?:projects|modules|tools)\/([^/]+)\/SPEC\.md$/);
  if (match) return match[1];
  match = normalizedPath.match(/^docs\/(?:SPEC|RUNBOOK)-(.+?)\.md$/);
  if (match) return match[1];
  return null;
}

function specTouchMatchesProject(path, project) {
  if (!path || !project) return false;
  const normalizedPath = String(path);
  const normalizedProject = String(project);
  return (
    normalizedPath === `projects/${normalizedProject}/SPEC.md` ||
    normalizedPath === `modules/${normalizedProject}/SPEC.md` ||
    normalizedPath === `tools/${normalizedProject}/SPEC.md` ||
    normalizedPath === `docs/SPEC-${normalizedProject}.md` ||
    normalizedPath.startsWith(`docs/SPEC-${normalizedProject}-`) ||
    normalizedPath === `docs/RUNBOOK-${normalizedProject}.md` ||
    normalizedPath.startsWith(`docs/RUNBOOK-${normalizedProject}-`)
  );
}

function describeTrackedContractChange({ path, patch }) {
  if (/^platform\/session-ledger\/src\/.*\.py$/.test(path)) {
    const signatureMatch = patch.match(/^[+-]def\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/m);
    if (signatureMatch) {
      return {
        project: 'session-ledger',
        thing: `public Python signature \`${signatureMatch[1]}(...)\` in \`${path}\``,
      };
    }
  }

  if (/^modules\/([^/]+)\/(?:lib\/python|lib|server)\/.*\.py$/.test(path)) {
    const project = path.match(/^modules\/([^/]+)\//)?.[1];
    const signatureMatch = patch.match(/^[+-]def\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/m);
    if (project && signatureMatch) {
      return {
        project,
        thing: `public Python signature \`${signatureMatch[1]}(...)\` in \`${path}\``,
      };
    }
  }

  if (/^platform\/session-ledger\/src\/session_ledger\/migrations\/.+\.sql$/.test(path)) {
    return {
      project: 'session-ledger',
      thing: `SQL migration \`${path}\``,
    };
  }

  if (/worker_events/i.test(path)) {
    return {
      project: path.match(/^modules\/([^/]+)\//)?.[1] || 'worker-pool',
      thing: `worker_events payload shape in \`${path}\``,
    };
  }

  if (/^modules\/worker-pool\/bin\/hq(?:-[^/]+)?$/.test(path)) {
    return {
      project: 'worker-pool',
      thing: `CLI contract in \`${path}\``,
    };
  }

  return null;
}

function detectSpecTouchViolations(diffText) {
  const files = parseDiffFiles(diffText);
  const touchedSpecProjects = new Set(
    files
      .map((file) => deriveSpecTouchProject(file.path))
      .filter(Boolean)
  );

  const violations = [];
  for (const file of files) {
    const contract = describeTrackedContractChange(file);
    if (!contract) continue;

    const publicSignatureNames = [...file.patch.matchAll(/^[+-]def\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/gm)].map((match) => match[1]);
    if (publicSignatureNames.length > 0 && publicSignatureNames.every((name) => name.startsWith('_'))) {
      continue;
    }

    const specTouched =
      touchedSpecProjects.has(contract.project) ||
      files.some((candidate) => specTouchMatchesProject(candidate.path, contract.project));
    if (specTouched) continue;

    violations.push({
      project: contract.project,
      thing: contract.thing,
      message: `Contract changed without spec update. The diff modifies ${contract.thing} but no canonical spec doc for \`${contract.project}\` was touched. The default remediation is to update the corresponding SPEC/RUNBOOK entry to match the new behavior; revert only for a concrete production regression or an explicit operator-policy conflict.`,
    });
  }

  return violations;
}

// ── Critical-issue detection ─────────────────────────────────────────────────

const CRITICAL_WORDS = ['critical', 'vulnerability', 'security', 'injection'];

function isCritical(reviewText) {
  const lower = reviewText.toLowerCase();
  return CRITICAL_WORDS.some((w) => lower.includes(w));
}

function shouldQueueFollowUpForReview(reviewText) {
  return Boolean(reviewText);
}

function queueFollowUpForPostedReview({
  rootDir = ROOT,
  repo,
  prNumber,
  baseBranch,
  revisionRef = null,
  reviewerModel,
  builderTag = null,
  linearTicketId = null,
  reviewText,
  reviewPostedAt = new Date().toISOString(),
  critical = false,
  summarizePRRemediationLedgerImpl = summarizePRRemediationLedger,
  createFollowUpJobImpl = createFollowUpJob,
}) {
  if (!shouldQueueFollowUpForReview(reviewText)) {
    return { queued: false, reason: 'empty-review-body' };
  }
  if (typeof baseBranch !== 'string' || baseBranch.trim() === '') {
    throw new Error('baseBranch is required to queue a follow-up handoff');
  }

  const priorLedger = summarizePRRemediationLedgerImpl(rootDir, { repo, prNumber });
  const tierResolution = resolveRoundBudgetForJob({ linearTicketId }, {
    rootDir,
    preferPersisted: false,
  });
  const latestMaxRounds = Number(priorLedger.latestMaxRounds);
  const elevatedPriorCap = Number.isInteger(latestMaxRounds) && latestMaxRounds > tierResolution.roundBudget
    ? latestMaxRounds
    : null;

  const { jobPath } = createFollowUpJobImpl({
    rootDir,
    repo,
    prNumber,
    baseBranch: baseBranch.trim(),
    revisionRef: revisionRef || null,
    reviewerModel,
    builderTag: builderTag || null,
    linearTicketId,
    reviewBody: reviewText,
    reviewPostedAt,
    critical,
    riskClass: tierResolution.riskClass,
    priorCompletedRounds: priorLedger.completedRoundsForPR,
    ...(elevatedPriorCap ? { maxRemediationRounds: elevatedPriorCap } : {}),
  });
  return { queued: true, jobPath };
}

// ── PR diff fetch ────────────────────────────────────────────────────────────

async function fetchPRDiff(repo, prNumber, headSha, {
  execFileImpl = execFileAsync,
  getCachedDiffImpl = getCachedDiff,
  putCachedDiffImpl = putCachedDiff,
  recordApiCallImpl = recordApiCall,
  apiStatusFromErrorImpl = apiStatusFromError,
  log = console,
} = {}) {
  const cacheLookupStartedAt = Date.now();
  const cached = headSha ? getCachedDiffImpl(repo, prNumber, headSha) : null;
  if (cached) {
    recordApiCallImpl({
      category: 'cache_hit_diff_fetch',
      repo,
      prNumber,
      status: 'hit',
      durationMs: Date.now() - cacheLookupStartedAt,
    });
    return cached.bytes;
  }

  const startedAt = Date.now();
  try {
    const { stdout } = await execFileImpl(
      'gh',
      ['pr', 'diff', String(prNumber), '--repo', repo],
      { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }
    );
    recordApiCallImpl({
      category: 'diff_fetch',
      repo,
      prNumber,
      status: 200,
      durationMs: Date.now() - startedAt,
    });
    if (headSha) {
      try {
        putCachedDiffImpl(repo, prNumber, headSha, stdout);
      } catch (err) {
        log.warn?.(`[reviewer] WARN: failed to write diff cache for ${repo}#${prNumber}@${headSha}: ${err?.message || err}`);
      }
    }
    return stdout;
  } catch (err) {
    recordApiCallImpl({
      category: 'diff_fetch',
      repo,
      prNumber,
      status: apiStatusFromErrorImpl(err),
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}

async function fetchPRContext(repo, prNumber) {
  return fetchPullRequestReviewContext(repo, prNumber, {
    execFileImpl: execFileAsync,
    recordApiCallImpl: recordApiCall,
  });
}

// ── AI review via CLI (OAuth only) ──────────────────────────────────────────

/**
 * Run adversarial review using Claude Code CLI (OAuth).
 * ANTHROPIC_API_KEY is explicitly removed from the env so the CLI
 * uses its native OAuth path only. Preflight auth validation is aligned with
 * the broker/Keychain path used by the live stack.
 */
async function reviewWithClaude(diff, extraContext = '', { promptStage = 'first' } = {}) {
  await assertClaudeOAuth();

  const promptPrefix = buildReviewerPromptPrefix({ stage: promptStage });
  const prompt = `${promptPrefix}${extraContext}\n\n---\n\nHere is the PR diff to review:\n\n\`\`\`diff\n${diff}\`\`\``;

  // Strip API key from env — Claude CLI falls back to OAuth when it's absent
  const { env } = scrubOAuthFallbackEnv(process.env);

  let stdout, stderr;
  try {
    ({ stdout, stderr } = await spawnClaude(
      buildClaudeReviewArgs(prompt),
      {
        env,
        timeout: resolveReviewerTimeoutMs(env),
        maxBuffer: 10 * 1024 * 1024,
      }
    ));
  } catch (err) {
    if (err?.isLaunchctlSessionError) {
      throw err;
    }
    // Detect OAuth expiry in error output
    const msg = (err.message || '') + (err.stderr || '');
    if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('oauth') || msg.includes('login')) {
      throw new OAuthError('claude', `CLI returned auth error: ${msg.substring(0, 200)}`);
    }
    throw err;
  }

  if (!stdout?.trim()) {
    const hint = stderr?.trim() ? ` stderr: ${stderr.substring(0, 200)}` : '';
    throw new Error(`Claude CLI returned empty output.${hint}`);
  }

  return stdout.trim();
}

function buildClaudeReviewArgs(prompt) {
  return ['--print', '--permission-mode', 'bypassPermissions', prompt];
}

const CODEX_EXEC_CONFIG_FORWARD_KEYS = [
  'model',
  'model_provider',
  'model_reasoning_effort',
];

function stripTomlInlineComment(rawValue) {
  const text = String(rawValue || '');
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === '\'') && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (char === '#' && !quote) return text.slice(0, index);
  }
  return text;
}

function parseCodexConfigLiteralString(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return null;
  const quote = value[0];
  if ((quote === '"' || quote === '\'') && value.endsWith(quote)) {
    const unquoted = value.slice(1, -1);
    if (quote === '"') return unquoted.replaceAll('\\"', '"').replaceAll('\\\\', '\\');
    return unquoted;
  }
  return value;
}

function readCodexConfigTopLevelValues(keys, {
  configPath = join(process.env.CODEX_HOME || join(process.env.HOME || homedir(), '.codex'), 'config.toml'),
} = {}) {
  const keySet = new Set(keys);
  const values = {};
  if (!existsSync(configPath)) return values;
  let currentSection = null;
  for (const rawLine of readFileSync(configPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim() || null;
      continue;
    }
    if (currentSection) continue;
    const match = rawLine.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (!match || !keySet.has(match[1])) continue;
    const parsed = parseCodexConfigLiteralString(stripTomlInlineComment(match[2]));
    if (parsed !== null) values[match[1]] = parsed;
  }
  return values;
}

function resolveCodexExecOverrides() {
  const values = readCodexConfigTopLevelValues(CODEX_EXEC_CONFIG_FORWARD_KEYS);
  const configOverrides = Object.entries(values)
    .filter(([key]) => key !== 'model')
    .map(([key, value]) => ({ key, value }));
  return {
    model: values.model || null,
    modelProvider: values.model_provider || null,
    configOverrides,
  };
}

function formatCodexConfigOverride({ key, value }) {
  return `${key}="${String(value).replaceAll('"', '\\"')}"`;
}

function buildCodexReviewArgs({
  outputPath,
  prompt,
  model = null,
  modelProvider = null,
  configOverrides = null,
}) {
  const args = [
    'exec',
    '--ignore-user-config',
    '--dangerously-bypass-approvals-and-sandbox',
    '--ephemeral',
    '--json',
  ];
  if (model) args.push('--model', model);
  const overrides = Array.isArray(configOverrides)
    ? configOverrides
    : (modelProvider ? [{ key: 'model_provider', value: modelProvider }] : []);
  for (const override of overrides) {
    if (!override?.key) continue;
    args.push('--config', formatCodexConfigOverride(override));
  }
  args.push(
    '--output-last-message',
    outputPath,
    '--',
    prompt,
  );
  return args;
}

function parseCodexJsonTokenUsage(stdout) {
  let tokenUsage = null;
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim() || (!line.includes('token_count') && !line.includes('turn.completed'))) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    const total = item.type === 'turn.completed'
      ? item.usage
      : (
          item.type === 'event_msg' && item.payload?.type === 'token_count'
            ? item.payload?.info?.total_token_usage
            : null
        );
    if (!total || typeof total !== 'object') continue;
    tokenUsage = {
      input: Number.isFinite(Number(total.input_tokens)) ? Math.trunc(Number(total.input_tokens)) : null,
      output: Number.isFinite(Number(total.output_tokens)) ? Math.trunc(Number(total.output_tokens)) : null,
      cacheRead: Number.isFinite(Number(total.cached_input_tokens)) ? Math.trunc(Number(total.cached_input_tokens)) : null,
      cacheWrite: 0,
      total: Number.isFinite(Number(total.total_tokens)) ? Math.trunc(Number(total.total_tokens)) : null,
      source: 'codex-json',
    };
  }
  return tokenUsage;
}

async function spawnCodexReview({
  codexCli = CODEX_CLI,
  outputPath,
  prompt,
  model = null,
  modelProvider = null,
  configOverrides = null,
  env,
  cwd = process.cwd(),
  timeout = resolveReviewerTimeoutMs(env),
  maxBuffer = 10 * 1024 * 1024,
  spawnCapturedImpl = spawnCaptured,
}) {
  return spawnCapturedImpl(
    codexCli,
    buildCodexReviewArgs({ outputPath, prompt, model, modelProvider, configOverrides }),
    {
      env,
      cwd,
      timeout,
      maxBuffer,
    },
  );
}

/**
 * Run adversarial review using Codex CLI (OAuth).
 * OPENAI_API_KEY is explicitly removed from the env so Codex
 * uses its stored OAuth credentials only.
 *
 * Note: ACPX session bootstrap is currently broken in this environment
 * (see runbooks/INCIDENT-2026-04-21-ACPX-codex-exec-regression.md).
 * Using native Codex CLI instead, which is stable and produces quality reviews.
 */
async function reviewWithCodex(diff, extraContext = '', { promptStage = 'first' } = {}) {
  console.error('[reviewWithCodex] asserting OAuth...');
  await assertCodexOAuth();
  console.error('[reviewWithCodex] OAuth OK');

  if (!existsSync(CODEX_CLI)) {
    throw new Error(`Codex CLI not found at ${CODEX_CLI}`);
  }

  const promptPrefix = buildReviewerPromptPrefix({ stage: promptStage });
  const prompt = `${promptPrefix}${extraContext}\n\n---\n\nHere is the PR diff to review:\n\n\`\`\`diff\n${diff}\`\`\``;
  const authPath = resolveCodexAuthPath();
  // Per-worker codex credential (burst OAuth-cascade fix). Each reviewer spawn
  // gets its own auth.json with a placeholder refresh_token so a review storm
  // (or a reviewer racing the hq-dispatch fleet) cannot rotate-and-revoke the
  // shared ChatGPT credential. Fail-safe: null -> use the shared path.
  const perWorkerAuth = materializePerWorkerCodexAuth({
    sharedAuthPath: authPath,
    key: `reviewer-${process.pid}-${Date.now()}`,
  });
  const effectiveAuthPath = perWorkerAuth?.authPath || authPath;
  const outputPath = join(tmpdir(), `codex-review-${process.pid}-${Date.now()}.md`);
  const codexExecOverrides = resolveCodexExecOverrides();

  const { env } = scrubOAuthFallbackEnv({
    ...process.env,
    PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    CODEX_AUTH_PATH: effectiveAuthPath,
    HOME: process.env.HOME || homedir(),
  });

  try {
    let stdout = '';
    let stderr = '';
    try {
      console.error('[reviewWithCodex] invoking native Codex CLI');
      const result = await spawnCodexReview(
        {
          codexCli: CODEX_CLI,
          outputPath,
          prompt,
          model: codexExecOverrides.model,
          modelProvider: codexExecOverrides.modelProvider,
          configOverrides: codexExecOverrides.configOverrides,
          env,
          cwd: process.cwd(),
          timeout: resolveReviewerTimeoutMs(env),
          maxBuffer: 10 * 1024 * 1024,
        }
      );
      stdout = result.stdout || '';
      stderr = result.stderr || '';
    } catch (err) {
      stdout = err.stdout || '';
      stderr = err.stderr || '';
      const msg = `${err.message || ''}\n${stdout}\n${stderr}`;
      if (/401|unauthorized|oauth|login required|not logged in/i.test(msg)) {
        throw new OAuthError('codex', `CLI returned auth error: ${msg.substring(0, 200)}`);
      }
      throw new Error(`Native Codex exec failed: ${msg.substring(0, 800)}`);
    }

    let fileOutput = '';
  const outputFileExists = existsSync(outputPath);
  try {
    if (outputFileExists) {
      fileOutput = readFileSync(outputPath, 'utf8');
    }
  } finally {
    try { unlinkSync(outputPath); } catch {}
  }

  console.error(`[reviewWithCodex] native Codex returned stdout length=${stdout.length}; stderr length=${stderr.length}; file exists=${outputFileExists}; file length=${fileOutput.length}`);
  console.error(`[reviewWithCodex] stdout preview: ${previewText(stdout)}`);
  console.error(`[reviewWithCodex] stderr preview: ${previewText(stderr)}`);
  console.error(`[reviewWithCodex] file preview: ${previewText(fileOutput)}`);
  const tokenUsage = parseCodexJsonTokenUsage(stdout);

  const cleanedStdout = stripCodexRuntimeNoise(stdout);
  const cleanedStderr = stripCodexRuntimeNoise(stderr);
  const cleanedFile = stripCodexRuntimeNoise(fileOutput);
  const combined = normalizeWhitespace(cleanedFile || cleanedStdout || cleanedStderr || '');

  if (looksLikeRuntimeJunk(stdout) && !combined) {
    throw new Error(`Native Codex returned runtime/status junk instead of a review: ${stdout.substring(0, 400)}`);
  }

  if (!combined) {
    const hint = stderr?.trim() ? ` stderr: ${stderr.substring(0, 200)}` : '';
    throw new Error(`Native Codex returned empty output.${hint}`);
  }

    return {
      reviewText: combined,
      tokenUsage,
    };
  } finally {
    perWorkerAuth?.cleanup();
  }
}

// ── Gemini review ─────────────────────────────────────────────────────────────

// Default to the best available reviewer model. GEMINI_REVIEWER_MODEL
// overrides the default at runtime — set it to the cheaper fallback
// (gemini-2.5-flash) when pro is unavailable or quota-capped.
const DEFAULT_GEMINI_REVIEWER_MODEL = 'gemini-2.5-pro';
const REVIEWER_METADATA_BY_MODEL = Object.freeze({
  claude: {
    displayName: 'Claude',
    reviewerIdentity: 'claude-reviewer-lacey',
  },
  codex: {
    displayName: 'Codex',
    reviewerIdentity: 'codex-reviewer-lacey',
  },
  gemini: {
    displayName: 'Gemini',
    reviewerIdentity: 'gemini-reviewer-lacey',
  },
});

function resolveGeminiReviewerModel(env = process.env) {
  const override = String(env.GEMINI_REVIEWER_MODEL || '').trim();
  return override || DEFAULT_GEMINI_REVIEWER_MODEL;
}

function resolveReviewerMetadata(reviewerModel) {
  const key = String(reviewerModel || '').trim().toLowerCase();
  return REVIEWER_METADATA_BY_MODEL[key] || REVIEWER_METADATA_BY_MODEL.codex;
}

/**
 * Build the headless Gemini argv. The actual prompt, diff, and extra context
 * still travel over stdin; `--prompt ''` only switches the Gemini CLI out of
 * interactive mode so stdin is consumed as headless prompt content.
 */
function buildGeminiReviewArgs({ model }) {
  return ['-m', model, '-o', 'text', '--prompt', ''];
}

function isRetryableGeminiSubprocessError(err) {
  const detail = buildGhErrorDetail(err);
  return /\b(etimedout|econnreset|econnrefused|ehostunreach|eai_again|enotfound|epipe|eagain|tls)\b/.test(detail)
    || detail.includes('timeout')
    || detail.includes('timed out')
    || detail.includes('temporary failure')
    || detail.includes('temporarily unavailable')
    || detail.includes('socket hang up')
    || detail.includes('network')
    || detail.includes('connection reset')
    || detail.includes('connection refused')
    || detail.includes('service unavailable')
    || detail.includes('503')
    || detail.includes('504')
    || detail.includes('429')
    || detail.includes('rate limit');
}

async function withGeminiSubprocessRetry(operation, {
  retryDelaysMs = REVIEW_POST_RETRY_DELAYS_MS,
  sleepImpl = sleep,
  log = console,
} = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (!isRetryableGeminiSubprocessError(err) || attempt >= retryDelaysMs.length) {
        throw err;
      }
      log.warn?.(
        `[reviewWithGemini] transient Gemini subprocess failure on attempt ${attempt + 1}/${retryDelaysMs.length + 1}; retrying: ${err?.message || err}`
      );
      await sleepImpl(retryDelaysMs[attempt]);
    }
  }
  throw lastErr;
}

async function spawnGeminiReview({
  geminiCli = GEMINI_CLI,
  prompt,
  model = resolveGeminiReviewerModel(),
  env,
  cwd = process.cwd(),
  timeout = resolveReviewerTimeoutMs(env),
  maxBuffer = 10 * 1024 * 1024,
  spawnWithInputImpl = spawnWithInput,
}) {
  // Prompt content is delivered on stdin only — see buildGeminiReviewArgs.
  return spawnWithInputImpl(
    geminiCli,
    buildGeminiReviewArgs({ model }),
    {
      env,
      cwd,
      input: prompt,
      timeout,
      maxBuffer,
    },
  );
}

/**
 * Run adversarial review using the native Gemini CLI (OAuth only).
 * GEMINI_API_KEY / GOOGLE_API_KEY are scrubbed from the env so Gemini uses
 * its stored OAuth credentials only. The prompt is fed over stdin (never
 * argv). Gemini token-usage parsing is out of scope, so tokenUsage is null.
 */
async function reviewWithGemini(diff, extraContext = '', {
  promptStage = 'first',
  assertOAuthImpl = assertGeminiOAuth,
  spawnGeminiReviewImpl = spawnGeminiReview,
  retryDelaysMs = REVIEW_POST_RETRY_DELAYS_MS,
  sleepImpl = sleep,
} = {}) {
  console.error('[reviewWithGemini] asserting OAuth...');
  await assertOAuthImpl();
  console.error('[reviewWithGemini] OAuth OK');

  const promptPrefix = buildReviewerPromptPrefix({ stage: promptStage });
  const prompt = `${promptPrefix}${extraContext}\n\n---\n\nHere is the PR diff to review:\n\n\`\`\`diff\n${diff}\`\`\``;
  const model = resolveGeminiReviewerModel();

  // Strip API keys (incl. GEMINI_API_KEY / GOOGLE_API_KEY) so the gemini CLI
  // falls through to OAuth. Pin HOME so it reads the same oauth_creds.json
  // asserted above.
  const { env } = scrubOAuthFallbackEnv({
    ...process.env,
    HOME: process.env.HOME || homedir(),
  });

  let stdout = '';
  let stderr = '';
  try {
    console.error(`[reviewWithGemini] invoking native Gemini CLI (model=${model})`);
    const result = await withGeminiSubprocessRetry(
      () => spawnGeminiReviewImpl({
        geminiCli: GEMINI_CLI,
        prompt,
        model,
        env,
        cwd: process.cwd(),
        timeout: resolveReviewerTimeoutMs(env),
        maxBuffer: 10 * 1024 * 1024,
      }),
      { retryDelaysMs, sleepImpl },
    );
    stdout = result.stdout || '';
    stderr = result.stderr || '';
  } catch (err) {
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    const msg = `${err.message || ''}\n${stdout}\n${stderr}`;
    if (/401|unauthorized|oauth|login required|not logged in/i.test(msg)) {
      throw new OAuthError('gemini', `CLI returned auth error: ${msg.substring(0, 200)}`);
    }
    throw new Error(`Gemini exec failed: ${msg.substring(0, 800)}`);
  }

  console.error(`[reviewWithGemini] gemini returned stdout length=${stdout.length}; stderr length=${stderr.length}`);
  console.error(`[reviewWithGemini] stdout preview: ${previewText(stdout)}`);
  console.error(`[reviewWithGemini] stderr preview: ${previewText(stderr)}`);

  const combined = normalizeWhitespace(stdout || stderr || '');
  if (!combined) {
    // Forensic: surface the raw output in the thrown error rather than
    // silently dropping it (mirrors the codex empty-output handling).
    const hint = stderr?.trim() ? ` stderr: ${stderr.substring(0, 200)}` : '';
    throw new Error(`Gemini returned empty output.${hint}`);
  }

  return { reviewText: combined, tokenUsage: null };
}

// ── Reviewer-model selection ──────────────────────────────────────────────────

/**
 * Route a review to the reviewer matching `effectiveModel`. This is the
 * single selection site: 'gemini' MUST land on reviewWithGemini and never
 * fall through to codex (the GMW-01 regression this guards). Codex output
 * still needs sanitization by the caller, so the codex branch returns the
 * raw text with reviewText=null and needsSanitize=true; claude/gemini are
 * returned ready to post.
 */
async function dispatchReviewerModel(effectiveModel, diff, extraContext, {
  promptStage = 'first',
  reviewWithClaudeImpl = reviewWithClaude,
  reviewWithCodexImpl = reviewWithCodex,
  reviewWithGeminiImpl = reviewWithGemini,
} = {}) {
  if (effectiveModel === 'claude') {
    const text = await reviewWithClaudeImpl(diff, extraContext, { promptStage });
    return { rawReviewText: text, reviewText: text, tokenUsage: null, needsSanitize: false };
  }
  if (effectiveModel === 'gemini') {
    const result = await reviewWithGeminiImpl(diff, extraContext, { promptStage });
    return {
      rawReviewText: result.reviewText,
      reviewText: result.reviewText,
      tokenUsage: result.tokenUsage ?? null,
      needsSanitize: false,
    };
  }
  const codexResult = await reviewWithCodexImpl(diff, extraContext, { promptStage });
  return {
    rawReviewText: codexResult.reviewText,
    reviewText: null,
    tokenUsage: codexResult.tokenUsage,
    needsSanitize: true,
  };
}

// ── GitHub review posting ────────────────────────────────────────────────────

class ReviewerPostAuthRefreshRetryableError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = 'ReviewerPostAuthRefreshRetryableError';
    this.cause = cause;
  }
}

function buildGhErrorDetail(err) {
  return [
    err?.code,
    err?.message,
    err?.stderr,
    err?.stdout,
  ].filter(Boolean).join('\n').toLowerCase();
}

function isReviewerPostAuthFailure(err, { preWriteSaw401 = false } = {}) {
  const detail = buildGhErrorDetail(err);
  if (
    /\b401\b/.test(detail)
    || /\bunauthorized\b/.test(detail)
    || /\bbad credentials?\b/.test(detail)
    || /\bauthentication (?:failed|required)\b/.test(detail)
    || /\brequires authentication\b/.test(detail)
    || /\bnot logged in\b/.test(detail)
    || /\blogin required\b/.test(detail)
  ) {
    return true;
  }
  return preWriteSaw401 && (
    /\boauth\b/.test(detail)
    || /\bcredentials?\b/.test(detail)
    || /\b(?:access|bearer|installation|github app)\s+token\b/.test(detail)
    || /\bgh auth\b/.test(detail)
    || /\bkeychain\b/.test(detail)
  );
}

function isRetryableGhTransportError(err, { allowAuthRefresh = false, preWriteSaw401 = false } = {}) {
  const detail = buildGhErrorDetail(err);
  if (allowAuthRefresh && isReviewerPostAuthFailure(err, { preWriteSaw401 })) {
    return true;
  }
  return /\b(etimedout|econnreset|econnrefused|ehostunreach|eai_again|enotfound|epipe|eagain)\b/.test(detail)
    || detail.includes('timeout')
    || detail.includes('timed out')
    || detail.includes('temporary failure')
    || detail.includes('temporarily unavailable')
    || detail.includes('rate limit')
    || detail.includes('secondary rate limit')
    || detail.includes('502 bad gateway')
    || detail.includes('503 service unavailable')
    || detail.includes('504 gateway timeout');
}

async function withGhRetry(operation, {
  retryDelaysMs = REVIEW_POST_RETRY_DELAYS_MS,
  isRetryable = () => false,
} = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt >= retryDelaysMs.length) {
        throw err;
      }
      await sleep(retryDelaysMs[attempt]);
    }
  }
  throw lastErr;
}

function createReviewerPreWriteLogProxy(log = console) {
  const base = log || console;
  const tracker = { saw401: false };
  return {
    tracker,
    log: {
      ...base,
      warn(message, ...args) {
        const rendered = String(message || '');
        if (/\[reviewer-pre-write\].*http 401/i.test(rendered)) {
          tracker.saw401 = true;
        }
        return base.warn?.(message, ...args);
      },
    },
  };
}

// GitHub's GraphQL `addPullRequestReview` mutation refuses to create a second
// pending review per (user, PR) tuple. If a previous reviewer subprocess was
// SIGTERM'd between `gh pr review --comment` initiating the review and the
// body submission completing, GitHub may have already accepted the review
// CREATION but not the body submission — leaving a PENDING review draft
// scoped to the bot, invisible to other accounts via the standard reviews
// list. Every subsequent reviewer attempt then dies with:
//
//   GraphQL: User can only have one pending review per pull request (addPullRequestReview)
//
// The watcher's failure classifier returns `failure-class=unknown` (no pattern
// match), so it schedules another retry, which fails the same way. Indefinite
// loop, never recovers without operator manual DELETE.
//
// Bot-self-housekeeping: before each post, list the bot's own reviews on the
// PR via the REST API (which DOES surface our own pending drafts), and DELETE
// any with state=PENDING. The bot is the only writer of its own reviews, so
// this is race-free against itself. Best-effort: if the list/delete calls
// fail, log and continue — the post may still succeed, and a failure here is
// strictly less bad than the leak it's trying to prevent.
async function postGitHubReview(repo, prNumber, reviewBody, botTokenEnv, execFileImpl = execFileAsync, opts = {}) {
  // GMW-06 safety net: a gemini reviewer must never silently mis-post under
  // another identity's token, and the legacy GEMINI_REVIEWER_GH_TOKEN item name
  // must never leak into the runtime. Fails closed with a legible error before
  // we read/use any token.
  preflightGeminiReviewerToken({
    env: process.env,
    botTokenEnv,
    reviewerIdentity: opts.reviewerIdentity,
  });
  let token = process.env[botTokenEnv];
  if (!token) {
    throw new Error(`Missing env var: ${botTokenEnv}`);
  }

  const prepareReviewWrite = opts.prepareReviewWrite || clearPendingReviewsForSelf;
  const log = opts.log || console;
  const refreshIdentity = resolveReviewerIdentityForBotTokenEnv(botTokenEnv, opts.reviewerIdentity);
  let refreshedAfterAuthFailure = false;

  const stateDir = resolveAdversarialReviewStateDir(opts.rootDir || ROOT, opts.env || process.env);
  let reviewerFence = null;
  try {
    reviewerFence = openReviewerFence({
      stateDir,
      spawnToken: opts.reviewerSpawnToken,
      repo,
      pr: prNumber,
      identity: opts.reviewerIdentity,
      graceSeconds: resolveSigtermFenceGraceSeconds(opts.env || process.env),
    });
  } catch (err) {
    if (err?.code === 'EWOULDBLOCK' || err?.code === 'EAGAIN') {
      throw err;
    }
    (opts.log || console).warn?.(
      `[reviewer] reviewer fence unavailable; posting review without fence: ${err?.message || err}`
    );
  }
  const startedAt = Date.now();
  try {
    await withGhRetry(
      async () => {
        const preWriteLog = createReviewerPreWriteLogProxy(log);
        await prepareReviewWrite({
          repo,
          prNumber,
          token,
          fetchImpl: opts.fetchImpl,
          log: preWriteLog.log,
        });
        try {
          await awaitThrottleIfNeeded();
          await execFileImpl(
            'gh',
            ['pr', 'review', String(prNumber), '--repo', repo, '--comment', '--body', reviewBody],
            {
              env: { ...process.env, GH_TOKEN: token },
              maxBuffer: 5 * 1024 * 1024,
            }
          );
        } catch (err) {
          const authRetryable = isReviewerPostAuthFailure(err, {
            preWriteSaw401: preWriteLog.tracker.saw401,
          });
          if (!refreshedAfterAuthFailure && authRetryable) {
            const refreshed = await resolveReviewerAppToken(refreshIdentity, {
              env: process.env,
              fetchImpl: opts.fetchImpl,
              readFileImpl: opts.readFileImpl,
              timeoutMs: opts.reviewerTokenFetchTimeoutMs,
            }).catch((refreshErr) => {
              log.warn?.(
                `[reviewer] failed to refresh ${botTokenEnv} after GitHub auth failure: ${refreshErr?.message || refreshErr}`
              );
              return null;
            });
            if (refreshed?.token && refreshed.envVar === botTokenEnv) {
              refreshedAfterAuthFailure = true;
              token = refreshed.token;
              log.warn?.(
                `[reviewer] refreshed ${botTokenEnv} after GitHub auth failure; retrying review post once`
              );
              throw new ReviewerPostAuthRefreshRetryableError(
                `Retry GitHub review post after refreshing ${botTokenEnv}`,
                { cause: err }
              );
            }
            if (refreshed?.token && refreshed.envVar !== botTokenEnv) {
              log.warn?.(
                `[reviewer] refused refreshed ${refreshed.envVar || '<unknown>'} token for ${botTokenEnv} after GitHub auth failure`
              );
            }
          }
          throw err;
        }
      },
      {
        retryDelaysMs: REVIEW_POST_RETRY_DELAYS_MS,
        isRetryable: (err) => err instanceof ReviewerPostAuthRefreshRetryableError,
      }
    );
    recordApiCall({
      category: 'review_post',
      repo,
      prNumber,
      status: 200,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    recordApiCall({
      category: 'review_post',
      repo,
      prNumber,
      status: apiStatusFromError(err),
      durationMs: Date.now() - startedAt,
    });
    throw err;
  } finally {
    reviewerFence?.clear();
  }
}

async function postGitHubReviewWithCapture({
  rootDir = ROOT,
  repo,
  prNumber,
  attemptNumber,
  reviewerModel,
  reviewBody,
  botTokenEnv,
  passKind,
  postedAt = null,
  execFileImpl = execFileAsync,
  log = console,
  fetchImpl = globalThis.fetch,
  readFileImpl = undefined,
  prepareReviewWrite = clearPendingReviewsForSelf,
  reviewerSpawnToken = null,
  reviewerIdentity = null,
  reviewerTokenFetchTimeoutMs = undefined,
} = {}) {
  // GMW-06: run the gemini-reviewer preflight before the generic env check so a
  // gemini post with an unresolved token fails with the legible runbook-naming
  // error (and the legacy-conflict guard fires) rather than the bare
  // "Missing env var" — and never falls through to another identity's token.
  preflightGeminiReviewerToken({ env: process.env, botTokenEnv, reviewerIdentity });
  const initialToken = process.env[botTokenEnv];
  if (!initialToken) {
    throw new Error(`Missing env var: ${botTokenEnv}`);
  }

  await postGitHubReview(repo, prNumber, reviewBody, botTokenEnv, execFileImpl, {
    rootDir,
    fetchImpl,
    readFileImpl,
    log,
    prepareReviewWrite,
    reviewerSpawnToken,
    reviewerIdentity,
    reviewerTokenFetchTimeoutMs,
  });

  // Capture postedAt AFTER the gh post returns so the candidate window
  // bounds the artifact's GitHub-assigned timestamp, which is set during
  // post handling — not before the request leaves.
  const effectivePostedAt = postedAt || new Date().toISOString();

  // Normalize 'unknown' to null so the reviewer_passes.verdict CHECK
  // constraint (approved / comment-only / request-changes / dismissed / NULL)
  // does not abort the body-capture UPDATE when a reviewer goes off-script.
  // Losing the parsed-verdict shortcut is preferable to losing body capture
  // entirely; downstream consumers already treat NULL as "verdict unknown".
  const normalizedVerdict = normalizeReviewVerdict(extractReviewVerdict(reviewBody));
  const persistedVerdict = normalizedVerdict === 'unknown' ? null : normalizedVerdict;

  await captureReviewerBodyAfterPost(rootDir, {
    repo,
    prNumber,
    attemptNumber: Number(attemptNumber),
    reviewerModel,
    botTokenEnv,
    reviewBody,
    verdict: persistedVerdict,
    passKind,
    postedAt: effectivePostedAt,
    execFileImpl,
    env: { ...process.env, [botTokenEnv]: process.env[botTokenEnv] || initialToken },
    log,
  });
}

// ── Clio alert (OAuth failure) ───────────────────────────────────────────────

/**
 * Alert Paul via Clio when OAuth credentials are unavailable.
 * Uses the OpenClaw wake hook to deliver a Telegram message.
 */
async function alertClioOAuthFailure(model, repo, prNumber, reason) {
  const msg = `🔐 Adversarial reviewer STOPPED — ${model} OAuth credentials unavailable.\n\nRepo: ${repo} PR #${prNumber}\nReason: ${reason}\n\nAction needed: re-authenticate ${model} (run the CLI and log in). PR review is paused until credentials are restored.`;

  console.error(`[reviewer] ALERT: ${msg}`);

  // Try to wake Clio via the OpenClaw hook
  try {
    await execFileAsync(
      'curl',
      [
        '-s', '-X', 'POST',
        'http://127.0.0.1:8787/hooks/wake',
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify({ message: msg }),
      ],
      { timeout: 10_000 }
    );
    console.log('[reviewer] Clio alert sent via wake hook');
  } catch (err) {
    console.error('[reviewer] Failed to send Clio alert:', err.message);
    // Alert is best-effort — the error is already in watcher logs
  }
}

// ── Linear integration (LAC-13) ──────────────────────────────────────────────

const linearTriage = createLinearTriageAdapter({
  logger: console,
  criticalWords: CRITICAL_WORDS,
});

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rawArgs = process.argv[2];
  if (!rawArgs) {
    console.error('[reviewer] Usage: node src/reviewer.mjs \'<JSON args>\'');
    process.exit(1);
  }

  let args;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    console.error('[reviewer] Invalid JSON args:', rawArgs);
    process.exit(1);
  }

  const {
    repo,
    prNumber,
    reviewerModel,
    botTokenEnv,
    linearTicketId,
    builderTag,
    reviewerHeadSha,
    reviewAttemptNumber,
    reviewDbAttemptNumber,
    completedRemediationRounds,
    maxRemediationRounds,
    passKind,
    reviewerSessionUuid,
    reviewerSpawnToken,
    labels = [],
    ticketPipelinePaused = false,
    crossModelReviewWaived = false,
    crossModelReviewWaiverReason = null,
  } = args;

  if (!repo || !prNumber || !reviewerModel || !botTokenEnv) {
    console.error('[reviewer] Missing required fields in args:', args);
    process.exit(1);
  }

  // The reviewer treats the final allowed review pass as a lenient
  // verdict round (only blocking on data corruption / secret leakage /
  // security regression / broken external contract). Computed from the
  // (1-indexed) attempt number and the remediation cap, both passed by
  // the watcher. Backward-compat: if either is missing (old watcher
  // calling new reviewer), default to non-final-round behavior so we
  // don't accidentally downgrade reviews on older deployments.
  const reviewerCompletedRemediationRounds = completedRemediationRounds ?? (
    Number.isFinite(Number(reviewAttemptNumber)) ? Number(reviewAttemptNumber) - 1 : undefined
  );
  const reviewerPromptStage = (
    reviewAttemptNumber === undefined &&
    completedRemediationRounds === undefined &&
    maxRemediationRounds === undefined
  )
    ? 'first'
    : pickReviewerStage({
        reviewAttemptNumber,
        completedRemediationRounds: reviewerCompletedRemediationRounds,
        maxRemediationRounds,
      });
  const isFinalRound = reviewerPromptStage === 'last';

  console.log(
    `[reviewer] Starting review: ${repo}#${prNumber} model=${reviewerModel}` +
    ` (OAuth-only mode; prompt stage=${reviewerPromptStage}${isFinalRound ? `; FINAL round attempt ${reviewAttemptNumber} of ${1 + Number(maxRemediationRounds || 0)} — lenient verdict threshold active` : ''})`
  );
  console.error(`[reviewer] DEBUG: args=${JSON.stringify(args)}`);
  if (reviewerSessionUuid && !process.env.REVIEWER_SESSION_UUID) {
    process.env.REVIEWER_SESSION_UUID = String(reviewerSessionUuid);
  }

  if (reviewerHeadSha) {
    try {
      await linearTriage.recordReviewerEngagement({
        domainId: 'code-pr',
        subjectExternalId: `${repo}#${prNumber}`,
        revisionRef: reviewerHeadSha,
        linearTicketId,
        labels,
        ticketPipelinePaused,
      }, {
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[reviewer] LINEAR REVIEW-START UPDATE FAILED for ${linearTicketId}:`, err.message);
    }
  }

  // 1. Fetch diff
  let diff;
  try {
    console.error(`[reviewer] DEBUG: fetching diff for ${repo}#${prNumber}...`);
    const diffBytes = await fetchPRDiff(repo, prNumber, reviewerHeadSha);
    diff = diffBytes.toString('utf8');
    console.error(`[reviewer] DEBUG: fetched diff (${diffBytes.byteLength} bytes)`);
  } catch (err) {
    console.error(`[reviewer] Failed to fetch diff for ${repo}#${prNumber}:`, err.message);
    process.exit(1);
  }

  if (!diff.trim()) {
    console.log(`[reviewer] Empty diff for ${repo}#${prNumber} — nothing to review`);
    process.exit(0);
  }

  let extraContext = buildObviousDocsGuidance();
  let prContext;
  try {
    prContext = await fetchPRContext(repo, prNumber);
  } catch (err) {
    console.error(`[reviewer] Failed to fetch required PR context for ${repo}#${prNumber}: ${err.message}`);
    process.exit(1);
  }

  try {
    const linkedContext = await fetchLinkedSpecContents(repo, prNumber, {
      prContext,
      fetchPRContextImpl: fetchPRContext,
      execFileImpl: execFileAsync,
    });
    if (linkedContext) {
      extraContext = `${linkedContext}${buildObviousDocsGuidance({ repoRootRelative: true, includeSelfContainedHint: true })}`;
      console.error(`[reviewer] DEBUG: fetched linked PR context (${linkedContext.length} bytes)`);
    } else {
      console.error('[reviewer] DEBUG: no linked PR context found; using obvious-docs fallback guidance');
    }
  } catch (err) {
    console.error(`[reviewer] WARN: failed to fetch linked PR context: ${err.message}`);
  }

  // 2. Run adversarial review (OAuth only — no API key fallback)
  const effectiveModel = reviewerModel;

  let reviewText;
  let rawReviewText;
  let tokenUsage = null;
  try {
    console.error(`[reviewer] DEBUG: starting ${effectiveModel} review...`);
    logStructuredEvent(console, {
      type: 'hosted-reviewer-selection',
      repo,
      prNumber,
      headSha: reviewerHeadSha || null,
      reviewerModel: effectiveModel,
      builderTag: builderTag || null,
      hostedReviewerFamily: resolveHostedReviewerFamily(effectiveModel),
    });
    // Single selection site (GMW-01): claude / gemini / codex. gemini routes
    // to reviewWithGemini and never falls through to codex.
    const dispatch = await dispatchReviewerModel(effectiveModel, diff, extraContext, {
      promptStage: reviewerPromptStage,
    });
    rawReviewText = dispatch.rawReviewText;
    tokenUsage = dispatch.tokenUsage;
    if (dispatch.needsSanitize) {
      console.error(`[reviewer] DEBUG: raw Codex review length=${rawReviewText.length}; preview=${previewText(rawReviewText)}`);
      try {
        reviewText = sanitizeCodexReviewPayload(rawReviewText);
      } catch (sanitizeErr) {
        console.error(`[reviewer] SANITIZE FAILED: ${sanitizeErr.message}`);
        console.error(`[reviewer] SANITIZE INPUT PREVIEW: ${previewText(rawReviewText, 400)}`);
        // LAC-545: forensic preservation. Persist the rejected raw codex
        // output so a future fix to the sanitizer / prompt / codex CLI
        // can be diagnosed without re-triggering the failure. Before
        // this, every rejection was lost — the codex output file was
        // unlinked inside reviewWithCodex and the watcher's classifier
        // silenced the stderr. Truncate to 50 KB to bound disk usage.
        try {
          persistRejectedCodexOutput({
            repo,
            prNumber,
            rejectionReason: sanitizeErr.message,
            rawReviewText,
          });
        } catch (persistErr) {
          console.error(`[reviewer] WARN: failed to persist rejected codex output: ${persistErr.message}`);
        }
        throw sanitizeErr;
      }
    } else {
      reviewText = dispatch.reviewText;
    }
    console.error(`[reviewer] DEBUG: review completed (${reviewText.length} bytes)`);
  } catch (err) {
    if (err.isOAuthError) {
      // OAuth failure — stop work and alert Paul
      await alertClioOAuthFailure(reviewerModel, repo, prNumber, err.message);
      console.error(`[reviewer] Stopped: OAuth credentials unavailable for ${reviewerModel}`);
      process.exit(2); // exit code 2 = auth failure (distinct from other errors)
    }
    console.error(`[reviewer] AI review failed for ${repo}#${prNumber}:`, err.message);
    console.error(`[reviewer] ERROR STACK: ${err.stack}`);
    process.exit(1);
  }

  if (tokenUsage) {
    console.log(JSON.stringify({ type: 'reviewer.token_usage', tokenUsage }));
  }
  console.log(`[reviewer] Review generated (${reviewText.length} chars)`);

  // 3. Post to GitHub
  const reviewerMetadata = resolveReviewerMetadata(effectiveModel);
  const header = `## Adversarial Review — ${reviewerMetadata.displayName} (${reviewerMetadata.reviewerIdentity})\n\n`;
  const waiverAuditBlock = crossModelReviewWaived
    ? `> Cross-model review waiver: ${String(crossModelReviewWaiverReason || 'operator override selected the same reviewer family as the builder for this pass.')}\n\n`
    : '';
  const fullComment = header + waiverAuditBlock + reviewText;
  let localShadowRequestRecord = null;
  try {
    localShadowRequestRecord = createOrLoadLocalReviewShadowRequest({
      rootDir: ROOT,
      repo,
      prNumber,
      headSha: reviewerHeadSha || null,
      labels,
      builderTag,
      hostedReviewerModel: effectiveModel,
      env: process.env,
      log: console,
    });
  } catch (err) {
    console.error(`[reviewer] WARNING local-review-shadow request setup failed for ${repo}#${prNumber}; continuing hosted-only: ${err.message}`);
  }

  try {
    console.error(`[reviewer] DEBUG: posting GitHub review body length=${fullComment.length}; preview=${previewText(fullComment, 300)}`);
    // Use reviewDbAttemptNumber to match the row beginReviewerPass created
    // in watcher.spawnReviewer. reviewAttemptNumber (ledger.completedRoundsForPR + 1)
    // only advances on round completion, while reviewDbAttemptNumber
    // (review_attempts + 1) advances on every launch attempt — they diverge
    // on retry-within-round, and the row key is the launch-attempt counter.
    const captureAttemptNumber = Number.isFinite(Number(reviewDbAttemptNumber))
      ? Number(reviewDbAttemptNumber)
      : Number(reviewAttemptNumber);
    await postGitHubReviewWithCapture({
      rootDir: ROOT,
      repo,
      prNumber,
      attemptNumber: captureAttemptNumber,
      reviewerModel: effectiveModel,
      reviewBody: fullComment,
      botTokenEnv,
      passKind,
      reviewerSpawnToken,
      reviewerIdentity: resolveReviewerIdentityForBotTokenEnv(
        botTokenEnv,
        reviewerMetadata.reviewerIdentity
      ),
      execFileImpl: execFileAsync,
      log: console,
    });
    console.log(`[reviewer] Review posted to ${repo}#${prNumber}`);
  } catch (err) {
    console.error(`[reviewer] GITHUB POST FAILED for ${repo}#${prNumber}:`, err.message);
    process.exit(1);
  }

  const critical = isCritical(reviewText);
  const reviewPostedAt = new Date().toISOString();
  if (localShadowRequestRecord?.requested) {
    try {
      const shadowResult = await reconcileLocalReviewShadow({
        rootDir: ROOT,
        request: localShadowRequestRecord.request,
        requestPath: localShadowRequestRecord.requestPath,
        artifactPath: localShadowRequestRecord.artifactPath,
        hostedReviewPosted: true,
        hostedReviewPostedAt: reviewPostedAt,
        diff,
        extraContext,
        env: process.env,
        fetchImpl: globalThis.fetch,
        log: console,
      });
      if (shadowResult.completed) {
        console.log(`[reviewer] Local review shadow artifact recorded at ${shadowResult.artifactPath}`);
      }
    } catch (err) {
      console.error(`[reviewer] WARNING local-review-shadow reconcile failed for ${repo}#${prNumber}; hosted gate remains unchanged: ${err.message}`);
    }
  }

  try {
    const baseBranch = typeof prContext?.baseRefName === 'string' ? prContext.baseRefName.trim() : '';
    const queued = queueFollowUpForPostedReview({
      rootDir: ROOT,
      repo,
      prNumber,
      baseBranch,
      revisionRef: reviewerHeadSha || null,
      reviewerModel: effectiveModel,
      builderTag,
      linearTicketId,
      reviewText,
      reviewPostedAt,
      critical,
    });
    if (queued.queued) {
      console.log(`[reviewer] Follow-up handoff queued at ${queued.jobPath}`);
    } else {
      console.error(`[reviewer] Follow-up handoff skipped for ${repo}#${prNumber}: ${queued.reason}`);
    }
  } catch (err) {
    console.error(`[reviewer] Failed to queue follow-up handoff for ${repo}#${prNumber}:`, err.message);
  }

  // 4. Update Linear (LAC-13)
  try {
    console.error(`[reviewer] DEBUG: updating Linear ticket ${linearTicketId || '<none>'}; critical=${critical}`);
    await linearTriage.recordReviewCompleted({
      domainId: 'code-pr',
      subjectExternalId: `${repo}#${prNumber}`,
      revisionRef: reviewerHeadSha || null,
      linearTicketId,
      labels,
      ticketPipelinePaused,
    }, {
      critical,
      reviewSummary: reviewText,
    });
  } catch (err) {
    console.error(`[reviewer] LINEAR UPDATE FAILED for ${linearTicketId}:`, err.message);
    // Non-fatal — review was posted, just log and continue
  }

  if (critical) {
    console.log(`[reviewer] CRITICAL issues detected in ${repo}#${prNumber} — Paul flagged in Linear`);
  }

  console.log(`[reviewer] Done: ${repo}#${prNumber}`);
}

const __test__ = {
  LAUNCHCTL,
  ENV_BIN,
  CLAUDE_STRIPPED_ENV_VARS,
  resolveAcpxCliPath,
  resolveClaudeCliPath,
  resolveCodexCliPath,
  spawnClaude,
  shouldQueueFollowUpForReview,
  queueFollowUpForPostedReview,
  isLaunchctlSessionFailure,
  isClaudeLoggedOutStatus,
  resolveClaudeAuthProbeTimeoutMs,
  resolveCodexAuthPath,
  resolveCodexExecOverrides,
  resolveProgressTimeoutMs,
  resolveReviewerTimeoutMs,
  spawnCaptured,
  fetchPRDiff,
  buildClaudeReviewArgs,
  buildCodexReviewArgs,
  parseCodexJsonTokenUsage,
  postGitHubReview,
  spawnCodexReview,
  resolveGeminiCliPath,
  resolveGeminiOAuthCredsPath,
  assertGeminiOAuth,
  resolveGeminiReviewerModel,
  resolveReviewerMetadata,
  buildGeminiReviewArgs,
  isRetryableGeminiSubprocessError,
  spawnGeminiReview,
  reviewWithGemini,
  dispatchReviewerModel,
  postGitHubReviewWithCapture,
  isRetryableGhTransportError,
  isReviewerPostAuthFailure,
  resolveReviewerIdentityForBotTokenEnv,
  LOCAL_REVIEW_SHADOW_LABEL,
  LOCAL_REVIEW_SHADOW_MODEL_METADATA,
  evaluateLocalReviewShadowEligibility,
  createOrLoadLocalReviewShadowRequest,
  reconcileLocalReviewShadow,
  runLocalReviewShadowViaLiteLLM,
  renderLocalReviewShadowArtifact,
  localReviewShadowRequestPath,
  localReviewShadowArtifactPath,
  buildLocalReviewShadowKey,
  resolveLocalReviewShadowModel,
  resolveBuilderFamily,
  resolveHostedReviewerFamily,
};

export {
  CLAUDE_CLI,
  CODEX_CLI,
  GEMINI_CLI,
  assertClaudeOAuth,
  assertCodexOAuth,
  sanitizeCodexReviewPayload,
  buildReviewerPromptPrefix,
  spawnCaptured,
  resolveReviewerTimeoutMs,
  isFinalReviewRound,
  detectSpecTouchViolations,
  clearPendingReviewsForSelf,
  ADVERSARIAL_PROMPT,
  ADVERSARIAL_PROMPT_FINAL_ROUND_ADDENDUM,
  __test__,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[reviewer] Unhandled error:', err);
    process.exit(1);
  });
}
