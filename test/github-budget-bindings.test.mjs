import './helpers/rate-limit-state-isolation.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBudgetBinding, writeBudgetBinding } from '../src/github-budget-bindings.mjs';
import { createRateLimitThrottle, githubCredential, registerGitHubInstallationToken, resolveBudgetBindingDirectory } from '../src/rate-limit-throttle.mjs';

const previousLogDisable = process.env.GHO_API_CALL_LOG_DISABLE;
process.env.GHO_API_CALL_LOG_DISABLE = '1';
after(() => {
  if (previousLogDisable === undefined) delete process.env.GHO_API_CALL_LOG_DISABLE;
  else process.env.GHO_API_CALL_LOG_DISABLE = previousLogDisable;
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'budget-binding-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a fresh process resolves broker bindings for status and zero-balance admission', async t => {
  const dir = fixture(t);
  const statePath = join(dir, 'data', 'api-cache', 'rate-limit-state.json');
  const env = { ...process.env, GHO_RATE_LIMIT_SHARED_STATE_PATH: statePath,
    GH_TOKEN: 'synthetic-bound-token', GITHUB_TOKEN: '', GHO_API_CALL_LOG_DISABLE: '1' };
  registerGitHubInstallationToken(env.GH_TOKEN, '12', '34', { env });
  registerGitHubInstallationToken('synthetic-rotated-token', '12', '34', { env });
  const throttle = createRateLimitThrottle({ env, recordApiCallImpl() {} });
  await throttle.recordResponseRateLimit({ resource: 'core', credential: 'installation-12-34',
    remaining: 0, resetAt: Date.now() + 60_000 });
  const moduleUrl = new URL('../src/rate-limit-throttle.mjs', import.meta.url).href;
  const apiUrl = new URL('../src/github-api.mjs', import.meta.url).href;
  const ghCliUrl = new URL('../src/gh-cli.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { githubCredential, readGitHubBudgetStatus, createRateLimitThrottle,
      withCloserGitHubBudget } from ${JSON.stringify(moduleUrl)};
    import { __test__ as api } from ${JSON.stringify(apiUrl)};
    import { buildAllowlistedGhEnv } from ${JSON.stringify(ghCliUrl)};
    assert.equal(githubCredential(), 'installation-12-34');
    assert.equal(githubCredential({ env: { GH_TOKEN: process.env.GH_TOKEN } }), 'installation-12-34');
    for (const env of [api.buildGhEnv(), buildAllowlistedGhEnv()]) {
      assert.equal(env.GHO_RATE_LIMIT_SHARED_STATE_PATH, undefined);
      assert.equal(githubCredential({ env }), 'installation-12-34');
    }
    assert.equal(githubCredential({ env: {} }), 'default');
    assert.equal(githubCredential({ token: 'synthetic-rotated-token' }), 'installation-12-34');
    assert.match(githubCredential({ token: 'synthetic-foreign-token' }), /^token-/);
    assert.equal(readGitHubBudgetStatus().core.remaining, 0);
    assert.equal(readGitHubBudgetStatus({ rootDir: ${JSON.stringify(dir)},
      env: { GH_TOKEN: process.env.GH_TOKEN } }).core.remaining, 0);
    assert.match(githubCredential({ env: { GH_TOKEN: process.env.GH_TOKEN,
      GHO_RATE_LIMIT_SHARED_STATE_PATH: ${JSON.stringify(join(dir, 'unrelated.json'))} } }), /^token-/);
    const throttle = createRateLimitThrottle({ recordApiCallImpl() {} });
    await withCloserGitHubBudget(async () => {
      await assert.rejects(throttle.awaitThrottleIfNeeded('core', githubCredential()),
        { budgetDeferred: true });
    });
    console.log('ok');
  `;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { env, encoding: 'utf8' }).trim(), 'ok');
  for (const name of readdirSync(`${statePath}.bindings`)) {
    const file = join(`${statePath}.bindings`, name);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /synthetic-/);
  }
});

test('bindings expire, reject malformed identity and digest substitution, and prune expired rotation files', t => {
  const directory = fixture(t);
  const digest = createHash('sha256').update('fixture').digest('hex').slice(0, 24);
  const other = 'b'.repeat(24);
  const now = Date.now();
  const failOnRead = () => assert.fail('an unchanged binding should reuse its parsed record');
  writeBudgetBinding(directory, digest, 'installation-12-34', now + 1000, now);
  assert.equal(readBudgetBinding(directory, digest, now), 'installation-12-34');
  assert.equal(readBudgetBinding(directory, digest, now + 1, { readFileSyncImpl: failOnRead }), 'installation-12-34');
  writeBudgetBinding(directory, digest, 'installation-56-78', now + 1000, now + 1);
  assert.equal(readBudgetBinding(directory, digest, now + 2), 'installation-56-78');
  assert.equal(readBudgetBinding(directory, digest, now + 1000), null);
  writeBudgetBinding(directory, other, 'installation-12-34', now + 10_000, now + 1001);
  assert.equal(readdirSync(directory).includes(`${digest}.json`), false);
  writeFileSync(join(directory, `${digest}.json`), JSON.stringify({
    digest: other, credential: 'installation-12-34', expiresAt: now + 1000,
  }));
  assert.equal(readBudgetBinding(directory, digest, now), null);
  writeBudgetBinding(directory, digest, 'token-invalid', now + 1000, now);
  assert.equal(readBudgetBinding(directory, digest, now), null);
  assert.equal(readBudgetBinding(directory, '../invalid', now), null);
});

test('an unavailable binding store leaves a successful registration usable in its process', t => {
  const dir = fixture(t);
  const file = join(dir, 'not-a-directory');
  writeFileSync(file, 'fixture');
  const env = { GHO_RATE_LIMIT_SHARED_STATE_PATH: join(file, 'budget.json') };
  assert.doesNotThrow(() => registerGitHubInstallationToken('synthetic-unwritable', '12', '34', { env }));
  assert.equal(githubCredential({ env, token: 'synthetic-unwritable' }), 'installation-12-34');
});

test('bindings select separate stores for the canonical owner 7001 and peer 7002', () => {
  const env = { GHO_RATE_LIMIT_SHARED_STATE_PATH: '/fixture/rate-limit-state.json' };
  const storeStatSyncImpl = () => ({ uid: 7001 });
  assert.equal(resolveBudgetBindingDirectory(env, { getuidImpl: () => 7001, storeStatSyncImpl }),
    '/fixture/rate-limit-state.json.bindings');
  assert.equal(resolveBudgetBindingDirectory(env, { getuidImpl: () => 7002, storeStatSyncImpl }),
    '/fixture/rate-limit-state.uid-7002.json.bindings');
});

test('bindings create private directories and reject foreign files and symlinks', async t => {
  const root = fixture(t);
  const directory = join(root, 'bindings');
  const digest = 'c'.repeat(24);
  const now = Date.now();
  writeBudgetBinding(directory, digest, 'installation-12-34', now + 1000, now);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(readBudgetBinding(directory, digest, now), 'installation-12-34');
  assert.equal(readBudgetBinding(directory, digest, now, {
    fstatSyncImpl: () => ({ isFile: () => true, uid: process.getuid() + 1 }),
  }), null);
  const { symlinkSync } = await import('node:fs');
  const target = join(root, 'target.json');
  writeFileSync(target, readFileSync(join(directory, `${digest}.json`)));
  rmSync(join(directory, `${digest}.json`));
  symlinkSync(target, join(directory, `${digest}.json`));
  assert.equal(readBudgetBinding(directory, digest, now), null);
  symlinkSync(directory, join(root, 'alias'));
  assert.equal(readBudgetBinding(join(root, 'alias'), digest, now), null);
});


test('adapter credential lookup inherits only the process store with a partial env', t => {
  const root = fixture(t);
  const env = { ...process.env, GHO_RATE_LIMIT_SHARED_STATE_PATH: join(root, 'budget.json'),
    GH_TOKEN: 'synthetic-adapter-binding', GITHUB_TOKEN: 'synthetic-ambient-adapter-token',
    GHO_API_CALL_LOG_DISABLE: '1' };
  registerGitHubInstallationToken(env.GH_TOKEN, '56', '78', { env });
  registerGitHubInstallationToken(env.GITHUB_TOKEN, '56', '79', { env });
  const moduleUrl = new URL('../src/github-adapter-client.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { __test__, githubAdapterReadCredential } from ${JSON.stringify(moduleUrl)};
    const args = ['--pat-env', 'GITHUB_TOKEN', '--pat-env', 'GH_TOKEN'];
    assert.equal(__test__.githubAdapterCredential(args).credential, 'adapter:default');
    assert.equal(__test__.githubAdapterCredential(args, { GH_TOKEN: process.env.GH_TOKEN }).credential,
      'installation-56-78');
    assert.equal(githubAdapterReadCredential({
      GH_TOKEN: process.env.GH_TOKEN, WATCHER_GH_AUTH_VIA_BROKER: 'true',
    }), 'installation-56-78');
    assert.equal(__test__.githubAdapterCredential(args, process.env).credential, 'installation-56-79');
    console.log('ok');
  `;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { env, encoding: 'utf8' }).trim(), 'ok');
});


test('negative binding lookups are bounded, expire after one second and isolate store paths', t => {
  const root = fixture(t);
  const token = 'synthetic-negative-cache';
  const digest = createHash('sha256').update(token).digest('hex').slice(0, 24);
  const env = { GHO_RATE_LIMIT_SHARED_STATE_PATH: join(root, 'budget.json') };
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  assert.equal(githubCredential({ token, env }), `token-${digest}`);
  writeBudgetBinding(resolveBudgetBindingDirectory(env), digest, 'installation-90-12', now + 60_000, now);
  assert.equal(githubCredential({ token, env }), `token-${digest}`);
  const otherEnv = { GHO_RATE_LIMIT_SHARED_STATE_PATH: join(root, 'other.json') };
  writeBudgetBinding(resolveBudgetBindingDirectory(otherEnv), digest, 'installation-34-56', now + 60_000, now);
  assert.equal(githubCredential({ token, env: otherEnv }), 'installation-34-56');
  now += 1000;
  assert.equal(githubCredential({ token, env }), 'installation-90-12');
  now += 60_000;
  assert.equal(githubCredential({ token, env }), `token-${digest}`);
});

test('binding misses use the inherited store path as their cache key', t => {
  const root = fixture(t);
  const token = 'synthetic-inherited-cache';
  const digest = createHash('sha256').update(token).digest('hex').slice(0, 24);
  const firstPath = join(root, 'first.json');
  const secondPath = join(root, 'second.json');
  const previousPath = process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
  t.after(() => {
    if (previousPath === undefined) delete process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH;
    else process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = previousPath;
  });
  process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = firstPath;
  assert.equal(githubCredential({ token, env: {} }), `token-${digest}`);
  writeBudgetBinding(`${secondPath}.bindings`, digest, 'installation-90-34', Date.now() + 60_000);
  process.env.GHO_RATE_LIMIT_SHARED_STATE_PATH = secondPath;
  assert.equal(resolveBudgetBindingDirectory({}), `${secondPath}.bindings`);
  assert.equal(githubCredential({ token, env: {} }), 'installation-90-34');
});
