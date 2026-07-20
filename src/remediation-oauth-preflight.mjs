// Per-worker-class OAuth pre-flight assertions for remediation workers.
//
// Extracted VERBATIM from follow-up-remediation.mjs (ARC-19 wave10). This leaf
// owns the fail-fast auth pre-flight that runs before a remediation worker is
// spawned: the codex `auth.json` parse, the claude-code `claude auth status
// --json` probe, the gemini `oauth_creds.json` parse, and the per-process
// pre-flight cache all three share. `assertRemediationWorkerOAuth` is the
// dispatch entry point the reconcile/dispatch orchestration calls.
//
// The small CLI/auth-path resolvers below (`resolveCodexCliPath`,
// `resolveCodexAuthPath`, `resolveGeminiCliPath`, `resolveGeminiAuthPath`) are
// behavior-preserving PRIVATE copies of the resolvers still defined in
// follow-up-remediation.mjs. The codex/gemini worker-spawn + startup-env path
// there is a live SEV0 fix and keeps its own copies verbatim; duplicating these
// pure env-reads here (matching the existing leaves' precedent for trivial
// primitives) keeps that spawn path completely untouched.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveClaudeCodeCliPath } from './remediation-claude-code-worker.mjs';
import { scrubOAuthFallbackEnv } from './secret-source/env.mjs';

const execFileAsync = promisify(execFile);

function resolveCodexCliPath() {
  return process.env.CODEX_CLI_PATH || process.env.CODEX_CLI || 'codex';
}

function resolveCodexAuthPath() {
  if (process.env.CODEX_AUTH_PATH) {
    return process.env.CODEX_AUTH_PATH;
  }

  const codexHome = process.env.CODEX_HOME || join(process.env.HOME || homedir(), '.codex');
  return join(codexHome, 'auth.json');
}

function resolveGeminiCliPath() {
  return process.env.GEMINI_CLI_PATH || process.env.GEMINI_CLI || 'gemini';
}

function resolveGeminiAuthPath() {
  if (process.env.GEMINI_AUTH_PATH) {
    return process.env.GEMINI_AUTH_PATH;
  }
  const geminiHome = process.env.GEMINI_HOME || join(process.env.HOME || homedir(), '.gemini');
  return join(geminiHome, 'oauth_creds.json');
}

class OAuthError extends Error {
  constructor(model, reason) {
    super(`[OAuth] ${model} credentials unavailable: ${reason}`);
    this.model = model;
    this.isOAuthError = true;
  }
}

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
    throw new OAuthError('codex', `Codex auth file missing OAuth tokens: ${authPath}`);
  }

  return authPath;
}

// Per-process pre-flight cache. The OAuth pre-flight reads
// `~/.codex/auth.json` (and runs `claude auth status --json` for the
// claude-code worker class), which on macOS Sequoia / Sonoma triggers
// per-file TCC prompts ("node would like to access data from other
// apps") on every read because the dirs `~/.codex/` and
// `~/.claude/` are tagged as their respective CLIs' data areas.
//
// The pre-flight is fail-fast guard, not load-bearing: if auth is
// broken, the worker we'd otherwise spawn would also fail (codex /
// claude both re-validate auth on startup), and reconcile would
// detect the missing-final-message artifact and mark the job
// failed. So caching the pre-flight result for the daemon's
// lifetime is safe — at worst we waste one worker spawn cycle on
// auth that broke after daemon start, which the next reconcile
// catches.
//
// Cache shape per worker class: null = unchecked (next call runs
// the real check), true = passed (skip the check), an OAuthError
// instance = failed (re-throw without retrying — operators see the
// same structured error every consume call until daemon restart,
// matching the previous fail-fast behavior).
//
// Invalidate via `resetOAuthPreflightCache()` from a test seam OR
// via SIGHUP (operator-driven re-check after rotating credentials).
const __oauthPreflightCache = {
  codex: null,
  'claude-code': null,
  gemini: null,
};

function resetOAuthPreflightCache(workerClass) {
  if (workerClass) {
    __oauthPreflightCache[workerClass] = null;
  } else {
    for (const key of Object.keys(__oauthPreflightCache)) {
      __oauthPreflightCache[key] = null;
    }
  }
}

async function assertCodexOAuth() {
  const cached = __oauthPreflightCache.codex;
  if (cached === true) return;
  if (cached instanceof OAuthError) throw cached;

  const codexCli = resolveCodexCliPath();

  try {
    if (codexCli.includes('/') && !existsSync(codexCli)) {
      throw new OAuthError('codex', `codex CLI not found at ${codexCli}`);
    }
    assertCodexAuthReadable();
    __oauthPreflightCache.codex = true;
  } catch (err) {
    if (err instanceof OAuthError) {
      __oauthPreflightCache.codex = err;
    }
    throw err;
  }
}

// ── Claude Code remediation worker (parallel to Codex) ─────────────────────
// Cross-model rule: the BUILDER fixes their own code. So when the original
// PR was built by Claude Code (tag `[claude-code]`, reviewed by Codex), the
// remediation worker that lands review-feedback fixes also has to be Claude
// Code — not Codex. Without this path, every `[claude-code]` PR gets its
// review findings remediated by the wrong model, breaking the symmetry the
// rest of the pipeline depends on.

// Required values for the OAuth invariant. These match what the
// worker-pool's claude-code adapter ENV_CLEAR enforces by stripping
// ANTHROPIC_API_KEY / CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX —
// "OAuth subscription only, Anthropic direct (no third-party providers)."
const CLAUDE_CODE_REQUIRED_AUTH_METHOD = 'claude.ai';
const CLAUDE_CODE_REQUIRED_API_PROVIDER = 'firstParty';

async function assertClaudeCodeOAuth({ execFileImpl = execFileAsync } = {}) {
  // Per-process cache mirrors the codex pre-flight cache. The
  // `claude auth status --json` subprocess otherwise runs every
  // consume tick, and macOS Sequoia's per-app-data-dir TCC prompts
  // ("node would like to access data from other apps") fire on
  // each spawn because the resulting `claude` binary touches
  // `~/.claude/` files. Caching the pre-flight result keeps the
  // first call honest and silences subsequent ones.
  // See the cache comment block above `assertCodexOAuth` for full
  // rationale.
  const cached = __oauthPreflightCache['claude-code'];
  if (cached === true) return;
  if (cached instanceof OAuthError) throw cached;

  const claudeCli = resolveClaudeCodeCliPath();
  if (claudeCli.includes('/') && !existsSync(claudeCli)) {
    const err = new OAuthError('claude-code', `claude CLI not found at ${claudeCli}`);
    __oauthPreflightCache['claude-code'] = err;
    throw err;
  }

  // Run `claude auth status --json` and validate the response. This is
  // the cheap, structured equivalent of the codex auth-file parse: it
  // catches three real failure modes before we ever spawn a worker —
  //   (1) not logged in
  //   (2) logged in but routed via API key instead of the OAuth path
  //   (3) routed via a 3P provider (Bedrock / Vertex / Foundry)
  // ANY of these would silently change the billing path or fail the
  // worker mid-run, so a 1-second pre-flight is worth it.
  //
  // IMPORTANT: strip Anthropic API credentials from the probe env. With
  // ANTHROPIC_API_KEY set, the CLI may report `authMethod: 'apiKey'` even
  // when the OAuth subscription is also configured, masking the real
  // login state. Mirrors `reviewer.mjs`'s `assertClaudeOAuth` hardening.
  const { env: probeEnv } = scrubOAuthFallbackEnv(process.env);

  let raw;
  try {
    const result = await execFileImpl(claudeCli, ['auth', 'status', '--json'], {
      env: probeEnv,
      maxBuffer: 1 * 1024 * 1024,
      timeout: 15_000,
    });
    raw = result.stdout;
  } catch (err) {
    throw new OAuthError(
      'claude-code',
      `\`claude auth status --json\` failed: ${err.message}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new OAuthError(
      'claude-code',
      `\`claude auth status --json\` did not return valid JSON: ${err.message}`
    );
  }

  if (!parsed?.loggedIn) {
    const err = new OAuthError(
      'claude-code',
      `not logged in to Claude Code (run \`claude auth login\`)`
    );
    __oauthPreflightCache['claude-code'] = err;
    throw err;
  }

  if (parsed.authMethod !== CLAUDE_CODE_REQUIRED_AUTH_METHOD) {
    const err = new OAuthError(
      'claude-code',
      `authMethod is ${JSON.stringify(parsed.authMethod)} but ` +
      `${JSON.stringify(CLAUDE_CODE_REQUIRED_AUTH_METHOD)} (OAuth subscription) is required`
    );
    __oauthPreflightCache['claude-code'] = err;
    throw err;
  }

  if (parsed.apiProvider !== CLAUDE_CODE_REQUIRED_API_PROVIDER) {
    const err = new OAuthError(
      'claude-code',
      `apiProvider is ${JSON.stringify(parsed.apiProvider)} but ` +
      `${JSON.stringify(CLAUDE_CODE_REQUIRED_API_PROVIDER)} (Anthropic direct) is required`
    );
    __oauthPreflightCache['claude-code'] = err;
    throw err;
  }

  __oauthPreflightCache['claude-code'] = true;

  return {
    authMethod: parsed.authMethod,
    apiProvider: parsed.apiProvider,
    cliPath: claudeCli,
  };
}

async function assertGeminiOAuth() {
  // Per-process pre-flight cache, identical contract to assertCodexOAuth:
  // null = unchecked, true = passed, OAuthError = cached failure. Reading
  // `~/.gemini/oauth_creds.json` on each consume tick would otherwise trip
  // macOS TCC prompts the same way the codex/claude auth reads do.
  const cached = __oauthPreflightCache.gemini;
  if (cached === true) return;
  if (cached instanceof OAuthError) throw cached;

  const geminiCli = resolveGeminiCliPath();

  try {
    if (geminiCli.includes('/') && !existsSync(geminiCli)) {
      throw new OAuthError('gemini', `gemini CLI not found at ${geminiCli}`);
    }

    const authPath = resolveGeminiAuthPath();
    if (!existsSync(authPath)) {
      throw new OAuthError('gemini', `OAuth oauth_creds.json missing: ${authPath}`);
    }

    let raw;
    try {
      raw = readFileSync(authPath, 'utf8');
    } catch (err) {
      throw new OAuthError('gemini', `cannot read ${authPath}: ${err.message}`);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new OAuthError('gemini', `invalid oauth_creds.json at ${authPath}: ${err.message}`);
    }

    if (!parsed?.access_token && !parsed?.refresh_token) {
      throw new OAuthError('gemini', `Gemini auth file missing OAuth tokens: ${authPath}`);
    }

    __oauthPreflightCache.gemini = true;
  } catch (err) {
    if (err instanceof OAuthError) {
      __oauthPreflightCache.gemini = err;
    }
    throw err;
  }
}

async function assertRemediationWorkerOAuth(workerClass, { execFileImpl } = {}) {
  switch (workerClass) {
    case 'codex':       return assertCodexOAuth();
    case 'claude-code': return assertClaudeCodeOAuth({ execFileImpl });
    case 'gemini':      return assertGeminiOAuth();
    default:
      throw new Error(`unknown remediation worker class: ${workerClass}`);
  }
}

export {
  OAuthError,
  resetOAuthPreflightCache,
  assertCodexOAuth,
  assertClaudeCodeOAuth,
  assertGeminiOAuth,
  assertRemediationWorkerOAuth,
};
