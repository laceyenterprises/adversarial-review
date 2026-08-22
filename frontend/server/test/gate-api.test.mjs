/**
 * ARF-08: the `ar-govern` HTTP surface.
 *
 * The read route is the one an operator opens when merges have stopped, so it
 * answers under every gate state including the broken ones. The write routes
 * are the arm/disarm control itself, so what they *refuse* matters as much as
 * what they do: an unattributed flip, a flip from off-box, a flip from a form
 * POST a browser sent on some other page's behalf, and a flip from a caller
 * holding a stale read are each refused for their own reason.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { MERGE_PATH_IDS } from '../../gate/gate-contract.mjs';
import { loadConfig } from '../src/config.mjs';
import { createArfServer } from '../src/server.mjs';

const JSON_HEADERS = { 'content-type': 'application/json' };

async function boot() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'arf-gate-api-'));
  const env = { ARF_PORT: '0', ARF_STATE_ROOT: stateRoot };
  const config = loadConfig({ env });
  const { server, gateStore } = createArfServer({ config, env });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const call = async (method, path, { body, headers } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return {
    config,
    gateStore,
    stateRoot,
    get: (path) => call('GET', path),
    post: (path, body, headers = JSON_HEADERS) => call('POST', path, { body, headers }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('ar-govern: reading the gate', () => {
  let app;
  before(async () => { app = await boot(); });
  after(async () => { await app.close(); });

  it('answers 200 before the gate is installed, and says every path is refusing', async () => {
    // A 404 here would be the wrong shape: "there is no gate" is an answer, and
    // it is the answer that explains why a configured merge path is refusing.
    const { status, body } = await app.get('/v1/governance/gate');
    assert.equal(status, 200);
    assert.equal(body.installed, false);
    assert.deepEqual(body.mergePaths, [...MERGE_PATH_IDS]);
    for (const id of MERGE_PATH_IDS) assert.equal(body.effective[id], false);
  });

  it('installs, then reports both merge paths armed', async () => {
    const created = await app.post('/v1/governance/gate/init', { actor: 'paul', reason: 'install' });
    assert.equal(created.status, 201);

    const { body } = await app.get('/v1/governance/gate');
    assert.equal(body.installed, true);
    assert.equal(body.gate.paths.filter((path) => path.msm).length, 2);
    for (const id of MERGE_PATH_IDS) assert.equal(body.effective[id], true);
  });

  it('reflects a disarm in the path it names and nowhere else', async () => {
    const armed = await app.post('/v1/governance/gate/disarm', {
      path: 'hammer', actor: 'ada', reason: 'rebase storm',
    });
    assert.equal(armed.status, 200);
    assert.equal(armed.body.applied, true);

    const { body } = await app.get('/v1/governance/gate');
    assert.equal(body.effective.hammer, false);
    assert.equal(body.effective['daemon-clean'], true);
    assert.equal(body.decisions.hammer.code, 'disarmed-path');
    assert.equal(body.decisions.hammer.setBy, 'ada');
  });

  it('carries the audit trail, newest last', async () => {
    const { body } = await app.get('/v1/governance/gate');
    const events = body.audit.map((record) => record.event);
    assert.deepEqual(events, ['init', 'disarm']);
  });

  it('bounds the audit a caller can ask for', async () => {
    const { status, body } = await app.get('/v1/governance/gate?auditLimit=9999');
    assert.equal(status, 400);
    assert.equal(body.error, 'bad_request');
  });

  it('re-arms', async () => {
    await app.post('/v1/governance/gate/arm', { path: 'hammer', actor: 'ada', reason: 'settled' });
    const { body } = await app.get('/v1/governance/gate');
    assert.equal(body.effective.hammer, true);
  });

  it('stops every path with one emergency-stop write', async () => {
    const { status, body } = await app.post('/v1/governance/gate/disarm', {
      scope: 'all', actor: 'paul', reason: 'emergency stop',
    });
    assert.equal(status, 200);
    for (const id of MERGE_PATH_IDS) assert.equal(body.gate.effective[id], false);
  });
});

describe('ar-govern: what the write surface refuses', () => {
  let app;
  before(async () => {
    app = await boot();
    await app.post('/v1/governance/gate/init', { actor: 'paul', reason: 'install' });
  });
  after(async () => { await app.close(); });

  it('refuses a flip with no actor or no reason', async () => {
    for (const body of [{ path: 'hammer', reason: 'x' }, { path: 'hammer', actor: 'paul' }]) {
      const res = await app.post('/v1/governance/gate/disarm', body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'bad_request');
    }
  });

  it('refuses a flip that does not say what it is flipping', async () => {
    const { status, body } = await app.post('/v1/governance/gate/disarm', { actor: 'paul', reason: 'x' });
    assert.equal(status, 400);
    assert.match(body.detail, /scope is required/);
  });

  it('refuses a non-boolean `armed` on init rather than coercing it', async () => {
    // `armed: "false"` coercing to true would install the gate in the opposite
    // posture to the one the caller asked for, silently.
    const { status, body } = await app.post('/v1/governance/gate/init', {
      actor: 'paul', reason: 'x', armed: 'false',
    });
    assert.equal(status, 400);
    assert.equal(body.error, 'bad_request');
  });

  it('refuses a scope that is not a merge path', async () => {
    // `--path hamer` becoming an emergency stop, or a silent no-op, is the
    // failure this whole surface exists to prevent.
    const { status } = await app.post('/v1/governance/gate/disarm', {
      path: 'hamer', actor: 'paul', reason: 'x',
    });
    assert.equal(status, 400);
  });

  it('refuses a form-shaped POST', async () => {
    // A JSON content-type cannot be sent cross-origin without a preflight, so
    // requiring it is what stops a page the operator has open from arming the
    // hammer through their own browser.
    const { status, body } = await app.post(
      '/v1/governance/gate/disarm',
      { path: 'hammer', actor: 'paul', reason: 'x' },
      { 'content-type': 'text/plain;charset=UTF-8' },
    );
    assert.equal(status, 415);
    assert.equal(body.error, 'unsupported_media_type');
  });

  it('refuses a stale-read re-arm', async () => {
    const before = await app.get('/v1/governance/gate');
    const staleSeq = before.body.gate.seq;
    await app.post('/v1/governance/gate/disarm', { scope: 'all', actor: 'ada', reason: 'emergency stop' });

    const { status, body } = await app.post('/v1/governance/gate/arm', {
      scope: 'all', actor: 'paul', reason: 'looks fine to me', expectedSeq: staleSeq,
    });
    assert.equal(status, 409);
    assert.equal(body.error, 'gate_conflict');

    const after = await app.get('/v1/governance/gate');
    assert.equal(after.body.gate.master.armed, false, 'the emergency stop survived');
  });

  it('reports a corrupt gate as a 409 the operator can act on, not a 500', async () => {
    writeFileSync(app.config.governance.gatePath, '{ truncated');
    const { status, body } = await app.post('/v1/governance/gate/arm', {
      scope: 'all', actor: 'paul', reason: 'x',
    });
    assert.equal(status, 409);
    assert.equal(body.error, 'gate_malformed');
  });

  it('still answers the read route with a corrupt gate, and still refuses every path', async () => {
    const { status, body } = await app.get('/v1/governance/gate');
    assert.equal(status, 200);
    assert.equal(body.error.code, 'gate_malformed');
    for (const id of MERGE_PATH_IDS) assert.equal(body.effective[id], false);
  });

  it('does not accept a GET on a write route or a POST on the read route', async () => {
    assert.equal((await app.get('/v1/governance/gate/disarm')).status, 404);
    assert.equal((await app.post('/v1/governance/gate', { actor: 'a', reason: 'b' })).status, 405);
  });
});
