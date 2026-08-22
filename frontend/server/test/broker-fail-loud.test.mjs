/**
 * The fail-loud gate (ARF-07 req 3, SPEC §4 AC#4, SPEC §6).
 *
 * This is the first-class test the ticket asks for, and it is here because of a
 * specific incident: the 2026-07-23 ambient-fallback RCA. A role with no
 * token mapping did not fail — it fell through to whatever ambient identity the
 * process happened to be carrying. The run *succeeded*, the writes were
 * attributed to the wrong actor, and the misconfiguration stayed invisible.
 *
 * So the property under test is not "an unmapped role errors". It is:
 *
 *   an unmapped role FAILS, in BOTH modes, and NO token comes back — not from a
 *   cache, not from a wildcard entry, not from the environment, not from the far
 *   broker, and not from any other role's mapping.
 *
 * Every case below is one way the old failure could come back.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BrokerConfigError, UnmappedRoleError } from '../src/broker/errors.mjs';
import { normalizeBrokerConfig } from '../src/broker/manifest.mjs';
import { createTokenBroker } from '../src/broker/token-broker.mjs';
import {
  EXTERNAL_TOKEN, MINTED_TOKEN, fakeSecretResolver, isoAt, jsonResponse, recordingFetch,
} from './helpers/broker-fixtures.mjs';

const NOW = 1_800_000_000;

const MODES = [
  {
    name: 'bundled',
    config: () => normalizeBrokerConfig({
      file: {
        mode: 'bundled',
        githubApiUrl: 'https://api.github.test',
        roles: {
          'the-hammer': {
            provider: 'github_app',
            appId: '4197249',
            installationId: '143886388',
            privateKeyRef: 'op://Vault/hammer-key/private key',
          },
        },
      },
    }),
    response: () => jsonResponse({ token: MINTED_TOKEN, expires_at: isoAt(NOW + 3600) }),
  },
  {
    name: 'external',
    config: () => normalizeBrokerConfig({
      file: {
        mode: 'external',
        endpoint: 'https://broker.arf.test',
        roles: { 'the-hammer': { scope: 'the-hammer-lacey/github_app/merge' } },
      },
    }),
    response: () => jsonResponse({ token: EXTERNAL_TOKEN, expires_at: isoAt(NOW + 3600) }),
  },
];

/**
 * A broker whose transport would happily hand back a token if it were ever
 * reached. Every assertion below therefore proves the refusal happened *before*
 * the transport, not that the transport declined.
 */
function generousBroker(mode, { config } = {}) {
  const fetchImpl = recordingFetch(async () => mode.response());
  const broker = createTokenBroker({
    config: config ?? mode.config(),
    fetchImpl,
    resolveSecret: fakeSecretResolver(),
    now: () => NOW,
  });
  return { broker, fetchImpl };
}

describe('fail-loud on a missing role -> token mapping', () => {
  for (const mode of MODES) {
    describe(`${mode.name} mode`, () => {
      it('refuses an unmapped role and returns no token', async () => {
        const { broker, fetchImpl } = generousBroker(mode);

        let caught = null;
        let returned = 'sentinel: resolveToken did not throw';
        try {
          returned = await broker.resolveToken('codex-reviewer');
        } catch (err) {
          caught = err;
        }

        assert.ok(caught instanceof UnmappedRoleError, 'the failure is the unmapped-role gate');
        assert.equal(caught.code, 'unmapped_role');
        assert.equal(caught.role, 'codex-reviewer');
        assert.equal(caught.mode, mode.name);
        assert.equal(returned, 'sentinel: resolveToken did not throw', 'nothing was returned');
        // The refusal precedes the transport: no exchange was even attempted.
        assert.equal(fetchImpl.calls.length, 0);
      });

      it('says what is wrong and what is mapped', async () => {
        const { broker } = generousBroker(mode);
        const err = await broker.resolveToken('codex-reviewer').catch((e) => e);

        assert.match(err.message, /no token mapping for role "codex-reviewer"/);
        assert.match(err.message, /the-hammer/, 'the message lists the roles that ARE mapped');
        assert.match(err.message, /ambient or default identity/);
        assert.deepEqual(err.knownRoles, ['the-hammer']);
      });

      it('does not borrow another role\'s mapping', async () => {
        const { broker, fetchImpl } = generousBroker(mode);
        // Warm the cache with a role that DOES resolve, so a fallback would have
        // something ready to hand back.
        const mapped = await broker.resolveToken('the-hammer');
        assert.ok(mapped.token);

        await assert.rejects(() => broker.resolveToken('codex-reviewer'), UnmappedRoleError);
        assert.equal(fetchImpl.calls.length, 1, 'only the mapped role ever minted');
      });

      it('ignores ambient GitHub credentials in the environment', async () => {
        // The literal shape of the old failure: a process carrying GITHUB_TOKEN
        // resolves an unmapped role and gets *something*. ARF reads no ambient
        // credential source at all — not the environment, not `gh auth`, not a
        // keychain — so setting them changes nothing.
        const restore = {};
        for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_APP_PRIVATE_KEY']) {
          restore[name] = process.env[name];
          process.env[name] = 'ghp_ambient_identity_that_must_not_be_used';
        }
        try {
          const { broker, fetchImpl } = generousBroker(mode);
          await assert.rejects(() => broker.resolveToken('codex-reviewer'), UnmappedRoleError);
          assert.equal(fetchImpl.calls.length, 0);
        } finally {
          for (const [name, value] of Object.entries(restore)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
          }
        }
      });

      it('refuses an empty, blank, or non-string role', async () => {
        const { broker, fetchImpl } = generousBroker(mode);
        for (const role of ['', '   ', null, undefined, 0, {}]) {
          await assert.rejects(() => broker.resolveToken(role), UnmappedRoleError);
        }
        assert.equal(fetchImpl.calls.length, 0);
      });

      it('reports hasRole() honestly for an unmapped role', () => {
        const { broker } = generousBroker(mode);
        assert.equal(broker.hasRole('the-hammer'), true);
        assert.equal(broker.hasRole('codex-reviewer'), false);
        assert.equal(broker.hasRole(''), false);
        assert.equal(broker.hasRole(null), false);
      });

      it('fails loud with an empty manifest rather than improvising', async () => {
        const config = normalizeBrokerConfig({
          file: mode.name === 'external'
            ? { mode: 'external', endpoint: 'https://broker.arf.test' }
            : { mode: 'bundled' },
        });
        assert.equal(config.configured, false, 'an empty manifest is reported as unconfigured');

        const { broker, fetchImpl } = generousBroker(mode, { config });
        const err = await broker.resolveToken('the-hammer').catch((e) => e);
        assert.ok(err instanceof UnmappedRoleError);
        assert.match(err.message, /no roles are mapped at all/);
        assert.equal(fetchImpl.calls.length, 0);
      });

      it('cannot be given a wildcard or catch-all mapping', () => {
        // Structural, not procedural: there is no key an unrequested role could
        // match, so the fail-loud rule cannot be forgotten at one call site.
        for (const wildcard of ['*', '', '  ', '.*', '_default']) {
          assert.throws(
            () => normalizeBrokerConfig({
              file: {
                ...(mode.name === 'external' ? { mode: 'external', endpoint: 'https://b.test' } : {}),
                roles: { [wildcard]: { scope: 's', provider: 'github_pat', tokenRef: 'env:X' } },
              },
            }),
            (err) => {
              assert.ok(err instanceof BrokerConfigError);
              assert.match(err.message, /Wildcard and catch-all role keys are refused/);
              return true;
            },
            `role key ${JSON.stringify(wildcard)} must be refused`,
          );
        }
      });
    });
  }

  it('refuses a role whose mapping was removed, even with a warm cache', async () => {
    // A live ARF can be reconfigured under a long-lived process. A grant minted
    // under the old manifest must not answer for a role the new one drops.
    const mode = MODES[0];
    const config = mode.config();
    const { broker, fetchImpl } = generousBroker(mode, { config });
    await broker.resolveToken('the-hammer');
    assert.equal(fetchImpl.calls.length, 1);

    config.roles.delete('the-hammer');
    await assert.rejects(() => broker.resolveToken('the-hammer'), UnmappedRoleError);
    assert.equal(fetchImpl.calls.length, 1, 'the warm cache did not answer for an unmapped role');
  });

  it('emits an audit record naming the unmapped role', async () => {
    const records = [];
    const broker = createTokenBroker({
      config: MODES[0].config(),
      fetchImpl: recordingFetch(async () => MODES[0].response()),
      resolveSecret: fakeSecretResolver(),
      now: () => NOW,
      logger: (record) => records.push(record),
    });
    await assert.rejects(() => broker.resolveToken('codex-reviewer'), UnmappedRoleError);

    // A silent refusal is better than an ambient fallback but worse than a loud
    // one: the operator has to be able to see WHICH role has no mapping.
    assert.deepEqual(records, [{
      event: 'broker.unmapped_role',
      mode: 'bundled',
      role: 'codex-reviewer',
      knownRoles: ['the-hammer'],
    }]);
  });

  it('external mode requires a scope, so a role cannot ask for "any identity"', () => {
    assert.throws(
      () => normalizeBrokerConfig({
        file: {
          mode: 'external',
          endpoint: 'https://broker.arf.test',
          roles: { 'the-hammer': { appId: '1', installationId: '2' } },
        },
      }),
      (err) => {
        assert.ok(err instanceof BrokerConfigError);
        assert.match(err.message, /needs a scope \(or principal\) in external mode/);
        assert.match(err.message, /default credential/);
        return true;
      },
    );
  });
});
