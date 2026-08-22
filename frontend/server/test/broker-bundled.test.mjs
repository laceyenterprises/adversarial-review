/**
 * Bundled mode: ARF's own GitHub-App installation-token minter (ARF-07 req 1).
 *
 * SPEC §6 calls identity minting "the deepest coupling"; the mitigation is that
 * ARF bundles a minimal equivalent instead of importing the in-OS broker. These
 * cases pin what "minimal" still has to get right: a real RS256 assertion GitHub
 * would accept, the permanent/transient split, and a PAT fallback that cannot
 * quietly substitute identities.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BrokerPermanentError, BrokerTransientError, SecretRefError,
} from '../src/broker/errors.mjs';
import { normalizeBrokerConfig } from '../src/broker/manifest.mjs';
import { createTokenBroker } from '../src/broker/token-broker.mjs';
import {
  MINTED_TOKEN, PAT_VALUE, decodeJwt, fakeSecretResolver, isoAt, jsonResponse,
  recordingFetch, streamingResponse, verifyJwt,
} from './helpers/broker-fixtures.mjs';

const NOW = 1_800_000_000;
const GITHUB = 'https://api.github.test';

function bundledConfig(overrides = {}) {
  return normalizeBrokerConfig({
    file: {
      mode: 'bundled',
      githubApiUrl: GITHUB,
      roles: {
        'the-hammer': {
          provider: 'github_app',
          appId: '4197249',
          installationId: '143886388',
          privateKeyRef: 'op://Vault/hammer-key/private key',
          patFallbackRef: 'op://Vault/hammer-pat/credential',
        },
        'claude-reviewer': {
          provider: 'github_app',
          appId: '881',
          installationId: '4100',
          privateKeyRef: 'op://Vault/hammer-key/private key',
        },
      },
      ...overrides,
    },
  });
}

function mintOk({ token = MINTED_TOKEN, expiresIn = 3600 } = {}) {
  return recordingFetch(async () => jsonResponse({
    token,
    expires_at: isoAt(NOW + expiresIn),
    permissions: { contents: 'write', pull_requests: 'write' },
  }));
}

function broker({
  config = bundledConfig(), fetchImpl = mintOk(), resolveSecret, now, logger, sleep,
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

describe('bundled broker mode', () => {
  it('resolves an installation token for a mapped role', async () => {
    const fetchImpl = mintOk();
    const grant = await broker({ fetchImpl }).resolveToken('the-hammer');

    assert.equal(grant.role, 'the-hammer');
    assert.equal(grant.mode, 'bundled');
    assert.equal(grant.credentialSource, 'github_app_installation');
    assert.equal(grant.tokenType, 'github_app_installation');
    assert.equal(grant.appId, '4197249');
    assert.equal(grant.installationId, '143886388');
    assert.equal(grant.expiresAt, NOW + 3600);
    // The token is usable — via the one deliberate exit, not a plain field.
    assert.equal(grant.token.use((value) => value), MINTED_TOKEN);
  });

  it('exchanges a real RS256 App JWT at the installation endpoint', async () => {
    const fetchImpl = mintOk();
    await broker({ fetchImpl }).resolveToken('the-hammer');

    assert.equal(fetchImpl.calls.length, 1);
    const [{ url, init }] = fetchImpl.calls;
    assert.equal(url, `${GITHUB}/app/installations/143886388/access_tokens`);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['x-github-api-version'], '2022-11-28');
    assert.equal(init.headers.accept, 'application/vnd.github+json');

    const jwt = init.headers.authorization.replace(/^Bearer /, '');
    const { header, payload } = decodeJwt(jwt);
    assert.equal(header.alg, 'RS256');
    assert.equal(header.typ, 'JWT');
    assert.equal(payload.iss, '4197249');
    // GitHub rejects an App JWT whose iat is in the future by even a second on a
    // drifting clock, and one whose life exceeds 10 minutes.
    assert.ok(payload.iat < NOW, 'iat carries a backdated skew allowance');
    assert.ok(payload.exp - payload.iat <= 600, 'JWT life is within GitHub\'s 10-minute cap');
    // Signed by the configured key, not merely shaped like a JWT.
    assert.ok(verifyJwt(jwt), 'the assertion verifies against the App private key');
  });

  it('serves a fresh grant from cache and refreshes before the deadline', async () => {
    const fetchImpl = mintOk({ expiresIn: 3600 });
    let clock = NOW;
    const b = broker({ fetchImpl, now: () => clock });

    const first = await b.resolveToken('the-hammer');
    await b.resolveToken('the-hammer');
    assert.equal(fetchImpl.calls.length, 1, 'a fresh grant is reused');

    // Inside the 60s refresh lead the grant is no longer served, even though it
    // has not technically expired: handing out a token with seconds of life left
    // moves the failure to a call site far from the broker.
    clock = first.expiresAt - 30;
    await b.resolveToken('the-hammer');
    assert.equal(fetchImpl.calls.length, 2, 'a grant inside the lead window is re-minted');
  });

  it('counts down expiresInSeconds on a cached grant instead of freezing it', async () => {
    const fetchImpl = mintOk({ expiresIn: 3600 });
    let clock = NOW;
    const b = broker({ fetchImpl, now: () => clock });

    const grant = await b.resolveToken('the-hammer');
    assert.equal(grant.expiresInSeconds, 3600);

    // Half an hour later the same cached object is what a caller gets back. If
    // the field were captured at mint time it would still claim a full hour,
    // and a caller sizing a long operation against it would carry a token that
    // is about to 401.
    clock = NOW + 1800;
    const cached = await b.resolveToken('the-hammer');
    assert.equal(fetchImpl.calls.length, 1, 'still the cached grant, not a re-mint');
    assert.equal(cached.expiresInSeconds, 1800);
    assert.equal(grant.expiresInSeconds, 1800, 'the first handle counts down too');

    // The redacted projection is what reaches logs and API bodies, so it has to
    // carry the live value rather than a snapshot of the getter at build time.
    assert.equal(cached.redacted().expiresInSeconds, 1800);
    assert.equal(JSON.parse(JSON.stringify(cached)).expiresInSeconds, 1800);

    // Past expiry it floors at zero rather than going negative.
    clock = NOW + 7200;
    assert.equal(grant.expiresInSeconds, 0);
    // …and the absolute deadline never moves.
    assert.equal(grant.expiresAt, NOW + 3600);
  });

  it('never serves an expired grant', async () => {
    let clock = NOW;
    // Expiry tracks the clock, so the re-mint is distinguishable from a replay
    // of the first grant.
    const fetchImpl = recordingFetch(async () => jsonResponse({
      token: MINTED_TOKEN, expires_at: isoAt(clock + 3600),
    }));
    const b = broker({ fetchImpl, now: () => clock });
    const first = await b.resolveToken('the-hammer');

    clock = first.expiresAt + 1;
    const refreshed = await b.resolveToken('the-hammer');
    assert.equal(fetchImpl.calls.length, 2, 'an expired grant is re-minted, not served');
    assert.ok(refreshed.expiresAt > clock);
  });

  it('collapses concurrent resolves for one role into a single mint', async () => {
    let inflight = 0;
    let peak = 0;
    const fetchImpl = recordingFetch(async () => {
      peak = Math.max(peak, ++inflight);
      await new Promise((r) => setTimeout(r, 5));
      inflight -= 1;
      return jsonResponse({ token: MINTED_TOKEN, expires_at: isoAt(NOW + 3600) });
    });
    const b = broker({ fetchImpl });

    const grants = await Promise.all([
      b.resolveToken('the-hammer'),
      b.resolveToken('the-hammer'),
      b.resolveToken('the-hammer'),
    ]);
    assert.equal(fetchImpl.calls.length, 1, 'single-flight: one exchange, not three');
    assert.equal(peak, 1);
    assert.equal(new Set(grants).size, 1, 'all callers get the same grant');
  });

  it('keeps roles independent', async () => {
    const fetchImpl = mintOk();
    const b = broker({ fetchImpl });
    await b.resolveToken('the-hammer');
    await b.resolveToken('claude-reviewer');
    assert.deepEqual(
      fetchImpl.calls.map((call) => call.url),
      [
        `${GITHUB}/app/installations/143886388/access_tokens`,
        `${GITHUB}/app/installations/4100/access_tokens`,
      ],
    );
  });

  it('falls back to the PAT on a transient GitHub failure', async () => {
    const fetchImpl = recordingFetch(async () => jsonResponse({ message: 'Server Error' }, 503));
    const grant = await broker({ fetchImpl }).resolveToken('the-hammer');

    assert.equal(grant.credentialSource, 'github_pat_fallback');
    assert.equal(grant.tokenType, 'github_pat_classic');
    assert.equal(grant.token.use((value) => value), PAT_VALUE);
  });

  it('does NOT fall back to the PAT on a permanent failure', async () => {
    // The identity-substitution guard. A revoked or wrong App key is not a blip:
    // silently posting as a PAT instead would attribute the hammer's writes to a
    // different actor, which is the same class of failure as ambient fallback.
    const fetchImpl = recordingFetch(async () => jsonResponse(
      { message: 'Integration not found' }, 404,
    ));
    const resolveSecret = fakeSecretResolver();
    await assert.rejects(
      () => broker({ fetchImpl, resolveSecret }).resolveToken('the-hammer'),
      (err) => {
        assert.ok(err instanceof BrokerPermanentError);
        assert.match(err.message, /HTTP 404/);
        return true;
      },
    );
    assert.ok(
      !resolveSecret.seen.includes('op://Vault/hammer-pat/credential'),
      'the PAT is never even resolved on a permanent failure',
    );
  });

  it('surfaces a transient failure when no PAT fallback is mapped', async () => {
    const fetchImpl = recordingFetch(async () => jsonResponse({ message: 'Bad gateway' }, 502));
    await assert.rejects(
      () => broker({ fetchImpl }).resolveToken('claude-reviewer'),
      BrokerTransientError,
    );
  });

  it('does not buffer a huge error body from the GitHub API host', async () => {
    // Whatever is answering on the GitHub API host is not always GitHub — a
    // corporate proxy serving a multi-megabyte block page is the usual shape.
    // ARF still quotes error bodies, so the read has to be bounded.
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

  it('treats an unreachable GitHub as transient, not permanent', async () => {
    const fetchImpl = recordingFetch(async () => { throw new Error('ECONNREFUSED'); });
    const grant = await broker({ fetchImpl }).resolveToken('the-hammer');
    assert.equal(grant.credentialSource, 'github_pat_fallback');
  });

  it('falls back to the PAT when the op subprocess is interrupted', async () => {
    // The 1Password CLI is a subprocess on a machine that also runs launchd
    // jobs: a timeout kill or an EIO is a blip, not 1Password refusing the ref.
    // Classifying it as a permanent secret-ref error would fail the mint outright
    // even though a working PAT fallback is mapped.
    const inner = fakeSecretResolver();
    const resolveSecret = async (ref, context) => {
      if (String(ref) === 'op://Vault/hammer-key/private key') {
        throw new BrokerTransientError('the 1Password CLI did not complete while resolving the key');
      }
      return inner(ref, context);
    };
    const grant = await broker({ resolveSecret }).resolveToken('the-hammer');
    assert.equal(grant.credentialSource, 'github_pat_fallback');
    assert.equal(grant.token.use((value) => value), PAT_VALUE);
  });

  it('does NOT fall back when 1Password refuses the reference', async () => {
    // `op` answering "no item matched" is a mapping/config error. Substituting a
    // PAT there would hide a misconfiguration behind the wrong identity.
    const inner = fakeSecretResolver();
    const resolveSecret = async (ref, context) => {
      if (String(ref) === 'op://Vault/hammer-key/private key') {
        throw new SecretRefError('1Password could not resolve op://Vault/hammer-key/private key');
      }
      return inner(ref, context);
    };
    await assert.rejects(
      () => broker({ resolveSecret }).resolveToken('the-hammer'),
      SecretRefError,
    );
  });

  it('resolves a github_pat role directly from its secret ref', async () => {
    const config = normalizeBrokerConfig({
      file: {
        mode: 'bundled',
        roles: { argus: { provider: 'github_pat', tokenRef: 'op://Vault/hammer-pat/credential' } },
      },
    });
    const fetchImpl = recordingFetch(async () => {
      throw new Error('a github_pat role must not call GitHub');
    });
    const grant = await broker({ config, fetchImpl }).resolveToken('argus');

    assert.equal(grant.credentialSource, 'github_pat');
    assert.equal(grant.token.use((value) => value), PAT_VALUE);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('rejects an unusable private key permanently, naming the ref not the material', async () => {
    const resolveSecret = fakeSecretResolver({
      'op://Vault/hammer-key/private key': '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----',
    });
    await assert.rejects(
      () => broker({ resolveSecret }).resolveToken('claude-reviewer'),
      (err) => {
        assert.ok(err instanceof BrokerPermanentError);
        assert.match(err.message, /op:\/\/Vault\/hammer-key\/private key/);
        assert.ok(!err.message.includes('not-a-key'), 'the key material is not echoed');
        return true;
      },
    );
  });

  it('describes the seam with refs and coordinates only', async () => {
    const b = broker();
    await b.resolveToken('the-hammer');
    const described = b.describe();

    assert.equal(described.mode, 'bundled');
    assert.equal(described.configured, true);
    assert.equal(described.githubApiUrl, GITHUB);
    const hammer = described.roles.find((role) => role.role === 'the-hammer');
    assert.deepEqual(hammer.secretRefs, [
      'op://Vault/hammer-key/private key',
      'op://Vault/hammer-pat/credential',
    ]);
    assert.equal(hammer.cached, true);
    assert.equal(described.roles.find((role) => role.role === 'claude-reviewer').cached, false);
  });
});
