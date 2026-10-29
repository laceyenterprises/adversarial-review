import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const client = new URL('../src/dispatch-read-client.mjs', import.meta.url).href;
const files = new URL('../src/dispatch-files-client.mjs', import.meta.url).href;

async function freshProcess(env, script) {
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (/^(APP_CONTRACT_|HCP_|HQ_LAUNCH_REQUEST_ID$|ADVERSARIAL_(DISPATCH_READS|WORKER_OBSERVATIONS)_ENABLED$)/.test(key)) delete childEnv[key];
  }
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...childEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(stderr, '');
  return { code, result: JSON.parse(stdout) };
}

test('cold composition registers the existing review app before authenticated synchronous reads', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'apps/bootstrap'), { recursive: true });
  writeFileSync(join(root, 'apps/bootstrap/adversarial-review.bearer'), 'fixture-bootstrap');
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: req.url, authorization: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/register' && req.headers.authorization === 'Bearer fixture-bootstrap') {
      assert.equal(body.app_id, 'adversarial-review');
      res.end(JSON.stringify({ session_token: 'fixture-session' }));
    } else if (req.url === '/v1/dispatch/lookup' && req.headers.authorization === 'Bearer fixture-session') {
      res.end(JSON.stringify(body.observation === 'host_identity'
        ? { schema_version: 1, status: 'found', ownerUser: 'fixture-owner' }
        : { schema_version: 1, status: 'found', complete: true,
          items: [{ launch_request_id: 'fixture-launch' }], roots: ['fixture-launch'], retry_edges: [] }));
    } else { res.writeHead(401); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { code, result } = await freshProcess({ HQ_ROOT: root,
    APP_CONTRACT_ENDPOINT_URL: `http://127.0.0.1:${server.address().port}` }, `
    import { prepareDispatchReadContext, readDispatchLaunchesSync } from ${JSON.stringify(client)};
    import { readHostIdentitySync } from ${JSON.stringify(files)};
    const ready = await prepareDispatchReadContext();
    const identity = readHostIdentitySync();
    const launch = readDispatchLaunchesSync({launch_request_ids: ['fixture-launch']});
    console.log(JSON.stringify({ready, identity, launch,
      reads: process.env.ADVERSARIAL_DISPATCH_READS_ENABLED,
      observations: process.env.ADVERSARIAL_WORKER_OBSERVATIONS_ENABLED}));
  `);
  assert.equal(code, 0);
  assert.deepEqual(result.ready, { ok: true });
  assert.deepEqual(result.identity, { ownerUser: 'fixture-owner' });
  assert.equal(result.launch.ok, true);
  assert.equal(result.reads, '1');
  assert.equal(result.observations, '1');
  assert.deepEqual(requests.map(req => req.path), ['/v1/register', '/v1/dispatch/lookup', '/v1/dispatch/lookup']);
});

test('a missing existing bootstrap credential yields a fixed named failure in a fresh process', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-context-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { code, result } = await freshProcess({ HQ_ROOT: root }, `
    import { prepareDispatchReadContext } from ${JSON.stringify(client)};
    const result = await prepareDispatchReadContext();
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  `);
  assert.equal(code, 1);
  assert.deepEqual(result, { ok: false, reason: 'dispatch-context-unavailable', detail: 'bootstrap-credential-missing' });
});

test('synchronous launch reads only borrow the session for the same connection', async t => {
  const { dispatchReadTransport, prepareDispatchReadContext } = await import(client);
  const calls = [];
  t.mock.method(dispatchReadTransport, 'sdk', () => ({
    connect: async config => ({ sessionToken: 'fixture-session', endpoint_url: config.endpoint_url }),
    readDispatchLookupSync: (_selector, options) => { calls.push(options); },
  }));
  const env = { APP_CONTRACT_ENDPOINT_URL: 'https://fixture.invalid/one' };
  assert.equal((await prepareDispatchReadContext({ env })).ok, true);
  dispatchReadTransport.lookupSync({}, { env });
  dispatchReadTransport.lookupSync({}, { env: { ...env, APP_CONTRACT_ENDPOINT_URL: 'https://fixture.invalid/two' } });
  assert.equal(calls[0].session_token, 'fixture-session');
  assert.equal(calls[1].session_token, undefined);
});

test('bootstrap failures redact arbitrary endpoint and credential diagnostics', async t => {
  const { dispatchReadTransport, prepareDispatchReadContext } = await import(client);
  t.mock.method(dispatchReadTransport, 'sdk', () => ({
    connect: async () => { throw new Error('fixture-secret producer response'); },
  }));
  assert.deepEqual(await prepareDispatchReadContext({ env: { APP_CONTRACT_ENDPOINT_URL: 'https://fixture.invalid/failure' } }),
    { ok: false, reason: 'dispatch-context-unavailable', detail: 'session-bootstrap-failed' });
});
