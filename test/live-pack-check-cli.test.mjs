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

async function runColdCli(t, { refuseRegistration = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'live-pack-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'apps/bootstrap'), { recursive: true });
  writeFileSync(join(dir, 'apps/bootstrap/adversarial-review.bearer'), 'fixture-bootstrap');

  const ghCalled = join(dir, 'gh-called');
  const registered = join(dir, 'registered');
  const ghReplies = {
    [prPath]: { state: 'open', head: { sha: head, ref: 'worker/FIXTURE-2' }, base: { sha: base },
      title: 'Update fixture plan', labels: [], user: { login: 'fixture-user', type: 'User' } },
    [`${prPath}/files`]: [{ filename: planPath }],
    [`repos/${repo}/contents/${planPath}?ref=${base}`]: { planId: 'fixture-plan', tickets: [{ id: 'FIXTURE-1' }] },
  };
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
    const { existsSync, writeFileSync } = require('node:fs');
    writeFileSync(${JSON.stringify(ghCalled)}, '');
    if (!existsSync(${JSON.stringify(registered)})) process.exit(2);
    const endpoint = process.argv.slice(2).find(arg => arg.startsWith('repos/'));
    const reply = ${JSON.stringify(ghReplies)}[endpoint];
    if (!reply) process.exit(2);
    console.log(JSON.stringify(reply));
  `, { mode: 0o755 });

  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const authorization = req.headers.authorization;
    requests.push({ path: req.url, authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/register' && authorization === 'Bearer fixture-bootstrap' && body.app_id === 'adversarial-review') {
      if (refuseRegistration) {
        res.writeHead(403).end(JSON.stringify({ error: 'fixture-sensitive-bootstrap-detail' }));
      } else {
        writeFileSync(registered, '');
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
  const args = ['--preserve-symlinks', '--preserve-symlinks-main', cli, repo, '1', head];
  const output = await exec(process.execPath, args, { cwd: dir, env, timeout: 15_000 })
    .then(result => ({ ...result, code: 0 }), error => error);
  assert.equal(output.stderr, '');
  return { code: output.code, result: JSON.parse(output.stdout), requests, ghCalled: existsSync(ghCalled) };
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

test('the cold live-pack executable returns a redacted bootstrap refusal before any PR or plan read', async t => {
  const { code, result, requests, ghCalled } = await runColdCli(t, { refuseRegistration: true });
  assert.equal(code, 1);
  assert.deepEqual(result, { ok: false, reason: 'dispatch-context-unavailable', detail: 'session-bootstrap-failed' });
  assert.equal(ghCalled, false);
  assert.deepEqual(requests.map(req => req.path), ['/v1/register']);
});
