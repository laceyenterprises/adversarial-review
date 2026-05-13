import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentOsHqReviewerRuntimeAdapter } from './agent-os-hq/index.mjs';
import { createCliDirectReviewerRuntimeAdapter } from './cli-direct/index.mjs';
import { createFixtureStubReviewerRuntimeAdapter } from './fixture-stub/index.mjs';
import { pruneReviewerRunRecords, readRecoverableReviewerRunRecords } from './run-state.mjs';

function loadDomainConfig(rootDir, domainId) {
  return JSON.parse(readFileSync(join(rootDir, 'domains', `${domainId}.json`), 'utf8'));
}

function resolveReviewerRuntimeName(domainConfig = {}) {
  return domainConfig.reviewerRuntime || 'cli-direct';
}

function createReviewerRuntimeAdapterByName(name = 'cli-direct', options = {}) {
  switch (name) {
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
  ...options
}) {
  const runtimeName = resolveReviewerRuntimeName(domainConfig);
  return createReviewerRuntimeAdapterByName(runtimeName, {
    rootDir,
    ...options,
  });
}

async function recoverReviewerRunRecords({
  rootDir,
  adapter,
  db = null,
  log = console,
  now = new Date(),
  ttlMs = 24 * 60 * 60 * 1000,
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
    const result = await adapter.reattach(record);
    if (result.failureClass === 'daemon-bounce' && db) {
      const outcome = db.prepare(
        "UPDATE reviewed_prs SET review_status = 'failed', failed_at = ?, failure_message = ? WHERE reviewer_session_uuid = ? AND review_status = 'reviewing'"
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
  createReviewerRuntimeAdapterByName,
  createReviewerRuntimeAdapterForDomain,
  loadDomainConfig,
  recoverReviewerRunRecords,
  resolveReviewerRuntimeName,
};
