import { createRequire } from 'node:module';

import { apiStatusFromError, recordApiCall } from './api-telemetry.mjs';
import {
  buildEtagCallKey,
  getCachedEtag,
  putCachedEtag,
} from './etag-cache.mjs';
import { awaitThrottleIfNeeded, recordResponseRateLimit } from './rate-limit-throttle.mjs';

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
    await awaitThrottleIfNeeded('core');
    return request(activeParams);
  }

  try {
    let response = await runRequest(requestParams);
    await recordResponseRateLimit({
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
    await recordResponseRateLimit({
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
  const octokit = octokitFactory({ auth });
  // When an authProvider is supplied, refresh the Authorization header on EVERY
  // request from the live token. The watcher is a long-lived process and its
  // octokit is constructed ONCE at startup; a GitHub App installation token
  // (broker-backed, ~1h life) snapshotted at construction would expire and 401
  // mid-run. Reading process.env.GITHUB_TOKEN per request (kept fresh by
  // refreshWatcherGithubToken) keeps the poll loop on a valid, rate-limit-
  // isolated App token without recreating the client. Fail-open: if the provider
  // yields nothing, leave the constructor auth in place.
  if (typeof authProvider === 'function' && octokit?.hook?.before) {
    octokit.hook.before('request', (options) => {
      let token;
      try {
        token = authProvider();
      } catch {
        token = null;
      }
      if (token) {
        options.headers = options.headers || {};
        options.headers.authorization = `token ${token}`;
      }
    });
  }
  return octokit;
}

export {
  createWatcherOctokit,
  fetchConditionalRestPage,
  getResponseHeader,
  responseStatus,
};
