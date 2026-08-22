/**
 * "No code path logs or returns a raw secret value" (ARF-07 req 4).
 *
 * The previous suite proves `SecretValue` redacts. This one proves the *broker*
 * uses it everywhere it matters, by driving real resolves through both modes
 * with distinctive material and then hunting for that material in everything the
 * broker emitted or returned: audit records, describe() output, grants, their
 * JSON, their inspect rendering, and the errors raised along the way.
 *
 * A search-for-the-literal test is only as good as its corpus, so the corpus is
 * built by walking the returned objects rather than by listing fields — a field
 * added later is covered without anyone remembering to add it here.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { describe, it } from 'node:test';

import { normalizeBrokerConfig } from '../src/broker/manifest.mjs';
import { createTokenBroker } from '../src/broker/token-broker.mjs';
import {
  BROKER_AUTH_VALUE, EXTERNAL_TOKEN, MINTED_TOKEN, PAT_VALUE, fakeSecretResolver, isoAt,
  jsonResponse, recordingFetch, testKeyPair,
} from './helpers/broker-fixtures.mjs';

const NOW = 1_800_000_000;
const BROKER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'broker');

/** Broker source files, as `[name, code]` with whole-line comments dropped. */
function brokerSources() {
  const files = [];
  for (const entry of readdirSync(BROKER_SRC)) {
    const path = join(BROKER_SRC, entry);
    if (!statSync(path).isFile() || extname(entry) !== '.mjs') continue;
    // Comment lines are dropped rather than the source being comment-stripped:
    // these files quote `op://…` refs in strings, and a naive `//` stripper
    // would eat the rest of those lines and hide real code from the scan.
    const code = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
      .join('\n');
    files.push([relative(BROKER_SRC, path), code]);
  }
  return files;
}

/** Every secret the fixtures put into play, plus a slice of the private key. */
function secretsInPlay() {
  const pem = testKeyPair().privateKeyPem;
  return [
    MINTED_TOKEN,
    EXTERNAL_TOKEN,
    PAT_VALUE,
    BROKER_AUTH_VALUE,
    // A middle slice of the PEM body: distinctive, and unlike the whole PEM it
    // still matches if something logged a truncated key.
    pem.split('\n').filter((line) => line.length > 40)[1].slice(0, 40),
  ];
}

/**
 * Every string reachable from a value, following objects, arrays, Maps, Sets,
 * and getters. `SecretValue.use()` is deliberately not called — a walk that
 * unwrapped secrets on purpose would prove nothing.
 */
function reachableStrings(value, out = [], seen = new Set()) {
  if (value === null || value === undefined) return out;
  const type = typeof value;
  if (type === 'string') {
    out.push(value);
    return out;
  }
  if (type === 'number' || type === 'boolean' || type === 'bigint' || type === 'symbol') {
    out.push(String(value));
    return out;
  }
  if (type === 'function') return out;
  if (seen.has(value)) return out;
  seen.add(value);

  // How the value renders is as important as what it contains: a leak through
  // toString/inspect is still a leak.
  out.push(String(value));
  out.push(inspect(value, { depth: null }));
  try {
    out.push(JSON.stringify(value) ?? '');
  } catch {
    // A circular structure still contributed its inspect rendering above.
  }

  if (value instanceof Map) {
    for (const [k, v] of value) {
      reachableStrings(k, out, seen);
      reachableStrings(v, out, seen);
    }
    return out;
  }
  if (value instanceof Set || Array.isArray(value)) {
    for (const item of value) reachableStrings(item, out, seen);
    return out;
  }
  if (value instanceof Error) {
    reachableStrings(value.message, out, seen);
    reachableStrings(value.stack ?? '', out, seen);
    reachableStrings(value.cause, out, seen);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') continue;
    let member;
    try {
      member = value[key];
    } catch {
      continue;
    }
    reachableStrings(key, out, seen);
    reachableStrings(member, out, seen);
  }
  return out;
}

function assertNoSecrets(corpus, what) {
  const strings = reachableStrings(corpus);
  for (const secret of secretsInPlay()) {
    for (const rendering of strings) {
      assert.ok(
        !rendering.includes(secret),
        `${what} exposed raw secret material: ${rendering.slice(0, 240)}`,
      );
    }
  }
  // Guard the guard: the walk has to actually be finding strings, or this
  // assertion passes against an empty corpus forever.
  assert.ok(strings.length > 0, `${what} produced nothing to scan`);
}

function bundledConfig() {
  return normalizeBrokerConfig({
    file: {
      mode: 'bundled',
      githubApiUrl: 'https://api.github.test',
      roles: {
        'the-hammer': {
          provider: 'github_app',
          appId: '4197249',
          installationId: '143886388',
          privateKeyRef: 'op://Vault/hammer-key/private key',
          patFallbackRef: 'op://Vault/hammer-pat/credential',
        },
      },
    },
  });
}

function externalConfig() {
  return normalizeBrokerConfig({
    file: {
      mode: 'external',
      endpoint: 'https://broker.arf.test',
      endpointTokenRef: 'op://Vault/broker-auth/credential',
      roles: { 'the-hammer': { scope: 'the-hammer-lacey/github_app/merge' } },
    },
  });
}

function harness(config, fetchImpl) {
  const records = [];
  const broker = createTokenBroker({
    config,
    fetchImpl,
    resolveSecret: fakeSecretResolver(),
    now: () => NOW,
    logger: (record) => records.push(record),
  });
  return { broker, records };
}

describe('the broker never logs or returns raw secret material', () => {
  it('keeps bundled-mode grants, audits, and describe() clean', async () => {
    const fetchImpl = recordingFetch(async () => jsonResponse({
      token: MINTED_TOKEN, expires_at: isoAt(NOW + 3600), permissions: { contents: 'write' },
    }));
    const { broker, records } = harness(bundledConfig(), fetchImpl);
    const grant = await broker.resolveToken('the-hammer');

    // Sanity: the material really did flow through this run, so a clean scan
    // means redaction worked rather than that nothing happened.
    assert.equal(grant.token.use((value) => value), MINTED_TOKEN);

    assertNoSecrets(grant, 'the grant');
    assertNoSecrets(grant.redacted(), 'grant.redacted()');
    assertNoSecrets(records, 'audit records');
    assertNoSecrets(broker.describe(), 'describe()');
    assert.ok(records.some((record) => record.event === 'broker.token_minted'));
  });

  it('keeps the PAT-fallback path clean', async () => {
    const fetchImpl = recordingFetch(async () => jsonResponse({ message: 'down' }, 503));
    const { broker, records } = harness(bundledConfig(), fetchImpl);
    const grant = await broker.resolveToken('the-hammer');

    assert.equal(grant.credentialSource, 'github_pat_fallback');
    assertNoSecrets(grant, 'the fallback grant');
    assertNoSecrets(records, 'fallback audit records');
    // The fallback audit names the ref and the reason, never the credential.
    const fallback = records.find((record) => record.event === 'broker.pat_fallback');
    assert.equal(fallback.patFallbackRef, 'op://Vault/hammer-pat/credential');
  });

  it('keeps external-mode grants, audits, and describe() clean', async () => {
    const fetchImpl = recordingFetch(async () => jsonResponse({
      token: EXTERNAL_TOKEN, expires_at: isoAt(NOW + 3600),
    }));
    const { broker, records } = harness(externalConfig(), fetchImpl);
    const grant = await broker.resolveToken('the-hammer');

    assert.equal(grant.token.use((value) => value), EXTERNAL_TOKEN);
    assertNoSecrets(grant, 'the external grant');
    assertNoSecrets(records, 'external audit records');
    assertNoSecrets(broker.describe(), 'external describe()');
  });

  it('keeps errors clean on both the GitHub and broker paths', async () => {
    const github = recordingFetch(async () => jsonResponse(
      // A hostile-shaped body: an upstream that echoed the Authorization header
      // back would otherwise be pasted straight into an operator-visible error.
      { message: `bad credentials for ${MINTED_TOKEN}` }, 401,
    ));
    const bundled = harness(bundledConfig(), github);
    const bundledErr = await bundled.broker.resolveToken('the-hammer').catch((err) => err);
    assert.ok(bundledErr instanceof Error);
    assertNoSecrets(bundledErr, 'the bundled-mode error');

    const remote = recordingFetch(async () => jsonResponse(
      { error: `refused ${BROKER_AUTH_VALUE}` }, 403,
    ));
    const external = harness(externalConfig(), remote);
    const externalErr = await external.broker.resolveToken('the-hammer').catch((err) => err);
    assert.ok(externalErr instanceof Error);
    assertNoSecrets(externalErr, 'the external-mode error');
  });

  it('sends the credential only in the request it belongs to', async () => {
    // The Authorization header is the one place material legitimately appears.
    // Everything else about the call — URL, method, body — must be free of it.
    const fetchImpl = recordingFetch(async () => jsonResponse({
      token: EXTERNAL_TOKEN, expires_at: isoAt(NOW + 3600),
    }));
    const { broker } = harness(externalConfig(), fetchImpl);
    await broker.resolveToken('the-hammer');

    const [{ url, init }] = fetchImpl.calls;
    assert.equal(init.headers.authorization, `Bearer ${BROKER_AUTH_VALUE}`);
    const { authorization, ...otherHeaders } = init.headers;
    assertNoSecrets({ url, method: init.method, body: init.body, otherHeaders }, 'the request');
  });

  it('has no console output in any broker source file', () => {
    // A dynamic scan cannot see a log statement on a branch the tests miss.
    // The broker emits through the injected `logger` seam and nowhere else, so
    // every emission is one the scans above cover.
    const offenders = [];
    for (const [name, code] of brokerSources()) {
      for (const match of code.matchAll(/\b(?:console\.\w+|process\.std(?:out|err)\.write)\s*\(/g)) {
        offenders.push(`${name}: ${match[0]}`);
      }
    }
    assert.deepEqual(offenders, [], `broker sources must log only through the logger seam:\n${offenders.join('\n')}`);
  });

  it('unwraps a secret only at the call sites that must', () => {
    // `use()` is the single exit, so counting its call sites is a cheap review
    // gate: a new one is a deliberate decision, not an accident.
    const sites = [];
    for (const [name, code] of brokerSources()) {
      if (name === 'secrets.mjs') continue; // defines `use`; not a consumer
      for (const _ of code.matchAll(/\.use\(/g)) sites.push(name);
    }
    assert.deepEqual(sites.sort(), [
      // signing the App JWT
      'github-app.mjs',
      // building the broker Authorization header
      'external.mjs',
      // classifying the token by issuer prefix, which emits no characters
      'token-broker.mjs',
    ].sort());
  });
});
