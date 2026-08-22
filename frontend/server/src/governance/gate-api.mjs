/**
 * `ar-govern` — the arm/disarm HTTP surface (ARF-08, SPEC §9).
 *
 * SPEC §5 keeps merge *execution* out of the UI. This surface does not merge
 * anything and cannot: it writes one small document that the merge paths read
 * for themselves. The pipeline still decides; the gate decides whether it may.
 *
 * ## Two guards on the write routes, and what each is for
 *
 * **Loopback only.** Arming merge authority from off-box is not a capability
 * this app should hand out, and ARF binds `127.0.0.1` by default — so a request
 * arriving from anywhere else means the operator widened the bind, and the
 * write surface should not silently come along.
 *
 * **`content-type: application/json` required.** A form POST from any page the
 * operator happens to have open is a simple cross-origin request that a browser
 * will send without a preflight; a JSON content-type is not, so requiring it is
 * what stops a page on the internet from arming the hammer through the
 * operator's own browser. It costs one header on every legitimate caller.
 *
 * Neither guard replaces authentication, and the README says so. They are the
 * two that are free and that close the paths a loopback service actually gets
 * attacked through.
 *
 * ## Reads are never guarded
 *
 * `GET /v1/governance/gate` answers even when the gate is missing or corrupt,
 * and reports that in the body. This is the surface an operator opens to find
 * out why merges stopped; failing it for the same reason merges are failing
 * would be the least useful possible behaviour.
 */

import { MASTER_SCOPE, MERGE_PATH_IDS } from '../../../gate/gate-contract.mjs';
import { GateError } from './gate-document.mjs';

/** The read route, and the prefix the write routes hang off. */
export const GATE_ROUTE = '/v1/governance/gate';

const WRITE_ACTIONS = new Set(['arm', 'disarm', 'init']);

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** HTTP status for a gate-side failure. */
function statusFor(code) {
  switch (code) {
    case 'bad_request': return 400;
    case 'gate_conflict': return 409;
    case 'gate_missing': return 409;
    case 'gate_malformed': return 409;
    case 'gate_oversize': return 409;
    case 'gate_version_unsupported': return 409;
    case 'gate_locked': return 503;
    default: return 500;
  }
}

/**
 * The write action named by a path, or `null` when this is not a write route.
 *
 * @param {string} pathname
 */
export function gateWriteAction(pathname) {
  if (!pathname.startsWith(`${GATE_ROUTE}/`)) return null;
  const action = pathname.slice(GATE_ROUTE.length + 1);
  return WRITE_ACTIONS.has(action) ? action : null;
}

/**
 * Whether a request arrived over loopback.
 *
 * An absent `remoteAddress` means there is no socket — an in-process call, which
 * is how the tests and any future embedding drive this surface. That is strictly
 * more local than loopback, so it passes.
 */
function isLoopback(req) {
  const address = req?.socket?.remoteAddress;
  return address === undefined || address === null || LOOPBACK.has(address);
}

/** `GET /v1/governance/gate` — always 200, even when the gate is broken. */
export function handleGateRead(ctx, url) {
  const limitRaw = url?.searchParams?.get('auditLimit');
  const limit = limitRaw === null || limitRaw === undefined ? 20 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 0 || limit > 500) {
    return { status: 400, body: { error: 'bad_request', detail: 'auditLimit must be an integer in 0..500' } };
  }
  return { status: 200, body: ctx.gateStore.describe({ auditLimit: limit }) };
}

/**
 * The scope a request body names.
 *
 * Accepts `scope` or the friendlier `path`, and requires exactly one. There is
 * no default: a body that forgot to say what it was disarming would otherwise
 * either stop everything or stop nothing, and both are wrong to guess when the
 * request's whole purpose is stopping merges.
 */
function scopeFromBody(body) {
  const scope = body.scope ?? body.path;
  if (body.scope !== undefined && body.path !== undefined && body.scope !== body.path) {
    throw new GateError('bad_request', 'send either scope or path, not both');
  }
  if (typeof scope !== 'string' || scope.trim() === '') {
    throw new GateError(
      'bad_request',
      `scope is required: "${MASTER_SCOPE}" or one of ${MERGE_PATH_IDS.join(', ')}`,
    );
  }
  return scope.trim();
}

/**
 * `POST /v1/governance/gate/{arm,disarm,init}`.
 *
 * @param {object} ctx
 * @param {string} action
 * @param {object} body already-parsed JSON
 * @param {import('node:http').IncomingMessage} req
 */
export function handleGateWrite(ctx, action, body, req) {
  if (!isLoopback(req)) {
    return {
      status: 403,
      body: {
        error: 'forbidden',
        detail: 'the arm/disarm write surface accepts loopback requests only; '
          + 'reach it through a tunnel rather than by widening the bind address',
      },
    };
  }
  const contentType = String(req?.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return {
      status: 415,
      body: {
        error: 'unsupported_media_type',
        detail: 'gate writes require content-type: application/json',
      },
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { error: 'bad_request', detail: 'request body must be a JSON object' } };
  }

  try {
    if (action === 'init') {
      if (body.armed !== undefined && typeof body.armed !== 'boolean') {
        // Not coerced. `armed: "false"` coercing to `true` would install a gate
        // in the opposite posture to the one the caller asked for, silently.
        throw new GateError('bad_request', `armed must be a boolean, got ${JSON.stringify(body.armed)}`);
      }
      const result = ctx.gateStore.init({
        actor: body.actor,
        reason: body.reason,
        armed: body.armed === undefined ? true : body.armed,
      });
      return {
        status: result.created ? 201 : 200,
        body: { created: result.created, gate: ctx.gateStore.describe() },
      };
    }
    const result = ctx.gateStore.set({
      scope: scopeFromBody(body),
      armed: action === 'arm',
      actor: body.actor,
      reason: body.reason,
      expectedSeq: body.expectedSeq,
    });
    return {
      status: 200,
      body: { applied: true, seq: result.document.seq, previousSeq: result.previousSeq, gate: ctx.gateStore.describe() },
    };
  } catch (err) {
    if (err instanceof GateError) {
      return { status: statusFor(err.code), body: { error: err.code, detail: err.message } };
    }
    throw err;
  }
}
