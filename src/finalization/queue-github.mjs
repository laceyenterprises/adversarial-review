import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildAllowlistedGhEnv } from '../gh-cli.mjs';
import { isGhAuthFailure } from '../github-auth-error.mjs';
import { meteredExecFile } from '../metered-gh.mjs';
import { withGitHubBudgetScope } from '../rate-limit-throttle.mjs';
import { fetchReviewerTokenFromBroker, resolveWatcherGhBrokerRole } from '../reviewer-broker-refresh.mjs';

const exec = promisify(execFile);
const text = value => typeof value === 'string' && !!value.trim();
const pageSize = 100;

export function createQueueGitHub({ env = process.env, mint = fetchReviewerTokenFromBroker, execFileImpl = exec,
  readWithHammerEntitlement = false, now = Date.now } = {}) {
  const role = resolveWatcherGhBrokerRole();
  const held = new Map();
  async function credential(repo, timeoutMs, signal, force = false) {
    signal?.throwIfAborted();
    if (!(timeoutMs > 0)) throw new Error('queue-github-deadline');
    const key = repo.toLowerCase();
    const prior = held.get(key);
    // An installation token is sufficient only while its broker-reported
    // lifetime covers the operation. Never fall back to ambient gh/PAT.
    if (!force && prior?.expiresAtMs > now() + timeoutMs + 60_000) return prior;
    let result;
    try {
      result = await mint({ role, env, repo, timeoutMs, force });
    } catch (error) {
      if (!force && error.transient === true && prior?.expiresAtMs > now() + timeoutMs) return prior;
      throw Object.assign(new Error('queue-credential-unavailable'), { authOutage: true });
    }
    if (!text(result?.token) || !(result.expiresAtMs > now() + timeoutMs)) {
      throw Object.assign(new Error('queue-credential-expiry-unavailable'), { authOutage: true });
    }
    signal?.throwIfAborted();
    held.set(key, result);
    return result;
  }
  const childEnv = token => ({
    ...buildAllowlistedGhEnv({ ...env, GITHUB_TOKEN: token, GH_TOKEN: token }),
    GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1',
  });
  async function get(repo, args, { timeoutMs, signal }) {
    const deadline = performance.now() + timeoutMs;
    const remaining = () => Math.floor(deadline - performance.now());
    const read = options => withGitHubBudgetScope({ urgent: false }, () => meteredExecFile(execFileImpl, 'gh',
      ['api', '--hostname', 'github.com', '--method', 'GET', ...args], {
        ...options, timeout: Math.max(1, remaining()), signal, killSignal: 'SIGKILL', maxBuffer: 12 * 1024 * 1024,
      }));
    if (readWithHammerEntitlement) {
      if (!['HAMMER_LACEY_GH_TOKEN', 'MERGE_AGENT_GH_TOKEN'].some(key => env[key] || env[`${key}_REFRESH_COMMAND`])
        && !env.HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND) throw new Error('queue-hammer-credential-unavailable');
      const clean = childEnv(null);
      delete clean.GH_TOKEN;
      return read({ hammerToken: true, env: clean, credentialEnv: env, credentialDeadlineMs: Date.now() + remaining() });
    }
    let token = (await credential(repo, remaining(), signal)).token;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      if (remaining() <= 0) throw new Error('queue-github-deadline');
      try {
        return await read({ env: childEnv(token), credentialEnv: { MERGE_AGENT_GH_TOKEN: token }, hammerToken: true });
      } catch (error) {
        if (!isGhAuthFailure(error)) throw error;
        held.delete(repo.toLowerCase());
        if (attempt) throw Object.assign(new Error('queue-credential-rejected'), { authOutage: true });
        token = (await credential(repo, remaining(), signal, true)).token;
      }
    }
  }
  function reader(repo, { timeoutMs, signal }) {
    const deadline = performance.now() + timeoutMs;
    return async path => JSON.parse((await get(repo, [path], { timeoutMs: deadline - performance.now(), signal })).stdout);
  }
  return { role, credential, childEnv, get, reader,
    async identity(repo, { timeoutMs, signal }) {
      const started = performance.now();
      const { token } = await credential(repo, timeoutMs, signal);
      const remaining = Math.floor(timeoutMs - (performance.now() - started));
      signal?.throwIfAborted();
      if (remaining <= 0) throw new Error('queue-identity-deadline');
      const { stdout } = await withGitHubBudgetScope({ urgent: false }, () => meteredExecFile(execFileImpl, 'gh',
        ['api', '--hostname', 'github.com', 'graphql', '-f', 'query={ viewer { login } }'], {
          env: childEnv(token), credentialEnv: { MERGE_AGENT_GH_TOKEN: token }, hammerToken: true,
          timeout: remaining, signal, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
        }));
      const { data, errors } = JSON.parse(stdout);
      const login = data?.viewer?.login;
      if (errors?.length || !/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(login ?? '')) return null;
      const actor = `${login.replace(/\[bot\]$/, '')}[bot]`;
      return { ok: true, login: actor, producerClass: 'ama-daemon', sourceRef: `github:viewer:${actor}:${repo}` };
    },
  };
}

// Preserve completeness even when GitHub returns an exact multiple of the page
// size. Reject repeated IDs and capped responses rather than certify a prefix.
export async function readQueueGitHubPages(read, path, { maxPages = 10 } = {}) {
  const items = [], ids = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const rows = await read(`${path}?per_page=${pageSize}&page=${page}`);
    if (!Array.isArray(rows) || rows.length > pageSize) throw new Error('queue-github-page-invalid');
    for (const row of rows) {
      if (row?.id != null && ids.has(row.id)) throw new Error('queue-github-page-moved');
      if (row?.id != null) ids.add(row.id);
      items.push(row);
    }
    if (rows.length < pageSize) return items;
  }
  throw new Error('queue-github-pages-incomplete');
}
