// claude-reviewer-token-proxy.mjs — a Claude reviewer survives a broker token
// rotation (TOKDZ-01; the BATCHTOKEN-01 mechanism, agent-os #7183, applied to
// reviewers).
//
// THE DEAD ZONE THIS REMOVES (SEV3 2026-09-28, agent-os #7309): the reviewer
// handed the `claude` CLI a static bearer in `ANTHROPIC_AUTH_TOKEN`. A broker
// rotation revokes the old grant upstream, so the handoff had to insist on a
// token that outlived the reviewer's MAXIMUM timeout (~3 h). A Claude OAuth
// token lives 8 h and the keychain bridge rotates it only when fewer than 30 min
// remain, so for ~2.5 h of every cycle nothing could satisfy the handoff and
// every Claude review was refused.
//
// THE MECHANISM. The credential the CLI sends is just an `Authorization` header
// on HTTPS requests to `ANTHROPIC_BASE_URL`, and that base URL is redirectable.
// For the life of one reviewer spawn, this module runs a loopback forwarding
// proxy in the reviewer process (the CLI's parent) and points the CLI at it.
// Every upstream request carries the CURRENT broker grant instead of the
// CLI's frozen copy:
//   - a grant within `proactiveRefreshLeadMs` of expiry is re-fetched before the
//     request is forwarded;
//   - an upstream 401 (the rotation revoked the grant the request carried)
//     re-fetches the broker's current grant and replays the request once. A 401
//     rejects the request before any work, so the replay is safe;
//   - when the broker has not rotated yet, the proxy answers 503. The CLI treats
//     that as retryable and backs off instead of dying on a 401, and the harness
//     classifies an unhealed rejection as `token-refresh-pending`: a bounded
//     hold, never an OAuth page.
// So the handoff no longer needs a token that outlives the maximum timeout, only
// one that is not already about to expire (`CLAUDE_REVIEWER_PROXIED_HANDOFF_FLOOR_MS`).
//
// What this deliberately does NOT do:
//   - It never asks the broker to refresh. It only re-reads the broker's current
//     grant through the same `/token` mint every reviewer spawn already makes.
//     The BATCHTOKEN-01 proxy escalates to a forced refresh when the current
//     grant is still rejected; a forced refresh revokes every other live holder,
//     so that step is left out here. The keychain bridge stays the sole refresh
//     owner.
//   - It never listens off loopback and never forwards anywhere but the
//     Anthropic API (or, in tests, a loopback upstream). The CLI's own frozen
//     bearer is accepted only as caller proof and is never sent upstream.
//   - It never logs a token. Tokens live in this process's memory and the
//     outbound `Authorization` header; caller proof compares SHA-256 digests.

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';

export const CLAUDE_REVIEWER_TOKEN_PROXY_ENV = 'ADVERSARIAL_REVIEW_CLAUDE_TOKEN_REFRESH_PROXY';
export const ANTHROPIC_UPSTREAM = 'https://api.anthropic.com';
// The proxied handoff only needs the spawn-time grant to still be usable while
// the CLI starts; the proxy carries it across expiry and rotation after that.
// The bridge serves grants with at least its 30 min refresh window left, so on a
// healthy bridge this floor never refuses.
export const CLAUDE_REVIEWER_PROXIED_HANDOFF_FLOOR_MS = 5 * 60 * 1000;
export const DEFAULT_PROACTIVE_REFRESH_LEAD_MS = 2 * 60 * 1000;
export const DEFAULT_REMINT_COOLDOWN_MS = 5 * 1000;
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;
export const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const TOKEN_REFRESH_PENDING_PROXY_MESSAGE =
  '[token-refresh-pending] Claude reviewer token proxy: the broker grant was rejected upstream and the broker has not rotated it yet; retry';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

// Hop-by-hop headers (RFC 7230 §6.1) plus the credential headers this proxy
// owns. `authorization` is the CLI's frozen copy; `x-api-key` is dropped because
// a broker OAuth grant must never be presented as an API key.
const DROP_REQUEST_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'accept-encoding',
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);
const DROP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

export function claudeReviewerTokenProxyEnabled(env = process.env) {
  const raw = String(env?.[CLAUDE_REVIEWER_TOKEN_PROXY_ENV] ?? '').trim().toLowerCase();
  return !['off', '0', 'false', 'no', 'disabled'].includes(raw);
}

function assertAllowedUpstream(upstream) {
  let url;
  try {
    url = new URL(upstream);
  } catch {
    throw new Error(`claude reviewer token proxy upstream is not a URL: ${JSON.stringify(upstream)}`);
  }
  const normalized = `${url.protocol}//${url.host}`;
  if (normalized === ANTHROPIC_UPSTREAM) return url;
  if ((url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new Error(
    `claude reviewer token proxy upstream must be ${ANTHROPIC_UPSTREAM} or a loopback URL (got ${normalized})`
  );
}

function digest(token) {
  return createHash('sha256').update(String(token)).digest();
}

function bearerFrom(header) {
  const match = String(header || '').trim().match(/^bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

function expiresAtMsOf(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonError(res, status, type, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = Buffer.from(JSON.stringify({ type: 'error', error: { type, message } }));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// The grant the proxy forwards with. Re-fetches are coalesced (concurrent
// requests share one broker call) and rate-limited, so a burst of 401s during a
// rotation costs one mint, not one per request.
function createTokenSource({ initialToken, initialExpiresAt, remint, now, logger, cooldownMs, stats }) {
  let current = { token: initialToken, expiresAtMs: expiresAtMsOf(initialExpiresAt) };
  const known = [digest(initialToken)];
  let inflight = null;
  let lastRemintAtMs = -Infinity;

  function remember(token) {
    const candidate = digest(token);
    if (!known.some((entry) => timingSafeEqual(entry, candidate))) {
      known.push(candidate);
      if (known.length > 32) known.splice(1, 1); // keep the spawn-time grant
    }
  }

  async function refetch(reason) {
    if (inflight) return inflight;
    if (now() - lastRemintAtMs < cooldownMs) return current;
    lastRemintAtMs = now();
    inflight = (async () => {
      try {
        const minted = await remint();
        const token = typeof minted?.token === 'string' ? minted.token.trim() : '';
        if (!token) {
          logger?.warn?.(`[reviewer-token-proxy] broker re-read (${reason}) returned no bearer; keeping the current grant`);
          return current;
        }
        stats.remints += 1;
        remember(token);
        const rotated = token !== current.token;
        current = { token, expiresAtMs: expiresAtMsOf(minted?.expiresAt) ?? current.expiresAtMs };
        if (rotated) {
          stats.rotationsObserved += 1;
          logger?.info?.(
            `[reviewer-token-proxy] picked up a rotated broker grant (${reason}); ` +
            `expires_at=${current.expiresAtMs ? new Date(current.expiresAtMs).toISOString() : 'unknown'}`
          );
        }
        return current;
      } catch (err) {
        logger?.warn?.(`[reviewer-token-proxy] broker re-read (${reason}) failed: ${err?.message || err}`);
        return current;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  return {
    current: () => current,
    isKnownCaller(header) {
      const presented = bearerFrom(header);
      if (!presented) return false;
      const candidate = digest(presented);
      return known.some((entry) => timingSafeEqual(entry, candidate));
    },
    async forRequest(proactiveLeadMs) {
      if (current.expiresAtMs !== null && current.expiresAtMs - now() <= proactiveLeadMs) {
        stats.proactiveRemints += 1;
        await refetch('near-expiry');
      }
      return current;
    },
    async afterRejection(rejectedToken) {
      if (current.token !== rejectedToken) return current;
      const next = await refetch('upstream-401');
      return next.token !== rejectedToken ? next : null;
    },
  };
}

export async function startClaudeReviewerTokenProxy({
  initialToken,
  initialExpiresAt = null,
  remint,
  upstream = ANTHROPIC_UPSTREAM,
  logger = console,
  now = () => Date.now(),
  proactiveRefreshLeadMs = DEFAULT_PROACTIVE_REFRESH_LEAD_MS,
  remintCooldownMs = DEFAULT_REMINT_COOLDOWN_MS,
  maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
  upstreamIdleTimeoutMs = DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS,
} = {}) {
  if (!String(initialToken || '').trim()) throw new Error('claude reviewer token proxy needs the spawn-time bearer');
  if (typeof remint !== 'function') throw new Error('claude reviewer token proxy needs a broker re-read function');
  const upstreamUrl = assertAllowedUpstream(upstream);
  const send = upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest;
  const stats = {
    requests: 0,
    forwarded: 0,
    remints: 0,
    proactiveRemints: 0,
    rotationsObserved: 0,
    rejectionsRecovered: 0,
    rejectionsUnrecovered: 0,
    unauthorizedCallers: 0,
    lastUnauthorized: null,
  };
  // 'rotation-pending' from the moment a rejection could not be healed until
  // the next upstream answer that is not a 401. The harness reads it to tell a
  // rotation lag from a genuinely bad credential.
  let authState = 'ok';
  const source = createTokenSource({
    initialToken: String(initialToken).trim(),
    initialExpiresAt,
    remint,
    now,
    logger,
    cooldownMs: remintCooldownMs,
    stats,
  });

  function forwardOnce(req, body, token) {
    return new Promise((resolve, reject) => {
      const target = new URL(req.url, upstreamUrl);
      const headers = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (!DROP_REQUEST_HEADERS.has(name.toLowerCase())) headers[name] = value;
      }
      headers.host = upstreamUrl.host;
      if (token) headers.authorization = `Bearer ${token}`;
      if (body.length > 0 || !['GET', 'HEAD'].includes(req.method)) headers['content-length'] = String(body.length);
      const upstreamReq = send(target, { method: req.method, headers }, resolve);
      upstreamReq.setTimeout(upstreamIdleTimeoutMs, () => {
        upstreamReq.destroy(new Error(`upstream idle for ${upstreamIdleTimeoutMs}ms`));
      });
      upstreamReq.on('error', reject);
      upstreamReq.end(body);
    });
  }

  async function handle(req, res) {
    stats.requests += 1;
    // Origin-form only: an absolute-form target could steer the bearer off-host.
    if (!String(req.url || '').startsWith('/')) {
      req.resume();
      jsonError(res, 400, 'invalid_request_error', 'claude reviewer token proxy accepts origin-form requests only');
      return;
    }
    // A request that carries no credential at all (the CLI's `HEAD /api/hello`
    // connectivity probe) is forwarded without one, exactly as the CLI would
    // send it without the proxy. Only a caller proving it holds the reviewer's
    // bearer ever gets the broker grant attached; any other credential is refused.
    const anonymous = !req.headers.authorization && !req.headers['x-api-key'];
    if (!anonymous && !source.isKnownCaller(req.headers.authorization)) {
      stats.unauthorizedCallers += 1;
      // Method and path only (no query, no headers): enough to tell a stray
      // local caller from a CLI request that lost its bearer.
      stats.lastUnauthorized = `${req.method} ${String(req.url).split('?')[0]}`;
      req.resume();
      jsonError(res, 401, 'authentication_error', 'claude reviewer token proxy requires the reviewer\'s broker bearer');
      return;
    }
    let body;
    try {
      body = await readBody(req, maxRequestBodyBytes);
    } catch (err) {
      jsonError(res, err?.tooLarge ? 413 : 400, 'invalid_request_error', `claude reviewer token proxy: ${err?.message || err}`);
      return;
    }
    let grant = anonymous ? null : await source.forRequest(proactiveRefreshLeadMs);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let upstreamRes;
      try {
        upstreamRes = await forwardOnce(req, body, grant?.token || null);
      } catch (err) {
        jsonError(res, 502, 'api_error', `claude reviewer token proxy: upstream unreachable: ${err?.message || err}`);
        return;
      }
      if (grant && upstreamRes.statusCode === 401 && attempt === 0) {
        upstreamRes.resume();
        const next = await source.afterRejection(grant.token);
        if (next) {
          stats.rejectionsRecovered += 1;
          grant = next;
          continue;
        }
        stats.rejectionsUnrecovered += 1;
        authState = 'rotation-pending';
        jsonError(res, 503, 'api_error', TOKEN_REFRESH_PENDING_PROXY_MESSAGE);
        return;
      }
      // A 401 on the replay means the broker's CURRENT grant is rejected too:
      // that is a bad credential, not a rotation lag, so it is mirrored to the
      // CLI and must surface as an auth failure rather than a hold.
      if (grant) authState = upstreamRes.statusCode === 401 ? 'rejected' : 'ok';
      stats.forwarded += 1;
      const headers = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) headers[name] = value;
      }
      res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, headers);
      res.on('close', () => {
        if (!res.writableFinished) upstreamRes.destroy();
      });
      try {
        await pipeline(upstreamRes, res);
      } catch {
        // The client went away or the upstream stream broke mid-response; either
        // way the socket is already torn down and the CLI sees the truncation.
      }
      return;
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      jsonError(res, 502, 'api_error', `claude reviewer token proxy: ${err?.message || err}`);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address();
  let closed = null;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stats: () => ({ ...stats, authState }),
    rotationPending: () => authState === 'rotation-pending',
    currentExpiresAt: () => {
      const { expiresAtMs } = source.current();
      return expiresAtMs === null ? null : new Date(expiresAtMs).toISOString();
    },
    close() {
      if (!closed) {
        // One line per reviewer spawn: the evidence that a rotation was
        // survived (rotations>0, recovered>0) or was not (unrecovered>0).
        logger?.info?.(
          `[reviewer-token-proxy] closed requests=${stats.requests} forwarded=${stats.forwarded} ` +
          `remints=${stats.remints} rotations=${stats.rotationsObserved} ` +
          `recovered=${stats.rejectionsRecovered} unrecovered=${stats.rejectionsUnrecovered} ` +
          `unauthorized=${stats.unauthorizedCallers}`
        );
        closed = new Promise((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        });
      }
      return closed;
    },
  };
}

// Start the proxy for one reviewer spawn, or return null so the caller falls
// back to the direct (static-bearer) handoff and its full-lifetime check. Null
// when the operator disabled it, when the auth carries no broker re-read (a
// keychain transport, or a test double), or when the listener cannot start.
export async function startClaudeReviewerTokenProxyForAuth({
  auth,
  env = process.env,
  logger = console,
  startImpl = startClaudeReviewerTokenProxy,
} = {}) {
  if (!claudeReviewerTokenProxyEnabled(env)) return null;
  if (auth?.transport !== 'broker' || typeof auth?.remint !== 'function') return null;
  const initialToken = String(auth?.env?.ANTHROPIC_AUTH_TOKEN || '').trim();
  if (!initialToken) return null;
  try {
    return await startImpl({
      initialToken,
      initialExpiresAt: auth.expiresAt || null,
      remint: auth.remint,
      logger,
    });
  } catch (err) {
    logger?.warn?.(
      `[reviewer-token-proxy] could not start; falling back to the direct handoff: ${err?.message || err}`
    );
    return null;
  }
}
