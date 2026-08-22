/**
 * The bundled minter: GitHub-App installation tokens (`ghs_`), ARF-owned.
 *
 * SPEC §2 / §6: identity minting is the deepest coupling ARF has to agent-os, so
 * ARF bundles a minimal equivalent rather than importing one. This is the same
 * two-step exchange the in-OS broker performs — RS256 App JWT, then
 * `POST /app/installations/<id>/access_tokens` — reimplemented over `node:crypto`
 * and global `fetch` so ARF keeps its zero-dependency boundary.
 * `platform/oauth-broker/.../github_app.py` is a reference model, never an import.
 *
 * What is deliberately kept from that model:
 *
 * - **The permanent/transient split.** 401/403/404/422 mean the App, the
 *   installation, or the key is wrong; a retry re-signs the same bad assertion.
 *   5xx and timeouts are transient.
 * - **PAT fallback on the transient side only.** GitHub being briefly down is
 *   worth falling back for. A revoked private key is not: falling back there
 *   would silently swap the App identity for a PAT identity and post as the
 *   wrong actor — the failure mode this whole ticket exists to prevent.
 * - **A short JWT life with a skew allowance.** GitHub rejects an App JWT whose
 *   `iat` is in the future by even a second on a clock that drifts.
 *
 * What is deliberately not kept: caching and single-flight, which belong to the
 * seam above (`token-broker.mjs`) so both modes share one policy.
 */

import { createPrivateKey, createSign } from 'node:crypto';

import { BrokerPermanentError, BrokerTransientError } from './errors.mjs';
import { readCappedBody } from './http.mjs';
import { withTransientRetry } from './retry.mjs';
import { SecretValue, safeUpstreamDetail } from './secrets.mjs';

const GITHUB_API_VERSION = '2022-11-28';
/** GitHub caps App JWTs at 10 minutes; 9 leaves room for the skew allowance. */
const JWT_LIFETIME_SECONDS = 540;
const JWT_SKEW_SECONDS = 5;

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function base64urlJson(value) {
  return base64url(Buffer.from(JSON.stringify(value), 'utf8'));
}

/**
 * Mint a GitHub App RS256 JWT.
 *
 * @param {object} options
 * @param {string} options.appId
 * @param {import('./secrets.mjs').SecretValue} options.privateKey PEM, still wrapped
 * @param {number} options.nowSeconds
 * @param {string|null} [options.role] for error attribution only
 * @returns {string} the compact JWT
 */
export function mintAppJwt({ appId, privateKey, nowSeconds, role = null }) {
  const issuedAt = Math.floor(nowSeconds) - JWT_SKEW_SECONDS;
  const signingInput = [
    base64urlJson({ alg: 'RS256', typ: 'JWT' }),
    base64urlJson({ iat: issuedAt, exp: issuedAt + JWT_LIFETIME_SECONDS, iss: String(appId) }),
  ].join('.');

  // The PEM is unwrapped here and nowhere else, and the raw material never
  // leaves this callback: `key` is a KeyObject, which does not render its
  // material under inspect or JSON.
  const key = privateKey.use((pem) => {
    try {
      return createPrivateKey(pem);
    } catch (err) {
      // `err.message` from node:crypto describes the parse failure, not the
      // input, but the ref is what an operator can act on either way.
      throw new BrokerPermanentError(
        `github app private key${privateKey.ref ? ` (${privateKey.ref})` : ''} is not a readable `
        + `private key: ${err.message}`,
        { role },
      );
    }
  });
  if (key.asymmetricKeyType !== 'rsa') {
    throw new BrokerPermanentError(
      `github app private key${privateKey.ref ? ` (${privateKey.ref})` : ''} must be RSA, got `
      + `${key.asymmetricKeyType}`,
      { role },
    );
  }

  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(key);
  return `${signingInput}.${base64url(signature)}`;
}

function githubMessage(bodyText, status, secrets = []) {
  const base = `github app token exchange failed with HTTP ${status}`;
  try {
    const body = JSON.parse(bodyText);
    if (typeof body?.message === 'string' && body.message) {
      // GitHub's message is worth quoting — "Integration not found" is the
      // difference between a five-minute fix and an hour — but it is someone
      // else's text, so it is scrubbed before it becomes ARF's error.
      return `${base}: ${safeUpstreamDetail(body.message, secrets).slice(0, 200)}`;
    }
  } catch {
    // A non-JSON error body tells us nothing an operator can use; the status
    // already does. Echoing it raw risks pasting a proxy's response into a log.
  }
  return base;
}

/** GitHub's `expires_at` is ISO-8601 with a `Z`; return epoch seconds. */
export function parseExpiresAt(value, { role = null } = {}) {
  if (typeof value !== 'string' || value === '') {
    throw new BrokerTransientError('github response expires_at is missing', { role });
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new BrokerTransientError('github response expires_at is invalid', { role });
  }
  return ms / 1000;
}

/**
 * Exchange an App JWT for an installation token.
 *
 * @param {object} options
 * @param {object} options.entry            normalized role entry
 * @param {Function} options.resolveSecret  ref -> Promise<SecretValue>
 * @param {Function} options.fetchImpl
 * @param {string} options.githubApiUrl
 * @param {number} options.nowSeconds
 * @param {number} options.requestTimeoutMs
 * @param {object} [options.retry] bounded-backoff options; see `retry.mjs`
 * @returns {Promise<{secret: import('./secrets.mjs').SecretValue, expiresAt: number,
 *   credentialSource: string, permissions: object}>}
 */
export async function mintInstallationToken({
  entry, resolveSecret, fetchImpl, githubApiUrl, nowSeconds, requestTimeoutMs, retry = undefined,
}) {
  const role = entry.role;
  const privateKey = await resolveSecret(entry.privateKeyRef, {
    field: 'privateKeyRef', role,
  });
  const jwt = mintAppJwt({ appId: entry.appId, privateKey, nowSeconds, role });

  const url = `${githubApiUrl}/app/installations/${encodeURIComponent(entry.installationId)}/access_tokens`;
  // The private key is passed as a scrub target: an upstream that echoed the
  // request back would otherwise republish it through ARF's own error message.
  const secrets = [privateKey];

  // Only the exchange is retried, not the key resolution above it: the JWT is
  // good for nine minutes, so re-signing per attempt would buy nothing and put
  // another 1Password round trip on every blip. The PAT fallback in
  // `token-broker.mjs` sits *outside* this loop by design — a persistent
  // transient failure should exhaust the App identity's retries before ARF
  // considers acting under a different one.
  return withTransientRetry(async () => {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': GITHUB_API_VERSION,
          'content-type': 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      throw new BrokerTransientError(
        `github app token exchange for role ${JSON.stringify(role)} failed: ${err.message}`,
        { role, cause: err },
      );
    }

    // Capped and streamed: an error page served by whatever is answering on the
    // GitHub API host must not be able to exhaust ARF's heap on the way to an error.
    const bodyText = await readCappedBody(response);
    if ([401, 403, 404, 422].includes(response.status)) {
      throw new BrokerPermanentError(githubMessage(bodyText, response.status, secrets), { role });
    }
    if (response.status >= 500 || response.status === 429 || response.status === 408) {
      throw new BrokerTransientError(githubMessage(bodyText, response.status, secrets), { role });
    }
    if (!response.ok) {
      throw new BrokerPermanentError(githubMessage(bodyText, response.status, secrets), { role });
    }

    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new BrokerTransientError('github returned invalid JSON', { role });
    }
    if (typeof body?.token !== 'string' || body.token === '') {
      throw new BrokerPermanentError('github response token is missing', { role });
    }

    return {
      // Wrapped here, at the boundary: `body.token` is the only place the raw
      // `ghs_` string exists as a plain value, and it does not outlive this frame.
      secret: new SecretValue(body.token, null),
      expiresAt: parseExpiresAt(body.expires_at, { role }),
      permissions: (body.permissions && typeof body.permissions === 'object') ? body.permissions : {},
      credentialSource: 'github_app_installation',
    };
  }, retry);
}

/**
 * Resolve a PAT reference into a token, used both for the `github_pat` provider
 * and as the App fallback. The PAT has no server-side expiry we can read, so the
 * grant gets a short TTL and is re-resolved rather than held indefinitely.
 */
export async function resolvePatToken({ ref, role, resolveSecret, nowSeconds, ttlSeconds, credentialSource }) {
  const secret = await resolveSecret(ref, { field: 'tokenRef', role });
  return {
    secret,
    expiresAt: nowSeconds + ttlSeconds,
    permissions: {},
    credentialSource,
  };
}
