import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAlertSinkHealth } from './alert-delivery.mjs';
import { runFailoverDrill } from './adapters/agent-runtime/failover-drill.mjs';
import { fetchAdversarialGateBranchProtection } from './branch-protection.mjs';
import {
  classifyFollowUpCriticality,
  FOLLOW_UP_JOB_DIRS,
  listFollowUpJobsInDir,
} from './follow-up-jobs.mjs';
import {
  resolveRemediationOrchestrationMode,
  resolveRemediationRuntimeMode,
} from './remediation-dispatch-mode.mjs';
import { collectReviewPipelineHealth } from './review-pipeline-health.mjs';
import {
  ensureReviewStateSchema,
  fetchLivePRLifecycle,
  openReviewStateDb,
  requestReviewRereview,
} from './review-state.mjs';
import { buildRuntimeStatus } from './runtime-status.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HQ_ROOT = process.env.HQ_ROOT || join(process.env.HOME || '', 'agent-os-hq');
const REPORT_SCHEMA_VERSION = 1;
const FOLLOW_UP_STATES = Object.keys(FOLLOW_UP_JOB_DIRS)
  .filter((key) => !['workspaces', 'stoppedArchived'].includes(key));

const USAGE = `\
Usage:
  adversarial-review sdk-cutover check --repo <owner/repo> --pr <number> [--base <branch>] [--root <dir>] [--hq-root <dir>] [--json]
`;

function toIso(now) {
  const value = typeof now === 'function' ? now() : now;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function reason(code, message) {
  return { code, message };
}

function gate(id, name, reasons, evidence = {}) {
  return { id, name, ready: reasons.length === 0, reasons, evidence };
}

function newestJobTimestamp(job = {}) {
  for (const key of [
    'updatedAt', 'completedAt', 'stoppedAt', 'failedAt',
    'claimedAt', 'pendingAt', 'createdAt',
  ]) {
    const parsed = Date.parse(job[key] || '');
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function findLatestFollowUpJob(rootDir, repo, prNumber) {
  const matches = [];
  for (const state of FOLLOW_UP_STATES) {
    for (const entry of listFollowUpJobsInDir(rootDir, state)) {
      if (entry.job?.repo !== repo || Number(entry.job?.prNumber) !== Number(prNumber)) continue;
      matches.push({ ...entry, state });
    }
  }
  matches.sort((a, b) => newestJobTimestamp(b.job) - newestJobTimestamp(a.job));
  return matches[0] || null;
}

function readReviewRow(rootDir, repo, prNumber) {
  const dbPath = join(rootDir, 'data', 'reviews.db');
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?')
      .get(repo, Number(prNumber)) || null;
  } finally {
    db.close();
  }
}

async function collectVerdictFidelity({
  rootDir,
  repo,
  prNumber,
  fetchLivePRLifecycleImpl = fetchLivePRLifecycle,
} = {}) {
  const live = await fetchLivePRLifecycleImpl({ repo, prNumber });
  const reviewRow = readReviewRow(rootDir, repo, prNumber);
  const latestJob = findLatestFollowUpJob(rootDir, repo, prNumber);
  const classification = latestJob
    ? classifyFollowUpCriticality(latestJob.job?.reviewBody)
    : null;
  const reviewedHead = reviewRow?.reviewer_head_sha || reviewRow?.revision_ref || null;
  const jobHead = latestJob?.job?.revisionRef || null;
  const liveHead = live?.headSha || null;
  const headMatches = Boolean(
    liveHead && reviewedHead === liveHead && (!jobHead || jobHead === liveHead),
  );
  const settledVerdict = ['comment-only', 'approved'].includes(classification?.verdict);
  const ready = Boolean(
    live?.prState === 'merged'
      && reviewRow?.review_status === 'posted'
      && headMatches
      && classification
      && classification.critical === false
      && classification.blockingFindingState === 'known'
      && classification.blockingFindingCount === 0
      && settledVerdict,
  );

  return {
    ready,
    livePrState: live?.prState || null,
    liveHead,
    reviewedHead,
    jobHead,
    headMatches,
    reviewStatus: reviewRow?.review_status || null,
    verdict: classification?.verdict || null,
    criticalFollowUps: classification?.critical ? 1 : 0,
    blockingFindings: classification?.blockingFindingCount ?? null,
    blockingFindingState: classification?.blockingFindingState || null,
    followUpState: latestJob?.state || null,
    followUpJobId: latestJob?.job?.jobId || null,
  };
}

function collectRemediationStatus({ rootDir, env = process.env } = {}) {
  const orchestrationMode = resolveRemediationOrchestrationMode(env);
  const runtimeMode = resolveRemediationRuntimeMode({}, { env });
  const sourcePaths = [
    join(rootDir, 'src', 'follow-up-remediation.mjs'),
    join(rootDir, 'src', 'remediation-claude-code-worker.mjs'),
  ];
  const sources = sourcePaths
    .filter((sourcePath) => existsSync(sourcePath))
    .map((sourcePath) => readFileSync(sourcePath, 'utf8'));
  const directSpawnReferences = sources.reduce(
    (count, source) => count + (source.match(/spawnDetachedCli/gu) || []).length,
    0,
  );
  const branchPushConfigured = sources.some(
    (source) => /completion_?[Ss]hape\s*:\s*['"]branch-push['"]/u.test(source),
  );
  return {
    orchestrationMode,
    runtimeMode,
    selectedRuntime: runtimeMode === 'os' ? 'agent-runtime' : 'local',
    completionShape: branchPushConfigured ? 'branch-push' : null,
    directSpawnReferences,
    ready: orchestrationMode === 'agentos'
      && runtimeMode === 'os'
      && branchPushConfigured
      && directSpawnReferences === 0,
  };
}

function createRereviewRecoveryFixture({ now = () => new Date() } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'sdk-cutover-rereview-'));
  const repo = 'fixture/repo';
  const prNumber = 31;
  const requestedAt = toIso(now);
  try {
    const db = openReviewStateDb(rootDir);
    try {
      ensureReviewStateSchema(db);
      db.prepare(
        `INSERT INTO reviewed_prs(
           repo, pr_number, domain_id, subject_external_id, revision_ref,
           reviewed_at, reviewer, pr_state, review_status, posted_at
         ) VALUES (?, ?, 'code-pr', ?, ?, ?, 'fixture-reviewer', 'open', 'posted', ?)`,
      ).run(repo, prNumber, `${repo}#${prNumber}`, 'fixture-head', requestedAt, requestedAt);
    } finally {
      db.close();
    }

    const result = requestReviewRereview({
      rootDir,
      repo,
      prNumber,
      requestedAt,
      reason: 'retrigger-review: ARC-31 sdk-cutover recovery fixture',
    });
    return {
      ready: result?.triggered === true && result?.status === 'pending',
      triggered: result?.triggered === true,
      status: result?.status || null,
      reason: result?.reason || null,
    };
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

async function collectSdkCutoverObservations({
  rootDir,
  hqRoot,
  repo,
  prNumber,
  baseBranch,
  env,
  now,
  buildRuntimeStatusImpl = buildRuntimeStatus,
  collectRemediationStatusImpl = collectRemediationStatus,
  runFailoverDrillImpl = runFailoverDrill,
  readAlertSinkHealthImpl = readAlertSinkHealth,
  fetchBranchProtectionImpl = fetchAdversarialGateBranchProtection,
  collectPipelineHealthImpl = collectReviewPipelineHealth,
  collectVerdictFidelityImpl = collectVerdictFidelity,
  createRereviewRecoveryFixtureImpl = createRereviewRecoveryFixture,
} = {}) {
  const drillRoot = mkdtempSync(join(tmpdir(), 'sdk-cutover-drill-'));
  let drill;
  try {
    drill = await runFailoverDrillImpl({ rootDir: drillRoot, now });
  } finally {
    rmSync(drillRoot, { recursive: true, force: true });
  }

  const [branchProtection, fidelity] = await Promise.all([
    fetchBranchProtectionImpl({ repoPath: repo, baseBranch, env }),
    collectVerdictFidelityImpl({ rootDir, repo, prNumber }),
  ]);

  return {
    runtime: buildRuntimeStatusImpl(rootDir, { now, env }),
    remediation: collectRemediationStatusImpl({ rootDir, env }),
    drill,
    alerts: readAlertSinkHealthImpl({ env }),
    branchProtection,
    pipeline: collectPipelineHealthImpl({
      rootDir,
      hqRoot,
      now,
      env,
      config: { hostChecksEnabled: true },
    }),
    fidelity,
    rereviewRecovery: createRereviewRecoveryFixtureImpl({ now }),
  };
}

function runtimeGate(observations) {
  const runtime = observations.runtime || {};
  const cutover = runtime.reviewerCutover || {};
  const drill = observations.drill || {};
  const reasons = [];
  if (cutover.ready !== true || cutover.selectedRuntime !== 'agent-runtime') {
    reasons.push(reason('reviewer-runtime-not-ready',
      'reviewer runtime is not cutover-ready on agent-runtime'));
  }
  if (runtime.mode !== 'os' || runtime.probe?.healthy !== true) {
    reasons.push(reason('hybrid-runtime-not-healthy',
      'hybrid SDK router is not healthy in OS mode'));
  }
  if (drill.ok !== true) {
    reasons.push(reason('standalone-failover-drill-failed',
      'sandboxed failover/resume drill did not pass'));
  }
  if (Number(drill.metrics?.duplicated) !== 0) {
    reasons.push(reason('duplicate-dispatches-observed',
      `failover drill observed ${drill.metrics?.duplicated ?? 'unknown'} duplicate dispatches`));
  }
  return gate('ARC-25', 'reviewer runtime and standalone fallback', reasons, {
    mode: runtime.mode || null,
    reviewerRuntime: cutover.selectedRuntime || null,
    reviewerCutoverReady: cutover.ready === true,
    fallbackCanary: runtime.canary?.status || null,
    settleSmoke: runtime.settleSmoke?.ok === true ? 'pass' : runtime.settleSmoke?.reason || null,
    drillPassed: drill.ok === true,
    duplicateDispatches: drill.metrics?.duplicated ?? null,
  });
}

function remediationGate(observations) {
  const remediation = observations.remediation || {};
  const reasons = [];
  if (remediation.orchestrationMode !== 'agentos' || remediation.runtimeMode !== 'os') {
    reasons.push(reason('remediation-runtime-not-os',
      'remediation does not default to the AgentRuntime OS path'));
  }
  if (remediation.completionShape !== 'branch-push') {
    reasons.push(reason('remediation-completion-shape-mismatch',
      'remediation completion shape is not branch-push'));
  }
  if (Number(remediation.directSpawnReferences) !== 0) {
    reasons.push(reason('direct-remediation-spawn-present',
      'remediation orchestration still references direct detached CLI spawning'));
  }
  return gate('ARC-26', 'remediation AgentRuntime parity', reasons, remediation);
}

function fidelityGate(observations) {
  const fidelity = observations.fidelity || {};
  const reasons = [];
  if (fidelity.livePrState !== 'merged') {
    reasons.push(reason('live-clean-pr-not-merged',
      `proof PR is ${fidelity.livePrState || 'unavailable'}, not merged`));
  }
  if (fidelity.reviewStatus !== 'posted' || fidelity.headMatches !== true) {
    reasons.push(reason('verdict-not-current-head',
      'posted review evidence is missing or does not match the proof PR head'));
  }
  if (!['comment-only', 'approved'].includes(fidelity.verdict)) {
    reasons.push(reason('verdict-not-settled-clean',
      `proof verdict is ${fidelity.verdict || 'unavailable'}`));
  }
  if (Number(fidelity.criticalFollowUps) !== 0 || Number(fidelity.blockingFindings) !== 0) {
    reasons.push(reason('clean-verdict-followup-fidelity-failed',
      'clean verdict produced critical or blocking follow-up work'));
  }
  return gate('ARC-27', 'verdict and follow-up fidelity', reasons, fidelity);
}

function alertGate(observations) {
  const alerts = observations.alerts || {};
  const reasons = [];
  if (alerts.ready !== true) {
    reasons.push(reason('alert-sink-not-ready',
      alerts.lastFailureReason || alerts.healthCheckError || 'durable alert sink is not ready'));
  }
  if (!alerts.lastDeliveredAt) {
    reasons.push(reason('alert-delivery-unproven',
      'durable alert sink has no successful delivery receipt'));
  }
  return gate('ARC-28', 'durable alert delivery', reasons, {
    ready: alerts.ready === true,
    sink: alerts.sink || 'agent-gateway',
    lastDeliveredAt: alerts.lastDeliveredAt || null,
    pendingCount: alerts.pendingCount ?? null,
    inflightCount: alerts.inflightCount ?? null,
    quarantineCount: alerts.quarantineCount ?? null,
    deadLetterCount: alerts.deadLetterCount ?? null,
    healthCheckError: alerts.healthCheckError || null,
  });
}

function branchGate(observations) {
  const branch = observations.branchProtection || {};
  const reasons = [];
  if (branch.ok !== true) {
    reasons.push(reason('branch-protection-gate-missing',
      `required adversarial gate is not proven (${branch.reason || 'unknown'})`));
  }
  return gate('ARC-29', 'branch protection closeout', reasons, {
    required: branch.ok === true,
    context: branch.context || null,
    reason: branch.reason || null,
    requiredContexts: branch.requiredContexts || [],
  });
}

function dispatchSloGate(observations) {
  const runtime = observations.runtime || {};
  const pipeline = observations.pipeline || {};
  const components = runtime.probe?.components || {};
  const threshold = runtime.config?.dispatchP95ThresholdMs;
  const p95 = components.dispatchP95Ms;
  const p95Ready = components.dispatchP95Ok === true
    || (Number.isFinite(p95) && Number.isFinite(threshold) && p95 <= threshold);
  const stalePrs = pipeline.mergeStalls?.candidates?.length ?? null;
  const blockingFindingCodes = new Set([
    'review:merge_stalled',
    'review:dispatch_spawn_failures',
    'review:dag_autowalk_launchd_unhealthy',
  ]);
  const activeBlockingFindings = (pipeline.findings || [])
    .filter((finding) => blockingFindingCodes.has(finding.code))
    .map((finding) => finding.code);
  const reasons = [];
  if (!p95Ready) {
    reasons.push(reason('dispatch-p95-not-ready',
      p95 == null ? 'dispatch acceptance p95 has no samples' : `dispatch p95 ${p95}ms exceeds ${threshold}ms`));
  }
  if (stalePrs !== 0) {
    reasons.push(reason('no-progress-stale-prs',
      `${stalePrs ?? 'unknown'} clean reviewed PRs are stale without merge progress`));
  }
  if (activeBlockingFindings.length > 0) {
    reasons.push(reason('dispatch-health-findings-active', activeBlockingFindings.join(', ')));
  }
  return gate('ARC-30', 'dispatch latency and no-progress SLO', reasons, {
    dispatchP95Ms: p95 ?? null,
    dispatchP95ThresholdMs: threshold ?? null,
    dispatchP95Ready: p95Ready,
    noProgressStalePrs: stalePrs,
    activeBlockingFindings,
  });
}

function rereviewGate(observations) {
  const recovery = observations.rereviewRecovery || {};
  const reasons = [];
  if (recovery.ready !== true) {
    reasons.push(reason('rereview-recovery-fixture-failed',
      `current-head re-review recovery returned ${recovery.status || recovery.reason || 'unknown'}`));
  }
  return gate('ARC-31', 'operator current-head re-review recovery', reasons, recovery);
}

async function buildSdkCutoverReport({
  rootDir = REPO_ROOT,
  hqRoot = DEFAULT_HQ_ROOT,
  repo,
  prNumber,
  baseBranch = 'main',
  env = process.env,
  now = () => new Date(),
  observations = null,
  collectObservationsImpl = collectSdkCutoverObservations,
} = {}) {
  if (!repo) throw new TypeError('sdk-cutover check requires repo');
  if (!Number.isInteger(Number(prNumber)) || Number(prNumber) <= 0) {
    throw new TypeError('sdk-cutover check requires a positive PR number');
  }
  const observed = observations || await collectObservationsImpl({
    rootDir,
    hqRoot,
    repo,
    prNumber: Number(prNumber),
    baseBranch,
    env,
    now,
  });
  const gates = [
    runtimeGate(observed),
    remediationGate(observed),
    fidelityGate(observed),
    alertGate(observed),
    branchGate(observed),
    dispatchSloGate(observed),
    rereviewGate(observed),
  ];
  const ready = gates.every((entry) => entry.ready);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: 'sdk-cutover-readiness',
    generatedAt: toIso(now),
    target: { repo, prNumber: Number(prNumber), baseBranch },
    ready,
    cutover: ready ? 'READY' : 'NOT_READY',
    gates,
    blockers: gates.flatMap((entry) => entry.reasons.map((entryReason) => ({
      gate: entry.id,
      ...entryReason,
    }))),
  };
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  if (ms >= 1_000) return `${Math.round(ms / 1_000)}s`;
  return `${ms}ms`;
}

function gateEvidence(report, id) {
  return report.gates.find((entry) => entry.id === id)?.evidence || {};
}

function renderSdkCutoverReport(report) {
  const runtime = gateEvidence(report, 'ARC-25');
  const remediation = gateEvidence(report, 'ARC-26');
  const fidelity = gateEvidence(report, 'ARC-27');
  const alerts = gateEvidence(report, 'ARC-28');
  const branch = gateEvidence(report, 'ARC-29');
  const slo = gateEvidence(report, 'ARC-30');
  const fidelityReady = report.gates.find((entry) => entry.id === 'ARC-27')?.ready;
  const lines = [
    `runtime: hybrid-sdk       reviewer: ${runtime.reviewerRuntime || 'unknown'}   remediation: ${remediation.selectedRuntime || 'unknown'}`,
    `fallback: ${runtime.reviewerCutoverReady ? 'ready' : 'not-ready'}           standalone drill: ${runtime.drillPassed ? 'pass' : 'fail'}     duplicate dispatches: ${runtime.duplicateDispatches ?? 'unknown'}`,
    `alerts: ${alerts.ready ? 'ready' : 'not-ready'}             sink: ${alerts.sink || 'unknown'}        last_delivery: ${alerts.lastDeliveredAt || 'none'}`,
    `branch gate: ${branch.required ? 'required' : 'missing'}     context: ${branch.context || 'unknown'}`,
    `dispatch p95: ${formatDuration(slo.dispatchP95Ms)}         no-progress stale PRs: ${slo.noProgressStalePrs ?? 'unknown'}`,
    `verdict fidelity: ${fidelityReady ? 'pass' : 'fail'}    comment-only followups: ${fidelity.criticalFollowUps ?? 'unknown'} critical / ${fidelity.blockingFindings ?? 'unknown'} blocking`,
    `cutover: ${report.cutover}`,
  ];
  if (!report.ready) {
    for (const blocker of report.blockers) {
      lines.push(`  ${blocker.gate} ${blocker.code}: ${blocker.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function parseSdkCutoverArgs(argv) {
  const [subcommand, ...rest] = argv;
  const options = {
    subcommand,
    rootDir: REPO_ROOT,
    hqRoot: DEFAULT_HQ_ROOT,
    repo: null,
    prNumber: null,
    baseBranch: 'main',
    json: false,
    help: false,
  };
  if (subcommand === '--help' || subcommand === '-h') {
    options.help = true;
    return options;
  }
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--root') {
      if (!rest[i + 1]) throw new Error('--root requires a directory');
      options.rootDir = rest[++i];
    } else if (arg === '--hq-root') {
      if (!rest[i + 1]) throw new Error('--hq-root requires a directory');
      options.hqRoot = rest[++i];
    } else if (arg === '--repo') {
      if (!rest[i + 1]) throw new Error('--repo requires owner/repo');
      options.repo = rest[++i];
    } else if (arg === '--pr') {
      if (!rest[i + 1]) throw new Error('--pr requires a number');
      options.prNumber = Number(rest[++i]);
    } else if (arg === '--base') {
      if (!rest[i + 1]) throw new Error('--base requires a branch');
      options.baseBranch = rest[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (subcommand !== 'check' && !options.help) {
    throw new Error(`Unknown sdk-cutover command: ${subcommand || '<none>'}`);
  }
  if (!options.help && !options.repo) throw new Error('--repo is required');
  if (!options.help && (!Number.isInteger(options.prNumber) || options.prNumber <= 0)) {
    throw new Error('--pr requires a positive integer');
  }
  return options;
}

async function sdkCutoverCheckMain(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let options;
  try {
    options = parseSdkCutoverArgs(argv);
  } catch (error) {
    stderr.write(`error: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  try {
    const buildReportImpl = io.buildReportImpl || buildSdkCutoverReport;
    const report = await buildReportImpl({ ...options, env: io.env || process.env });
    stdout.write(options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderSdkCutoverReport(report));
    return report.ready ? 0 : 1;
  } catch (error) {
    stderr.write(`error: sdk-cutover check failed: ${error.message || error}\n`);
    return 3;
  }
}

export {
  REPORT_SCHEMA_VERSION,
  buildSdkCutoverReport,
  collectRemediationStatus,
  collectSdkCutoverObservations,
  collectVerdictFidelity,
  createRereviewRecoveryFixture,
  parseSdkCutoverArgs,
  renderSdkCutoverReport,
  sdkCutoverCheckMain,
};
