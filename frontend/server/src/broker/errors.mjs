/**
 * Error vocabulary for the ARF token/identity broker (ARF-07).
 *
 * The distinctions here are load-bearing, not decorative:
 *
 * - `UnmappedRoleError` is the fail-loud gate. SPEC §6 records the 2026-07-23
 *   RCA: a role with no token mapping fell through to whatever ambient identity
 *   the process happened to carry, so the *misconfiguration* was invisible and
 *   the work was attributed to the wrong actor. ARF refuses instead, and says
 *   which roles it does know about.
 *
 * - `AmbientIdentityRefusedError` is the same rule applied to the far side of
 *   the wire. An external broker asked for an unknown role can answer with its
 *   own default credential; a token whose echoed identity does not match what
 *   ARF asked for is refused rather than used.
 *
 * - permanent vs transient mirrors the split the in-OS broker already draws
 *   (`RefreshFailedPermanent` / `RefreshFailedTransient`): a bad private key is
 *   not something a retry fixes, a 503 is. The bundled minter only reaches for a
 *   PAT fallback on the transient side, so folding the two together would let a
 *   revoked App key silently downgrade to a PAT.
 *
 * No error message ever carries a secret value — only secret *references*,
 * which are checked-in pointers (`op://…`) and safe to print.
 */

export class ArfBrokerError extends Error {
  constructor(message, { code = 'broker_error', role = null, cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ArfBrokerError';
    this.code = code;
    this.role = role;
  }
}

/** A broker/config shape that cannot be used at all. Raised at load time. */
export class BrokerConfigError extends ArfBrokerError {
  constructor(message, options = {}) {
    super(message, { code: 'broker_config', ...options });
    this.name = 'BrokerConfigError';
  }
}

/** A secret *reference* that is malformed, unknown-scheme, or unresolvable. */
export class SecretRefError extends ArfBrokerError {
  constructor(message, options = {}) {
    super(message, { code: 'secret_ref', ...options });
    this.name = 'SecretRefError';
  }
}

/** Retrying will not help: bad key, revoked app, 401/403/404/422. */
export class BrokerPermanentError extends ArfBrokerError {
  constructor(message, options = {}) {
    super(message, { code: 'broker_permanent', ...options });
    this.name = 'BrokerPermanentError';
  }
}

/** Retrying may help: timeouts, connection resets, 5xx, 429. */
export class BrokerTransientError extends ArfBrokerError {
  constructor(message, options = {}) {
    super(message, { code: 'broker_transient', ...options });
    this.name = 'BrokerTransientError';
  }
}

/**
 * The fail-loud gate: this role has no token mapping.
 *
 * Deliberately NOT a subclass of the transient error — nothing about it is
 * retryable, and nothing about it is recoverable by substituting another
 * identity. The only fix is a mapping.
 */
export class UnmappedRoleError extends ArfBrokerError {
  constructor(role, { knownRoles = [], mode = null } = {}) {
    const known = knownRoles.length > 0
      ? `mapped roles: ${knownRoles.join(', ')}`
      : 'no roles are mapped at all';
    super(
      `no token mapping for role ${JSON.stringify(role)}`
      + `${mode ? ` (broker mode=${mode})` : ''}; ${known}. `
      + 'ARF refuses to fall back to an ambient or default identity — add a '
      + 'role -> token mapping under broker.roles (or broker.rolesFile).',
      { code: 'unmapped_role', role },
    );
    this.name = 'UnmappedRoleError';
    this.knownRoles = [...knownRoles];
    this.mode = mode;
  }
}

/**
 * A broker answered with a credential that is not the identity we asked for.
 *
 * The same class of failure as an unmapped role, caught one hop further out:
 * using the token anyway would attribute ARF's writes to whoever the broker
 * decided to hand back.
 */
export class AmbientIdentityRefusedError extends ArfBrokerError {
  constructor(role, { field, expected, actual } = {}) {
    super(
      `broker returned a credential for ${field}=${JSON.stringify(actual)} `
      + `but role ${JSON.stringify(role)} requires ${field}=${JSON.stringify(expected)}; `
      + 'refusing the token rather than acting under an identity ARF did not request.',
      { code: 'ambient_identity_refused', role },
    );
    this.name = 'AmbientIdentityRefusedError';
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}
