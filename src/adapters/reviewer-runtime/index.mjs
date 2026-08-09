import { createAgentOsHqReviewerRuntimeAdapter } from './agent-os-hq/index.mjs';
import { createAgentRuntimeReviewerRuntimeAdapter } from './agent-runtime/index.mjs';
import { createAcpxReviewerRuntimeAdapter } from './acpx/index.mjs';
import { createCliDirectReviewerRuntimeAdapter } from './cli-direct/index.mjs';
import { createFixtureStubReviewerRuntimeAdapter } from './fixture-stub/index.mjs';
import { pruneReviewerRunRecords, readRecoverableReviewerRunRecords } from './run-state.mjs';
import { resolveReviewerLeaseRecoveryEnabled } from '../../reviewer-lease.mjs';
import { loadDomainConfig } from '../../domain-config.mjs';
import {
  KNOWN_REVIEWER_RUNTIME_NAMES,
  requestedReviewerRuntime,
  resolveReviewerRuntimeCutover,
  trimEnvOverride,
} from '../../reviewer-runtime-cutover.mjs';

function resolveReviewerRuntimeName(
  domainConfig = {},
  { rootDir = null, orchestrationMode = 'native', env = process.env, now, readSnapshotImpl, readCanaryImpl } = {},
) {
  // RPR-01 emergency operator kill-switch: force a reviewer runtime WITHOUT
  // editing (and re-deploying) the tracked domain config. This exists because a
  // build pack (PRD-01 #687) silently flipped code-pr from cli-direct to
  // agent-runtime with no settle smoke; the pipeline broke for days and there
  // was no fast lever to override the runtime live. Only a known adapter name is
  // honored — an unknown value is ignored (not thrown) so a typo in the env can
  // never wedge the reviewer.
  const forced = trimEnvOverride(env);
  if (forced) {
    if (KNOWN_REVIEWER_RUNTIME_NAMES.has(forced)) {
      return forced;
    }
    console.warn(
      `[reviewer-runtime] ignoring ADVERSARIAL_REVIEWER_RUNTIME='${forced}' — not a known adapter ` +
        `(${[...KNOWN_REVIEWER_RUNTIME_NAMES].join(', ')}); falling through to domain config`,
    );
  }

  const requestedRuntime = requestedReviewerRuntime(domainConfig);
  if (requestedRuntime === 'agent-runtime' || orchestrationMode === 'agentos') {
    return resolveReviewerRuntimeCutover({
      rootDir,
      domainConfig,
      orchestrationMode,
      env: {},
      now,
      readSnapshotImpl,
      readCanaryImpl,
    }).selectedRuntime;
  }
  return requestedRuntime;
}

function createReviewerRuntimeAdapterByName(name = 'cli-direct', options = {}) {
  switch (name) {
    case 'agent-runtime':
      return createAgentRuntimeReviewerRuntimeAdapter(options);
    case 'acpx':
      return createAcpxReviewerRuntimeAdapter(options);
    case 'cli-direct':
      return createCliDirectReviewerRuntimeAdapter(options);
    case 'fixture-stub':
      return createFixtureStubReviewerRuntimeAdapter(options);
    case 'agent-os-hq':
      return createAgentOsHqReviewerRuntimeAdapter(options);
    default:
      throw new Error(`Unknown reviewer runtime adapter: ${name}`);
  }
}

function createReviewerRuntimeAdapterForDomain({
  rootDir,
  domainId,
  domainConfig = loadDomainConfig(rootDir, domainId),
  orchestrationMode = 'native',
  ...options
}) {
  const runtimeName = resolveReviewerRuntimeName(domainConfig, {
    rootDir,
    orchestrationMode,
    env: options.env,
    now: options.now,
    readSnapshotImpl: options.readSnapshotImpl,
    readCanaryImpl: options.readCanaryImpl,
  });
  return createReviewerRuntimeAdapterByName(runtimeName, {
    rootDir,
    domainConfig,
    ...options,
  });
}

async function recoverReviewerRunRecords({
  rootDir,
  adapter,
  adapterForRecord = null,
  db = null,
  log = console,
  now = new Date(),
  ttlMs = 24 * 60 * 60 * 1000,
  leaseRecoveryEnabled = resolveReviewerLeaseRecoveryEnabled(),
} = {}) {
  const pruned = pruneReviewerRunRecords(rootDir, { now, ttlMs });
  const prunedTotal = typeof pruned === 'number' ? pruned : pruned.total;
  if (prunedTotal > 0) {
    const records = typeof pruned === 'number' ? pruned : pruned.records;
    const orphanSideChannelFiles = typeof pruned === 'number' ? 0 : pruned.orphanSideChannelFiles;
    log.log?.(
      `[watcher] reviewer_runtime_pruned records=${records} orphan_side_channel_files=${orphanSideChannelFiles} total=${prunedTotal}`
    );
  }
  const activeRecords = readRecoverableReviewerRunRecords(rootDir);
  let recovered = 0;
  for (const record of activeRecords) {
    let result = null;
    try {
      const recordAdapter = typeof adapterForRecord === 'function'
        ? adapterForRecord(record)
        : adapter;
      result = await recordAdapter.reattach(record);
    } catch (err) {
      log.error?.(
        `[watcher] reviewer_runtime_reattach_failed session=${record.sessionUuid} runtime=${record.runtime}: ${err?.message || err}`
      );
      continue;
    }
    if (result.failureClass === 'daemon-bounce' && db) {
      const outcome = db.prepare(
        leaseRecoveryEnabled
          ? "UPDATE reviewed_prs SET review_status = 'pending', failed_at = ?, failure_message = ?, review_attempts = review_attempts + 1, reviewer_lease_expires_at = NULL WHERE reviewer_session_uuid = ? AND review_status = 'reviewing'"
          : "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ?, reviewer_lease_expires_at = NULL WHERE reviewer_session_uuid = ? AND review_status = 'reviewing'"
      ).run(
        now.toISOString(),
        '[daemon-bounce] Reviewer runtime could not reattach after kernel restart; re-queueing review.',
        record.sessionUuid,
      );
      if (outcome.changes > 0) recovered += 1;
    }
    log.log?.(
      `[watcher] reviewer_runtime_reattach session=${record.sessionUuid} runtime=${record.runtime} result=${result.failureClass || 'ok'}`
    );
  }
  return { recovered, pruned: prunedTotal };
}

export {
  createAgentOsHqReviewerRuntimeAdapter,
  createAgentRuntimeReviewerRuntimeAdapter,
  createReviewerRuntimeAdapterByName,
  createReviewerRuntimeAdapterForDomain,
  loadDomainConfig,
  recoverReviewerRunRecords,
  resolveReviewerRuntimeName,
};
