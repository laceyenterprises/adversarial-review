/**
 * Secret references and redacting secret values (ARF-07 req 4, SPEC §7).
 *
 * "ARF never handles raw secret values" is really two rules, and both are
 * tested here:
 *
 *   - **Configuration consumes references only.** A raw secret pasted where a
 *     reference belongs is refused, rather than accepted as an opaque string
 *     that then lives in the config file and every describe() response.
 *   - **A resolved value cannot render itself.** Every accidental path out —
 *     string coercion, template literal, JSON, util.inspect, error
 *     interpolation — produces a redaction.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { after, describe, it } from 'node:test';

import { BrokerTransientError, SecretRefError } from '../src/broker/errors.mjs';
import {
  SECRET_REF_SCHEMES, SecretValue, classifyOpReadError, createSecretResolver, parseSecretRef,
  safeUpstreamDetail, scrubCredentials,
} from '../src/broker/secrets.mjs';

const SECRET = 'ghs_super_secret_value_0007';

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'arf-secrets-'));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('secret references', () => {
  it('parses the three supported schemes', () => {
    assert.deepEqual(SECRET_REF_SCHEMES, ['op', 'file', 'env']);

    const op = parseSecretRef('op://Cliovault/hammer.private-key/private key');
    assert.equal(op.scheme, 'op');
    assert.equal(op.locator, 'Cliovault/hammer.private-key/private key');

    assert.equal(parseSecretRef('file:///etc/arf/hammer.pem').locator, '/etc/arf/hammer.pem');
    assert.equal(parseSecretRef('env:ARF_HAMMER_PAT').locator, 'ARF_HAMMER_PAT');
  });

  it('refuses a raw secret written where a reference belongs', () => {
    // The failure this prevents: a PAT pasted into `tokenRef` would be accepted
    // as a plain string, checked into a config file, and echoed by describe().
    assert.throws(
      () => parseSecretRef('ghp_a_real_looking_token', { field: 'broker.roles["x"].tokenRef' }),
      (err) => {
        assert.ok(err instanceof SecretRefError);
        assert.match(err.message, /ARF consumes secret references only/);
        assert.match(err.message, /Never configure a raw secret value/);
        assert.match(err.message, /broker\.roles\["x"\]\.tokenRef/);
        return true;
      },
    );
  });

  it('refuses malformed references of a known scheme', () => {
    assert.throws(() => parseSecretRef('op://Vault/item'), /not a complete 1Password reference/);
    assert.throws(() => parseSecretRef('file://relative/path'), /must name an absolute path/);
    assert.throws(() => parseSecretRef('env:not a name'), /valid environment variable/);
    assert.throws(() => parseSecretRef(''), /must be a non-empty string/);
    assert.throws(() => parseSecretRef(null), /must be a non-empty string/);
  });
});

describe('SecretValue redaction', () => {
  const secret = new SecretValue(SECRET, parseSecretRef('op://Vault/item/field'));

  it('has no property that returns the material', () => {
    // A getter named `value` is the obvious thing to add later; this pins that
    // there is exactly one deliberate exit.
    assert.equal(secret.value, undefined);
    assert.ok(!Object.keys(secret).includes('value'));
    assert.equal(secret.use((value) => value), SECRET);
  });

  it('redacts under every accidental rendering path', () => {
    const renderings = [
      String(secret),
      `${secret}`,
      secret.toString(),
      secret + '',
      JSON.stringify(secret),
      JSON.stringify({ token: secret }),
      inspect(secret),
      inspect({ nested: { token: secret } }, { depth: null }),
      new Error(`failed with ${secret}`).message,
      [secret].join(','),
    ];
    for (const rendering of renderings) {
      assert.ok(!rendering.includes(SECRET), `leaked in: ${rendering}`);
      assert.match(rendering, /redacted/);
    }
  });

  it('carries the ref and a stable fingerprint for correlation', () => {
    assert.equal(secret.ref, 'op://Vault/item/field');
    assert.match(secret.fingerprint(), /^[0-9a-f]{12}$/);
    assert.equal(secret.fingerprint(), new SecretValue(SECRET, null).fingerprint());
    assert.notEqual(secret.fingerprint(), new SecretValue(`${SECRET}x`, null).fingerprint());
    assert.deepEqual(secret.toJSON(), {
      redacted: true,
      ref: 'op://Vault/item/field',
      fingerprint: secret.fingerprint(),
    });
  });
});

describe('scrubbing text ARF did not author', () => {
  // An upstream is not obliged to be careful with our material. GitHub, a
  // proxy, or a broker can echo a token or an Authorization header into its own
  // error body, and quoting that into an operator-visible message would
  // republish the credential — a leak ARF caused without ever mishandling a
  // value of its own.
  it('removes credential-shaped substrings from someone else\'s message', () => {
    const cases = [
      'bad credentials for ghs_16CHARACTERSMINIMUMxyz',
      'rejected ghp_TEST_PAT_VALUE_do_not_leak_0001',
      'token github_pat_11ABCDEFG0abcdefghijklmnop invalid',
      'header was Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiI0MTk3MjQ5In0.c2lnbmF0dXJl',
    ];
    for (const text of cases) {
      const scrubbed = scrubCredentials(text);
      assert.match(scrubbed, /\[redacted credential\]/, `not scrubbed: ${text}`);
      assert.ok(!scrubbed.includes('ghs_16CHAR'));
      assert.ok(!scrubbed.includes('do_not_leak'));
    }
  });

  it('leaves an ordinary upstream message intact', () => {
    // Over-scrubbing destroys the diagnostic that makes the error useful.
    for (const text of ['Integration not found', 'Bad credentials', 'Resource not accessible by integration']) {
      assert.equal(scrubCredentials(text), text);
    }
  });

  it('also removes the specific secrets an exchange was holding', () => {
    // Pattern matching cannot catch a credential with no standard shape — a
    // broker's own auth token, for instance. The exact-match pass can.
    const shapeless = new SecretValue('brokerauth_no_recognisable_shape', null);
    const scrubbed = safeUpstreamDetail(
      'refused: brokerauth_no_recognisable_shape', [shapeless],
    );
    assert.ok(!scrubbed.includes('brokerauth_no_recognisable_shape'));
    assert.match(scrubbed, /redacted/);
  });

  it('does not replace a short value that is likely a coincidence', () => {
    const tiny = new SecretValue('abc', null);
    assert.equal(safeUpstreamDetail('abcdefg is fine', [tiny]), 'abcdefg is fine');
  });
});

describe('secret resolver', () => {
  it('reads a file ref and strips the trailing newline', async () => {
    const dir = tempDir();
    const path = join(dir, 'hammer.pem');
    writeFileSync(path, `${SECRET}\n`);
    const resolved = await createSecretResolver()(`file://${path}`);
    assert.equal(resolved.use((value) => value), SECRET);
    assert.equal(resolved.ref, `file://${path}`);
  });

  it('reads an env ref from the injected environment', async () => {
    const resolve = createSecretResolver({ env: { ARF_TEST_PAT: SECRET } });
    assert.equal((await resolve('env:ARF_TEST_PAT')).use((value) => value), SECRET);
    await assert.rejects(() => resolve('env:ARF_TEST_MISSING'), /is not set/);
  });

  it('shells out to the 1Password CLI for an op ref', async () => {
    const calls = [];
    const resolve = createSecretResolver({
      opCommand: '/usr/local/bin/op',
      opReadImpl: async (command, ref) => {
        calls.push([command, ref]);
        return `${SECRET}\n`;
      },
    });
    const resolved = await resolve('op://Cliovault/hammer/private key');
    assert.deepEqual(calls, [['/usr/local/bin/op', 'op://Cliovault/hammer/private key']]);
    assert.equal(resolved.use((value) => value), SECRET);
  });

  it('fails loud on an empty resolve', async () => {
    // The quietest possible failure otherwise: an unauthenticated request that
    // surfaces as an authorization problem three steps later.
    const resolve = createSecretResolver({ env: { ARF_TEST_BLANK: '   \n' } });
    await assert.rejects(() => resolve('env:ARF_TEST_BLANK'), /resolved to an empty value/);
  });

  it('never puts resolver output into an error message', async () => {
    const resolve = createSecretResolver({
      opReadImpl: async () => { throw new SecretRefError('1Password could not resolve op://V/i/f'); },
    });
    const err = await resolve('op://V/i/f').catch((e) => e);
    assert.ok(!err.message.includes(SECRET));

    const dir = tempDir();
    const missing = await createSecretResolver()(`file://${join(dir, 'absent.pem')}`).catch((e) => e);
    assert.match(missing.message, /could not be read/);
  });
});

describe('op read failure classification', () => {
  // The split the PAT fallback keys on. "1Password said no" must stay permanent
  // — falling back there would swap the identity behind a configuration error —
  // while "the op process never got to answer" is the same class as a GitHub
  // 503, which the bundled minter is allowed to ride out on a PAT.
  const ref = 'op://Cliovault/hammer.private-key/private key';

  function execFileError(fields) {
    return Object.assign(new Error('Command failed: op read'), fields);
  }

  it('treats a timeout kill as transient', () => {
    // How node reports `{timeout}` firing: SIGTERM, killed, no exit status.
    const err = classifyOpReadError(execFileError({ killed: true, signal: 'SIGTERM', code: null }), '', ref);
    assert.ok(err instanceof BrokerTransientError);
    assert.equal(err.code, 'broker_transient');
    assert.match(err.message, /did not complete/);
  });

  it('treats a transient spawn errno as transient', () => {
    for (const code of ['ETIMEDOUT', 'EIO', 'EAGAIN', 'EMFILE']) {
      const err = classifyOpReadError(execFileError({ code, signal: null }), '', ref);
      assert.ok(err instanceof BrokerTransientError, `${code} should be transient`);
    }
  });

  it('keeps a non-zero exit and a missing CLI permanent', () => {
    // `op` answered: the ref is wrong, the vault is not shared, or the session
    // is not signed in. A retry re-asks the same question.
    const refused = classifyOpReadError(execFileError({ code: 1, signal: null }), 'no item matched', ref);
    assert.ok(refused instanceof SecretRefError);
    assert.equal(refused.code, 'secret_ref');
    assert.match(refused.message, /no item matched/);

    // Not installed is an install problem, not a blip.
    const absent = classifyOpReadError(execFileError({ code: 'ENOENT', signal: null }), '', ref);
    assert.ok(absent instanceof SecretRefError);
  });

  it('quotes stderr only, capped, and never stdout', () => {
    const err = classifyOpReadError(
      execFileError({ code: 1, signal: null }),
      `${'x'.repeat(400)} ${SECRET}`,
      ref,
    );
    assert.ok(!err.message.includes(SECRET));
    assert.ok(err.message.length < 400);
  });

  it('lets a transient op failure reach the caller as transient', async () => {
    const resolve = createSecretResolver({
      opReadImpl: async () => {
        throw classifyOpReadError(execFileError({ killed: true, signal: 'SIGTERM' }), '', ref);
      },
    });
    const err = await resolve(ref).catch((e) => e);
    assert.equal(err.code, 'broker_transient');
  });
});
