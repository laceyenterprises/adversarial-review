/**
 * `ar-govern` read surface: the Screen B payload (ARF-04).
 *
 * Assembles the four inputs Screen B needs and nothing else:
 *
 *   governance config layers ─┐
 *   daemon heartbeats ────────┼─→ merge-path arm state + stop-state
 *   (pure derivation) ────────┘
 *   review store ─────────────→ review-cycle-cap burndown
 *
 * The derivation itself lives in `merge-paths.mjs` and takes no I/O, so this
 * module's job is strictly to gather inputs and hand them over. That split is
 * what keeps the stop-state answer O(1) and independent of how many PRs are in
 * flight: the burndown, which *is* proportional to the store, is computed
 * separately and can never feed back into whether a path is armed.
 *
 * SPEC §5 is in force here: this is a read surface. There is no arm/disarm
 * *write* in ARF-04 — the load-independent gate the pipeline honours is ARF-08.
 * Reporting the true state honestly is this ticket's whole contract.
 */

import { readGovernanceConfig } from './config-source.mjs';
import { buildReviewCycleBurndown } from './cycle-cap.mjs';
import { GOVERNANCE_KEYS, MERGE_AUTHORITY_KEY_IDS } from './keys.mjs';
import { probeDaemons } from './liveness.mjs';
import { deriveMergePaths } from './merge-paths.mjs';

/** The newest mtime across the governance layers, or null if none was read. */
function newestConfigChange(sources) {
  const stamps = sources
    .map((source) => (source.modifiedAt ? Date.parse(source.modifiedAt) : NaN))
    .filter((ms) => Number.isFinite(ms));
  return stamps.length === 0 ? null : new Date(Math.max(...stamps)).toISOString();
}

/**
 * Build the `/pipeline/health` payload.
 *
 * @param {object} options
 * @param {ReturnType<import('../config.mjs').loadConfig>} options.config
 * @param {import('../store/review-store.mjs').ReviewStore} options.store
 * @param {() => number} [options.now]
 */
export function buildPipelineHealth({ config, store, now = Date.now }) {
  const pipeline = config.pipeline;

  const governance = readGovernanceConfig({
    files: pipeline.configFiles,
    envFile: pipeline.envFile,
  });

  const daemons = probeDaemons({
    sources: pipeline.heartbeats,
    staleAfterMs: pipeline.heartbeatStaleMs,
    now,
  });

  const configChangedAt = newestConfigChange(governance.sources);
  const { paths, stopState, killSwitches } = deriveMergePaths({
    keys: governance.keys,
    daemons,
    envLayerObservable: governance.envLayer.observable,
    configChangedAt,
  });

  const cycles = store.reviewCycles();
  const reviewCycle = buildReviewCycleBurndown({
    cycles: cycles.cycles,
    capKey: governance.keys.reviewCycleCap,
    windowKey: governance.keys.reviewCycleWindowHours,
    now,
  });

  return {
    generatedAt: new Date(now()).toISOString(),
    daemons: Object.values(daemons),
    mergePaths: paths,
    stopState,
    killSwitches,
    governance: {
      sources: governance.sources,
      configChangedAt,
      envLayer: governance.envLayer,
      // Split by group so a renderer can show the merge-authority keys as the
      // governance block and the review-cycle keys with the burndown, without
      // either surface having to know the key names.
      keys: Object.fromEntries(
        MERGE_AUTHORITY_KEY_IDS.map((id) => [id, governance.keys[id]]),
      ),
      // Every key ARF resolved, including the review-cycle ones, so a caller
      // never has to guess which block a key landed in.
      allKeys: governance.keys,
      anySourceReadable: governance.anySourceReadable,
    },
    reviewCycle: { ...reviewCycle, store: cycles.store },
    store: store.describe(),
  };
}

export { GOVERNANCE_KEYS };
