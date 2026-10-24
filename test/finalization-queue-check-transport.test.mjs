import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntitledQueueCheckRequest } from '../src/finalization/queue-check-transport.mjs';
import { hammerTokenSession } from '../src/hammer-token.mjs';
import { handoffTime } from './helpers/queue-handoff-fixture.mjs';
const head = 'b'.repeat(40);
const path = `/repos/example/review/commits/${head}/statuses?per_page=100&page=1`;
const req = { path, deadline: handoffTime(10), timeoutMs: 10_000 };
const idle = { enabled: false };
const held = 'synthetic-entitled', ambient = 'synthetic-ambient';
const env = () => ({ PATH: '/usr/bin:/bin', HOME: '/nonexistent-fixture',
  HAMMER_LACEY_GH_TOKEN: held, GH_TOKEN: ambient, GITHUB_TOKEN: ambient });
const response = (headers = '') => ({ stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n${headers}\r\n[]\n` });

test('each read uses the held entitled credential despite optional early refresh failure and ambient conflicts', async () => {
  const credentialEnv = { ...env(), HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND: 'exit 1' };
  let calls = 0;
  const reader = createEntitledQueueCheckRequest({ credentialEnv, load: idle, now: () => handoffTime(0),
    execFileImpl: async (cmd, args, options) => {
      calls++; assert.equal(cmd, 'gh'); assert.deepEqual(args.slice(0, 5), ['api', '--include', '--method', 'GET', path]);
      assert.equal(options.env.GH_TOKEN, held); assert.equal(options.env.GITHUB_TOKEN, held);
      assert.ok(options.timeout <= 5000); return response();
    } });
  await reader.read(req); await reader.read(req); assert.equal(calls, 2);
  assert.equal(credentialEnv.GH_TOKEN, ambient);
});

test('refresh-only export contract supplies credentials around each operation, not once per daemon', async () => {
  const credentialEnv = { ...env(), HAMMER_LACEY_GH_TOKEN: undefined,
    HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND: "printf 'export HAMMER_LACEY_GH_TOKEN=synthetic-fresh\\nexport GH_TOKEN=synthetic-fresh\\n'" };
  const reader = createEntitledQueueCheckRequest({ credentialEnv, load: idle, now: () => handoffTime(0), execFileImpl: async (_cmd, _args, options) => {
    assert.equal(options.env.GH_TOKEN, 'synthetic-fresh'); return response();
  } });
  await reader.read(req);
  credentialEnv.HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND = "printf 'synthetic-next'";
  const next = createEntitledQueueCheckRequest({ credentialEnv, load: idle, now: () => handoffTime(0), execFileImpl: async (_cmd, _args, options) => {
    assert.equal(options.env.GH_TOKEN, 'synthetic-next'); return response();
  } });
  await next.read(req);
});

for (const credentialEnv of [{ GH_TOKEN: ambient }, { HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND: 'exit 1', GH_TOKEN: ambient }]) {
  test('ambient credentials cannot substitute for missing entitled credentials', async () => {
    let calls = 0;
    const reader = createEntitledQueueCheckRequest({ credentialEnv, load: idle, now: () => handoffTime(0), execFileImpl: async () => { calls++; } });
    await assert.rejects(reader.read(req)); assert.equal(calls, 0);
  });
}

test('rejected credentials force one refresh and fail closed during outage', async () => {
  let calls = 0;
  const reader = createEntitledQueueCheckRequest({ credentialEnv: { ...env(), HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND: 'exit 1' },
    load: idle, now: () => handoffTime(0), execFileImpl: async () => { calls++; throw Object.assign(new Error('HTTP 401 Bad credentials'), { status: 401 }); } });
  await assert.rejects(reader.read(req), /entitled token refresh failed/); assert.equal(calls, 1);
});

test('Link pagination is explicit and confined to the immutable commit endpoint', async () => {
  const reader = createEntitledQueueCheckRequest({ credentialEnv: env(), load: idle, now: () => handoffTime(0), execFileImpl: async () => response(
    `Link: <https://api.github.com${path.replace('&page=1', '&page=2')}>; rel="next"\r\n`) });
  assert.equal((await reader.read(req)).nextPage, 2);
  const foreign = createEntitledQueueCheckRequest({ credentialEnv: env(), load: idle, now: () => handoffTime(0), execFileImpl: async () => response(
    'Link: <https://example.invalid/unrelated?page=2>; rel="next"\r\n') });
  await assert.rejects(foreign.read(req), /pagination/);
});

test('uppercase candidate SHAs use the same entitled read path', async () => {
  const uppercase = path.replace(head, head.toUpperCase());
  const reader = createEntitledQueueCheckRequest({ credentialEnv: env(), load: idle, now: () => handoffTime(0),
    execFileImpl: async (_cmd, args) => { assert.equal(args[4], uppercase); return response(); } });
  assert.equal((await reader.read({ ...req, path: uppercase })).nextPage, null);
});

for (const kind of ['statuses', 'check-runs']) test(`${kind} pagination accepts split Link headers and canonical repository paths`, async () => {
  const original = `/repos/example/review/commits/${head}/${kind}?per_page=100&page=1${kind === 'check-runs' ? '&filter=all' : ''}`;
  const canonical = original.replace('/repos/example/review', '/repositories/123');
  for (const split of [', ', '\r\nlInK: ']) {
    const reader = createEntitledQueueCheckRequest({ credentialEnv: env(), load: idle, now: () => handoffTime(0),
      execFileImpl: async (_cmd, args) => {
        assert.equal(args[4], original);
        return response(`Link: <https://api.github.com${canonical.replace('&page=1', '&page=2')}>; rel="next"${split}<https://api.github.com${canonical.replace('&page=1', '&page=3')}>; rel="last"\r\n`);
      } });
    assert.equal((await reader.read({ ...req, path: original })).nextPage, 2);
  }
});

for (const [name, next] of [
  ['foreign origin', `https://example.invalid/repositories/123/commits/${head}/statuses?per_page=100&page=2`],
  ['different SHA', `https://api.github.com/repositories/123/commits/${'a'.repeat(40)}/statuses?per_page=100&page=2`],
  ['different endpoint', `https://api.github.com/repositories/123/commits/${head}/check-runs?per_page=100&page=2`],
  ['different named repository', `https://api.github.com/repos/foreign/review/commits/${head}/statuses?per_page=100&page=2`],
  ['malformed repository ID', `https://api.github.com/repositories/wrong/commits/${head}/statuses?per_page=100&page=2`],
  ['wrong page size', `https://api.github.com/repositories/123/commits/${head}/statuses?per_page=10&page=2`],
  ['wrong filter', `https://api.github.com/repositories/123/commits/${head}/statuses?per_page=100&page=2&filter=all`],
]) test(`canonical pagination refuses ${name}`, async () => {
  const reader = createEntitledQueueCheckRequest({ credentialEnv: env(), load: idle, now: () => handoffTime(0),
    execFileImpl: async () => response(`Link: <${next}>; rel="next"\r\n`) });
  await assert.rejects(reader.read(req), /checks-pagination-unreadable/);
});

test('multiple Link header lines retain malformed and duplicate-next rejection', async () => {
  const next = `Link: <https://api.github.com${path.replace('&page=1', '&page=2')}>; rel="next"\r\n`;
  for (const headers of [next + next, next + 'Link: malformed\r\n']) {
    const reader = createEntitledQueueCheckRequest({ credentialEnv: env(), load: idle, now: () => handoffTime(0), execFileImpl: async () => response(headers) });
    await assert.rejects(reader.read(req), /checks-pagination-unreadable/);
  }
});

test('high load clips to remaining absolute budget after refresh and refuses expired reads', async () => {
  let clock = handoffTime(9), calls = 0;
  const reader = createEntitledQueueCheckRequest({ credentialEnv: env(), now: () => clock,
    load: { enabled: true, loadAvg1m: 1000, cpuCount: 1, cpuBusyPercent: 100 },
    execFileImpl: async (_cmd, _args, options) => { calls++; assert.equal(options.timeout, 1000); return response(); } });
  await reader.read(req); clock = handoffTime(10); await assert.rejects(reader.read(req), /expired/); assert.equal(calls, 1);
});

test('broker refresh timeout consumes the supplied effective budget without scaling it', () => {
  const session = hammerTokenSession({ hammerToken: true, credentialEnv: {
    HAMMER_LACEY_GH_TOKEN_REFRESH_COMMAND: 'exec /bin/sleep 10', PATH: '/usr/bin:/bin', HOME: '/nonexistent-fixture' } });
  const start = performance.now();
  assert.throws(() => session.prepare({ timeoutMs: 25 }), /timeout or signal/);
  assert.ok(performance.now() - start < 2000);
  assert.throws(() => session.prepare({ timeoutMs: 0 }), /deadline expired/);
});

test('supported generic launch refresh replaces ambient credentials before a read', async () => {
  const reader = createEntitledQueueCheckRequest({ credentialEnv: { GH_TOKEN: ambient,
    HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND: "printf 'synthetic-generic'", PATH: '/usr/bin:/bin', HOME: '/nonexistent-fixture' },
    load: idle, now: () => handoffTime(0), execFileImpl: async (_cmd, _args, options) => {
      assert.equal(options.env.GH_TOKEN, 'synthetic-generic'); return response();
    } });
  await reader.read(req);
});
