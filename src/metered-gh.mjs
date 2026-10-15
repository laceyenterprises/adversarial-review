// The only gh execution seam. GH_DEBUG captures headers even for high-level
// commands (and every page of --paginate) without changing stdout or exit codes.
// HTTP transcripts, which may contain bodies and credentials, never leave here.
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  awaitThrottleIfNeeded, extractRateLimitObservation, recordResponseRateLimit,
  resolveRateLimitSharedStatePath, resolveThrottleFloor, markGitHubRateLimited,
  recordRateLimitedCall, currentGitHubBudgetScope, GitHubBudgetDeferredError,
  githubCredential, githubBudgetKey, scopedGitHubRateLimit,
} from './rate-limit-throttle.mjs';

const execFileAsync = promisify(execFile);
const bridge = fileURLToPath(new URL('../bin/metered-gh.mjs', import.meta.url));

function ghResources(args) {
  if (args[0] === 'api') return [args.includes('graphql') ? 'graphql' : 'core'];
  // High-level commands can mix REST with GraphQL. Wait for both pools.
  return ['core', 'graphql'];
}

function parseGhDebug(stderr, resource = 'core') {
  const observations = [];
  const retained = [];
  let inRequest = false;
  let diagnosticTail = [];
  let headers = {};
  let rateLimited = false;
  let forbidden = false;
  let limitMessage = false;
  function flush() {
    const observation = extractRateLimitObservation(headers, { resource, rateLimited: rateLimited || (forbidden && limitMessage) });
    if (observation) observations.push({ ...observation, rateLimited: rateLimited || (forbidden && (observation.remaining === 0 || limitMessage)) });
    headers = {};
    rateLimited = false;
    forbidden = false;
    limitMessage = false;
  }
  for (const line of String(stderr || '').split(/\r?\n/)) {
    if (/^\* Request at /.test(line)) {
      retained.push(...diagnosticTail);
      diagnosticTail = [];
      flush();
      inRequest = true;
    }
    const header = line.match(/^< (x-ratelimit-[\w-]+|retry-after):\s*(.*)$/i);
    if (header) headers[header[1].toLowerCase()] = header[2];
    if (/^< HTTP\/\S+ 429\b/.test(line)) rateLimited = true;
    if (/^< HTTP\/\S+ 403\b/.test(line)) forbidden = true;
    if (inRequest && /rate limit|too many requests/i.test(line)) limitMessage = true;
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
  return { observations, stderr: retained.join('\n') };
}

function isRateLimitedError(err) {
  const detail = [err?.message, err?.stderr, err?.stdout, err?.response?.data?.message].join('\n');
  return err?.rateLimited === true || err?.status === 429 || /rate limit|too many requests|HTTP\s+429/i.test(detail);
}

function debugOptions(options = {}) {
  const env = { ...(options.env || process.env), GH_DEBUG: 'api' };
  for (const key of ['GHO_RATE_LIMIT_SHARED_STATE_PATH', 'GHO_RATE_LIMIT_THROTTLE_FLOOR']) {
    if (options.env?.[key] === undefined && process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...options, env };
}

function responseRateLimited(result, parsed, failed) {
  // Successful PR bodies can discuss rate limits. Only actual API errors and
  // failed commands contribute to the resource failure count.
  let graphqlLimited = false;
  try {
    const text = String(result?.stdout || '').replace(/^HTTP\/[\s\S]*?\r?\n\r?\n/, '');
    const payload = JSON.parse(text);
    graphqlLimited = Array.isArray(payload.errors) && payload.errors.some(error =>
      error.type === 'RATE_LIMITED' || /rate limit|too many requests/i.test(error.message || ''));
  } catch { /* High-level commands need not produce JSON. */ }
  const limited = parsed.observations.some(observation => observation.rateLimited)
    || graphqlLimited || (failed && isRateLimitedError(result));
  if (limited && !parsed.observations.some(observation => observation.rateLimited) && parsed.observations.length) {
    parsed.observations.at(-1).rateLimited = true;
  }
  if (result?.message && result.stderr) result.message = result.message.replace(String(result.stderr), parsed.stderr);
  if (result && 'stderr' in result) {
    result.stderr = Buffer.isBuffer(result.stderr) ? Buffer.from(parsed.stderr) : parsed.stderr;
    if (Array.isArray(result.output)) result.output[2] = result.stderr;
  }
  if (limited) result.rateLimited = true;
  return limited;
}

async function finish(result, { failed = false, resource = 'core', credential = 'default' } = {}) {
  const parsed = parseGhDebug(result?.stderr, resource);
  const limited = responseRateLimited(result, parsed, failed);
  for (const observation of parsed.observations) await recordResponseRateLimit({ ...observation, credential });
  if (limited) {
    const observation = parsed.observations.findLast(item => item.rateLimited);
    // GraphQL errors can name a different pool from the command's fallback.
    result.observation = observation
      ? markGitHubRateLimited(observation.resource, credential, observation)
      : await recordRateLimitedCall(resource, credential);
  }
  return result;
}

function meteredExecFile(execFileImpl = execFileAsync, command, args, options = {}) {
  if (command !== 'gh') return execFileImpl(command, args, options);
  return executeGh();
  async function executeGh() {
    const credential = githubCredential({ env: options.env || process.env });
    const resource = args[0] === 'api' ? ghResources(args)[0] : 'graphql';
    for (const resource of ghResources(args)) await awaitThrottleIfNeeded(resource, credential);
    try {
      return await finish(await execFileImpl(command, args, debugOptions(options)), { credential, resource });
    } catch (err) {
      await finish(err, { failed: true, credential, resource });
      throw err;
    }
  }
}

function bridgeCall(action, payload, env) {
  return execFileSync(process.execPath, [bridge, action], {
    input: JSON.stringify(payload), encoding: 'utf8', env,
    maxBuffer: 1024 * 1024,
  });
}

function finishSync(result, { failed = false, resource = 'core', env, credential = githubCredential({ env }) } = {}) {
  const parsed = parseGhDebug(result?.stderr, resource);
  const limited = responseRateLimited(result, parsed, failed || Number(result?.status) > 0);
  if (parsed.observations.length) bridgeCall('record', parsed.observations.map(item => ({ ...item, credential })), env);
  if (limited) {
    const observation = parsed.observations.findLast(item => item.rateLimited);
    result.observation = markGitHubRateLimited(observation?.resource || resource, credential, observation || {});
    if (!observation) bridgeCall('limited', [{ resource, credential }], env);
  }
  return result;
}

function meteredExecFileSync(execFileImpl, command, args, options = {}) {
  if (command !== 'gh') return execFileImpl(command, args, options);
  const activeOptions = debugOptions(options);
  const { env } = activeOptions;
  const resource = args[0] === 'api' ? ghResources(args)[0] : 'graphql';
  let buckets = {};
  try { buckets = JSON.parse(readFileSync(resolveRateLimitSharedStatePath(env), 'utf8')).buckets || {}; } catch { /* No observation yet. */ }
  const scope = currentGitHubBudgetScope();
  const credential = githubCredential({ env });
  for (const resource of ghResources(args)) {
    const bucket = buckets[githubBudgetKey(resource, credential)];
    const limited = scopedGitHubRateLimit(resource, credential);
    if (limited) throw new GitHubBudgetDeferredError(limited);
    if (bucket?.remaining < resolveThrottleFloor(env) && Date.parse(bucket.resetAt) > Date.now()) {
      if (scope?.urgent && bucket.remaining > 0) continue;
      if (scope) { scope.deferred = true; throw new GitHubBudgetDeferredError(bucket); }
      bridgeCall('wait', [{ resource, credential }], env);
    }
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
    if (result && typeof result === 'object' && 'status' in result) finishSync(result, { env, resource });
    return result;
  } catch (err) {
    finishSync(err, { failed: true, resource, env });
    throw err;
  }
}

export { ghResources, isRateLimitedError, meteredExecFile, meteredExecFileSync, parseGhDebug };
