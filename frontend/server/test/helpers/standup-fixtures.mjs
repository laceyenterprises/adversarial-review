/**
 * Fixtures for the identity standup tests (ARF-05).
 *
 * The GitHub double here is deliberately a *router* over real URLs rather than a
 * queue of canned responses. A queue asserts the order calls happen in, which is
 * an implementation detail; a router asserts what was asked for, which is the
 * contract. It also means a test can make one endpoint behave badly — a 404 from
 * the installation lookup, a `User` attribution on a comment — without having to
 * restate every other response around it.
 *
 * Every call is recorded, which is what the fail-loud test needs: proving a run
 * did **not** post is only possible if you can see everything it did do.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../../src/config.mjs';
import { SecretValue } from '../../src/broker/secrets.mjs';
import { testKeyPair } from './broker-fixtures.mjs';

export const APP_ID = '887';
export const APP_SLUG = 'the-hammer';
export const BOT_LOGIN = 'the-hammer[bot]';
export const INSTALLATION_ID = '4155001';
export const TARGET_REPO = 'laceyenterprises/agent-os';
export const VERIFY_ISSUE = 5543;
export const PRIVATE_KEY_REF = 'op://Vault/hammer-key/private key';
export const PAT_REF = 'op://Vault/hammer-pat/credential';
export const MINTED_TOKEN = 'ghs_STANDUP_TEST_TOKEN_do_not_leak_0007';
export const COMMENT_URL = `https://github.com/${TARGET_REPO}/pull/${VERIFY_ISSUE}#issuecomment-1`;

export function tmpStateRoot() {
  return mkdtempSync(join(tmpdir(), 'arf-standup-'));
}

/** A resolver over the fixture keypair + PAT. Records the refs it was asked for. */
export function standupSecretResolver(extra = {}) {
  const table = {
    [PRIVATE_KEY_REF]: testKeyPair().privateKeyPem,
    [PAT_REF]: 'ghp_STANDUP_TEST_PAT_do_not_leak_0008',
    ...extra,
  };
  const seen = [];
  const resolve = async (ref) => {
    const key = String(ref);
    seen.push(key);
    if (!(key in table)) throw new Error(`test resolver has no value for ${key}`);
    return new SecretValue(table[key], key);
  };
  resolve.seen = seen;
  return resolve;
}

function response(status, body) {
  const text = JSON.stringify(body ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

/**
 * A `fetch` double routing the four GitHub calls a standup makes.
 *
 * @param {object} [overrides]
 * @param {boolean} [overrides.installed]   whether the App is installed on the repo
 * @param {string}  [overrides.installationId]
 * @param {object}  [overrides.commentUser] the `user` block the comment POST returns
 * @param {boolean} [overrides.readyz]      external-mode readiness answer
 * @param {Function} [overrides.handler]    escape hatch for a bespoke case
 */
export function githubDouble({
  installed = true,
  installationId = INSTALLATION_ID,
  commentUser = { login: BOT_LOGIN, type: 'Bot' },
  readyz = true,
  handler = null,
} = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    const target = String(url);
    calls.push({ url: target, method, init });

    if (handler) {
      const custom = await handler(target, init);
      if (custom) return custom;
    }

    if (target.endsWith('/app') && method === 'GET') {
      return response(200, { id: Number(APP_ID), slug: APP_SLUG, name: 'The Hammer', owner: { login: 'laceyenterprises' } });
    }
    if (target.includes('/installation') && target.includes('/repos/') && method === 'GET') {
      return installed
        ? response(200, { id: Number(installationId), account: { login: 'laceyenterprises' } })
        : response(404, { message: 'Not Found' });
    }
    if (target.includes('/access_tokens') && method === 'POST') {
      return response(201, {
        token: MINTED_TOKEN,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: { contents: 'write', pull_requests: 'write' },
      });
    }
    if (target.includes('/issues/') && target.endsWith('/comments') && method === 'POST') {
      return response(201, { id: 1, html_url: COMMENT_URL, user: commentUser });
    }
    if (target.endsWith('/readyz')) {
      return response(readyz ? 200 : 503, { ok: readyz, can_serve: readyz, status: readyz ? 'ready' : 'draining' });
    }
    return response(404, { message: `unrouted ${method} ${target}` });
  };
  impl.calls = calls;
  /** Every call whose URL matches, for "did it ever post?" assertions. */
  impl.matching = (fragment) => calls.filter((call) => call.url.includes(fragment));
  return impl;
}

/**
 * Build a config whose broker maps `role`, or maps nothing at all.
 *
 * @param {object} options
 * @param {string} options.stateRoot
 * @param {object|null} [options.roles] role map to write into a rolesFile
 * @param {boolean} [options.withRolesFile] configure `broker.rolesFile` at all —
 *   `false` is the "ARF has nowhere to record a mapping" case
 */
export function standupConfig({ stateRoot, roles = null, withRolesFile = true, broker = {} }) {
  const rolesFile = join(stateRoot, 'roles.json');
  if (roles) writeFileSync(rolesFile, `${JSON.stringify({ roles }, null, 2)}\n`, 'utf8');

  const configFile = join(stateRoot, 'config.json');
  writeFileSync(configFile, `${JSON.stringify({
    mode: 'standalone',
    stateRoot,
    broker: {
      mode: 'bundled',
      ...(withRolesFile ? { rolesFile } : {}),
      // Retries off: these tests assert classification and refusal, and a
      // bounded backoff around a deterministic double only adds wall-clock.
      transientRetryAttempts: 1,
      ...broker,
    },
  }, null, 2)}\n`, 'utf8');

  const env = { ARF_CONFIG_FILE: configFile, ARF_STATE_ROOT: stateRoot };
  return {
    configFile,
    rolesFile,
    env,
    load: () => loadConfig({ env }),
    config: loadConfig({ env }),
  };
}

/**
 * A real HTTP server answering the GitHub calls a standup makes.
 *
 * The `fetch` double above is enough for the machine-level tests, but the
 * end-to-end SSE case needs the *real* transport — ARF's own `fetch`, its
 * timeouts, its capped body reads — so it gets a real socket to talk to instead.
 * Without this the server-level test would either reach api.github.com or need a
 * test-only injection seam in `createArfServer`, and neither is worth having.
 *
 * @returns {Promise<{url: string, calls: object[], close: Function}>}
 */
export async function mockGithubServer({ commentUser = { login: BOT_LOGIN, type: 'Bot' } } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://mock.invalid').pathname;
    const call = { method: req.method, path, body: '' };
    calls.push(call);

    const send = (status, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': '1786000000',
      });
      res.end(payload);
    };

    req.setEncoding('utf8');
    req.on('data', (chunk) => { call.body += chunk; });
    req.on('end', () => {
      if (path === '/app') {
        send(200, { id: Number(APP_ID), slug: APP_SLUG, name: 'The Hammer', owner: { login: 'laceyenterprises' } });
      } else if (path.endsWith('/installation')) {
        send(200, { id: Number(INSTALLATION_ID), account: { login: 'laceyenterprises' } });
      } else if (path.endsWith('/access_tokens')) {
        send(201, {
          token: MINTED_TOKEN,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: { contents: 'write' },
        });
      } else if (path.endsWith('/comments')) {
        send(201, { id: 1, html_url: COMMENT_URL, user: commentUser });
      } else if (path === '/repos/laceyenterprises/agent-os/pulls/5543') {
        send(200, {
          number: 5543,
          title: '[claude-code] (feat) ARF-09 acceptance smoke',
          state: 'open',
          draft: false,
          merged: false,
          mergeable: null,
          mergeable_state: 'blocked',
          html_url: 'https://github.com/laceyenterprises/agent-os/pull/5543',
          user: { login: 'agent-os-builder[bot]', type: 'Bot' },
          head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
          base: { ref: 'main' },
          labels: [{ name: 'adversarial-review' }, { name: 'agent-built' }],
        });
      } else if (path === '/repos/laceyenterprises/agent-os/pulls/5541') {
        send(200, {
          number: 5541,
          title: '[codex] ROS-02 send-turn + reply stream',
          state: 'closed',
          draft: false,
          merged: true,
          mergeable: null,
          mergeable_state: 'clean',
          html_url: 'https://github.com/laceyenterprises/agent-os/pull/5541',
          user: { login: 'agent-os-codex[bot]', type: 'Bot' },
          head: { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
          base: { ref: 'main' },
          labels: [],
        });
      } else if (path === '/repos/laceyenterprises/agent-os/pulls/5543/reviews') {
        send(200, [{
          id: 900001,
          user: { login: 'agent-os-reviewer[bot]', type: 'Bot' },
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-08-16T10:20:00Z',
          body: '## Verdict\n\nRequest changes.\n\n## Blocking issues\n\n- **Store adapter opens a writable handle**\n',
          html_url: 'https://github.com/laceyenterprises/agent-os/pull/5543#pullrequestreview-900001',
        }]);
      } else if (path === '/repos/laceyenterprises/agent-os/pulls/5541/reviews') {
        send(200, [{
          id: 900003,
          user: { login: 'agent-os-reviewer[bot]', type: 'Bot' },
          state: 'APPROVED',
          submitted_at: '2026-08-15T09:50:00Z',
          body: '## Verdict\n\nApproved.\n',
          html_url: 'https://github.com/laceyenterprises/agent-os/pull/5541#pullrequestreview-900003',
        }]);
      } else if (path === '/repos/laceyenterprises/agent-os/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/check-runs') {
        send(200, {
          total_count: 2,
          check_runs: [
            { name: 'repo-guards', status: 'completed', conclusion: 'success', html_url: 'https://github.com/checks/1' },
            { name: 'tests', status: 'in_progress', conclusion: null, html_url: 'https://github.com/checks/2' },
          ],
        });
      } else if (path === '/repos/laceyenterprises/agent-os/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/check-runs') {
        send(200, {
          total_count: 1,
          check_runs: [
            { name: 'repo-guards', status: 'completed', conclusion: 'success', html_url: 'https://github.com/checks/4' },
          ],
        });
      } else if (path === '/repos/laceyenterprises/agent-os/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/status') {
        send(200, {
          state: 'success',
          statuses: [
            { context: 'legacy/ci', state: 'success', target_url: 'https://ci/1', updated_at: '2026-08-16T10:10:00Z' },
          ],
        });
      } else if (path === '/repos/laceyenterprises/agent-os/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/status') {
        send(200, {
          state: 'success',
          statuses: [
            { context: 'tests', state: 'success', target_url: 'https://ci/2', updated_at: '2026-08-15T09:45:00Z' },
          ],
        });
      } else if (path === '/repos/laceyenterprises/agent-os/branches/main/protection/required_status_checks') {
        send(200, { contexts: ['repo-guards', 'tests'] });
      } else {
        send(404, { message: `unrouted ${req.method} ${path}` });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Install the fixture keypair and PAT into the environment, and return `env:`
 * references to them.
 *
 * `env:` is a first-class secret-ref scheme (SPEC §7 — the standalone path for an
 * install with no 1Password), so an end-to-end test using it exercises a real
 * supported configuration rather than a stub. It also means the test never
 * spawns the `op` subprocess.
 */
export function envSecretRefs(suffix = '') {
  const keyVar = `ARF_TEST_APP_KEY${suffix}`;
  const patVar = `ARF_TEST_APP_PAT${suffix}`;
  process.env[keyVar] = testKeyPair().privateKeyPem;
  process.env[patVar] = 'ghp_STANDUP_ENV_PAT_do_not_leak_0009';
  return { privateKeyRef: `env:${keyVar}`, patFallbackRef: `env:${patVar}` };
}

/** A fully-specified standup request against the doubles above. */
export function standupParams(overrides = {}) {
  return {
    role: 'the-hammer',
    appId: APP_ID,
    privateKeyRef: PRIVATE_KEY_REF,
    patFallbackRef: PAT_REF,
    repos: [TARGET_REPO],
    verifyRepo: TARGET_REPO,
    verifyIssue: VERIFY_ISSUE,
    ...overrides,
  };
}

/** The mapping a wired `the-hammer` has, for tests that start already-mapped. */
export function mappedRoles(overrides = {}) {
  return {
    'the-hammer': {
      provider: 'github_app',
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      privateKeyRef: PRIVATE_KEY_REF,
      ...overrides,
    },
  };
}

/** Drain an event generator into an array. */
export async function collect(events) {
  const out = [];
  for await (const event of events) out.push(event);
  return out;
}

/** Frames of one kind, in order. */
export function framesOf(events, name) {
  return events.filter((event) => event.event === name).map((event) => event.data);
}

/** The last status each step reported, keyed by step id. */
export function finalStepStatuses(events) {
  const statuses = new Map();
  for (const frame of framesOf(events, 'step')) statuses.set(frame.id, frame.status);
  return Object.fromEntries(statuses);
}

/** A config rooted at a throwaway state root, with optional extra env. */
export function testConfig(env = {}) {
  const stateRoot = env.ARF_STATE_ROOT ?? tmpStateRoot();
  return loadConfig({ env: { ARF_STATE_ROOT: stateRoot, ARF_PORT: '0', ...env } });
}

/**
 * Write an ARF config file and return the env that points at it. Nested config
 * (`broker.roles`, `standup.runtimeSearchPath`) has no env form by design, so
 * anything exercising those goes through a real file — the same path an operator
 * uses.
 */
export function withConfigFile(stateRoot, config) {
  mkdirSync(stateRoot, { recursive: true });
  const path = join(stateRoot, 'config.json');
  writeFileSync(path, JSON.stringify(config, null, 2));
  return { ARF_STATE_ROOT: stateRoot, ARF_CONFIG_FILE: path, ARF_PORT: '0' };
}

/**
 * Drop an executable file into a directory so `resolveExecutable` can find it.
 * The probe resolves binaries against the filesystem for real — that is the
 * behaviour worth testing — so the fixture has to be a real executable file.
 */
export function fakeBinary(dir, name, body = '#!/bin/sh\necho "fake 1.2.3"\n') {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

/** A minimal valid reviewer harness spec, broker-OAuth by default. */
export function harnessSpec(overrides = {}) {
  return {
    class: 'claude-reviewer',
    kind: 'reviewer',
    entitlement: 'claude-reviewer-worker',
    allowedModels: ['claude-opus-5', 'claude-sonnet-5'],
    defaultModel: 'claude-opus-5',
    botIdentity: { login: 'claude-reviewer', kind: 'github_app' },
    modelAuth: { mode: 'broker-oauth', brokerRole: 'claude-reviewer' },
    runtime: { command: 'claude' },
    ...overrides,
  };
}

/**
 * A stand-in for the ARF-07 broker that records what was asked of it.
 *
 * `resolveToken` returns a grant shaped exactly like the real one's redacted
 * projection, so the wizard cannot be passing tests against a shape the real
 * broker does not produce.
 */
export function fakeBroker({ roles = ['claude-reviewer'], mode = 'bundled' } = {}) {
  const calls = [];
  return {
    calls,
    mode,
    hasRole(role) {
      calls.push({ call: 'hasRole', role });
      return roles.includes(role);
    },
    async resolveToken(role) {
      calls.push({ call: 'resolveToken', role });
      if (!roles.includes(role)) {
        const err = new Error(`no token mapping for role ${JSON.stringify(role)}`);
        err.code = 'unmapped_role';
        throw err;
      }
      return {
        role,
        mode,
        provider: 'github_app',
        credentialSource: 'github_app_installation',
        tokenType: 'github_app_installation',
        fingerprint: 'abc123def456',
        expiresAt: Math.round(Date.now() / 1000) + 3600,
        secretRefs: ['op://Vault/item/private key'],
      };
    },
    describe() {
      calls.push({ call: 'describe' });
      return { mode, configured: roles.length > 0, roles: roles.map((role) => ({ role, provider: 'github_app' })) };
    },
  };
}

/**
 * A broker that fails on contact.
 *
 * Used to assert the negative: a standalone-token run must complete without
 * touching a broker at all, so any call this object sees fails the test rather
 * than being quietly satisfied.
 */
export function forbiddenBroker(label = 'the in-OS broker') {
  const explode = (call) => () => {
    throw new Error(`${label} was contacted (${call}) during a standalone-token run`);
  };
  return {
    get mode() { return explode('mode')(); },
    hasRole: explode('hasRole'),
    resolveToken: explode('resolveToken'),
    describe: explode('describe'),
  };
}

/** A secret resolver over an in-memory ref -> value map. */
export function fakeSecretResolver(values) {
  return async function resolveSecret(ref) {
    const key = typeof ref === 'string' ? ref : ref.raw;
    if (!(key in values)) {
      const err = new Error(`secret ref ${key} is not set in this fixture`);
      err.code = 'secret_ref';
      throw err;
    }
    return new SecretValue(values[key], key);
  };
}

/**
 * An `execFile` stand-in.
 *
 * @param {Record<string, {stdout?: string, stderr?: string, error?: object}>} responses
 *   keyed by the command's basename
 */
export function fakeExecFile(responses) {
  const calls = [];
  const impl = (command, args, options, callback) => {
    calls.push({ command, args });
    const key = String(command).split('/').pop();
    const response = responses[key];
    if (!response) {
      const err = new Error(`spawn ${command} ENOENT`);
      err.code = 'ENOENT';
      setImmediate(() => callback(err, '', ''));
      return;
    }
    setImmediate(() => callback(
      response.error ?? null,
      response.stdout ?? '',
      response.stderr ?? '',
    ));
  };
  impl.calls = calls;
  return impl;
}
