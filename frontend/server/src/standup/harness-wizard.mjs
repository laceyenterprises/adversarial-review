/**
 * The harness standup wizard: five steps, one run, an SSE-shaped event stream
 * (ARF-06 / SPEC §1 Screen C).
 *
 *   1. register-class        class + entitlement + allowed models + bot identity
 *   2. provision-model-auth  broker-OAuth (ARF-07) or a standalone token ref
 *   3. verify-runtime        the harness CLI is installed and answers
 *   4. wire-allowlist        the bot login goes into the reviewer allowlist
 *   5. verify-allowlist      re-read from disk and confirm it is really there
 *
 * ## Why the manifest is written step by step
 *
 * Each step persists its own result rather than the run writing one record at
 * the end. A run that dies at step 4 leaves a manifest that says so — class
 * registered, model-auth provisioned, allowlist not wired — instead of leaving
 * nothing at all and inviting a second run to start from a state nobody can see.
 *
 * ## Why `ready` is hard to reach
 *
 * `status: 'ready'` is written by exactly one place: the end of a run in which
 * every step passed. A failed step aborts the run, marks the remaining steps
 * `skipped`, and leaves `status: 'incomplete'` with `failedStep` naming the
 * step. This is the asymmetry the ticket asks for. A harness whose allowlist
 * wiring silently failed but which reads as `ready` is the exact shape of the
 * outage this flow exists to prevent: reviews get posted, nothing counts them,
 * and every surface says the harness is fine.
 *
 * ## Dry runs
 *
 * A dry run validates the spec, checks the broker mapping, looks for the runtime
 * binary, and verifies the allowlist against *what the file would contain* — and
 * writes nothing. Every step result carries `dryRun: true` so a dry verification
 * can never be read as a live one.
 */

import { randomUUID } from 'node:crypto';

import { openTokenBroker } from '../broker/index.mjs';
import { harnessCatalog } from './catalog.mjs';
import {
  HARNESS_MANIFEST_VERSION, MODEL_AUTH_BROKER_OAUTH, emptyHarnessManifest, harnessRecord,
  normalizeHarnessSpec,
} from './harness-manifest.mjs';
import { probeRuntime } from './runtime-probe.mjs';
import { provisionModelAuth } from './model-auth.mjs';
import {
  addAllowlistEntry, describeVerificationFailure, emptyReviewerAllowlist,
  parseReviewerAllowlist, verifyAllowlist,
} from './reviewer-allowlist.mjs';
import { openJsonState } from './state-store.mjs';

export const STEP_REGISTER_CLASS = 'register-class';
export const STEP_PROVISION_MODEL_AUTH = 'provision-model-auth';
export const STEP_VERIFY_RUNTIME = 'verify-runtime';
export const STEP_WIRE_ALLOWLIST = 'wire-allowlist';
export const STEP_VERIFY_ALLOWLIST = 'verify-allowlist';

export const HARNESS_STANDUP_STEPS = Object.freeze([
  STEP_REGISTER_CLASS,
  STEP_PROVISION_MODEL_AUTH,
  STEP_VERIFY_RUNTIME,
  STEP_WIRE_ALLOWLIST,
  STEP_VERIFY_ALLOWLIST,
]);

function parseHarnessManifest(document, { source }) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new TypeError(`${source} must contain a JSON object`);
  }
  const harnesses = document.harnesses ?? {};
  if (harnesses === null || typeof harnesses !== 'object' || Array.isArray(harnesses)) {
    throw new TypeError(`${source}: "harnesses" must be a JSON object keyed by class`);
  }
  return {
    version: Number.isInteger(document.version) ? document.version : HARNESS_MANIFEST_VERSION,
    harnesses,
  };
}

/**
 * Build the harness-standup service over a loaded ARF config.
 *
 * Every side effect is injectable, so the tests never need a broker endpoint, a
 * 1Password session, or a harness CLI on the machine running them.
 *
 * @param {object} options
 * @param {ReturnType<import('../config.mjs').loadConfig>} options.config
 * @param {object|null} [options.broker] ARF-07 broker; built lazily from config
 *   when a run actually needs one, so a standalone-token run never constructs it
 * @param {Function} [options.resolveSecret]
 * @param {Function} [options.execFileImpl]
 * @param {() => string} [options.clock] ISO timestamps
 * @param {() => string} [options.newRunId]
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export function createHarnessStandup({
  config,
  broker = null,
  resolveSecret = null,
  execFileImpl = undefined,
  clock = () => new Date().toISOString(),
  newRunId = () => randomUUID(),
  env = process.env,
} = {}) {
  const standup = config.standup;
  const manifestStore = openJsonState(standup.harnessManifestPath, {
    empty: emptyHarnessManifest,
    parse: parseHarnessManifest,
  });
  const allowlistStore = openJsonState(standup.reviewerAllowlistPath, {
    empty: emptyReviewerAllowlist,
    parse: parseReviewerAllowlist,
  });

  // Built once, and only for a run that asks for broker-OAuth. A standalone
  // deployment has no broker to point at, and constructing one eagerly would
  // make an absent role map a boot-time concern for a flow that never uses it.
  let lazyBroker = broker;
  function brokerInstance() {
    if (lazyBroker !== null) return lazyBroker;
    lazyBroker = openTokenBroker(config, resolveSecret ? { resolveSecret } : {});
    return lazyBroker;
  }

  function describeBroker() {
    try {
      return brokerInstance().describe();
    } catch (err) {
      return { available: false, configured: false, roles: [], reason: err.message };
    }
  }

  /** Merge a patch into one harness record, under the manifest lock. */
  async function patchHarness(harnessClass, patch, at) {
    const { document } = await manifestStore.update((current) => {
      const existing = current.harnesses[harnessClass];
      if (!existing) return null;
      return {
        document: {
          ...current,
          harnesses: {
            ...current.harnesses,
            [harnessClass]: { ...existing, ...patch, updatedAt: at },
          },
        },
        result: null,
      };
    });
    return document.harnesses[harnessClass] ?? null;
  }

  async function stepRegisterClass(ctx) {
    const { spec, dryRun, at } = ctx;
    if (dryRun) {
      return {
        dryRun: true,
        class: spec.class,
        entitlement: spec.entitlement,
        allowedModels: [...spec.allowedModels],
        defaultModel: spec.defaultModel,
        botLogin: spec.botIdentity.postingLogins[0],
        detail: 'dry run: the class validated but was not written to the manifest',
      };
    }

    const record = harnessRecord(spec, { registeredAt: at });
    const { result } = await manifestStore.update((current) => {
      const previous = current.harnesses[spec.class] ?? null;
      const next = previous
        // Re-registering keeps the original registration time and resets
        // everything the run is about to re-prove. Carrying a previous
        // `verified: true` forward would let a re-run that fails at step 3 still
        // display a verified allowlist from a run whose spec may have differed.
        ? { ...record, registeredAt: previous.registeredAt, updatedAt: at }
        : record;
      return {
        document: { ...current, harnesses: { ...current.harnesses, [spec.class]: next } },
        result: { replaced: Boolean(previous) },
      };
    });

    ctx.record = record;
    return {
      dryRun: false,
      class: spec.class,
      entitlement: spec.entitlement,
      allowedModels: [...spec.allowedModels],
      defaultModel: spec.defaultModel,
      botLogin: spec.botIdentity.postingLogins[0],
      replaced: result?.replaced ?? false,
      manifestPath: manifestStore.path,
    };
  }

  async function stepProvisionModelAuth(ctx) {
    const { spec, dryRun } = ctx;
    const provisioned = await provisionModelAuth({
      spec,
      // Only a broker-OAuth harness gets a broker. In standalone-token mode this
      // is `null` and nothing downstream can quietly reach for one — the broker
      // is not even constructed, which is what "no in-OS broker dependency"
      // has to mean to be worth claiming.
      broker: spec.modelAuth.mode === MODEL_AUTH_BROKER_OAUTH ? brokerInstance() : null,
      resolveSecret,
      dryRun,
    });
    if (!dryRun) {
      await patchHarness(spec.class, {
        modelAuth: {
          mode: provisioned.mode,
          brokerRole: provisioned.brokerRole ?? null,
          tokenRef: provisioned.tokenRef ?? null,
          provider: spec.modelAuth.provider,
          provisioned: provisioned.provisioned,
          credential: provisioned.credential,
        },
      }, ctx.at);
    }
    return provisioned;
  }

  async function stepVerifyRuntime(ctx) {
    const { spec, dryRun } = ctx;
    const runtime = await probeRuntime({
      runtime: spec.runtime,
      allowlist: standup.runtimeCommandAllowlist,
      searchPath: standup.runtimeSearchPath,
      allowInstall: standup.allowRuntimeInstall,
      timeoutMs: standup.runtimeProbeTimeoutMs,
      execFileImpl,
      env,
      dryRun,
    });
    if (!dryRun && spec.runtime) {
      await patchHarness(spec.class, {
        runtime: {
          ...spec.runtime,
          versionArgs: [...spec.runtime.versionArgs],
          installArgs: [...spec.runtime.installArgs],
          verified: runtime.verified,
          resolvedPath: runtime.resolvedPath ?? null,
          version: runtime.version ?? null,
          installed: runtime.installed ?? false,
        },
      }, ctx.at);
    }
    return runtime;
  }

  async function stepWireAllowlist(ctx) {
    const { spec, dryRun, at } = ctx;
    const logins = spec.botIdentity.postingLogins;

    if (!spec.reviewerAllowlist.enabled) {
      // Opting out is legal but never silent: it is typed into the spec, echoed
      // in the step result, and recorded on the harness, so "this harness's
      // posts do not count as reviews" is a visible property, not an omission.
      return {
        skipped: true,
        reason: 'harness.reviewerAllowlist.enabled is false — this harness\'s posts will not '
          + 'be counted as reviews',
        logins,
      };
    }

    if (dryRun) {
      const current = await allowlistStore.read();
      const projected = addAllowlistEntry(current, {
        login: logins[0],
        logins,
        harnessClass: spec.class,
        entitlement: spec.entitlement,
        kind: spec.botIdentity.kind,
        at,
        note: spec.reviewerAllowlist.note,
      });
      ctx.projectedAllowlist = projected.state;
      return {
        dryRun: true,
        logins,
        changed: projected.changed,
        allowlistPath: allowlistStore.path,
        detail: 'dry run: the entry was computed but not written',
      };
    }

    const { result } = await allowlistStore.update((current) => {
      const next = addAllowlistEntry(current, {
        login: logins[0],
        logins,
        harnessClass: spec.class,
        entitlement: spec.entitlement,
        kind: spec.botIdentity.kind,
        at,
        note: spec.reviewerAllowlist.note,
      });
      // An unchanged allowlist is not rewritten: a re-run should be a no-op on
      // disk, not a new mtime that makes it look like something moved.
      if (!next.changed) return null;
      return { document: next.state, result: { changed: true, entry: next.entry } };
    });

    await patchHarness(spec.class, {
      reviewerAllowlist: {
        enabled: true,
        note: spec.reviewerAllowlist.note,
        logins: [...logins],
        wired: true,
        // Wiring is not verification. `verified` stays false until step 5 has
        // read the file back and found the entry.
        verified: false,
      },
    }, at);

    return {
      dryRun: false,
      logins,
      changed: result?.changed ?? false,
      allowlistPath: allowlistStore.path,
    };
  }

  async function stepVerifyAllowlist(ctx) {
    const { spec, dryRun } = ctx;
    const logins = spec.botIdentity.postingLogins;

    if (!spec.reviewerAllowlist.enabled) {
      return { skipped: true, reason: 'allowlist wiring was not requested', logins };
    }

    // The re-read is the verification. Confirming the object the previous step
    // just built would only prove ARF can remember its own decision; what has to
    // be true is that the bytes on disk carry the login.
    const state = dryRun ? ctx.projectedAllowlist : await allowlistStore.read();
    const verdict = verifyAllowlist(state, { logins, harnessClass: spec.class });

    if (!verdict.present) {
      const err = new Error(describeVerificationFailure(verdict, { path: allowlistStore.path }));
      err.code = 'reviewer_allowlist_unverified';
      err.detail = { missing: verdict.missing, mismatched: verdict.mismatched };
      throw err;
    }

    if (!dryRun) {
      await patchHarness(spec.class, {
        reviewerAllowlist: {
          enabled: true,
          note: spec.reviewerAllowlist.note,
          logins: [...logins],
          wired: true,
          verified: true,
          verifiedAt: ctx.at,
          verifiedFrom: allowlistStore.path,
        },
      }, ctx.at);
    }

    return {
      dryRun,
      verified: !dryRun,
      logins,
      entry: verdict.entry,
      allowlistPath: allowlistStore.path,
      detail: dryRun
        ? 'dry run: verified against the allowlist this run would have written'
        : `confirmed by re-reading ${allowlistStore.path}`,
    };
  }

  const RUNNERS = new Map([
    [STEP_REGISTER_CLASS, stepRegisterClass],
    [STEP_PROVISION_MODEL_AUTH, stepProvisionModelAuth],
    [STEP_VERIFY_RUNTIME, stepVerifyRuntime],
    [STEP_WIRE_ALLOWLIST, stepWireAllowlist],
    [STEP_VERIFY_ALLOWLIST, stepVerifyAllowlist],
  ]);

  /**
   * Validate a spec without running anything. Separated so the HTTP layer can
   * answer a malformed request with a 400 *before* it commits to a stream — an
   * event stream whose first frame is a validation error is a worse 400.
   */
  function validate(rawSpec) {
    return normalizeHarnessSpec(rawSpec);
  }

  /**
   * Run a harness standup.
   *
   * @param {object} rawSpec
   * @param {object} [options]
   * @param {boolean} [options.dryRun]
   * @param {(event: {event: string, data: object}) => void} [options.emit]
   * @returns {Promise<object>} the run summary (also the last event's payload)
   */
  async function run(rawSpec, { dryRun = false, emit = () => {} } = {}) {
    const spec = validate(rawSpec);
    const runId = newRunId();
    const startedAt = clock();
    const ctx = { spec, dryRun, at: startedAt, record: null, projectedAllowlist: null };
    const steps = [];

    emit({
      event: 'run.start',
      data: {
        runId,
        class: spec.class,
        entitlement: spec.entitlement,
        modelAuthMode: spec.modelAuth.mode,
        dryRun,
        steps: [...HARNESS_STANDUP_STEPS],
        startedAt,
      },
    });

    let failed = null;
    for (const [index, name] of HARNESS_STANDUP_STEPS.entries()) {
      if (failed) {
        const skipped = { step: name, index, status: 'skipped', reason: `aborted after ${failed.step}` };
        steps.push(skipped);
        emit({ event: 'step.skipped', data: { runId, ...skipped } });
        continue;
      }

      emit({ event: 'step.start', data: { runId, step: name, index, total: HARNESS_STANDUP_STEPS.length } });
      const began = Date.now();
      try {
        const detail = await RUNNERS.get(name)(ctx);
        const status = detail?.skipped ? 'skipped' : 'ok';
        const record = { step: name, index, status, durationMs: Date.now() - began, detail };
        steps.push(record);
        emit({ event: status === 'ok' ? 'step.ok' : 'step.skipped', data: { runId, ...record } });
      } catch (err) {
        const record = {
          step: name,
          index,
          status: 'failed',
          durationMs: Date.now() - began,
          code: err.code ?? 'error',
          // ARF-07 errors redact by construction; this is the message, not a
          // serialized error object, so nothing incidental rides along.
          message: err.message,
          detail: err.detail ?? null,
        };
        steps.push(record);
        failed = record;
        emit({ event: 'step.failed', data: { runId, ...record } });
      }
    }

    const finishedAt = clock();
    const status = failed ? 'failed' : 'ready';

    if (!dryRun) {
      // The terminal status is written last and from one place. `ready` means
      // every step passed, including the allowlist re-read.
      await patchHarness(spec.class, {
        status: failed ? 'incomplete' : 'ready',
        failedStep: failed?.step ?? null,
        failureMessage: failed?.message ?? null,
        lastRunId: runId,
        lastRunAt: finishedAt,
      }, finishedAt);
    }

    const manifest = dryRun ? null : (await manifestStore.read()).harnesses[spec.class] ?? null;
    const summary = {
      runId,
      class: spec.class,
      status,
      dryRun,
      startedAt,
      finishedAt,
      failedStep: failed?.step ?? null,
      steps,
      harness: manifest,
    };
    emit({ event: 'run.done', data: summary });
    return summary;
  }

  return {
    run,
    validate,
    catalog: harnessCatalog,
    paths: { manifest: manifestStore.path, allowlist: allowlistStore.path },

    /**
     * Panel state: what is registered, what is allowlisted, and which broker
     * roles are available to pick from. Refs and coordinates only.
     */
    async describe() {
      const [manifest, allowlist] = await Promise.all([
        manifestStore.read(),
        allowlistStore.read(),
      ]);
      return {
        mode: config.mode,
        paths: { manifest: manifestStore.path, allowlist: allowlistStore.path },
        harnesses: Object.values(manifest.harnesses),
        allowlist: {
          path: allowlistStore.path,
          entries: allowlist.entries,
        },
        // Read straight off the broker seam so the panel offers the roles that
        // are actually mapped, rather than inviting an operator to type one that
        // will fail loud at step 2. A broker that cannot even be constructed is
        // reported as such: a standalone install still has a panel to render,
        // and blanking the whole page over an absent broker would hide the
        // harnesses that do not need one.
        broker: describeBroker(),
        runtime: {
          commandAllowlist: [...standup.runtimeCommandAllowlist],
          searchPath: [...standup.runtimeSearchPath],
          allowInstall: standup.allowRuntimeInstall,
          probeTimeoutMs: standup.runtimeProbeTimeoutMs,
        },
      };
    },
  };
}
