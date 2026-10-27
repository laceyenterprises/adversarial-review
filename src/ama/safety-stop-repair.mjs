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
import { reserveHammerRepairDispatch } from './hammer-retry-cap.mjs';

const execFileAsync = promisify(execFile);

// This executor has coding/push authority only. HCP admits the scoped PR update;
// the normal closer still owns all validation, merge predicates and leases.
export async function dispatchSafetyStopRepair({ rootDir, repo, prNumber, headSha, refusal,
  dispatchKey, jobKey, signal, logger = console, env = process.env,
  cfg = loadConfigCached().getMergeAuthorityConfig(), execFileImpl = execFileAsync,
  probeOwnershipImpl = probeOrphanOwnership, fleetStopImpl = fleetStopReason,
  workerClassImpl = pickRemediationWorkerClass,
}) {
  if (process.env.NODE_TEST_CONTEXT && execFileImpl === execFileAsync) {
    throw new Error('offline tests must inject safety-stop repair transport');
  }
  const refuse = reason => ({ dispatched: false, reason });
  // Only proven pre-submission waits may release the caller's reservation.
  // Once HQ submission starts, errors remain ambiguous and stay charged.
  const defer = reason => ({ dispatched: false, deferred: true, reason });
  if (cfg.enabled !== true || cfg.autonomousMergeExecutionEnabled !== true) return defer('execution-disabled');
  const stop = fleetStopImpl({ env, logger });
  if (stop) return defer(stop);
  let stdout;
  try {
    ({ stdout } = await execGhWithRetry({ execFileImpl, args: ['pr', 'view', String(prNumber), '--repo', repo,
      '--json', 'state,headRefOid,headRefName,isDraft,labels'], env, signal, timeoutMs: 15_000,
      retries: 0, totalTimeoutMs: 15_000 }));
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
  const workerClass = workerClassImpl({}, { env });
  const promptPath = join(rootDir, 'data', 'follow-up-jobs', 'ama-automated-recovery', `${dispatchKey}.md`);
  const missing = refusal.missingEvidence;
  const brief = [`Scoped closure-recovery PR update: ${repo} PR ${prNumber}`,
    `Expected head: ${headSha}`, `Refusal key: ${refusal.key}`, `Repair: ${refusal.next}`,
    'Exact missing evidence:', typeof missing === 'string' ? missing : missing?.summary || JSON.stringify(missing),
    'Protected regions and complete recorded evidence:', JSON.stringify(missing, null, 2),
    'Before editing and before pushing, prove the PR is open at the expected head; stop if it moved.',
    'Repair only the recorded refusal and its cited regions while preserving the surrounding contract.',
    'Preserve all primary-change regions. A reversal requires an authoritative finding citing that exact region.',
    'Run bounded relevant offline validation and push this PR update. Do not merge, change labels, relax gates,',
    'edit leases or review state, dispatch another worker, or open another PR. This is the single repair attempt.',
  ].join('\n');
  writeFileAtomic(promptPath, `${brief}\n`);
  if (!reserveHammerRepairDispatch(rootDir, { repo, prNumber }, { jobKey, headSha, dispatchKey,
    lifetimeDispatchCeiling: cfg.hammerLifetimeDispatchCeiling })) return refuse('hammer-budget-exhausted');
  const args = buildLegacyHqRemediationDispatchArgs({ ticketRef: `AMA-REPAIR-PR-${prNumber}`,
    workerClass, repo, prNumber, branch: pr.headRefName, promptPath,
    parentSession: env.HQ_PARENT_SESSION || 'session:unknown:closure-recovery',
    project: 'adversarial-merge-authority', hqRoot: resolveHqRoot(env) });
  args.push('--idempotency-key', dispatchKey, '--fleet-retry-policy', 'origin-owned');
  const response = await execFileImpl(env.HQ_BIN || 'hq', args,
    { env, signal, timeout: 60_000, maxBuffer: 5 * 1024 * 1024 });
  const receipt = readDispatchReceipt(parseDispatchJsonOutput(response.stdout));
  if (!receipt.launchRequestId) throw new Error(receipt.identityDiagnostic);
  return { dispatched: true, launchRequestId: receipt.launchRequestId, promptPath };
}
