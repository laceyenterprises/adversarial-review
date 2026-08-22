/**
 * ARF-09: end-to-end acceptance smoke.
 *
 * Boots the packaged standalone app through `arf up`, points it at a committed
 * review-state fixture and a local GitHub double, renders every shipped screen,
 * and drives the two standup surfaces over HTTP. No Agent OS daemon, broker,
 * launchd job, GitHub App, or live GitHub API is involved.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { testKeyPair } from './helpers/broker-fixtures.mjs';
import {
  APP_ID, BOT_LOGIN, TARGET_REPO, VERIFY_ISSUE, envSecretRefs, harnessSpec, mockGithubServer,
} from './helpers/standup-fixtures.mjs';
import { FIXTURE_PATH } from './fixtures/build-reviews-fixture.mjs';

// test -> server -> arf
const ARF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARF_BIN = join(ARF_ROOT, 'supervisor', 'bin', 'arf');

async function until(predicate, { timeoutMs = 15_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) {
      const label = typeof what === 'function' ? what() : what;
      assert.fail(`${label} not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function readSse(response) {
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const text = await response.text();
  return text.split('\n\n').filter((frame) => frame.trim() !== '').flatMap((frame) => {
    let event = 'message';
    const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length);
      else if (line.startsWith('data: ')) data.push(line.slice('data: '.length));
    }
    return data.length > 0 ? [{ event, data: JSON.parse(data.join('\n')) }] : [];
  });
}

async function fetchJson(baseUrl, path, init) {
  const res = await fetch(`${baseUrl}${path}`, init);
  const body = await res.json();
  return { res, body };
}

function pipelineFixture(root) {
  const pipelineRoot = join(root, 'pipeline');
  const dataDir = join(pipelineRoot, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(pipelineRoot, 'config.yaml'), [
    'review_cycle_cap: 4',
    'review_cycle_window_hours: 24',
    'roles:',
    '  adversarial:',
    '    merge_authority:',
    '      enabled: true',
    '      autonomous_merge_execution_enabled: false',
    '      strict_mode: true',
    '      strict_non_blocking_remediation: true',
    '',
  ].join('\n'), 'utf8');
  return pipelineRoot;
}

describe('ARF-09 end-to-end smoke', () => {
  let github;
  let stateRoot;
  let server;
  let baseUrl;
  let log = '';
  let env;

  after(async () => {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise((resolve) => server.once('exit', resolve));
    }
    if (github) await github.close();
    if (stateRoot) rmSync(stateRoot, { recursive: true, force: true });
    if (env?.HOME) rmSync(env.HOME, { recursive: true, force: true });
  });

  it('boots standalone, renders all screens, and completes dry standups against a mock GitHub', async () => {
    github = await mockGithubServer();
    stateRoot = mkdtempSync(join(tmpdir(), 'arf-e2e-smoke-'));

    const storePath = join(stateRoot, 'reviews.db');
    copyFileSync(FIXTURE_PATH, storePath);

    const binDir = join(stateRoot, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'claude'), '#!/bin/sh\necho "claude 1.4.2"\n', { mode: 0o755 });

    const { privateKeyRef, patFallbackRef } = envSecretRefs('_E2E');
    const rolesFile = join(stateRoot, 'roles.json');
    writeFileSync(rolesFile, `${JSON.stringify({
      roles: {
        'claude-reviewer': {
          provider: 'github_app',
          appId: APP_ID,
          installationId: '4155001',
          privateKeyRef,
        },
      },
    }, null, 2)}\n`, 'utf8');

    const configFile = join(stateRoot, 'config.json');
    writeFileSync(configFile, `${JSON.stringify({
      mode: 'standalone',
      stateRoot,
      storePath,
      pipelineRoot: pipelineFixture(stateRoot),
      host: '127.0.0.1',
      port: 0,
      githubApiBase: github.url,
      githubRequestTimeoutMs: 2000,
      githubMinRefreshIntervalMs: 0,
      broker: {
        mode: 'bundled',
        githubApiUrl: github.url,
        rolesFile,
        requestTimeoutMs: 2000,
        transientRetryAttempts: 1,
      },
      standup: {
        runtimeSearchPath: [binDir],
      },
    }, null, 2)}\n`, 'utf8');

    env = {
      PATH: '/usr/bin:/bin',
      HOME: mkdtempSync(join(tmpdir(), 'arf-e2e-home-')),
      ARF_CONFIG_FILE: configFile,
      ARF_STATE_ROOT: stateRoot,
      ARF_GITHUB_TOKEN: 'ghs_ARF_E2E_MIRROR_TOKEN',
      ARF_TEST_APP_KEY_E2E: testKeyPair().privateKeyPem,
      ARF_TEST_APP_PAT_E2E: process.env.ARF_TEST_APP_PAT_E2E,
    };

    server = spawn(process.execPath, [ARF_BIN, 'up'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.setEncoding('utf8');
    server.stderr.setEncoding('utf8');
    server.stdout.on('data', (chunk) => { log += chunk; });
    server.stderr.on('data', (chunk) => { log += chunk; });

    const serverLog = join(stateRoot, 'logs', 'arf-server.log');
    const port = await until(() => {
      if (!existsSync(serverLog)) return null;
      const match = readFileSync(serverLog, 'utf8').match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      return match ? match[1] : null;
    }, { what: () => `ARF server to listen (log: ${log})` });
    baseUrl = `http://127.0.0.1:${port}`;

    const shell = await fetch(`${baseUrl}/`);
    assert.equal(shell.status, 200);
    const shellHtml = await shell.text();
    assert.match(shellHtml, /Review dashboard/);
    assert.match(shellHtml, /Standup <span class="dim">›<\/span> Add remediator identity/);

    const dashboard = await fetchJson(baseUrl, '/v1/reviews/prs?limit=1');
    assert.equal(dashboard.res.status, 200);
    assert.equal(dashboard.body.store.available, true);
    assert.ok(dashboard.body.pullRequests.length > 0);
    for (const pr of dashboard.body.pullRequests) {
      assert.ok(pr.mirror, `PR #${pr.pr} has mirror data: ${JSON.stringify(dashboard.body.mirrorStats)}`);
      assert.match(pr.mirror.title, /\S/);
      assert.match(pr.mirror.builder, /\S/);
      assert.ok(pr.mirror.checks);
      assert.notEqual(pr.mirror.title, `PR #${pr.pr}`);
      assert.notEqual(pr.mirror.builder, '—');
    }

    const governancePage = await fetch(`${baseUrl}/pipeline/panel`);
    assert.equal(governancePage.status, 200);
    const governanceHtml = await governancePage.text();
    assert.match(governanceHtml, /data-path="hammer"/);
    assert.match(governanceHtml, /data-path="daemon-clean" data-state="disarmed"/);
    assert.match(governanceHtml, /enabled/);
    assert.match(governanceHtml, /autonomous_merge_execution_enabled/);
    assert.match(governanceHtml, />false<\/td>/);

    const harnessPage = await fetch(`${baseUrl}/ui/`);
    assert.equal(harnessPage.status, 200);
    assert.match(await harnessPage.text(), /Standup <span class="crumb">› Add harness<\/span>/);

    const identity = await fetch(`${baseUrl}/v1/standup/identity/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        role: 'the-hammer',
        appId: APP_ID,
        privateKeyRef,
        patFallbackRef,
        repos: [TARGET_REPO],
        verifyRepo: TARGET_REPO,
        verifyIssue: VERIFY_ISSUE,
      }),
    });
    assert.equal(identity.status, 200);
    const identityFrames = await readSse(identity);
    assert.equal(identityFrames.at(-1).event, 'complete');
    assert.equal(identityFrames.at(-1).data.outputs.attributedLogin, BOT_LOGIN);
    assert.ok(github.calls.some((call) => call.path === '/app'), 'mock saw App lookup');
    assert.ok(github.calls.some((call) => call.path.endsWith('/installation')), 'mock saw installation lookup');
    assert.ok(github.calls.some((call) => call.path.endsWith('/access_tokens')), 'mock saw token mint');
    assert.ok(github.calls.some((call) => call.path.endsWith('/comments')), 'mock saw verification post');

    const harness = await fetch(`${baseUrl}/api/standup/harness/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ dryRun: true, harness: harnessSpec() }),
    });
    assert.equal(harness.status, 200);
    const harnessFrames = await readSse(harness);
    assert.equal(harnessFrames.at(-1).event, 'run.done');
    assert.equal(harnessFrames.at(-1).data.status, 'ready');
    assert.equal(harnessFrames.at(-1).data.dryRun, true);
    assert.ok(harnessFrames.some((frame) => (
      frame.event === 'step.ok'
      && frame.data.step === 'wire-allowlist'
      && frame.data.detail.dryRun === true
    )));

    const failLoud = await fetch(`${baseUrl}/api/standup/harness/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dryRun: true,
        harness: harnessSpec({
          class: 'missing-role-reviewer',
          entitlement: 'missing-role-worker',
          botIdentity: { login: 'missing-role-reviewer', kind: 'github_app' },
          modelAuth: { mode: 'broker-oauth', brokerRole: 'missing-role' },
        }),
      }),
    });
    assert.equal(failLoud.status, 422);
    const loudBody = await failLoud.json();
    assert.equal(loudBody.status, 'failed');
    assert.equal(loudBody.failedStep, 'provision-model-auth');
    assert.match(loudBody.steps.find((step) => step.step === 'provision-model-auth').message, /no token mapping/i);
  });
});
