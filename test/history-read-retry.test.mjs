import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHistoryReader } from '../src/ama/history-reader.mjs';
import { fetchPrimaryChange, checkPrimaryChange } from '../src/ama/primary-change.mjs';
import { readHammerStopForHead } from '../src/ama/hammer-stop-hold.mjs';
import { HISTORY_READ_ERROR_LIMIT, historyReadRetryDelayMs } from '../src/ama/history-read-policy.mjs';
import { githubCredential, recordResponseRateLimit } from '../src/rate-limit-throttle.mjs';

const base = 'a'.repeat(40), primary = 'b'.repeat(40), head = 'c'.repeat(40);
const prPath = 'repos/fixture/repo/pulls/42';
let credential = 0;
const fakeEnv = () => ({ GH_TOKEN: `synthetic-history-${++credential}` });
const transportError = (stderr, extra = {}) => Object.assign(new Error('Command failed: gh api fixture'), { stderr, ...extra });

test('a retried blob read produces exactly the same complete evidence as first-try success', async t => {
  const collect = async retry => {
    const rootDir = mkdtempSync(join(os.tmpdir(), 'history-retry-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    let failed = false;
    const delays = [];
    const get = createHistoryReader({ env: fakeEnv(), sleep: async ms => { delays.push(ms); },
      execFileImpl: async (_cmd, args) => {
        const path = args[1];
        assert.ok(args.includes('--include'));
        let value;
        if (path.includes('/reviews?')) value = [];
        else if (path.includes('/pulls/')) value = { head: { sha: head }, base: { sha: base } };
        else if (path.includes('/compare/')) value = { status: 'ahead', total_commits: path.includes(head) ? 1 : 0,
          merge_base_commit: { sha: base }, commits: path.includes(head)
            ? [{ sha: head, parents: [{ sha: primary }], commit: { message: 'repair\n\nWorker-Class: hammer' } }] : [] };
        else if (path.includes('/git/trees/')) value = { tree: path.endsWith(base) ? [] : [{ path: 'source.mjs', type: 'blob', mode: '100644', sha: head }], truncated: false };
        else if (path.includes('/git/blobs/')) {
          if (retry && !failed) { failed = true; throw transportError('Get "https://api.github.com/fixture": egress-proxy: upstream connect failed'); }
          value = { encoding: 'base64', content: Buffer.from('protected\n').toString('base64'), size: 10 };
        } else assert.fail(`unexpected fixture path ${path}`);
        return { stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}` };
      } });
    const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 42, headSha: head, rootDir, get },
      { fetchCiCostImpl: async () => ({ headSha: head, ok: true }) });
    return { evidence, delays };
  };
  const baseline = await collect(false);
  const retried = await collect(true);
  assert.equal(retried.evidence.completeFileLists, true);
  assert.equal(retried.evidence.primaryFiles.length, 1);
  assert.equal(checkPrimaryChange(retried.evidence, head).ok, true);
  assert.deepEqual(retried.evidence, baseline.evidence);
  assert.deepEqual(retried.delays, [500]);
});

for (const stderr of [
  'Get "https://api.github.com/fixture": dial tcp: lookup api.github.com: no such host',
  'read: connection reset by peer', 'connect: connection refused', 'network error: unexpected EOF',
  'proxyconnect tcp: proxy error', 'egress-proxy: upstream connect failed',
  'remote error: tls: internal error', 'x509: certificate signed by unknown authority',
  'context deadline exceeded (Client.Timeout exceeded while awaiting headers)',
  'gh: Service Unavailable (HTTP 503)',
]) {
  test(`history transport retries are bounded: ${stderr}`, async () => {
    let calls = 0;
    const delays = [];
    const get = createHistoryReader({ env: fakeEnv(), sleep: async ms => { delays.push(ms); },
      execFileImpl: async () => { calls++; throw transportError(stderr); } });
    const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 42, headSha: head, get });
    assert.equal(checkPrimaryChange(evidence, head).reason, 'history-read-failed');
    assert.ok(evidence.reason.includes(stderr), evidence.reason);
    assert.equal(calls, 3);
    assert.deepEqual(delays, [500, 1000]);
  });
}

for (const stderr of [
  'gh: Not Found (HTTP 404): proxy timeout document does not exist',
  'gh: Resource not accessible by integration (HTTP 403)',
  'gh: Validation Failed (HTTP 422): network error is an invalid value',
  'gh: secondary rate limit (HTTP 403)',
  'gh: secondary rate limit (HTTP 403)\nRetry-After: invalid',
]) {
  test(`permanent history errors are never retried: ${stderr}`, async () => {
    let calls = 0;
    const get = createHistoryReader({ env: fakeEnv(), sleep: async () => assert.fail('unexpected retry'),
      execFileImpl: async () => { calls++; throw transportError(stderr); } });
    await assert.rejects(get(prPath), error => error.message.includes(stderr));
    assert.equal(calls, 1);
  });
}

test('successful malformed data is terminal without retries', async () => {
  for (const stdout of ['{invalid', '{"tree":[],"truncated":true}']) {
    let calls = 0;
    const get = createHistoryReader({ env: fakeEnv(), execFileImpl: async () => { calls++; return { stdout }; },
      sleep: async () => assert.fail('malformed data must not retry') });
    await assert.rejects(get(`repos/fixture/repo/compare/${base}...${head}`));
    assert.equal(calls, 1);
  }
});

for (const code of ['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ENOBUFS']) {
  test(`history output overflow is terminal even when the process was killed: ${code}`, async () => {
    const cause = transportError('stdout maxBuffer length exceeded', { code, killed: true, signal: 'SIGTERM' });
    assert.equal(historyReadRetryDelayMs(cause, 0), null);
    let calls = 0;
    const get = createHistoryReader({ env: fakeEnv(),
      sleep: async () => assert.fail('output overflow must not retry'),
      execFileImpl: async () => { calls++; throw cause; } });
    await assert.rejects(get(prPath), error => {
      assert.equal(error.cause, cause);
      assert.match(error.message, /output limit \d+ bytes exceeded/);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test('raw string transport rejections retry and recover', async () => {
  assert.equal(historyReadRetryDelayMs('connection reset by peer', 0), 500);
  let calls = 0;
  const delays = [];
  const get = createHistoryReader({ env: fakeEnv(), sleep: async ms => { delays.push(ms); },
    execFileImpl: async () => {
      if (++calls < 3) throw 'connection reset by peer';
      return { stdout: '{}' };
    } });
  assert.deepEqual(await get(prPath), {});
  assert.equal(calls, 3);
  assert.deepEqual(delays, [500, 1000]);
  assert.equal(historyReadRetryDelayMs('HTTP 404: proxy timeout document does not exist', 0), null);
  assert.equal(historyReadRetryDelayMs('malformed response', 0), null);
});

test('backoff scales with corroborated host load and metadata reads recover', async t => {
  t.mock.method(os, 'loadavg', () => [os.cpus().length * 3, 0, 0]);
  t.mock.method(childProcess, 'execFileSync', () => `${os.cpus().length * 100}\n`);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const delays = [];
  let calls = 0;
  // Reader construction sizes its context budget and caches a CPU sample.
  // Install both host mocks before that first load-aware sizing call.
  const get = createHistoryReader({ env: fakeEnv(), sleep: async ms => { delays.push(ms); },
    execFileImpl: async () => {
      if (++calls < 3) throw transportError('egress-proxy: upstream connect failed');
      return { stdout: '{"status":"ahead"}' };
    } });
  assert.deepEqual(await get.metadata(`repos/fixture/repo/compare/${base}...${head}`), { status: 'ahead' });
  assert.deepEqual(delays, [3000, 6000]);
});

test('rate limits require and honor Retry-After, including HTTP dates', async t => {
  const mockedNow = t.mock.method(Date, 'now', () => Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(historyReadRetryDelayMs(transportError('HTTP 403: secondary rate limit\nRetry-After: 2'), 0), 2000);
  assert.equal(historyReadRetryDelayMs(transportError('HTTP 429: too many requests\nRetry-After: Thu, 01 Jan 2026 00:00:03 GMT'), 0), 3000);
  assert.equal(historyReadRetryDelayMs(transportError('Retry-After: 2', { status: 429 }), 0), 2000);
  assert.equal(historyReadRetryDelayMs(transportError('proxy timeout', { status: 404 }), 0), null);
  mockedNow.mock.restore();
  let calls = 0;
  const delays = [];
  const get = createHistoryReader({ env: fakeEnv(), sleep: async ms => { delays.push(ms); await new Promise(resolve => setTimeout(resolve, ms)); },
    execFileImpl: async () => {
      if (++calls === 1) throw Object.assign(transportError('* Request at fixture\n< HTTP/2.0 403 Forbidden\n< Retry-After: 2\nsecondary rate limit\n* Request took 1ms\ngh: secondary rate limit (HTTP 403)'),
        { stdout: 'HTTP/2.0 403 Forbidden\r\nRetry-After: 2\r\n\r\n' });
      return { stdout: '{}' };
    } });
  assert.deepEqual(await get(prPath), {});
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2000]);
});

test('exhausted shared quota defers CLI history reads instead of sleeping past the budget', async () => {
  const env = fakeEnv();
  await recordResponseRateLimit({ resource: 'core', credential: githubCredential({ env }), remaining: 0,
    resetAt: Date.now() + 3600_000 });
  const get = createHistoryReader({ env, contextTimeoutMs: 1000,
    execFileImpl: async () => assert.fail('exhausted quota must not execute'),
    sleep: async () => assert.fail('exhausted quota must not retry') });
  await assert.rejects(get(prPath), /budget deferred until/);
});

test('caller cancellation interrupts retry backoff without launching another request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const get = createHistoryReader({ env: fakeEnv(), signal: controller.signal,
    execFileImpl: async () => {
      calls++;
      setImmediate(() => controller.abort(new Error('synthetic cancellation')));
      throw transportError('connection reset by peer');
    } });
  await assert.rejects(get(prPath), /aborted|synthetic cancellation/);
  assert.equal(calls, 1);
});

test('all retries share the remaining context budget and preserve the final cause', async () => {
  let now = 0;
  const timeouts = [], delays = [];
  const error = transportError('read: connection reset by peer');
  const get = createHistoryReader({ env: fakeEnv(), contextTimeoutMs: 2000, nowMs: () => now,
    sleep: async ms => { delays.push(ms); now += ms; },
    execFileImpl: async (_cmd, _args, options) => {
      timeouts.push(options.timeout);
      if (timeouts.length === 1) { now += 700; return { stdout: '{}' }; }
      now += 400;
      throw error;
    } });
  await get(prPath);
  await assert.rejects(get(`${prPath}/reviews?per_page=100`), /connection reset by peer/);
  assert.deepEqual(timeouts, [2000, 1300, 400]);
  assert.deepEqual(delays, [500]);
  assert.equal(now, 2000);
  await assert.rejects(get(prPath), /history read context budget exhausted/);
  assert.equal(timeouts.length, 3);
});

test('Retry-After beyond the context budget fails immediately with the original cause', async () => {
  let calls = 0;
  const get = createHistoryReader({ env: fakeEnv(), contextTimeoutMs: 1000,
    sleep: async () => assert.fail('cannot spend the whole budget sleeping'),
    execFileImpl: async () => { calls++; throw transportError('HTTP 503 Service Unavailable\nRetry-After: 120'); } });
  await assert.rejects(get(prPath), /Retry-After: 120/);
  assert.equal(calls, 1);
});

test('long stderr and closing status retain the cause beyond 300 characters, up to 2000', async () => {
  const cause = `${'synthetic request detail '.repeat(30)}egress-proxy: upstream connect failed`;
  const get = createHistoryReader({ env: fakeEnv(), sleep: async () => {},
    execFileImpl: async () => { throw transportError(`${cause}\n${'x'.repeat(3000)}`); } });
  const evidence = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 42, headSha: head, get });
  assert.equal(evidence.reason.length, HISTORY_READ_ERROR_LIMIT);
  assert.match(evidence.reason, /egress-proxy: upstream connect failed/);
  const attempt = { outcome: 'failed-without-merge', reason: 'history-read-failed', path: 'hammer', head,
    historyReadError: evidence.reason, closingStatus: evidence.reason };
  const stop = readHammerStopForHead({ hqRoot: '/unused', repo: 'fixture/repo', prNumber: 42, headSha: head,
    readAuditImpl: () => ({ attempts: [attempt] }) });
  assert.equal(stop.historyReadError, evidence.reason.replace(/\s+/g, ' '));
  assert.equal(stop.closingStatus, stop.historyReadError);
});
