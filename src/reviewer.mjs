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
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname, homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { apiStatusFromError, recordApiCall } from './api-telemetry.mjs';
import { awaitThrottleIfNeeded } from './rate-limit-throttle.mjs';
import { resolveGitHubAppBotLogin } from './github-app-identity.mjs';
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
import { emitReviewedAttestation } from './reviewed-attestation.mjs';
import { resolveReviewerAppToken } from './reviewer-broker-refresh.mjs';
import { preflightGeminiReviewerToken } from './gemini-reviewer-preflight.mjs';
import { materializePerWorkerCodexAuth } from './codex-per-worker-auth.mjs';
import { clearPendingReviewsForSelf } from './reviewer-pre-write.mjs';
import {
  openReviewerFence,
  resolveAdversarialReviewStateDir,
  resolveSigtermFenceGraceSeconds,
} from './reviewer-fence.mjs';
import {
  resolveAgyPrintTimeoutMs,
  resolveAgyReviewerSubprocessTimeoutMs,
  resolveProgressTimeoutMs,
  resolveReviewerTimeoutMs,
} from './reviewer-timeout.mjs';
import { spawnCapturedProcessGroup } from './process-group-spawn.mjs';
import { extractReviewVerdict, looksLikeRuntimeJunk, normalizeEffectiveReviewVerdict, normalizeReviewVerdict, normalizeWhitespace, sanitizeCodexReviewPayload, sanitizeReviewPayloadBestEffort } from './kernel/verdict.mjs';
import { loadStagePrompt, pickReviewerStage } from './kernel/prompt-stage.mjs';
import { createLinearTriageAdapter } from './adapters/operator/linear-triage/index.mjs';
import { getConfig } from './config-loader.mjs';
import { parseCodexJsonTokenUsage } from './adapters/reviewer-runtime/cli-direct/index.mjs';
import { OAUTH_ENV_STRIP_LIST, scrubOAuthFallbackEnv } from './secret-source/env.mjs';
import {
  fetchPullRequestHeadAndState,
  fetchPullRequestReviewContext,
} from './github-api.mjs';
import {
  resolveHandoffConfig,
  signalFollowUpDaemonWake,
} from './handoff-wake.mjs';
import {
  adapterUnsupportedError,
  writeAdapterPullRequestReview,
} from './github-adapter-client.mjs';
import { GH_LOOKUP_TIMEOUT_MS, execGhWithRetry } from './gh-cli.mjs';
import { fetchLatestLabelEvent } from './github-label-events.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import {
  appendScopeViolationFinding,
  resolveAdditiveOnlyScopeReview,
  reviewBodyHasScopeViolationFinding,
} from './additive-only-scope.mjs';
import {
  AGY_KEYCHAIN_ACCOUNT,
  AGY_KEYCHAIN_REMEDIATION,
  AGY_KEYCHAIN_SERVICE,
  checkAgyReviewerAuth,
  resolveAgyAuthProbeTimeoutMs,
} from './agy-reviewer-auth.mjs';
import { resolveGeminiRuntime, resolveGeminiAntigravityModel } from './role-config.mjs';

const REVIEW_ADAPTER_ENV_KEYS = [
  'USER',
  'LOGNAME',
  'TMPDIR',
  'GH_CONFIG_DIR',
  'GH_HOST',
  'GITHUB_HOST',
  'LANG',
  'LC_ALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE_BUNDLE',
  'GHA_ADAPTER_BIN',
  'AGENT_OS_GITHUB_ADAPTER_BIN',
];

const execFileAsync = promisify(execFile);
const REVIEW_POST_RETRY_DELAYS_MS = [0];
const WAKE_HOOK_RETRY_DELAYS_MS = [250, 1_000];
const ADVISORY_ONLY_REVIEW_LABEL = 'operator-approved: advisory-only-review';
const VERDICT_MODE_ENFORCE = 'enforce';
const VERDICT_MODE_ADVISORY_ONLY = 'advisory-only';
const ENFORCE_REVIEW_HEADER_RE = /^## Adversarial Review — .+ \(.+\)$/;
const ADVISORY_ONLY_REVIEW_HEADER_RE = /^## Adversarial Review \(advisory-only\) — .+ \(.+\)$/;
const ANY_ADVERSARIAL_REVIEW_HEADER_RE = /^##\s+Adversarial Review\b.*$/;

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

async function spawnWithInput(command, args, {
  env,
  cwd,
  input = '',
  timeout = 0,
  progressTimeout = resolveProgressTimeoutMs(env),
  killGraceMs,
  maxBuffer = 10 * 1024 * 1024,
  signal,
  reapGroupOnExit = false,
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
    reapGroupOnExit,
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
const AGY_CLI = resolveAgyCliPath();

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

function resolveAgyCliPath(env = process.env) {
  return env.AGY_CLI_PATH || env.AGY_CLI || findOnPath('agy', env.PATH) || 'agy';
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

async function assertAgyReviewerAuth({
  agyCli = AGY_CLI,
  env = process.env,
  checkAuthImpl = checkAgyReviewerAuth,
  timeoutMs = resolveAgyAuthProbeTimeoutMs(env),
} = {}) {
  const result = await checkAuthImpl({ agyCli, env, timeoutMs });
  if (!result?.ok) {
    const reason = result?.reason || 'agy-probe-failed';
    const detail = result?.detail ? `: ${result.detail}` : '';
    const remediation = result?.remediation || AGY_KEYCHAIN_REMEDIATION;
    throw new OAuthError(
      'gemini',
      `Antigravity agy auth failed (${reason})${detail}. ${remediation}`
    );
  }
  return result;
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

// ── Local OSS shadow review (opt-in, non-gating) ────────────────────────────

const LOCAL_REVIEW_SHADOW_LABEL = 'run-local-review-shadow';
const LOCAL_REVIEW_SHADOW_DEFAULT_MODEL = '';
const LOCAL_REVIEW_SHADOW_DEFAULT_BASE_URL = 'http://127.0.0.1:4000';
const LOCAL_REVIEW_SHADOW_DEFAULT_TIMEOUT_MS = 120_000;

// Module-local explicit model-family metadata. Do not promote this to shared
// Agent OS CFG from this adversarial-review-only ticket.
const LOCAL_REVIEW_SHADOW_MODEL_FAMILY_BY_MODEL = Object.freeze({
  'litellm-local/qwen3-coder': 'qwen',
  'litellm-local/qwen2.5-coder': 'qwen',
  'litellm-local/gpt-oss-120b': 'openai-oss',
  'litellm-local/gpt-oss-20b': 'openai-oss',
  'openai/gpt-oss-120b': 'openai-oss',
  'openai/gpt-oss-20b': 'openai-oss',
});

const REVIEW_FAMILY_BY_BUILDER_CLASS = Object.freeze({
  codex: 'codex',
  'claude-code': 'claude',
  'clio-agent': 'codex',
  gemini: 'gemini',
  pi: 'pi',
  opencode: 'opencode',
  hermes: 'hermes',
});

const REVIEW_FAMILY_BY_REVIEWER_MODEL = Object.freeze({
  claude: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  gemini: 'gemini',
});

function logStructuredEvent(log = console, event) {
  const payload = {
    ts: new Date().toISOString(),
    ...event,
  };
  const line = JSON.stringify(payload);
  if (event?.level === 'warning') log.warn?.(line);
  else if (event?.level === 'error') log.error?.(line);
  else log.log?.(line);
}

function normalizeLabelName(label) {
  if (typeof label === 'string') return label.trim().toLowerCase();
  return String(label?.name || '').trim().toLowerCase();
}

function hasLabel(labels, labelName) {
  const expected = String(labelName || '').trim().toLowerCase();
  return Boolean(expected) && Array.isArray(labels)
    && labels.some((label) => normalizeLabelName(label) === expected);
}

function hasLocalReviewShadowLabel(labels) {
  return hasLabel(labels, LOCAL_REVIEW_SHADOW_LABEL);
}

function normalizeVerdictMode(mode) {
  return String(mode || '').trim() === VERDICT_MODE_ADVISORY_ONLY
    ? VERDICT_MODE_ADVISORY_ONLY
    : VERDICT_MODE_ENFORCE;
}

function resolveVerdictModeForHead({
  labels = [],
  currentHeadSha = null,
  reviewerHeadSha = null,
  advisoryLabelEvent = null,
  prAuthor = null,
} = {}) {
  const sameHead = (
    reviewerHeadSha &&
    currentHeadSha &&
    String(reviewerHeadSha) === String(currentHeadSha)
  );
  const actor = String(advisoryLabelEvent?.actor || '').trim();
  const author = String(prAuthor || '').trim();
  const hasEventId = Boolean(advisoryLabelEvent?.id || advisoryLabelEvent?.nodeId);
  const labelHeadMatches = String(advisoryLabelEvent?.headSha || '') === String(currentHeadSha || '');
  const nonAuthorActor = Boolean(actor) &&
    actor.toLowerCase() !== 'unknown' &&
    Boolean(author) &&
    actor.toLowerCase() !== author.toLowerCase();

  if (
    sameHead &&
    hasLabel(labels, ADVISORY_ONLY_REVIEW_LABEL) &&
    labelHeadMatches &&
    nonAuthorActor &&
    hasEventId &&
    advisoryLabelEvent?.createdAt
  ) {
    return VERDICT_MODE_ADVISORY_ONLY;
  }
  return VERDICT_MODE_ENFORCE;
}

async function fetchCurrentHeadVerdictMode({
  repo,
  prNumber,
  reviewerHeadSha = null,
  fetchPullRequestHeadAndStateImpl = fetchPullRequestHeadAndState,
  fetchLatestLabelEventImpl = fetchLatestLabelEvent,
  execFileImpl = execFileAsync,
  recordApiCallImpl = recordApiCall,
  log = console,
} = {}) {
  try {
    const current = await fetchPullRequestHeadAndStateImpl(repo, prNumber, {
      execFileImpl,
      recordApiCallImpl,
      withLabels: true,
    });
    const labels = current?.labels || [];
    const currentHeadSha = current?.headRefOid || null;
    // Normalize defensively: only a non-empty string author login is a confirmed
    // author. A malformed/loginless author object (e.g. `{}`) must resolve to null
    // so the non-author gate fails closed to enforce instead of comparing against
    // the stringified object `"[object Object]"`.
    const authorLogin = typeof current?.author === 'string'
      ? current.author
      : current?.author?.login;
    const prAuthor = (typeof authorLogin === 'string' && authorLogin.trim())
      ? authorLogin
      : null;
    const needsAdvisoryEvent = (
      reviewerHeadSha &&
      currentHeadSha &&
      String(reviewerHeadSha) === String(currentHeadSha) &&
      hasLabel(labels, ADVISORY_ONLY_REVIEW_LABEL)
    );
    const advisoryLabelEvent = needsAdvisoryEvent && typeof fetchLatestLabelEventImpl === 'function'
      ? await fetchLatestLabelEventImpl(repo, prNumber, ADVISORY_ONLY_REVIEW_LABEL, {
          execFileImpl,
          currentHeadSha,
        })
      : null;
    const verdictMode = resolveVerdictModeForHead({
      labels,
      currentHeadSha,
      reviewerHeadSha,
      advisoryLabelEvent,
      prAuthor,
    });
    if (needsAdvisoryEvent && verdictMode !== VERDICT_MODE_ADVISORY_ONLY) {
      log.warn?.(
        `[reviewer] WARN: advisory-only label for ${repo}#${prNumber}@${currentHeadSha || '<unknown-head>'} was ignored; missing current-head non-author label event audit fields`
      );
    }
    return {
      verdictMode,
      currentHeadSha,
      labels,
      advisoryLabelEvent,
      source: 'current-pr-head',
    };
  } catch (err) {
    log.warn?.(
      `[reviewer] WARN: failed to resolve advisory-only label for ${repo}#${prNumber}; using enforce mode: ${err?.message || err}`
    );
    return {
      verdictMode: VERDICT_MODE_ENFORCE,
      currentHeadSha: null,
      labels: [],
      source: 'fallback-enforce',
      error: err?.message || String(err),
    };
  }
}

function buildReviewCommentHeader({ reviewerMetadata, verdictMode }) {
  const mode = normalizeVerdictMode(verdictMode);
  if (mode === VERDICT_MODE_ADVISORY_ONLY) {
    // Keep the canonical `## Adversarial Review` marker heading and displayName in
    // advisory mode so the same heuristic used to locate enforce reviews still finds
    // advisory-only reviews; append the advisory disclaimer beneath it.
    return `## Adversarial Review (advisory-only) — ${reviewerMetadata.displayName} (${reviewerMetadata.reviewerIdentity})\n\n` +
      `**Advisory-only review** — findings below are informational; no automated remediation will run.\n\n`;
  }
  return `## Adversarial Review — ${reviewerMetadata.displayName} (${reviewerMetadata.reviewerIdentity})\n\n`;
}

function classifyReviewCommentHeader(reviewBody) {
  const [firstLine = ''] = String(reviewBody || '').split(/\r?\n/, 1);
  if (ADVISORY_ONLY_REVIEW_HEADER_RE.test(firstLine)) {
    return {
      isAdversarialReview: true,
      verdictMode: VERDICT_MODE_ADVISORY_ONLY,
      advisoryOnly: true,
    };
  }
  if (ENFORCE_REVIEW_HEADER_RE.test(firstLine)) {
    return {
      isAdversarialReview: true,
      verdictMode: VERDICT_MODE_ENFORCE,
      advisoryOnly: false,
    };
  }
  return {
    isAdversarialReview: false,
    verdictMode: null,
    advisoryOnly: false,
  };
}

function startsWithReviewCommentHeader(reviewBody) {
  const [firstLine = ''] = String(reviewBody || '').trimStart().split(/\r?\n/, 1);
  return ANY_ADVERSARIAL_REVIEW_HEADER_RE.test(firstLine.trim());
}

function insertAfterExistingReviewHeader(reviewBody, insertText) {
  const text = String(reviewBody || '').trimStart();
  const block = String(insertText || '');
  if (!block) return text;

  const lineBreakMatch = text.match(/\r?\n/);
  if (!lineBreakMatch) {
    return `${text}\n\n${block}`;
  }

  const headerLine = text.slice(0, lineBreakMatch.index);
  const rest = text
    .slice(lineBreakMatch.index + lineBreakMatch[0].length)
    .replace(/^(?:[ \t]*\r?\n)+/, '');
  return `${headerLine}\n\n${block}${rest}`;
}

function buildReviewCommentBody({
  reviewerMetadata,
  verdictMode,
  waiverAuditBlock = '',
  reviewText,
}) {
  const text = String(reviewText || '');
  if (startsWithReviewCommentHeader(text)) {
    return insertAfterExistingReviewHeader(text, waiverAuditBlock);
  }

  const header = buildReviewCommentHeader({ reviewerMetadata, verdictMode });
  return header + String(waiverAuditBlock || '') + text;
}

function normalizeBuilderTag(builderTag) {
  const normalized = String(builderTag || '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return Object.prototype.hasOwnProperty.call(REVIEW_FAMILY_BY_BUILDER_CLASS, normalized)
    ? normalized
    : null;
}

function normalizeReviewerFamily(reviewerModel) {
  const key = String(reviewerModel || '').trim().toLowerCase();
  return REVIEW_FAMILY_BY_REVIEWER_MODEL[key] || null;
}

function resolveLocalReviewShadowModel(env = process.env) {
  return String(env.ADVERSARIAL_REVIEW_LOCAL_SHADOW_MODEL || LOCAL_REVIEW_SHADOW_DEFAULT_MODEL).trim();
}

function resolveLocalReviewShadowFamily(model, {
  familyByModel = LOCAL_REVIEW_SHADOW_MODEL_FAMILY_BY_MODEL,
} = {}) {
  const key = String(model || '').trim().toLowerCase();
  return familyByModel[key] || null;
}

function resolveLocalReviewShadowTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env.ADVERSARIAL_REVIEW_LOCAL_SHADOW_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : LOCAL_REVIEW_SHADOW_DEFAULT_TIMEOUT_MS;
}

function evaluateLocalReviewShadowEligibility({
  labels,
  builderTag,
  reviewerModel,
  env = process.env,
  familyByModel = LOCAL_REVIEW_SHADOW_MODEL_FAMILY_BY_MODEL,
} = {}) {
  if (!hasLocalReviewShadowLabel(labels)) {
    return { eligible: false, reason: 'label-absent' };
  }

  const localModel = resolveLocalReviewShadowModel(env);
  const localFamily = resolveLocalReviewShadowFamily(localModel, { familyByModel });
  if (!localModel) {
    return { eligible: false, reason: 'local-model-missing' };
  }
  if (!localFamily) {
    return { eligible: false, reason: 'local-model-family-unproven', localModel };
  }

  const builderClass = normalizeBuilderTag(builderTag);
  const builderFamily = builderClass ? REVIEW_FAMILY_BY_BUILDER_CLASS[builderClass] : null;
  const hostedReviewerFamily = normalizeReviewerFamily(reviewerModel);
  const comparedFamilies = [...new Set([builderFamily, hostedReviewerFamily].filter(Boolean))];
  if (!builderFamily) {
    return { eligible: false, reason: 'builder-family-unproven', localModel, localFamily };
  }
  if (!hostedReviewerFamily) {
    return { eligible: false, reason: 'hosted-reviewer-family-unproven', localModel, localFamily, builderClass };
  }
  if (comparedFamilies.includes(localFamily)) {
    return {
      eligible: false,
      reason: 'local-model-same-family',
      localModel,
      localFamily,
      builderClass,
      builderFamily,
      hostedReviewerFamily,
    };
  }

  return {
    eligible: true,
    label: LOCAL_REVIEW_SHADOW_LABEL,
    localModel,
    localFamily,
    builderClass,
    builderFamily,
    hostedReviewerFamily,
  };
}

function safePathPart(value) {
  return String(value || 'unknown')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'unknown';
}

function localReviewShadowKey({ repo, prNumber, headSha, label = LOCAL_REVIEW_SHADOW_LABEL }) {
  return [
    safePathPart(repo).replaceAll('/', '__'),
    `pr-${safePathPart(prNumber)}`,
    safePathPart(headSha || 'unknown-head'),
    safePathPart(label),
  ].join('__');
}

function localReviewShadowDir(rootDir = ROOT) {
  return join(rootDir, 'data', 'local-review-shadow');
}

function localReviewShadowPaths(rootDir, request) {
  const key = localReviewShadowKey({
    repo: request?.repo,
    prNumber: request?.prNumber,
    headSha: request?.headSha,
    label: request?.label || LOCAL_REVIEW_SHADOW_LABEL,
  });
  const dir = localReviewShadowDir(rootDir);
  return {
    dir,
    key,
    requestPath: join(dir, 'requests', `${key}.json`),
    artifactPath: join(dir, 'artifacts', `${key}.md`),
    statePath: join(dir, 'states', `${key}.json`),
  };
}

function readJsonFileIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function ensureLocalReviewShadowWritable(paths, targets = ['requestPath', 'artifactPath', 'statePath']) {
  for (const key of targets) {
    const dir = dirname(paths[key]);
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  }
}

function persistLocalReviewShadowRequest({
  rootDir = ROOT,
  repo,
  prNumber,
  headSha,
  builderTag,
  reviewerModel,
  hostedReviewerIdentity = null,
  eligibility,
  requestedAt = new Date().toISOString(),
  writeFileAtomicImpl = writeFileAtomic,
  ensureWritableImpl = ensureLocalReviewShadowWritable,
} = {}) {
  if (!eligibility?.eligible) {
    return { persisted: false, reason: eligibility?.reason || 'not-eligible' };
  }
  const request = {
    schemaVersion: 1,
    kind: 'local-review-shadow-request',
    label: LOCAL_REVIEW_SHADOW_LABEL,
    repo,
    prNumber: Number(prNumber),
    headSha: headSha || null,
    builderTag: builderTag || null,
    reviewerModel,
    hostedReviewerIdentity,
    localModel: eligibility.localModel,
    localFamily: eligibility.localFamily,
    builderFamily: eligibility.builderFamily,
    hostedReviewerFamily: eligibility.hostedReviewerFamily,
    status: 'requested',
    requestedAt,
    hostedPostedAt: null,
  };
  const paths = localReviewShadowPaths(rootDir, request);
  ensureWritableImpl(paths, ['requestPath']);
  const existing = readJsonFileIfExists(paths.requestPath);
  const next = existing
    ? {
        ...existing,
        ...request,
        requestedAt: existing.requestedAt || requestedAt,
        hostedPostedAt: existing.hostedPostedAt || null,
      }
    : request;
  writeFileAtomicImpl(paths.requestPath, `${JSON.stringify(next, null, 2)}\n`);
  return { persisted: true, request: next, ...paths };
}

function markLocalReviewShadowHostedPosted({
  rootDir = ROOT,
  request,
  hostedPostedAt = new Date().toISOString(),
  writeFileAtomicImpl = writeFileAtomic,
  ensureWritableImpl = ensureLocalReviewShadowWritable,
} = {}) {
  if (!request) return { marked: false, reason: 'missing-request' };
  const paths = localReviewShadowPaths(rootDir, request);
  ensureWritableImpl(paths, ['requestPath']);
  const current = readJsonFileIfExists(paths.requestPath) || request;
  const next = {
    ...current,
    status: current.status === 'completed' ? 'completed' : 'hosted-posted',
    hostedPostedAt: current.hostedPostedAt || hostedPostedAt,
  };
  writeFileAtomicImpl(paths.requestPath, `${JSON.stringify(next, null, 2)}\n`);
  return { marked: true, request: next, ...paths };
}

function buildLocalReviewShadowPrompt({ hostedReviewText, diff, extraContext = '' }) {
  return [
    'You are producing a non-gating local OSS model shadow review for an already-posted hosted adversarial review.',
    'Do not claim to be Codex, Claude, Gemini, or the merge-blocking reviewer.',
    'Focus on independently useful findings. If there are no material findings, say so clearly.',
    '',
    'Already-posted hosted review:',
    '```markdown',
    String(hostedReviewText || '').trim(),
    '```',
    '',
    extraContext ? `Additional PR context:\n${extraContext.trim()}\n` : '',
    'PR diff:',
    '```diff',
    String(diff || '').trim(),
    '```',
  ].filter(Boolean).join('\n');
}

function formatAdvisoryFindingsContext(advisoryFindings = []) {
  const findings = (Array.isArray(advisoryFindings) ? advisoryFindings : [])
    .filter((finding) => finding && typeof finding === 'object');
  if (findings.length === 0) return '';
  return [
    '',
    '## Watcher Advisory Findings',
    '',
    'These findings are informational context from the watcher. Do not place them in `## Blocking Issues`, and do not change the verdict solely because of them.',
    '',
    '```json',
    JSON.stringify(findings, null, 2),
    '```',
    '',
  ].join('\n');
}

function formatLocalReviewShadowArtifact({ request, reviewText, status = 'completed', reason = null }) {
  const provenance = [
    '# Local OSS Model Shadow Review (Non-Gating)',
    '',
    `Provenance: generated by local OSS model \`${request.localModel}\` via LiteLLM for opt-in label \`${LOCAL_REVIEW_SHADOW_LABEL}\`.`,
    'This artifact is not the hosted adversarial reviewer, not Codex/Claude/Gemini reviewer identity, and not a merge gate verdict.',
    '',
    `Repo/PR: ${request.repo}#${request.prNumber}`,
    `Head SHA: ${request.headSha || 'unknown'}`,
    `Hosted reviewer model: ${request.reviewerModel || 'unknown'}`,
    `Shadow status: ${status}${reason ? ` (${reason})` : ''}`,
    '',
    '---',
    '',
  ].join('\n');
  return `${provenance}${String(reviewText || '').trim()}\n`;
}

class LocalReviewShadowFailure extends Error {
  constructor(message, {
    retryable = true,
    skipReason = null,
    statusCode = null,
    category = null,
  } = {}) {
    super(message);
    this.name = 'LocalReviewShadowFailure';
    this.retryable = retryable;
    this.skipReason = skipReason || message;
    this.statusCode = statusCode;
    this.category = category;
  }
}

function classifyLocalReviewShadowHttpFailure(status) {
  const code = Number(status);
  if (code === 401 || code === 403) {
    return { retryable: false, reason: 'local-shadow-auth-failed', category: 'auth' };
  }
  if (code === 408 || code === 425 || code === 429 || code >= 500) {
    return { retryable: true, reason: 'local-shadow-transient-http', category: 'transient-http' };
  }
  if (code >= 400 && code < 500) {
    return { retryable: false, reason: 'local-shadow-client-or-config-error', category: 'client-or-config' };
  }
  return { retryable: true, reason: 'local-shadow-http-error', category: 'http' };
}

function classifyLocalReviewShadowFailure(err) {
  if (err instanceof LocalReviewShadowFailure) {
    return {
      retryable: Boolean(err.retryable),
      reason: err.message,
      skipReason: err.skipReason || err.message,
      statusCode: err.statusCode || null,
      category: err.category || null,
    };
  }
  if (err?.name === 'AbortError') {
    return {
      retryable: true,
      reason: 'local-review-shadow-timeout',
      skipReason: 'local-shadow-timeout',
      statusCode: null,
      category: 'timeout',
    };
  }
  return {
    retryable: true,
    reason: err?.message || String(err),
    skipReason: err?.message || String(err),
    statusCode: null,
    category: 'transport-or-runtime',
  };
}

function normalizeLocalReviewShadowHostname(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

function isLoopbackLocalReviewShadowHostname(hostname) {
  const normalized = normalizeLocalReviewShadowHostname(hostname);
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1';
}

function resolveAllowedLocalReviewShadowBaseUrl(env = process.env) {
  const rawBaseUrl = String(
    env.ADVERSARIAL_REVIEW_LOCAL_SHADOW_BASE_URL || LOCAL_REVIEW_SHADOW_DEFAULT_BASE_URL
  ).trim();
  let parsed;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new LocalReviewShadowFailure(
      'local shadow LiteLLM URL is invalid',
      { retryable: false, skipReason: 'local-shadow-url-invalid', category: 'config' }
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !isLoopbackLocalReviewShadowHostname(parsed.hostname)) {
    throw new LocalReviewShadowFailure(
      'local shadow LiteLLM URL must use HTTP(S) loopback',
      { retryable: false, skipReason: 'local-shadow-url-not-loopback', category: 'config' }
    );
  }
  return parsed.toString().replace(/\/+$/, '');
}

async function callLiteLLMLocalReviewShadow({
  request,
  diff,
  hostedReviewText,
  extraContext = '',
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = resolveLocalReviewShadowTimeoutMs(env),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch unavailable for LiteLLM local review shadow');
  }
  const baseUrl = resolveAllowedLocalReviewShadowBaseUrl(env);
  const token = env.ADVERSARIAL_REVIEW_LOCAL_SHADOW_API_KEY || env.LITELLM_API_KEY || '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('local-review-shadow-timeout')), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        model: request.localModel,
        messages: [
          {
            role: 'user',
            content: buildLocalReviewShadowPrompt({ hostedReviewText, diff, extraContext }),
          },
        ],
        temperature: 0.1,
      }),
    });
    if (!response?.ok) {
      const classification = classifyLocalReviewShadowHttpFailure(response?.status);
      throw new LocalReviewShadowFailure(
        `LiteLLM local review shadow failed: HTTP ${response?.status || 'unknown'} (${classification.reason})`,
        {
          retryable: classification.retryable,
          skipReason: classification.reason,
          statusCode: response?.status || null,
          category: classification.category,
        }
      );
    }
    let parsed;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new LocalReviewShadowFailure(
        `LiteLLM local review shadow returned invalid JSON: ${err?.message || String(err)}`,
        {
          retryable: false,
          skipReason: 'local-shadow-invalid-response',
          category: 'invalid-response',
        }
      );
    }
    const text = parsed?.choices?.[0]?.message?.content;
    if (!String(text || '').trim()) {
      throw new LocalReviewShadowFailure(
        'LiteLLM local review shadow returned empty output',
        {
          retryable: false,
          skipReason: 'local-shadow-empty-response',
          category: 'invalid-response',
        }
      );
    }
    return String(text).trim();
  } finally {
    clearTimeout(timer);
  }
}

async function completeLocalReviewShadowRequest({
  rootDir = ROOT,
  request,
  diff,
  hostedReviewText,
  extraContext = '',
  fetchImpl = globalThis.fetch,
  env = process.env,
  log = console,
  writeFileAtomicImpl = writeFileAtomic,
  ensureWritableImpl = ensureLocalReviewShadowWritable,
  callLiteLLMImpl = callLiteLLMLocalReviewShadow,
} = {}) {
  if (!request) return { completed: false, reason: 'missing-request' };
  const paths = localReviewShadowPaths(rootDir, request);
  let existingState = null;
  try {
    existingState = readJsonFileIfExists(paths.statePath);
  } catch (err) {
    log.warn?.(`[local-review-shadow] WARNING: ${request.repo}#${request.prNumber} ignored unreadable shadow state before retry: ${err?.message || String(err)}`);
  }
  if (['completed', 'skipped'].includes(existingState?.status) && existsSync(paths.artifactPath)) {
    return {
      completed: true,
      skipped: existingState.status === 'skipped',
      idempotent: true,
      reason: existingState.reason || null,
      artifactPath: paths.artifactPath,
    };
  }

  try {
    ensureWritableImpl(paths, ['artifactPath', 'statePath']);
  } catch (err) {
    const reason = 'shadow-storage-unwritable';
    log.warn?.(`[local-review-shadow] WARNING: ${request.repo}#${request.prNumber} skipped: ${reason}: ${err?.message || String(err)}`);
    return {
      completed: false,
      skipped: true,
      retryable: true,
      reason,
      error: err?.message || String(err),
    };
  }

  try {
    const shadowText = await callLiteLLMImpl({
      request,
      diff,
      hostedReviewText,
      extraContext,
      fetchImpl,
      env,
      timeoutMs: resolveLocalReviewShadowTimeoutMs(env),
    });
    const artifact = formatLocalReviewShadowArtifact({
      request,
      reviewText: shadowText,
      status: 'completed',
    });
    const completedAt = new Date().toISOString();
    writeFileAtomicImpl(paths.artifactPath, artifact);
    writeFileAtomicImpl(paths.statePath, `${JSON.stringify({
      schemaVersion: 1,
      kind: 'local-review-shadow-state',
      status: 'completed',
      repo: request.repo,
      prNumber: request.prNumber,
      headSha: request.headSha || null,
      label: LOCAL_REVIEW_SHADOW_LABEL,
      artifactPath: paths.artifactPath,
      completedAt,
      localModel: request.localModel,
      localFamily: request.localFamily,
    }, null, 2)}\n`);
    return { completed: true, artifactPath: paths.artifactPath };
  } catch (err) {
    const failure = classifyLocalReviewShadowFailure(err);
    const skippedAt = new Date().toISOString();
    const reason = failure.reason || 'local-review-shadow-failed';
    const retryable = Boolean(failure.retryable);
    const status = retryable ? 'warn-skip' : 'skipped';
    const artifactStatus = retryable ? 'warn-skip' : 'skipped';
    const skipReason = retryable ? reason : (failure.skipReason || reason);
    const artifact = formatLocalReviewShadowArtifact({
      request,
      reviewText: retryable
        ? `WARNING: local OSS shadow review skipped or retryable after hosted review posted.\n\nReason: ${reason}`
        : `Local OSS shadow review skipped after hosted review posted.\n\nReason: ${skipReason}`,
      status: artifactStatus,
      reason: skipReason,
    });
    writeFileAtomicImpl(paths.artifactPath, artifact);
    writeFileAtomicImpl(paths.statePath, `${JSON.stringify({
      schemaVersion: 1,
      kind: 'local-review-shadow-state',
      status,
      reason: skipReason,
      lastError: reason,
      retryable,
      category: failure.category || null,
      statusCode: failure.statusCode || null,
      repo: request.repo,
      prNumber: request.prNumber,
      headSha: request.headSha || null,
      label: LOCAL_REVIEW_SHADOW_LABEL,
      artifactPath: paths.artifactPath,
      skippedAt,
      localModel: request.localModel,
      localFamily: request.localFamily,
    }, null, 2)}\n`);
    log.warn?.(`[local-review-shadow] WARNING: ${request.repo}#${request.prNumber} skipped: ${reason}`);
    return {
      completed: !retryable,
      skipped: true,
      retryable,
      reason,
      artifactPath: paths.artifactPath,
    };
  }
}

function persistLocalReviewShadowRequestFailOpen({
  log = console,
  ...args
} = {}) {
  try {
    return persistLocalReviewShadowRequest(args);
  } catch (err) {
    logStructuredEvent(log, {
      event: 'local-review-shadow',
      level: 'warning',
      repo: args.repo,
      prNumber: args.prNumber,
      phase: 'request',
      eligible: true,
      reason: 'request-persist-failed',
      error: err?.message || String(err),
    });
    return { persisted: false, reason: 'request-persist-failed', error: err?.message || String(err) };
  }
}

function startLocalReviewShadowCompletion({
  rootDir = ROOT,
  request,
  diff,
  hostedReviewText,
  extraContext = '',
  fetchImpl = globalThis.fetch,
  env = process.env,
  log = console,
  callLiteLLMImpl = callLiteLLMLocalReviewShadow,
} = {}) {
  if (!request) return { started: false, reason: 'missing-request' };
  const shadowStartedAt = Date.now();
  const completion = (async () => {
    try {
      const shadow = await completeLocalReviewShadowRequest({
        rootDir,
        request,
        diff,
        hostedReviewText,
        extraContext,
        fetchImpl,
        env,
        log,
        callLiteLLMImpl,
      });
      logStructuredEvent(log, {
        event: 'local-review-shadow',
        level: shadow.completed ? 'info' : 'warning',
        repo: request.repo,
        prNumber: request.prNumber,
        phase: 'artifact',
        completed: Boolean(shadow.completed),
        skipped: Boolean(shadow.skipped),
        retryable: Boolean(shadow.retryable),
        reason: shadow.reason || null,
        artifactPath: shadow.artifactPath || null,
        durationMs: Date.now() - shadowStartedAt,
      });
      return shadow;
    } catch (err) {
      logStructuredEvent(log, {
        event: 'local-review-shadow',
        level: 'warning',
        repo: request.repo,
        prNumber: request.prNumber,
        phase: 'artifact',
        completed: false,
        retryable: true,
        reason: err?.message || String(err),
        durationMs: Date.now() - shadowStartedAt,
      });
      return { completed: false, retryable: true, reason: err?.message || String(err) };
    }
  })();
  completion.catch(() => {});
  return { started: true, completion };
}

async function reconcileLocalReviewShadow({
  rootDir = ROOT,
  repo,
  prNumber,
  headSha,
  labels,
  builderTag,
  reviewerModel,
  hostedReviewPosted = false,
  hostedReviewText = '',
  diff = '',
  extraContext = '',
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console,
  writeFileAtomicImpl = writeFileAtomic,
  callLiteLLMImpl = callLiteLLMLocalReviewShadow,
  ensureWritableImpl = ensureLocalReviewShadowWritable,
} = {}) {
  const eligibility = evaluateLocalReviewShadowEligibility({ labels, builderTag, reviewerModel, env });
  if (!eligibility.eligible) {
    return { reconciled: false, reason: eligibility.reason };
  }
  const persisted = persistLocalReviewShadowRequest({
    rootDir,
    repo,
    prNumber,
    headSha,
    builderTag,
    reviewerModel,
    eligibility,
    writeFileAtomicImpl,
    ensureWritableImpl,
  });
  if (!hostedReviewPosted) {
    return { reconciled: false, reason: 'hosted-review-not-posted', requestPath: persisted.requestPath };
  }
  const marked = markLocalReviewShadowHostedPosted({
    rootDir,
    request: persisted.request,
    writeFileAtomicImpl,
    ensureWritableImpl,
  });
  const completed = await completeLocalReviewShadowRequest({
    rootDir,
    request: marked.request,
    diff,
    hostedReviewText,
    extraContext,
    fetchImpl,
    env,
    log,
    writeFileAtomicImpl,
    callLiteLLMImpl,
    ensureWritableImpl,
  });
  return { reconciled: true, requestPath: marked.requestPath, ...completed };
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

function buildReviewerPrompt({ promptPrefix, extraContext = '', diff = '' } = {}) {
  return `${promptPrefix || ''}${extraContext}\n\n---\n\nHere is the PR diff to review:\n\n\`\`\`diff\n${diff}\`\`\``;
}

function buildPromptForReviewerModel(reviewerModel, diff, extraContext = '', { promptStage = 'first', runtime = null } = {}) {
  const model = String(reviewerModel || '').trim().toLowerCase();
  const promptPrefix = model === 'gemini' && runtime === 'antigravity'
    ? buildAgyReviewerPromptPrefix({ stage: promptStage })
    : buildReviewerPromptPrefix({ stage: promptStage });
  return buildReviewerPrompt({ promptPrefix, extraContext, diff });
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
  verdictMode = VERDICT_MODE_ENFORCE,
  summarizePRRemediationLedgerImpl = summarizePRRemediationLedger,
  createFollowUpJobImpl = createFollowUpJob,
  resolveHandoffConfigImpl = () => resolveHandoffConfig({ getConfigImpl: getConfig }),
  signalFollowUpDaemonWakeImpl = signalFollowUpDaemonWake,
  scopeViolationFinding = null,
}) {
  const normalizedVerdictMode = normalizeVerdictMode(verdictMode);
  if (normalizedVerdictMode === VERDICT_MODE_ADVISORY_ONLY) {
    return {
      queued: false,
      reason: 'advisory-only-review',
      verdictMode: normalizedVerdictMode,
    };
  }
  if (!shouldQueueFollowUpForReview(reviewText)) {
    return { queued: false, reason: 'empty-review-body', verdictMode: normalizedVerdictMode };
  }
  if (scopeViolationFinding || reviewBodyHasScopeViolationFinding(reviewText)) {
    return { queued: false, reason: 'scope-violation' };
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
    verdictMode: normalizedVerdictMode,
    riskClass: tierResolution.riskClass,
    priorCompletedRounds: priorLedger.completedRoundsForPR,
    ...(elevatedPriorCap ? { maxRemediationRounds: elevatedPriorCap } : {}),
  });
  let handoffWake = { attempted: false };
  try {
    const handoffConfig = resolveHandoffConfigImpl();
    if (handoffConfig.enabled && handoffConfig.reviewToRemediation) {
      const wake = signalFollowUpDaemonWakeImpl({
        rootDir,
        reason: 'review-to-remediation',
        repo,
        prNumber,
        headSha: revisionRef,
      });
      handoffWake = { attempted: true, ok: true, ...wake };
    }
  } catch (err) {
    handoffWake = {
      attempted: true,
      ok: false,
      error: err?.message || String(err),
    };
  }
  return { queued: true, jobPath, verdictMode: normalizedVerdictMode, handoffWake };
}

// ── PR diff fetch ────────────────────────────────────────────────────────────

async function fetchPRDiff(repo, prNumber, headSha, {
  execFileImpl = execFileAsync,
  execGhWithRetryImpl = execGhWithRetry,
  getCachedDiffImpl = getCachedDiff,
  putCachedDiffImpl = putCachedDiff,
  recordApiCallImpl = recordApiCall,
  apiStatusFromErrorImpl = apiStatusFromError,
  ghRetrySleepImpl = sleep,
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

  const { stdout } = await execGhWithRetryImpl({
    execFileImpl: async (command, args, options) => {
      const attemptStartedAt = Date.now();
      try {
        const result = await execFileImpl(
          command,
          args,
          { ...options, encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }
        );
        recordApiCallImpl({
          category: 'diff_fetch',
          repo,
          prNumber,
          status: 200,
          durationMs: Date.now() - attemptStartedAt,
        });
        return result;
      } catch (err) {
        recordApiCallImpl({
          category: 'diff_fetch',
          repo,
          prNumber,
          status: apiStatusFromErrorImpl(err),
          durationMs: Date.now() - attemptStartedAt,
        });
        throw err;
      }
    },
    args: ['pr', 'diff', String(prNumber), '--repo', repo],
    timeoutMs: Math.max(GH_LOOKUP_TIMEOUT_MS, 60_000),
    sleep: ghRetrySleepImpl,
  });
  if (headSha) {
    try {
      putCachedDiffImpl(repo, prNumber, headSha, stdout);
    } catch (err) {
      log.warn?.(`[reviewer] WARN: failed to write diff cache for ${repo}#${prNumber}@${headSha}: ${err?.message || err}`);
    }
  }
  return stdout;
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
  const prompt = buildReviewerPrompt({ promptPrefix, extraContext, diff });

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

  // `--output-format json` wraps the response as {result, usage, ...}. Extract the
  // review text (result) for downstream posting AND the exact usage block, so
  // claude reviewers no longer depend on the flaky ~/.claude/projects transcript
  // scrape (which missed ~90% of passes -> token_source='unknown'). Fail closed:
  // malformed JSON or an invalid result must use the normal reviewer retry path,
  // not post a raw CLI payload as a GitHub review.
  const raw = stdout.trim();
  const parsed = parseClaudeJsonOutput(raw);
  return { reviewText: parsed.reviewText, tokenUsage: parsed.tokenUsage };
}

function parseClaudeJsonOutput(raw) {
  let doc;
  const jsonText = extractClaudeJsonText(raw);
  try {
    doc = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Failed to parse Claude JSON output: ${err.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Claude JSON output is not an object');
  }
  if (typeof doc.result !== 'string') {
    throw new Error("Claude JSON output missing string 'result' field");
  }
  if (!doc.result.trim()) {
    throw new Error("Claude JSON output contains empty 'result' field");
  }
  return { reviewText: doc.result, tokenUsage: mapClaudeJsonUsage(doc.usage) };
}

function extractClaudeJsonText(raw) {
  const text = String(raw ?? '').trim();
  const jsonStart = text.indexOf('{');
  if (jsonStart < 0) {
    return text;
  }
  return text.slice(jsonStart);
}

function mapClaudeJsonUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  if (input === null && output === null && cacheRead === null && cacheWrite === null) {
    return null;
  }
  return {
    input,
    output,
    // Claude does not expose reasoning as a separate dimension (thinking is
    // folded into output_tokens); no tool-context dimension either.
    cacheRead,
    cacheWrite,
    total: (input || 0) + (output || 0) + (cacheRead || 0) + (cacheWrite || 0),
    source: 'claude-json',
  };
}

function buildClaudeReviewArgs(prompt) {
  return ['--print', '--output-format', 'json', '--permission-mode', 'bypassPermissions', prompt];
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

function estimateTokensFromText(text) {
  // ~4 chars/token heuristic; a visible-text LOWER BOUND (system prompt, tools,
  // and reasoning tokens are unseen), hence a floor, not an exact count. Used
  // only for antigravity (agy) reviewers, which expose no local usage.
  const s = typeof text === 'string' ? text : '';
  return Math.max(0, Math.round(s.length / 4));
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
  const prompt = buildReviewerPrompt({ promptPrefix, extraContext, diff });
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

const DEFAULT_CQP_BROKER_URL = 'http://127.0.0.1:4099';
const GEMINI_REVIEWER_SESSION_DIR_PREFIX = 'review-';
const GEMINI_CQP_CHECKOUT_TIMEOUT_MS = 5_000;
const GEMINI_CQP_FALLBACK_LOCK_WAIT_MS = 30 * 60 * 1000;
const GEMINI_REVIEWER_SESSION_STALE_AGE_MS = 12 * 60 * 60 * 1000;
let geminiReviewerSessionPreflightDone = false;

class GeminiCredentialPoolUnavailableError extends Error {
  constructor(reason, { cause } = {}) {
    super(`Gemini credential checkout unavailable: ${reason}`);
    this.name = 'GeminiCredentialPoolUnavailableError';
    this.cause = cause;
    this.isGeminiCredentialPoolUnavailable = true;
  }
}

class GeminiCredentialPoolNoCreditError extends Error {
  constructor(reason = 'no-credit') {
    super(`Gemini credential checkout deferred: ${reason}`);
    this.name = 'GeminiCredentialPoolNoCreditError';
    this.isGeminiCredentialPoolNoCredit = true;
  }
}

function resolveGeminiReviewerSessionParent(env = process.env) {
  if (env.GEMINI_REVIEWER_SESSION_PARENT) return env.GEMINI_REVIEWER_SESSION_PARENT;
  return join(env.HOME || homedir(), '.gemini', 'reviewer-sessions');
}

function normalizeGeminiReviewerHostname(value) {
  return String(value || '').trim().toLowerCase();
}

function currentGeminiReviewerHostname() {
  return normalizeGeminiReviewerHostname(hostname());
}

function maybeChmodOwnedPath(path, mode, { chmodSyncImpl = chmodSync, log = console } = {}) {
  try {
    chmodSyncImpl(path, mode);
  } catch (err) {
    if (err?.code !== 'EPERM') throw err;
    log.warn?.(`[reviewWithGemini] WARN: cannot chmod shared Gemini reviewer path ${path}: ${err.message}`);
  }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    return true;
  }
}

function readGeminiReviewerOwner(fullPath, { readFileSyncImpl = readFileSync } = {}) {
  try {
    const owner = JSON.parse(readFileSyncImpl(join(fullPath, 'owner.json'), 'utf8'));
    return owner && typeof owner === 'object' ? owner : null;
  } catch {
    return null;
  }
}

function shouldPurgeGeminiReviewerSessionDir(name, fullPath, {
  nowMs = Date.now(),
  staleAgeMs = GEMINI_REVIEWER_SESSION_STALE_AGE_MS,
  statSyncImpl = statSync,
  readFileSyncImpl = readFileSync,
  isProcessAliveImpl = isProcessAlive,
  localHostname = currentGeminiReviewerHostname(),
} = {}) {
  const owner = readGeminiReviewerOwner(fullPath, { readFileSyncImpl });
  const ownerHostname = normalizeGeminiReviewerHostname(owner?.hostname);
  const normalizedLocalHostname = normalizeGeminiReviewerHostname(localHostname);
  if (ownerHostname) {
    if (normalizedLocalHostname && ownerHostname !== normalizedLocalHostname) return false;
    const ownerPid = Number(owner?.pid);
    if (Number.isSafeInteger(ownerPid) && ownerPid > 0) return !isProcessAliveImpl(ownerPid);
  }
  try {
    const stat = statSyncImpl(fullPath);
    return nowMs - stat.mtimeMs > staleAgeMs;
  } catch {
    return false;
  }
}

function purgeStaleGeminiReviewerSessionDirs({
  env = process.env,
  sessionParent = resolveGeminiReviewerSessionParent(env),
  rmSyncImpl = rmSync,
  readdirSyncImpl = readdirSync,
  mkdirSyncImpl = mkdirSync,
  statSyncImpl = statSync,
  readFileSyncImpl = readFileSync,
  chmodSyncImpl = chmodSync,
  isProcessAliveImpl = isProcessAlive,
  localHostname = currentGeminiReviewerHostname(),
  nowMs = Date.now(),
  staleAgeMs = GEMINI_REVIEWER_SESSION_STALE_AGE_MS,
  log = console,
} = {}) {
  mkdirSyncImpl(sessionParent, { recursive: true, mode: 0o700 });
  maybeChmodOwnedPath(sessionParent, 0o700, { chmodSyncImpl, log });
  let entries = [];
  try {
    entries = readdirSyncImpl(sessionParent, { withFileTypes: true });
  } catch {
    return { sessionParent, purged: 0 };
  }
  let purged = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(GEMINI_REVIEWER_SESSION_DIR_PREFIX)) continue;
    const fullPath = join(sessionParent, entry.name);
    if (!shouldPurgeGeminiReviewerSessionDir(entry.name, fullPath, {
      nowMs,
      staleAgeMs,
      statSyncImpl,
      readFileSyncImpl,
      isProcessAliveImpl,
      localHostname,
    })) continue;
    try {
      rmSyncImpl(fullPath, { recursive: true, force: true });
      purged += 1;
    } catch (err) {
      log.warn?.(`[reviewWithGemini] WARN: failed to purge stale Gemini reviewer session ${entry.name}: ${err.message}`);
    }
  }
  return { sessionParent, purged };
}

function resetGeminiReviewerSessionPreflightForTest() {
  geminiReviewerSessionPreflightDone = false;
}

function createGeminiReviewerSessionDir({
  env = process.env,
  sessionParent = resolveGeminiReviewerSessionParent(env),
  mkdirSyncImpl = mkdirSync,
  writeFileSyncImpl = writeFileSync,
  rmSyncImpl = rmSync,
  chmodSyncImpl = chmodSync,
  log = console,
} = {}) {
  mkdirSyncImpl(sessionParent, { recursive: true, mode: 0o700 });
  maybeChmodOwnedPath(sessionParent, 0o700, { chmodSyncImpl, log });
  const sessionDir = join(
    sessionParent,
    `${GEMINI_REVIEWER_SESSION_DIR_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  mkdirSyncImpl(sessionDir, { mode: 0o700 });
  try {
    writeFileSyncImpl(join(sessionDir, 'owner.json'), `${JSON.stringify({
      pid: process.pid,
      hostname: currentGeminiReviewerHostname(),
      acquiredAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    chmodSyncImpl(sessionDir, 0o700);
  } catch (err) {
    rmSyncImpl(sessionDir, { recursive: true, force: true });
    throw err;
  }
  return sessionDir;
}

function normalizeGeminiOauthCredsPayload(body) {
  const candidates = [
    body?.oauth_creds_json,
    body?.oauthCredsJson,
    body?.credentials?.oauth_creds_json,
    body?.credentials?.oauthCredsJson,
    body?.credential?.oauth_creds_json,
    body?.credential?.oauthCredsJson,
    body?.credential?.secret_json,
    body?.credential?.secretJson,
    body?.credential?.value,
    body?.credential,
    body?.credentials,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'string') {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        continue;
      }
    }
    if (typeof candidate === 'object' && candidate.access_token) return candidate;
  }
  if (body?.access_token) {
    return {
      access_token: body.access_token,
      expires_at: body.expires_at,
      metadata: body.metadata,
    };
  }
  return null;
}

function normalizeGeminiCheckout(body) {
  const oauthCreds = normalizeGeminiOauthCredsPayload(body);
  const checkoutId = body?.checkout_id || body?.checkoutId || body?.lease_id || body?.leaseId || body?.lease?.id || body?.id || null;
  const credentialId = body?.credential_id || body?.credentialId || body?.credential?.id || body?.credentials?.id || null;
  if (!oauthCreds?.access_token) {
    throw new GeminiCredentialPoolUnavailableError('broker response missing oauth credential JSON');
  }
  if (!checkoutId) {
    throw new GeminiCredentialPoolUnavailableError('broker response missing checkout id');
  }
  return {
    checkoutId: String(checkoutId),
    credentialId: credentialId ? String(credentialId) : null,
    oauthCreds,
    releaseUrl: body?.release_url || body?.releaseUrl || null,
    quotaUrl: body?.quota_url || body?.quotaUrl || null,
  };
}

function isTypedNoCreditResponse(status, body) {
  const values = [
    body?.type,
    body?.status,
    body?.code,
    body?.reason,
    body?.error,
    body?.error?.type,
    body?.error?.code,
    body?.error?.reason,
  ].map((value) => String(value || '').trim().toLowerCase());
  return values.some((value) => value === 'no-credit' || value === 'no_credit' || value === 'quota-exhausted')
    || ((status === 409 || status === 429) && values.some((value) => value.includes('no-credit') || value.includes('quota')));
}

function stringifyGeminiBrokerReason(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveCqpBrokerConfig(env = process.env) {
  return {
    brokerUrl: (env.CQP_BROKER_URL || env.OAUTH_BROKER_URL || DEFAULT_CQP_BROKER_URL).replace(/\/+$/, ''),
    secretFile: env.CQP_BROKER_SHARED_SECRET_FILE || env.OAUTH_BROKER_SHARED_SECRET_FILE || '',
  };
}

function readCqpBrokerSecret({ env = process.env, readFileImpl = readFileSync } = {}) {
  const { secretFile } = resolveCqpBrokerConfig(env);
  if (!secretFile) return '';
  return String(readFileImpl(secretFile, 'utf8') || '').trim();
}

async function readJsonResponse(res) {
  try {
    return await res.json();
  } catch (err) {
    throw new GeminiCredentialPoolUnavailableError(`malformed broker JSON response: ${err.message}`, { cause: err });
  }
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkoutGeminiCredentialFromBroker({
  env = process.env,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFileSync,
  timeoutMs = GEMINI_CQP_CHECKOUT_TIMEOUT_MS,
} = {}) {
  const { brokerUrl } = resolveCqpBrokerConfig(env);
  const secret = readCqpBrokerSecret({ env, readFileImpl });
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  let res;
  try {
    res = await fetchWithTimeout(fetchImpl, `${brokerUrl}/checkout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        provider: 'gemini',
        consumer: 'adversarial-reviewer',
        pid: process.pid,
        ttl_seconds: 30 * 60,
      }),
    }, timeoutMs);
  } catch (err) {
    throw new GeminiCredentialPoolUnavailableError(err?.name === 'AbortError' ? 'broker checkout timed out' : err.message, { cause: err });
  }
  const body = await readJsonResponse(res);
  if (isTypedNoCreditResponse(res.status, body)) {
    throw new GeminiCredentialPoolNoCreditError(
      stringifyGeminiBrokerReason(body?.reason)
      || stringifyGeminiBrokerReason(body?.error?.reason)
      || stringifyGeminiBrokerReason(body?.error)
      || 'no-credit'
    );
  }
  if (!res.ok) {
    throw new GeminiCredentialPoolUnavailableError(`broker returned HTTP ${res.status}`);
  }
  try {
    return normalizeGeminiCheckout(body);
  } catch (err) {
    const checkoutId = body?.checkout_id || body?.checkoutId || body?.lease_id || body?.leaseId || body?.lease?.id || body?.id || null;
    if (checkoutId) {
      await releaseGeminiCredentialCheckout({
        checkout: {
          checkoutId: String(checkoutId),
          credentialId: body?.credential_id || body?.credentialId || body?.credential?.id || body?.credentials?.id || null,
          releaseUrl: body?.release_url || body?.releaseUrl || null,
        },
        quotaSignal: false,
        env,
        fetchImpl,
        readFileImpl,
        timeoutMs,
      });
    }
    throw err;
  }
}

async function releaseGeminiCredentialCheckout({
  checkout,
  quotaSignal = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFileSync,
  timeoutMs = GEMINI_CQP_CHECKOUT_TIMEOUT_MS,
  log = console,
} = {}) {
  if (!checkout?.checkoutId || typeof fetchImpl !== 'function') return;
  const { brokerUrl } = resolveCqpBrokerConfig(env);
  const secret = readCqpBrokerSecret({ env, readFileImpl });
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const url = quotaSignal && checkout.quotaUrl
    ? checkout.quotaUrl
    : checkout.releaseUrl || `${brokerUrl}/checkout/release`;
  const payload = {
    provider: 'gemini',
    lease_id: checkout.checkoutId,
    credential_id: checkout.credentialId,
    kind: quotaSignal ? 'quota_exhausted' : 'release',
    window: 'weekly',
    reset_at: env.CQP_GEMINI_QUOTA_RESET_AT || nextWeeklyQuotaResetIso(),
  };
  if (!quotaSignal) {
    payload.unit = 'requests';
    const requestLimit = quotaLimitFromEnv(env.CQP_GEMINI_QUOTA_LIMIT_REQUESTS, 1000);
    if (requestLimit >= 0) {
      payload.limit = requestLimit;
    }
  }
  try {
    await fetchWithTimeout(fetchImpl, url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }, timeoutMs);
  } catch (err) {
    log.warn?.(`[reviewWithGemini] WARN: failed to release Gemini credential checkout ${checkout.checkoutId}: ${err.message}`);
  }
}

function nextWeeklyQuotaResetIso(nowMs = Date.now()) {
  const now = new Date(nowMs);
  const reset = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0
  ));
  const daysUntilMonday = (8 - reset.getUTCDay()) % 7 || 7;
  reset.setUTCDate(reset.getUTCDate() + daysUntilMonday);
  return reset.toISOString();
}

function quotaLimitFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function geminiSpendReportsForUsage(tokenUsage, env = process.env) {
  const reports = [{
    unit: 'requests',
    amount: 1,
    window: 'weekly',
    limit: quotaLimitFromEnv(env.CQP_GEMINI_QUOTA_LIMIT_REQUESTS, 1000),
    reset_at: env.CQP_GEMINI_QUOTA_RESET_AT || nextWeeklyQuotaResetIso(),
  }];
  const totalTokens = Number(tokenUsage?.total);
  if (Number.isFinite(totalTokens) && totalTokens > 0) {
    reports.push({
      unit: 'tokens',
      amount: Math.trunc(totalTokens),
      window: 'weekly',
      limit: quotaLimitFromEnv(env.CQP_GEMINI_QUOTA_LIMIT_TOKENS, 1_000_000),
      reset_at: env.CQP_GEMINI_QUOTA_RESET_AT || nextWeeklyQuotaResetIso(),
    });
  }
  return reports.filter((report) => Number.isFinite(report.limit) && report.limit >= 0);
}

async function reportGeminiCredentialSpend({
  checkout,
  tokenUsage = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFileSync,
  timeoutMs = GEMINI_CQP_CHECKOUT_TIMEOUT_MS,
  log = console,
} = {}) {
  if (!checkout?.credentialId || typeof fetchImpl !== 'function') return;
  const { brokerUrl } = resolveCqpBrokerConfig(env);
  const secret = readCqpBrokerSecret({ env, readFileImpl });
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  for (const report of geminiSpendReportsForUsage(tokenUsage, env)) {
    try {
      await fetchWithTimeout(fetchImpl, `${brokerUrl}/quota/report`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          provider: 'gemini',
          credential_id: checkout.credentialId,
          kind: 'spend',
          ...report,
        }),
      }, timeoutMs);
    } catch (err) {
      log.warn?.(`[reviewWithGemini] WARN: failed to report Gemini credential spend ${checkout.credentialId}: ${err.message}`);
    }
  }
}

function materializeGeminiCheckoutSession({
  checkout,
  env = process.env,
  sessionParent = resolveGeminiReviewerSessionParent(env),
  writeFileSyncImpl = writeFileSync,
} = {}) {
  const sessionDir = createGeminiReviewerSessionDir({ env, sessionParent });
  const credsPath = join(sessionDir, 'oauth_creds.json');
  writeFileSyncImpl(credsPath, `${JSON.stringify(checkout.oauthCreds, null, 2)}\n`, { mode: 0o600 });
  chmodSync(credsPath, 0o600);
  return {
    sessionDir,
    credsPath,
    env: {
      ...env,
      GEMINI_HOME: sessionDir,
      GEMINI_OAUTH_CREDS_PATH: credsPath,
    },
    cleanup() {
      rmSync(sessionDir, { recursive: true, force: true });
    },
  };
}

async function cleanupGeminiAntigravityResources({
  checkout,
  checkoutSession,
  fallbackLock,
  quotaSignal = false,
  env = process.env,
  log = console,
  releaseGeminiCredentialCheckoutImpl = releaseGeminiCredentialCheckout,
}) {
  try {
    await releaseGeminiCredentialCheckoutImpl({
      checkout,
      quotaSignal,
      env,
      log,
    });
  } catch (err) {
    log.warn?.(`[reviewWithGemini] WARN: failed to release Gemini credential checkout ${checkout?.checkoutId || 'unknown'}: ${err.message}`);
  } finally {
    try {
      checkoutSession?.cleanup();
    } finally {
      fallbackLock?.release();
    }
  }
}

async function acquireGeminiFallbackLock({
  env = process.env,
  waitMs = GEMINI_CQP_FALLBACK_LOCK_WAIT_MS,
  sleepImpl = sleep,
  writeFileSyncImpl = writeFileSync,
  readFileSyncImpl = readFileSync,
  rmSyncImpl = rmSync,
  mkdirSyncImpl = mkdirSync,
  chmodSyncImpl = chmodSync,
  isProcessAliveImpl = isProcessAlive,
  log = console,
} = {}) {
  const parent = resolveGeminiReviewerSessionParent(env);
  mkdirSyncImpl(parent, { recursive: true, mode: 0o700 });
  maybeChmodOwnedPath(parent, 0o700, { chmodSyncImpl, log });
  const lockDir = join(parent, 'legacy-fallback.lock');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSyncImpl(lockDir, { mode: 0o700 });
      try {
        writeFileSyncImpl(join(lockDir, 'owner.json'), `${JSON.stringify({
          pid: process.pid,
          hostname: currentGeminiReviewerHostname(),
          acquiredAt: new Date().toISOString(),
        })}\n`, { mode: 0o600 });
      } catch (err) {
        rmSyncImpl(lockDir, { recursive: true, force: true });
        throw err;
      }
      return {
        lockDir,
        release() {
          rmSyncImpl(lockDir, { recursive: true, force: true });
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        const owner = JSON.parse(readFileSyncImpl(join(lockDir, 'owner.json'), 'utf8'));
        const ownerPid = Number(owner?.pid);
        const ownerHostname = normalizeGeminiReviewerHostname(owner?.hostname);
        if (
          ownerHostname
          && ownerHostname === currentGeminiReviewerHostname()
          && Number.isSafeInteger(ownerPid)
          && ownerPid > 0
          && !isProcessAliveImpl(ownerPid)
        ) {
          rmSyncImpl(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Missing or malformed owner metadata is ambiguous; leave the lock in place.
      }
      if (Date.now() >= deadline) {
        throw new GeminiCredentialPoolUnavailableError('legacy fallback lock wait timed out');
      }
      await sleepImpl(100);
    }
  }
}

function looksLikeGeminiQuotaError(err, stdout = '', stderr = '') {
  const text = `${err?.message || ''}\n${err?.stdout || ''}\n${err?.stderr || ''}\n${stdout || ''}\n${stderr || ''}`.toLowerCase();
  return /\b429\b/.test(text)
    || /resource[_ -]?exhausted/.test(text)
    || /quota/.test(text)
    || /rate limit/.test(text);
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

function formatAgyPrintTimeout(timeoutMs) {
  const ms = Math.max(1_000, Math.floor(Number(timeoutMs) || 0));
  const seconds = Math.max(1, Math.floor(ms / 1000));
  return `${seconds}s`;
}

// agy's `--print` is a VALUE-taking flag (it consumes the next token as the
// prompt body), NOT a boolean. The previous form
//   ['--print', '--print-timeout', <T>, '-m', <model>]
// with the prompt on stdin caused `--print` to swallow `--print-timeout`'s
// value and left `-m`/`--model` unbound, so agy logged `model=""` and fell
// back to the persisted default ("Gemini 3.5 Flash (High)") — the reviewer
// silently ran Flash regardless of config.
//
// The verified-working form binds the model and delivers the prompt as the
// `--print` ARGUMENT:
//   ['--model', <token>, '--print-timeout', <T>, '--dangerously-skip-permissions', '--print', <prompt>]
// Every flag with its own value sits BEFORE `--print` so `--print` consumes
// the prompt (the last argv element) as its value.
function buildAgyReviewArgs({ model, prompt, printTimeoutMs = resolveAgyPrintTimeoutMs() }) {
  return [
    '--model', model,
    '--print-timeout', formatAgyPrintTimeout(printTimeoutMs),
    '--dangerously-skip-permissions',
    '--print', String(prompt ?? ''),
  ];
}

// Antigravity `agy --print <prompt>` carries the full review prompt on argv so
// `--model` remains bound. The observed agy argv budget from #3074/#3122/#3124
// is 262144 bytes; do not revert oversized prompts to stdin because stdin
// unbinds `--model` and silently runs the persisted default model.
const DEFAULT_AGY_ARGV_MAX_BYTES = 262_144;

function resolveAgyArgvMaxBytes(env = process.env) {
  const raw = env.ADVERSARIAL_REVIEW_AGY_ARGV_MAX_BYTES || env.AGY_ARGV_MAX_BYTES;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_AGY_ARGV_MAX_BYTES;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_AGY_ARGV_MAX_BYTES;
}

const AGY_ARGV_MAX_BYTES = resolveAgyArgvMaxBytes();

function agyPromptBytes(prompt) {
  return Buffer.byteLength(String(prompt ?? ''), 'utf8');
}

function assertAgyPromptFitsArgv(prompt, { maxBytes = resolveAgyArgvMaxBytes() } = {}) {
  const bytes = Buffer.byteLength(String(prompt ?? ''), 'utf8');
  if (bytes > maxBytes) {
    throw new Error(
      `Antigravity agy review prompt is ${bytes} bytes, exceeding the ${maxBytes}-byte argv budget. `
      + 'agy requires the prompt on argv to bind --model; refusing rather than reverting to the '
      + 'stdin form (which unbinds the model and silently runs the persisted default).',
    );
  }
  return bytes;
}

function hasAgyErrorSentinel(output) {
  const text = String(output ?? '');
  return /^Error:\s+timed out waiting for response\s*$/im.test(text)
    || /^Error:\s+/m.test(text)
    || /^panic:\s+/im.test(text)
    || /^fatal:\s+/im.test(text)
    || /\bagy(?:\s+\w+)*\s+failed\b/i.test(text);
}

function candidateAgyReviewBlocks(rawOutput) {
  const text = normalizeWhitespace(rawOutput);
  if (!text) return [];

  const reviewStarts = [];
  const reviewPattern = /^##\s+Adversarial Review\b.*$/gm;
  for (let match; (match = reviewPattern.exec(text));) {
    reviewStarts.push(match.index);
  }
  if (reviewStarts.length > 0) {
    return reviewStarts.map((start, index) => {
      const end = reviewStarts[index + 1] ?? text.length;
      return text.slice(start, end).trim();
    }).filter(Boolean);
  }

  const firstHeading = text.match(/^##\s+/m);
  return firstHeading ? [text.slice(firstHeading.index).trim()] : [];
}

function normalizeAgyReviewBlock(block) {
  return normalizeWhitespace(block)
    .replace(/^##\s+Verdict\s*:\s*(.+?)\s*$/gim, '## Verdict\n$1')
    .trim();
}

function sanitizeAgyReviewOutput(rawOutput) {
  const text = normalizeWhitespace(rawOutput);
  if (!text) {
    throw new Error('Antigravity agy returned empty output');
  }

  const candidates = candidateAgyReviewBlocks(text);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = normalizeAgyReviewBlock(candidates[index]);
    const verdict = normalizeReviewVerdict(extractReviewVerdict(candidate));
    if (verdict && verdict !== 'unknown') {
      return candidate;
    }
  }

  if (hasAgyErrorSentinel(text)) {
    throw new Error(`Antigravity agy returned error output instead of a review: ${previewText(text, 400)}`);
  }

  throw new Error(`Antigravity agy returned output without a parseable review verdict: ${previewText(text, 400)}`);
}

function buildAgyReviewerPromptPrefix({ stage }) {
  return `${buildReviewerPromptPrefix({ stage })}

Antigravity runtime instructions:
- This is a single-shot GitHub review. The PR diff and all needed context are already provided below.
- Review the PROVIDED diff. Do not re-list the repository, re-derive the diff with git, inspect unrelated files, or run exploratory filesystem/git commands.
- Use at most one narrowly targeted lookup only if the provided diff is insufficient to verify a concrete suspected bug. Otherwise use no tools.
- Emit ONLY the final Markdown review block for GitHub. Do not narrate your plan, tool calls, exploration steps, uncertainty, or internal reasoning.
- Start with "## Adversarial Review — Gemini (gemini-reviewer-lacey)" unless an outer caller already supplied that header.
- Include "## Verdict" with the first non-empty verdict line exactly one of: "Comment only", "Request changes", or "Approve".
- Verdict is a pure function of the structured Blocking issues list: if "## Blocking issues" is empty / "- None.", the Verdict MUST be "Comment only"; emit "Request changes" only when at least one blocking issue is listed. Non-blocking issues never escalate the verdict.`;
}

function isRetryableGeminiSubprocessError(err) {
  const detail = buildGhErrorDetail(err);
  return /\b(etimedout|econnreset|econnrefused|ehostunreach|eai_again|enotfound|epipe|eagain|eio|tls)\b/.test(detail)
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

function isRetryableCurlWakeError(err) {
  const curlTransientExitCodes = new Set([5, 6, 7, 22, 28, 35, 52, 55, 56]);
  return curlTransientExitCodes.has(Number(err?.code))
    || err?.killed === true
    || err?.signal === 'SIGTERM'
    || isRetryableGeminiSubprocessError(err);
}

async function execFileWithTransientRetry(command, args, {
  execFileImpl = execFileAsync,
  retryDelaysMs = WAKE_HOOK_RETRY_DELAYS_MS,
  sleepImpl = sleep,
  isRetryable = isRetryableCurlWakeError,
  timeout,
} = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await execFileImpl(command, args, { timeout });
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt >= retryDelaysMs.length) throw err;
      await sleepImpl(retryDelaysMs[attempt]);
    }
  }
  throw lastErr;
}

async function withGeminiSubprocessRetry(operation, {
  retryDelaysMs = REVIEW_POST_RETRY_DELAYS_MS,
  sleepImpl = sleep,
  log = console,
  isRetryableError = isRetryableGeminiSubprocessError,
} = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt >= retryDelaysMs.length) {
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

function resolveGeminiRuntimeForReview(resolveGeminiRuntimeImpl, log = console) {
  try {
    return resolveGeminiRuntimeImpl();
  } catch (err) {
    if (err?.name === 'AgentOSConfigError' && err?.key === 'reviewer.gemini.runtime') {
      log.warn?.(`[reviewWithGemini] invalid reviewer.gemini.runtime; falling back to cli until AGR-04 boot validation owns this key: ${err.message}`);
      return 'cli';
    }
    throw err;
  }
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

async function spawnAgyReview({
  agyCli = AGY_CLI,
  prompt,
  model = resolveGeminiAntigravityModel(),
  env,
  cwd = process.cwd(),
  timeout = resolveReviewerTimeoutMs(env),
  printTimeoutMs = resolveAgyPrintTimeoutMs(env),
  maxBuffer = 10 * 1024 * 1024,
  spawnWithInputImpl = spawnWithInput,
}) {
  const effectiveTimeout = resolveAgyReviewerSubprocessTimeoutMs(env, {
    reviewerTimeoutMs: timeout,
    printTimeoutMs,
  });
  // The prompt MUST travel on argv (as the `--print` value) so `--model`
  // binds. Refuse if it would blow the argv budget rather than silently
  // reverting to stdin (which unbinds the model — the bug this fixes).
  assertAgyPromptFitsArgv(prompt);
  return spawnWithInputImpl(
    agyCli,
    buildAgyReviewArgs({ model, prompt, printTimeoutMs }),
    {
      env,
      cwd,
      // Prompt is delivered on argv (see buildAgyReviewArgs); stdin is closed.
      input: '',
      timeout: effectiveTimeout,
      maxBuffer,
      // agy leaves a long-lived language-server child holding our stdout/stderr
      // pipes; without this the capture never sees EOF and every review stalls
      // until the progress/wall timeout SIGKILLs it. `reapGroupOnExit`
      // treats main-process exit as authoritative and reaps descendants.
      reapGroupOnExit: true,
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
  assertAgyAuthImpl = assertAgyReviewerAuth,
  spawnAgyReviewImpl = spawnAgyReview,
  resolveGeminiRuntimeImpl = resolveGeminiRuntime,
  checkoutGeminiCredentialImpl = checkoutGeminiCredentialFromBroker,
  releaseGeminiCredentialCheckoutImpl = releaseGeminiCredentialCheckout,
  materializeGeminiCheckoutSessionImpl = materializeGeminiCheckoutSession,
  purgeStaleGeminiReviewerSessionDirsImpl = purgeStaleGeminiReviewerSessionDirs,
  acquireGeminiFallbackLockImpl = acquireGeminiFallbackLock,
  retryDelaysMs = REVIEW_POST_RETRY_DELAYS_MS,
  sleepImpl = sleep,
  log = console,
} = {}) {
  const runtime = resolveGeminiRuntimeForReview(resolveGeminiRuntimeImpl, log);
  if (runtime !== 'cli' && runtime !== 'antigravity') {
    throw new Error(`Unsupported Gemini runtime: ${runtime}`);
  }

  // Strip API keys (incl. GEMINI_API_KEY / GOOGLE_API_KEY) before any Gemini
  // subprocess probe or review spawn so the runtime exercises OAuth only.
  const { env } = scrubOAuthFallbackEnv({
    ...process.env,
    HOME: process.env.HOME || homedir(),
  });
  let reviewEnv = env;
  let checkout = null;
  let checkoutSession = null;
  let fallbackLock = null;
  let quotaSignal = false;
  let spendReported = false;
  console.error('[reviewWithGemini] asserting OAuth...');
  if (runtime === 'antigravity') {
    if (!geminiReviewerSessionPreflightDone) {
      geminiReviewerSessionPreflightDone = true;
      purgeStaleGeminiReviewerSessionDirsImpl({ env });
    }
    try {
      checkout = await checkoutGeminiCredentialImpl({ env });
      checkoutSession = materializeGeminiCheckoutSessionImpl({ checkout, env });
      reviewEnv = checkoutSession.env;
    } catch (err) {
      if (checkout) {
        await cleanupGeminiAntigravityResources({
          checkout,
          checkoutSession,
          fallbackLock,
          quotaSignal: false,
          env,
          log,
          releaseGeminiCredentialCheckoutImpl,
        });
        checkout = null;
        checkoutSession = null;
        fallbackLock = null;
        throw err;
      }
      if (err?.isGeminiCredentialPoolNoCredit) {
        throw err;
      }
      if (!err?.isGeminiCredentialPoolUnavailable) {
        throw err;
      }
      log.warn?.(`[reviewWithGemini] WARN: ${err.message}; using serialized legacy Gemini credential fallback`);
      fallbackLock = await acquireGeminiFallbackLockImpl({ env, sleepImpl });
      reviewEnv = env;
    }
  }

  let stdout = '';
  let stderr = '';
  let subprocessStarted = false;
  try {
    if (runtime === 'antigravity') {
      await assertAgyAuthImpl({ agyCli: AGY_CLI, env: reviewEnv });
    } else {
      await assertOAuthImpl(reviewEnv);
    }
    console.error('[reviewWithGemini] OAuth OK');

    const promptPrefix = runtime === 'antigravity'
      ? buildAgyReviewerPromptPrefix({ stage: promptStage })
      : buildReviewerPromptPrefix({ stage: promptStage });
    const prompt = buildReviewerPrompt({ promptPrefix, extraContext, diff });
    // Runtime-aware model token. The token FORMATS differ and are NOT
    // interchangeable: the gemini-CLI path expects a slug (gemini-2.5-pro);
    // the agy/antigravity path expects agy's verbatim display name
    // (e.g. "Gemini 3.1 Pro (High)"). Feeding the cli slug to agy is the bug
    // that previously left the model unbound — agy ignores an unknown token and
    // falls back to its persisted default (Flash).
    const model = runtime === 'antigravity'
      ? resolveGeminiAntigravityModel({ env: reviewEnv })
      : resolveGeminiReviewerModel(reviewEnv);

    console.error(`[reviewWithGemini] invoking Gemini reviewer CLI (model=${model}, runtime=${runtime})`);
    subprocessStarted = true;
    const result = runtime === 'antigravity'
      ? await withGeminiSubprocessRetry(
        () => spawnAgyReviewImpl({
          agyCli: AGY_CLI,
          prompt,
          model,
          env: reviewEnv,
          cwd: process.cwd(),
          timeout: resolveReviewerTimeoutMs(reviewEnv),
          maxBuffer: 10 * 1024 * 1024,
        }),
        { retryDelaysMs, sleepImpl },
      )
      : await withGeminiSubprocessRetry(
        () => spawnGeminiReviewImpl({
          geminiCli: GEMINI_CLI,
          prompt,
          model,
          env: reviewEnv,
          cwd: process.cwd(),
          timeout: resolveReviewerTimeoutMs(reviewEnv),
          maxBuffer: 10 * 1024 * 1024,
        }),
        { retryDelaysMs, sleepImpl },
      );
    stdout = result.stdout || '';
    stderr = result.stderr || '';
    if (runtime === 'antigravity' && checkout?.credentialId) {
      try {
        await reportGeminiCredentialSpend({
          checkout,
          tokenUsage: result.tokenUsage || null,
          env,
          log,
        });
        spendReported = true;
      } catch (err) {
        spendReported = true;
        log.warn?.(`[reviewWithGemini] WARN: failed to report Gemini credential spend ${checkout.credentialId}: ${err.message}`);
      }
    }
  } catch (err) {
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    quotaSignal = runtime === 'antigravity' && looksLikeGeminiQuotaError(err, stdout, stderr);
    const msg = `${err.message || ''}\n${stdout}\n${stderr}`;
    if (!subprocessStarted) {
      throw err;
    }
    if (/401|unauthorized|oauth|login required|not logged in/i.test(msg)) {
      throw new OAuthError('gemini', `CLI returned auth error: ${msg.substring(0, 200)}`);
    }
    throw new Error(`Gemini exec failed: ${msg.substring(0, 800)}`);
  } finally {
    if (runtime === 'antigravity') {
      if (checkout?.credentialId && !quotaSignal && !spendReported && subprocessStarted) {
        try {
          await reportGeminiCredentialSpend({
            checkout,
            tokenUsage: null,
            env,
            log,
          });
        } catch (err) {
          log.warn?.(`[reviewWithGemini] WARN: failed to report Gemini credential spend ${checkout.credentialId}: ${err.message}`);
        }
      }
      await cleanupGeminiAntigravityResources({
        checkout,
        checkoutSession,
        fallbackLock,
        quotaSignal,
        env,
        log,
        releaseGeminiCredentialCheckoutImpl,
      });
      checkout = null;
      checkoutSession = null;
      fallbackLock = null;
    }
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

  const reviewText = runtime === 'antigravity'
    ? sanitizeAgyReviewOutput(combined)
    : combined;

  return { reviewText, tokenUsage: null };
}

// ── Reviewer-model selection ──────────────────────────────────────────────────

const REVIEWER_ROUTE_BY_MODEL = Object.freeze({
  claude: {
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
  },
  codex: {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
  gemini: {
    reviewerModel: 'gemini',
    botTokenEnv: 'GH_GEMINI_REVIEWER_TOKEN',
  },
});

const CROSS_MODEL_PRIMARY_BY_BUILDER_CLASS = Object.freeze({
  codex: 'claude',
  'claude-code': 'codex',
  'clio-agent': 'claude',
});

const DEFAULT_AGY_CHUNK_MAX_CHUNKS = 20;

function resolveAgyChunkMaxChunks(env = process.env) {
  const raw = env.ADVERSARIAL_REVIEW_AGY_CHUNK_MAX_CHUNKS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_AGY_CHUNK_MAX_CHUNKS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_AGY_CHUNK_MAX_CHUNKS;
}

function agyOversizedChunkContextSuffix(index, total) {
  return `\n\nOversized-diff chunk ${index} of ${total}. Review only this chunk; findings will be merged.`;
}

function agyOversizedChunkContextBudgetSuffix(maxChunks) {
  const safeMaxChunks = Math.max(1, Number(maxChunks) || DEFAULT_AGY_CHUNK_MAX_CHUNKS);
  return agyOversizedChunkContextSuffix(safeMaxChunks, safeMaxChunks);
}

function chooseAgyOversizedCrossModelRoute(builderTag) {
  const builderClass = normalizeBuilderTag(builderTag);
  const reviewerModel = CROSS_MODEL_PRIMARY_BY_BUILDER_CLASS[builderClass];
  if (!reviewerModel) return null;
  return REVIEWER_ROUTE_BY_MODEL[reviewerModel] || null;
}

function resolveAgyOversizedReviewRoute({
  reviewerModel,
  botTokenEnv,
  builderTag,
  diff,
  extraContext = '',
  promptStage = 'first',
  geminiRuntime = 'cli',
  maxBytes = resolveAgyArgvMaxBytes(),
} = {}) {
  const normalizedReviewer = String(reviewerModel || '').trim().toLowerCase();
  if (normalizedReviewer !== 'gemini' || geminiRuntime !== 'antigravity') {
    return {
      oversized: false,
      promptBytes: null,
      maxBytes,
      route: { reviewerModel, botTokenEnv },
    };
  }
  const prompt = buildPromptForReviewerModel('gemini', diff, extraContext, {
    promptStage,
    runtime: 'antigravity',
  });
  const promptBytes = agyPromptBytes(prompt);
  if (promptBytes <= maxBytes) {
    return {
      oversized: false,
      promptBytes,
      maxBytes,
      route: { reviewerModel, botTokenEnv },
    };
  }
  const routed = chooseAgyOversizedCrossModelRoute(builderTag);
  return {
    oversized: true,
    promptBytes,
    maxBytes,
    route: routed || null,
    reason: 'agy-argv-budget-exceeded',
  };
}

function pushAgyChunk(chunks, chunkDiff, {
  extraContext,
  promptStage,
  maxBytes,
  maxChunks,
}) {
  const diff = String(chunkDiff || '');
  if (diff === '') return { ok: true };
  const prompt = buildPromptForReviewerModel('gemini', diff, extraContext, {
    promptStage,
    runtime: 'antigravity',
  });
  const bytes = agyPromptBytes(prompt);
  if (bytes > maxBytes) return { ok: false, reason: 'chunk-over-budget', bytes };
  if (chunks.length >= maxChunks) return { ok: false, reason: 'chunk-cap-hit', bytes };
  chunks.push({ diff, promptBytes: bytes });
  return { ok: true };
}

function splitPatchHeaderAndBodyLines(lines) {
  const hunkIndex = lines.findIndex((line) => /^@@\s/.test(line));
  if (hunkIndex < 0) return { headerLines: [], bodyLines: lines };
  return {
    headerLines: lines.slice(0, hunkIndex),
    bodyLines: lines.slice(hunkIndex),
  };
}

function joinPatchLines(headerLines, bodyLines) {
  if (headerLines.length === 0) return bodyLines.join('\n');
  if (bodyLines.length === 0) return headerLines.join('\n');
  return `${headerLines.join('\n')}\n${bodyLines.join('\n')}`;
}

function splitOversizedPatchByLines(patch, {
  extraContext,
  chunkContextBudgetSuffix = '',
  promptStage,
  maxBytes,
  maxChunks,
  chunks,
}) {
  const lines = String(patch || '').replace(/\r\n/g, '\n').split('\n');
  const { headerLines, bodyLines } = splitPatchHeaderAndBodyLines(lines);
  const budgetExtraContext = `${extraContext || ''}${chunkContextBudgetSuffix || ''}`;
  const promptOverheadBytes = agyPromptBytes(buildPromptForReviewerModel('gemini', '', budgetExtraContext, {
    promptStage,
    runtime: 'antigravity',
  }));
  const headerText = headerLines.join('\n');
  const headerBytes = agyPromptBytes(headerText);
  const headerBodySeparatorBytes = headerLines.length > 0 ? 1 : 0;
  let currentLines = [];
  let currentBodyBytes = 0;
  let activeHunkLine = null;
  let activeHunkBytes = 0;
  const promptBytesForBody = (bodyBytes) => promptOverheadBytes
    + headerBytes
    + (headerLines.length > 0 && bodyBytes > 0 ? headerBodySeparatorBytes : 0)
    + bodyBytes;
  const startBodyWithLine = (line, lineBytes) => {
    if (/^@@\s/.test(line)) return { lines: [line], bytes: lineBytes };
    if (activeHunkLine) {
      return {
        lines: [activeHunkLine, line],
        bytes: activeHunkBytes + 1 + lineBytes,
      };
    }
    return { lines: [line], bytes: lineBytes };
  };
  for (const line of bodyLines) {
    const lineBytes = agyPromptBytes(line);
    if (/^@@\s/.test(line)) {
      activeHunkLine = line;
      activeHunkBytes = lineBytes;
    }
    const start = currentLines.length === 0 ? startBodyWithLine(line, lineBytes) : null;
    const candidateBodyBytes = start
      ? start.bytes
      : currentBodyBytes + 1 + lineBytes;
    const candidatePromptBytes = promptBytesForBody(candidateBodyBytes);
    if (candidatePromptBytes <= maxBytes) {
      if (start) {
        currentLines = start.lines;
      } else {
        currentLines.push(line);
      }
      currentBodyBytes = candidateBodyBytes;
      continue;
    }
    if (currentLines.length === 0) {
      return { ok: false, reason: 'single-line-over-budget' };
    }
    const pushed = pushAgyChunk(chunks, joinPatchLines(headerLines, currentLines), {
      extraContext: budgetExtraContext,
      promptStage,
      maxBytes,
      maxChunks,
    });
    if (!pushed.ok) return pushed;
    const next = startBodyWithLine(line, lineBytes);
    if (promptBytesForBody(next.bytes) > maxBytes) {
      return { ok: false, reason: 'single-line-over-budget' };
    }
    currentLines = next.lines;
    currentBodyBytes = next.bytes;
  }
  if (currentLines.length > 0) {
    const pushed = pushAgyChunk(chunks, joinPatchLines(headerLines, currentLines), {
      extraContext: budgetExtraContext,
      promptStage,
      maxBytes,
      maxChunks,
    });
    if (!pushed.ok) return pushed;
  }
  return { ok: true };
}

function splitDiffForAgyChunks(diff, {
  extraContext = '',
  chunkContextBudgetSuffix = '',
  promptStage = 'first',
  maxBytes = resolveAgyArgvMaxBytes(),
  maxChunks = resolveAgyChunkMaxChunks(),
} = {}) {
  if (maxChunks <= 0) {
    return { ok: false, chunks: [], truncated: true, reason: 'chunking-disabled' };
  }
  const chunks = [];
  const files = parseDiffFiles(diff);
  const units = files.length > 0 ? files.map((file) => file.patch) : [String(diff || '')];
  const budgetExtraContext = `${extraContext || ''}${chunkContextBudgetSuffix || ''}`;
  let pendingUnit = '';
  const canFitUnit = (unit) => pushAgyChunk([], unit, {
    extraContext: budgetExtraContext,
    promptStage,
    maxBytes,
    maxChunks: 1,
  }).ok;
  const flushPendingUnit = () => {
    if (!pendingUnit) return { ok: true };
    const pushed = pushAgyChunk(chunks, pendingUnit, {
      extraContext: budgetExtraContext,
      promptStage,
      maxBytes,
      maxChunks,
    });
    pendingUnit = '';
    return pushed;
  };
  for (const unit of units) {
    if (!unit) continue;
    if (pendingUnit) {
      const combinedUnit = `${pendingUnit}\n${unit}`;
      if (canFitUnit(combinedUnit)) {
        pendingUnit = combinedUnit;
        continue;
      }
      const flushed = flushPendingUnit();
      if (!flushed.ok) {
        if (flushed.reason === 'chunk-cap-hit') {
          return { ok: true, chunks, truncated: true, reason: flushed.reason };
        }
        return { ok: false, chunks, truncated: false, reason: flushed.reason };
      }
    }
    if (canFitUnit(unit)) {
      pendingUnit = unit;
      continue;
    }
    const flushed = flushPendingUnit();
    if (!flushed.ok) {
      if (flushed.reason === 'chunk-cap-hit') {
        return { ok: true, chunks, truncated: true, reason: flushed.reason };
      }
      return { ok: false, chunks, truncated: false, reason: flushed.reason };
    }
    const split = splitOversizedPatchByLines(unit, {
      extraContext,
      chunkContextBudgetSuffix,
      promptStage,
      maxBytes,
      maxChunks,
      chunks,
    });
    if (!split.ok) {
      if (split.reason === 'chunk-cap-hit') {
        return { ok: true, chunks, truncated: true, reason: split.reason };
      }
      return { ok: false, chunks, truncated: false, reason: split.reason };
    }
  }
  const flushed = flushPendingUnit();
  if (!flushed.ok) {
    if (flushed.reason === 'chunk-cap-hit') {
      return { ok: true, chunks, truncated: true, reason: flushed.reason };
    }
    return { ok: false, chunks, truncated: false, reason: flushed.reason };
  }
  return { ok: chunks.length > 0, chunks, truncated: false, reason: chunks.length > 0 ? null : 'empty-diff' };
}

function markdownSectionBody(markdown, heading) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const sectionStart = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (sectionStart < 0) return '';
  const sectionLines = [];
  for (const line of lines.slice(sectionStart + 1)) {
    if (/^##\s+/.test(line)) break;
    sectionLines.push(line);
  }
  return sectionLines.join('\n').trim();
}

function extractMarkdownIssueList(markdown, heading) {
  const body = markdownSectionBody(markdown, heading);
  if (!body || /^[-*+]\s+none\.?\s*$/i.test(body)) return [];
  const lines = body.split('\n');
  const issues = [];
  let current = [];
  for (const line of lines) {
    if (/^[-*+]\s+/.test(line)) {
      if (current.length > 0) issues.push(current.join('\n').trimEnd());
      current = [line];
      continue;
    }
    if (current.length > 0) current.push(line);
  }
  if (current.length > 0) issues.push(current.join('\n').trimEnd());
  const filtered = issues.filter((issue) => !/^[-*+]\s+none\.?\s*$/i.test(issue.trim()));
  if (filtered.length === 0 && body.trim()) {
    return [`- ${body.trim().replace(/\n/g, '\n  ')}`];
  }
  return filtered;
}

function mergeChunkedAgyReviews(chunkReviews, { truncated = false, promptBytes = null, maxBytes = null } = {}) {
  const texts = chunkReviews.map((chunk) => sanitizeReviewPayloadBestEffort(chunk.reviewText)).filter(Boolean);
  const parts = [
    '## Summary',
    `Reviewed an oversized diff through ${chunkReviews.length} bounded Antigravity chunks because the full agy prompt exceeded the argv budget${promptBytes ? ` (${promptBytes} bytes > ${maxBytes} bytes)` : ''}.`,
  ];
  if (truncated) {
    parts.push('', '> Operator note: the chunk hard cap was hit; this merged review covers the reviewed chunks only.');
  }
  parts.push('', '## Blocking issues');
  const blocking = texts.flatMap((text) => extractMarkdownIssueList(text, 'Blocking issues'));
  parts.push(blocking.length > 0 ? blocking.join('\n') : '- None.');
  const verdict = blocking.length > 0 ? 'Request changes' : 'Comment only';
  parts.push('', '## Non-blocking issues');
  const nonBlocking = texts.flatMap((text) => extractMarkdownIssueList(text, 'Non-blocking issues'));
  parts.push(nonBlocking.length > 0 ? nonBlocking.join('\n') : '- None.');
  parts.push('', '## Suggested fixes');
  const suggestedFixes = texts.flatMap((text) => extractMarkdownIssueList(text, 'Suggested fixes'));
  parts.push(suggestedFixes.length > 0 ? suggestedFixes.join('\n') : '- None.');
  parts.push('', '## Verdict', verdict);
  return parts.join('\n');
}

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
    const claudeResult = await reviewWithClaudeImpl(diff, extraContext, { promptStage });
    // reviewWithClaude now returns { reviewText, tokenUsage } (from --output-format
    // json). Tolerate a bare string too (legacy / mocked impls) so callers and
    // tests that predate the json capture keep working.
    const text = typeof claudeResult === 'string' ? claudeResult : claudeResult?.reviewText;
    const tokenUsage = typeof claudeResult === 'string' ? null : (claudeResult?.tokenUsage ?? null);
    // Best-effort canonicalization: claude/gemini are posted without the hard
    // codex sanitize, but non-`##` canonical headings still break the verdict/
    // blocking-finding parsers the cap + closer depend on. Promote them here
    // (never throws; falls back to the raw body).
    return { rawReviewText: text, reviewText: sanitizeReviewPayloadBestEffort(text), tokenUsage, needsSanitize: false };
  }
  if (effectiveModel === 'gemini') {
    const result = await reviewWithGeminiImpl(diff, extraContext, { promptStage });
    return {
      rawReviewText: result.reviewText,
      reviewText: sanitizeReviewPayloadBestEffort(result.reviewText),
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

async function reviewAgyOversizedInChunks(diff, extraContext, {
  promptStage = 'first',
  promptBytes = null,
  maxBytes = resolveAgyArgvMaxBytes(),
  reviewWithGeminiImpl = reviewWithGemini,
  maxChunks = resolveAgyChunkMaxChunks(),
} = {}) {
  const split = splitDiffForAgyChunks(diff, {
    extraContext,
    chunkContextBudgetSuffix: agyOversizedChunkContextBudgetSuffix(maxChunks),
    promptStage,
    maxBytes,
    maxChunks,
  });
  if (!split.ok) {
    throw new Error(
      `Antigravity agy oversized diff chunking unavailable: ${split.reason}; `
      + `repo prompt size=${promptBytes ?? 'unknown'} maxBytes=${maxBytes} chunks=${split.chunks.length}`
    );
  }
  const chunkReviews = [];
  for (let index = 0; index < split.chunks.length; index += 1) {
    const chunk = split.chunks[index];
    const chunkContext = `${extraContext}${agyOversizedChunkContextSuffix(index + 1, split.chunks.length)}`;
    const result = await reviewWithGeminiImpl(chunk.diff, chunkContext, { promptStage });
    chunkReviews.push({
      index: index + 1,
      promptBytes: chunk.promptBytes,
      reviewText: result.reviewText,
    });
  }
  const mergedReviewText = mergeChunkedAgyReviews(chunkReviews, {
    truncated: split.truncated,
    promptBytes,
    maxBytes,
  });
  return {
    rawReviewText: mergedReviewText,
    reviewText: mergedReviewText,
    tokenUsage: null,
    needsSanitize: false,
    chunked: true,
    chunks: split.chunks,
    truncated: split.truncated,
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
  const sourceEnv = opts.env || process.env;
  // GMW-06 safety net: a gemini reviewer must never silently mis-post under
  // another identity's token, and the legacy GEMINI_REVIEWER_GH_TOKEN item name
  // must never leak into the runtime. Fails closed with a legible error before
  // we read/use any token.
  preflightGeminiReviewerToken({
    env: sourceEnv,
    botTokenEnv,
    reviewerIdentity: opts.reviewerIdentity,
  });
  let token = sourceEnv[botTokenEnv];
  if (!token) {
    throw new Error(`Missing env var: ${botTokenEnv}`);
  }

  const prepareReviewWrite = opts.prepareReviewWrite || clearPendingReviewsForSelf;
  const log = opts.log || console;
  const refreshIdentity = resolveReviewerIdentityForBotTokenEnv(botTokenEnv, opts.reviewerIdentity);
  const appSelfLogin = resolveGitHubAppBotLogin({
    identity: refreshIdentity,
    botTokenEnv,
    env: sourceEnv,
    log,
  });
  const writeIdentity = appSelfLogin || refreshIdentity;
  let refreshedAfterAuthFailure = false;

  const stateDir = resolveAdversarialReviewStateDir(opts.rootDir || ROOT, sourceEnv);
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
          // The reviewer bot tokens are GitHub App tokens — `GET /user` returns
          // 403 ("Resource not accessible by integration"), so pass the known
          // GitHub author login to skip the self-login probe. (PAT path still
          // falls back to /user when no app/provider identity is supplied.)
          selfLogin: appSelfLogin,
          fetchImpl: opts.fetchImpl,
          log: preWriteLog.log,
        });
        try {
          await awaitThrottleIfNeeded();
          const adapterEnv = {
            PATH: sourceEnv.PATH ?? '/usr/bin:/bin',
            HOME: sourceEnv.HOME ?? '',
            GH_TOKEN: token,
            [botTokenEnv]: token,
          };
          for (const key of REVIEW_ADAPTER_ENV_KEYS) {
            if (sourceEnv[key] !== undefined) adapterEnv[key] = sourceEnv[key];
          }
          for (const suffix of ['_SOURCE', '_BROKER_PROVIDER']) {
            const key = `${botTokenEnv}${suffix}`;
            if (sourceEnv[key] !== undefined) adapterEnv[key] = sourceEnv[key];
          }
          let adapterHandled = false;
          try {
            const adapterResult = await writeAdapterPullRequestReview(
              repo,
              prNumber,
              { body: reviewBody, reviewerLogin: writeIdentity },
              { execFileImpl, env: adapterEnv, rootDir: opts.rootDir || ROOT }
            );
            adapterHandled = adapterResult?.ran === true;
          } catch (adapterErr) {
            if (!adapterUnsupportedError(adapterErr)) {
              throw adapterErr;
            }
          }
          if (!adapterHandled) {
            await execFileImpl(
              'gh',
              ['pr', 'review', String(prNumber), '--repo', repo, '--comment', '--body', reviewBody],
              {
                env: adapterEnv,
                maxBuffer: 5 * 1024 * 1024,
              }
            );
          }
        } catch (err) {
          const authRetryable = isReviewerPostAuthFailure(err, {
            preWriteSaw401: preWriteLog.tracker.saw401,
          });
          if (!refreshedAfterAuthFailure && authRetryable) {
            const refreshed = await resolveReviewerAppToken(refreshIdentity, {
              env: sourceEnv,
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
  reviewerHeadSha = null,
  reviewBody,
  botTokenEnv,
  passKind,
  postedAt = null,
  execFileImpl = execFileAsync,
  attestExecFileImpl = execFileImpl,
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
  if (!String(reviewerHeadSha || '').trim()) {
    throw new Error(`Cannot post reviewed attestation for ${repo}#${prNumber}: reviewerHeadSha is required`);
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
  const normalizedVerdict = normalizeEffectiveReviewVerdict(reviewBody, {
    log,
    context: `${repo}#${prNumber} attempt=${attemptNumber} reviewer=${reviewerModel}`,
  });
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

  await emitReviewedAttestation({
    repo,
    prNumber,
    headSha: reviewerHeadSha,
    reviewerIdentity: resolveReviewerIdentityForBotTokenEnv(
      botTokenEnv,
      reviewerIdentity || reviewerModel
    ),
    verdict: normalizedVerdict,
    reviewBody,
    execFileImpl: attestExecFileImpl,
    env: process.env,
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

async function alertClioOversizedAgyFailure({
  repo,
  prNumber,
  promptBytes,
  maxBytes,
  reason,
}, {
  execFileImpl = execFileAsync,
  retryDelaysMs = WAKE_HOOK_RETRY_DELAYS_MS,
  sleepImpl = sleep,
} = {}) {
  const msg = `Adversarial reviewer oversized agy prompt could not be reviewed.\n\nRepo: ${repo} PR #${prNumber}\nPrompt bytes: ${promptBytes ?? 'unknown'}\nAgy argv budget: ${maxBytes ?? 'unknown'}\nReason: ${reason}\n\nThis is the #3074/#3122/#3124 no-review prevention guard; operator action is required because both cross-model routing and chunk fallback were unavailable.`;

  console.error(`[reviewer] ALERT: ${msg}`);

  try {
    await execFileWithTransientRetry(
      'curl',
      [
        '-sS', '-f', '--max-time', '10', '-X', 'POST',
        'http://127.0.0.1:8787/hooks/wake',
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify({ message: msg }),
      ],
      {
        execFileImpl,
        retryDelaysMs,
        sleepImpl,
      }
    );
    console.log('[reviewer] oversized agy prompt alert sent via wake hook');
  } catch (err) {
    console.error('[reviewer] Failed to send oversized agy prompt alert:', err.message);
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
    advisoryFindings = [],
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
  const advisoryContext = formatAdvisoryFindingsContext(advisoryFindings);
  if (advisoryContext) {
    extraContext = `${extraContext}${advisoryContext}`;
  }

  // 2. Run adversarial review (OAuth only — no API key fallback)
  let effectiveModel = reviewerModel;
  let effectiveBotTokenEnv = botTokenEnv;
  let oversizedAgyRoute = null;
  let useAgyChunkFallback = false;
  const geminiRuntimeForBudget = effectiveModel === 'gemini'
    ? resolveGeminiRuntimeForReview(resolveGeminiRuntime, console)
    : null;
  oversizedAgyRoute = resolveAgyOversizedReviewRoute({
    reviewerModel: effectiveModel,
    botTokenEnv: effectiveBotTokenEnv,
    builderTag,
    diff,
    extraContext,
    promptStage: reviewerPromptStage,
    geminiRuntime: geminiRuntimeForBudget,
  });
  if (oversizedAgyRoute.oversized) {
    if (oversizedAgyRoute.route) {
      effectiveModel = oversizedAgyRoute.route.reviewerModel;
      effectiveBotTokenEnv = oversizedAgyRoute.route.botTokenEnv;
      console.warn(
        `[reviewer] reviewer-selection repo=${repo} pr=${prNumber} reason=agy-argv-budget-exceeded ` +
          `size=${oversizedAgyRoute.promptBytes} budget=${oversizedAgyRoute.maxBytes} ` +
          `routed=${effectiveModel} original=gemini refs=#3074,#3122,#3124`
      );
    } else {
      useAgyChunkFallback = true;
      console.warn(
        `[reviewer] reviewer-selection repo=${repo} pr=${prNumber} reason=agy-argv-budget-exceeded ` +
          `size=${oversizedAgyRoute.promptBytes} budget=${oversizedAgyRoute.maxBytes} ` +
          `routed=agy-chunks original=gemini refs=#3074,#3122,#3124`
      );
    }
  }
  logStructuredEvent(console, {
    event: 'hosted-reviewer-selection',
    level: 'info',
    repo,
    prNumber,
    reviewerModel: effectiveModel,
    botTokenEnv: effectiveBotTokenEnv,
    builderTag: builderTag || null,
    label: hasLocalReviewShadowLabel(labels) ? LOCAL_REVIEW_SHADOW_LABEL : null,
    oversizedAgyPromptBytes: oversizedAgyRoute?.oversized ? oversizedAgyRoute.promptBytes : null,
    oversizedAgyBudgetBytes: oversizedAgyRoute?.oversized ? oversizedAgyRoute.maxBytes : null,
  });

  let reviewText;
  let rawReviewText;
  let tokenUsage = null;
  try {
    console.error(`[reviewer] DEBUG: starting ${effectiveModel} review...`);
    // Single selection site (GMW-01): claude / gemini / codex. gemini routes
    // to reviewWithGemini and never falls through to codex.
    let dispatch;
    try {
      dispatch = useAgyChunkFallback
        ? await reviewAgyOversizedInChunks(diff, extraContext, {
            promptStage: reviewerPromptStage,
            promptBytes: oversizedAgyRoute?.promptBytes,
            maxBytes: oversizedAgyRoute?.maxBytes,
          })
        : await dispatchReviewerModel(effectiveModel, diff, extraContext, {
            promptStage: reviewerPromptStage,
          });
    } catch (firstErr) {
      if (!oversizedAgyRoute?.oversized || useAgyChunkFallback) throw firstErr;
      console.warn(
        `[reviewer] oversized agy routed reviewer unavailable for ${repo}#${prNumber}: ` +
          `${firstErr?.message || firstErr}; falling back to bounded agy chunks`
      );
      effectiveModel = 'gemini';
      effectiveBotTokenEnv = 'GH_GEMINI_REVIEWER_TOKEN';
      dispatch = await reviewAgyOversizedInChunks(diff, extraContext, {
        promptStage: reviewerPromptStage,
        promptBytes: oversizedAgyRoute.promptBytes,
        maxBytes: oversizedAgyRoute.maxBytes,
      });
    }
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
    if (oversizedAgyRoute?.oversized) {
      await alertClioOversizedAgyFailure({
        repo,
        prNumber,
        promptBytes: oversizedAgyRoute.promptBytes,
        maxBytes: oversizedAgyRoute.maxBytes,
        reason: err.message || String(err),
      });
    }
    console.error(`[reviewer] AI review failed for ${repo}#${prNumber}:`, err.message);
    console.error(`[reviewer] ERROR STACK: ${err.stack}`);
    process.exit(1);
  }

  if (!tokenUsage && effectiveModel === 'gemini') {
    // Antigravity (agy) reviewers emit no local token usage (server-side
    // conversations, no JSON surface). Persist a heuristic LOWER-BOUND estimate
    // from the prompt (diff + context) and the review body, tagged distinctly so
    // it stays separable from exact counts. Mirrors the worker-pool antigravity
    // estimate-floor (source gemini-antigravity-estimate).
    const estInput = estimateTokensFromText(`${diff}\n${extraContext || ''}`);
    const estOutput = estimateTokensFromText(reviewText);
    if (estInput > 0 || estOutput > 0) {
      tokenUsage = {
        input: estInput,
        output: estOutput,
        reasoning: null,
        cacheRead: null,
        cacheWrite: 0,
        toolContext: null,
        total: estInput + estOutput,
        source: 'gemini-antigravity-estimate',
      };
    }
  }

  if (tokenUsage) {
    const hasExplicitGuardrail = Object.prototype.hasOwnProperty.call(tokenUsage, 'guardrail')
      && tokenUsage.guardrail !== undefined;
    console.log(JSON.stringify({
      type: 'reviewer.token_usage',
      tokenUsage: {
        ...tokenUsage,
        usageTag: tokenUsage.usageTag || 'guardrail',
        guardrail: hasExplicitGuardrail
          ? tokenUsage.guardrail
          : (tokenUsage.total ?? ((tokenUsage.input || 0) + (tokenUsage.output || 0))),
      },
    }));
  }
  console.log(`[reviewer] Review generated (${reviewText.length} chars)`);

  // 3. Post to GitHub
  const reviewerMetadata = resolveReviewerMetadata(effectiveModel);
  const verdictModeResolution = await fetchCurrentHeadVerdictMode({
    repo,
    prNumber,
    reviewerHeadSha,
  });
  const verdictMode = verdictModeResolution.verdictMode;
  console.log(
    `[reviewer] Verdict mode for ${repo}#${prNumber}@${reviewerHeadSha || '<unknown-head>'}: ${verdictMode}` +
      (verdictModeResolution.currentHeadSha ? ` (current head ${verdictModeResolution.currentHeadSha})` : '')
  );
  const waiverAuditBlock = crossModelReviewWaived
    ? `> Cross-model review waiver: ${String(crossModelReviewWaiverReason || 'operator override selected the same reviewer family as the builder for this pass.')}\n\n`
    : '';
  let scopeViolationFinding = null;
  try {
    const scopeReview = await resolveAdditiveOnlyScopeReview({
      repo,
      prNumber,
      logger: console,
    });
    scopeViolationFinding = scopeReview.finding || null;
    if (scopeViolationFinding) {
      console.error(
        `[reviewer] additive-only scope violation detected for ${repo}#${prNumber}: ` +
          `${scopeViolationFinding.violating_files.join(', ')}`
      );
    }
  } catch (err) {
    console.error(
      `[reviewer] WARN: additive-only scope check failed for ${repo}#${prNumber}; continuing normal review: ${err?.message || err}`
    );
  }
  const reviewTextForPost = scopeViolationFinding
    ? appendScopeViolationFinding(reviewText, scopeViolationFinding)
    : reviewText;
  const fullComment = buildReviewCommentBody({
    reviewerMetadata,
    verdictMode,
    waiverAuditBlock,
    reviewText: reviewTextForPost,
  });
  const localShadowEligibility = evaluateLocalReviewShadowEligibility({
    labels,
    builderTag,
    reviewerModel: effectiveModel,
  });
  const localShadowRequest = localShadowEligibility.eligible
    ? persistLocalReviewShadowRequestFailOpen({
        log: console,
        rootDir: ROOT,
        repo,
        prNumber,
        headSha: reviewerHeadSha || null,
        builderTag,
        reviewerModel: effectiveModel,
        hostedReviewerIdentity: resolveReviewerIdentityForBotTokenEnv(
          effectiveBotTokenEnv,
          reviewerMetadata.reviewerIdentity
        ),
        eligibility: localShadowEligibility,
      })
    : { persisted: false, reason: localShadowEligibility.reason };
  logStructuredEvent(console, {
    event: 'local-review-shadow',
    level: localShadowEligibility.eligible ? 'info' : (hasLocalReviewShadowLabel(labels) ? 'warning' : 'info'),
    repo,
    prNumber,
    phase: 'request',
    eligible: localShadowEligibility.eligible,
    reason: localShadowEligibility.reason || null,
    requestPath: localShadowRequest.requestPath || null,
    localModel: localShadowEligibility.localModel || null,
    localFamily: localShadowEligibility.localFamily || null,
    builderTag: builderTag || null,
    reviewerModel: effectiveModel,
  });

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
      reviewerHeadSha: reviewerHeadSha || null,
      reviewBody: fullComment,
      botTokenEnv: effectiveBotTokenEnv,
      passKind,
      reviewerSpawnToken,
      reviewerIdentity: resolveReviewerIdentityForBotTokenEnv(
        effectiveBotTokenEnv,
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
  let postedLocalShadowRequest = null;
  if (localShadowRequest.persisted) {
    try {
      const marked = markLocalReviewShadowHostedPosted({
        rootDir: ROOT,
        request: localShadowRequest.request,
        hostedPostedAt: reviewPostedAt,
      });
      postedLocalShadowRequest = marked.request;
      logStructuredEvent(console, {
        event: 'local-review-shadow',
        level: 'info',
        repo,
        prNumber,
        phase: 'hosted-posted',
        requestPath: marked.requestPath,
      });
    } catch (err) {
      console.error(`[reviewer] WARN: failed to mark local shadow hosted-posted for ${repo}#${prNumber}: ${err.message}`);
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
      reviewText: fullComment,
      reviewPostedAt,
      critical,
      verdictMode,
      scopeViolationFinding,
    });
    if (queued.queued) {
      console.log(`[reviewer] Follow-up handoff queued at ${queued.jobPath}`);
    } else {
      console.error(`[reviewer] Follow-up handoff skipped for ${repo}#${prNumber}: ${queued.reason}`);
    }
  } catch (err) {
    console.error(`[reviewer] Failed to queue follow-up handoff for ${repo}#${prNumber}:`, err.message);
  }

  if (postedLocalShadowRequest) {
    startLocalReviewShadowCompletion({
      rootDir: ROOT,
      request: postedLocalShadowRequest,
      diff,
      hostedReviewText: fullComment,
      extraContext,
      fetchImpl: globalThis.fetch,
      env: process.env,
      log: console,
    });
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
  ADVISORY_ONLY_REVIEW_LABEL,
  VERDICT_MODE_ADVISORY_ONLY,
  VERDICT_MODE_ENFORCE,
  buildReviewCommentHeader,
  classifyReviewCommentHeader,
  startsWithReviewCommentHeader,
  buildReviewCommentBody,
  fetchCurrentHeadVerdictMode,
  normalizeVerdictMode,
  resolveVerdictModeForHead,
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
  parseClaudeJsonOutput,
  buildCodexReviewArgs,
  estimateTokensFromText,
  parseCodexJsonTokenUsage,
  postGitHubReview,
  spawnCodexReview,
  resolveGeminiCliPath,
  resolveAgyCliPath,
  resolveGeminiOAuthCredsPath,
  assertGeminiOAuth,
  assertAgyReviewerAuth,
  checkAgyReviewerAuth,
  resolveAgyAuthProbeTimeoutMs,
  AGY_KEYCHAIN_ACCOUNT,
  AGY_KEYCHAIN_SERVICE,
  AGY_KEYCHAIN_REMEDIATION,
  resolveGeminiRuntime,
  resolveGeminiAntigravityModel,
  resolveGeminiReviewerModel,
  resolveGeminiReviewerSessionParent,
  purgeStaleGeminiReviewerSessionDirs,
  resetGeminiReviewerSessionPreflightForTest,
  createGeminiReviewerSessionDir,
  checkoutGeminiCredentialFromBroker,
  geminiSpendReportsForUsage,
  reportGeminiCredentialSpend,
  releaseGeminiCredentialCheckout,
  materializeGeminiCheckoutSession,
  acquireGeminiFallbackLock,
  looksLikeGeminiQuotaError,
  GeminiCredentialPoolUnavailableError,
  GeminiCredentialPoolNoCreditError,
  resolveReviewerMetadata,
  buildGeminiReviewArgs,
  buildAgyReviewArgs,
  DEFAULT_AGY_ARGV_MAX_BYTES,
  resolveAgyArgvMaxBytes,
  agyPromptBytes,
  assertAgyPromptFitsArgv,
  AGY_ARGV_MAX_BYTES,
  resolveAgyPrintTimeoutMs,
  resolveAgyReviewerSubprocessTimeoutMs,
  formatAgyPrintTimeout,
  hasAgyErrorSentinel,
  sanitizeAgyReviewOutput,
  buildAgyReviewerPromptPrefix,
  buildReviewerPrompt,
  buildPromptForReviewerModel,
  chooseAgyOversizedCrossModelRoute,
  resolveAgyOversizedReviewRoute,
  splitDiffForAgyChunks,
  extractMarkdownIssueList,
  mergeChunkedAgyReviews,
  reviewAgyOversizedInChunks,
  resolveAgyChunkMaxChunks,
  isRetryableGeminiSubprocessError,
  isRetryableCurlWakeError,
  execFileWithTransientRetry,
  alertClioOversizedAgyFailure,
  resolveGeminiRuntimeForReview,
  spawnGeminiReview,
  spawnAgyReview,
  reviewWithGemini,
  dispatchReviewerModel,
  formatAdvisoryFindingsContext,
  postGitHubReviewWithCapture,
  isRetryableGhTransportError,
  isReviewerPostAuthFailure,
  resolveReviewerIdentityForBotTokenEnv,
  LOCAL_REVIEW_SHADOW_LABEL,
  LOCAL_REVIEW_SHADOW_MODEL_FAMILY_BY_MODEL,
  hasLocalReviewShadowLabel,
  evaluateLocalReviewShadowEligibility,
  persistLocalReviewShadowRequest,
  persistLocalReviewShadowRequestFailOpen,
  markLocalReviewShadowHostedPosted,
  completeLocalReviewShadowRequest,
  startLocalReviewShadowCompletion,
  reconcileLocalReviewShadow,
  formatLocalReviewShadowArtifact,
  localReviewShadowPaths,
  readJsonFileIfExists,
  ensureLocalReviewShadowWritable,
};

export {
  CLAUDE_CLI,
  CODEX_CLI,
  GEMINI_CLI,
  AGY_CLI,
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
