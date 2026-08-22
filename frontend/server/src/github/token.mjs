/**
 * The GitHub token source (ARF-02 hard boundary).
 *
 * ARF authenticates with a **configured** token source and nothing else:
 *
 *   - an environment variable this config *names* (`githubTokenEnv`, default
 *     `ARF_GITHUB_TOKEN`), or
 *   - a file this config *points at* (`githubTokenFile`) — the shape a secret
 *     manager materializes a secret into.
 *
 * There is no third option. Specifically there is **no ambient fallback**: not
 * `gh auth token`, not `~/.config/gh/hosts.yml`, not the keychain, not
 * `clio-airlock`, and not a bare `GITHUB_TOKEN`/`GH_TOKEN` that happens to be in
 * the environment. An operator who wants ARF to use `GITHUB_TOKEN` sets
 * `githubTokenEnv=GITHUB_TOKEN`, which is a decision with a record rather than
 * an accident of whatever shell started the process.
 *
 * That is the direct mitigation for SPEC §6's "no-token-mapping → ambient
 * identity fallback masks failure" (RCA 2026-07-23): every ambient fallback is a
 * path where a broken identity config produces plausible-looking output under
 * the wrong identity, and nobody finds out until something is attributed wrong.
 *
 * No token value is ever returned to a describe/status caller, logged, or stored
 * in the resolved config. Only the *source* — an env var name or a file path —
 * travels outside this module.
 */

import { readFile } from 'node:fs/promises';

import { ArfGithubAuthError } from './errors.mjs';

/**
 * Prefixes of unresolved secret references. Passing one of these through as a
 * bearer token yields a bare 401 that reads as "bad credentials" — the operator
 * then goes looking at GitHub App permissions instead of at the `op://` URI they
 * forgot to resolve. Naming it here turns a 20-minute misdiagnosis into a
 * sentence.
 */
const SECRET_REFERENCE_PREFIXES = ['op://', 'vault:', 'secret://', 'aws-secrets://', 'gcp-secret://', 'azure-kv://'];

/**
 * Where the token would be read from, without reading it.
 *
 * @param {{github: {tokenEnv: string, tokenFile: string|null}}} config
 * @returns {{kind: 'file'|'env', ref: string}}
 */
export function tokenSource(config) {
  const github = config?.github ?? {};
  if (github.tokenFile) return { kind: 'file', ref: String(github.tokenFile) };
  return { kind: 'env', ref: String(github.tokenEnv) };
}

function sourceLabel(source) {
  return source.kind === 'file'
    ? `the token file ${source.ref}`
    : `the environment variable ${source.ref}`;
}

/** The one sentence that tells an operator how to fix a missing token. */
function howToFix(source) {
  return source.kind === 'file'
    ? `set githubTokenFile / ARF_GITHUB_TOKEN_FILE to a readable file whose contents are the token (currently ${source.ref})`
    : `export ${source.ref} with a GitHub token, or point githubTokenEnv / ARF_GITHUB_TOKEN_ENV at the variable that holds one`;
}

function validate(raw, source) {
  const value = String(raw ?? '').trim();
  if (!value) {
    throw new ArfGithubAuthError(
      `GitHub token from ${sourceLabel(source)} is empty. ARF has no ambient-identity `
      + `fallback by design, so this is fatal rather than degraded: ${howToFix(source)}.`,
    );
  }
  const reference = SECRET_REFERENCE_PREFIXES.find((prefix) => value.startsWith(prefix));
  if (reference) {
    throw new ArfGithubAuthError(
      `GitHub token from ${sourceLabel(source)} is an unresolved secret reference `
      + `(starts with "${reference}"), not a token. Resolve the reference before ARF `
      + 'reads it — ARF never handles a secret manager itself (SPEC §7).',
    );
  }
  if (/\s/.test(value)) {
    // A pasted `Bearer ghp_…`, a wrapped line, or a whole `.env` line. All of
    // them 401, and the 401 says nothing about which one it was.
    throw new ArfGithubAuthError(
      `GitHub token from ${sourceLabel(source)} contains whitespace, so it is not a bare `
      + 'token (a copied "Bearer <token>" or a multi-line paste does this). Store the '
      + 'token value alone.',
    );
  }
  return value;
}

/**
 * Read the configured GitHub token, or throw an `ArfGithubAuthError` that names
 * the source and the fix.
 *
 * Called on **every** request rather than memoized at construction: a token
 * rotated in place then takes effect without a restart, and a token revoked or
 * deleted fails loud on the next read instead of on the next boot.
 *
 * **Async, and deliberately so.** Per-request reads plus `readFileSync` would put
 * a synchronous disk read on the critical path of every outbound GitHub call. A
 * dashboard batch refresh issues `maxConcurrentRefreshes` requests at a time
 * across a page of PRs — each one paying `3 * maxPages + 2` requests — so a
 * single sweep is easily hundreds of blocking reads. Every one of them stalls the
 * whole event loop: `/healthz` cannot be answered, no other socket is accepted,
 * and a liveness probe can fail while ARF is doing nothing but reading a token it
 * already read a millisecond ago. Re-reading per request is the property worth
 * keeping; doing it synchronously was not.
 *
 * @param {object} config resolved ARF config
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {Promise<string>}
 */
export async function readGithubToken(config, { env = process.env } = {}) {
  const source = tokenSource(config);
  if (source.kind === 'file') {
    let raw;
    try {
      raw = await readFile(source.ref, 'utf8');
    } catch (err) {
      throw new ArfGithubAuthError(
        `GitHub token file ${source.ref} could not be read (${err.code ?? err.message}). `
        + 'ARF will not fall back to an ambient identity: fix the path or the file '
        + 'permissions.',
        { cause: err },
      );
    }
    return validate(raw, source);
  }
  const raw = env[source.ref];
  if (raw === undefined) {
    throw new ArfGithubAuthError(
      `GitHub token is not configured: ${sourceLabel(source)} is unset. ARF has no `
      + `ambient gh/keychain fallback by design — ${howToFix(source)}.`,
    );
  }
  return validate(raw, source);
}

/**
 * The token source as a status payload: never the token, only where it comes
 * from and whether it resolves.
 *
 * `reason` carries the same actionable sentence the read path would have thrown,
 * so `/github/status` answers "why is the dashboard empty?" without anyone
 * having to trigger a failing fetch to find out.
 *
 * @returns {Promise<{kind: string, ref: string, present: boolean, reason: string|null}>}
 */
export async function describeTokenSource(config, { env = process.env } = {}) {
  const source = tokenSource(config);
  try {
    await readGithubToken(config, { env });
    return { kind: source.kind, ref: source.ref, present: true, reason: null };
  } catch (err) {
    return { kind: source.kind, ref: source.ref, present: false, reason: err.message };
  }
}
