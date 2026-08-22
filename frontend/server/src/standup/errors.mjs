/**
 * Error vocabulary for the identity standup wizard (ARF-05).
 *
 * The wizard's job is to be *legible when it fails*: a standup is a five-step
 * ritual across GitHub, a secret store, and a broker, and "it didn't work" is
 * worth nothing to the operator watching the stream. So every failure carries a
 * stable `code` the panel renders on, and — where there is one — a `nextAction`
 * saying what to do about it.
 *
 * Two of these codes are load-bearing rather than cosmetic:
 *
 * - `token_map_unavailable` is the fail-loud gate at the wire step. The role has
 *   no mapping and ARF has nowhere to put one, so the run **fails**. It does not
 *   proceed to the verify step under whatever identity the process happens to be
 *   carrying, which is the 2026-07-23 ambient-fallback RCA the whole ARF-05/07
 *   pair exists to refuse. `UnmappedRoleError` from the broker seam is the same
 *   condition stated one layer down and is surfaced, never swallowed.
 *
 * - `ambient_attribution` is that rule applied to the *proof*. The verify step
 *   posts a comment and reads back who GitHub says wrote it. A post attributed
 *   to a human user rather than the App's bot means the write did not act as the
 *   role — the credential worked, but it was not this identity. That is a
 *   failure even though every HTTP call returned 2xx.
 *
 * `operator_input_required` is deliberately a *failure*, not a fifth status.
 * SPEC's step vocabulary is `pending | running | ok | failed` and the wizard
 * keeps to it exactly; a step waiting on a human is reported as failed with this
 * code, `resumable: true`, and the action to take. Because the run is resumable,
 * "supply the missing thing and re-run" picks up precisely where it stopped —
 * which is the same interaction the mockup's "waiting" chip describes, expressed
 * without inventing a status the contract does not have.
 */

/** Base for every failure the wizard raises itself. */
export class StandupError extends Error {
  constructor(message, { code = 'standup_error', step = null, nextAction = null, cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StandupError';
    this.code = code;
    this.step = step;
    this.nextAction = nextAction;
  }
}

/** The request itself is not usable. Raised before a run starts. */
export class StandupParamsError extends StandupError {
  constructor(message) {
    super(message, { code: 'invalid_params' });
    this.name = 'StandupParamsError';
  }
}

/**
 * A step needs something only a human can supply — an App created in a browser,
 * a private key stored in a vault, an installation approved on the org.
 *
 * @param {string} message
 * @param {{nextAction?: object|null}} [options] `{summary, url?, params?}` — what to do
 */
export class OperatorInputRequiredError extends StandupError {
  constructor(message, { nextAction = null } = {}) {
    super(message, { code: 'operator_input_required', nextAction });
    this.name = 'OperatorInputRequiredError';
  }
}

/**
 * The fail-loud gate: the role has no token mapping and ARF has nowhere to
 * write one, so there is no mapped credential this run could act under.
 *
 * Distinct from the broker's `UnmappedRoleError` only in *where* it is noticed:
 * this one is raised before a token is even requested, because ARF can already
 * see there is no manifest to map into. Both end the run the same way, and
 * neither has a fallback branch.
 */
export class TokenMapUnavailableError extends StandupError {
  constructor(role, { knownRoles = [], nextAction = null } = {}) {
    const known = knownRoles.length > 0
      ? `mapped roles: ${knownRoles.join(', ')}`
      : 'no roles are mapped at all';
    super(
      `role ${JSON.stringify(role)} has no role -> token mapping and ARF has no writable `
      + `manifest to record one in (broker.rolesFile is not configured); ${known}. `
      + 'The standup FAILS here: ARF will not verify, post, or act under an ambient or '
      + 'default identity in place of a mapping.',
      { code: 'token_map_unavailable', nextAction },
    );
    this.name = 'TokenMapUnavailableError';
    this.role = role;
    this.knownRoles = [...knownRoles];
  }
}

/**
 * What ARF stood up and what the mapping points at are not the same identity.
 *
 * Wiring over the mismatch would leave the role's writes attributed to whichever
 * App the stale mapping named — an ambient identity by another route, since
 * nobody asked for that one either.
 */
export class IdentityMismatchError extends StandupError {
  constructor(message, { field, expected, actual } = {}) {
    super(message, { code: 'identity_mismatch' });
    this.name = 'IdentityMismatchError';
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * The verification post was not attributed to the role's bot.
 *
 * This is the check that makes the whole wizard mean something: every step can
 * return 2xx and the identity can still be wrong. A comment written by
 * `paul-lacey` when the role is `the-hammer` proves the run acted as the ambient
 * account, and is refused as loudly as an unmapped role.
 */
export class AmbientAttributionError extends StandupError {
  constructor({ role, expectedLogin, actualLogin, actualType }) {
    super(
      `the verification post for role ${JSON.stringify(role)} was attributed to `
      + `${JSON.stringify(actualLogin)} (type ${actualType ?? 'unknown'})`
      + `${expectedLogin ? `, not the app's bot identity ${JSON.stringify(expectedLogin)}` : ''}. `
      + 'The identity did not act as itself, so the standup is not verified — a post that '
      + 'succeeds under the wrong actor is the failure this step exists to catch.',
      { code: 'ambient_attribution' },
    );
    this.name = 'AmbientAttributionError';
    this.role = role;
    this.expectedLogin = expectedLogin ?? null;
    this.actualLogin = actualLogin ?? null;
    this.actualType = actualType ?? null;
  }
}

/** The run was cancelled — the SSE client went away, or the server is stopping. */
export class StandupAbortedError extends StandupError {
  constructor(step) {
    super(`standup run cancelled at step ${JSON.stringify(step)}`, { code: 'aborted', step });
    this.name = 'StandupAbortedError';
  }
}

/**
 * The stable code for any error a step can raise.
 *
 * Broker errors already carry their own vocabulary (`unmapped_role`,
 * `ambient_identity_refused`, `broker_transient`, …) and it is deliberately
 * passed through rather than flattened: an operator seeing `unmapped_role` in the
 * stream is being told the mapping is missing, which is a different fix from
 * `broker_permanent`. Anything without a code is reported as internal rather
 * than guessed at.
 */
export function errorCode(err) {
  const code = err?.code;
  return typeof code === 'string' && code !== '' ? code : 'internal_error';
}

/** The `nextAction` a step attached, if any. Safe to render; never has secrets. */
export function errorNextAction(err) {
  const action = err?.nextAction;
  return action && typeof action === 'object' ? action : null;
}
