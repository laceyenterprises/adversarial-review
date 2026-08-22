/**
 * `resolveToken(role)` — the one seam both standup wizards call (ARF-07).
 *
 * ARF-05 (identity standup) and ARF-06 (harness standup) do not know whether the
 * credential they are about to use was minted by ARF's own bundled minter or
 * handed over by an external broker. They call `resolveToken(role)` and get a
 * grant. Everything mode-specific lives below this file.
 *
 * ## The fail-loud gate
 *
 * The mapping lookup is the FIRST thing `resolveToken` does — before the cache,
 * before the in-flight table, before any network call, and in both modes. An
 * unmapped role throws `UnmappedRoleError` and returns nothing.
 *
 * This ordering is the whole point, not an implementation detail. SPEC §6 records
 * the 2026-07-23 RCA: a role with no token mapping fell through to the ambient
 * identity the process happened to be carrying, so a misconfiguration produced
 * *successful-looking* writes attributed to the wrong actor. Everything here is
 * arranged so there is no path to a credential that did not come from an
 * explicit mapping:
 *
 *   - the manifest refuses wildcard/catch-all role keys, so there is no entry an
 *     unrequested role can match (`manifest.mjs`);
 *   - the lookup precedes the cache, so a warm cache cannot answer for a role
 *     that is no longer mapped;
 *   - nothing reads `GITHUB_TOKEN`, `GH_TOKEN`, `gh auth`, a keychain, or any
 *     other ambient source — the only credential inputs are the secret refs a
 *     role entry names;
 *   - in external mode the response's own identity claims are checked against
 *     the request, so the far broker cannot substitute its default either
 *     (`external.mjs`).
 *
 * ## Freshness
 *
 * A cached grant is served only while it is still fresh by `refreshLeadSeconds`.
 * Serving a token with seconds left on it moves the failure to a call site far
 * from here — the shape of the 2026-07-12 refresh-deadline miss. Concurrent
 * resolves for the same role share one in-flight mint (single-flight), so a
 * wizard fanning out five steps does not open five token exchanges.
 *
 * ## Transient failures
 *
 * Both legs of a mint — the `op` subprocess and the HTTP call — get the same
 * bounded backoff (`retry.mjs`, `broker.transientRetryAttempts`), because a
 * classification that says "this is a blip" and then escalates on the first
 * occurrence is not doing anything. The retry sits *inside* the PAT fallback:
 * falling back changes which identity acts, so it is reached only once the App
 * identity's own retries are spent. In external mode, a 401/403 additionally
 * drops the memoized `endpointTokenRef` resolution, so a rotated broker
 * credential is picked up on the next attempt instead of at the next restart.
 *
 * ## Secrets
 *
 * A grant's `token` is a `SecretValue`: it redacts under string coercion, JSON,
 * and `util.inspect`. Audit records carry secret *references*, a token type, and
 * a truncated fingerprint — never material.
 */

import {
  BrokerConfigError, BrokerPermanentError, UnmappedRoleError,
} from './errors.mjs';
import {
  BROKER_MODE_BUNDLED, BROKER_MODE_EXTERNAL, PROVIDER_GITHUB_APP, PROVIDER_GITHUB_PAT,
  entrySecretRefs,
} from './manifest.mjs';
import { fetchExternalToken } from './external.mjs';
import { mintInstallationToken, resolvePatToken } from './github-app.mjs';
import { isTransientBrokerError } from './retry.mjs';
import { SecretValue, createSecretResolver } from './secrets.mjs';

/**
 * Classify a token by its issuer prefix without emitting any of its characters.
 * Useful in audits ("this role is running on its PAT fallback, not its App")
 * and safe to log, unlike the prefix itself.
 */
function tokenType(secret) {
  return secret.use((value) => {
    if (value.startsWith('ghs_')) return 'github_app_installation';
    if (value.startsWith('github_pat_')) return 'github_pat_fine_grained';
    if (value.startsWith('ghp_')) return 'github_pat_classic';
    if (value.startsWith('gho_')) return 'github_oauth';
    if (value.startsWith('ghu_')) return 'github_user_to_server';
    return 'unclassified';
  });
}

function buildGrant({ entry, mode, secret, expiresAt, credentialSource, permissions, now }) {
  // The safe fields are built once, as their own object, so `redacted()` cannot
  // drift from the grant by forgetting to strip a field added later — it is
  // built from the allowlist rather than by subtracting from the whole.
  const safe = {
    role: entry.role,
    mode,
    provider: entry.provider,
    credentialSource,
    tokenType: tokenType(secret),
    fingerprint: secret.fingerprint(),
    expiresAt,
    appId: entry.appId,
    installationId: entry.installationId,
    scope: entry.scope,
    principal: entry.principal,
    secretRefs: entrySecretRefs(entry),
    permissions,
  };

  // `expiresInSeconds` is a live getter, not a number captured at mint time. A
  // grant spends most of its life being served from the cache, and a frozen
  // value would tell the twentieth caller the token still had its full original
  // lifetime left. A caller sizing a long operation against that claim — or
  // caching the credential on the strength of it — would be holding a token
  // about to 401. `expiresAt` stays the absolute truth; this is derived from it
  // on every read, including through `redacted()` / `toJSON()`.
  const remaining = (target) => Object.defineProperty(target, 'expiresInSeconds', {
    get: () => Math.max(0, Math.round(expiresAt - now())),
    enumerable: true,
  });

  /** Everything in the grant except the material — for logs and API bodies. */
  const redacted = () => remaining({ ...safe, token: secret.toJSON() });
  return Object.freeze(remaining({ ...safe, token: secret, redacted, toJSON: redacted }));
}

/**
 * Build the token broker over a normalized broker config.
 *
 * @param {object} options
 * @param {ReturnType<import('./manifest.mjs').normalizeBrokerConfig>} options.config
 * @param {Function} [options.resolveSecret] ref -> Promise<SecretValue>
 * @param {Function} [options.fetchImpl]
 * @param {() => number} [options.now] epoch seconds; injectable for tests
 * @param {(ms: number) => Promise<any>} [options.sleep] backoff sleep; injectable for tests
 * @param {(record: object) => void} [options.logger] receives redacted audit records
 */
export function createTokenBroker({
  config,
  resolveSecret = null,
  fetchImpl = globalThis.fetch,
  now = () => Date.now() / 1000,
  sleep = undefined,
  logger = null,
} = {}) {
  if (!config || !(config.roles instanceof Map)) {
    throw new BrokerConfigError('createTokenBroker needs a normalized broker config');
  }
  if (typeof fetchImpl !== 'function') {
    throw new BrokerConfigError(
      'no fetch implementation is available; ARF needs a Node with global fetch',
    );
  }

  const cache = new Map();
  const inflight = new Map();
  let endpointTokenPromise = null;

  // One retry policy, shared by the subprocess (`op`) and network legs, so an
  // operator tuning `broker.transientRetryAttempts` gets the same behaviour out
  // of both rather than having to know which leg blipped.
  const retry = {
    attempts: config.transientRetryAttempts,
    baseDelayMs: config.transientRetryDelayMs,
    sleep,
    onRetry: ({ attempt, attempts, delayMs, error }) => audit('broker.transient_retry', {
      attempt, attempts, delayMs, reason: error.message, role: error.role ?? null,
    }),
  };
  const resolve = resolveSecret ?? createSecretResolver({ retry });

  function audit(event, fields) {
    if (typeof logger !== 'function') return;
    // Assembled from refs, classifications, and fingerprints only. There is no
    // branch of this function that can be handed a SecretValue's material.
    logger({ event, mode: config.mode, ...fields });
  }

  function endpointToken() {
    if (!config.endpointTokenRef) return Promise.resolve(null);
    // Resolved once per process: the credential that authenticates ARF *to* the
    // broker is long-lived, and re-reading it per mint would put a 1Password
    // round trip on every standup step.
    if (!endpointTokenPromise) {
      endpointTokenPromise = resolve(config.endpointTokenRef, {
        field: 'broker.endpointTokenRef',
      }).catch((err) => {
        endpointTokenPromise = null;
        throw err;
      });
    }
    return endpointTokenPromise;
  }

  async function mint(entry, nowSeconds) {
    if (config.mode === BROKER_MODE_EXTERNAL) {
      try {
        return await fetchExternalToken({
          entry,
          endpoint: config.endpoint,
          endpointToken: await endpointToken(),
          fetchImpl,
          requestTimeoutMs: config.requestTimeoutMs,
          nowSeconds,
          retry,
        });
      } catch (err) {
        // The broker rejected the credential ARF authenticated with. It is
        // resolved once per process — deliberately, since it is long-lived and
        // re-reading it per mint would put a 1Password round trip on every
        // standup step — so an operator who rotates `endpointTokenRef` would
        // otherwise keep failing against the withdrawn value until the daemon
        // restarted. Dropping the memo makes the *next* attempt re-read it; the
        // current failure still surfaces, because a silent retry here would
        // hide a genuinely revoked credential behind a rotation that never
        // happened.
        if (err?.endpointAuthRejected && endpointTokenPromise) {
          endpointTokenPromise = null;
          audit('broker.endpoint_token_invalidated', {
            role: entry.role,
            endpointTokenRef: config.endpointTokenRef,
            reason: err.message,
          });
        }
        throw err;
      }
    }

    if (entry.provider === PROVIDER_GITHUB_PAT) {
      return resolvePatToken({
        ref: entry.tokenRef,
        role: entry.role,
        resolveSecret: resolve,
        nowSeconds,
        ttlSeconds: entry.ttlSeconds ?? config.patFallbackTtlSeconds,
        credentialSource: 'github_pat',
      });
    }

    if (entry.provider !== PROVIDER_GITHUB_APP) {
      /* c8 ignore next 3 -- unreachable: the manifest rejects other providers at load */
      throw new BrokerConfigError(
        `role ${JSON.stringify(entry.role)} has provider ${JSON.stringify(entry.provider)}, `
        + `which the bundled minter cannot serve`,
      );
    }

    try {
      return await mintInstallationToken({
        entry,
        resolveSecret: resolve,
        fetchImpl,
        githubApiUrl: config.githubApiUrl,
        nowSeconds,
        requestTimeoutMs: config.requestTimeoutMs,
        retry,
      });
    } catch (err) {
      // Fall back to the PAT only on the transient side, and only once the
      // App identity's own bounded retries are spent. A permanent failure means
      // the App identity itself is wrong, and quietly posting as a PAT instead
      // would substitute an identity nobody asked for — the same class of
      // failure as an ambient fallback, just with a configured credential.
      if (!isTransientBrokerError(err) || !entry.patFallbackRef) throw err;
      audit('broker.pat_fallback', {
        role: entry.role,
        reason: err.message,
        patFallbackRef: entry.patFallbackRef,
      });
      return resolvePatToken({
        ref: entry.patFallbackRef,
        role: entry.role,
        resolveSecret: resolve,
        nowSeconds,
        ttlSeconds: config.patFallbackTtlSeconds,
        credentialSource: 'github_pat_fallback',
      });
    }
  }

  async function mintGrant(entry) {
    const nowSeconds = now();
    const minted = await mint(entry, nowSeconds);
    const secret = minted.secret;
    if (!SecretValue.isSecret(secret)) {
      /* c8 ignore next 3 -- a mode adapter that returned a bare string would leak it */
      throw new BrokerPermanentError(
        `internal: ${config.mode} minter returned an unwrapped token for role ${entry.role}`,
        { role: entry.role },
      );
    }
    const grant = buildGrant({
      entry,
      mode: config.mode,
      secret,
      expiresAt: minted.expiresAt,
      credentialSource: minted.credentialSource,
      permissions: minted.permissions ?? {},
      now,
    });
    cache.set(entry.role, grant);
    audit('broker.token_minted', {
      role: grant.role,
      provider: grant.provider,
      credentialSource: grant.credentialSource,
      tokenType: grant.tokenType,
      fingerprint: grant.fingerprint,
      expiresAt: grant.expiresAt,
      secretRefs: grant.secretRefs,
    });
    return grant;
  }

  function isFresh(grant, nowSeconds) {
    return Number.isFinite(grant.expiresAt)
      && grant.expiresAt - config.refreshLeadSeconds > nowSeconds;
  }

  /**
   * Resolve a credential for `role`.
   *
   * @param {string} role
   * @param {{forceRefresh?: boolean}} [options]
   * @returns {Promise<object>} the grant; `grant.token` is a `SecretValue`
   * @throws {UnmappedRoleError} when the role has no mapping — never a fallback
   */
  async function resolveToken(role, { forceRefresh = false } = {}) {
    const key = typeof role === 'string' ? role.trim() : String(role ?? '');
    const entry = key === '' ? undefined : config.roles.get(key);

    // FIRST. Before the cache, before the network, in both modes.
    if (!entry) {
      const err = new UnmappedRoleError(key, {
        knownRoles: [...config.roles.keys()],
        mode: config.mode,
      });
      audit('broker.unmapped_role', { role: key, knownRoles: err.knownRoles });
      throw err;
    }

    const nowSeconds = now();
    if (!forceRefresh) {
      const cached = cache.get(key);
      if (cached && isFresh(cached, nowSeconds)) {
        audit('broker.token_served_cached', {
          role: key, fingerprint: cached.fingerprint, expiresAt: cached.expiresAt,
        });
        return cached;
      }
      // A stale grant is dropped, never served with a warning attached: a token
      // past its refresh horizon fails downstream, where nobody is looking.
      if (cached) cache.delete(key);

      const pending = inflight.get(key);
      if (pending) return pending;
    }

    const promise = mintGrant(entry).finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  }

  return {
    mode: config.mode,
    resolveToken,

    /** Whether a role has an explicit mapping. Never consults the cache. */
    hasRole(role) {
      const key = typeof role === 'string' ? role.trim() : '';
      return key !== '' && config.roles.has(key);
    },

    /** Drop a cached grant (e.g. after GitHub rejects it as revoked). */
    invalidate(role) {
      const key = typeof role === 'string' ? role.trim() : '';
      return cache.delete(key);
    },

    /**
     * Operator-facing description of the seam. Refs, coordinates, and freshness
     * only: this is safe to render in a standup wizard or a health body.
     */
    describe() {
      const nowSeconds = now();
      return {
        mode: config.mode,
        configured: config.configured,
        endpoint: config.endpoint,
        endpointTokenRef: config.endpointTokenRef,
        githubApiUrl: config.mode === BROKER_MODE_BUNDLED ? config.githubApiUrl : null,
        refreshLeadSeconds: config.refreshLeadSeconds,
        rolesFile: config.rolesFile,
        rolesFileExists: config.rolesFileExists,
        roles: [...config.roles.values()].map((entry) => {
          const cached = cache.get(entry.role);
          return {
            role: entry.role,
            provider: entry.provider,
            source: entry.source,
            appId: entry.appId,
            installationId: entry.installationId,
            scope: entry.scope,
            principal: entry.principal,
            secretRefs: entrySecretRefs(entry),
            cached: Boolean(cached && isFresh(cached, nowSeconds)),
          };
        }),
      };
    },
  };
}

export { BROKER_MODE_BUNDLED, BROKER_MODE_EXTERNAL };
