/**
 * External mode: point ARF at a broker that already exists (ARF-07).
 *
 * In-OS this is the LiteLLM/oauth-broker sidecar that already holds the
 * `identities/*.yaml` descriptors and mints `ghs_` tokens for the reviewer and
 * hammer principals. ARF does not import its client — it speaks a small HTTP
 * contract to it, so any equivalent service can be dropped in:
 *
 *   POST <endpoint>/token
 *     request : {"role": "...", "scope": "...", "provider": "...", "principal": "..."}
 *     response: {"token": "ghs_…", "expires_at": "2026-08-19T12:00:00Z",
 *                "role"?: "...", "scope"?: "...", "principal"?: "..."}
 *
 * `access_token` / `expiresAt` are accepted as aliases, because every broker
 * spells these two fields slightly differently and a rename should not be a
 * fork.
 *
 * The part that is not negotiable is **identity confirmation**. If the response
 * echoes a role, scope, or principal, it must match what ARF asked for. A broker
 * that answers an unrecognised role with its own default credential is the
 * ambient-fallback failure (SPEC §6, RCA 2026-07-23) relocated across a socket:
 * ARF would post as an identity it never requested and the misconfiguration
 * would look like success. Mismatch is refused, and the token is discarded
 * without being returned.
 */

import { AmbientIdentityRefusedError, BrokerPermanentError, BrokerTransientError } from './errors.mjs';
import { readCappedBody } from './http.mjs';
import { withTransientRetry } from './retry.mjs';
import { SecretValue, safeUpstreamDetail } from './secrets.mjs';

/** Response fields that assert an identity, paired with the entry field they must match. */
const IDENTITY_FIELDS = [
  ['role', (entry) => entry.role],
  ['scope', (entry) => entry.scope],
  ['principal', (entry) => entry.principal],
];

function brokerMessage(bodyText, status, secrets = []) {
  const base = `broker token request failed with HTTP ${status}`;
  try {
    const body = JSON.parse(bodyText);
    const detail = body?.error ?? body?.message ?? body?.detail;
    if (typeof detail === 'string' && detail) {
      // Someone else's text, quoted into ARF's error: scrub it first. A broker
      // that echoes the credential ARF authenticated with is not hypothetical —
      // "invalid token: <token>" is a common shape.
      return `${base}: ${safeUpstreamDetail(detail, secrets).slice(0, 200)}`;
    }
  } catch {
    // Non-JSON error body: the status is the only thing we can trust to be
    // about the request rather than about a proxy in front of it.
  }
  return base;
}

function coerceExpiresAt(body, { role, nowSeconds }) {
  const value = body.expires_at ?? body.expiresAt ?? null;
  if (value === null || value === undefined || value === '') {
    throw new BrokerTransientError('broker response has no expires_at', { role });
  }
  let seconds;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds vs milliseconds is guessable only by magnitude; anything past the
    // year ~2286 in seconds is certainly milliseconds.
    seconds = value > 1e11 ? value / 1000 : value;
  } else {
    const ms = Date.parse(String(value));
    if (!Number.isFinite(ms)) {
      throw new BrokerTransientError('broker response expires_at is invalid', { role });
    }
    seconds = ms / 1000;
  }
  // Checked for both spellings: an already-expired grant is worse than no
  // grant, because it fails at a call site far from the broker that issued it.
  if (seconds <= nowSeconds) {
    throw new BrokerTransientError('broker returned an already-expired token', { role });
  }
  return seconds;
}

/**
 * Confirm the credential we were handed is the identity we asked for.
 *
 * Only fields the response actually asserts are checked — a broker that says
 * nothing about identity is not treated as having confirmed one, and a broker
 * that says something must say the right thing.
 */
export function confirmIdentity(entry, body) {
  for (const [field, expectedOf] of IDENTITY_FIELDS) {
    const actual = body?.[field];
    if (actual === undefined || actual === null || actual === '') continue;
    const expected = expectedOf(entry);
    if (expected === null || expected === undefined) continue;
    if (String(actual) !== String(expected)) {
      throw new AmbientIdentityRefusedError(entry.role, { field, expected, actual: String(actual) });
    }
  }
}

/**
 * Request a token for one role from the configured external broker.
 *
 * @param {object} options
 * @param {object} options.entry           normalized role entry
 * @param {string} options.endpoint        broker base URL (entry.endpoint wins if set)
 * @param {import('./secrets.mjs').SecretValue|null} options.endpointToken
 * @param {Function} options.fetchImpl
 * @param {number} options.requestTimeoutMs
 * @param {number} options.nowSeconds
 * @param {object} [options.retry] bounded-backoff options; see `retry.mjs`
 * @returns {Promise<{secret: SecretValue, expiresAt: number, credentialSource: string,
 *   permissions: object}>}
 */
export async function fetchExternalToken({
  entry, endpoint, endpointToken, fetchImpl, requestTimeoutMs, nowSeconds, retry = undefined,
}) {
  const role = entry.role;
  const base = entry.endpoint ?? endpoint;
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (endpointToken) {
    // Built inside `use()` and handed straight to fetch; the header object is
    // not logged anywhere in this module.
    headers.authorization = endpointToken.use((value) => `Bearer ${value}`);
  }

  const payload = {
    role,
    provider: entry.provider,
    ...(entry.scope ? { scope: entry.scope } : {}),
    ...(entry.principal ? { principal: entry.principal } : {}),
  };

  // Bounded backoff on the transient side only. A broker behind a proxy or a
  // restarting sidecar answers 502/503 for a few seconds at a time, and the
  // external mode has no PAT fallback to mask it: without a retry the very
  // first blip fails the standup step outright.
  return withTransientRetry(async () => {
    let response;
    try {
      response = await fetchImpl(`${base}/token`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (err) {
      throw new BrokerTransientError(
        `broker at ${base} could not be reached for role ${JSON.stringify(role)}: ${err.message}`,
        { role, cause: err },
      );
    }

    // Capped and streamed: a broker (or a proxy in front of it) that answers with
    // a huge body must not be able to exhaust ARF's heap on the way to an error.
    const bodyText = await readCappedBody(response);
    if (response.status === 404 || response.status === 400) {
      // The broker does not know this role. That is the same fail-loud condition
      // as a locally-unmapped role, stated by the far side, and it must not be
      // retried into a fallback.
      throw new BrokerPermanentError(
        `${brokerMessage(bodyText, response.status, [endpointToken])} — the broker has no mapping for role `
        + `${JSON.stringify(role)}${entry.scope ? ` (scope ${entry.scope})` : ''}`,
        { role },
      );
    }
    if (response.status === 401 || response.status === 403) {
      // The broker rejected the credential ARF authenticated *with*, not the
      // role it asked about. That credential is resolved once per process, so
      // an operator who rotates `endpointTokenRef` would otherwise keep hitting
      // this until the daemon restarted. Flagged rather than handled here:
      // dropping the cached resolution belongs to whoever owns that cache
      // (`token-broker.mjs`), and the failure itself stays permanent.
      const err = new BrokerPermanentError(
        brokerMessage(bodyText, response.status, [endpointToken]), { role },
      );
      err.endpointAuthRejected = true;
      throw err;
    }
    if (response.status === 422) {
      throw new BrokerPermanentError(brokerMessage(bodyText, response.status, [endpointToken]), { role });
    }
    if (response.status >= 500 || response.status === 429 || response.status === 408) {
      throw new BrokerTransientError(brokerMessage(bodyText, response.status, [endpointToken]), { role });
    }
    if (!response.ok) {
      throw new BrokerPermanentError(brokerMessage(bodyText, response.status, [endpointToken]), { role });
    }

    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new BrokerTransientError('broker returned invalid JSON', { role });
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new BrokerTransientError('broker returned a non-object response', { role });
    }

    // Identity is confirmed BEFORE the token is wrapped or returned, so a refused
    // response never produces a usable grant anywhere up the stack.
    confirmIdentity(entry, body);

    const token = body.token ?? body.access_token;
    if (typeof token !== 'string' || token === '') {
      throw new BrokerPermanentError('broker response token is missing', { role });
    }
    const expiresAt = coerceExpiresAt(body, { role, nowSeconds });

    return {
      secret: new SecretValue(token, null),
      expiresAt,
      permissions: (body.permissions && typeof body.permissions === 'object') ? body.permissions : {},
      credentialSource: typeof body.credential_source === 'string' && body.credential_source
        ? body.credential_source
        : 'external_broker',
    };
  }, retry);
}
