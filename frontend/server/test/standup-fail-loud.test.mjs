/**
 * ARF-05 acceptance: a run with no role -> token mapping FAILS at the wire step,
 * and never falls back to an ambient identity.
 *
 * This is the ticket's headline property and SPEC §6's recorded RCA (2026-07-23):
 * a role with no token mapping did not fail — it fell through to whatever
 * identity the process happened to be carrying. The run looked successful, the
 * writes were attributed to the wrong actor, and the misconfiguration stayed
 * invisible because nothing about the output said which identity had acted.
 *
 * ARF-07 enforces the refusal at the credential seam. What ARF-05 has to prove is
 * that the *wizard* surfaces it rather than swallowing it — so the assertions
 * here are deliberately about behaviour that would still be observable if
 * someone added a well-meaning `catch` to the wire step:
 *
 *  - the run terminates as `failed`, at `wire_token_map`;
 *  - the verify step never runs, so no post is attributed to anyone;
 *  - **no HTTP request is made with any credential at all** after the refusal;
 *  - the ambient credentials that would have been available are provably ignored.
 *
 * The last one is the one that matters. A test that only checks the error message
 * would pass against an implementation that failed loudly *and then* posted
 * anyway, which is exactly the shape of the original incident.
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { UnmappedRoleError, openTokenBroker } from '../src/broker/index.mjs';
import { runIdentityStandup } from '../src/standup/identity-run.mjs';
import { normalizeStandupParams } from '../src/standup/params.mjs';
import { openStandupRunStore } from '../src/standup/run-store.mjs';
import {
  APP_ID, BOT_LOGIN, INSTALLATION_ID, PRIVATE_KEY_REF, collect, finalStepStatuses, framesOf,
  githubDouble, mappedRoles, standupConfig, standupParams, standupSecretResolver, tmpStateRoot,
} from './helpers/standup-fixtures.mjs';

/**
 * Ambient credentials, present in the environment for the whole of this file.
 *
 * Their presence is the point. Every variable here is one a tool in this
 * ecosystem would happily authenticate with, and the assertions below hold *while
 * they are set* — so "the run did not post" cannot be explained away by there
 * being nothing to post with.
 */
const AMBIENT = {
  GITHUB_TOKEN: 'ghp_AMBIENT_MUST_NEVER_BE_USED_0001',
  GH_TOKEN: 'ghp_AMBIENT_MUST_NEVER_BE_USED_0002',
  GITHUB_APP_PRIVATE_KEY: 'ghp_AMBIENT_MUST_NEVER_BE_USED_0003',
  ARF_BROKER_DEFAULT_TOKEN: 'ghp_AMBIENT_MUST_NEVER_BE_USED_0004',
};
const saved = {};

before(() => {
  for (const [key, value] of Object.entries(AMBIENT)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});

after(() => {
  for (const key of Object.keys(AMBIENT)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/**
 * Run a standup for an unmapped role.
 *
 * `withRolesFile: false` is the honest form of "there is no mapping and nowhere
 * to make one": the broker has no entry for the role, and ARF has no manifest it
 * owns to write one into. Nothing about the request is otherwise deficient — the
 * App exists, the key resolves, the installation is real — so the only reason
 * this run can fail is the missing mapping.
 */
async function runUnmapped({ roles = null, withRolesFile = false, params = {} } = {}) {
  const stateRoot = tmpStateRoot();
  const fixture = standupConfig({ stateRoot, roles, withRolesFile });
  const runStore = openStandupRunStore(fixture.config);
  const github = githubDouble();
  const events = await collect(runIdentityStandup(normalizeStandupParams(standupParams(params)), {
    config: fixture.config,
    reloadConfig: fixture.load,
    runStore,
    fetchImpl: github,
    resolveSecret: standupSecretResolver(),
    newRunId: () => 'run-unmapped',
  }));
  return { events, github, runStore, fixture, stateRoot };
}

describe('a standup with no role -> token mapping', () => {
  it('FAILS at the wire step', async () => {
    const { events } = await runUnmapped();

    const terminal = events.at(-1);
    assert.equal(terminal.event, 'failed');
    assert.equal(terminal.data.status, 'failed');
    assert.equal(terminal.data.failedStep, 'wire_token_map');
    assert.equal(terminal.data.code, 'token_map_unavailable');

    const statuses = finalStepStatuses(events);
    assert.equal(statuses.create_or_select_app, 'ok');
    assert.equal(statuses.install_app, 'ok');
    assert.equal(statuses.store_secrets, 'ok');
    assert.equal(statuses.wire_token_map, 'failed');

    // The steps before it succeeded, which is what makes this a clean isolation:
    // the run had everything it needed except a mapping.
    assert.equal(terminal.data.outputs.appId, APP_ID);
    assert.equal(terminal.data.outputs.installationId, INSTALLATION_ID);
  });

  it('never runs the verify step, so nothing is posted as anyone', async () => {
    const { events, github } = await runUnmapped();

    // The verify step is not merely failed — it is never entered. There is no
    // `running` frame for it, and it reports `pending` in the terminal snapshot.
    assert.equal(framesOf(events, 'step').some((step) => step.id === 'verify_identity'), false);
    const verify = events.at(-1).data.steps.find((step) => step.id === 'verify_identity');
    assert.equal(verify.status, 'pending');

    // And no post happened. This is the assertion the RCA is about.
    assert.deepEqual(github.matching('/comments'), []);
  });

  it('makes no credentialed request at all after the refusal', async () => {
    const { github } = await runUnmapped();

    // No installation token was ever minted, so there was no `ghs_` in the
    // process to misuse — the refusal happens before the exchange, not after it.
    assert.deepEqual(github.matching('/access_tokens'), []);

    // Every call that *was* made is an App-JWT read of the App's own identity.
    // Not one carries an ambient credential.
    for (const call of github.calls) {
      const authorization = call.init?.headers?.authorization ?? '';
      assert.match(authorization, /^Bearer ey/, `unexpected credential on ${call.url}`);
      for (const secret of Object.values(AMBIENT)) {
        assert.equal(
          authorization.includes(secret), false,
          `an ambient credential reached ${call.url}`,
        );
      }
    }
  });

  it('says which roles ARF does know about, and what to do', async () => {
    // The error is actionable rather than merely correct: an operator seeing it
    // should not have to go and read the broker's config to find out what ARF
    // thought the world looked like.
    const { events } = await runUnmapped({ roles: null, withRolesFile: false });
    const { message, nextAction, resumable } = events.at(-1).data;

    assert.match(message, /no role -> token mapping/);
    assert.match(message, /no roles are mapped at all/);
    assert.match(message, /will not verify, post, or act under an ambient or default identity/);
    assert.ok(nextAction.summary);
    // Re-running changes nothing until the operator configures a manifest, and
    // reporting it as resumable would send them round a loop.
    assert.equal(resumable, false);
  });

  it('is the same refusal the broker seam makes at the credential', async () => {
    // The wizard's gate and ARF-07's gate are the same rule stated at two
    // depths, and this pins the lower one directly so the assertions above are
    // known to be about propagation rather than coincidence: with a manifest
    // that maps a *different* role, asking for this one throws rather than
    // returning the other role's credential.
    const fixture = standupConfig({
      stateRoot: tmpStateRoot(),
      roles: { 'some-other-role': { provider: 'github_pat', tokenRef: PRIVATE_KEY_REF } },
    });
    await assert.rejects(
      () => openTokenBroker(fixture.config).resolveToken('the-hammer'),
      (err) => {
        assert.ok(err instanceof UnmappedRoleError);
        assert.deepEqual(err.knownRoles, ['some-other-role']);
        return true;
      },
    );
  });

  it('fails the run when the mapping cannot be recorded, rather than proceeding', async () => {
    // A manifest ARF is configured to own but cannot write to. The run must stop
    // here: an unrecorded mapping means the next process has no mapping, and
    // verifying anyway would be certifying an identity that does not persist.
    const stateRoot = tmpStateRoot();
    const locked = join(stateRoot, 'locked');
    mkdirSync(locked, { mode: 0o555 });
    const fixture = standupConfig({
      stateRoot,
      roles: null,
      broker: { rolesFile: join(locked, 'roles.json') },
    });
    const github = githubDouble();

    const events = await collect(runIdentityStandup(normalizeStandupParams(standupParams()), {
      config: fixture.config,
      reloadConfig: fixture.load,
      runStore: openStandupRunStore(fixture.config),
      fetchImpl: github,
      resolveSecret: standupSecretResolver(),
    }));

    const terminal = events.at(-1).data;
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.failedStep, 'wire_token_map');
    assert.match(terminal.message, /could not be written/);
    // Stopped, and nothing acted: no token minted, no post attributed to anyone.
    assert.deepEqual(github.matching('/access_tokens'), []);
    assert.deepEqual(github.matching('/comments'), []);
  });

  it('records the failure without recording a mapping', async () => {
    const { runStore, fixture } = await runUnmapped();
    const record = runStore.read('the-hammer');

    assert.equal(record.status, 'failed');
    assert.equal(record.steps.wire_token_map.status, 'failed');
    assert.equal(record.steps.wire_token_map.code, 'token_map_unavailable');
    // The run's prefix is still resumable — that is the point of persisting it —
    // but nothing about a credential or a mapping was written.
    assert.equal(record.steps.store_secrets.status, 'ok');
    assert.equal(record.outputs.tokenType, undefined);

    // And no manifest was conjured up on the side.
    assert.throws(() => readFileSync(fixture.rolesFile, 'utf8'), /ENOENT/);
  });

  it('wires and verifies once a mapping exists — the refusal is about the mapping', async () => {
    // The negative control. Same request, same doubles, same everything except
    // that the role is now mapped: it completes. Without this, every assertion
    // above would also pass against a wizard that simply never worked.
    const { events, github } = await runUnmapped({ roles: mappedRoles(), withRolesFile: true });

    assert.equal(events.at(-1).event, 'complete');
    assert.equal(events.at(-1).data.outputs.attributedLogin, BOT_LOGIN);
    assert.equal(github.matching('/access_tokens').length, 1);
    assert.equal(github.matching('/comments').length, 1);
  });
});

describe('the wire step writing a mapping', () => {
  it('records the mapping and verifies against a broker reloaded from disk', async () => {
    // The other half of the wire step: when ARF *does* have a manifest, it writes
    // the mapping, reloads from disk, and only then resolves a token — so what
    // the operator sees succeed is what a restarted ARF would see.
    const { events, fixture } = await runUnmapped({ roles: null, withRolesFile: true });

    assert.equal(events.at(-1).event, 'complete');
    const wire = framesOf(events, 'step').find(
      (step) => step.id === 'wire_token_map' && step.status === 'ok',
    );
    assert.match(wire.detail, /created mapping/);

    const written = JSON.parse(readFileSync(fixture.rolesFile, 'utf8'));
    assert.deepEqual(written.roles['the-hammer'], {
      provider: 'github_app',
      appId: APP_ID,
      installationId: INSTALLATION_ID,
      privateKeyRef: PRIVATE_KEY_REF,
      patFallbackRef: 'op://Vault/hammer-pat/credential',
    });

    // A reference, not a value — the manifest is as safe to read as the config.
    const raw = readFileSync(fixture.rolesFile, 'utf8');
    assert.doesNotMatch(raw, /BEGIN (RSA )?PRIVATE KEY/);
    assert.doesNotMatch(raw, /ghs_|ghp_/);
  });

  it('preserves other roles already in the manifest', async () => {
    // A standup for one role must not take the rest of the fleet's identities
    // down with it.
    const { events, fixture } = await runUnmapped({
      roles: { argus: { provider: 'github_pat', tokenRef: 'op://Vault/argus/credential' } },
      withRolesFile: true,
    });

    assert.equal(events.at(-1).event, 'complete');
    const written = JSON.parse(readFileSync(fixture.rolesFile, 'utf8'));
    assert.deepEqual(Object.keys(written.roles).sort(), ['argus', 'the-hammer']);
    assert.equal(written.roles.argus.tokenRef, 'op://Vault/argus/credential');
  });
});
