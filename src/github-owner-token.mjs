// Request-scoped GitHub authority. Home credentials and refresh clocks stay in
// reviewer-broker-refresh; owner tokens never enter the process environment.
import { readFileSync } from 'node:fs';
import { BROKER_REVIEWER_ROLES, fetchReviewerTokenFromBroker, fetchReviewerTokenFromBrokerSync,
  REVIEWER_TOKEN_REFRESH_SKEW_MS, REVIEWER_TOKEN_FALLBACK_TTL_MS } from './reviewer-broker-refresh.mjs';

export class GithubOwnerTokenUnavailableError extends Error {
  constructor(cause) {
    super('[github-auth-outage] github-owner-token-unavailable', { cause });
    this.code = 'github-owner-token-unavailable';
    this.failureClass = 'github-auth-outage';
    this.authOutage = true;
  }
}

export function githubTargetRepo(target) {
  if (Array.isArray(target)) {
    let repoTarget;
    const positional = [], fields = new Map();
    const valueFlags = new Set(['--body', '-b', '--body-file', '--title', '--head', '--base', '-B', '--label', '-l', '--assignee', '-a', '-r',
      '--reviewer', '--jq', '--template', '--json', '-q', '-t', '-H', '--header', '--hostname', '--method',
      '-X', '--input', '--search', '-S', '--author', '-f', '-F', '--field', '--raw-field']);
    for (let i = 0; i < target.length; i++) {
      const arg = String(target[i]);
      if (arg === '--repo' || arg === '-R') { repoTarget = target[++i]; continue; }
      if (arg.startsWith('--repo=')) { repoTarget = arg.slice(7); continue; }
      if (/^-R.+/.test(arg)) { repoTarget = arg.slice(2); continue; }
      if (valueFlags.has(arg)) {
        const value = String(target[++i]);
        if (['-f', '-F', '--field', '--raw-field'].includes(arg)) {
          const match = value.match(/^(owner|repo)=([^\s]+)$/);
          if (match) fields.set(match[1], match[2]);
        }
        continue;
      }
      positional.push(arg);
    }
    if (repoTarget !== undefined) return githubTargetRepo(repoTarget);
    for (const arg of positional) {
      if (/^(?:\/?repos\/|https:\/\/github\.com\/)/i.test(arg)) return githubTargetRepo(arg);
    }
    // Repository GraphQL reads name their target in typed request variables.
    if (positional.includes('graphql') && fields.has('owner') && fields.has('repo')) {
      return githubTargetRepo(`${fields.get('owner')}/${fields.get('repo')}`);
    }
    return null;
  }
  if (target && typeof target === 'object') {
    return (target.owner && target.repo ? githubTargetRepo(`${target.owner}/${target.repo}`) : null)
      || githubTargetRepo(target.url);
  }
  if (/^https:\/\/api\.github\.com\/(?!repos\/)/i.test(String(target || ''))) return null;
  // Bare API namespaces are routes too. Explicit /repos and GitHub web URLs
  // still allow repositories whose owner happens to match a namespace.
  if (/^\/?(?:orgs|users|gists|graphql|teams|licenses|emojis|meta|rate_limit)(?:[/?#]|$)/i.test(String(target || ''))) return null;
  const value = String(target || '').replace(/^https:\/\/(?:api\.)?github\.com\//i, '')
    .replace(/^\/?repos\//, '').replace(/^\//, '');
  const match = value.match(/^([a-z\d-]+)\/([a-z\d_.-]+)(?:[/?#]|$)/i);
  // API routes other than /repos are not repository slugs.
  if (/^\/(?!repos\/)/.test(String(target || '')) && !/^https:/i.test(String(target))) return null;
  const owner = normalizeOwner(match?.[1]);
  return owner && !['.', '..'].includes(match[2]) ? `${owner}/${match[2]}` : null;
}
export function githubTargetOwner(target) {
  const repo = githubTargetRepo(target);
  if (repo) return repo.split('/')[0];
  return target && !Array.isArray(target) && typeof target === 'object' ? normalizeOwner(target.owner) : null;
}
function normalizeOwner(owner) {
  const value = String(owner || '').toLowerCase();
  return /^[a-z\d](?:[a-z\d-]{0,38})$/.test(value) ? value : null;
}

const tokenIdentities = new Map();
export function recordGithubToken(token, identity) {
  tokenIdentities.set(token, identity);
}
export function githubTokenRole(token, env = process.env, tokenEnv) {
  const recorded = tokenIdentities.get(token);
  if (recorded) return recorded.role;
  const selected = tokenEnv || env.GITHUB_REVIEWER_TOKEN_ENV;
  return BROKER_REVIEWER_ROLES.find(entry => token
    && (env[entry.envVar] === token || (entry.envVar === selected && (!env[selected] || env[selected] === token))))?.role;
}

export function createGithubOwnerTokenSelector({
  readHomeOwner = () => JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')).org,
  mint = fetchReviewerTokenFromBroker,
  mintSync,
  now = Date.now,
} = {}) {
  let homeRead = false, homeOwner, homeError;
  const cache = new Map(), flights = new Map();
  function routedOwner(target) {
    const owner = githubTargetOwner(target);
    if (!owner) return null;
    if (!homeRead) {
      homeRead = true;
      try { homeOwner = normalizeOwner(readHomeOwner()); } catch (err) { homeError = err; }
    }
    if (homeError) throw new GithubOwnerTokenUnavailableError(homeError);
    return homeOwner && owner !== homeOwner ? owner : null;
  }
  function selection({ token, env = process.env, target, role, tokenEnv, requireSourceToken = true, minValidityMs = 0 }) {
    if (!Number.isSafeInteger(minValidityMs) || minValidityMs < 0) throw new TypeError('invalid owner token lifetime floor');
    const owner = routedOwner(target);
    if (!owner) return { token };
    // Child allowlists omit broker inputs and sometimes the reviewer alias.
    // Resolve with the Node process configuration, without forwarding it.
    env = { ...process.env, ...env };
    role ||= githubTokenRole(token, env, tokenEnv);
    if (!role) throw new GithubOwnerTokenUnavailableError();
    // Legacy clients must still observe source credential removal, including
    // when an owner token is cached. Only a declared broker-only read route
    // opts out; the broker still validates its explicit role and target owner.
    if (requireSourceToken && !token) throw new GithubOwnerTokenUnavailableError();
    const repo = githubTargetRepo(target);
    const key = `${role}@${repo?.toLowerCase() || owner}`;
    const cached = cache.get(key);
    return { token, env, owner, repo, role, key, minValidityMs, cached: cached && now() < cached.refreshAt
      && (!minValidityMs || cached.expiresAtMs - now() >= minValidityMs) ? cached : null };
  }
  function mintRequest({ key, role, owner, repo, env, minValidityMs }) {
    return { role, ...(repo ? { repo } : { owner }), env, force: cache.get(key)?.rejected === true || minValidityMs > 0 };
  }
  function store({ key, role, owner }, result) {
    if (!result.token || (result.expiresAtMs != null && result.expiresAtMs <= now())) throw new Error('expired owner token');
    cache.set(key, { token: result.token, expiresAtMs: result.expiresAtMs, refreshAt: result.expiresAtMs == null
      ? now() + REVIEWER_TOKEN_FALLBACK_TTL_MS : result.expiresAtMs - REVIEWER_TOKEN_REFRESH_SKEW_MS });
    recordGithubToken(result.token, { role, owner });
    return result.token;
  }
  function withRequiredLifetime({ key, minValidityMs }, token) {
    const cached = cache.get(key);
    if (minValidityMs > 0 && !(cached?.token === token && cached.expiresAtMs - now() >= minValidityMs)) {
      throw new GithubOwnerTokenUnavailableError(new Error('owner token lifetime insufficient for command'));
    }
    return token;
  }
  function sync(options) {
    const selected = selection(options);
    if (!selected.owner) return selected.token;
    if (selected.cached) return selected.cached.token;
    if (!mintSync) throw new GithubOwnerTokenUnavailableError();
    try { return withRequiredLifetime(selected, store(selected, mintSync(mintRequest(selected)))); }
    catch (err) { throw new GithubOwnerTokenUnavailableError(err); }
  }
  async function select(options) {
    const selected = selection(options);
    if (!selected.owner) return selected.token;
    if (selected.cached) return selected.cached.token;
    const { key } = selected;
    if (!flights.has(key)) {
      flights.set(key, Promise.resolve().then(async () => {
        try { return store(selected, await mint(mintRequest(selected))); }
        catch (err) { throw new GithubOwnerTokenUnavailableError(err); }
      }).finally(() => flights.delete(key)));
    }
    const token = await flights.get(key);
    // Each waiter owns its floor, including when it joins a shorter read's mint.
    // Unknown expiry cannot authorize a bounded, unrefreshable child run.
    return withRequiredLifetime(selected, token);
  }
  function invalidate(token) {
    const identity = tokenIdentities.get(token);
    if (!identity?.owner) return false;
    let invalidated = false;
    for (const [key, entry] of cache) {
      if (entry.token !== token) continue;
      cache.set(key, { rejected: true });
      invalidated = true;
    }
    return invalidated;
  }
  function remember(options, result) {
    const selected = selection(options);
    if (selected.owner) store(selected, result);
  }
  return { select, sync, routedOwner, invalidate, remember };
}
export const githubOwnerTokens = createGithubOwnerTokenSelector({ mintSync: fetchReviewerTokenFromBrokerSync });
export const githubTokenForTarget = options => githubOwnerTokens.select(options);

export function githubEnvForTarget(env, target, { tokenEnv, sync = false, token } = {}) {
  if (!githubOwnerTokens.routedOwner(target)) return env;
  token ??= tokenEnv ? env[tokenEnv] : env.GH_TOKEN || env.GITHUB_TOKEN;
  const options = { token, tokenEnv, env, target };
  const replace = selected => ({ ...env, GH_TOKEN: selected, GITHUB_TOKEN: selected, ...(tokenEnv ? { [tokenEnv]: selected } : {}) });
  return sync ? replace(githubOwnerTokens.sync(options)) : githubTokenForTarget(options).then(replace);
}

// Match authentication rejection only; 403 and rate-limit responses do not
// invalidate a valid installation token.
export function invalidateGithubOwnerTokenOnAuthFailure(error, token) {
  const detail = [error?.message, error?.stderr, error?.stdout].join('\n');
  return (error?.status === 401 || error?.response?.status === 401
    || /bad credentials|HTTP\s*401|401[^\n]*unauthorized|unauthorized[^\n]*401|authentication (?:failed|required)|token (?:has )?expired|requires authentication/i.test(detail))
    ? githubOwnerTokens.invalidate(token) : false;
}
