/**
 * ARF-05 acceptance: a re-run picks up from the last completed step.
 *
 * Resume is what makes the wizard usable for the thing it is actually for. Half
 * the standup ritual is not ARF's to perform — creating the App in a browser,
 * storing a key in a vault, getting an org owner to approve an installation — so
 * a run that stops for one of those and then starts again from scratch would
 * re-drive every GitHub call each time, and would be slower than doing it by hand.
 *
 * The properties pinned here are the ones that make resume *honest* rather than
 * merely fast:
 *
 *  - completed steps are replayed, and the run says they were replayed;
 *  - the work is genuinely not re-done (asserted on calls made, not on labels);
 *  - a step whose **inputs changed** is re-run, along with everything after it;
 *  - the two steps that assert something about the present are never replayed.
 *
 * That third one is the one worth having. Without it, correcting a typo'd app id
 * and re-running would show `Create / select GitHub App ✔` — a claim about an App
 * nobody is standing up any more — and then wire the corrected role to
 * coordinates captured from the wrong one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runIdentityStandup } from '../src/standup/identity-run.mjs';
import { normalizeStandupParams } from '../src/standup/params.mjs';
import { openStandupRunStore } from '../src/standup/run-store.mjs';
import {
  APP_ID, INSTALLATION_ID, PRIVATE_KEY_REF, TARGET_REPO, collect, framesOf, githubDouble,
  mappedRoles, standupConfig, standupParams, standupSecretResolver, tmpStateRoot,
} from './helpers/standup-fixtures.mjs';

/**
 * A standup session against one state root, so successive runs share a record.
 *
 * Each `run()` gets a fresh GitHub double, which is what lets the assertions be
 * about "did this run make that call" rather than about a cumulative tally.
 */
function session({ roles = mappedRoles(), ...rest } = {}) {
  const stateRoot = tmpStateRoot();
  const fixture = standupConfig({ stateRoot, roles, ...rest });
  const runStore = openStandupRunStore(fixture.config);

  return {
    stateRoot,
    fixture,
    runStore,
    record: () => runStore.read('the-hammer'),
    async run(params = {}, { github = githubDouble(), ...deps } = {}) {
      const events = await collect(runIdentityStandup(
        normalizeStandupParams(standupParams(params)),
        {
          config: fixture.load(),
          reloadConfig: fixture.load,
          runStore,
          fetchImpl: github,
          resolveSecret: standupSecretResolver(),
          ...deps,
        },
      ));
      return { events, github, opening: events[0].data, terminal: events.at(-1) };
    },
  };
}

/** The steps this run actually executed, as opposed to replayed. */
function executed(events) {
  return framesOf(events, 'step').filter((step) => step.status === 'running').map((step) => step.id);
}

/** The steps this run replayed from the record. */
function replayed(events) {
  return framesOf(events, 'step').filter((step) => step.resumed).map((step) => step.id);
}

describe('resuming an identity standup', () => {
  it('picks up from the last completed step', async () => {
    const app = session();

    // First attempt stops at installation: the App is not on the repo yet, which
    // is an org owner's action, not ARF's.
    const first = await app.run({}, { github: githubDouble({ installed: false }) });
    assert.equal(first.terminal.data.failedStep, 'install_app');
    assert.equal(first.terminal.data.resumable, true);
    assert.deepEqual(executed(first.events), ['create_or_select_app', 'install_app']);

    // The operator installs it. The second attempt resumes rather than restarting.
    const second = await app.run();
    assert.equal(second.terminal.event, 'complete');

    // Step 1 is replayed; everything from the failure onward is executed.
    assert.deepEqual(replayed(second.events), ['create_or_select_app']);
    assert.deepEqual(executed(second.events), [
      'install_app', 'store_secrets', 'wire_token_map', 'verify_identity',
    ]);

    // And the opening frame said so before anything ran, so the panel could paint
    // the resumed prefix immediately.
    assert.equal(second.opening.resumedFrom, 'create_or_select_app');
    assert.equal(second.opening.resumedSteps, 1);
  });

  it('does not re-do the work it replayed', async () => {
    // The claim "resumed" has to be checked against calls made, not against a
    // label: a run that replayed the step and then did it anyway would look
    // identical in the event stream.
    const app = session();
    await app.run({}, { github: githubDouble({ installed: false }) });

    const second = await app.run();
    // `GET /app` is called once — by the verification readiness check, not by
    // step 1, which was replayed.
    const appLookups = second.github.matching('/app').filter((call) => call.url.endsWith('/app'));
    assert.equal(appLookups.length, 1);
    assert.deepEqual(replayed(second.events), ['create_or_select_app']);
  });

  it('carries the replayed steps\' outputs forward', async () => {
    // A replayed step still has to supply what the later steps read from it —
    // otherwise resume would produce a run missing the coordinates it needs.
    const app = session();
    await app.run({}, { github: githubDouble({ installed: false }) });

    const second = await app.run();
    assert.equal(second.terminal.data.outputs.appId, APP_ID);
    assert.equal(second.terminal.data.outputs.botLogin, 'the-hammer[bot]');
    assert.equal(second.terminal.data.outputs.installationId, INSTALLATION_ID);
  });

  it('lets a re-run supply only the field that was missing', async () => {
    // The point of merging a re-run over the record: an operator who forgot the
    // verification target should not have to restate the whole request.
    const app = session();
    const first = await app.run({ verifyRepo: null, verifyIssue: null });
    assert.equal(first.terminal.data.failedStep, 'verify_identity');
    assert.equal(first.terminal.data.code, 'operator_input_required');

    const second = await app.run({ verifyRepo: TARGET_REPO, verifyIssue: 4242 });
    assert.equal(second.terminal.event, 'complete');
    // The App id and key ref came from the record, not from this request.
    assert.equal(second.terminal.data.outputs.appId, APP_ID);
    assert.equal(second.github.matching('/issues/4242/comments').length, 1);
  });

  it('re-runs a step whose inputs changed, and everything after it', async () => {
    // The honesty guard. A recorded `ok` is only reusable for the inputs it was
    // recorded against; otherwise a corrected app id would be wired to
    // coordinates captured for the wrong App.
    const app = session();
    await app.run();
    assert.equal(app.record().steps.create_or_select_app.status, 'ok');

    const second = await app.run({ appId: '424242' });
    // Step 1 consumed the app id, so it re-runs — and takes the rest with it.
    assert.deepEqual(replayed(second.events), []);
    assert.equal(executed(second.events)[0], 'create_or_select_app');
    // The GitHub double answers for app 887, so the mismatch is caught rather
    // than quietly captured.
    assert.equal(second.terminal.data.code, 'identity_mismatch');
    assert.match(second.terminal.data.message, /887/);
  });

  it('re-runs a later step whose own inputs changed, but keeps the prefix', async () => {
    const app = session();
    await app.run({ repos: [TARGET_REPO] });

    // Only step 2's inputs change, so step 1 is still replayable.
    const second = await app.run({ repos: ['laceyenterprises/other-repo'] });
    assert.deepEqual(replayed(second.events), ['create_or_select_app']);
    assert.equal(executed(second.events)[0], 'install_app');
    assert.equal(second.github.matching('/repos/laceyenterprises/other-repo/installation').length, 1);
  });

  it('never replays the wire and verify steps', async () => {
    // Both make claims about the present — "this mapping resolves to a token" and
    // "this identity posts as itself" — and a replayed green tick would be a
    // cached answer to a live question. A completed run re-proves both.
    const app = session();
    const first = await app.run();
    assert.equal(first.terminal.event, 'complete');
    assert.equal(app.record().steps.wire_token_map.status, 'ok');
    assert.equal(app.record().steps.verify_identity.status, 'ok');

    const second = await app.run();
    assert.equal(second.terminal.event, 'complete');
    assert.deepEqual(replayed(second.events), [
      'create_or_select_app', 'install_app', 'store_secrets',
    ]);
    assert.deepEqual(executed(second.events), ['wire_token_map', 'verify_identity']);
    // Re-proved against the world, not against the record.
    assert.equal(second.github.matching('/access_tokens').length, 1);
    assert.equal(second.github.matching('/comments').length, 1);
  });

  it('reports a replayed step as ok, and flags it as replayed', async () => {
    // The panel draws these differently, and it can only do that if the stream
    // distinguishes them. `ok` keeps the status vocabulary intact; `resumed`
    // stops the tick from over-claiming what this run verified.
    const app = session();
    await app.run({}, { github: githubDouble({ installed: false }) });
    const second = await app.run();

    const replayedStep = framesOf(second.events, 'step').find((step) => step.resumed);
    assert.equal(replayedStep.id, 'create_or_select_app');
    assert.equal(replayedStep.status, 'ok');
    assert.equal(replayedStep.resumed, true);
    // It carries the detail the original run produced, so the panel is not blank.
    assert.match(replayedStep.detail, /app_id 887/);

    // A freshly-executed ok is not flagged.
    const fresh = framesOf(second.events, 'step')
      .find((step) => step.id === 'install_app' && step.status === 'ok');
    assert.equal(fresh.resumed, false);
  });

  it('starts fresh when the record is absent, corrupt, or from another schema', async () => {
    // A record that cannot be trusted means "nothing to resume from", and the
    // right response is a clean run — not a crash on a file the operator cannot
    // be expected to have kept intact.
    const app = session();
    await app.run({}, { github: githubDouble({ installed: false }) });

    const { writeFileSync } = await import('node:fs');
    writeFileSync(app.runStore.path('the-hammer'), '{ truncated', 'utf8');
    assert.equal(app.record(), null);

    const second = await app.run();
    assert.equal(second.terminal.event, 'complete');
    assert.deepEqual(replayed(second.events), []);
    assert.equal(second.opening.resumedFrom, null);
  });

  it('exposes the recorded run over the API for the panel to show', async () => {
    const app = session();
    await app.run({}, { github: githubDouble({ installed: false }) });

    const record = app.record();
    assert.equal(record.role, 'the-hammer');
    assert.equal(record.status, 'failed');
    assert.equal(record.steps.create_or_select_app.status, 'ok');
    assert.equal(record.steps.install_app.status, 'failed');
    // The fingerprint is what the next run compares against; without it a
    // recorded `ok` would be reusable for inputs it never saw.
    assert.match(record.steps.create_or_select_app.fingerprint, /^[0-9a-f]{16}$/);
    assert.equal(record.params.privateKeyRef, PRIVATE_KEY_REF);
  });
});
