// Reviewer model-execution harness.
//
// ARC-10: the bespoke per-harness spawn surface (Claude/Codex/Gemini/Antigravity
// CLI invocation, OAuth preflight, credential-broker checkout, token-usage
// capture, oversized-diff chunking, and reviewer-model dispatch) lives here,
// extracted verbatim from the former `reviewer.mjs` monolith. `reviewer.mjs`
// now assembles the review request and emits the artifact, delegating model
// execution to `dispatchReviewerModel` in this module. Prompt assembly is
// imported from `reviewer-prompt.mjs`; model detection and codex token parsing
// from `reviewer-model-detection.mjs`. Per-harness knowledge that must not live
// in this repo at all belongs in the OS worker classes (os-dispatch runtime);
// this module is the OS-independent local-review lifeline that keeps the review
// pipeline alive when the OS dispatch contract is unavailable.

import { execFile } from 'node:child_process';
import {
  chmodSync,
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
import { join } from 'node:path';
import { promisify } from 'node:util';
import { materializePerWorkerCodexAuth } from './codex-per-worker-auth.mjs';
import {
  resolveAgyPrintTimeoutMs,
  resolveAgyReviewerSubprocessTimeoutMs,
  resolveProgressTimeoutMs,
  resolveReviewerTimeoutMs,
} from './reviewer-timeout.mjs';
import { spawnCapturedProcessGroup } from './process-group-spawn.mjs';
import {
  extractReviewVerdict,
  looksLikeRuntimeJunk,
  normalizeReviewVerdict,
  normalizeWhitespace,
  sanitizeReviewPayloadBestEffort,
} from './kernel/verdict.mjs';
import { OAUTH_ENV_STRIP_LIST, scrubOAuthFallbackEnv } from './secret-source/env.mjs';
import {
  AGY_KEYCHAIN_ACCOUNT,
  AGY_KEYCHAIN_REMEDIATION,
  AGY_KEYCHAIN_SERVICE,
  checkAgyReviewerAuth,
  resolveAgyAuthProbeTimeoutMs,
} from './agy-reviewer-auth.mjs';
import { resolveGeminiRuntime, resolveGeminiAntigravityModel } from './role-config.mjs';
import {
  REVIEW_POST_RETRY_DELAYS_MS,
  WAKE_HOOK_RETRY_DELAYS_MS,
  buildGhErrorDetail,
  normalizeBuilderTag,
  parseDiffFiles,
} from './reviewer-util.mjs';
import {
  buildReviewerPromptPrefix,
  buildReviewerPrompt,
  buildPromptForReviewerModel,
  buildAgyReviewerPromptPrefix,
} from './reviewer-prompt.mjs';
import { parseCodexJsonTokenUsage } from './reviewer-model-detection.mjs';

const execFileAsync = promisify(execFile);

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
const CLAUDE_LAUNCHCTL_RETRY_DELAYS_MS = [250, 750];

async function withClaudeLaunchctlRetry(operation, {
  retryDelaysMs = CLAUDE_LAUNCHCTL_RETRY_DELAYS_MS,
  sleepImpl = sleep,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      if (!err?.isLaunchctlSessionError || attempt >= retryDelaysMs.length) throw err;
      await sleepImpl(retryDelaysMs[attempt]);
    }
  }
}

async function assertClaudeOAuth({
  spawnClaudeImpl = spawnClaude,
  retryDelaysMs,
  sleepImpl,
  existsSyncImpl = existsSync,
} = {}) {
  if (spawnClaudeImpl === spawnClaude && !existsSyncImpl(CLAUDE_CLI)) {
    throw new OAuthError('claude', `claude CLI not found at ${CLAUDE_CLI}`);
  }

  const { env } = scrubOAuthFallbackEnv(process.env);

  let stdout = '';
  let stderr = '';
  try {
    ({ stdout, stderr } = await withClaudeLaunchctlRetry(
      () => spawnClaudeImpl(['auth', 'status'], { env, timeout: resolveClaudeAuthProbeTimeoutMs(env) }),
      { retryDelaysMs, sleepImpl },
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
    if (existsSync(homeAuth) || !existsSync('/Users/placey/.codex/auth.json')) return homeAuth;  // cfg-allowlist(account-placey): oss-readiness-apply-reviewed
  }
  return '/Users/placey/.codex/auth.json';  // cfg-allowlist(account-placey): oss-readiness-apply-reviewed
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

// ── AI review via CLI (OAuth only) ──────────────────────────────────────────

/**
 * Run adversarial review using Claude Code CLI (OAuth).
 * ANTHROPIC_API_KEY is explicitly removed from the env so the CLI
 * uses its native OAuth path only. Preflight auth validation is aligned with
 * the broker/Keychain path used by the live stack.
 */
async function reviewWithClaude(diff, extraContext = '', {
  promptStage = 'first', assertClaudeOAuthImpl = assertClaudeOAuth,
  spawnClaudeImpl = spawnClaude, launchctlRetryDelaysMs, sleepImpl,
} = {}) {
  await assertClaudeOAuthImpl();

  const promptPrefix = buildReviewerPromptPrefix({ stage: promptStage });
  const prompt = buildReviewerPrompt({ promptPrefix, extraContext, diff });

  // Strip API key from env — Claude CLI falls back to OAuth when it's absent
  const { env } = scrubOAuthFallbackEnv(process.env);

  let stdout, stderr;
  try {
    ({ stdout, stderr } = await withClaudeLaunchctlRetry(
      () => spawnClaudeImpl(buildClaudeReviewArgs(prompt), {
        env,
        timeout: resolveReviewerTimeoutMs(env),
        maxBuffer: 10 * 1024 * 1024,
      }),
      { retryDelaysMs: launchctlRetryDelaysMs, sleepImpl },
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
  statSyncImpl = statSync,
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
        try {
          if (Date.now() - statSyncImpl(lockDir).mtimeMs >= 5_000) {
            rmSyncImpl(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          // A concurrent owner may have completed or removed the lock.
        }
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
  assertAgyPromptFitsArgv(prompt, { maxBytes: resolveAgyArgvMaxBytes(env) });
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

const __test__ = {
  AGY_ARGV_MAX_BYTES,
  AGY_CLI,
  AGY_KEYCHAIN_ACCOUNT,
  AGY_KEYCHAIN_REMEDIATION,
  AGY_KEYCHAIN_SERVICE,
  CLAUDE_CLI,
  CLAUDE_STRIPPED_ENV_VARS,
  CODEX_CLI,
  CODEX_EXEC_CONFIG_FORWARD_KEYS,
  CROSS_MODEL_PRIMARY_BY_BUILDER_CLASS,
  DEFAULT_AGY_ARGV_MAX_BYTES,
  DEFAULT_AGY_CHUNK_MAX_CHUNKS,
  DEFAULT_CLAUDE_CLI,
  DEFAULT_CQP_BROKER_URL,
  DEFAULT_GEMINI_REVIEWER_MODEL,
  ENV_BIN,
  GEMINI_CLI,
  GEMINI_CQP_CHECKOUT_TIMEOUT_MS,
  GEMINI_CQP_FALLBACK_LOCK_WAIT_MS,
  GEMINI_REVIEWER_SESSION_DIR_PREFIX,
  GEMINI_REVIEWER_SESSION_STALE_AGE_MS,
  GeminiCredentialPoolNoCreditError,
  GeminiCredentialPoolUnavailableError,
  LAUNCHCTL,
  LaunchctlSessionError,
  MAINTAINER_ACPX_CLI,
  OAuthError,
  REVIEWER_METADATA_BY_MODEL,
  REVIEWER_ROUTE_BY_MODEL,
  acquireGeminiFallbackLock,
  agyOversizedChunkContextBudgetSuffix,
  agyOversizedChunkContextSuffix,
  agyPromptBytes,
  assertAgyPromptFitsArgv,
  assertAgyReviewerAuth,
  assertClaudeOAuth,
  assertCodexAuthReadable,
  assertCodexOAuth,
  assertGeminiAuthReadable,
  assertGeminiOAuth,
  buildAgyReviewArgs,
  buildClaudeReviewArgs,
  buildCodexReviewArgs,
  buildGeminiReviewArgs,
  candidateAgyReviewBlocks,
  checkAgyReviewerAuth,
  checkoutGeminiCredentialFromBroker,
  chooseAgyOversizedCrossModelRoute,
  cleanupGeminiAntigravityResources,
  createGeminiReviewerSessionDir,
  currentGeminiReviewerHostname,
  dispatchReviewerModel,
  estimateTokensFromText,
  execFileWithTransientRetry,
  extractClaudeJsonText,
  extractMarkdownIssueList,
  fetchWithTimeout,
  findOnPath,
  formatAgyPrintTimeout,
  formatChildProcessFailureDetails,
  formatCodexConfigOverride,
  geminiSpendReportsForUsage,
  hasAgyErrorSentinel,
  isClaudeLoggedOutStatus,
  isCodexOAuthAuthFile,
  isLaunchctlSessionFailure,
  isProcessAlive,
  isRetryableCurlWakeError,
  isRetryableGeminiSubprocessError,
  isTypedNoCreditResponse,
  joinPatchLines,
  looksLikeGeminiQuotaError,
  mapClaudeJsonUsage,
  markdownSectionBody,
  materializeGeminiCheckoutSession,
  maybeChmodOwnedPath,
  mergeChunkedAgyReviews,
  nextWeeklyQuotaResetIso,
  normalizeAgyReviewBlock,
  normalizeGeminiCheckout,
  normalizeGeminiOauthCredsPayload,
  normalizeGeminiReviewerHostname,
  parseClaudeJsonOutput,
  parseCodexConfigLiteralString,
  previewText,
  purgeStaleGeminiReviewerSessionDirs,
  pushAgyChunk,
  quotaLimitFromEnv,
  readCodexConfigTopLevelValues,
  readCqpBrokerSecret,
  readGeminiReviewerOwner,
  readJsonResponse,
  releaseGeminiCredentialCheckout,
  reportGeminiCredentialSpend,
  resetGeminiReviewerSessionPreflightForTest,
  resolveAcpxCliPath,
  resolveAgyArgvMaxBytes,
  resolveAgyAuthProbeTimeoutMs,
  resolveAgyChunkMaxChunks,
  resolveAgyCliPath,
  resolveAgyOversizedReviewRoute,
  resolveAgyPrintTimeoutMs,
  resolveAgyReviewerSubprocessTimeoutMs,
  resolveClaudeAuthProbeTimeoutMs,
  resolveClaudeCliPath,
  resolveCodexAuthPath,
  resolveCodexCliPath,
  resolveCodexExecOverrides,
  resolveCqpBrokerConfig,
  resolveGeminiAntigravityModel,
  resolveGeminiCliPath,
  resolveGeminiOAuthCredsPath,
  resolveGeminiReviewerModel,
  resolveGeminiReviewerSessionParent,
  resolveGeminiRuntime,
  resolveGeminiRuntimeForReview,
  resolveProgressTimeoutMs,
  resolveReviewerMetadata,
  resolveReviewerTimeoutMs,
  reviewAgyOversizedInChunks,
  reviewWithClaude,
  reviewWithCodex,
  reviewWithGemini,
  sanitizeAgyReviewOutput,
  shouldPurgeGeminiReviewerSessionDir,
  spawnAgyReview,
  spawnCaptured,
  spawnClaude,
  spawnCodexReview,
  spawnGeminiReview,
  spawnWithInput,
  splitDiffForAgyChunks,
  splitOversizedPatchByLines,
  splitPatchHeaderAndBodyLines,
  stringifyGeminiBrokerReason,
  stripCodexRuntimeNoise,
  stripTomlInlineComment,
  withGeminiSubprocessRetry,
};

export {
  dispatchReviewerModel,
  reviewAgyOversizedInChunks,
  reviewWithCodex,
  reviewWithGemini,
  resolveAgyOversizedReviewRoute,
  resolveGeminiRuntimeForReview,
  resolveReviewerMetadata,
  estimateTokensFromText,
  execFileWithTransientRetry,
  previewText,
  CLAUDE_CLI,
  CODEX_CLI,
  GEMINI_CLI,
  AGY_CLI,
  assertClaudeOAuth,
  assertCodexOAuth,
  spawnCaptured,
  __test__,
};
