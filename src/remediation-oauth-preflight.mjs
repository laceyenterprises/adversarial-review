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
// EXCEPTION: the claude-code BROKER transport caches success only. Its
// probe is a cheap loopback HTTP GET (no TCC prompt, no subprocess) and
// its failures include transient ones (broker restarting), so caching
// them would convert a momentary bounce into a permanent daemon-lifetime
// outage. See the note in `assertClaudeCodeOAuth`.
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

// ── Broker-OAuth transport (the credential source the WORKER actually uses) ──
//
// The fleet claude-code worker does NOT read the macOS login keychain. Its
// adapter (`modules/worker-pool/lib/adapters/claude-code.sh`) runs in
// `CLAUDE_AUTH_MODE="broker-oauth"`: it fetches an `ANTHROPIC_AUTH_TOKEN` from
// the loopback OAuth broker (`GET {broker}/token?provider=claude-code`, primary
// :4099 with :4097 standby) and requires the class authPath to be `oauth` or
// `broker://oauth-broker/claude-code`. The local remediation spawn path mirrors
// this: `prepareClaudeCodeRemediationStartupEnv` preserves the broker-vended
// `ANTHROPIC_AUTH_TOKEN` and never touches the keychain.
//
// So probing `claude auth status --json` (a keychain check) is the WRONG
// credential source for the claude-code worker class. In a system/launchd
// daemon with no login keychain that probe fails with "Command failed" even
// though the broker would vend a perfectly good token — which is exactly what
// stranded remediation and made the AMA closer escalate to the hammer too
// early. The broker-mode preflight below asserts the SAME source the worker
// will use: the broker's public `/readyz` reporting the claude-code provider
// serviceable.
//
// Transport is config-driven via ADVERSARIAL_REVIEW_CLAUDE_CODE_OAUTH_TRANSPORT
// ('broker' | 'keychain'). With no explicit override it AUTO-DETECTS: 'broker'
// when this host is wired to an OS OAuth broker (a broker shared secret is
// configured), else 'keychain' so a STANDALONE install -- a dev/local host that
// ran `claude auth login` and runs no broker -- keeps working with its
// keychain-stored claude-code OAuth. Set 'keychain' explicitly to force the
// direct-CLI path, or 'broker' to force the fleet posture before the secret is
// provisioned.
const CLAUDE_CODE_BROKER_PROVIDER = 'claude-code';
const DEFAULT_OAUTH_BROKER_URL = 'http://127.0.0.1:4099';
const DEFAULT_OAUTH_BROKER_STANDBY_URL = 'http://127.0.0.1:4097';
const BROKER_READYZ_TIMEOUT_MS = 2_500;

// True when this host is wired to an OS OAuth broker -- i.e. a broker shared
// secret is configured (inline or via file). This is the STATIC 'is a broker
// available here' signal used to pick the default transport; it does not read
// or validate the secret (that happens at mint time).
function brokerSharedSecretConfigured(env = process.env) {
  return Boolean(
    (env.OAUTH_BROKER_SHARED_SECRET && String(env.OAUTH_BROKER_SHARED_SECRET).trim()) ||
      (env.OAUTH_BROKER_SHARED_SECRET_FILE && String(env.OAUTH_BROKER_SHARED_SECRET_FILE).trim())
  );
}

function resolveClaudeCodeOAuthTransport(env = process.env) {
  const raw = String(env.ADVERSARIAL_REVIEW_CLAUDE_CODE_OAUTH_TRANSPORT || '').trim().toLowerCase();
  if (raw === 'keychain') return 'keychain';
  if (raw === 'broker') return 'broker';
  // Auto: prefer broker injection when an OS OAuth broker is configured for
  // this host; otherwise fall back to keychain so a standalone install keeps
  // working with no broker (vanilla `claude auth login`).
  return brokerSharedSecretConfigured(env) ? 'broker' : 'keychain';
}

function resolveBrokerReadyzUrls(env = process.env) {
  const primary = String(env.OAUTH_BROKER_URL || DEFAULT_OAUTH_BROKER_URL).replace(/\/+$/, '');
  const standby = String(env.OAUTH_BROKER_STANDBY_URL || DEFAULT_OAUTH_BROKER_STANDBY_URL).replace(/\/+$/, '');
  const urls = [primary];
  if (standby && standby !== primary) urls.push(standby);
  return urls;
}

// `/readyz` reports per-provider readiness. A provider that is `can_serve` (even
// while `degraded`) can still vend a usable token — that is the SOFT signal the
// fleet treats as healthy — so `can_serve` is the authoritative "the worker can
// get a token" gate. A rejected/dead grant reads `can_serve: false`, and an
// absent provider is not serviceable at all. Fall back to the boolean readiness
// verdict in `providers` when the richer `provider_states` map is unavailable.
function claudeCodeServiceableFromReadyz(body) {
  if (!body || typeof body !== 'object') return false;
  const state = body.provider_states?.[CLAUDE_CODE_BROKER_PROVIDER];
  if (state && typeof state === 'object' && typeof state.can_serve === 'boolean') {
    return state.can_serve === true;
  }
  return body.providers?.[CLAUDE_CODE_BROKER_PROVIDER] === true;
}

async function probeBrokerReadyzForClaudeCode(url, { fetchImpl, timeoutMs = BROKER_READYZ_TIMEOUT_MS }) {
  // Bound the whole exchange (headers AND body read) so a wedged broker can
  // never hang the remediation drain. `/readyz` is a PUBLIC endpoint (no shared
  // secret), so this needs no credential injection. It returns HTTP 200 when
  // the aggregate is ready and 503 when ANY blocking provider is down — but
  // claude-code can be serviceable while some OTHER provider forces the 503, so
  // parse the body regardless of status rather than gating on `res.ok`.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url}/readyz`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    let body;
    try {
      body = await res.json();
    } catch (err) {
      return { ok: false, reason: `${url}/readyz body not JSON (http ${res.status}): ${err.message}` };
    }
    if (claudeCodeServiceableFromReadyz(body)) {
      return { ok: true };
    }
    const state = body?.provider_states?.[CLAUDE_CODE_BROKER_PROVIDER];
    const known = body?.providers && CLAUDE_CODE_BROKER_PROVIDER in body.providers;
    const detail = state?.kind || (known ? 'not-ready' : 'provider-absent');
    return { ok: false, reason: `${url}/readyz reports claude-code not serviceable (${detail})` };
  } catch (err) {
    return { ok: false, reason: `${url}/readyz unreachable: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function assertClaudeCodeBrokerOAuth({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = BROKER_READYZ_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new OAuthError('claude-code', 'no fetch implementation available to probe the OAuth broker');
  }
  const urls = resolveBrokerReadyzUrls(env);
  const failures = [];
  for (const url of urls) {
    // Mirror the worker's own primary->standby fetch order; either endpoint
    // vending claude-code is enough.
    const result = await probeBrokerReadyzForClaudeCode(url, { fetchImpl, timeoutMs });
    if (result.ok) {
      return { transport: 'broker', brokerUrl: url, provider: CLAUDE_CODE_BROKER_PROVIDER };
    }
    failures.push(result.reason);
  }
  // Fail closed: neither the primary nor the standby broker can serve
  // claude-code, so the worker would fail its own token fetch too.
  throw new OAuthError(
    'claude-code',
    `broker OAuth unavailable for claude-code (${failures.join('; ')})`
  );
}

// The `/readyz` probe above proves the broker CAN vend a claude-code token; a
// BARE remediation spawn additionally needs the token ITSELF. os-mode (hq
// dispatch) workers get it from the fleet adapter (`adapter-broker-token.sh`),
// but the local spawn path only PRESERVES an already-present
// `ANTHROPIC_AUTH_TOKEN` (see `prepareClaudeCodeRemediationStartupEnv`) -- it
// mints nothing. Without a mint a bare claude-code remediation authenticates
// against neither the keychain (a launchd daemon has none) nor the broker, and
// the CLI dies "Not logged in" (#5546). This helper performs the SAME
// authenticated fetch the fleet adapter does -- `GET {broker}/token?provider=
// claude-code` (primary :4099 -> :4097 standby), `Authorization: Bearer
// <OAUTH_BROKER_SHARED_SECRET[_FILE]>` -- and returns the vended token for the
// caller to inject as `ANTHROPIC_AUTH_TOKEN`. That is bearer OAuth (a
// broker-vended access token), NOT the forbidden api-key/bedrock/vertex
// fallback the startup contract scrubs. Remediators do not need remote control,
// so API-mode injection is acceptable here.
const BROKER_TOKEN_TIMEOUT_MS = 8_000;

function resolveBrokerSharedSecret(env = process.env) {
  const inline = env.OAUTH_BROKER_SHARED_SECRET;
  if (inline && String(inline).trim()) return String(inline).trim();
  const file = env.OAUTH_BROKER_SHARED_SECRET_FILE;
  if (file && String(file).trim()) {
    // readFileSync throws on an unreadable/missing file; the caller converts
    // that into an OAuthError so the already-claimed job fails closed.
    return String(readFileSync(String(file).trim(), 'utf8')).replace(/[\r\n]+$/g, '').trim();
  }
  return '';
}

function usableBrokerAccessToken(body) {
  if (!body || typeof body !== 'object') return null;
  const token = body.access_token;
  if (typeof token !== 'string' || token.length === 0 || token === 'null') return null;
  // Provider guard: the broker echoes the provider it minted for. Accept an
  // absent provider (older broker builds) or an exact claude-code match.
  if (body.provider != null && body.provider !== CLAUDE_CODE_BROKER_PROVIDER) return null;
  return token;
}

// Mint a claude-code bearer token from the loopback OAuth broker for a bare
// remediation spawn. Returns `{ injected: false, reason }` when the transport is
// keychain or a token is already present (leave the env untouched); returns
// `{ injected: true, token, brokerUrl, expiresAt }` on success; throws an
// `OAuthError` on a hard fault (no secret, or neither broker endpoint vends a
// usable token) so the already-claimed job fails closed instead of spawning an
// unauthenticated worker. The returned object carries the secret token -- callers
// MUST NOT log it; log only `brokerUrl`/`expiresAt`.
async function mintClaudeCodeRemediationBrokerToken({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = BROKER_TOKEN_TIMEOUT_MS,
} = {}) {
  // Only the broker transport mints. A keychain-configured host authenticates
  // the direct CLI itself, so leave its env untouched.
  if (resolveClaudeCodeOAuthTransport(env) !== 'broker') {
    return { injected: false, reason: 'transport-not-broker' };
  }
  // Respect an already-present token (an os-mode seed or an operator override):
  // never clobber a credential the caller deliberately supplied.
  if (env.ANTHROPIC_AUTH_TOKEN && String(env.ANTHROPIC_AUTH_TOKEN).trim()) {
    return { injected: false, reason: 'token-already-present' };
  }
  if (typeof fetchImpl !== 'function') {
    throw new OAuthError('claude-code', 'no fetch implementation available to mint the OAuth broker token');
  }
  let secret;
  try {
    secret = resolveBrokerSharedSecret(env);
  } catch (err) {
    // A configured-but-unreadable secret file (readFileSync ENOENT/EACCES):
    // convert the raw fs error into an OAuthError so the already-claimed job
    // fails closed with the correct auth classification instead of an
    // unclassified error bubbling to the consumer.
    throw new OAuthError(
      'claude-code',
      `broker shared secret file unreadable: ${err?.message || err}`
    );
  }
  if (!secret) {
    throw new OAuthError(
      'claude-code',
      'OAUTH_BROKER_SHARED_SECRET(_FILE) is not configured; cannot mint a broker claude-code token'
    );
  }
  const model = String(env.CLAUDE_MODEL_ID || env.CLAUDE_CODE_MODEL_ID || '').trim();
  const failures = [];
  for (const base of resolveBrokerReadyzUrls(env)) {
    let url = `${base}/token?provider=${CLAUDE_CODE_BROKER_PROVIDER}`;
    if (model) url += `&model=${encodeURIComponent(model)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${secret}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        failures.push(`${base}/token http ${res.status}`);
        continue;
      }
      let body;
      try {
        body = await res.json();
      } catch (err) {
        failures.push(`${base}/token body not JSON: ${err.message}`);
        continue;
      }
      const token = usableBrokerAccessToken(body);
      if (!token) {
        failures.push(`${base}/token returned no usable claude-code access_token`);
        continue;
      }
      return {
        injected: true,
        token,
        brokerUrl: base,
        provider: CLAUDE_CODE_BROKER_PROVIDER,
        expiresAt: body.expires_at || null,
      };
    } catch (err) {
      failures.push(`${base}/token unreachable: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  // Fail closed: the /readyz preflight already asserted serviceability, so a
  // mint failure here is a real fault. Throwing moves the already-claimed job to
  // failed/ rather than spawning a doomed, unauthenticated worker.
  throw new OAuthError(
    'claude-code',
    `broker claude-code token mint failed (${failures.join('; ')})`
  );
}

async function assertClaudeCodeOAuth({
  execFileImpl = execFileAsync,
  fetchImpl = globalThis.fetch,
  env = process.env,
  transport,
} = {}) {
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

  const resolvedTransport = transport || resolveClaudeCodeOAuthTransport(env);
  if (resolvedTransport === 'broker') {
    // NOTE: the broker path caches SUCCESS only, never the failure. The
    // keychain/codex/gemini paths cache their OAuthError because re-probing
    // costs a subprocess spawn and a macOS TCC prompt, so a permanently
    // sticky error is the cheaper trade. The broker probe is just an HTTP GET
    // to a loopback `/readyz`: no TCC prompt, no subprocess, bounded by an
    // AbortController. And `assertClaudeCodeBrokerOAuth` throws an OAuthError
    // for TRANSIENT conditions too — ECONNREFUSED / timeout while the local
    // broker restarts. Caching that in the process-global cache would turn a
    // few-second broker bounce into a permanent remediation outage: every
    // later consume tick would re-throw the cached error without re-probing,
    // and the daemon could never spawn a claude-code worker again until it
    // was manually bounced. So let the next tick re-probe.
    await assertClaudeCodeBrokerOAuth({ env, fetchImpl });
    __oauthPreflightCache['claude-code'] = true;
    // Returns undefined, matching the cache-hit path above and the
    // codex/gemini pre-flights: the contract is "throws or resolves", never a
    // payload whose presence depends on cache state.
    return;
  }

  // transport === 'keychain': legacy direct-CLI login-state probe. Only correct
  // for a dev/local host that runs `claude` against a login-keychain session and
  // no broker. Unchanged from the pre-broker behavior below.
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
  // No payload here either: on the very next call this same probe short-circuits
  // at the `cached === true` branch and resolves with undefined, so any caller
  // reading `result.authMethod` would `TypeError` on its second invocation.
  // "Throws or resolves" is the whole contract, for both transports.
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

async function assertRemediationWorkerOAuth(workerClass, { execFileImpl, fetchImpl, env } = {}) {
  switch (workerClass) {
    case 'codex':       return assertCodexOAuth();
    case 'claude-code': return assertClaudeCodeOAuth({ execFileImpl, fetchImpl, env });
    case 'gemini':      return assertGeminiOAuth();
    default:
      throw new Error(`unknown remediation worker class: ${workerClass}`);
  }
}

export {
  OAuthError,
  resetOAuthPreflightCache,
  resolveClaudeCodeOAuthTransport,
  mintClaudeCodeRemediationBrokerToken,
  assertCodexOAuth,
  assertClaudeCodeOAuth,
  assertClaudeCodeBrokerOAuth,
  assertGeminiOAuth,
  assertRemediationWorkerOAuth,
};
