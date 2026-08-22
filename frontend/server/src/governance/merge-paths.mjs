/**
 * The stop-state derivation (ARF-04 — the correctness core).
 *
 * This module answers one question per merge path: **can this path merge?** It
 * is a pure function of the resolved governance keys and the daemon probes. It
 * reads no file, opens no store, and never looks at how many PRs are in flight,
 * so its cost is O(number of paths) — a fixed 3 — rather than O(load). A gate
 * whose answer depends on load is a gate that answers differently under the
 * conditions an operator most needs it (SPEC §6; the 2026-07-18 / 2026-07-26
 * "hot-path gates must be load-independent" doctrine).
 *
 * ## Two axes, deliberately not collapsed
 *
 * **`armed`** is the config-derived question: do the governing inputs permit
 * this path to merge? Tri-state — `true`, `false`, or `null` for "ARF could not
 * establish it". A path is disarmed the moment *any* one of its required inputs
 * fails, so neither kill-switch key can outvote the other: with
 * `enabled: true` and `autonomous_merge_execution_enabled: false`, the
 * daemon-clean path is disarmed, full stop.
 *
 * **`effective`** is the operational question: is this path *proven* stopped?
 * It is not the same question, and treating it as the same is the recorded
 * failure. The Node watcher's `process.env` is frozen at boot and the canonical
 * env override outranks every YAML file, so a config flip is not a stop until
 * the daemon has been bounced — on 2026-07-26 two config-flag halts plus
 * bounces did not stop live merges. So a disarming config over a *live*
 * executor resolves to `unknown`, not `stopped`, and the reason names the
 * bounce that would settle it.
 *
 * The asymmetry is on purpose. Claiming `armed` when the pipeline is stopped
 * strands PRs; claiming `stopped` when it is still merging is how a governance
 * breach goes unnoticed. `unknown` is therefore always preferred over
 * `stopped`, and `stopped` is only ever reached from positive evidence.
 *
 * ## Three paths, not two
 *
 * The MSM model has two paths, and the ticket is about representing both. But
 * the Python auto-merge daemon is a third merge-capable actor, and neither
 * kill-switch key stops it: it does not read `autonomous_merge_execution_enabled`
 * at all, and `enabled: false` removes its 30-minute deferral to the AMA closer
 * rather than disabling it — so the "off" position of that switch makes the
 * backstop merge *sooner*. A panel that showed only the two MSM paths would
 * render both disarmed and let an operator read that as "the pipeline is
 * stopped" while merges continued. It is therefore carried as a distinct path
 * whose arm state comes from its daemon's liveness, and it counts in the
 * aggregate.
 */

import { MERGE_PATHS, MSM_PATH_IDS } from './keys.mjs';

/** A live-or-recently-live executor cannot be assumed to have adopted a flip. */
const LIVE_EXECUTOR_STATES = new Set(['up', 'stale']);

function evaluateRequirement(requirement, key) {
  const base = {
    keyId: requirement.keyId,
    key: key?.key ?? requirement.keyId,
    label: key?.label ?? requirement.keyId,
    value: key?.known ? key.value : null,
    known: Boolean(key?.known),
    expected: requirement.equals !== undefined ? requirement.equals : `>= ${requirement.atLeast}`,
  };
  if (!key || !key.known) {
    return { ...base, verdict: 'unknown', reason: key?.reason ?? 'value not established' };
  }
  const satisfied = requirement.equals !== undefined
    ? key.value === requirement.equals
    : Number.isInteger(key.value) && key.value >= requirement.atLeast;
  return { ...base, verdict: satisfied ? 'satisfied' : 'disarms', reason: null };
}

/**
 * Whether a disarming config value can be proven to have reached the executor.
 *
 * Two things have to hold, and each is a real way the proof fails:
 *
 *   1. the executor started *after* the newest governance config change — a
 *      long-lived daemon is still running the config it booted with;
 *   2. the environment layer is observable, or none of the disarming keys has
 *      an env override — because a plist-pinned env var outranks the file ARF
 *      just read, and changing one requires bootout+bootstrap.
 *
 * Neither is knowable today from the watcher's own heartbeat, so this normally
 * answers `unproven`. It is written as a real check rather than a constant so
 * ARF-08's supervisor, which does know when it started a process, can settle it
 * without this module changing.
 */
function adoptionOf({ executor, configChangedAt, envLayerObservable, disarmingKeys }) {
  const startedAt = executor?.startedAt ? Date.parse(executor.startedAt) : NaN;
  const changedAt = configChangedAt ? Date.parse(configChangedAt) : NaN;
  const envPinnable = disarmingKeys.some((key) => Boolean(key.env));

  if (envPinnable && !envLayerObservable) {
    return {
      state: 'unproven',
      reason: 'the environment layer outranks every config file and ARF cannot observe '
        + "the daemon's environment; a plist-pinned override may still be arming this path",
    };
  }
  if (!Number.isFinite(startedAt)) {
    return {
      state: 'unproven',
      reason: 'the executor daemon does not report when it started, so ARF cannot show it '
        + 'has restarted since the config changed (daemons cache config at boot)',
    };
  }
  if (!Number.isFinite(changedAt)) {
    return {
      state: 'unproven',
      reason: 'ARF could not date the governance config, so it cannot show the daemon '
        + 'restarted after the change',
    };
  }
  if (startedAt >= changedAt) return { state: 'adopted', reason: null };
  return {
    state: 'pending-bounce',
    reason: 'the governance config changed after the daemon started; the flip does not '
      + 'take effect until the daemon is bounced',
  };
}

function deriveArmed(path, keys, executor) {
  if (path.armedByLiveness) {
    // No config key governs this path. Its liveness IS its arm state, which is
    // why "unknown liveness" must not round to "disarmed" here.
    if (executor.state === 'unknown') {
      return {
        armed: null,
        requirements: [],
        disarmedBy: [],
        reason: `no liveness signal for ${executor.job}, and no merge-authority key `
          + 'governs this path — ARF cannot say whether it can merge',
      };
    }
    if (LIVE_EXECUTOR_STATES.has(executor.state)) {
      return {
        armed: true,
        requirements: [],
        disarmedBy: [],
        reason: `${executor.job} is ${executor.state} and no merge-authority key disarms `
          + 'this path; only a launchd disable + bootout stops it',
      };
    }
    return {
      armed: false,
      requirements: [],
      disarmedBy: [],
      reason: `${executor.job} is not beating; note that a KeepAlive relaunch re-arms this `
        + 'path unless the launchd job is also disabled',
    };
  }

  const requirements = path.requires.map((req) => evaluateRequirement(req, keys[req.keyId]));
  const disarming = requirements.filter((req) => req.verdict === 'disarms');
  if (disarming.length > 0) {
    // Any single failing input disarms, even when another input is unknown:
    // "some other key might also be off" never makes a path more armed.
    return {
      armed: false,
      requirements,
      disarmedBy: disarming.map((req) => req.key),
      reason: null,
    };
  }
  const unknown = requirements.filter((req) => req.verdict === 'unknown');
  if (unknown.length > 0) {
    return {
      armed: null,
      requirements,
      disarmedBy: [],
      reason: `ARF could not establish ${unknown.map((req) => req.key).join(', ')}`,
    };
  }
  return { armed: true, requirements, disarmedBy: [], reason: null };
}

function deriveEffective({ armed, path, executor, adoption }) {
  if (armed === null) {
    return { state: 'unknown', reasons: ['this path\'s arm state could not be established'] };
  }
  if (armed === true) {
    const reasons = [`${path.label} is armed`];
    if (!LIVE_EXECUTOR_STATES.has(executor.state)) {
      reasons.push(
        `${executor.job} is ${executor.state}, so nothing is executing right now — but the `
        + 'path is armed and merges resume when it does',
      );
    }
    return { state: 'merging-possible', reasons };
  }

  if (path.armedByLiveness) {
    // Disarmed here means "the daemon is not beating", which IS the evidence.
    return {
      state: 'stopped',
      reasons: [
        `${executor.job} is ${executor.state} and this path has no other executor`,
        'a launchd disable is still required so KeepAlive cannot relaunch it',
      ],
    };
  }

  if (LIVE_EXECUTOR_STATES.has(executor.state)) {
    if (adoption.state === 'adopted') {
      return {
        state: 'stopped',
        reasons: [
          'disarmed by its governing config',
          `${executor.job} started after the config changed, so the flip is in effect`,
        ],
      };
    }
    return {
      state: 'unknown',
      reasons: [
        'the config disarms this path, but a live daemon caches config and environment at '
        + 'boot, so a flip is not proven to be in effect',
        adoption.reason,
        `bounce ${executor.job} (launchctl bootout, wait for it to settle, then bootstrap) `
        + 'and re-check',
      ].filter(Boolean),
    };
  }

  if (executor.state === 'down') {
    return {
      state: 'stopped',
      reasons: [
        'disarmed by its governing config',
        `${executor.job} is not beating, so nothing is executing this path`,
      ],
    };
  }

  return {
    state: 'unknown',
    reasons: [
      'the config disarms this path, but ARF has no liveness signal for '
      + `${executor.job}, so it cannot show the flip is in effect`,
    ],
  };
}

/**
 * Derive per-path arm state and the aggregate stop-state.
 *
 * @param {object} options
 * @param {Record<string, object>} options.keys resolved governance keys, by id
 * @param {Record<string, object>} options.daemons daemon probes, by id
 * @param {boolean} [options.envLayerObservable]
 * @param {string|null} [options.configChangedAt] newest governance-config mtime
 * @returns {{paths: object[], stopState: object, killSwitches: object[]}}
 */
export function deriveMergePaths({
  keys = {},
  daemons = {},
  envLayerObservable = false,
  configChangedAt = null,
} = {}) {
  const paths = MERGE_PATHS.map((path) => {
    const executor = daemons[path.executor] ?? {
      id: path.executor, job: path.executor, state: 'unknown', label: path.executor,
    };
    const { armed, requirements, disarmedBy, reason } = deriveArmed(path, keys, executor);
    const adoption = armed === false && !path.armedByLiveness
      ? adoptionOf({
        executor,
        configChangedAt,
        envLayerObservable,
        disarmingKeys: requirements.filter((req) => req.verdict === 'disarms')
          .map((req) => keys[req.keyId])
          .filter(Boolean),
      })
      : { state: 'not-applicable', reason: null };

    return {
      id: path.id,
      label: path.label,
      msm: path.msm,
      role: path.role,
      // True for a path no merge-authority key governs, so a consumer can tell
      // "every requirement is satisfied" apart from "there are no requirements".
      armedByLiveness: Boolean(path.armedByLiveness),
      executor: { id: executor.id, job: executor.job, state: executor.state },
      armed,
      state: armed === true ? 'armed' : armed === false ? 'disarmed' : 'unknown',
      armReason: reason,
      requirements,
      disarmedBy,
      // Keys that shape what an armed path may merge, kept apart from the arm
      // decision so a renderer cannot fold `strict_mode` into "is it armed".
      modifiers: path.modifiers
        .map((keyId) => keys[keyId])
        .filter(Boolean)
        .map((key) => ({
          keyId: key.id, key: key.key, label: key.label, value: key.known ? key.value : null,
          known: key.known, note: key.note,
        })),
      adoption,
      effective: deriveEffective({
        armed,
        path,
        executor,
        adoption,
      }),
    };
  });

  return { paths, stopState: summarize(paths), killSwitches: summarizeKillSwitches(paths, keys) };
}

function summarize(paths) {
  const byEffective = (state) => paths.filter((p) => p.effective.state === state).map((p) => p.id);
  const merging = byEffective('merging-possible');
  const stopped = byEffective('stopped');
  const unknown = byEffective('unknown');

  // Order matters and is the whole safety property: any path that can merge
  // makes the aggregate "merging possible", and only positive evidence for
  // EVERY path makes it "stopped". Nothing rounds an unknown up to a stop.
  const state = merging.length > 0 ? 'merging-possible' : unknown.length > 0 ? 'unknown' : 'stopped';

  const reasons = [];
  if (merging.length > 0) reasons.push(`${merging.join(', ')} can still merge`);
  for (const path of paths) {
    if (path.effective.state === 'unknown') {
      reasons.push(`${path.id}: ${path.effective.reasons[0]}`);
    }
  }
  if (state === 'stopped') {
    reasons.push('every merge path is disarmed with its executor not beating; a launchd '
      + 'disable keeps KeepAlive from relaunching them');
  }

  return {
    state,
    mergingPaths: merging,
    stoppedPaths: stopped,
    unknownPaths: unknown,
    armedPaths: paths.filter((p) => p.armed === true).map((p) => p.id),
    disarmedPaths: paths.filter((p) => p.armed === false).map((p) => p.id),
    unknownArmPaths: paths.filter((p) => p.armed === null).map((p) => p.id),
    msmPaths: MSM_PATH_IDS,
    reasons,
  };
}

/**
 * Per kill-switch key: which paths it currently disarms, and — the part that
 * matters — which merge-capable paths it does **not** govern at all.
 */
function summarizeKillSwitches(paths, keys) {
  return Object.values(keys)
    .filter((key) => key.killSwitch)
    .map((key) => {
      const governs = paths.filter((path) => path.requirements.some((req) => req.keyId === key.id));
      return {
        keyId: key.id,
        key: key.key,
        label: key.label,
        value: key.known ? key.value : null,
        known: key.known,
        source: key.source,
        env: key.env,
        caveats: key.caveats,
        governs: governs.map((path) => path.id),
        doesNotGovern: paths.filter((path) => !governs.includes(path)).map((path) => path.id),
        disarming: governs
          .filter((path) => path.disarmedBy.includes(key.key))
          .map((path) => path.id),
        note: key.note,
      };
    });
}
