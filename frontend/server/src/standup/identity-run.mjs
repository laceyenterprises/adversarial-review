/**
 * The identity standup step-state machine (ARF-05).
 *
 * An async generator: it yields `{event, data}` frames as it advances, and the
 * HTTP layer turns those into SSE. Keeping the machine a generator rather than a
 * callback-emitter is what makes it testable without a socket — every test in
 * this ticket drives the same code path the endpoint does, by iterating it.
 *
 * ## The frames
 *
 *   run      once, first. The full step list with its resume state already
 *            resolved, so the panel can paint the whole ritual before anything
 *            runs instead of growing a list line by line.
 *   step     every transition: `running`, then `ok` or `failed`.
 *   complete terminal, all steps ok.
 *   failed   terminal, with the failing step, a stable code, whether a re-run can
 *            resume, and what to do about it.
 *
 * Exactly one terminal frame is emitted, always. A stream that just stops is
 * indistinguishable from a dropped connection, and the panel would spin forever.
 *
 * ## Persistence, and why it is per-step
 *
 * The record is written after every step transition, not once at the end. A crash
 * — or an operator closing the tab, which aborts the request — then still leaves
 * a resumable prefix. Writing only on success would make the interrupted case,
 * which is the case resume exists for, the one case that does not resume.
 *
 * ## What this module refuses to do
 *
 * It does not catch a step's failure and try something else. A failed step ends
 * the run; the steps after it stay `pending` and are reported as such. That
 * matters most at the wire step: "the role has no token mapping" must terminate
 * the run, not degrade it into a verification performed under some other
 * identity (SPEC §6, RCA 2026-07-23).
 */

import { randomUUID } from 'node:crypto';

// The one piece of ARF-07's internals ARF-05 reaches for directly. ARF-05 signs
// an App JWT to *read* the App and its installations — a different job from
// minting an installation token, which stays entirely inside the seam and is
// reached only through `resolveToken`. Everything else comes from `index.mjs`.
import { mintAppJwt } from '../broker/github-app.mjs';
import { openTokenBroker } from '../broker/index.mjs';
import { createSecretResolver } from '../broker/secrets.mjs';
import { StandupAbortedError, errorCode, errorNextAction } from './errors.mjs';
import { mergeParams, persistableParams } from './params.mjs';
import { RECORD_SCHEMA_VERSION, fingerprintInputs, isReplayable } from './run-store.mjs';
import { IDENTITY_STEPS } from './steps.mjs';

/** Codes for which a re-run can pick up where this one stopped. */
const RESUMABLE_CODES = new Set([
  'operator_input_required',
  'broker_transient',
  'aborted',
]);

function isoAt(epochSeconds) {
  return new Date(Math.round(epochSeconds * 1000)).toISOString();
}

/**
 * The public shape of one step, as the panel and the record both see it.
 * `resumed` is carried explicitly rather than inferred: an `ok` the run proved
 * and an `ok` it replayed from a record are different claims, and a surface that
 * showed them identically would be overstating what this run verified.
 */
function stepView(step, index, state) {
  return {
    id: step.id,
    label: step.label,
    index,
    total: IDENTITY_STEPS.length,
    status: state.status,
    resumed: state.resumed === true,
    detail: state.detail ?? null,
    ...(state.completedAt ? { completedAt: state.completedAt } : {}),
    ...(state.code ? { code: state.code } : {}),
    ...(state.message ? { message: state.message } : {}),
    ...(state.nextAction ? { nextAction: state.nextAction } : {}),
  };
}

/**
 * Run an identity standup.
 *
 * @param {object} params        normalized params (see `params.mjs`)
 * @param {object} deps
 * @param {object} deps.config   the loaded ARF config
 * @param {object} deps.runStore the durable run-record store
 * @param {Function} [deps.reloadConfig] re-read config from disk; used after the
 *   wire step writes a mapping, so the broker it verifies against is the one a
 *   restarted ARF would build
 * @param {object} [deps.broker] an already-open broker (defaults to config's)
 * @param {Function} [deps.fetchImpl]
 * @param {Function} [deps.resolveSecret] ref -> Promise<SecretValue>
 * @param {() => number} [deps.now] epoch seconds
 * @param {AbortSignal|null} [deps.signal]
 * @param {() => string} [deps.newRunId]
 * @yields {{event: string, data: object}}
 */
export async function* runIdentityStandup(params, {
  config,
  runStore,
  reloadConfig = null,
  broker = null,
  fetchImpl = globalThis.fetch,
  resolveSecret = null,
  now = () => Date.now() / 1000,
  signal = null,
  newRunId = () => randomUUID(),
} = {}) {
  const role = params.role;
  const prior = runStore.read(role);
  const effective = mergeParams(prior?.params, params);
  const runId = newRunId();
  const startedAt = isoAt(now());

  // Outputs carry forward from the prior run: they are what the replayed steps
  // produced, and the steps after them read from here rather than re-deriving.
  const outputs = { ...(prior?.outputs ?? {}) };
  const states = IDENTITY_STEPS.map(() => ({ status: 'pending' }));

  const retry = {
    attempts: config.broker.transientRetryAttempts,
    baseDelayMs: config.broker.transientRetryDelayMs,
  };
  let currentBroker = broker ?? openTokenBroker(config, { fetchImpl, resolveSecret, now });
  let jwtPromise = null;
  let grantPromise = null;

  const ctx = {
    role,
    runId,
    params: effective,
    outputs,
    config,
    githubApiUrl: config.broker.githubApiUrl,
    resolveSecret: resolveSecret ?? createSecretResolver({ retry }),
    isoNow: () => isoAt(now()),

    /** The transport options every GitHub call shares. */
    github: () => ({
      githubApiUrl: config.broker.githubApiUrl,
      fetchImpl,
      requestTimeoutMs: config.broker.requestTimeoutMs,
      signal,
      retry,
    }),

    broker: () => currentBroker,

    /**
     * Rebuild the broker from config on disk. Called by the wire step after it
     * writes a mapping — see `role-mapping.mjs` for why it is a disk reload and
     * not an in-memory patch.
     */
    reloadBroker: () => {
      const reloaded = reloadConfig ? reloadConfig() : config;
      currentBroker = openTokenBroker(reloaded, { fetchImpl, resolveSecret, now });
      // The grant is derived from the mapping, so a reloaded broker invalidates it.
      grantPromise = null;
      return currentBroker;
    },

    /**
     * The App JWT, minted once per run. It is good for nine minutes, which
     * comfortably covers a standup, and re-signing per call would put another
     * secret-store round trip on every step.
     */
    appJwt: () => {
      if (!jwtPromise) {
        jwtPromise = (async () => {
          const appId = outputs.appId ?? effective.appId;
          const ref = effective.privateKeyRef ?? outputs.privateKeyRef;
          const privateKey = await ctx.resolveSecret(ref, { field: 'privateKeyRef', role });
          return mintAppJwt({ appId, privateKey, nowSeconds: now(), role });
        })();
      }
      return jwtPromise;
    },

    /**
     * The role's grant, memoized per run.
     *
     * Every path to a credential in this wizard goes through here, and every
     * path through here goes through `broker.resolveToken`, whose first act is
     * the mapping lookup. There is deliberately no branch that produces a token
     * any other way — no env var, no `gh auth`, no keychain, no "reuse the App
     * JWT for the write". An unmapped role throws and the caller does not catch.
     */
    tokenGrant: ({ broker: use = null, forceRefresh = false } = {}) => {
      if (!grantPromise || forceRefresh) {
        grantPromise = (use ?? currentBroker).resolveToken(role, { forceRefresh });
      }
      return grantPromise;
    },

    throwIfAborted: () => {
      if (signal?.aborted) throw new StandupAbortedError(null);
    },
  };

  const record = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    role,
    runId,
    startedAt,
    updatedAt: startedAt,
    status: 'running',
    params: persistableParams(effective),
    outputs,
    steps: { ...(prior?.steps ?? {}) },
  };

  const persist = (status) => {
    record.updatedAt = isoAt(now());
    record.status = status;
    record.outputs = { ...outputs };
    try {
      runStore.write(record);
    } catch {
      // A record that cannot be written costs the *next* run its resume; it does
      // not make this run wrong. Failing the standup over it would turn a
      // read-only state root into "identity standup is broken", which is a worse
      // trade than losing resumability and saying so nowhere but here.
    }
  };

  // Resume is resolved for the whole list up front, so the opening frame shows
  // the operator what will actually run rather than discovering it step by step.
  const fingerprints = [];
  let stillResuming = true;
  for (const [index, step] of IDENTITY_STEPS.entries()) {
    const fingerprint = fingerprintInputs(step.inputs(ctx));
    fingerprints.push(fingerprint);
    const recorded = record.steps[step.id];
    if (stillResuming && isReplayable(step, recorded, fingerprint)) {
      states[index] = {
        status: 'ok',
        resumed: true,
        detail: recorded.detail ?? null,
        completedAt: recorded.completedAt ?? null,
      };
    } else {
      // The first step that cannot be replayed ends the resumable prefix: every
      // step after it may consume that step's outputs, so replaying them would be
      // reporting success for work done against inputs that no longer hold.
      stillResuming = false;
    }
  }
  const resumedCount = states.filter((state) => state.resumed).length;

  yield {
    event: 'run',
    data: {
      runId,
      role,
      startedAt,
      brokerMode: config.broker.mode,
      resumedFrom: resumedCount > 0 ? IDENTITY_STEPS[resumedCount - 1].id : null,
      resumedSteps: resumedCount,
      steps: IDENTITY_STEPS.map((step, index) => stepView(step, index, states[index])),
    },
  };

  for (const [index, step] of IDENTITY_STEPS.entries()) {
    if (states[index].resumed) {
      // Replayed, not re-run — and said so, so a green tick in the panel never
      // over-claims what this run actually proved.
      yield { event: 'step', data: stepView(step, index, states[index]) };
      continue;
    }

    if (signal?.aborted) {
      const err = new StandupAbortedError(step.id);
      states[index] = { status: 'failed', code: err.code, message: err.message };
      record.steps[step.id] = { status: 'failed', code: err.code, failedAt: isoAt(now()) };
      persist('failed');
      yield { event: 'step', data: stepView(step, index, states[index]) };
      yield {
        event: 'failed',
        data: terminal({ runId, role, step, index, states, err, outputs, config }),
      };
      return;
    }

    states[index] = { status: 'running' };
    yield { event: 'step', data: stepView(step, index, states[index]) };

    try {
      const result = await step.run(ctx);
      Object.assign(outputs, result.outputs ?? {});
      const completedAt = isoAt(now());
      states[index] = { status: 'ok', detail: result.detail ?? null, completedAt };
      record.steps[step.id] = {
        status: 'ok',
        detail: result.detail ?? null,
        // Recomputed after the step ran: step 2's fingerprint covers step 1's
        // captured app_id, which did not exist when the prefix was resolved.
        fingerprint: fingerprintInputs(step.inputs(ctx)),
        completedAt,
      };
      persist('running');
      yield { event: 'step', data: stepView(step, index, states[index]) };
    } catch (err) {
      const code = errorCode(err);
      states[index] = {
        status: 'failed',
        code,
        message: String(err?.message ?? err),
        nextAction: errorNextAction(err),
      };
      record.steps[step.id] = { status: 'failed', code, failedAt: isoAt(now()) };
      persist('failed');
      yield { event: 'step', data: stepView(step, index, states[index]) };
      yield {
        event: 'failed',
        data: terminal({ runId, role, step, index, states, err, outputs, config }),
      };
      return;
    }
  }

  persist('ok');
  yield {
    event: 'complete',
    data: {
      runId,
      role,
      status: 'ok',
      completedAt: record.updatedAt,
      brokerMode: config.broker.mode,
      outputs: { ...outputs },
      steps: IDENTITY_STEPS.map((step, index) => stepView(step, index, states[index])),
    },
  };
}

/** The terminal `failed` frame. Everything the panel needs to render a refusal. */
function terminal({ runId, role, step, index, states, err, outputs, config }) {
  const code = errorCode(err);
  return {
    runId,
    role,
    status: 'failed',
    brokerMode: config.broker.mode,
    failedStep: step.id,
    failedStepIndex: index,
    failedStepLabel: step.label,
    code,
    message: String(err?.message ?? err),
    nextAction: errorNextAction(err),
    // A re-run of a transient or input-blocked failure resumes; a re-run of an
    // identity mismatch or a missing mapping will hit the same wall until the
    // operator changes something, and saying "resumable" there would suggest
    // otherwise.
    resumable: RESUMABLE_CODES.has(code),
    outputs: { ...outputs },
    steps: IDENTITY_STEPS.map((s, i) => stepView(s, i, states[i])),
  };
}
