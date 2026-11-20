import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/live-pack-check.mjs', import.meta.url));
const { org = 'fixture-owner' } = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const repo = `${org}/fixture`;
const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const prPath = `repos/${repo}/pulls/1`;
const planPath = 'projects/fixture-pack/plan.json';

async function runColdCli(t, { refuseRegistration = false, transientFailures = 0,
  changedPaths = [planPath], identity = [repo, '1', head] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'live-pack-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'apps/bootstrap'), { recursive: true });
  writeFileSync(join(dir, 'apps/bootstrap/adversarial-review.bearer'), 'fixture-bootstrap');

  const ghCalled = join(dir, 'gh-called');
  const ghReplies = {
    [prPath]: { state: 'open', head: { sha: head, ref: 'worker/FIXTURE-2' }, base: { sha: base },
      title: 'Update fixture plan', labels: [], user: { login: 'fixture-user', type: 'User' } },
    [`${prPath}/files`]: changedPaths.map(filename => ({ filename })),
    [`repos/${repo}/contents/${planPath}?ref=${base}`]: { planId: 'fixture-plan', tickets: [{ id: 'FIXTURE-1' }] },
  };
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
    const { appendFileSync } = require('node:fs');
    const endpoint = process.argv.slice(2).find(arg => arg.startsWith('repos/'));
    appendFileSync(${JSON.stringify(ghCalled)}, endpoint + '\\n');
    const reply = ${JSON.stringify(ghReplies)}[endpoint];
    if (!reply) process.exit(2);
    console.log(JSON.stringify(reply));
  `, { mode: 0o755 });

  const requests = [];
  let registrations = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const authorization = req.headers.authorization;
    requests.push({ path: req.url, authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/register' && authorization === 'Bearer fixture-bootstrap' && body.app_id === 'adversarial-review') {
      registrations++;
      if (refuseRegistration) {
        res.writeHead(403).end(JSON.stringify({ error: 'fixture-sensitive-bootstrap-detail' }));
      } else if (registrations <= transientFailures) {
        res.writeHead(503).end(JSON.stringify({ error: 'service_unavailable', message: 'fixture-sensitive-bootstrap-detail' }));
      } else {
        res.end(JSON.stringify({ session_token: 'fixture-session' }));
      }
    } else if (req.url === '/v1/dispatch/lookup' && authorization === 'Bearer fixture-session') {
      res.end(JSON.stringify({ schema_version: 1, observation: 'dag_runs', status: 'not_live',
        complete: true, next_offset: null, scope_complete: false, mutation_authority: false, items: [] }));
    } else {
      res.writeHead(401).end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { PATH: `${dir}:${process.env.PATH}`, HOME: dir, HQ_ROOT: dir,
    APP_CONTRACT_ENDPOINT_URL: `http://127.0.0.1:${server.address().port}` };
  const args = ['--preserve-symlinks', '--preserve-symlinks-main', cli, ...identity];
  const output = await exec(process.execPath, args, { cwd: dir, env, timeout: 15_000 })
    .then(result => ({ ...result, code: 0 }), error => error);
  for (const secret of ['fixture-sensitive-bootstrap-detail', 'fixture-bootstrap', 'fixture-session']) {
    assert.equal(output.stderr.includes(secret), false, 'stderr must redact fixture secrets');
    assert.equal(output.stdout.includes(secret), false, 'stdout must redact fixture secrets');
  }
  return { code: output.code, result: JSON.parse(output.stdout), requests, ghCalled: existsSync(ghCalled),
    ghRequests: existsSync(ghCalled) ? readFileSync(ghCalled, 'utf8').trim().split('\n') : [] };
}

test('the cold live-pack executable registers once and reads authenticated plan liveness', async t => {
  const { code, result, requests, ghCalled } = await runColdCli(t);
  assert.equal(code, 0, JSON.stringify({ result, ghCalled }));
  assert.deepEqual(result, { ok: true, reason: 'live-pack-clear', headSha: head, findings: [], waived: false, exemptions: [] });
  assert.equal(ghCalled, true);
  assert.deepEqual(requests.map(req => req.path), ['/v1/register', '/v1/dispatch/lookup']);
  assert.equal(requests[1].authorization, 'Bearer fixture-session');
  assert.equal(requests[1].body.observation, 'dag_runs');
  assert.equal(requests[1].body.plan_id, 'fixture-plan');
});

test('the cold live-pack executable returns a redacted bootstrap refusal before plan reads', async t => {
  const { code, result, requests, ghCalled, ghRequests } = await runColdCli(t, { refuseRegistration: true });
  assert.equal(code, 1);
  assert.deepEqual(result, { ok: false, reason: 'dispatch-context-unavailable', detail: 'session-bootstrap-failed' });
  assert.equal(ghCalled, true);
  assert.deepEqual(ghRequests, [prPath, `${prPath}/files`]);
  assert.deepEqual(requests.map(req => req.path), ['/v1/register']);
});

test('a PR without guarded pack files clears without attempting refused registration', async t => {
  const { code, result, requests, ghCalled } = await runColdCli(t, {
    changedPaths: ['src/example.mjs', 'docs/example.md'], refuseRegistration: true,
  });
  assert.equal(code, 0);
  assert.equal(result.reason, 'live-pack-clear');
  assert.equal(result.waived, false);
  assert.equal(ghCalled, true);
  assert.deepEqual(requests, []);
});

for (const identity of [[repo, '1'], [repo, '1', 'invalid'], ['invalid', '1', head], [repo, '0', head]]) {
  test(`invalid identity ${identity.join(' ')} refuses before GitHub or registration`, async t => {
    const { code, result, requests, ghCalled } = await runColdCli(t, { identity, refuseRegistration: true });
    assert.equal(code, 1);
    assert.deepEqual(result, { ok: false, reason: 'live-pack-invalid-identity' });
    assert.equal(ghCalled, false);
    assert.deepEqual(requests, []);
  });
}

test('a transient registration refusal retries and then reads authenticated liveness', async t => {
  const { code, result, requests } = await runColdCli(t, { transientFailures: 1 });
  assert.equal(code, 0);
  assert.equal(result.reason, 'live-pack-clear');
  assert.deepEqual(requests.map(req => req.path), ['/v1/register', '/v1/register', '/v1/dispatch/lookup']);
});

test('transient registration refusals stop after three attempts without a liveness read', async t => {
  const { code, result, requests } = await runColdCli(t, { transientFailures: 10 });
  assert.equal(code, 1);
  assert.deepEqual(result, { ok: false, reason: 'dispatch-context-unavailable', detail: 'session-bootstrap-failed' });
  assert.deepEqual(requests.map(req => req.path), ['/v1/register', '/v1/register', '/v1/register']);
});
