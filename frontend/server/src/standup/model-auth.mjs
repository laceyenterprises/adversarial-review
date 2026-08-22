/**
 * Provisioning a harness's model-auth (ARF-06 step 2).
 *
 * Two modes, and the difference between them is not a detail — it is what makes
 * ARF deployable outside the OS at all (SPEC §2):
 *
 * **`broker-oauth`** — in-OS. The credential comes from the ARF-07 seam:
 * `resolveToken(role)`, which mints or fetches it and refuses loudly for a role
 * with no mapping. Nothing here reaches around that seam, and nothing here
 * catches `UnmappedRoleError` and carries on: an unmapped role fails this step,
 * the harness never reaches `ready`, and no other credential is substituted. The
 * 2026-07-23 RCA is the reason the refusal has to survive every layer above it —
 * a fallback that "helps" here would attribute a harness's work to whatever
 * identity the process happened to be carrying.
 *
 * **`standalone-token`** — no broker at all. The credential is a secret
 * *reference* the operator configured (`op://`, `file://`, `env:`), resolved
 * through ARF-07's secret resolver. This path never constructs a broker, never
 * reads a role map, and never touches the network, which is what lets a
 * standalone ARF stand up a harness on a machine with no agent-os on it.
 *
 * Neither path lets material out. What is recorded on the harness record is a
 * reference, a token *type*, a truncated fingerprint, and an expiry — the same
 * vocabulary ARF-07's audit records use, and enough to answer "is this harness
 * running on the identity I think it is?" without ever printing the answer.
 */

import { UnmappedRoleError } from '../broker/errors.mjs';
import { SecretValue, createSecretResolver } from '../broker/secrets.mjs';
import {
  MODEL_AUTH_BROKER_OAUTH, MODEL_AUTH_STANDALONE_TOKEN,
} from './harness-manifest.mjs';

export class ModelAuthError extends Error {
  constructor(message, { code = 'model_auth', cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ModelAuthError';
    this.code = code;
  }
}

/**
 * Classify a resolved credential by issuer shape, without emitting any of it.
 *
 * Model-provider credentials do not share GitHub's prefix conventions, so this
 * is deliberately coarse: it distinguishes the shapes an operator would want to
 * tell apart in a standup summary (an OAuth-ish bearer vs a provider API key)
 * and says `opaque` rather than guessing.
 */
function credentialShape(secret) {
  return secret.use((value) => {
    if (value.startsWith('sk-ant-')) return 'anthropic_api_key';
    if (value.startsWith('sk-')) return 'provider_api_key';
    if (value.startsWith('ya29.') || value.startsWith('1//')) return 'google_oauth';
    if (/^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(value)) return 'jwt';
    return 'opaque';
  });
}

/**
 * Provision model-auth for one harness.
 *
 * @param {object} options
 * @param {object} options.spec        normalized harness spec
 * @param {object|null} [options.broker] the ARF-07 broker; required only in
 *   `broker-oauth` mode, and deliberately *not* consulted in the other one
 * @param {Function} [options.resolveSecret] ref -> Promise<SecretValue>
 * @param {() => number} [options.now] epoch seconds
 * @param {boolean} [options.dryRun]   validate the wiring without resolving
 * @returns {Promise<object>} the redacted credential record for the manifest
 */
export async function provisionModelAuth({
  spec, broker = null, resolveSecret = null, now = () => Date.now() / 1000, dryRun = false,
}) {
  const { modelAuth } = spec;

  if (modelAuth.mode === MODEL_AUTH_BROKER_OAUTH) {
    if (!broker) {
      throw new ModelAuthError(
        `harness ${JSON.stringify(spec.class)} is configured for `
        + `model-auth mode=${MODEL_AUTH_BROKER_OAUTH} but no token broker is available. `
        + `Configure broker.roles.${modelAuth.brokerRole}, or stand the harness up with `
        + `model-auth mode=${MODEL_AUTH_STANDALONE_TOKEN} and a token reference.`,
        { code: 'broker_unavailable' },
      );
    }

    // The mapping check runs even in a dry run, because "is this role mapped?"
    // is the question a dry run is most useful for answering — and because
    // `hasRole` consults the manifest, not the cache, so it cannot be satisfied
    // by a credential left over from an earlier run.
    if (!broker.hasRole(modelAuth.brokerRole)) {
      throw new UnmappedRoleError(modelAuth.brokerRole, {
        knownRoles: (broker.describe?.().roles ?? []).map((role) => role.role),
        mode: broker.mode ?? null,
      });
    }

    if (dryRun) {
      return {
        mode: modelAuth.mode,
        provisioned: false,
        dryRun: true,
        brokerRole: modelAuth.brokerRole,
        brokerMode: broker.mode ?? null,
        credential: null,
      };
    }

    // No try/catch. An `UnmappedRoleError` — or a permanent broker refusal —
    // must reach the step runner as a failure. Recovering here is how the
    // ambient-identity class of bug gets reintroduced one layer up.
    const grant = await broker.resolveToken(modelAuth.brokerRole);
    return {
      mode: modelAuth.mode,
      provisioned: true,
      dryRun: false,
      brokerRole: modelAuth.brokerRole,
      brokerMode: grant.mode,
      credential: {
        source: grant.credentialSource,
        tokenType: grant.tokenType,
        fingerprint: grant.fingerprint,
        expiresAt: grant.expiresAt,
        secretRefs: grant.secretRefs,
      },
    };
  }

  // ---- standalone-token: no broker is constructed, contacted, or required ----

  if (dryRun) {
    return {
      mode: modelAuth.mode,
      provisioned: false,
      dryRun: true,
      tokenRef: modelAuth.tokenRef,
      credential: null,
    };
  }

  const resolve = resolveSecret ?? createSecretResolver();
  let secret;
  try {
    secret = await resolve(modelAuth.tokenRef, { field: `harness.${spec.class}.modelAuth.tokenRef` });
  } catch (err) {
    throw new ModelAuthError(
      `could not resolve the model-auth token reference ${modelAuth.tokenRef} for harness `
      + `${JSON.stringify(spec.class)}: ${err.message}`,
      { code: err.code ?? 'secret_ref', cause: err },
    );
  }
  if (!SecretValue.isSecret(secret)) {
    /* c8 ignore next 4 -- a resolver returning a bare string would leak it */
    throw new ModelAuthError(
      `internal: the secret resolver returned an unwrapped value for ${modelAuth.tokenRef}`,
    );
  }

  return {
    mode: modelAuth.mode,
    provisioned: true,
    dryRun: false,
    tokenRef: modelAuth.tokenRef,
    credential: {
      source: 'standalone_token_ref',
      tokenType: credentialShape(secret),
      fingerprint: secret.fingerprint(),
      // A static reference has no issuer-declared expiry. `null` says "this does
      // not expire on its own"; a synthesized deadline would be a claim about a
      // credential ARF has no lifetime information for.
      expiresAt: null,
      secretRefs: [modelAuth.tokenRef],
      resolvedAt: Math.round(now()),
    },
  };
}
