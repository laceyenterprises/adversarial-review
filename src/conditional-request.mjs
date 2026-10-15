import { createRequire } from 'node:module';

import { apiStatusFromError, recordApiCall } from './api-telemetry.mjs';
import {
  buildEtagCallKey,
  getCachedEtag,
  putCachedEtag,
} from './etag-cache.mjs';
import { awaitThrottleIfNeeded, recordResponseRateLimit, extractRateLimitObservation, isGitHubRateLimitError, githubCredential, recordRateLimitedCall } from './rate-limit-throttle.mjs';

const require = createRequire(import.meta.url);

function defaultOctokitFactory(options) {
  const { Octokit } = require('@octokit/rest');
  return new Octokit(options);
}

function getResponseHeader(headers, name) {
  if (!headers || !name) return null;
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return value == null ? null : String(value).trim() || null;
  }
  const target = String(name).trim().toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).trim().toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value.map((entry) => String(entry || '').trim()).find(Boolean) || null;
    return String(value || '').trim() || null;
  }
  return null;
}

function responseStatus(response, fallback = 200) {
  if (Number.isFinite(Number(response?.status))) return Math.trunc(Number(response.status));
  return fallback;
}

function buildConditionalCacheHitResponse(cached, response = null) {
  return {
    status: 304,
    headers: response?.headers || {},
    data: cached.body,
    fromConditionalCache: true,
  };
}

function recordConditional304Telemetry({ repo, prNumber, startedAt, recordApiCallImpl = recordApiCall }) {
  recordApiCallImpl({
    category: 'conditional_304',
    repo,
    prNumber,
    status: 304,
    durationMs: Date.now() - startedAt,
  });
}

async function fetchConditionalRestPage({
  category,
  endpoint,
  repo,
  prNumber,
  params,
  request,
  rootDir,
  logger = console,
  telemetryStatusFallback = 200,
  allowConditionalRequest = true,
  recordApiCallImpl = recordApiCall,
  putCachedEtagImpl = putCachedEtag,
  credential = githubCredential({ token: process.env.GITHUB_TOKEN || null }),
} = {}) {
  if (!rootDir) throw new TypeError('rootDir is required for conditional REST cache');
  if (typeof request !== 'function') {
    throw new TypeError(`request function is required for ${endpoint}`);
  }
  const callKey = buildEtagCallKey({
    repo,
    prNumber,
    category,
    endpoint,
    params,
  });
  const cached = getCachedEtag(rootDir, callKey);
  const startedAt = Date.now();
  const hasReusableCachedBody = cached?.body !== null && cached?.body !== undefined;
  const conditionalHeaders = allowConditionalRequest && cached?.etag && hasReusableCachedBody
    ? { 'if-none-match': cached.etag }
    : null;
  const requestParams = conditionalHeaders
    ? { ...params, headers: { ...(params?.headers || {}), ...conditionalHeaders } }
    : { ...params };

  async function runRequest(activeParams) {
    await awaitThrottleIfNeeded('core', credential);
    return request(activeParams);
  }

  try {
    let response = await runRequest(requestParams);
    await recordResponseRateLimit({
      credential,
      remaining: getResponseHeader(response?.headers, 'x-ratelimit-remaining'),
      resetAt: getResponseHeader(response?.headers, 'x-ratelimit-reset'),
      observedAt: new Date().toISOString(),
    });
    if (responseStatus(response) === 304) {
      if (cached?.body !== null && cached?.body !== undefined) {
        recordConditional304Telemetry({ repo, prNumber, startedAt, recordApiCallImpl });
        return buildConditionalCacheHitResponse(cached, response);
      }
      response = await runRequest({ ...params });
    }
    const status = responseStatus(response, telemetryStatusFallback);
    recordApiCallImpl({
      category,
      repo,
      prNumber,
      status,
      durationMs: Date.now() - startedAt,
    });
    if (status === 200) {
      const etag = getResponseHeader(response?.headers, 'etag');
      if (etag) {
        try {
          putCachedEtagImpl(rootDir, callKey, etag, response?.data ?? null);
        } catch (err) {
          logger.warn?.(
            `[watcher] conditional cache write failed for ${repo}#${prNumber} ${endpoint}; continuing without cache update: ${err?.message || err}`
          );
        }
      }
    }
    return response;
  } catch (err) {
    if (isGitHubRateLimitError(err) && !err.budgetDeferred) {
      err.observation = await recordRateLimitedCall('core', credential, extractRateLimitObservation(err?.response?.headers, { rateLimited: true }));
    }
    await recordResponseRateLimit({
      credential,
      remaining: getResponseHeader(err?.response?.headers, 'x-ratelimit-remaining'),
      resetAt: getResponseHeader(err?.response?.headers, 'x-ratelimit-reset'),
      observedAt: new Date().toISOString(),
    });
    const status = apiStatusFromError(err);
    if (status === 304) {
      if (cached?.body !== null && cached?.body !== undefined) {
        recordConditional304Telemetry({ repo, prNumber, startedAt, recordApiCallImpl });
        return buildConditionalCacheHitResponse(cached, err?.response);
      }
      if (!allowConditionalRequest) {
        recordApiCallImpl({
          category,
          repo,
          prNumber,
          status,
          durationMs: Date.now() - startedAt,
        });
        throw err;
      }
      return fetchConditionalRestPage({
        category,
        endpoint,
        repo,
        prNumber,
        params,
        request,
        rootDir,
        logger,
        telemetryStatusFallback,
        allowConditionalRequest: false,
        recordApiCallImpl,
        putCachedEtagImpl,
        credential,
      });
    }
    recordApiCallImpl({
      category,
      repo,
      prNumber,
      status,
      durationMs: Date.now() - startedAt,
    });
    throw err;
  }
}

function createWatcherOctokit({
  auth = process.env.GITHUB_TOKEN,
  octokitFactory = defaultOctokitFactory,
  authProvider = null,
} = {}) {
  const hasDynamicAuth = typeof authProvider === 'function';
  const requestTokens = new WeakMap();
  const octokit = octokitFactory(hasDynamicAuth ? {} : { auth });
  // When an authProvider is supplied, refresh the Authorization header on EVERY
  // request from the live token. The watcher is a long-lived process and its
  // octokit is constructed ONCE at startup; a GitHub App installation token
  // (broker-backed, ~1h life) snapshotted at construction would expire and can
  // also be re-applied by Octokit's auth plugin after before-hooks. Dynamic mode
  // therefore constructs an unauthenticated client and injects the live token in
  // the request hook.
  if (hasDynamicAuth && octokit?.hook?.before) {
    octokit.hook.before('request', (options) => {
      let token;
      try {
        token = requestTokens.has(options) ? requestTokens.get(options) : authProvider();
      } catch {
        token = null;
      }
      if (token) {
        options.headers = options.headers || {};
        options.headers.authorization = `token ${token}`;
      }
    });
  }
  octokit?.hook?.wrap?.('request', async (request, options) => {
    const resource = String(options.url || '').includes('/graphql') ? 'graphql' : 'core';
    let token = auth;
    if (hasDynamicAuth) {
      try { token = authProvider(); } catch { token = null; }
      token ||= String(options.headers?.authorization || '').replace(/^(?:token|bearer)\s+/i, '') || null;
      // Pin the token for both admission and the before hook. A refresh during
      // the asynchronous budget read must not charge one credential for another.
      requestTokens.set(options, token);
    }
    const credential = githubCredential({ token: token || null });
    await awaitThrottleIfNeeded(resource, credential);
    try {
      const response = await request(options);
      await recordResponseRateLimit({ ...extractRateLimitObservation(response.headers, { resource }), credential });
      return response;
    } catch (err) {
      const limited = isGitHubRateLimitError(err);
      const observation = extractRateLimitObservation(err?.response?.headers, { resource, rateLimited: limited });
      if (limited && !err.budgetDeferred) err.observation = await recordRateLimitedCall(resource, credential, observation);
      else if (observation) await recordResponseRateLimit({ ...observation, credential });
      throw err;
    }
  });
  return octokit;
}

export {
  createWatcherOctokit,
  fetchConditionalRestPage,
  getResponseHeader,
  responseStatus,
};
