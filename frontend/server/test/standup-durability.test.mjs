/**
 * ARF-05: the failure modes that take the *daemon* down rather than the run.
 *
 * Everything else in this suite asks whether a standup produced the right answer.
 * These ask whether ARF is still there afterwards, which is a different property
 * and fails in a different way: a run that goes wrong is reported on the stream,
 * while a process that goes wrong takes every other operator's session with it and
 * reports nothing at all.
 *
 * Three of them, each pinned here because it was a live defect:
 *
 *  - a client that disconnects mid-stream, or a body ARF refuses, must not leave a
 *    rejection with nobody to catch it. An unhandled rejection ends the process;
 *    one dropped tab must not be able to do that.
 *  - the scratch file an atomic write uses must be unique per attempt. A name
 *    keyed on the pid alone is shared by every concurrent write in the process and
 *    by any other process that happens to hold that pid.
 *  - replacing an existing role manifest must preserve its ownership and mode.
 *    Silently narrowing it to ARF-owned `0600` locks out every other reader of the
 *    same file — the cross-process outage shape of the 501:20 class.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createArfServer } from '../src/server.mjs';
import { tempPathFor } from '../src/standup/atomic-file.mjs';
import { writeRoleMapping } from '../src/standup/role-mapping.mjs';
import { openStandupRunStore } from '../src/standup/run-store.mjs';
import { RECORD_SCHEMA_VERSION } from '../src/standup/run-store.mjs';
import {
  APP_ID, INSTALLATION_ID, PRIVATE_KEY_REF, envSecretRefs, mappedRoles, mockGithubServer,
  standupConfig, standupParams, tmpStateRoot,
} from './helpers/standup-fixtures.mjs';

/**
 * Run a body with an unhandled-rejection trap installed.
 *
 * Node fails the whole test *run* on an unhandled rejection, which reports as
 * some unrelated later test dying. Catching them here names the actual property
 * instead: nothing on this path may reject without a handler.
 */
async function withoutUnhandledRejections(body) {
  const escaped = [];
  const trap = (err) => escaped.push(err);
  process.on('unhandledRejection', trap);
  try {
    await body();
    // A rejection is delivered a turn later than the code that produced it, so
    // the check has to come after the loop has had a chance to run.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', trap);
  }
  assert.deepEqual(escaped.map((err) => String(err?.message ?? err)), []);
}

async function boot() {
  const github = await mockGithubServer();
  const refs = envSecretRefs('_DURABILITY');
  const stateRoot = tmpStateRoot();
  const fixture = standupConfig({
    stateRoot,
    roles: mappedRoles({ privateKeyRef: refs.privateKeyRef }),
    broker: { githubApiUrl: github.url },
  });
  const { server } = createArfServer({ config: fixture.config, reloadConfig: fixture.load });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    refs,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await github.close();
    },
  };
}

describe('the daemon survives its clients', () => {
  it('refuses an oversized body with a 400 and keeps serving', async () => {
    // The refusal has to *arrive*. Destroying the request to stop the read takes
    // the response with it, so the caller would see a socket hangup and ARF would
    // be writing a 400 into a socket that no longer exists.
    const app = await boot();
    try {
      await withoutUnhandledRejections(async () => {
        const oversized = await fetch(app.url('/v1/standup/identity/runs'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'the-hammer', padding: 'x'.repeat(128 * 1024) }),
        });

        assert.equal(oversized.status, 400);
        const body = await oversized.json();
        assert.equal(body.error, 'invalid_params');
        assert.match(body.detail, /exceeds/);
      });

      // The point of the test: the process is still answering.
      const health = await fetch(app.url('/healthz'));
      assert.equal(health.status, 200);
    } finally {
      await app.close();
    }
  });

  it('survives a client that disconnects mid-stream', async () => {
    // The operator closing the tab is the ordinary case, not an exotic one. It
    // aborts the run — which the machine handles — and it destroys the socket,
    // which every subsequent write on the SSE path has to expect.
    const app = await boot();
    try {
      await withoutUnhandledRejections(async () => {
        const controller = new AbortController();
        const response = await fetch(app.url('/v1/standup/identity/runs'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(standupParams(app.refs)),
          signal: controller.signal,
        });
        assert.equal(response.status, 200);

        // Read one chunk so the stream is genuinely in flight, then walk away.
        const reader = response.body.getReader();
        await reader.read();
        controller.abort();
        await reader.cancel().catch(() => {});
        // Long enough for the aborted run to reach its terminal frame and for the
        // writes that follow the disconnect to happen.
        await new Promise((resolve) => setTimeout(resolve, 150));
      });

      const health = await fetch(app.url('/healthz'));
      assert.equal(health.status, 200);
    } finally {
      await app.close();
    }
  });

  it('404s an unknown path without leaving the static read unhandled', async () => {
    // The static body read is asynchronous now, so "not an asset either" resolves
    // through a promise chain rather than a return value. The 404 must survive
    // that move, and the chain must terminate.
    const app = await boot();
    try {
      await withoutUnhandledRejections(async () => {
        const missing = await fetch(app.url('/v1/standup/identity/rolez'));
        assert.equal(missing.status, 404);
        assert.equal((await missing.json()).error, 'not_found');

        const shell = await fetch(app.url('/'));
        assert.equal(shell.status, 200);
        assert.match(shell.headers.get('content-type'), /text\/html/);
      });
    } finally {
      await app.close();
    }
  });
});

describe('atomic writes do not collide', () => {
  it('gives every attempt its own scratch path', () => {
    // The defect this replaces: `${target}.${process.pid}.tmp`, which is one name
    // for every concurrent write in the process — and for any other process
    // holding that pid, or for the stale file a crashed one left behind.
    const target = join(tmpdir(), 'arf-atomic', 'roles.json');
    const paths = new Set(Array.from({ length: 64 }, () => tempPathFor(target)));

    assert.equal(paths.size, 64);
    for (const path of paths) {
      assert.ok(path.startsWith(`${target}.`), `${path} must sit beside its target`);
      assert.ok(path.endsWith('.tmp'), `${path} must be recognisable as scratch`);
      assert.ok(!path.endsWith('.json'), `${path} must not read back as a record`);
    }
  });

  it('leaves no scratch file behind, and never reads one as a record', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arf-runstore-'));
    const store = openStandupRunStore({ stateRoot: dir });
    const record = (role) => ({
      schemaVersion: RECORD_SCHEMA_VERSION,
      role,
      runId: `run-${role}`,
      startedAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
      status: 'ok',
      params: {},
      outputs: {},
      steps: {},
    });

    store.write(record('the-hammer'));
    store.write(record('the-hammer'));
    store.write(record('other-role'));

    const left = readdirSync(store.dir).filter((entry) => entry.endsWith('.tmp'));
    assert.deepEqual(left, []);
    assert.deepEqual(store.list().map((entry) => entry.role).sort(), ['other-role', 'the-hammer']);
  });

  it('keeps concurrent role writes to one manifest whole', () => {
    // Two roles stood up against the same `rolesFile` share the target path, so
    // they shared the scratch path too. The file must still parse, and must still
    // hold both entries plus whatever the operator had in it.
    const dir = mkdtempSync(join(tmpdir(), 'arf-manifest-'));
    const path = join(dir, 'roles.json');
    writeFileSync(path, `${JSON.stringify({ roles: mappedRoles() }, null, 2)}\n`, 'utf8');

    for (const role of ['role-a', 'role-b']) {
      writeRoleMapping({
        path,
        role,
        entry: { provider: 'github_app', appId: APP_ID, installationId: INSTALLATION_ID, privateKeyRef: PRIVATE_KEY_REF },
      });
    }

    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(Object.keys(written.roles).sort(), ['role-a', 'role-b', 'the-hammer']);
    assert.deepEqual(readdirSync(dir).filter((entry) => entry.endsWith('.tmp')), []);
  });
});

describe('merging a manifest does not take it over', () => {
  const entry = {
    provider: 'github_app',
    appId: APP_ID,
    installationId: INSTALLATION_ID,
    privateKeyRef: PRIVATE_KEY_REF,
  };

  it('preserves an existing manifest ownership and mode', () => {
    // The 501:20 shape: `renameSync` replaces the inode, so a merge that did not
    // carry the old file's mode across would hand the manifest to ARF at 0600 and
    // lock out the pipeline daemon reading the same file — at the exact moment a
    // standup reported success.
    const dir = mkdtempSync(join(tmpdir(), 'arf-manifest-owned-'));
    const path = join(dir, 'roles.json');
    writeFileSync(path, `${JSON.stringify({ roles: mappedRoles() }, null, 2)}\n`, 'utf8');
    chmodSync(path, 0o640);
    const before = statSync(path);

    writeRoleMapping({ path, role: 'role-a', entry });

    const after = statSync(path);
    assert.equal(after.mode & 0o7777, 0o640, 'group read must survive the merge');
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
  });

  it('still creates a new manifest at 0600', () => {
    // Nothing is weakened for a file ARF creates: there is nobody to lock out, and
    // a mapping another account can rewrite is a way to make ARF post as something
    // else.
    const dir = mkdtempSync(join(tmpdir(), 'arf-manifest-new-'));
    const path = join(dir, 'roles.json');

    const result = writeRoleMapping({ path, role: 'role-a', entry });

    assert.equal(result.created, true);
    assert.equal(statSync(path).mode & 0o7777, 0o600);
  });
});
