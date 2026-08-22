/**
 * External mode: point ARF at a broker that already exists (ARF-07 req 1).
 *
 * The same `resolveToken(role)` seam, a different transport. The cases that
 * matter beyond the happy path are the ones where a broker answers with
 * *something* — because "something" is how an ambient default gets in.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AmbientIdentityRefusedError, BrokerPermanentError, BrokerTransientError,
} from '../src/broker/errors.mjs';
import { normalizeBrokerConfig } from '../src/broker/manifest.mjs';
import { createTokenBroker } from '../src/broker/token-broker.mjs';
import {
  BROKER_AUTH_VALUE, EXTERNAL_TOKEN, fakeSecretResolver, isoAt, jsonResponse, recordingFetch,
  streamingResponse,
} from './helpers/broker-fixtures.mjs';

const NOW = 1_800_000_000;
const ENDPOINT = 'https://broker.arf.test';

function externalConfig(overrides = {}) {
  return normalizeBrokerConfig({
    file: {
      mode: 'external',
      endpoint: ENDPOINT,
      endpointTokenRef: 'op://Vault/broker-auth/credential',
      roles: {
        'the-hammer': {
          scope: 'the-hammer-lacey/github_app/merge',
          principal: 'the-hammer-lacey',
          appId: '4197249',
          installationId: '143886388',
        },
        'claude-reviewer': { scope: 'lacey-claude-reviewer/github_app/review' },
      },
      ...overrides,
    },
  });
}

function tokenOk(body = {}) {
  return recordingFetch(async () => jsonResponse({
    token: EXTERNAL_TOKEN,
    expires_at: isoAt(NOW + 3600),
    ...body,
  }));
}

function broker({
  config = externalConfig(), fetchImpl = tokenOk(), resolveSecret, now, logger, sleep,
} = {}) {
  return createTokenBroker({
    config,
    fetchImpl,
    resolveSecret: resolveSecret ?? fakeSecretResolver(),
    now: now ?? (() => NOW),
    // Backoff is bounded and correct by construction (`retry.test.mjs` pins the
    // schedule); spending it in wall-clock here would only slow the suite.
    sleep: sleep ?? (async () => {}),
    logger,
  });
}

describe('external broker mode', () => {
  it('resolves a token via the configured endpoint for a mapped role', async () => {
    const fetchImpl = tokenOk();
    const grant = await broker({ fetchImpl }).resolveToken('the-hammer');

    assert.equal(grant.mode, 'external');
    assert.equal(grant.credentialSource, 'external_broker');
    assert.equal(grant.scope, 'the-hammer-lacey/github_app/merge');
    assert.equal(grant.expiresAt, NOW + 3600);
    assert.equal(grant.token.use((value) => value), EXTERNAL_TOKEN);

    assert.equal(fetchImpl.calls.length, 1);
    const [{ url, init }] = fetchImpl.calls;
    assert.equal(url, `${ENDPOINT}/token`);
    assert.equal(init.method, 'POST');
    // The request names the identity explicitly. A request that did not could
    // only be answered by whatever the broker considers its default.
    assert.deepEqual(JSON.parse(init.body), {
      role: 'the-hammer',
      provider: 'external',
      scope: 'the-hammer-lacey/github_app/merge',
      principal: 'the-hammer-lacey',
    });
    assert.equal(init.headers.authorization, `Bearer ${BROKER_AUTH_VALUE}`);
  });

  it('accepts the access_token / expiresAt spellings', async () => {
    const fetchImpl = recordingFetch(async () => jsonResponse({
      access_token: EXTERNAL_TOKEN,
      expiresAt: NOW + 900,
      credential_source: 'oauth_broker.github_app',
    }));
    const grant = await broker({ fetchImpl }).resolveToken('claude-reviewer');
    assert.equal(grant.expiresAt, NOW + 900);
    assert.equal(grant.credentialSource, 'oauth_broker.github_app');
  });

  it('refuses a credential minted for a different identity', async () => {
    // The ambient-fallback failure relocated across a socket: a broker that does
    // not recognise the request and answers with its own default. Using the
    // token would attribute ARF's writes to an identity it never asked for.
    for (const [field, value] of [
      ['role', 'some-other-role'],
      ['scope', 'default/github_app/all'],
      ['principal', 'agent-os-integrator'],
    ]) {
      const fetchImpl = tokenOk({ [field]: value });
      await assert.rejects(
        () => broker({ fetchImpl }).resolveToken('the-hammer'),
        (err) => {
          assert.ok(err instanceof AmbientIdentityRefusedError);
          assert.equal(err.field, field);
          assert.equal(err.actual, value);
          assert.equal(err.role, 'the-hammer');
          return true;
        },
      );
    }
  });

  it('accepts a response that echoes the identity it was asked for', async () => {
    const fetchImpl = tokenOk({
      role: 'the-hammer',
      scope: 'the-hammer-lacey/github_app/merge',
      principal: 'the-hammer-lacey',
    });
    const grant = await broker({ fetchImpl }).resolveToken('the-hammer');
    assert.equal(grant.role, 'the-hammer');
  });

  it('does not cache a refused credential', async () => {
    const fetchImpl = tokenOk({ role: 'someone-else' });
    const b = broker({ fetchImpl });
    await assert.rejects(() => b.resolveToken('the-hammer'), AmbientIdentityRefusedError);
    await assert.rejects(() => b.resolveToken('the-hammer'), AmbientIdentityRefusedError);
    assert.equal(fetchImpl.calls.length, 2, 'a refusal leaves nothing behind to serve');
  });

  it('treats a broker that does not know the role as permanent, not retryable', async () => {
    const fetchImpl = recordingFetch(async () => jsonResponse({ error: 'unknown scope' }, 404));
    await assert.rejects(
      () => broker({ fetchImpl }).resolveToken('claude-reviewer'),
      (err) => {
        assert.ok(err instanceof BrokerPermanentError);
        assert.match(err.message, /no mapping for role "claude-reviewer"/);
        return true;
      },
    );
  });

  it('classifies 5xx, 429 and transport faults as transient', async () => {
    for (const status of [500, 502, 503, 429, 408]) {
      const fetchImpl = recordingFetch(async () => jsonResponse({ message: 'later' }, status));
      await assert.rejects(
        () => broker({ fetchImpl }).resolveToken('claude-reviewer'),
        BrokerTransientError,
      );
    }
    const unreachable = recordingFetch(async () => { throw new Error('ECONNREFUSED'); });
    await assert.rejects(
      () => broker({ fetchImpl: unreachable }).resolveToken('claude-reviewer'),
      BrokerTransientError,
    );
  });

  it('does not buffer a huge upstream error body on its way to an error', async () => {
    // A proxy in front of the broker answering 502 with a 64 MiB HTML page is
    // an upstream misconfiguration; buffering it would make it an ARF OOM.
    // A fresh response per call, because 502 is retried: the cap has to hold on
    // every attempt, not just the first, or a retried blip is a multiplied OOM.
    const chunks = Array.from({ length: 64 }, () => new Uint8Array(1024 * 1024).fill(0x61));
    const metas = [];
    const fetchImpl = recordingFetch(async () => {
      const made = streamingResponse(chunks, { status: 502 });
      metas.push(made.meta);
      return made.response;
    });
    await assert.rejects(
      () => broker({ fetchImpl }).resolveToken('claude-reviewer'),
      BrokerTransientError,
    );
    assert.ok(metas.length >= 1);
    for (const meta of metas) {
      assert.ok(meta.pulled < 4 * 1024 * 1024, `body read stayed bounded (pulled ${meta.pulled})`);
      assert.equal(meta.cancelled, true, 'the reader is released once the cap is hit');
    }
  });

  it('refuses an already-expired or malformed grant', async () => {
    const expired = tokenOk({ expires_at: isoAt(NOW - 60) });
    await assert.rejects(
      () => broker({ fetchImpl: expired }).resolveToken('claude-reviewer'),
      /already-expired/,
    );

    // Both spellings are checked, not just the ISO one: an epoch-seconds
    // `expiresAt` in the past is the same worthless grant.
    const expiredEpoch = recordingFetch(async () => jsonResponse({
      token: EXTERNAL_TOKEN, expiresAt: NOW - 60,
    }));
    await assert.rejects(
      () => broker({ fetchImpl: expiredEpoch }).resolveToken('claude-reviewer'),
      /already-expired/,
    );

    const noExpiry = recordingFetch(async () => jsonResponse({ token: EXTERNAL_TOKEN }));
    await assert.rejects(
      () => broker({ fetchImpl: noExpiry }).resolveToken('claude-reviewer'),
      /no expires_at/,
    );

    const noToken = recordingFetch(async () => jsonResponse({ expires_at: isoAt(NOW + 60) }));
    await assert.rejects(
      () => broker({ fetchImpl: noToken }).resolveToken('claude-reviewer'),
      /token is missing/,
    );

    const notJson = recordingFetch(async () => jsonResponse('<html>proxy</html>'));
    await assert.rejects(
      () => broker({ fetchImpl: notJson }).resolveToken('claude-reviewer'),
      /invalid JSON/,
    );
  });

  it('caches and single-flights the same way bundled mode does', async () => {
    const fetchImpl = tokenOk();
    const b = broker({ fetchImpl });
    await Promise.all([b.resolveToken('the-hammer'), b.resolveToken('the-hammer')]);
    await b.resolveToken('the-hammer');
    assert.equal(fetchImpl.calls.length, 1);

    b.invalidate('the-hammer');
    await b.resolveToken('the-hammer');
    assert.equal(fetchImpl.calls.length, 2, 'invalidate() drops the cached grant');
  });

  it('honours a per-role endpoint override', async () => {
    const config = normalizeBrokerConfig({
      file: {
        mode: 'external',
        endpoint: ENDPOINT,
        roles: {
          'the-hammer': { scope: 'hammer/merge', endpoint: 'https://other.broker.test/' },
        },
      },
    });
    const fetchImpl = tokenOk();
    await broker({ config, fetchImpl }).resolveToken('the-hammer');
    assert.equal(fetchImpl.calls[0].url, 'https://other.broker.test/token');
    // No endpointTokenRef configured — no Authorization header invented.
    assert.equal(fetchImpl.calls[0].init.headers.authorization, undefined);
  });

  it('describes the seam without exposing the endpoint credential', () => {
    const described = broker().describe();
    assert.equal(described.mode, 'external');
    assert.equal(described.endpoint, ENDPOINT);
    assert.equal(described.endpointTokenRef, 'op://Vault/broker-auth/credential');
    assert.equal(described.githubApiUrl, null, 'bundled-only settings are not implied');
    assert.deepEqual(described.roles.map((role) => role.role), ['the-hammer', 'claude-reviewer']);
  });
});
