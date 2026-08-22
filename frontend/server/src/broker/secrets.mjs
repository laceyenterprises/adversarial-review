/**
 * Secret *references* and redacting secret values (ARF-07, SPEC §7).
 *
 * The rule this module exists to enforce: **ARF's configuration, its manifests,
 * its logs, and its return values carry secret references only — never secret
 * values.** A reference (`op://Cliovault/hammer-key/private key`) is a pointer.
 * It is checked into `identities/*.yaml` in this very repo, it is safe to print,
 * and it is what an operator needs to see when a standup step fails.
 *
 * A value has to exist for the few microseconds it takes to sign a JWT or set an
 * Authorization header, so this module wraps it in `SecretValue`, which:
 *
 *   - has no getter that returns the raw string;
 *   - stringifies, JSON-serialises, and `util.inspect`s to a redaction, so a
 *     stray `console.log`, a template literal, an error message, or a JSON
 *     response body cannot leak it by accident;
 *   - exposes the value only through `use(fn)`, which is a visible, greppable
 *     act at the one place that genuinely needs it.
 *
 * `fingerprint()` gives log/audit records something to correlate on — a
 * truncated SHA-256 — without exposing the material. It is the same trick the
 * in-OS broker uses for its permissions digest.
 *
 * Resolvers are pluggable so ARF stays standalone: `op://` shells out to the
 * 1Password CLI when it is present, and `file://` / `env:` are the standalone
 * secret refs for an install with no 1Password (SPEC §7).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';

import { BrokerTransientError, SecretRefError } from './errors.mjs';
import { withTransientRetry } from './retry.mjs';

/** Schemes a secret reference may use. Anything else fails loud. */
export const SECRET_REF_SCHEMES = ['op', 'file', 'env'];

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A parsed, validated secret reference. Safe to log, store, and return.
 *
 * @property {string} raw     the reference exactly as configured
 * @property {string} scheme  one of SECRET_REF_SCHEMES
 * @property {string} locator scheme-specific remainder (op path / file path / env name)
 */
export class SecretRef {
  constructor(raw, scheme, locator) {
    this.raw = raw;
    this.scheme = scheme;
    this.locator = locator;
    Object.freeze(this);
  }

  toString() {
    return this.raw;
  }

  toJSON() {
    return this.raw;
  }
}

/**
 * Parse a secret reference, or throw with the field that carried it.
 *
 * @param {unknown} value
 * @param {{field?: string, role?: string|null}} [context] naming for the error message
 * @returns {SecretRef}
 */
export function parseSecretRef(value, { field = 'secret ref', role = null } = {}) {
  const where = role ? `${field} for role ${JSON.stringify(role)}` : field;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SecretRefError(`${where} must be a non-empty string`, { role });
  }
  const raw = value.trim();

  if (raw.startsWith('op://')) {
    // `op://<vault>/<item>/<field>` — the shape `op read` accepts. Fewer than
    // three segments is a reference `op` would reject at resolve time, which is
    // a mid-standup failure instead of a load-time one.
    const segments = raw.slice('op://'.length).split('/').filter((part) => part !== '');
    if (segments.length < 3) {
      throw new SecretRefError(
        `${where} ${JSON.stringify(raw)} is not a complete 1Password reference `
        + '(expected op://<vault>/<item>/<field>)',
        { role },
      );
    }
    return new SecretRef(raw, 'op', raw.slice('op://'.length));
  }

  if (raw.startsWith('file://')) {
    const path = raw.slice('file://'.length);
    if (!path.startsWith('/')) {
      throw new SecretRefError(
        `${where} ${JSON.stringify(raw)} must name an absolute path `
        + '(expected file:///absolute/path)',
        { role },
      );
    }
    return new SecretRef(raw, 'file', path);
  }

  if (raw.startsWith('env:')) {
    const name = raw.slice('env:'.length);
    if (!ENV_NAME_PATTERN.test(name)) {
      throw new SecretRefError(
        `${where} ${JSON.stringify(raw)} must name a valid environment variable `
        + '(expected env:NAME)',
        { role },
      );
    }
    return new SecretRef(raw, 'env', name);
  }

  // Refusing an unknown scheme matters more than it looks: a raw secret pasted
  // into a config field where a reference belongs would otherwise be accepted
  // as an opaque string and end up in the config file, the manifest, and every
  // describe() response.
  throw new SecretRefError(
    `${where} ${JSON.stringify(raw)} has no recognised scheme — ARF consumes secret `
    + `references only, one of: ${SECRET_REF_SCHEMES.map((s) => `${s}:`).join(', ')}. `
    + 'Never configure a raw secret value.',
    { role },
  );
}

/**
 * A resolved secret. Holds the material privately and refuses to render it.
 *
 * There is intentionally no `.value` getter: `use(fn)` is the only way out, so
 * every access is greppable and every accidental path (string coercion, JSON,
 * inspect, error interpolation) renders the redaction instead.
 */
export class SecretValue {
  #value;

  constructor(value, ref) {
    if (typeof value !== 'string') {
      throw new SecretRefError('a secret value must be a string');
    }
    this.#value = value;
    this.ref = ref instanceof SecretRef ? ref.raw : (ref == null ? null : String(ref));
    Object.freeze(this);
  }

  /** Truncated SHA-256 — correlate across logs without exposing the material. */
  fingerprint() {
    return createHash('sha256').update(this.#value, 'utf8').digest('hex').slice(0, 12);
  }

  /**
   * Replace this secret's material wherever it appears in `text`.
   *
   * For scrubbing text ARF did not author — an upstream error body it is about
   * to quote into an operator-visible message. Consumes the material internally
   * and returns only the redacted string.
   */
  redactFrom(text) {
    if (typeof text !== 'string' || text === '') return text;
    // Below ~8 characters a "secret" is more likely to be a common substring
    // than a credential, and replacing it would mangle the message it is in.
    if (this.#value.length < 8) return text;
    return text.split(this.#value).join(this.#redacted());
  }

  /**
   * The one exit. Whatever `fn` returns is returned verbatim, so a caller can
   * sign with the key or build a header without the value escaping this class.
   */
  use(fn) {
    return fn(this.#value);
  }

  /** Length only — useful for "the secret resolved but is suspiciously short". */
  get length() {
    return this.#value.length;
  }

  toString() {
    return this.#redacted();
  }

  toJSON() {
    return { redacted: true, ref: this.ref, fingerprint: this.fingerprint() };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return this.#redacted();
  }

  #redacted() {
    return `[redacted secret${this.ref ? ` ${this.ref}` : ''} sha256:${this.fingerprint()}]`;
  }

  static isSecret(value) {
    return value instanceof SecretValue;
  }
}

// `inspect` is imported for this assertion alone: if Node ever changed the
// custom-inspect symbol, a redaction that silently stopped applying would be
// exactly the kind of quiet leak this module exists to prevent.
/* c8 ignore next 3 */
if (inspect.custom !== Symbol.for('nodejs.util.inspect.custom')) {
  throw new Error('node util.inspect.custom is not the well-known symbol; redaction would not apply');
}

/**
 * Credential shapes ARF might quote back from someone else's error body.
 *
 * An upstream is not obliged to be careful with our material: a proxy, a
 * gateway, or a broker can echo an Authorization header or a token into its own
 * error message, and quoting that message verbatim into an operator-visible
 * error (or a log line) would republish the credential. These patterns cover the
 * shapes that actually travel through this seam — GitHub's prefixed tokens and
 * the App JWT ARF itself mints.
 */
const CREDENTIAL_PATTERNS = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}/g,
  // A compact JWT: three base64url segments, the first starting `ey` ({"...).
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

const CREDENTIAL_REDACTION = '[redacted credential]';

/** Strip anything credential-shaped out of text ARF did not author. */
export function scrubCredentials(text) {
  if (typeof text !== 'string' || text === '') return text;
  let scrubbed = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, CREDENTIAL_REDACTION);
  }
  return scrubbed;
}

/**
 * Make an upstream detail safe to quote: pattern-scrub it, then remove any of
 * the specific secrets this exchange was holding.
 *
 * The two passes catch different things. The patterns catch material ARF never
 * had (a token the upstream echoed); the exact-match pass catches material ARF
 * *did* hold but whose shape is not guessable — a broker's own auth credential,
 * for instance, which has no standard prefix.
 *
 * @param {string} text
 * @param {Array<SecretValue|null|undefined>} [secrets]
 */
export function safeUpstreamDetail(text, secrets = []) {
  let safe = scrubCredentials(text);
  for (const secret of secrets) {
    if (secret instanceof SecretValue) safe = secret.redactFrom(safe);
  }
  return safe;
}

/**
 * Spawn/IO errnos that mean the machine got in the way, not that 1Password
 * answered. `op` is a subprocess, and ARF runs as a LaunchAgent: a descriptor
 * exhaustion, an interrupted read, or a busy filesystem is a blip a retry (or a
 * PAT fallback) survives. `ENOENT` is deliberately absent — a 1Password CLI that
 * is not installed is a permanent install problem.
 */
const TRANSIENT_SPAWN_CODES = new Set([
  'ETIMEDOUT', 'EIO', 'EAGAIN', 'EINTR', 'EBUSY', 'EMFILE', 'ENFILE', 'ENOMEM',
  'ECONNRESET', 'EPIPE',
]);

/**
 * Classify an `execFile` failure from `op read`.
 *
 * The split matters because `token-broker.mjs` reaches for a role's PAT fallback
 * on the transient side only. Two different things can fail here and they must
 * not be folded together:
 *
 *   - **1Password answered, and the answer was no** — a non-zero exit status.
 *     The ref is wrong, the vault is not shared, the session is not signed in.
 *     Permanent: retrying re-asks the same question, and falling back to a PAT
 *     would swap the identity behind a *configuration* error, which is the
 *     ambient-fallback shape this subsystem exists to refuse.
 *   - **`op` never got to answer** — the timeout killed it, a signal killed it,
 *     or the spawn failed with a transient errno. Nothing about the mapping is
 *     wrong, so this is the same class as GitHub returning a 503, and the
 *     bundled minter should be free to ride it out on the PAT fallback.
 *
 * Node reports a timeout kill as `err.killed === true` (with `err.signal` set),
 * a spawn/IO failure as a string `err.code`, and a plain non-zero exit as a
 * numeric `err.code` with `err.signal === null`.
 *
 * @param {Error & {code?: string|number, killed?: boolean, signal?: string|null}} err
 * @param {unknown} stderr
 * @param {string} ref  the secret *reference*, safe to print
 */
export function classifyOpReadError(err, stderr, ref) {
  // stderr only, capped. stdout may hold the secret on a partial read, and this
  // string ends up in an operator-visible error.
  const detail = String(stderr ?? '').trim().slice(0, 200);
  const because = detail ? `: ${detail}` : `: ${err.message}`;

  const killed = err.killed === true || typeof err.signal === 'string';
  const spawnFailure = typeof err.code === 'string' && TRANSIENT_SPAWN_CODES.has(err.code);
  if (killed || spawnFailure) {
    return new BrokerTransientError(
      `the 1Password CLI did not complete while resolving ${ref}${because} `
      + '(the process was interrupted rather than 1Password refusing the reference)',
    );
  }
  return new SecretRefError(`1Password could not resolve ${ref}${because}`);
}

function execOpRead(command, ref, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      ['read', '--no-newline', ref],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          reject(classifyOpReadError(err, stderr, ref));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/**
 * Read one reference out of 1Password, retrying the *interrupted* case.
 *
 * `classifyOpReadError` already separates "1Password answered, and the answer
 * was no" from "the process never got to answer". Only the second half is
 * retried here, and that split is what makes the retry safe: re-running a
 * command 1Password refused would just re-ask a settled question, while
 * re-running one that a spawn `EIO` or a timeout kill cut short is exactly the
 * blip the 2026-05-16 launchd outage turned into a permanent minting failure.
 *
 * The whole loop is bounded (see `retry.mjs`), so a genuinely broken `op` still
 * escalates promptly instead of stalling a standup step behind an open-ended
 * wait — and it escalates as a `BrokerTransientError`, so the bundled minter's
 * PAT fallback still fires for a role that has one.
 *
 * @param {string} command 1Password CLI to invoke
 * @param {string} ref     the secret *reference*, safe to print
 * @param {number} timeoutMs per-attempt timeout
 * @param {object} [retry] bounded-backoff options; see `withTransientRetry`
 */
export function runOpRead(command, ref, timeoutMs, retry = undefined) {
  return withTransientRetry(() => execOpRead(command, ref, timeoutMs), retry);
}

/**
 * Build a secret resolver over the built-in schemes.
 *
 * Every dependency is injectable so tests never need a 1Password session, a key
 * on disk, or a real environment variable.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.opCommand] 1Password CLI to shell out to
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.readFileImpl] injection point for the `file:` scheme
 * @param {Function} [options.opReadImpl] injection point for the `op:` scheme
 * @param {object} [options.retry] bounded-backoff options for the `op:` scheme
 * @returns {(ref: SecretRef|string, context?: object) => Promise<SecretValue>}
 */
export function createSecretResolver({
  env = process.env,
  opCommand = 'op',
  timeoutMs = 15000,
  readFileImpl = readFile,
  opReadImpl = runOpRead,
  retry = undefined,
} = {}) {
  return async function resolveSecret(ref, context = {}) {
    const parsed = ref instanceof SecretRef ? ref : parseSecretRef(ref, context);
    let raw;

    if (parsed.scheme === 'op') {
      raw = await opReadImpl(opCommand, parsed.raw, timeoutMs, retry);
    } else if (parsed.scheme === 'file') {
      try {
        raw = await readFileImpl(parsed.locator, 'utf8');
      } catch (err) {
        throw new SecretRefError(
          `secret file ${parsed.locator} could not be read: ${err.message}`,
          { role: context.role ?? null, cause: err },
        );
      }
    } else {
      const value = env[parsed.locator];
      if (value === undefined) {
        throw new SecretRefError(
          `environment variable ${parsed.locator} (from ${parsed.raw}) is not set`,
          { role: context.role ?? null },
        );
      }
      raw = String(value);
    }

    // Trailing newlines are an artifact of every one of these transports; a PEM
    // or a token with one attached is still the same secret. Leading whitespace
    // is not trimmed — it would corrupt nothing here, but it is not ours to eat.
    const value = raw.replace(/\s+$/, '');
    if (value === '') {
      // An empty resolve is the quietest possible failure: an unauthenticated
      // request that looks like an authorization problem three steps later.
      throw new SecretRefError(
        `secret ref ${parsed.raw} resolved to an empty value`,
        { role: context.role ?? null },
      );
    }
    return new SecretValue(value, parsed);
  };
}
