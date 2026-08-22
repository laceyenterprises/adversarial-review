/**
 * ARF-05 acceptance: the step-state machine advances and reports each step.
 *
 * The contract under test is the one the panel and any other client codes
 * against — the sequence of frames, the status vocabulary, and the fact that a
 * terminal frame always arrives. It is exercised twice: directly against the
 * generator (fast, and where the interesting assertions live) and once end to
 * end over a real socket, because "reports over SSE" is a claim about the wire
 * and not just about the machine.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parseSseBuffer } from '../../frontend/shared/sse-wire.mjs';
import { runIdentityStandup } from '../src/standup/identity-run.mjs';
import { normalizeStandupParams } from '../src/standup/params.mjs';
import { openStandupRunStore } from '../src/standup/run-store.mjs';
import { IDENTITY_STEP_IDS, STEP_STATUSES } from '../src/standup/steps.mjs';
import { createArfServer } from '../src/server.mjs';
import {
  APP_ID, BOT_LOGIN, COMMENT_URL, INSTALLATION_ID, MINTED_TOKEN, PAT_REF, PRIVATE_KEY_REF,
  VERIFY_ISSUE, collect, envSecretRefs, finalStepStatuses, framesOf, githubDouble, mappedRoles,
  mockGithubServer, standupConfig, standupParams, standupSecretResolver, tmpStateRoot,
} from './helpers/standup-fixtures.mjs';

/** Run a standup against the doubles, returning every frame it emitted. */
async function runStandup({ roles = mappedRoles(), params = {}, github = githubDouble(), ...rest } = {}) {
  const stateRoot = tmpStateRoot();
  const fixture = standupConfig({ stateRoot, roles, ...rest });
  const runStore = openStandupRunStore(fixture.config);
  const resolveSecret = standupSecretResolver();
  const events = await collect(runIdentityStandup(normalizeStandupParams(standupParams(params)), {
    config: fixture.config,
    reloadConfig: fixture.load,
    runStore,
    fetchImpl: github,
    resolveSecret,
    newRunId: () => 'run-0001',
  }));
  return { events, github, runStore, fixture, resolveSecret, stateRoot };
}

describe('identity standup step machine', () => {
  it('advances through all five steps and reports each one', async () => {
    const { events } = await runStandup();

    // One opening frame, one terminal frame, and the steps in between.
    assert.equal(events[0].event, 'run');
    assert.equal(events.at(-1).event, 'complete');
    assert.equal(framesOf(events, 'failed').length, 0);

    // The opening frame carries the whole ritual, so the panel paints it at once
    // rather than growing a list as the run proceeds.
    assert.deepEqual(events[0].data.steps.map((step) => step.id), IDENTITY_STEP_IDS);
    assert.deepEqual(
      [...new Set(events[0].data.steps.map((step) => step.status))],
      ['pending'],
    );

    // Every step reports running, then ok — in order, with no step skipped.
    const transitions = framesOf(events, 'step').map((step) => [step.id, step.status]);
    assert.deepEqual(transitions, IDENTITY_STEP_IDS.flatMap((id) => [[id, 'running'], [id, 'ok']]));

    const terminal = events.at(-1).data;
    assert.equal(terminal.status, 'ok');
    assert.equal(terminal.role, 'the-hammer');
    assert.equal(terminal.runId, 'run-0001');
  });

  it('reports only the four statuses the contract names', async () => {
    const { events } = await runStandup();
    for (const step of [...framesOf(events, 'run').flatMap((f) => f.steps), ...framesOf(events, 'step')]) {
      assert.ok(
        STEP_STATUSES.includes(step.status),
        `step ${step.id} reported "${step.status}", which is outside ${STEP_STATUSES.join('|')}`,
      );
    }
  });

  it('captures the app, installation, mapping, and attribution as it goes', async () => {
    const { events, github } = await runStandup();
    const outputs = events.at(-1).data.outputs;

    assert.equal(outputs.appId, APP_ID);
    assert.equal(outputs.botLogin, BOT_LOGIN);
    assert.equal(outputs.installationId, INSTALLATION_ID);
    assert.equal(outputs.privateKeyRef, PRIVATE_KEY_REF);
    assert.equal(outputs.patFallbackRef, PAT_REF);
    assert.equal(outputs.tokenType, 'github_app_installation');
    assert.equal(outputs.attributedLogin, BOT_LOGIN);
    assert.equal(outputs.attributedType, 'Bot');
    assert.equal(outputs.verifyCommentUrl, COMMENT_URL);

    // The lifecycle actually happened rather than being asserted into existence.
    assert.equal(github.matching('/app').length >= 1, true);
    assert.equal(github.matching(`/repos/laceyenterprises/agent-os/installation`).length, 1);
    assert.equal(github.matching('/access_tokens').length, 1);
    assert.equal(github.matching('/issues/5543/comments').length, 1);
  });

  it('never writes a secret value into the run record', async () => {
    // The record is a durable file an operator may read and a backup may copy.
    // It holds references, coordinates, and fingerprints — never material.
    const { runStore, resolveSecret } = await runStandup();
    const raw = readFileSync(runStore.path('the-hammer'), 'utf8');

    assert.match(raw, /op:\/\/Vault\/hammer-key\/private key/);
    assert.doesNotMatch(raw, /BEGIN (RSA )?PRIVATE KEY/);
    assert.doesNotMatch(raw, /ghp_/);
    assert.doesNotMatch(raw, /ghs_/);
    assert.equal(raw.includes(MINTED_TOKEN), false);
    // The resolver really was asked for both refs, so the absence above is the
    // redaction working rather than the secrets never having been resolved.
    assert.deepEqual([...new Set(resolveSecret.seen)].sort(), [PAT_REF, PRIVATE_KEY_REF].sort());
  });

  it('stops at the failing step and leaves the rest pending', async () => {
    // A failure is terminal, not something the machine works around: the steps
    // after it must not run, and must not be reported as anything but pending.
    const github = githubDouble({ installed: false });
    const { events } = await runStandup({ github });

    const statuses = finalStepStatuses(events);
    assert.equal(statuses.create_or_select_app, 'ok');
    assert.equal(statuses.install_app, 'failed');
    assert.equal(statuses.store_secrets, undefined);

    const terminal = events.at(-1).data;
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.failedStep, 'install_app');
    assert.equal(terminal.code, 'operator_input_required');
    assert.equal(terminal.resumable, true);
    // Everything downstream is reported, and reported as untouched.
    assert.deepEqual(
      terminal.steps.slice(2).map((step) => step.status),
      ['pending', 'pending', 'pending'],
    );
    // And it says what to do, which is the difference between a wizard and a 500.
    assert.match(terminal.nextAction.url, /installations\/new/);
  });

  it('refuses a post attributed to a human account', async () => {
    // Every HTTP call in this run returns 2xx. The identity is still wrong, and
    // that is exactly what the verification step exists to notice.
    const github = githubDouble({ commentUser: { login: 'paul-lacey', type: 'User' } });
    const { events } = await runStandup({ github });

    const terminal = events.at(-1).data;
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.failedStep, 'verify_identity');
    assert.equal(terminal.code, 'ambient_attribution');
    assert.match(terminal.message, /paul-lacey/);
    assert.match(terminal.message, /not the app's bot identity/);
    // Not resumable: re-running changes nothing until the mapping is corrected.
    assert.equal(terminal.resumable, false);
  });

  it('refuses to wire a mapping that points at a different identity', async () => {
    const { events } = await runStandup({ roles: mappedRoles({ installationId: '999999' }) });
    const terminal = events.at(-1).data;
    assert.equal(terminal.failedStep, 'wire_token_map');
    assert.equal(terminal.code, 'identity_mismatch');
    assert.match(terminal.message, /999999/);
  });
});

describe('identity standup over SSE', () => {
  /**
   * Boot the real ARF server against a real mock GitHub.
   *
   * Nothing is injected into `createArfServer`: it uses its own `fetch`, its own
   * secret resolver, and its own broker. Only the two things an operator would
   * genuinely configure are pointed somewhere test-local — the GitHub API base
   * and the secret refs. So this exercises the shipping path end to end.
   */
  async function boot(fixtureOptions = {}) {
    const github = await mockGithubServer(fixtureOptions.github ?? {});
    const refs = envSecretRefs();
    const stateRoot = tmpStateRoot();
    const fixture = standupConfig({
      stateRoot,
      roles: mappedRoles({ privateKeyRef: refs.privateKeyRef }),
      broker: { githubApiUrl: github.url },
      ...fixtureOptions.config,
    });
    const { server } = createArfServer({ config: fixture.config, reloadConfig: fixture.load });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
      port,
      fixture,
      github,
      refs,
      close: async () => {
        await new Promise((resolve) => server.close(resolve));
        await github.close();
      },
      url: (path) => `http://127.0.0.1:${port}${path}`,
    };
  }

  it('streams a complete run as parseable SSE frames', async () => {
    // The generator tests above cover the machine. This one covers the wire: the
    // media type, the framing, the ids, and that a client reading the response
    // body reconstructs exactly the frames the machine produced.
    const app = await boot();
    try {
      const response = await fetch(app.url('/v1/standup/identity/runs'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(standupParams(app.refs)),
      });

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/event-stream/);
      assert.match(response.headers.get('cache-control'), /no-transform/);
      assert.equal(response.headers.get('x-accel-buffering'), 'no');

      const text = await response.text();
      const { events, rest } = parseSseBuffer(text);
      // No half-frame left over: the stream ended on a frame boundary.
      assert.equal(rest.trim(), '');

      assert.equal(events[0].event, 'run');
      assert.deepEqual(events[0].data.steps.map((step) => step.id), IDENTITY_STEP_IDS);
      // Ids are monotonic, which is what makes Last-Event-ID meaningful.
      assert.deepEqual(events.map((event) => Number(event.id)), events.map((_, i) => i + 1));

      const terminal = events.at(-1);
      assert.equal(terminal.event, 'complete');
      assert.equal(terminal.data.role, 'the-hammer');
      assert.equal(terminal.data.status, 'ok');
      assert.equal(terminal.data.outputs.attributedLogin, BOT_LOGIN);

      // Every step transition arrived over the wire, in order.
      const transitions = events
        .filter((event) => event.event === 'step')
        .map((event) => [event.data.id, event.data.status]);
      assert.deepEqual(
        transitions,
        IDENTITY_STEP_IDS.flatMap((id) => [[id, 'running'], [id, 'ok']]),
      );

      // And the mock GitHub really was driven through the lifecycle.
      assert.deepEqual(
        app.github.calls.map((call) => `${call.method} ${call.path}`),
        [
          'GET /app',
          'GET /repos/laceyenterprises/agent-os/installation',
          'POST /app/installations/4155001/access_tokens',
          'GET /app',
          `POST /repos/laceyenterprises/agent-os/issues/${VERIFY_ISSUE}/comments`,
        ],
      );
    } finally {
      await app.close();
    }
  });

  it('serves the SPA shell and its shared module, and refuses a traversal', async () => {
    const app = await boot();
    try {
      const shell = await fetch(app.url('/'));
      assert.equal(shell.status, 200);
      assert.match(shell.headers.get('content-type'), /text\/html/);
      assert.match(await shell.text(), /Add remediator identity/);

      // The panel and the server share one SSE parser; the browser gets it here.
      const wire = await fetch(app.url('/shared/sse-wire.mjs'));
      assert.equal(wire.status, 200);
      assert.match(wire.headers.get('content-type'), /javascript/);

      // A path that resolves outside the frontend root is not served, and an
      // API route is not shadowed by the static handler.
      const escaped = await fetch(app.url('/../server/src/config.mjs'), { redirect: 'manual' });
      assert.notEqual(escaped.status, 200);
      assert.equal((await fetch(app.url('/version'))).status, 200);
    } finally {
      await app.close();
    }
  });

  it('serves the step catalog and the role catalog the panel renders', async () => {
    const app = await boot();
    try {
      const steps = await (await fetch(app.url('/v1/standup/identity/steps'))).json();
      assert.deepEqual(steps.steps.map((step) => step.id), IDENTITY_STEP_IDS);
      assert.deepEqual(steps.statuses, [...STEP_STATUSES]);
      // The two steps that re-prove themselves are flagged, so the panel can
      // explain why a re-run repeats them.
      assert.deepEqual(
        steps.steps.filter((step) => step.alwaysRun).map((step) => step.id),
        ['wire_token_map', 'verify_identity'],
      );

      const roles = await (await fetch(app.url('/v1/standup/identity/roles'))).json();
      assert.equal(roles.broker.mode, 'bundled');
      assert.equal(roles.broker.canWriteMappings, true);
      assert.deepEqual(roles.roles.map((entry) => entry.role), ['the-hammer']);
      assert.equal(roles.roles[0].mapped, true);
    } finally {
      await app.close();
    }
  });

  it('refuses a raw secret where a reference belongs, before a run exists', async () => {
    const app = await boot();
    try {
      const response = await fetch(app.url('/v1/standup/identity/runs'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(standupParams({
          privateKeyRef: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----',
        })),
      });

      // 400 and a JSON body, not an SSE stream: the run never started, so no
      // record exists and the material never reached a file.
      assert.equal(response.status, 400);
      assert.match(response.headers.get('content-type'), /application\/json/);
      const body = await response.json();
      assert.equal(body.error, 'secret_ref');
      assert.match(body.detail, /references only/);

      const record = await fetch(app.url('/v1/standup/identity/runs/the-hammer'));
      assert.equal(record.status, 404);
    } finally {
      await app.close();
    }
  });

  it('still 405s a write to a read route', async () => {
    // The standup route is the only POST on the surface; the rest stays read-only.
    const app = await boot();
    try {
      const response = await fetch(app.url('/healthz'), { method: 'POST' });
      assert.equal(response.status, 405);
      assert.equal((await response.json()).error, 'method_not_allowed');
    } finally {
      await app.close();
    }
  });
});
