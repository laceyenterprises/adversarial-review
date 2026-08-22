/**
 * The `ar-standup` HTTP surface and the Screen C panel it serves (ARF-06).
 *
 * Covers the routes, the SSE step stream the panel consumes, and the two guards
 * that stand between "ARF is bound to localhost" and "a web page the operator
 * has open can stand up a harness".
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createArfServer } from '../src/server.mjs';
import { createHarnessStandup } from '../src/standup/harness-wizard.mjs';
import { FRONTEND_ROOT } from '../src/ui.mjs';
import {
  fakeBinary, fakeBroker, fakeExecFile, harnessSpec, testConfig, tmpStateRoot, withConfigFile,
} from './helpers/standup-fixtures.mjs';

/** Boot a real server on an ephemeral port with an injected standup service. */
async function boot({ broker = fakeBroker() } = {}) {
  const stateRoot = tmpStateRoot();
  const binDir = join(stateRoot, 'bin');
  fakeBinary(binDir, 'claude');
  const config = testConfig(withConfigFile(stateRoot, {
    standup: { runtimeSearchPath: [binDir] },
  }));
  const standup = createHarnessStandup({
    config,
    broker,
    execFileImpl: fakeExecFile({ claude: { stdout: 'claude 1.4.2\n' } }),
    env: { PATH: '' },
  });
  const { server } = createArfServer({ config, standup });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    config,
    close: () => new Promise((resolve) => server.close(resolve)),
    async json(path, init) {
      const res = await fetch(`${base}${path}`, init);
      const type = res.headers.get('content-type') ?? '';
      return { status: res.status, type, body: type.includes('json') ? await res.json() : await res.text() };
    },
    post(body, init = {}) {
      return fetch(`${base}/api/standup/harness/runs`, {
        method: 'POST',
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
        body: JSON.stringify(body),
      });
    },
  };
}

/** Read an SSE response into `{event, data}` records. */
async function readEvents(response) {
  const text = await response.text();
  return text.split('\n\n').filter((frame) => frame.trim() !== '').flatMap((frame) => {
    let event = 'message';
    const data = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data.push(line.slice(6));
    }
    return data.length ? [{ event, data: JSON.parse(data.join('\n')) }] : [];
  });
}

describe('ar-standup API', () => {
  it('describes registered harnesses, the allowlist, and the mapped broker roles', async () => {
    const app = await boot();
    try {
      const { status, body } = await app.json('/api/standup/harness');
      assert.equal(status, 200);
      assert.deepEqual(body.harnesses, []);
      assert.deepEqual(body.allowlist.entries, []);
      assert.equal(body.paths.manifest, app.config.standup.harnessManifestPath);
      // The panel offers roles that are actually mapped rather than inviting an
      // operator to type one that fails loud at step 2.
      assert.deepEqual(body.broker.roles.map((role) => role.role), ['claude-reviewer']);
      assert.equal(body.runtime.allowInstall, false);
    } finally {
      await app.close();
    }
  });

  it('serves the catalog templates the panel prefills from', async () => {
    const app = await boot();
    try {
      const { status, body } = await app.json('/api/standup/harness/catalog');
      assert.equal(status, 200);
      assert.ok(body.templates.length > 0);
      assert.ok(body.templates.some((template) => template.spec.modelAuth.mode === 'standalone-token'));
    } finally {
      await app.close();
    }
  });

  it('runs a standup as JSON and reflects it in the next describe()', async () => {
    const app = await boot();
    try {
      const res = await app.post({ harness: harnessSpec() });
      assert.equal(res.status, 200);
      const summary = await res.json();
      assert.equal(summary.status, 'ready');
      assert.equal(summary.harness.reviewerAllowlist.verified, true);

      const { body } = await app.json('/api/standup/harness');
      assert.equal(body.harnesses.length, 1);
      assert.equal(body.allowlist.entries[0].login, 'claude-reviewer[bot]');
    } finally {
      await app.close();
    }
  });

  it('answers a run that failed a step with 422, not 200', async () => {
    // A client that checks `res.ok` must not read an unwired allowlist as a
    // success. The request was fine; the standup was not.
    const app = await boot({ broker: fakeBroker({ roles: [] }) });
    try {
      const res = await app.post({ harness: harnessSpec() });
      assert.equal(res.status, 422);
      const summary = await res.json();
      assert.equal(summary.status, 'failed');
      assert.equal(summary.failedStep, 'provision-model-auth');
    } finally {
      await app.close();
    }
  });

  it('streams steps as SSE when the client asks for an event stream', async () => {
    const app = await boot();
    try {
      const res = await app.post(
        { harness: harnessSpec() },
        { headers: { accept: 'text/event-stream' } },
      );
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
      const events = await readEvents(res);
      assert.deepEqual(
        events.map((event) => event.event),
        [
          'run.start',
          'step.start', 'step.ok', 'step.start', 'step.ok', 'step.start', 'step.ok',
          'step.start', 'step.ok', 'step.start', 'step.ok',
          'run.done',
        ],
      );
      assert.equal(events.at(-1).data.status, 'ready');
    } finally {
      await app.close();
    }
  });

  it('rejects a malformed spec with 400 before it opens a stream', async () => {
    // A 400 is easier to notice and easier to script against than an event
    // stream whose first frame is a validation error.
    const app = await boot();
    try {
      const res = await app.post(
        { harness: { ...harnessSpec(), entitlement: '' } },
        { headers: { accept: 'text/event-stream' } },
      );
      assert.equal(res.status, 400);
      assert.match(res.headers.get('content-type'), /application\/json/);
      const body = await res.json();
      assert.equal(body.error, 'harness_manifest');
      assert.match(body.detail, /harness\.entitlement/);
    } finally {
      await app.close();
    }
  });

  it('refuses a non-JSON content type and a cross-origin POST', async () => {
    const app = await boot();
    try {
      const plain = await fetch(`${app.base}/api/standup/harness/runs`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ harness: harnessSpec() }),
      });
      // A `text/plain` POST needs no CORS preflight, which is exactly why it is
      // the shape a hostile page would use.
      assert.equal(plain.status, 415);

      const crossOrigin = await app.post(
        { harness: harnessSpec() },
        { headers: { origin: 'http://evil.example' } },
      );
      assert.equal(crossOrigin.status, 403);
      assert.equal((await crossOrigin.json()).error, 'forbidden_origin');
    } finally {
      await app.close();
    }
  });

  it('caps the request body and refuses other methods on the run route', async () => {
    const app = await boot();
    try {
      const huge = await fetch(`${app.base}/api/standup/harness/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ harness: harnessSpec(), padding: 'x'.repeat(70 * 1024) }),
      });
      assert.equal(huge.status, 413);

      const wrongMethod = await app.json('/api/standup/harness/runs');
      assert.equal(wrongMethod.status, 405);
    } finally {
      await app.close();
    }
  });

  it('404s an unknown standup route as JSON', async () => {
    const app = await boot();
    try {
      const { status, body } = await app.json('/api/standup/nope');
      assert.equal(status, 404);
      assert.equal(body.error, 'not_found');
    } finally {
      await app.close();
    }
  });
});

describe('Screen C panel assets', () => {
  it('serves the panel and its module and stylesheet', async () => {
    const app = await boot();
    try {
      const page = await app.json('/ui/');
      assert.equal(page.status, 200);
      assert.match(page.type, /text\/html/);
      assert.match(page.body, /Standup <span class="crumb">› Add harness<\/span>/);

      const script = await app.json('/ui/harness-panel.mjs');
      assert.match(script.type, /text\/javascript/);
      assert.match(script.body, /api\/standup\/harness\/runs/);

      const styles = await app.json('/ui/arf.css');
      assert.match(styles.type, /text\/css/);

      const redirect = await fetch(`${app.base}/ui`, { redirect: 'manual' });
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get('location'), '/ui/');
    } finally {
      await app.close();
    }
  });

  it('refuses to serve outside the frontend root', async () => {
    const app = await boot();
    try {
      for (const path of ['/ui/../server/package.json', '/ui/%2e%2e/server/src/config.mjs']) {
        const res = await app.json(path);
        assert.equal(res.status, 404, `${path} is not served`);
      }
    } finally {
      await app.close();
    }
  });

  it('leaves / to the identity standup shell', async () => {
    const app = await boot();
    try {
      const page = await app.json('/');
      assert.equal(page.status, 200);
      assert.match(page.body, /Add remediator identity/);
    } finally {
      await app.close();
    }
  });

  it('renders every step the wizard actually runs', async () => {
    // A panel with a step list that has drifted from the wizard would show a
    // run stalling on a step that no longer exists — or, worse, quietly not
    // show the allowlist steps at all.
    const { HARNESS_STANDUP_STEPS } = await import('../src/standup/harness-wizard.mjs');
    const html = readFileSync(join(FRONTEND_ROOT, 'harness.html'), 'utf8');
    for (const step of HARNESS_STANDUP_STEPS) {
      assert.match(html, new RegExp(`data-step="${step}"`), `the panel renders ${step}`);
    }
  });
});
