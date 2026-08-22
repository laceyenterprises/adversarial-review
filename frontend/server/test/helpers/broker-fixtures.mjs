/**
 * Shared fixtures for the ARF token/identity-broker tests (ARF-07).
 *
 * The RSA keypair is generated once per test process and reused: a 2048-bit
 * generation is ~100ms, and every bundled-mode case needs a key that a real
 * `createPrivateKey` + `createSign` round trip accepts. Using a real key rather
 * than a stub is the point — it is what makes the JWT assertions meaningful.
 */

import { createVerify, generateKeyPairSync } from 'node:crypto';

import { SecretValue } from '../../src/broker/secrets.mjs';

let cachedKeyPair = null;

/** A real RSA keypair; the private half in PEM, the public half for verifying. */
export function testKeyPair() {
  if (!cachedKeyPair) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    cachedKeyPair = {
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      publicKey,
    };
  }
  return cachedKeyPair;
}

/** Distinctive material, so a leak test can search for an exact string. */
export const PAT_VALUE = 'ghp_TEST_PAT_VALUE_do_not_leak_0001';
export const MINTED_TOKEN = 'ghs_TEST_INSTALLATION_TOKEN_do_not_leak_0002';
export const EXTERNAL_TOKEN = 'ghs_TEST_EXTERNAL_TOKEN_do_not_leak_0003';
export const BROKER_AUTH_VALUE = 'brokerauth_TEST_do_not_leak_0004';

/**
 * A secret resolver over an in-memory ref -> value map. Records every ref it was
 * asked for, so tests can assert which credential path a mint actually took.
 */
export function fakeSecretResolver(values = {}) {
  const table = {
    'op://Vault/hammer-key/private key': testKeyPair().privateKeyPem,
    'op://Vault/hammer-pat/credential': PAT_VALUE,
    'op://Vault/broker-auth/credential': BROKER_AUTH_VALUE,
    ...values,
  };
  const seen = [];
  const resolve = async (ref) => {
    const key = String(ref);
    seen.push(key);
    if (!(key in table)) {
      throw new Error(`test resolver has no value for ${key}`);
    }
    return new SecretValue(table[key], key);
  };
  resolve.seen = seen;
  return resolve;
}

/** Decode a compact JWT's header and payload without verifying. */
export function decodeJwt(jwt) {
  const [header, payload] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
  };
}

/** Verify a compact RS256 JWT against the fixture keypair's public half. */
export function verifyJwt(jwt, publicKey = testKeyPair().publicKey) {
  const parts = jwt.split('.');
  return createVerify('RSA-SHA256')
    .update(`${parts[0]}.${parts[1]}`)
    .end()
    .verify(publicKey, Buffer.from(parts[2], 'base64url'));
}

/** A `fetch` stand-in driven by a handler, recording every call it received. */
export function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length - 1);
  };
  impl.calls = calls;
  return impl;
}

/** A minimal `Response`-shaped object; `fetch` is only used through this shape. */
export function jsonResponse(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  };
}

/**
 * A `Response`-shaped object whose body is a real web `ReadableStream`, the
 * shape `undici` actually hands back.
 *
 * Chunks are produced lazily so an "upstream returns 64 MiB" case never
 * materialises the payload in the test either. The returned `meta` records how
 * many bytes the consumer actually pulled and whether it cancelled early —
 * which is the property a body cap has to be tested on, since a length check on
 * the result cannot distinguish "read 64 MiB then truncated" from "never read
 * past the cap".
 *
 * @param {Array<Uint8Array>} chunks
 * @param {{status?: number}} [options]
 */
export function streamingResponse(chunks, { status = 500 } = {}) {
  const meta = { pulled: 0, cancelled: false };
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index++];
      meta.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      meta.cancelled = true;
    },
  });
  return {
    response: {
      ok: status >= 200 && status < 300,
      status,
      body,
      text: async () => { throw new Error('text() must not be used when a stream is available'); },
    },
    meta,
  };
}

/** ISO-8601 with a `Z`, the shape GitHub returns for `expires_at`. */
export function isoAt(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
