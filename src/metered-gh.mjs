// The only gh execution seam. GH_DEBUG captures headers even for high-level
// commands (and every page of --paginate) without changing stdout or exit codes.
// HTTP transcripts, which may contain bodies and credentials, never leave here.
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { awaitThrottleIfNeeded, extractRateLimitObservation, recordResponseRateLimit, resolveRateLimitSharedStatePath, resolveThrottleFloor, markGitHubRateLimited, recordRateLimitedCall, currentGitHubBudgetScope, GitHubBudgetDeferredError } from './rate-limit-throttle.mjs';

const execFileAsync = promisify(execFile);
const bridge = fileURLToPath(new URL('../bin/metered-gh.mjs', import.meta.url));

function ghResources(args) {
  if (args[0] === 'api') return [args.includes('graphql') ? 'graphql' : 'core'];
  // High-level commands can mix REST with GraphQL. Wait for both pools.
  return ['core', 'graphql'];
}

function parseGhDebug(stderr) {
  const observations = [];
  const retained = [];
  let inRequest = false;
  let headers = {};
  let rateLimited = false;
  let forbidden = false;
  let limitMessage = false;
  function flush() {
    const observation = extractRateLimitObservation(headers);
    if (observation) observations.push({ ...observation, rateLimited: rateLimited || (forbidden && (observation.remaining === 0 || limitMessage)) });
    headers = {};
    rateLimited = false;
    forbidden = false;
    limitMessage = false;
  }
  for (const line of String(stderr || '').split(/\r?\n/)) {
    if (/^\* Request at /.test(line)) { flush(); inRequest = true; }
    const header = line.match(/^< (x-ratelimit-[\w-]+):\s*(.*)$/i);
    if (header) headers[header[1].toLowerCase()] = header[2];
    if (/^< HTTP\/\S+ 429\b/.test(line)) rateLimited = true;
    if (/^< HTTP\/\S+ 403\b/.test(line)) forbidden = true;
    if (inRequest && /rate limit|too many requests/i.test(line)) limitMessage = true;
    if (/^\* Request took /.test(line)) { flush(); inRequest = false; continue; }
    if (!inRequest) retained.push(line);
  }
  flush();
  return { observations, stderr: retained.join('\n') };
}

function isRateLimitedError(err) {
  const detail = [err?.message, err?.stderr, err?.stdout, err?.response?.data?.message].join('\n');
  return err?.rateLimited === true || err?.status === 429 || /rate limit|too many requests|HTTP\s+429/i.test(detail);
}

function debugOptions(options = {}) {
  return { ...options, env: { ...(options.env || process.env), GHO_RATE_LIMIT_SHARED_STATE_PATH: process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH, GHO_RATE_LIMIT_THROTTLE_FLOOR: process.env.GHO_RATE_LIMIT_THROTTLE_FLOOR, GH_DEBUG: 'api' } };
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
  if (result && 'stderr' in result) result.stderr = parsed.stderr;
  if (limited) { result.rateLimited = true; markGitHubRateLimited(); }
  return limited;
}

async function finish(result, { failed = false, resource = 'core' } = {}) {
  const parsed = parseGhDebug(result?.stderr);
  const limited = responseRateLimited(result, parsed, failed);
  for (const observation of parsed.observations) await recordResponseRateLimit(observation);
  if (limited && !parsed.observations.length) await recordRateLimitedCall(resource);
  return result;
}

function meteredExecFile(execFileImpl = execFileAsync, command, args, options = {}) {
  if (command !== 'gh') return execFileImpl(command, args, options);
  return executeGh();
  async function executeGh() {
    for (const resource of ghResources(args)) await awaitThrottleIfNeeded(resource);
    try {
      return await finish(await execFileImpl(command, args, debugOptions(options)));
    } catch (err) {
      await finish(err, { failed: true, resource: args[0] === 'api' ? ghResources(args)[0] : 'graphql' });
      throw err;
    }
  }
}

function bridgeCall(action, payload) {
  return execFileSync(process.execPath, [bridge, action], {
    input: JSON.stringify(payload), encoding: 'utf8', env: process.env,
    maxBuffer: 1024 * 1024,
  });
}

function finishSync(result, { failed = false, resource = 'core' } = {}) {
  const parsed = parseGhDebug(result?.stderr);
  const limited = responseRateLimited(result, parsed, failed || Number(result?.status) > 0);
  if (parsed.observations.length) bridgeCall('record', parsed.observations);
  else if (limited) bridgeCall('limited', [resource]);
  return result;
}

function meteredExecFileSync(execFileImpl, command, args, options = {}) {
  if (command !== 'gh') return execFileImpl(command, args, options);
  let buckets = {};
  try { buckets = JSON.parse(readFileSync(resolveRateLimitSharedStatePath(), 'utf8')).buckets || {}; } catch { /* No observation yet. */ }
  const scope = currentGitHubBudgetScope();
  for (const resource of ghResources(args)) {
    const bucket = buckets[resource];
    if (scope?.rateLimited) throw new GitHubBudgetDeferredError(bucket || { resource, resetAt: null });
    if (bucket?.remaining < resolveThrottleFloor() && Date.parse(bucket.resetAt) > Date.now()) {
      if (scope?.urgent && bucket.remaining > 0) continue;
      if (scope) { scope.deferred = true; throw new GitHubBudgetDeferredError(bucket); }
      bridgeCall('wait', [resource]);
    }
  }
  try {
    // execFileSync normally returns only stdout. Capture stderr as well so all
    // successful responses are accounted for; injected executors keep their seam.
    if (execFileImpl === execFileSync) {
      const result = finishSync(spawnSync(command, args, { ...debugOptions(options), stdio: 'pipe' }));
      if (result.error || result.status !== 0) {
        const err = result.error || new Error(`Command failed: gh ${args.slice(0, 2).join(' ')}`);
        Object.assign(err, { stdout: result.stdout, stderr: result.stderr, status: result.status, signal: result.signal });
        throw err;
      }
      return result.stdout;
    }
    const result = execFileImpl(command, args, debugOptions(options));
    if (result && typeof result === 'object' && 'status' in result) finishSync(result);
    return result;
  } catch (err) {
    finishSync(err, { failed: true, resource: args[0] === 'api' ? ghResources(args)[0] : 'graphql' });
    throw err;
  }
}

export { ghResources, isRateLimitedError, meteredExecFile, meteredExecFileSync, parseGhDebug };
