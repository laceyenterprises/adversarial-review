/**
 * The governance vocabulary Screen B is built on (ARF-04).
 *
 * This module is the single place that states, as data:
 *
 *   - which config keys govern autonomous merge, what they default to, and
 *     which environment variable overrides each one;
 *   - which merge *paths* exist, which daemon executes each, and which keys
 *     must hold which value for a path to be armed.
 *
 * It is data rather than code because the failure this ticket exists to prevent
 * is a panel that collapses two paths into one, or reads one key and calls it
 * the kill switch. Both paths and both keys have to be *enumerable*, so a test
 * can assert they are each represented distinctly rather than inspecting a
 * rendered string and hoping.
 *
 * Sources for the semantics below, verified against the deployed code rather
 * than inferred from the key names:
 *
 *   - `docs/RUNBOOK-adversarial-review-pipeline.md` §"Config keys and their
 *     *actual* semantics" — the authoritative table.
 *   - `src/config-loader.mjs` — schema defaults and the
 *     canonical env-override names.
 *   - `src/ama-closure-orchestration.mjs` — where
 *     `enabled` and `autonomousMergeExecutionEnabled` are consumed.
 *   - `modules/worker-pool/lib/python/cwp_dispatch/auto_merge_daemon.py` —
 *     `_ama_merge_authority_enabled` / `_should_defer_to_ama`.
 *
 * They are read as reference models. ARF imports none of them (SPEC §9).
 */

/** The config prefix every merge-authority key hangs off. */
export const MERGE_AUTHORITY_PREFIX = 'roles.adversarial.merge_authority';

/**
 * The governance keys, keyed by the short id the payload and the panel use.
 *
 * `default` is the value the pipeline's own schema declares, so a key absent
 * from every config file resolves to what the pipeline would actually use —
 * not to a value chosen here. Two of these defaults are counter-intuitive and
 * are the reason a panel must show the resolved value and its source together:
 * `enabled` defaults to **false** while `autonomousMergeExecutionEnabled`
 * defaults to **true**.
 */
export const GOVERNANCE_KEYS = Object.freeze({
  enabled: {
    id: 'enabled',
    key: `${MERGE_AUTHORITY_PREFIX}.enabled`,
    env: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_ENABLED',
    type: 'boolean',
    default: false,
    killSwitch: true,
    label: 'enabled',
    note: 'Master switch for the watcher AMA closure (both sub-paths). The Python '
      + 'auto-merge daemon reads the SAME key with a DIFFERENT meaning: true makes it '
      + 'defer to the AMA closer for a grace window, false makes it merge without '
      + 'deferring. Turning this off therefore disarms both MSM paths and REMOVES the '
      + "backstop's deferral.",
  },
  autonomousMergeExecutionEnabled: {
    id: 'autonomousMergeExecutionEnabled',
    key: `${MERGE_AUTHORITY_PREFIX}.autonomous_merge_execution_enabled`,
    env: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_AUTONOMOUS_MERGE_EXECUTION_ENABLED',
    type: 'boolean',
    default: true,
    killSwitch: true,
    label: 'autonomous_merge_execution_enabled',
    note: 'Execution kill switch for the watcher AMA closer. When false BOTH watcher '
      + 'sub-paths refuse and a fail-closed audit is written. Not read by the Python '
      + 'auto-merge daemon at all.',
  },
  strictMode: {
    id: 'strictMode',
    key: `${MERGE_AUTHORITY_PREFIX}.strict_mode`,
    env: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_STRICT_MODE',
    type: 'boolean',
    default: true,
    killSwitch: false,
    label: 'strict_mode',
    note: 'Daemon-clean path only: true ⇒ it may inline-merge only a zero-finding '
      + 'review; false ⇒ it may also merge over KNOWN non-blocking findings. It '
      + 'narrows what the daemon path may merge — it never disarms the path.',
  },
  strictNonBlockingRemediation: {
    id: 'strictNonBlockingRemediation',
    key: `${MERGE_AUTHORITY_PREFIX}.strict_non_blocking_remediation`,
    env: null,
    type: 'boolean',
    default: true,
    killSwitch: false,
    label: 'strict_non_blocking_remediation',
    note: 'Shapes the ELIGIBILITY predicate (non-blocking findings must be remediated '
      + 'before a close). Distinct from strict_mode, which shapes the daemon-clean '
      + 'path — the two are routinely confused and are shown separately for that reason.',
  },
  hammerLifetimeCeiling: {
    id: 'hammerLifetimeCeiling',
    key: `${MERGE_AUTHORITY_PREFIX}.hammer_lifetime_ceiling`,
    env: 'AGENT_OS_ROLES_ADVERSARIAL_MERGE_AUTHORITY_HAMMER_LIFETIME_CEILING',
    type: 'integer',
    default: 6,
    killSwitch: false,
    label: 'hammer_lifetime_ceiling',
    note: 'Lifetime cap on HAM terminal-remediation dispatches per PR. 0 disables the '
      + 'hammer path outright, which makes it a third input to the hammer arm state.',
  },
  branchProtectionRequired: {
    id: 'branchProtectionRequired',
    key: `${MERGE_AUTHORITY_PREFIX}.branch_protection.required`,
    env: null,
    type: 'boolean',
    default: true,
    killSwitch: false,
    label: 'branch_protection.required',
    note: 'Requires the adversarial gate to be a branch-protection required context. A '
      + 'private repo cannot satisfy it (GitHub answers 403), so leaving it true '
      + 'blocks every autonomous merge on eligibility.',
  },
  reviewCycleCap: {
    id: 'reviewCycleCap',
    key: 'review_cycle_cap',
    env: null,
    type: 'integer',
    default: 5,
    killSwitch: false,
    group: 'review-cycle',
    label: 'review_cycle_cap',
    note: 'Review rounds a PR head may consume inside the window before the cycle '
      + 'escalates. Read from the pipeline config, not from the store — the store '
      + 'records only the count.',
  },
  reviewCycleWindowHours: {
    id: 'reviewCycleWindowHours',
    key: 'review_cycle_window_hours',
    env: null,
    type: 'integer',
    default: 24,
    killSwitch: false,
    group: 'review-cycle',
    label: 'review_cycle_window_hours',
    note: 'Rolling window the cap is measured over. A counter whose last verdict is older '
      + 'than this restarts at 1 on the next verdict.',
  },
});

/** Keys that govern autonomous merge, as opposed to the review-cycle budget. */
export const MERGE_AUTHORITY_KEY_IDS = Object.freeze(
  Object.values(GOVERNANCE_KEYS)
    .filter((entry) => (entry.group ?? 'merge-authority') === 'merge-authority')
    .map((entry) => entry.id),
);

/** Ids of the two keys that can each disarm a path on their own. */
export const KILL_SWITCH_KEY_IDS = Object.freeze(
  Object.values(GOVERNANCE_KEYS).filter((entry) => entry.killSwitch).map((entry) => entry.id),
);

/** The daemons whose liveness Screen B reports. */
export const DAEMONS = Object.freeze({
  watcher: {
    id: 'watcher',
    label: 'watcher',
    job: 'adversarial-watcher',
    mergeCapable: true,
    note: 'The poll loop. Runs the daemon-clean inline merge and dispatches the hammer.',
  },
  followUp: {
    id: 'followUp',
    label: 'follow-up',
    job: 'adversarial-follow-up',
    mergeCapable: false,
    note: 'Remediation spawner and worktree reaper. It dispatches remediation workers; '
      + 'it does not itself click merge.',
  },
  autoMerge: {
    id: 'autoMerge',
    label: 'auto-merge',
    job: 'auto-merge-daemon',
    mergeCapable: true,
    note: 'The Python worker-pool backstop. Merges CLEAN + MERGEABLE gate decisions; no '
      + 'merge-authority key disarms it.',
  },
});

/**
 * The merge paths, and what governs each.
 *
 * `requires` is the full set of inputs that must hold for the path to be armed;
 * a path is disarmed as soon as **any** one of them fails, which is the
 * property the ticket names — either kill-switch key disarming a path disarms
 * it, with no key able to silently outvote the other.
 *
 * `modifiers` are keys that change what an armed path may merge without arming
 * or disarming it. They are kept in a separate field precisely so a renderer
 * cannot accidentally fold `strict_mode` into the arm decision.
 */
export const MERGE_PATHS = Object.freeze([
  {
    id: 'hammer',
    label: 'hammer',
    msm: true,
    executor: 'watcher',
    role: 'Common path. Remediates every final finding, rebases, revalidates CI at the '
      + 'rebased head, and merges under its own lease.',
    requires: [
      { keyId: 'enabled', equals: true },
      { keyId: 'autonomousMergeExecutionEnabled', equals: true },
      { keyId: 'hammerLifetimeCeiling', atLeast: 1 },
    ],
    modifiers: ['strictNonBlockingRemediation', 'branchProtectionRequired'],
  },
  {
    id: 'daemon-clean',
    label: 'daemon-clean',
    msm: true,
    executor: 'watcher',
    role: 'Rare path. On a fully-clean settled review with green required checks, a '
      + 'mergeable PR, and a matching head, the watcher clicks merge inline.',
    requires: [
      { keyId: 'enabled', equals: true },
      { keyId: 'autonomousMergeExecutionEnabled', equals: true },
    ],
    modifiers: ['strictMode', 'branchProtectionRequired'],
  },
  {
    id: 'python-backstop',
    label: 'auto-merge backstop',
    msm: false,
    executor: 'autoMerge',
    role: 'Worker-pool lane that merges CLEAN + MERGEABLE gate decisions once the AMA '
      + 'deferral window lapses.',
    // Deliberately empty. Neither kill-switch key stops this path: it does not
    // read `autonomous_merge_execution_enabled` at all, and `enabled: false`
    // makes it merge SOONER (no deferral) rather than not at all. Its only stop
    // is its launchd job, which is why its arm state is derived from liveness.
    requires: [],
    armedByLiveness: true,
    modifiers: [],
  },
]);

/** Path ids that make up the MSM two-path merge model. */
export const MSM_PATH_IDS = Object.freeze(MERGE_PATHS.filter((p) => p.msm).map((p) => p.id));
