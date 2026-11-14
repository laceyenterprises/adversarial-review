import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';
import { buildLegacyHqRemediationDispatchArgs } from '../remediation-dispatch-mode.mjs';
import { pickRemediationWorkerClass } from '../remediation-worker-routing.mjs';
import { parseDispatchJsonOutput, readDispatchReceipt } from '../producer-contracts/dispatch-receipt.mjs';
import { loadConfigCached } from '../config-loader.mjs';
import { OPERATOR_HOLD_LABELS } from '../operator-hold-labels.mjs';
import { resolveHqRoot } from '../hq-root.mjs';
import { fleetStopReason } from '../fleet-stop.mjs';
import { execGhWithRetry, isTransientGhError } from '../gh-cli.mjs';
import { probeOrphanOwnership } from './orphan-watchdog.mjs';
import { readHammerRetryCapLedger, reserveHammerRepairDispatch } from './hammer-retry-cap.mjs';
import { fetchPrimaryChange } from './primary-change.mjs';
import { createHistoryReader } from './history-reader.mjs';
import { primaryChangeRepairEvidence } from './primary-change-repair.mjs';
import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';

const execFileAsync = promisify(execFile);

// This executor has coding/push authority only. HCP admits the scoped PR update;
// the normal closer still owns all validation, merge predicates and leases.
export async function dispatchSafetyStopRepair({ rootDir, repo, prNumber, headSha, refusal,
  dispatchKey, jobKey, signal, logger = console, env = process.env,
  cfg = loadConfigCached().getMergeAuthorityConfig(), execFileImpl = execFileAsync,
  probeOwnershipImpl = probeOrphanOwnership, fleetStopImpl = fleetStopReason,
  workerClassImpl = pickRemediationWorkerClass,
  fetchPrimaryChangeImpl = fetchPrimaryChange,
}) {
  if (process.env.NODE_TEST_CONTEXT && execFileImpl === execFileAsync) {
    throw new Error('offline tests must inject safety-stop repair transport');
  }
  const refuse = reason => ({ dispatched: false, reason });
  // Only proven pre-submission waits may release the caller's reservation.
  // Once HQ submission starts, errors remain ambiguous and stay charged.
  const defer = reason => ({ dispatched: false, deferred: true, reason });
  if (refusal?.repairable !== true || !String(refusal.next || '').trim()) return refuse('no-recorded-repair');
  if (cfg.enabled !== true || cfg.autonomousMergeExecutionEnabled !== true) return defer('execution-disabled');
  const stop = fleetStopImpl({ env, logger });
  if (stop) return defer(stop);
  let stdout;
  try {
    const timeoutMs = loadAwareTimeoutMs(15_000);
    ({ stdout } = await execGhWithRetry({ execFileImpl, args: ['pr', 'view', String(prNumber), '--repo', repo,
      '--json', 'state,headRefOid,headRefName,isDraft,labels'], env, signal, timeoutMs,
      retries: 0, totalTimeoutMs: timeoutMs }));
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isTransientGhError(error)) return defer('live-pr-read-transient');
    throw error;
  }
  const pr = JSON.parse(stdout);
  if (pr.state !== 'OPEN' || pr.headRefOid !== headSha || pr.isDraft !== false || !pr.headRefName
    || !Array.isArray(pr.labels)) return refuse('live-pr-not-actionable');
  if (pr.labels.some(label => OPERATOR_HOLD_LABELS.includes(label.name))) return defer('operator-held');
  const owner = await probeOwnershipImpl({ rootDir, repo, prNumber, headSha, signal, logger, env });
  if (owner?.owned !== false || owner?.uncertain !== false) return defer('ownership-unavailable');
  const get = createHistoryReader({ execFileImpl, env, signal });
  const ledger = readHammerRetryCapLedger(rootDir, { repo, prNumber });
  if (ledger?.__corrupt) return refuse('hammer-budget-unreadable');
  // A descendant which still refuses the gate must not start a repair chain.
  // Keep the original evidence in the PR ledger across head/series resets.
  for (const prior of Object.values(ledger?.stopRepairReservations || {})) {
    if (prior.headSha === headSha) continue;
    const comparison = await get.metadata(`repos/${repo}/compare/${prior.headSha}...${headSha}`);
    const status = comparison?.status;
    if (status === 'ahead' || status === 'identical') {
      return { ...refuse('repair-descendant-still-refused'), previousRepair: prior };
    }
    if (!['behind', 'diverged'].includes(status)) return refuse('repair-ancestry-unreadable');
  }
  let repairEvidence = null;
  if (refusal.reasons?.includes('primary-change-reverted') || refusal.reason === 'primary-change-reverted') {
    const evidence = await fetchPrimaryChangeImpl({ repo, prNumber, headSha, rootDir, get, signal });
    repairEvidence = primaryChangeRepairEvidence(evidence, headSha, {
      strictNonBlockingRemediation: cfg.strictNonBlockingRemediation !== false,
    });
  }
  const workerClass = workerClassImpl({}, { env });
  const promptPath = join(rootDir, 'data', 'follow-up-jobs', 'ama-automated-recovery', `${dispatchKey}.md`);
  const missing = refusal.missingEvidence;
  const brief = [`Scoped closure-recovery PR update: ${repo} PR ${prNumber}`,
    `Expected head: ${headSha}`, `Refusal key: ${refusal.key}`, `Repair: ${refusal.next}`,
    `Hold reasons: ${(refusal.reasons || []).join(', ')}`,
    'Exact missing evidence:', typeof missing === 'string' ? missing : missing?.summary || JSON.stringify(missing),
    'Protected regions and complete recorded evidence:', JSON.stringify(missing, null, 2),
    ...(repairEvidence ? [
      `Reviewed head: ${repairEvidence.reviewedHead}; hammer head: ${headSha}; merge base: ${repairEvidence.mergeBase}`,
      `Coordinates: ${repairEvidence.coordinateConvention}.`,
      'Exact uncited reverted regions, attributed by the primary-change gate:',
      ...repairEvidence.paths.flatMap(path => [
        `${path.reviewedPath}: reviewed lines ${path.reviewedRanges.map(range => `[${range.start}, ${range.end})`).join(', ')}; `
          + `gate merge-base ranges ${path.regions.map(range => `[${range.start}, ${range.end})`).join(', ')}`,
      ]),
      'Complete fresh gate attribution:', JSON.stringify(repairEvidence, null, 2),
    ] : []),
    'Before editing and before pushing, prove the PR is open at the expected head; stop if it moved.',
    'Repair only the recorded refusal and its cited regions while preserving the surrounding contract.',
    'Restore the uncited reverted regions from the reviewed head as a builder-authored commit.',
    'Do not add closer trailers (Closed-By, HAM-*, or Worker-Class: hammer).',
    'Fast-forward only: commit on the expected hammer head and push without force; do not rebase or rewrite history.',
    'Preserve all primary-change regions. A reversal requires an authoritative finding citing that exact region.',
    'Run bounded relevant offline validation and push this PR update. Do not merge, change labels, relax gates,',
    'edit leases or review state, dispatch another worker, or open another PR. This is the single repair attempt.',
  ].join('\n');
  writeFileAtomic(promptPath, `${brief}\n`);
  if (!reserveHammerRepairDispatch(rootDir, { repo, prNumber }, { jobKey, headSha, dispatchKey,
    lifetimeDispatchCeiling: cfg.hammerLifetimeDispatchCeiling, refusal })) return refuse('hammer-budget-exhausted');
  const args = buildLegacyHqRemediationDispatchArgs({ ticketRef: `AMA-REPAIR-PR-${prNumber}`,
    workerClass, repo, prNumber, branch: pr.headRefName, promptPath,
    parentSession: env.HQ_PARENT_SESSION || 'session:unknown:closure-recovery',
    project: 'adversarial-merge-authority', hqRoot: resolveHqRoot(env) });
  args.push('--idempotency-key', dispatchKey, '--fleet-retry-policy', 'origin-owned');
  const response = await execFileImpl(env.HQ_BIN || 'hq', args,
    { env, signal, timeout: loadAwareTimeoutMs(60_000), maxBuffer: 5 * 1024 * 1024 });
  const receipt = readDispatchReceipt(parseDispatchJsonOutput(response.stdout));
  if (!receipt.launchRequestId) throw new Error(receipt.identityDiagnostic);
  return { dispatched: true, launchRequestId: receipt.launchRequestId, promptPath };
}
