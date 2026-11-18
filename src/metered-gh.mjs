import { githubEnvForTarget, invalidateGithubOwnerTokenOnAuthFailure } from './github-owner-token.mjs';
import { withHammerGit, withHammerGitSync, withHammerToken, withHammerTokenSync } from './hammer-token.mjs';
import { readAdmissionChecks } from './watcher-admission-read-cache.mjs';
import { observeSynchronousChild } from './watcher-latency.mjs';
// The only gh execution seam. GH_DEBUG captures headers even for high-level
// commands (and every page of --paginate) without changing stdout or exit codes.
// HTTP transcripts, which may contain bodies and credentials, never leave here.
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { githubRequestCategory, recordApiCall, resolveDefaultApiCallRootDir } from './api-telemetry.mjs';
import {
  awaitThrottleIfNeeded, extractRateLimitObservation, recordResponseRateLimit,
  readGitHubBudgetBucketsSync, resolveThrottleFloor, markGitHubRateLimited,
  recordRateLimitedCall, currentGitHubBudgetScope, GitHubBudgetDeferredError,
  classifyGitHubRateLimit, isGitHubRateLimitError, githubCredential, githubBudgetKey, scopedGitHubRateLimit, githubBudgetBelowFloor, githubBudgetFloor,
} from './rate-limit-throttle.mjs';

const execFileAsync = promisify(execFile);
const bridge = fileURLToPath(new URL('../bin/metered-gh.mjs', import.meta.url));

// Fixed free endpoint only: this must bypass admission to avoid recursively
// waiting on the same exhausted bucket. All raw gh execution stays in this seam.
export async function readUnthrottledGitHubRateLimit(env) {
  const baseUrl = env.GITHUB_API_URL || env.GH_API_URL
    || (env.GH_HOST && env.GH_HOST !== 'github.com' ? `https://${env.GH_HOST}/api/v3` : null);
  const endpoint = baseUrl ? `${baseUrl.replace(/\/$/, '')}/rate_limit` : 'rate_limit';
  let result;
  let failure;
  try {
    result = await execFileAsync('gh', ['api', '--method', 'GET', '--include',
      '-H', 'User-Agent: adversarial-review', endpoint], {
      env: { ...env, GH_DEBUG: '' }, timeout: 15_000, maxBuffer: 1024 * 1024,
    });
  } catch (err) { result = err; failure = err; }
  const text = String(result.stdout || '');
  const boundary = text.search(/\r?\n\r?\n/);
  if (!text.startsWith('HTTP/') || boundary < 0) throw failure || new Error('Missing rate_limit response headers');
  const headerText = text.slice(0, boundary);
  const bodyText = text.slice(boundary).replace(/^\r?\n\r?\n/, '');
  const status = Number(headerText.match(/^HTTP\/\S+\s+(\d{3})/)?.[1]);
  const headers = Object.fromEntries(headerText.split(/\r?\n/).slice(1).map(line => {
    const colon = line.indexOf(':');
    return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
  }));
  recordApiCall({ category: 'github_request', status, extra: {
    credential: githubCredential({ env }), resource: 'core', requestCategory: 'rate_limit',
    unit: 'http_response', budgetExempt: true,
  } });
  let data;
  try { data = JSON.parse(bodyText); } catch { /* Headers still prove rate limits. */ }
  if (failure || !Number.isInteger(status) || status < 200 || status >= 300) throw Object.assign(new Error('confirmation response unavailable'), {
    status, response: { status, headers, data },
  });
  return { ...data?.resources,
    rawRateLimitHeaders: extractRateLimitObservation(headers)?.rawRateLimitHeaders };
}

function ghResources(args) {
  if (args[0] === 'api') return [args.includes('graphql') ? 'graphql' : 'core'];
  // High-level commands can mix REST with GraphQL. Wait for both pools.
  return ['core', 'graphql'];
}

function parseGhDebug(stderr, resource = 'core') {
  const observations = [];
  const requests = [];
  let httpStatus = null;
  const retained = [];
  let inRequest = false;
  let diagnosticTail = [];
  let headers = {};
  let inHeaders = false;
  let lastResponseRateLimit = null;
  let requestResource = resource;
  let requestCategory = 'other';
  let lastResponseResource = resource;
  function flush() {
    // GraphQL can report RATE_LIMITED with HTTP 200. Preserve only the last
    // response's reset hint until stdout/error classification is available.
    if (inRequest || Object.keys(headers).length) {
      lastResponseResource = headers['x-ratelimit-resource'] || requestResource;
      lastResponseRateLimit = extractRateLimitObservation(headers, { resource: requestResource, rateLimited: true, status: httpStatus, requestCategory });
    }
    const kind = classifyGitHubRateLimit({ status: httpStatus, headers });
    const observation = extractRateLimitObservation(headers, { resource: requestResource,
      rateLimited: Boolean(kind), kind, status: httpStatus, requestCategory });
    if (httpStatus !== null) requests.push({ status: httpStatus, resource: headers['x-ratelimit-resource'] || requestResource, requestCategory });
    if (observation) observations.push({ ...observation, requestCategory, rateLimited: Boolean(kind) });
    headers = {};
    httpStatus = null;
    inHeaders = false;
  }
  for (const line of String(stderr || '').split(/\r?\n/)) {
    if (/^\* Request at /.test(line)) {
      retained.push(...diagnosticTail);
      diagnosticTail = [];
      flush();
      inRequest = true;
      requestResource = resource;
      requestCategory = 'other';
    }
    const requestUrl = line.match(/^\* Request to https?:\/\/[^/]+(\/[^ ?#]*)/);
    if (requestUrl) {
      requestResource = requestUrl[1].includes('/graphql') ? 'graphql' : 'core';
      requestCategory = githubRequestCategory(requestUrl[1]);
    }
    const header = line.match(/^< (x-ratelimit-[\w-]+|retry-after):\s*(.*)$/i);
    const statusLine = httpStatus === null && inRequest ? line.match(/^< HTTP\/\S+ (\d{3})\b/) : null;
    if (statusLine) { httpStatus = Number(statusLine[1]); inHeaders = true; }
    if (inHeaders && line.trim() === '') inHeaders = false;
    if (header && inHeaders) headers[header[1].toLowerCase()] = header[2];
    if (/^\* Request took /.test(line)) {
      flush();
      diagnosticTail = [];
      inRequest = false;
      continue;
    }
    // A transport failure can terminate the trace without Request took. Keep
    // CLI/Go diagnostics (including their continuation lines), but do not expose
    // arbitrary unprefixed HTTP bodies by treating every non-header as stderr.
    // Buffer candidates until EOF so diagnostic-looking text in a completed
    // response body is still discarded with its envelope.
    if (inRequest && !/^[*<>] /.test(line) && (diagnosticTail.length || /^(?:gh: |(?:Get|Post|Put|Patch|Delete|Head|Options) "https?:\/\/[^"\r\n]+": |net\/http: |dial tcp |lookup |error\b|failed\b|TLS handshake\b|connection reset\b|network is unreachable\b|unexpected EOF\s*$|socket hang up\s*$)/i.test(line))) {
      diagnosticTail.push(line);
    }
    if (!inRequest) retained.push(line);
  }
  retained.push(...diagnosticTail);
  flush();
  return { observations, requests, stderr: retained.join('\n'), lastResponseRateLimit, lastResponseResource };
}

function recordRequests(parsed, credential) {
  for (const request of parsed.requests) recordApiCall({
    category: 'github_request', status: request.status,
    extra: { credential, resource: request.resource, requestCategory: request.requestCategory, unit: 'http_response',
      budgetExempt: request.status === 304 },
  });
}

function isRateLimitedError(err) {
  return isGitHubRateLimitError(err);
}

function debugOptions(options = {}) {
  const env = { ...(options.env || process.env), GH_DEBUG: 'api' };
  for (const key of ['GHO_RATE_LIMIT_SHARED_STATE_PATH', 'GHO_RATE_LIMIT_THROTTLE_FLOOR',
    'GHO_API_CALL_LOG_ROOT_DIR', 'GHO_API_CALL_LOG_DISABLE', 'GHO_API_CONSUMER']) {
    if (options.env?.[key] === undefined && process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Debug headers need a child-env copy; token sessions must retain the source
  // environment identity so successful refreshes survive subsequent calls.
  return { ...options, credentialEnv: options.credentialEnv || options.env || process.env, env };
}

function responseRateLimited(result, parsed, failed) {
  // Successful PR bodies can discuss rate limits. Only actual API errors and
  // failed commands contribute to the resource failure count.
  const limited = parsed.observations.some(observation => observation.rateLimited)
    || (failed && isRateLimitedError({ ...result, stderr: parsed.stderr }));
  if (limited && !parsed.observations.some(observation => observation.rateLimited) && parsed.lastResponseRateLimit) {
    const hint = parsed.lastResponseRateLimit;
    const last = parsed.observations.at(-1);
    if (last?.resource === hint.resource && last.resetAt === hint.resetAt) Object.assign(last, hint, { rateLimited: true });
    else parsed.observations.push({ ...hint, rateLimited: true });
  }
  if (result?.message && result.stderr) result.message = result.message.replace(String(result.stderr), parsed.stderr);
  if (result && 'stderr' in result) {
    result.stderr = Buffer.isBuffer(result.stderr) ? Buffer.from(parsed.stderr) : parsed.stderr;
    if (Array.isArray(result.output)) result.output[2] = result.stderr;
  }
  if (limited) {
    result.rateLimited = true;
    result.githubRateLimitKind = parsed.observations.findLast(item => item.rateLimited)?.kind || 'secondary';
  }
  return limited;
}

async function finish(result, { failed = false, resource = 'core', credential = 'default' } = {}) {
  if (result?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || result?.code === 'ENOBUFS') return result;
  const parsed = parseGhDebug(result?.stderr, resource);
  recordRequests(parsed, credential);
  const limited = responseRateLimited(result, parsed, failed);
  let recordedLimit;
  for (const observation of parsed.observations) {
    const recorded = await recordResponseRateLimit({ ...observation, credential });
    if (observation.rateLimited) recordedLimit = recorded;
  }
  if (limited) result.observation = recordedLimit || await recordRateLimitedCall(parsed.lastResponseResource, credential,
    extractRateLimitObservation({}, { resource: parsed.lastResponseResource, rateLimited: true }));
  return result;
}

function meteredExecFile(execFileImpl = execFileAsync, command, args, options = {}) {
  if (command !== 'gh') {
    if (command === 'git' && options.hammerToken) {
      return withHammerGit(active => execFileImpl(command, args, active), options);
    }
    return execFileImpl(command, args, options);
  }
  // Resolve refresh-only entitlements before cache keys or budget identities.
  // Retry the whole metered attempt so a renewed credential owns its telemetry.
  const prepared = debugOptions(options);
  return withHammerToken(async (active, session) => {
    if (!session.managed) {
      const env = await githubEnvForTarget(prepared.credentialEnv, args, { token: active.env.GH_TOKEN || active.env.GITHUB_TOKEN });
      if (env !== prepared.credentialEnv) active = { ...active, env: { ...active.env, GH_TOKEN: env.GH_TOKEN, GITHUB_TOKEN: env.GITHUB_TOKEN } };
    }
    return readAdmissionChecks(execFileImpl, command, args, active, () => executeGh(active, session));
  }, prepared);
  async function executeGh(active, session) {
    let credential = githubCredential({ env: active.env || process.env });
    const resource = args[0] === 'api' ? ghResources(args)[0] : 'graphql';
    let waited = false;
    for (const res of ghResources(args)) waited = await awaitThrottleIfNeeded(res, credential, { env: active.env || process.env }) || waited;
    if (waited && session.managed) {
      active = session.prepare();
      credential = githubCredential({ env: active.env });
    }
    try {
      return await finish(await execFileImpl(command, args, active), { credential, resource });
    } catch (err) {
      if (!session.managed && invalidateGithubOwnerTokenOnAuthFailure(err, active.env.GH_TOKEN || active.env.GITHUB_TOKEN)) err.ownerTokenRejected = true;
      await finish(err, { failed: true, credential, resource });
      throw err;
    }
  }
}

function bridgeCall(action, payload, env) {
  const logRoot = resolveDefaultApiCallRootDir({ ...process.env, ...env });
  env = { ...env, ...(logRoot ? { GHO_API_CALL_LOG_ROOT_DIR: logRoot } : { GHO_API_CALL_LOG_DISABLE: '1' }) };
  return execFileSync(process.execPath, [bridge, action], {
    input: JSON.stringify(payload), encoding: 'utf8', env,
    maxBuffer: 1024 * 1024,
  });
}

function finishSync(result, { failed = false, resource = 'core', env, credential = githubCredential({ env }) } = {}) {
  if (result?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || result?.code === 'ENOBUFS') return result;
  const parsed = parseGhDebug(result?.stderr, resource);
  recordRequests(parsed, credential);
  const limited = responseRateLimited(result, parsed, failed || Number(result?.status) > 0);
  const recorded = parsed.observations.length
    ? JSON.parse(bridgeCall('record', parsed.observations.map(item => ({ ...item, credential })), env)) : [];
  if (limited) {
    const index = parsed.observations.findLastIndex(item => item.rateLimited);
    const observation = index >= 0 ? recorded[index] : JSON.parse(bridgeCall('record', [{
      ...extractRateLimitObservation({}, { resource: parsed.lastResponseResource, rateLimited: true }), credential,
    }], env))[0];
    result.observation = markGitHubRateLimited(observation?.resource || parsed.lastResponseResource, credential, observation || {});
  }
  return result;
}

function meteredExecFileSync(execFileImpl, command, args, options = {}) {
  return observeSynchronousChild(command, () => executeFileSync(execFileImpl, command, args, options));
}

function executeFileSync(execFileImpl, command, args, options = {}) {
  if (command !== 'gh') {
    if (command === 'git' && options.hammerToken) {
      return withHammerGitSync(active => execFileImpl(command, args, active), options);
    }
    return execFileImpl(command, args, options);
  }
  const prepared = debugOptions(options);
  return withHammerTokenSync((active, session) => executeGhSync(execFileImpl, command, args, active, session, prepared.credentialEnv), prepared);
}

function executeGhSync(execFileImpl, command, args, activeOptions, session, credentialEnv) {
  if (!session.managed) {
    const env = githubEnvForTarget(credentialEnv, args, { sync: true, token: activeOptions.env.GH_TOKEN || activeOptions.env.GITHUB_TOKEN });
    if (env !== credentialEnv) activeOptions = { ...activeOptions, env: { ...activeOptions.env, GH_TOKEN: env.GH_TOKEN, GITHUB_TOKEN: env.GITHUB_TOKEN } };
  }
  let { env } = activeOptions;
  const resource = args[0] === 'api' ? ghResources(args)[0] : 'graphql';
  // Owner-aware (GHSTATEOWNER-01): the caller's own store plus a readable
  // shared store; an unreadable store contributes unknown, never a fake empty.
  const buckets = readGitHubBudgetBucketsSync({ env });
  const scope = currentGitHubBudgetScope();
  let credential = githubCredential({ env });
  let waited = false;
  for (const res of ghResources(args)) {
    let bucket = buckets[githubBudgetKey(res, credential)];
    const limited = scopedGitHubRateLimit(res, credential);
    if (limited) {
      const error = new GitHubBudgetDeferredError(limited, { credential });
      if (scope) scope.budgetDeferral = error;
      throw error;
    }
    if (scope?.operatorSafety) continue; // Never starved by the floor (NOMERGEHOLDHANG-01).
    // The floor is capped by the bucket's observed limit (WATCHERANONBUCKET-01).
    if (githubBudgetBelowFloor(bucket, resolveThrottleFloor(env)) && Math.max(Date.parse(bucket.resetAt), Date.parse(bucket.secondaryUntil || '') || 0) > Date.now()) {
      if (scope?.urgent && bucket.remaining > 0 && !(Date.parse(bucket.secondaryUntil || '') > Date.now())) continue;
      if (scope && Math.max(bucket.remaining != null && bucket.remaining < githubBudgetFloor(bucket, resolveThrottleFloor(env)) ? Date.parse(bucket.resetAt) : 0, Date.parse(bucket.secondaryUntil || '') || 0) - Date.now() > 120_000) {
        const checked = JSON.parse(bridgeCall('admit', [{ resource: res, credential }], env));
        if (!checked.deferred) continue;
        bucket = checked.observation;
      }
      if (scope) {
        scope.deferred = true;
        const error = new GitHubBudgetDeferredError(bucket, { credential, floor: githubBudgetFloor(bucket, resolveThrottleFloor(env)) });
        scope.budgetDeferral = error;
        throw error;
      }
      bridgeCall('wait', [{ resource: res, credential }], env);
      waited = true;
    }
  }
  if (waited && session.managed) {
    activeOptions = session.prepare();
    env = activeOptions.env;
    credential = githubCredential({ env });
  }
  try {
    // execFileSync normally returns only stdout. Capture stderr as well so all
    // successful responses are accounted for; injected executors keep their seam.
    if (execFileImpl === execFileSync) {
      const result = spawnSync(command, args, { ...activeOptions, stdio: 'pipe' });
      if (result.error || result.status !== 0) {
        const err = result.error || new Error(`Command failed: gh ${args.slice(0, 2).join(' ')}`);
        Object.assign(err, { stdout: result.stdout, stderr: result.stderr, status: result.status, signal: result.signal });
        throw err;
      }
      return finishSync(result, { env, resource }).stdout;
    }
    const result = execFileImpl(command, args, activeOptions);
    if (result && typeof result === 'object' && 'status' in result) {
      if (!session.managed && result.status !== 0) invalidateGithubOwnerTokenOnAuthFailure(result, env.GH_TOKEN || env.GITHUB_TOKEN);
      finishSync(result, { env, resource });
    }
    return result;
  } catch (err) {
    if (!session.managed) invalidateGithubOwnerTokenOnAuthFailure(err, env.GH_TOKEN || env.GITHUB_TOKEN);
    finishSync(err, { failed: true, resource, env });
    throw err;
  }
}

export { ghResources, isRateLimitedError, meteredExecFile, meteredExecFileSync, parseGhDebug };
