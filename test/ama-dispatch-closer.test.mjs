import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  amaCloserDispatchFilePath,
  amaClosureNeedsTerminalRemediation,
  composeCloserPrompt,
  isHammerRemediableEligibilityMiss,
  isInterruptedInFlightAmaCloserDispatch,
  maybeDispatchAmaCloser,
  namedAmaNoDispatchReason,
  substituteTemplate,
} from '../src/ama/dispatch-closer.mjs';
import { ENUM_ROLES_ADVERSARIAL_ORCHESTRATION_MODE } from '../src/config-loader.mjs';
import {
  amaAuditFilePath,
  amaAuditTraceRef,
  appendAmaAuditAttempt,
  readAmaAuditEntry,
  writeAmaAuditEntry,
} from '../src/ama/audit.mjs';
import {
  acquireAmaCloserLease,
  readAmaCloserLease,
  updateAmaCloserLease,
} from '../src/ama/closer-lease.mjs';
import { openReviewStateDb } from '../src/review-state.mjs';
import { main as tokensMain } from '../src/tokens-cli.mjs';
import { createSessionLedgerDb } from './helpers/session-ledger-fixtures.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TEMPLATE_PATH = join(REPO_ROOT, 'templates', 'ama-closer-prompt.md');
const HAMMER_TEMPLATE_PATH = join(REPO_ROOT, 'templates', 'hammer-prompt.md');
const GOLDEN_PROMPT_PATH = join(__dirname, 'fixtures', 'ama-closer-prompt.golden.md');
const HAMMER_GOLDEN_PROMPT_PATH = join(__dirname, 'fixtures', 'hammer-prompt.golden.md');
const CURRENT_USER = userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';

/**
 * Default eligible (reviewState, prMetadata, cfg, dispatchContext)
 * tuple. The 5 test cases mutate one input at a time.
 */
function eligibleFixture(overrides = {}) {
  const headSha = 'abc12345abc12345abc12345abc12345abc12345';
  const dispatchContextOverrides = overrides.dispatchContext || {};
  const rootDir = dispatchContextOverrides.rootDir || '/tmp/ama-test-root';
  const hqRoot = dispatchContextOverrides.hqRoot || join(rootDir, 'hq-root');
  const reviewState = {
    verdict: 'approved',
    headSha,
    riskClass: 'low',
    remediationPending: false,
    // The eligibility predicate (post-AMA-02) requires
    // `blockingFindingState === 'known'` to clear the verdict gate
    // even on `Approved`. AMA-02's classifyBlockingFindings treats
    // `unknown` as failing closed; the watcher's fresh review record
    // populates this in production. Pinning `known`/`0` here models
    // a clean settled-success row.
    blockingFindingState: 'known',
    blockingFindingCount: 0,
    nonBlockingFindingState: 'known',
    nonBlockingFindingCount: 0,
    operatorApprovedEvidence: null,
    prAuthor: 'codex-worker-bot',
    reviewerFamily: 'claude',
    ...overrides.reviewState,
  };
  const prMetadata = {
    prNumber: 1234,
    headSha,
    isOpen: true,
    isDraft: false,
    mergeableState: 'MERGEABLE',
    labels: [],
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
    ],
    branchProtection: { requiredContexts: ['agent-os/adversarial-gate'] },
    author: 'codex-worker-bot',
    ...overrides.prMetadata,
  };
  const cfg = {
    enabled: true,
    workerClass: 'codex',
    mergeMethod: 'squash',
    eligibility: {
      riskClasses: ['low'],
      fastMergeLabels: ['fast-merge:test-fixtures', 'fast-merge:docs'],
    },
    branchProtection: {},
    ...overrides.cfg,
  };
  const dispatchContext = {
    repo: 'acme/myrepo',
    prUrl: 'https://github.com/acme/myrepo/pull/1234',
    reviewedSha: headSha,
    riskClass: 'low',
    requiredGateContext: 'agent-os/adversarial-gate',
    reviewedBy: 'claude-reviewer-lacey',
    reviewer: 'claude',
    parentSession: 'session:test:watcher',
    hqProject: 'adversarial-merge-authority',
    hqPath: '/bin/true-stub-hq',
    hqRoot,
    hqOwnerUser: CURRENT_USER,
    currentUser: CURRENT_USER,
    rootDir,
    templatePath: TEMPLATE_PATH,
    dispatchedAt: '2026-06-11T20:00:00Z',
    ...dispatchContextOverrides,
  };
  return { reviewState, prMetadata, cfg, dispatchContext };
}

/**
 * MSM-04 — a fixture that DISPATCHES the (only surviving) agent: the terminal
 * remediation hammer. Under MSM-04 a fully-clean, mergeable settled PR is merged
 * inline by the MSM-03 watcher daemon (no agent); an agent is spawned ONLY when
 * the closure has genuine remediation work. This fixture models that: a settled
 * review that still carries a blocking finding at review-cycle exhaustion, so the
 * auto-hammer lane fires, forces the `hammer` worker class, and dispatches the
 * `hammer-prompt.md` terminal-remediation prompt. Individual overrides win over
 * these defaults exactly like {@link eligibleFixture}.
 */
function hammerFixture(overrides = {}) {
  return eligibleFixture({
    ...overrides,
    reviewState: {
      verdict: 'request-changes',
      reviewCycleExhausted: true,
      blockingFindingState: 'known',
      blockingFindingCount: 1,
      ...overrides.reviewState,
    },
    cfg: {
      autoHammerOnEligibilityMiss: true,
      ...overrides.cfg,
    },
  });
}

/**
 * MSM-04 — a hammer-dispatching fixture that is NOT review-cycle-exhausted, so it
 * exercises the ordinary hammer dispatch + existing-dispatch reconciliation
 * machinery without tripping the exhausted-final-hammer same-head idempotency
 * guard. The `hammer` worker class makes a non-blocking-finding eligibility miss
 * auto-remediable before exhaustion, so it dispatches the terminal-remediation
 * hammer with `workerClass === 'hammer'`.
 */
function liveHammerFixture(overrides = {}) {
  return eligibleFixture({
    ...overrides,
    reviewState: {
      // Keep the settled-success verdict so the sole eligibility miss is
      // `non-blocking-findings-present` — a pre-exhaustion hammer-remediable miss
      // (blocking findings / `verdict-not-settled-success` only become remediable
      // at exhaustion). This dispatches the hammer without exhaustion.
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 1,
      ...overrides.reviewState,
    },
    cfg: {
      workerClass: 'hammer',
      autoHammerOnEligibilityMiss: true,
      ...overrides.cfg,
    },
  });
}

/**
 * MSM-04 — a hammer-dispatching fixture that preserves the CONFIGURED worker
 * class (harness). Unlike {@link hammerFixture}, this reaches the dispatch via
 * the eligible-but-dirty path (a current-head `operator-approved` override clears
 * the verdict gate while a standing blocking finding keeps the terminal-remediation
 * mandate), so the auto-hammer lane never fires and `cfg.workerClass` is honored
 * verbatim on `--worker-class`. Use it for worker-class / harness routing tests.
 */
function eligibleHammerFixture(overrides = {}) {
  const headSha = 'abc12345abc12345abc12345abc12345abc12345';
  return eligibleFixture({
    ...overrides,
    reviewState: {
      verdict: 'request-changes',
      reviewCycleExhausted: true,
      blockingFindingState: 'known',
      blockingFindingCount: 1,
      operatorApprovedEvidence: {
        applied: true,
        actor: 'operator-human',
        eventId: 'evt-operator-approved-routing',
        observedAt: '2026-06-18T22:00:00Z',
        observedRevisionRef: headSha,
      },
      ...overrides.reviewState,
    },
    prMetadata: {
      labels: [{ name: 'operator-approved' }],
      ...overrides.prMetadata,
    },
  });
}

/**
 * Mock `execFile`-style helper that records every call and emits a
 * scripted dispatch id. Mirrors the contract `maybeDispatchAmaCloser`
 * expects (`{ stdout, stderr }` return shape).
 */
function buildExecMock({ stdout = 'dispatchId=lrq_test_0001\n', throwOn = null } = {}) {
  const calls = [];
  const impl = async (cmd, args, _opts) => {
    calls.push({ cmd, args });
    if (throwOn && throwOn(cmd, args)) {
      const err = new Error('exec failed');
      err.stderr = 'simulated dispatch failure';
      throw err;
    }
    return { stdout, stderr: '' };
  };
  return { impl, calls };
}

/**
 * Capture writeFile invocations so the test can inspect the prompt
 * body without touching the filesystem.
 */
function buildWriteMock() {
  const captured = { dir: null, path: null, body: null };
  const impl = (dir, path, body) => {
    captured.dir = dir;
    captured.path = path;
    captured.body = body;
  };
  return { impl, captured };
}

function buildStructuredLogger() {
  const events = [];
  return {
    events,
    logger: {
      info(line) {
        events.push(JSON.parse(line));
      },
      warn() {},
      error() {},
      log() {},
    },
  };
}

function summarizeDispatchCall(call) {
  const args = call?.args || [];
  const readFlag = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : null;
  };
  const readFlags = (flag) => {
    const values = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === flag) values.push(args[i + 1]);
    }
    return values;
  };
  return {
    cmd: call?.cmd || null,
    workerClass: readFlag('--worker-class'),
    taskKind: readFlag('--task-kind'),
    completionShape: readFlag('--completion-shape'),
    project: readFlag('--project'),
    repo: readFlag('--repo'),
    additionalRepos: readFlags('--additional-repo'),
    pr: readFlag('--pr'),
    ticket: readFlag('--ticket'),
    parentSession: readFlag('--parent-session'),
  };
}

// ---------------------------------------------------------------------------
// Test 1 — cfg.enabled=false short-circuits before any I/O.
// ---------------------------------------------------------------------------

test('cfg.enabled=false returns ama-disabled and never spawns hq dispatch', async () => {
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { enabled: false },
  });
  const exec = buildExecMock();
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: () => 'unused',
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'ama-disabled');
  assert.equal(result.namedReason, 'ama-disabled');
  assert.equal(exec.calls.length, 0, 'hq dispatch must not be invoked when AMA is disabled');
  assert.equal(write.captured.body, null, 'no prompt is written when AMA is disabled');
});

// ---------------------------------------------------------------------------
// Test 2 — cfg.enabled=true + eligibility=false returns reasons; no dispatch.
// ---------------------------------------------------------------------------

test('cfg.enabled=true + ineligible returns reasons and never spawns hq dispatch', async () => {
  // Risk class `high` blocks under the default `low`-only allowlist. A clean but
  // risk-blocked closure is ineligible and has no hammer-remediable work, so no
  // agent is dispatched and the daemon never gets a clean tick either.
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
    reviewState: { riskClass: 'high' },
  });
  const exec = buildExecMock();
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: () => 'unused',
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'not-eligible');
  assert.equal(result.namedReason, 'not-eligible:risk-class-not-permitted');
  assert.ok(Array.isArray(result.reasons));
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
  assert.equal(exec.calls.length, 0, 'hq dispatch must not be invoked when ineligible');
});

// ---------------------------------------------------------------------------
// Test 3 (MSM-04) — a fully-clean, mergeable eligible closure is DAEMON-OWNED:
// the standalone AMA-closer agent (a worker spawned solely to click merge) is
// deleted, so `maybeDispatchAmaCloser` spawns NO agent and routes the clean
// merge back to the MSM-03 watcher daemon (skipMergeAgent).
// ---------------------------------------------------------------------------

test('fully-clean eligible closure is daemon-owned — no click-merge agent is dispatched', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-clean-daemon-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
    cfg: { workerClass: undefined },
    dispatchContext: { rootDir },
  });
  const exec = buildExecMock();
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: () => 'unused',
  });
  // No agent whose sole job is to click merge — the daemon owns the clean merge.
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'clean-close-daemon-owned');
  assert.equal(result.skipMergeAgent, true);
  assert.equal(exec.calls.length, 0, 'no hq dispatch for a clean daemon-owned close');
  assert.equal(write.captured.body, null, 'no closer prompt is written for a clean close');
});

// MSM-04 — the exhausted-final-hammer CURRENT-HEAD re-targeting is deleted. When
// the reviewed head is stale at exhaustion, the one hammer no longer re-targets
// the live current head (that reviewed→current gap re-arming per HAM commit was
// the #3123 re-hammer loop). The dispatch keys on the STABLE reviewed head, so
// the per-PR hammer retry cap (same job key) bounds it and the loop cannot fire.
test('exhausted final hammer keys the dispatch on the reviewed head, never re-targeting the live head', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-target-head-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const reviewedHead = '40e302440e302440e302440e302440e302440e3024';
  const currentHead = '6358df76358df76358df76358df76358df76358d';
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: {
      workerClass: 'hammer',
      autoHammerOnEligibilityMiss: true,
    },
    reviewState: {
      verdict: 'request-changes',
      headSha: reviewedHead,
      riskClass: 'medium',
      reviewCycleExhausted: true,
      blockingFindingState: 'known',
      blockingFindingCount: 1,
    },
    prMetadata: {
      headSha: currentHead,
      mergeableState: 'MERGEABLE',
    },
    dispatchContext: {
      rootDir,
      reviewedSha: reviewedHead,
      riskClass: 'medium',
    },
  });
  const exec = buildExecMock();
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: () => readFileSync(HAMMER_TEMPLATE_PATH, 'utf8'),
  });

  assert.equal(result.dispatched, true);
  assert.ok(write.captured.body.includes(reviewedHead), 'prompt must preserve the reviewed head');
  // The dispatch record is keyed on the REVIEWED head (stable job anchor), NOT the
  // advanced current head — there is no per-HAM-commit re-target record to re-arm.
  const reviewedHeadPath = amaCloserDispatchFilePath(rootDir, {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: reviewedHead,
  });
  assert.equal(existsSync(reviewedHeadPath), true, 'dispatch record key must be the reviewed head');
  const currentHeadPath = amaCloserDispatchFilePath(rootDir, {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: currentHead,
  });
  assert.equal(existsSync(currentHeadPath), false, 'no current-head re-target record is written');
  const record = JSON.parse(readFileSync(reviewedHeadPath, 'utf8'));
  assert.equal(record.headSha, reviewedHead);
  assert.equal(record.reviewedSha, reviewedHead);
  assert.equal(record.targetRemediationSha, reviewedHead);
  assert.notEqual(record.dispatchReason, 'exhausted-final-hammer');
  assert.equal(record.retryCount, 1);
});

test('eligible agent-os dispatch does not add agent-os as a duplicate workspace repo', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-agent-os-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: {
      rootDir,
      repo: 'laceyenterprises/agent-os',
      prUrl: 'https://github.com/laceyenterprises/agent-os/pull/1234',
    },
  });
  const exec = buildExecMock();
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: () => readFileSync(TEMPLATE_PATH, 'utf8'),
  });
  assert.equal(result.dispatched, true);
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].args[exec.calls[0].args.indexOf('--repo') + 1], 'agent-os');
  assert.equal(exec.calls[0].args.includes('--additional-repo'), false);
});

test('eligible adversarial-review self-PR dispatch is single-repo for rescue provision', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-adversarial-review-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: {
      rootDir,
      repo: 'laceyenterprises/adversarial-review',
      prUrl: 'https://github.com/laceyenterprises/adversarial-review/pull/504',
    },
    prMetadata: { prNumber: 504 },
  });
  const exec = buildExecMock();
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: () => readFileSync(TEMPLATE_PATH, 'utf8'),
  });

  assert.equal(result.dispatched, true);
  assert.equal(exec.calls.length, 1);
  const promptPath = join(
    rootDir,
    'data',
    'follow-up-jobs',
    'ama-closer-prompts',
    `laceyenterprises-adversarial-review-pr-504-${reviewState.headSha}.md`,
  );
  assert.deepEqual(exec.calls[0].args, [
    'dispatch',
    '--worker-class', 'hammer',
    '--task-kind', 'merge',
    '--completion-shape', 'decision-only',
    '--project', 'adversarial-merge-authority',
    '--repo', 'adversarial-review',
    '--pr', '504',
    '--ticket', 'AMA-PR-504',
    '--parent-session', 'session:test:watcher',
    '--prompt', promptPath,
    '--root', dispatchContext.hqRoot,
  ]);
  assert.equal(exec.calls[0].args.includes('--additional-repo'), false);
  assert.equal(exec.calls[0].args.includes('--branch'), false);
});

test('maybeDispatchAmaCloser is mode-invariant for merge-class dispatch', async (t) => {
  const dispatches = [];
  for (const orchestrationMode of ENUM_ROLES_ADVERSARIAL_ORCHESTRATION_MODE) {
    const rootDir = mkdtempSync(join(tmpdir(), `ama-dispatch-${orchestrationMode}-`));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
      dispatchContext: { rootDir, orchestrationMode },
    });
    const exec = buildExecMock();
    const write = buildWriteMock();
    const { logger, events } = buildStructuredLogger();
    const result = await maybeDispatchAmaCloser({
      reviewState,
      prMetadata,
      cfg,
      dispatchContext,
      execFileImpl: exec.impl,
      writeFileImpl: write.impl,
      readTemplateImpl: () => readFileSync(TEMPLATE_PATH, 'utf8'),
      logger,
    });
    dispatches.push({
      orchestrationMode,
      result,
      calls: exec.calls.map((call) => ({ cmd: call.cmd, args: [...call.args] })),
      events,
    });
  }

  const nativeDispatch = dispatches.find(entry => entry.orchestrationMode === 'native');
  const agentosDispatch = dispatches.find(entry => entry.orchestrationMode === 'agentos');
  assert.equal(dispatches.length, ENUM_ROLES_ADVERSARIAL_ORCHESTRATION_MODE.length);
  assert.equal(nativeDispatch.result.dispatched, true);
  assert.equal(agentosDispatch.result.dispatched, true);
  assert.equal(nativeDispatch.calls.length, 1, 'native must still launch via hq dispatch');
  assert.equal(agentosDispatch.calls.length, 1, 'agentos must still launch via hq dispatch');
  assert.deepEqual(
    summarizeDispatchCall(nativeDispatch.calls[0]),
    summarizeDispatchCall(agentosDispatch.calls[0]),
  );

  const nativeNoopEvent = nativeDispatch.events.find((event) => event.event === 'ama_closer.orchestration_mode_noop');
  const agentosNoopEvent = agentosDispatch.events.find((event) => event.event === 'ama_closer.orchestration_mode_noop');
  assert.equal(nativeNoopEvent.route, 'hq-dispatch');
  assert.equal(agentosNoopEvent.route, 'hq-dispatch');
  assert.equal(nativeNoopEvent.completionShape, 'decision-only');
  assert.equal(agentosNoopEvent.completionShape, 'decision-only');
});

test('cfg.enabled=true + branch protection opt-out records waived eligibility reason', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-waived-protection-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    prMetadata: { branchProtection: { requiredContexts: [] } },
    cfg: {
      branchProtection: {
        required: false,
      },
    },
    dispatchContext: { rootDir },
  });
  const exec = buildExecMock();
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: () => readFileSync(TEMPLATE_PATH, 'utf8'),
  });
  assert.equal(result.dispatched, true);
  assert.ok(write.captured.body.includes('branch_protection_requirement_waived'));
  assert.ok(!write.captured.body.includes('configured_gate_context_required'));

  const audit = readAmaAuditEntry(
    dispatchContext.hqRoot,
    dispatchContext.repo,
    prMetadata.prNumber,
    dispatchContext.reviewedSha,
  );
  assert.deepEqual(
    audit.eligibilityReasons.filter(reason => reason.includes('branch')),
    ['branch_protection_requirement_waived'],
  );
  assert.equal(audit.attempts[0].eligibilityTrace.branchProtection.auditReason, 'branch_protection_requirement_waived');
});

test('eligible dispatch bootstraps the watcher-owned audit record before the first closer append', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-bootstrap-'));
  const hqRoot = mkdtempSync(join(tmpdir(), 'ama-hq-bootstrap-'));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  });
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir, hqRoot },
  });
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: async () => ({
      stdout: '{"dispatchId":"dispatch-bootstrap","launchRequestId":"lrq_bootstrap"}',
      stderr: '',
    }),
    readTemplateImpl: () => 'stubbed',
  });
  assert.equal(result.dispatched, true);

  const auditPath = amaAuditFilePath(
    hqRoot,
    dispatchContext.repo,
    prMetadata.prNumber,
    dispatchContext.reviewedSha,
  );
  const bootstrapped = readAmaAuditEntry(
    hqRoot,
    dispatchContext.repo,
    prMetadata.prNumber,
    dispatchContext.reviewedSha,
  );
  assert.equal(bootstrapped.status, 'in_progress');
  assert.equal(bootstrapped.reviewedBy, 'claude-reviewer-lacey');
  assert.deepEqual(bootstrapped.requiredGateContexts, ['agent-os/adversarial-gate']);
  assert.equal(bootstrapped.attempts.length, 1);
  assert.equal(bootstrapped.attempts[0].outcome, 'in_progress');
  assert.equal(bootstrapped.attempts[0].requiredGateContext, 'agent-os/adversarial-gate');

  const { doc } = appendAmaAuditAttempt({
    hqRoot,
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
    attempt: { outcome: 'deferred', preMergeReasons: ['ci-not-green'] },
    now: '2026-06-11T20:01:00Z',
  });
  assert.equal(doc.status, 'deferred');
  assert.equal(doc.attempts.length, 2);
  assert.equal(doc.attempts[1].attemptNumber, 2);
  assert.equal(auditPath.endsWith('.json'), true);
});

// ---------------------------------------------------------------------------
// Test 4 — cfg.workerClass=claude-code surfaces in the hq dispatch args.
// ---------------------------------------------------------------------------

test('cfg.workerClass=claude-code routes the closer to claude-code', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-claude-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleHammerFixture({
    cfg: { workerClass: 'claude-code' },
    dispatchContext: { rootDir },
  });
  const exec = buildExecMock();
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: () => 'stubbed',
  });
  assert.equal(result.dispatched, true);
  assert.equal(result.workerClass, 'claude-code');
  const args = exec.calls[0].args;
  assert.equal(args[args.indexOf('--worker-class') + 1], 'claude-code');
});

test('cfg.workerClass=gemini routes the hammer to gemini with hammer provenance', async (t) => {
  // GMW-04 / MSM-04: gemini is a selectable AMA merge HARNESS. Only the executing
  // harness changes (`--worker-class gemini`) — the dispatched worker is the
  // terminal-remediation hammer, so the dispatch shape (--task-kind merge
  // --completion-shape decision-only) and the merge-commit provenance
  // (`Closed-By: hammer`) are unchanged. The standalone `-closer` agent is deleted.
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-gemini-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleHammerFixture({
    cfg: { workerClass: 'gemini' },
    dispatchContext: { rootDir },
  });
  const exec = buildExecMock();
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: () => readFileSync(HAMMER_TEMPLATE_PATH, 'utf8'),
  });
  assert.equal(result.dispatched, true);
  assert.equal(result.workerClass, 'gemini');
  const args = exec.calls[0].args;
  assert.equal(args[args.indexOf('--worker-class') + 1], 'gemini');
  // The AMA dispatch shape is unchanged — only the harness differs.
  assert.equal(args[args.indexOf('--task-kind') + 1], 'merge');
  assert.equal(args[args.indexOf('--completion-shape') + 1], 'decision-only');
  // The dispatched worker is the hammer, so the merge provenance is the hammer's,
  // regardless of which harness (gemini) executes it.
  assert.ok(write.captured.body.includes('Closed-By: hammer (adversarial-pipe-mode)'));
});

// MSM-04 — a clean exhausted closure has nothing for HAM to remediate, so it is
// NOT dispatched to any agent: the standalone `ama-closer-prompt.md` click-merge
// worker is deleted, and the fully-clean merge is owned by the MSM-03 daemon. The
// closer never spawns a worker (of any class) whose sole job is to click merge.
test('a clean exhausted closure dispatches no agent — the daemon owns the clean merge', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-clean-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const readPaths = [];
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
    cfg: { workerClass: 'hammer' },
    // Clean settled-success review: zero blocking and zero non-blocking findings.
    // Even at review-cycle exhaustion that alone must never spawn a merge agent.
    reviewState: { reviewCycleExhausted: true },
    dispatchContext: { rootDir, templatePath: null },
  });
  const exec = buildExecMock();
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: (path) => {
      readPaths.push(path);
      return readFileSync(path, 'utf8');
    },
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'clean-close-daemon-owned');
  assert.equal(result.skipMergeAgent, true);
  assert.equal(exec.calls.length, 0, 'no agent is spawned for a clean close');
  assert.deepEqual(readPaths, [], 'no prompt template is read for a clean close');
  assert.equal(write.captured.body, null, 'no prompt is written for a clean close');
});

// The terminal-remediation prompt is still selected for a hammer closure that
// genuinely needs remediation. With standing findings the verdict gate is only
// cleared by a findings-waiving mode (here: final-hammer review-cycle
// exhaustion plus a current-head operator-approved override), so this models an
// eligible-but-dirty closure that legitimately carries the HAM mandate.
test('cfg.workerClass=hammer selects the terminal HAM mandate prompt when findings need remediation', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const headSha = 'abc12345abc12345abc12345abc12345abc12345';
  const readPaths = [];
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer', mergeMethod: 'merge' },
    reviewState: {
      verdict: 'request-changes',
      reviewCycleExhausted: true,
      blockingFindingState: 'known',
      blockingFindingCount: 1,
      operatorApprovedEvidence: {
        applied: true,
        actor: 'operator-human',
        eventId: 'evt-operator-approved-1',
        observedAt: '2026-06-18T22:00:00Z',
        observedRevisionRef: headSha,
      },
    },
    prMetadata: {
      labels: [{ name: 'operator-approved' }],
    },
    dispatchContext: { rootDir, templatePath: null },
  });
  const exec = buildExecMock();
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: (path) => {
      readPaths.push(path);
      return readFileSync(path, 'utf8');
    },
  });
  assert.equal(result.dispatched, true);
  assert.equal(result.workerClass, 'hammer');
  const args = exec.calls[0].args;
  assert.equal(args[args.indexOf('--worker-class') + 1], 'hammer');
  assert.deepEqual(readPaths, [HAMMER_TEMPLATE_PATH]);
  assert.ok(write.captured.body.includes('Closed-By: hammer (adversarial-pipe-mode)'));
  assert.equal(write.captured.body.includes('Closed-By: hammer-closer (adversarial-pipe-mode)'), false);
  assert.match(write.captured.body, /remediate, commit, comment, validate, merge/i);
  assert.match(write.captured.body, /Do not request another adversarial review round/);
  assert.match(write.captured.body, /Do not defer the review findings into follow-up PRs/);
  assert.match(write.captured.body, /Every shell command you run must have an explicit wall-clock bound/);
  assert.match(write.captured.body, /do not fall back to broad host\s+scans/);
  assert.match(write.captured.body, /ham_terminal_remediation_validated/);
  assert.match(write.captured.body, /before-hammer-gh-pr-merge/);
  assert.match(write.captured.body, /HAM_LOCAL_BATTERY_COMMAND="\$\{HAM_LOCAL_BATTERY_COMMAND:-npm test\}"/);
  assert.match(write.captured.body, /fetchPullRequestRollup/);
  assert.match(write.captured.body, /gh pr merge https:\/\/github\.com\/acme\/myrepo\/pull\/1234[\s\S]*--merge[\s\S]*--match-head-commit "\$POST_REMEDIATION_SHA"/);
  assert.doesNotMatch(write.captured.body, /gh pr merge https:\/\/github\.com\/acme\/myrepo\/pull\/1234[\s\S]*--squash[\s\S]*--match-head-commit "\$POST_REMEDIATION_SHA"/);
  assert.match(write.captured.body, /hammer owns the in-lease merge/);
  assert.match(write.captured.body, /failed, missing, stale, or\s+unchecked required checks/);
  assert.match(write.captured.body, /HAM-03 hard-blocker: rebase attempt cap exceeded/);
  assert.match(write.captured.body, /HAM_UPDATE_BRANCH_RETRY_CAP="\$\{HAM_UPDATE_BRANCH_RETRY_CAP:-3\}"/);
  assert.match(write.captured.body, /HAM_UPDATE_BRANCH_EXIT=\$\?/);
  assert.match(write.captured.body, /validatedHead: \$validatedHead/);
});

test('auto-hammer dispatches HAM terminal remediation at review-cycle exhaustion even for verdict-only misses', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-exhausted-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const readPaths = [];
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: {
      workerClass: 'hammer',
      autoHammerOnEligibilityMiss: true,
    },
    reviewState: {
      verdict: 'request-changes',
      reviewCycleExhausted: true,
      blockingFindingState: 'known',
      blockingFindingCount: 0,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0,
    },
    dispatchContext: { rootDir, templatePath: null },
  });
  const exec = buildExecMock();
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: (path) => {
      readPaths.push(path);
      return readFileSync(path, 'utf8');
    },
  });
  assert.equal(result.dispatched, true);
  assert.equal(result.workerClass, 'hammer');
  assert.deepEqual(readPaths, [HAMMER_TEMPLATE_PATH]);
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].args[exec.calls[0].args.indexOf('--worker-class') + 1], 'hammer');
  assert.ok(write.captured.body.includes('Closed-By: hammer (adversarial-pipe-mode)'));
  assert.equal(write.captured.body.includes('Closed-By: hammer-closer (adversarial-pipe-mode)'), false);
  assert.match(write.captured.body, /remediate, commit, comment, validate, merge/i);
  assert.match(write.captured.body, /Get required checks and changed-surface tests green/);
});

test('auto-hammer dispatches exhausted CONFLICTING stale-head PRs through hammer', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-conflicting-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const reviewedHead = 'cc01669cc01669cc01669cc01669cc01669cc01';
  const currentHead = '8cf53758cf53758cf53758cf53758cf53758cf5';
  const readPaths = [];
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: {
      workerClass: 'codex',
      autoHammerOnEligibilityMiss: true,
    },
    reviewState: {
      verdict: 'request-changes',
      headSha: reviewedHead,
      riskClass: 'medium',
      reviewCycleExhausted: true,
      blockingFindingState: 'unknown',
      nonBlockingFindingState: 'unknown',
    },
    prMetadata: {
      headSha: currentHead,
      mergeableState: 'CONFLICTING',
    },
    dispatchContext: {
      rootDir,
      reviewedSha: reviewedHead,
      riskClass: 'medium',
      templatePath: null,
    },
  });
  const exec = buildExecMock();
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: (path) => {
      readPaths.push(path);
      return readFileSync(path, 'utf8');
    },
  });

  assert.equal(
    isHammerRemediableEligibilityMiss(
      ['pr-not-mergeable', 'stale-review-head', 'verdict-not-settled-success', 'blocking-findings-unknown'],
      { reviewCycleExhausted: true },
    ),
    true,
    '#3105 exhausted conflict reason set is hammer-remediable',
  );
  assert.equal(result.dispatched, true);
  assert.equal(result.workerClass, 'hammer');
  assert.deepEqual(readPaths, [HAMMER_TEMPLATE_PATH]);
  const workerClassIndex = exec.calls[0].args.indexOf('--worker-class');
  assert.notEqual(workerClassIndex, -1, 'hq dispatch args must include --worker-class');
  assert.equal(exec.calls[0].args[workerClassIndex + 1], 'hammer');
  assert.ok(write.captured.body.includes(reviewedHead), 'terminal hammer prompt must preserve the reviewed head');
  // MSM-04 — the dispatch keys on the REVIEWED head (stable job anchor); the one
  // hammer works the live branch itself and there is no per-HAM-commit current-head
  // re-target record to re-arm the loop.
  const recordPath = amaCloserDispatchFilePath(rootDir, {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: reviewedHead,
  });
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(record.headSha, reviewedHead);
  assert.equal(record.reviewedSha, reviewedHead);
  assert.equal(record.targetRemediationSha, reviewedHead);
  assert.notEqual(record.dispatchReason, 'exhausted-final-hammer');
  assert.equal(
    existsSync(amaCloserDispatchFilePath(rootDir, {
      repo: dispatchContext.repo,
      prNumber: prMetadata.prNumber,
      headSha: currentHead,
    })),
    false,
    'no current-head re-target record is written',
  );
  assert.ok(write.captured.body.includes('Closed-By: hammer (adversarial-pipe-mode)'));
});

// MSM-04 regression — the #3123 re-hammer loop. A settled review that is FULLY
// CLEAN (zero findings) but whose reviewed head is stale because a prior HAM
// commit advanced the PR head is NOT hammer-remediable: there is nothing to
// remediate, so re-hammering it just re-arms the loop. It must dispatch NO agent
// (a fresh review of the new head is the correct next step, not another hammer).
test('#3123: a clean stale-head (prior HAM commit advanced the head) spawns no hammer', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-clean-stale-head-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const reviewedHead = 'cc01669cc01669cc01669cc01669cc01669cc01';
  const currentHead = '8cf53758cf53758cf53758cf53758cf53758cf5';
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
    cfg: {
      workerClass: 'codex',
      autoHammerOnEligibilityMiss: true,
    },
    reviewState: {
      // A clean settled-success review (zero findings) at cycle exhaustion.
      headSha: reviewedHead,
      riskClass: 'medium',
      reviewCycleExhausted: true,
      blockingFindingState: 'known',
      blockingFindingCount: 0,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0,
    },
    prMetadata: {
      // The live head advanced past the reviewed head (a prior HAM commit moved it).
      headSha: currentHead,
      mergeableState: 'MERGEABLE',
    },
    dispatchContext: {
      rootDir,
      reviewedSha: reviewedHead,
      riskClass: 'medium',
      templatePath: null,
    },
  });
  const exec = buildExecMock();
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: (path) => readFileSync(path, 'utf8'),
  });

  // A bare stale-review-head with nothing to remediate is not hammer-remediable,
  // even at exhaustion — this is the guard that keeps the loop from re-arming.
  assert.equal(
    isHammerRemediableEligibilityMiss(['stale-review-head'], { reviewCycleExhausted: true }),
    false,
    'a clean stale-review-head must not be hammer-remediable at exhaustion',
  );
  assert.equal(result.dispatched, false, 'no hammer is dispatched for a clean stale head');
  assert.equal(exec.calls.length, 0, 'no hq dispatch for a clean stale head (#3123 loop guard)');
  assert.equal(write.captured.body, null, 'no prompt is written for a clean stale head');
});

// MSM-04 mandatory — idempotency. Two settle ticks for the SAME logical job/head
// dispatch AT MOST ONE hammer: the first acquires the merge lease + writes the
// dispatch record; the second sees the live in-flight dispatch under the same
// (repo, pr, reviewed-head) key and suppresses, never launching a second worker.
test('two settle ticks for the same job dispatch at most one hammer (lease + logical-job key)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-idempotent-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const launches = [];
  const execFileImpl = async (_cmd, args) => {
    if (args[0] === 'dispatch' && args[1] === 'status') {
      // The first tick's worker is still running when the second tick fires.
      return { stdout: '{"status":"running"}', stderr: '' };
    }
    if (args[0] !== 'dispatch') {
      return { stdout: '{}', stderr: '' };
    }
    launches.push(args);
    return { stdout: '{"dispatchId":"dispatch_once","launchRequestId":"lrq_once"}', stderr: '' };
  };

  const tick1 = await maybeDispatchAmaCloser({
    ...hammerFixture({ dispatchContext: { rootDir } }),
    execFileImpl,
    readTemplateImpl: () => readFileSync(HAMMER_TEMPLATE_PATH, 'utf8'),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
  });
  assert.equal(tick1.dispatched, true, 'the first settle tick dispatches the one hammer');

  // Second concurrent tick for the SAME job/head — the lease is still held and the
  // dispatch record shows a live in-flight worker.
  const tick2 = await maybeDispatchAmaCloser({
    ...hammerFixture({ dispatchContext: { rootDir } }),
    execFileImpl,
    readTemplateImpl: () => readFileSync(HAMMER_TEMPLATE_PATH, 'utf8'),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
  });
  assert.equal(tick2.dispatched, false, 'the second settle tick does NOT spawn a second hammer');
  assert.equal(tick2.skipMergeAgent, true, 'the in-flight hammer keeps the tick off the merge-agent lane');
  assert.equal(launches.length, 1, 'exactly one hammer worker was launched across both ticks');
});

// MSM-04 mandatory — structural hard-stops still block. A hard-stop label
// (`do-not-merge`) is not code the hammer may remediate, so even a findings PR at
// review-cycle exhaustion (which would otherwise auto-hammer) dispatches NO agent.
test('a structural hard-stop label blocks the hammer even with remediable findings', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hardstop-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    prMetadata: { labels: ['do-not-merge'] },
    dispatchContext: { rootDir },
  });
  const exec = buildExecMock();
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: () => readFileSync(HAMMER_TEMPLATE_PATH, 'utf8'),
  });

  // The hard-stop label makes the miss non-hammer-remediable at every phase.
  assert.equal(
    isHammerRemediableEligibilityMiss(
      ['label-do-not-merge', 'verdict-not-settled-success', 'blocking-findings-present'],
      { reviewCycleExhausted: true },
    ),
    false,
    'a hard-stop label is never hammer-remediable, even at exhaustion',
  );
  assert.equal(result.dispatched, false, 'no hammer is dispatched past a hard-stop label');
  assert.equal(result.reason, 'not-eligible');
  assert.equal(exec.calls.length, 0, 'no hq dispatch past a structural hard-stop');
  assert.equal(write.captured.body, null, 'no prompt is written past a hard-stop');
});

test('auto-hammer does not bypass blocking findings before exhaustion on conflicting PRs', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-conflicting-blocking-pre-exhaustion-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: {
      workerClass: 'hammer',
      autoHammerOnEligibilityMiss: true,
    },
    reviewState: {
      verdict: 'request-changes',
      reviewCycleExhausted: false,
      blockingFindingState: 'known',
      blockingFindingCount: 1,
    },
    prMetadata: {
      mergeableState: 'CONFLICTING',
    },
    dispatchContext: { rootDir },
  });
  const exec = buildExecMock();
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: (path) => readFileSync(path, 'utf8'),
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'not-eligible');
  assert.ok(result.reasons.includes('pr-not-mergeable'));
  assert.ok(result.reasons.includes('blocking-findings-present'));
  assert.equal(exec.calls.length, 0);
  assert.equal(write.captured.body, null);
});

test('AMA #3084: exhausted hammer dispatch records are keyed by target head commits', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-stable-head-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const heads = [
    '40e302440e302440e302440e302440e302440e3024',
    '6358df76358df76358df76358df76358df76358d',
  ];
  const exec = buildExecMock({ stdout: 'dispatchId=lrq_rehammer\n' });
  const write = buildWriteMock();
  const results = [];
  for (const headSha of heads) {
    const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
      cfg: {
        workerClass: 'hammer',
        autoHammerOnEligibilityMiss: true,
      },
      reviewState: {
        verdict: 'request-changes',
        headSha,
        riskClass: 'medium',
        reviewCycleExhausted: true,
        blockingFindingState: 'known',
        blockingFindingCount: 0,
        nonBlockingFindingState: 'known',
        nonBlockingFindingCount: 0,
      },
      prMetadata: {
        headSha,
        mergeableState: 'MERGEABLE',
      },
      dispatchContext: {
        rootDir,
        reviewedSha: headSha,
        targetRemediationSha: headSha,
        dispatchRecordHeadSha: headSha,
        dispatchReason: 'exhausted-final-hammer',
        riskClass: 'medium',
        templatePath: null,
      },
    });

    const result = await maybeDispatchAmaCloser({
      reviewState,
      prMetadata,
      cfg,
      dispatchContext,
      execFileImpl: exec.impl,
      writeFileImpl: write.impl,
      readTemplateImpl: (path) => readFileSync(path, 'utf8'),
    });
    results.push(result);
  }

  assert.equal(results[0].dispatched, true);
  assert.equal(results[0].workerClass, 'hammer');
  assert.equal(results[1].dispatched, true);
  assert.equal(results[1].workerClass, 'hammer');
  const dispatchCalls = exec.calls.filter((call) => {
    const args = call.args || [];
    return args[0] === 'dispatch' && args[1] !== 'status';
  });
  assert.equal(dispatchCalls.length, 2, 'each target head is keyed by its commit SHA');
  for (const headSha of heads) {
    const recordPath = amaCloserDispatchFilePath(rootDir, {
      repo: 'acme/myrepo',
      prNumber: 1234,
      headSha,
    });
    assert.equal(existsSync(recordPath), true);
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.equal(record.retryCount, 1);
    assert.equal(record.headSha, headSha);
    assert.equal(record.reviewedSha, headSha);
    assert.equal(record.targetRemediationSha, headSha);
    assert.equal(record.dispatchReason, 'exhausted-final-hammer');
  }
});

test('AMA #3084 loop guard: same current-head hammer success with unknown merged signal alerts operator', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-loop-guard-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const headSha = '6358df76358df76358df76358df76358df76358d';
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: {
      workerClass: 'hammer',
      autoHammerOnEligibilityMiss: true,
    },
    reviewState: {
      verdict: 'request-changes',
      headSha,
      riskClass: 'medium',
      reviewCycleExhausted: true,
      blockingFindingState: 'known',
      blockingFindingCount: 0,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0,
    },
    prMetadata: {
      headSha,
      mergeableState: 'MERGEABLE',
    },
    dispatchContext: {
      rootDir,
      reviewedSha: headSha,
      riskClass: 'medium',
      templatePath: null,
      dispatchedAt: '2026-07-04T12:00:00Z',
    },
  });
  plantDispatchRecord(rootDir, {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha,
  }, {
    workerClass: 'hammer',
    state: 'dispatched',
    retryCount: 1,
    dispatchId: 'dispatch-current-head-hammer',
    launchRequestId: 'lrq-current-head-hammer',
    lastObservedStatus: 'starting',
    dispatchedAt: '2026-07-04T11:55:00Z',
  });

  const calls = [];
  const errors = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: '{"status":"succeeded"}', stderr: '' };
      }
      throw new Error(`unexpected redispatch: ${args.join(' ')}`);
    },
    readTemplateImpl: (path) => readFileSync(path, 'utf8'),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'sqlite-read-failed' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    logger: {
      error(line) {
        errors.push(JSON.parse(line));
      },
      info() {},
      warn() {},
      log() {},
    },
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'current-head-hammer-already-ran-needs-operator');
  assert.equal(result.needsOperator, true);
  assert.equal(
    calls.filter((args) => args[0] === 'dispatch' && args[1] !== 'status').length,
    0,
    'same-head hammer must not redispatch after terminal success',
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].event, 'ama_closer.current_head_hammer_stuck');
  assert.equal(errors[0].headSha, headSha);
});

test('AMA #3084 loop guard: same current-head hammer success with merged signal does not alert stuck', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-merged-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const headSha = '6358df76358df76358df76358df76358df76358d';
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: {
      workerClass: 'hammer',
      autoHammerOnEligibilityMiss: true,
    },
    reviewState: {
      verdict: 'request-changes',
      headSha,
      riskClass: 'medium',
      reviewCycleExhausted: true,
      blockingFindingState: 'known',
      blockingFindingCount: 0,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0,
    },
    prMetadata: {
      headSha,
      mergeableState: 'MERGEABLE',
    },
    dispatchContext: {
      rootDir,
      reviewedSha: headSha,
      riskClass: 'medium',
      templatePath: null,
      dispatchedAt: '2026-07-04T12:00:00Z',
    },
  });
  plantDispatchRecord(rootDir, {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha,
  }, {
    workerClass: 'hammer',
    state: 'dispatched',
    retryCount: 1,
    dispatchId: 'dispatch-current-head-hammer',
    launchRequestId: 'lrq-current-head-hammer',
    lastObservedStatus: 'starting',
    dispatchedAt: '2026-07-04T11:55:00Z',
  });

  const errors = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: async (_cmd, args) => {
      if (args[0] === 'worker' && args[1] === 'tear-down') {
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected dispatch call: ${args.join(' ')}`);
    },
    readTemplateImpl: (path) => readFileSync(path, 'utf8'),
    readBuildCompletionSignalForPrImpl: () => ({
      ok: true,
      row: { signal_kind: 'merged', head_sha: 'merge-commit-sha' },
      headShaMatchesReviewed: false,
      producerHeadSha: 'merge-commit-sha',
    }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: true, row: { producer: 'autowalk' } }),
    logger: {
      error(line) {
        errors.push(JSON.parse(line));
      },
      info() {},
      warn() {},
      log() {},
    },
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'merged-signal-present');
  assert.equal(errors.length, 0);
});

// Unit coverage for the prompt-selection predicate itself (HAM-04, SPEC §1.1.1).
test('amaClosureNeedsTerminalRemediation triggers on waived unset verdict without findings', () => {
  const clean = {
    trace: {
      verdict: {
        blockingFindings: { known: true, count: 0 },
        nonBlockingFindings: { known: true, count: 0 },
      },
      hamTerminalRemediation: { active: false },
      finalHammer: { active: false },
    },
  };
  assert.equal(amaClosureNeedsTerminalRemediation(clean), false);

  const withBlocking = structuredClone(clean);
  withBlocking.trace.verdict.blockingFindings = { known: true, count: 1 };
  assert.equal(amaClosureNeedsTerminalRemediation(withBlocking), true);

  const withNonBlocking = structuredClone(clean);
  withNonBlocking.trace.verdict.nonBlockingFindings = { known: true, count: 2 };
  assert.equal(amaClosureNeedsTerminalRemediation(withNonBlocking), true);

  const finalHammerActiveClean = structuredClone(clean);
  finalHammerActiveClean.trace.finalHammer = { active: true, waived: [] };
  assert.equal(amaClosureNeedsTerminalRemediation(finalHammerActiveClean), false);

  const finalHammerOnlyWaivedBranchProtection = structuredClone(clean);
  finalHammerOnlyWaivedBranchProtection.trace.finalHammer = {
    active: true,
    waived: ['branch-protection-missing-gate'],
  };
  assert.equal(amaClosureNeedsTerminalRemediation(finalHammerOnlyWaivedBranchProtection), false);

  const finalHammerWaivedFindingsGate = structuredClone(clean);
  finalHammerWaivedFindingsGate.trace.finalHammer = {
    active: true,
    waived: ['blocking-findings-unknown'],
  };
  assert.equal(amaClosureNeedsTerminalRemediation(finalHammerWaivedFindingsGate), true);

  const finalHammerWaivedVerdictGate = structuredClone(clean);
  finalHammerWaivedVerdictGate.trace.finalHammer = {
    active: true,
    waived: ['verdict-not-settled-success'],
  };
  assert.equal(amaClosureNeedsTerminalRemediation(finalHammerWaivedVerdictGate), true);

  const finalHammerWaivedVerdictGateWithFindings = structuredClone(finalHammerWaivedVerdictGate);
  finalHammerWaivedVerdictGateWithFindings.trace.verdict.nonBlockingFindings = { known: true, count: 1 };
  assert.equal(amaClosureNeedsTerminalRemediation(finalHammerWaivedVerdictGateWithFindings), true);

  const hamEvidenceActive = structuredClone(clean);
  hamEvidenceActive.trace.hamTerminalRemediation = { active: true };
  assert.equal(amaClosureNeedsTerminalRemediation(hamEvidenceActive), true);

  // Conservative fallback: a missing trace must not silently downgrade.
  assert.equal(amaClosureNeedsTerminalRemediation({}), true);
});

test('eligible dispatch refuses watcher audit writes when runtime user is not the HQ owner', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-owner-mismatch-'));
  const hqRoot = mkdtempSync(join(tmpdir(), 'ama-hq-owner-mismatch-'));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  });
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: {
      rootDir,
      hqRoot,
      hqOwnerUser: `${CURRENT_USER}-different`,
      currentUser: CURRENT_USER,
    },
  });
  await assert.rejects(
    () => maybeDispatchAmaCloser({
      reviewState,
      prMetadata,
      cfg,
      dispatchContext,
      execFileImpl: async () => ({
        stdout: '{"dispatchId":"dispatch-bootstrap","launchRequestId":"lrq_bootstrap"}',
        stderr: '',
      }),
      readTemplateImpl: () => 'stubbed',
    }),
    /does not match HQ ownerUser/,
  );
});

// ---------------------------------------------------------------------------
// Test 5 — Prompt body snapshot vs the golden file.
// ---------------------------------------------------------------------------

test('composed prompt body matches the checked-in golden snapshot', () => {
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: {
      rootDir: '/tmp/ama-test-root',
      hqRoot: '/tmp/ama-test-hqroot',
    },
  });
  // Use the same substitution values the dispatch site composes.
  const templateBody = readFileSync(TEMPLATE_PATH, 'utf8');
  const auditPath =
    `${dispatchContext.hqRoot}/dispatch/audit/adversarial-merge-authority/` +
    `${dispatchContext.repo.replace('/', '-')}-pr-${prMetadata.prNumber}-${dispatchContext.reviewedSha}.json`;
  const auditRef = amaAuditTraceRef(dispatchContext.repo, prMetadata.prNumber, dispatchContext.reviewedSha);
  const prompt = composeCloserPrompt({
    prUrl: dispatchContext.prUrl,
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    reviewedSha: dispatchContext.reviewedSha,
    riskClass: dispatchContext.riskClass,
    mergeMethod: cfg.mergeMethod,
    requiredGateContext: dispatchContext.requiredGateContext,
    auditPath,
    hqRoot: dispatchContext.hqRoot,
    rootDir: dispatchContext.rootDir,
    hqOwnerUser: 'unknown',
    reviewedBy: dispatchContext.reviewedBy,
    reviewer: dispatchContext.reviewer,
    dispatchedAt: dispatchContext.dispatchedAt,
    amaTrailers: [
      'Closed-By: codex-closer (adversarial-pipe-mode)',
      'Reviewed-By: claude-reviewer-lacey',
      'Risk-Class: low',
      'Eligibility-Reason: latest_review_settled_success, reviewer_family_recorded, risk_class_low_permitted, head_sha_matches_review, ci_all_green, no_blocking_labels, configured_gate_context_required',
      `Eligibility-Trace: ${auditRef}`,
    ].join('\n'),
    templateBody,
  });
  const golden = readFileSync(GOLDEN_PROMPT_PATH, 'utf8');
  assert.equal(
    prompt,
    golden,
    'composed prompt drifted from the golden snapshot. ' +
    'Re-generate via the snippet in the test file header (search "// regenerate-golden") ' +
    'after reviewing the diff for unintended changes.',
  );
  assert.match(prompt, /branchProtectionUnavailable: true, reason: "github_plan"/);
  assert.match(prompt, /protection_max_attempts=3/);
  assert.match(prompt, /grep -Eiq "\$protection_transient_re" "\$protection_err"/);
  assert.match(prompt, /cat "\$protection_err" >&2\n  rm -f "\$protection_err"\n  exit 1/);
  assert.match(prompt, /HAM-03 stale-head \/ behind recovery/);
  assert.match(prompt, /AMA_REBASE_ATTEMPT_CAP="\$\{AMA_REBASE_ATTEMPT_CAP:-3\}"/);
  assert.match(prompt, /jq '\[\.attempts\[\]\?\.rebaseAttempts \/\/ 0\] \| max \/\/ 0'/);
  assert.match(prompt, /REBASE_UPDATE_BRANCH_RETRY_CAP="\$\{REBASE_UPDATE_BRANCH_RETRY_CAP:-3\}"/);
  assert.match(prompt, /ama-rebase-authority\.mjs/);
  assert.match(prompt, /assess_rebase_equivalence/);
  assert.match(prompt, /write_non_empty_patch_ids/);
  assert.match(prompt, /set -o pipefail; git patch-id --stable/);
  assert.match(prompt, /empty \$patch_id_label patch-id evidence/);
  assert.match(prompt, /HARD_BLOCKER_REASON=reviewed-diff-fetch-failure/);
  assert.match(prompt, /HARD_BLOCKER_REASON=rebased-diff-fetch-failure/);
  assert.doesNotMatch(prompt, /@SECURITY\.md/);
  assert.match(prompt, /is_update_branch_conflict/);
  assert.match(prompt, /is_update_branch_transient/);
  assert.match(prompt, /HARD_BLOCKER_REASON=update-branch-failure/);
  assert.match(prompt, /content_equivalent_rebased_head/);
  assert.match(prompt, /AMA_TMP_DIR=\$\(mktemp -d -t ama-closer\.XXXXXX\)/);
  assert.match(prompt, /trap 'rm -rf "\$AMA_TMP_DIR"' EXIT/);
  assert.match(prompt, /--rebase-assessment "\$AMA_TMP_DIR\/ama-rebase-assessment\.json"/);
  assert.doesNotMatch(prompt, /\/tmp\/ama-rebase-assessment\.json/);
  assert.match(
    prompt,
    /ama-check\.mjs[\s\S]*--reviewed-sha abc12345abc12345abc12345abc12345abc12345[\s\S]*--rebase-assessment "\$AMA_TMP_DIR\/ama-rebase-assessment\.json"/,
  );
  assert.match(prompt, /Rebase-Attempts: \${REBASE_ATTEMPTS:-0}/);
  assert.match(prompt, /ham_terminal_remediation_validated/);
  assert.match(prompt, /AMA_MERGE_LEASE_BIN="\/Users\/airlock\/agent-os\/tools\/adversarial-review\/bin\/merge-lease\.mjs"/);
  assert.match(prompt, /MERGE_LEASE_BASE_BRANCH=""/);
  assert.match(prompt, /fetch_current_base_sha\(\) \{[\s\S]*attempt=1[\s\S]*is_merge_lease_revalidation_transient "\$err_path"[\s\S]*merge-lease base fetch transient failure/);
  assert.match(prompt, /if ! MERGE_VALIDATION_BASE=\$\(fetch_current_base_sha "\$MERGE_LEASE_BASE_BRANCH"\); then[\s\S]*append_merge_lease_revalidation_deferred_attempt_and_exit merge-lease-base-fetch-failure/);
  assert.match(prompt, /ensure_ama_audit_owner\(\)/);
  assert.match(prompt, /append_merge_lease_parked_attempt_and_exit\(\) \{[\s\S]*ensure_ama_audit_owner/);
  assert.match(prompt, /append_merge_lease_timeout_deferred_attempt_and_exit\(\) \{[\s\S]*ensure_ama_audit_owner/);
  assert.match(prompt, /MERGE_LEASE_OWNER_PGID_ARGS=\(\)/);
  assert.match(prompt, /MERGE_LEASE_OWNER_PGID_ARGS=\(--owner-pgid "\$MERGE_LEASE_OWNER_PGID"\)/);
  assert.match(prompt, /node "\$AMA_MERGE_LEASE_BIN" acquire[\s\S]*--owner-pid "\$\$"[\s\S]*"\$\{MERGE_LEASE_OWNER_PGID_ARGS\[@\]\}"[\s\S]*MERGE_LEASE_ID=\$\(jq -r '\.leaseId'/);
  assert.match(prompt, /ACQUIRE_EXIT=\$\?/);
  assert.match(prompt, /\[ "\$ACQUIRE_EXIT" -eq 75 \] && jq -e '\.timedOut == true'/);
  assert.match(prompt, /append_merge_lease_timeout_deferred_attempt_and_exit/);
  assert.match(prompt, /preMergeReasons: \["merge-lease-timeout"\], mergeLeaseTimeout: true/);
  assert.match(prompt, /--outcome deferred/);
  assert.match(prompt, /\[ "\$ACQUIRE_EXIT" -eq 70 \] && jq -e '\.parked == true'/);
  assert.match(prompt, /hardBlockerReason: "merge-lease-parked"/);
  const mergeLeaseTransientFn = prompt.match(
    /is_merge_lease_revalidation_transient\(\) \{[\s\S]*?\n\}/,
  )?.[0] || '';
  assert.doesNotMatch(mergeLeaseTransientFn, /\(\^\\\|\[\^0-9\]\)\(500\|502\|503\|504\)/);
  assert.doesNotMatch(mergeLeaseTransientFn, /server error/);
  assert.match(prompt, /trap 'release_merge_lease_if_held \|\| true; rm -rf "\$AMA_TMP_DIR"' EXIT/);
  assert.match(prompt, /trap 'release_merge_lease_if_held \|\| true; rm -rf "\$AMA_TMP_DIR"' EXIT\nacquire_merge_lease/);
  assert.doesNotMatch(prompt, /acquire_merge_lease\ntrap 'release_merge_lease_if_held \|\| true; rm -rf "\$AMA_TMP_DIR"' EXIT/);
  assert.match(prompt, /MERGE_VALIDATION_BASE=\$\(fetch_current_base_sha "\$MERGE_LEASE_BASE_BRANCH"\)/);
  assert.match(prompt, /run_revalidation_snapshot_command ama-pr-base-guard/);
  assert.match(prompt, /CURRENT_PR_BASE_BRANCH=\$\(jq -r '\.baseRefName' "\$AMA_TMP_DIR\/ama-pr-base-guard\.json"\)/);
  assert.match(prompt, /append_merge_lease_revalidation_deferred_attempt_and_exit merge-lease-base-retargeted/);
  assert.match(prompt, /run_revalidation_snapshot_command ama-pr/);
  assert.match(prompt, /append_merge_lease_revalidation_deferred_attempt_and_exit merge-lease-ama-check-failure/);
  assert.match(prompt, /node "\$AMA_MERGE_LEASE_BIN" needs-revalidation[\s\S]*--validation-base "\$MERGE_VALIDATION_BASE"[\s\S]*--current-base "\$CURRENT_BASE_SHA"/);
  assert.match(prompt, /if jq -e '\.needsRevalidation == true'/);
  assert.match(prompt, /REBASE_ASSESSED_HEAD="\$VALIDATED_HEAD"/);
  assert.match(prompt, /--match-head-commit "\$VALIDATED_HEAD"/);
  assert.match(prompt, /node "\$AMA_MERGE_LEASE_BIN" release[\s\S]*--lease-id "\$MERGE_LEASE_ID"/);
  assert.match(prompt, /gh pr comment https:\/\/github\.com\/acme\/myrepo\/pull\/1234/);
  assert.match(prompt, /<!-- hq:closeout:pr -->/);
  assert.match(prompt, /Findings remediated: none required; clean AMA close/);
  assert.doesNotMatch(prompt, /UPDATE_BRANCH_EXIT"\s+-eq 2[\s\S]*release_merge_lease_if_held \|\| true[\s\S]*unresolvable-rebase-conflict/);
  assert.doesNotMatch(prompt, /if \[ "\$OUTCOME" = "succeeded" \]; then[\s\S]*release_merge_lease_if_held \|\| true/);
});

test('composed hammer prompt body matches the checked-in golden snapshot', () => {
  const { prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer' },
    dispatchContext: {
      rootDir: '/tmp/ama-test-root',
      hqRoot: '/tmp/ama-test-hqroot',
    },
  });
  const templateBody = readFileSync(HAMMER_TEMPLATE_PATH, 'utf8');
  const auditPath =
    `${dispatchContext.hqRoot}/dispatch/audit/adversarial-merge-authority/` +
    `${dispatchContext.repo.replace('/', '-')}-pr-${prMetadata.prNumber}-${dispatchContext.reviewedSha}.json`;
  const auditRef = amaAuditTraceRef(dispatchContext.repo, prMetadata.prNumber, dispatchContext.reviewedSha);
  const prompt = composeCloserPrompt({
    prUrl: dispatchContext.prUrl,
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    reviewedSha: dispatchContext.reviewedSha,
    riskClass: dispatchContext.riskClass,
    mergeMethod: cfg.mergeMethod,
    requiredGateContext: dispatchContext.requiredGateContext,
    auditPath,
    hqRoot: dispatchContext.hqRoot,
    rootDir: dispatchContext.rootDir,
    hqOwnerUser: 'unknown',
    reviewedBy: dispatchContext.reviewedBy,
    reviewer: dispatchContext.reviewer,
    dispatchedAt: dispatchContext.dispatchedAt,
    amaTrailers: [
      'Closed-By: hammer (adversarial-pipe-mode)',
      'Reviewed-By: claude-reviewer-lacey',
      'Risk-Class: low',
      `Eligibility-Trace: ${auditRef}`,
    ].join('\n'),
    templateBody,
  });
  const golden = readFileSync(HAMMER_GOLDEN_PROMPT_PATH, 'utf8');
  assert.equal(prompt, golden);
  assert.match(prompt, /Remediate ALL final comments, blocking and non-blocking/);
  assert.match(prompt, /No silent red exits/);
  assert.match(prompt, /subrepo PR opened/);
  assert.match(prompt, /submodule-rooted failure/);
  assert.match(prompt, /real PR against the submodule's owning\s+repository/);
  assert.match(prompt, /main-catchup automatically floats the superproject `tools\/<submodule>`\s+gitlink/);
  assert.match(prompt, /Never create a separate\s+superproject pointer-bump PR/);
  assert.match(prompt, /No superproject pointer-bump PRs for submodule fixes/);
  assert.match(prompt, /CFG parity/);
  assert.match(prompt, /Dual-source migration parity is mandatory/);
  assert.match(prompt, /Worker-Ticket: HAM/);
  assert.doesNotMatch(prompt, /HAM-02/);
  assert.match(prompt, /Do not request another adversarial review round/);
  assert.match(prompt, /No follow-up PRs\/issues for the final findings/);
  assert.match(prompt, /ham_terminal_remediation_validated/);
  assert.match(prompt, /Do not merge unless all of these are true/);
  assert.match(prompt, /HAM_REBASE_ATTEMPT_CAP="\$\{HAM_REBASE_ATTEMPT_CAP:-3\}"/);
  assert.match(prompt, /HAM_MERGE_LEASE_RELEASE_RETRY_CAP="\$\{HAM_MERGE_LEASE_RELEASE_RETRY_CAP:-3\}"/);
  assert.match(prompt, /ham_update_branch_conflict/);
  assert.match(prompt, /ham_update_branch_transient/);
  assert.match(prompt, /No unbounded rebase\/update-branch retries/);
  assert.match(prompt, /merge-lease\.mjs acquire[\s\S]*--owner-pid "\$\$"[\s\S]*--wait "\$HAM_MERGE_LEASE_WAIT_SECONDS"/);
  assert.match(prompt, /The acquire waits; do not poll/);
  assert.match(prompt, /HAM_MERGE_LEASE_ID=\$\(jq -r '\.leaseId \/\/ empty'/);
  assert.match(prompt, /HAM_MERGE_LEASE_ACQUIRE_EXIT" -eq 75[\s\S]*'\.timedOut \/\/ false'/);
  assert.match(prompt, /merge lease acquisition timed out for PR 1234/);
  assert.match(prompt, /ham_fetch_base_with_retries/);
  assert.match(prompt, /ham_is_full_sha "\$HAM_VALIDATION_BASE_SHA"/);
  assert.match(prompt, /"reason":"validation-base-unavailable"/);
  assert.match(prompt, /merge-lease\.mjs needs-revalidation[\s\S]*--current-base "\$HAM_CURRENT_BASE_SHA"/);
  assert.match(prompt, /needs-revalidation-tool-failed/);
  assert.match(prompt, /needs-revalidation-output-invalid/);
  assert.match(prompt, /jq -er 'if \(\.needsRevalidation \| type\) == "boolean" then \.needsRevalidation else true end'/);
  assert.match(prompt, /before-hammer-gh-pr-merge/);
  assert.match(prompt, /HAM_LOCAL_BATTERY_COMMAND="\$\{HAM_LOCAL_BATTERY_COMMAND:-npm test\}"/);
  assert.match(prompt, /ham_run_local_battery_with_timeout/);
  assert.match(prompt, /use POSIX qw\(setsid\)/);
  assert.match(prompt, /kill "TERM", -\$pid/);
  assert.doesNotMatch(prompt, /perl -e 'alarm shift @ARGV; exec @ARGV'/);
  assert.match(prompt, /fetchPullRequestRollup/);
  assert.match(prompt, /statusCheckRollup/);
  assert.match(prompt, /const mergeable = String\(rollup\.mergeable \|\| ''\)\.toUpperCase\(\) === 'MERGEABLE'/);
  assert.match(prompt, /const state = String\(rollup\.state \|\| ''\)\.toUpperCase\(\)/);
  // MSM-02: the hammer's GitHub pre-merge gate routes through the shared
  // merge-eligibility predicate instead of an inline boolean expression.
  assert.match(prompt, /import \{ evaluateMergeEligibility \} from '[^']*\/src\/ama\/merge-eligibility\.mjs'/);
  assert.match(prompt, /const ok = evaluateMergeEligibility\(\{[\s\S]*requiredChecks: checks,[\s\S]*validatedHead: expectedHead,[\s\S]*\}\)\.eligible;/);
  assert.doesNotMatch(prompt, /const ok = open && headMatches && mergeable && notBehind/);
  assert.match(prompt, /ham_already_merged_validated_head/);
  assert.match(prompt, /HAM_MERGE_TMP_PREFIX="\$\{TMPDIR:-\/tmp\}\/ham-1234-\$\{HAM_MERGE_LEASE_ID:-no-lease\}-\$\$"/);
  assert.match(prompt, /HAM_MERGE_STDOUT=\$\(mktemp "\$\{HAM_MERGE_TMP_PREFIX\}\.gh-pr-merge\.stdout\.XXXXXX"\) \|\| exit 1/);
  assert.doesNotMatch(prompt, /HAM_MERGE_STDOUT="\/tmp\/ham-gh-pr-merge\.stdout"/);
  assert.match(prompt, /--argjson githubGate "\$\(\[ -s "\$HAM_GATE_JSON" \] && cat "\$HAM_GATE_JSON" \|\| printf '\{\}'\)"/);
  assert.match(prompt, /--argjson preMergeEligible "\$\{HAM_PRE_MERGE_ELIGIBLE:-0\}"/);
  assert.match(prompt, /preMergeEligible: \(\$preMergeEligible == 1\)/);
  assert.match(prompt, /ham_refresh_github_gate_once\(\)/);
  assert.match(prompt, /HAM GitHub gate read transient failure; retrying/);
  assert.match(prompt, /HAM preflight: PR is already merged at validated head; proceeding to post-merge validation/);
  assert.match(prompt, /ham_merge_error_retryable/);
  assert.match(prompt, /ham_merge_error_already_merged/);
  assert.match(prompt, /ham_merge_error_permanent/);
  assert.match(prompt, /HAM_MERGE_RETRY_CAP="\$\{HAM_MERGE_RETRY_CAP:-4\}"/);
  assert.match(prompt, /gh pr merge https:\/\/github\.com\/acme\/myrepo\/pull\/1234[\s\S]*--squash[\s\S]*--match-head-commit "\$POST_REMEDIATION_SHA"/);
  assert.match(prompt, /PR is already merged at validated head; proceeding to post-merge validation/);
  assert.match(prompt, /full local test battery failed; fix locally before merge/);
  assert.match(prompt, /ham_append_terminal_audit failed-without-merge local-battery-red/);
  assert.match(prompt, /live PR head moved off validated head; releasing lease without merge or re-dispatch/);
  assert.match(prompt, /ham_append_terminal_audit superseded live-head-moved-before-merge/);
  assert.match(prompt, /ham_append_terminal_audit failed-without-merge github-gate-not-green/);
  assert.match(prompt, /HAM merge response says PR is already merged; proceeding to post-merge validation/);
  assert.match(prompt, /permanent gh pr merge rejection; not retrying/);
  assert.match(prompt, /merge transient failure; retrying/);
  assert.match(prompt, /merge-retry-budget-exhausted/);
  assert.match(prompt, /gh pr view https:\/\/github\.com\/acme\/myrepo\/pull\/1234 --json state,mergedAt,mergeCommit,headRefOid[\s\S]*2> "\$HAM_POST_MERGE_STDERR"/);
  assert.match(prompt, /post-merge confirmation transient failure; retrying/);
  assert.match(prompt, /merge-confirmation-read-failed/);
  assert.match(prompt, /deferred merge-confirmation-read-failed-after-merge-accepted/);
  assert.match(prompt, /\.mergeCommit\?\.oid \/\/ ""/);
  assert.match(prompt, /ham_append_terminal_audit succeeded merged\n\s+HAM_MERGED_AUDIT_APPEND_EXIT=\$\?/);
  assert.doesNotMatch(prompt, new RegExp("ham_merge_error_permanent\\(\\) \\{\\n  grep -Eiq '[^']*already merged"));
  assert.match(prompt, /merge-lease\.mjs release[\s\S]*--lease-id "\$HAM_MERGE_LEASE_ID"/);
  assert.match(prompt, /keeping EXIT trap armed/);
  assert.match(prompt, /do not continue while the lease is unconfirmed/);
  assert.match(prompt, /trap ham_release_merge_lease EXIT/);
  assert.match(prompt, /HAM_MERGE_LEASE_ID=""\n\s+trap - EXIT/);
  assert.match(prompt, /HAM_AUDIT_COMMENT_MARKER='<!-- hq:ham-terminal-remediation:audit -->'/);
  assert.match(prompt, /HAM_AUDIT_COMMENT_HEAD="HAM-Terminal-Remediation-Head: \$POST_REMEDIATION_SHA"/);
  assert.match(prompt, /HAM_AUDIT_PR_VIEW_STDERR=\$\(mktemp "\$\{TMPDIR:-\/tmp\}\/ham-audit-pr-view\.XXXXXX"\) \|\| exit 1/);
  assert.match(prompt, /HAM_AUDIT_COMMENT_LOOKUP_STDERR=\$\(mktemp "\$\{TMPDIR:-\/tmp\}\/ham-audit-comment-lookup\.XXXXXX"\) \|\| \{/);
  assert.match(prompt, /for HAM_AUDIT_SHA_ATTEMPT in 1 2 3; do[\s\S]*gh pr view https:\/\/github\.com\/acme\/myrepo\/pull\/1234 --json headRefOid --jq '\.headRefOid' 2> "\$HAM_AUDIT_PR_VIEW_STDERR"[\s\S]*ham_audit_comment_transient "\$HAM_AUDIT_PR_VIEW_STDERR"[\s\S]*hammer audit head lookup failed on attempt/);
  assert.match(prompt, /ham_existing_terminal_audit_comment_id\(\) \{[\s\S]*HAM_AUDIT_COMMENTS_JSON=\$\(GH_TOKEN="\$MERGE_AGENT_GH_TOKEN" gh api[\s\S]*repos\/acme\/myrepo\/issues\/1234\/comments[\s\S]*"\$HAM_AUDIT_COMMENT_LOOKUP_STDERR"\) \|\| return 1[\s\S]*contains\(\$marker\)[\s\S]*contains\(\$head\)/);
  assert.match(prompt, /if ! HAM_EXISTING_AUDIT_COMMENT_ID=\$\(ham_existing_terminal_audit_comment_id\); then[\s\S]*hammer audit comment lookup failed on attempt[\s\S]*continue/);
  assert.match(prompt, /GH_TOKEN="\$MERGE_AGENT_GH_TOKEN" gh pr comment https:\/\/github\.com\/acme\/myrepo\/pull\/1234 --body "\$HAM_AUDIT_COMMENT_BODY"/);
  assert.match(prompt, /MERGE_AGENT_GH_TOKEN is required for hammer audit comment identity/);
  assert.doesNotMatch(prompt, /fallbackTokenEnvNames/);
  assert.match(prompt, /HAM-03 conflict: releasing merge lease before local conflict resolution/);
  assert.match(prompt, /re-acquire before the next rebase\/merge attempt/);
  assert.match(prompt, /HAM_MERGE_LEASE_ACQUIRE_EXIT" -eq 70/);
  assert.match(prompt, /parked PR 1234/);
  assert.match(prompt, /AMG-04 hard-blocker: no hammer merge without holding the merge lease/);
  assert.match(prompt, /No hammer merge without holding the merge lease/);
  assert.match(prompt, /No daemon handoff/);
  assert.doesNotMatch(prompt, /trap ham_audit_cleanup_tmp_files EXIT/);
  assert.doesNotMatch(prompt, /ham_audit_cleanup_tmp_files\ntrap - EXIT/);
  assert.match(prompt, /HAM_AUDIT_COMMENT_POST_STDERR=\$\(mktemp "\$\{TMPDIR:-\/tmp\}\/ham-audit-comment-post\.XXXXXX"\) \|\| \{/);
  assert.match(prompt, /gh pr comment https:\/\/github\.com\/acme\/myrepo\/pull\/1234 --body "\$HAM_AUDIT_COMMENT_BODY" 2> "\$HAM_AUDIT_COMMENT_POST_STDERR"/);
  assert.match(prompt, /ham_audit_comment_transient "\$HAM_AUDIT_COMMENT_POST_STDERR"[\s\S]*not retrying/);
});

test('composed prompt documents that branch_protection.required=false does not require the GitHub-plan sentinel', () => {
  const { cfg, dispatchContext, prMetadata } = hammerFixture({
    cfg: {
      branchProtection: {
        required: false,
      },
    },
  });
  const prompt = composeCloserPrompt({
    prUrl: dispatchContext.prUrl,
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    reviewedSha: dispatchContext.reviewedSha,
    riskClass: dispatchContext.riskClass,
    mergeMethod: cfg.mergeMethod,
    requiredGateContext: dispatchContext.requiredGateContext,
    auditPath: '/tmp/audit.json',
    hqRoot: dispatchContext.hqRoot,
    rootDir: dispatchContext.rootDir,
    hqOwnerUser: 'unknown',
    reviewedBy: dispatchContext.reviewedBy,
    reviewer: dispatchContext.reviewer,
    dispatchedAt: dispatchContext.dispatchedAt,
    amaTrailers: 'Eligibility-Reason: branch_protection_requirement_waived',
    templateBody: readFileSync(TEMPLATE_PATH, 'utf8'),
  });
  assert.match(prompt, /structured sentinel below is one\s+# accepted shape/);
  assert.doesNotMatch(prompt, /only that case with a structured sentinel/);
});

// ---------------------------------------------------------------------------
// Helpers: substituteTemplate sanity (defense-in-depth so the
// substitution loop isn't accidentally a noop).
// ---------------------------------------------------------------------------

test('substituteTemplate replaces all occurrences of each placeholder', () => {
  const body = 'a=<<X>> b=<<X>> c=<<Y>>';
  const out = substituteTemplate(body, { X: '1', Y: '2' });
  assert.equal(out, 'a=1 b=1 c=2');
});

test('substituteTemplate leaves unknown placeholders alone', () => {
  const body = 'a=<<KNOWN>> b=<<UNKNOWN>>';
  const out = substituteTemplate(body, { KNOWN: 'k' });
  assert.equal(out, 'a=k b=<<UNKNOWN>>');
});

test('namedAmaNoDispatchReason keeps not-eligible token stable and single-reason', () => {
  assert.equal(
    namedAmaNoDispatchReason('not-eligible', ['blocking-findings-present', 'ci-not-green']),
    'not-eligible:blocking-findings-present',
  );
  assert.equal(namedAmaNoDispatchReason('not-eligible', []), 'not-eligible:unknown');
  assert.equal(namedAmaNoDispatchReason('dispatch-failed'), 'dispatch-failed');
});

// ---------------------------------------------------------------------------
// Helper: dispatch failure surfaces as { dispatched: false, reason: 'dispatch-failed' }
// rather than throwing — so the watcher can fall through to merge-agent.
// ---------------------------------------------------------------------------

test('dispatch failure returns dispatched=false, reason=dispatch-failed (caller falls through)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-failure-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir },
  });
  const exec = buildExecMock({ throwOn: () => true });
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: () => 'stubbed',
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'dispatch-failed');
  assert.equal(result.namedReason, 'dispatch-failed');
  assert.ok(result.error.includes('simulated dispatch failure'));
  assert.equal(result.releasedPendingLease, true);
  assert.equal(
    readAmaCloserLease(rootDir, {
      repo: dispatchContext.repo,
      prNumber: prMetadata.prNumber,
      headSha: dispatchContext.reviewedSha,
    }),
    null,
    'a completed dispatch refusal must release the pending lease for the next tick',
  );
});

test('branch-holder provision failures use bounded cleanup-debt counter outside redispatch budget', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-branch-holder-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  const branchHolderError = [
    '[hq] worker provision failed:',
    "refusing grace-waived git worktree holder drop for branch 'codex-oap-05/OAP-05': holder has unrecovered local state or could not be safely inspected: /tmp/hq/workers/codex-oap-05/agent-os",
    "fatal: 'codex-oap-05/OAP-05' is already used by worktree at '/tmp/hq/workers/codex-oap-05/agent-os'",
  ].join('\n');
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatch-failed',
    retryCount: 2,
    dispatchId: null,
    launchRequestId: null,
    lastError: branchHolderError,
  });

  let execCalled = false;
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: async () => {
      execCalled = true;
      const err = new Error('provision failed');
      err.stderr = branchHolderError;
      throw err;
    },
    readTemplateImpl: () => 'stubbed',
  });

  assert.equal(execCalled, true, 'branch-holder blocked records must retry instead of exhausting');
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'dispatch-branch-holder-blocked');
  assert.equal(result.skipMergeAgent, true);
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.state, 'dispatch-blocked-branch-holder');
  assert.equal(record.retryCount, 2, 'branch-holder provision blockers are cleanup debt, not consumed launch attempts');
  assert.equal(record.branchHolderBlockCount, 1);
  assert.equal(record.lastObservedStatus, 'blocked');
});

test('branch-holder provision detection tolerates generic worktree collision wording', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-branch-holder-generic-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  const branchHolderError = [
    '[hq] worker provision failed: branch-holder-blocked',
    "fatal: branch 'codex-oap-05/OAP-05' is already checked out in worktree '/tmp/hq/workers/codex-oap-05/agent-os'",
  ].join('\n');
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatch-failed',
    retryCount: 2,
    dispatchId: null,
    launchRequestId: null,
    lastError: branchHolderError,
  });

  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: async () => {
      const err = new Error('provision failed');
      err.stderr = branchHolderError;
      throw err;
    },
    readTemplateImpl: () => 'stubbed',
  });

  assert.equal(result.reason, 'dispatch-branch-holder-blocked');
  assert.equal(result.skipMergeAgent, true);
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.retryCount, 2);
  assert.equal(record.branchHolderBlockCount, 1);
});

test('stale own hammer worktree cleanup does not exhaust branch-holder budget', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-stale-own-worktree-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer' },
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  const staleOwnWorktreeError = [
    "[hq] error: targeted worktree fallback could not find admin entry for '/tmp/hq/workers/hammer-ama-pr-1234/agent-os' in '/tmp/hq/repos/agent-os'",
    "[hq] warning: provision cleanup for 'hammer-ama-pr-1234' was incomplete; continuing after releasing worktree mutation lock",
  ].join('\n');
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatch-branch-holder-block-exhausted',
    retryCount: 0,
    branchHolderBlockCount: 3,
    dispatchId: null,
    launchRequestId: null,
    lastError: staleOwnWorktreeError,
  });

  let execCalled = false;
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: async () => {
      execCalled = true;
      return { stdout: '{"dispatchId":"dispatch-reclaimed","launchRequestId":"lrq_reclaimed"}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
  });

  assert.equal(execCalled, true, 'stale own hammer cleanup debt must not permanently block redispatch');
  assert.equal(result.dispatched, true);
  assert.equal(result.dispatchId, 'dispatch-reclaimed');
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.state, 'dispatched');
  assert.equal(record.branchHolderBlockCount, 0);
});

test('stale own worktree cleanup lines do not mask later branch-holder blockers', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-stale-own-worktree-mixed-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer' },
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  const mixedError = [
    "[hq] error: targeted worktree fallback could not find admin entry for '/tmp/hq/workers/hammer-ama-pr-1234/agent-os' in '/tmp/hq/repos/agent-os'",
    "[hq] warning: provision cleanup for 'hammer-ama-pr-1234' was incomplete; continuing after releasing worktree mutation lock",
    '[hq] worker provision failed: branch-holder-collision',
    "fatal: branch 'codex-oap-05/OAP-05' is already checked out in worktree '/tmp/hq/workers/codex-oap-05/agent-os'",
  ].join('\n');

  let execCalled = false;
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: async () => {
      execCalled = true;
      const err = new Error('provision failed');
      err.stderr = mixedError;
      throw err;
    },
    readTemplateImpl: () => 'stubbed',
  });

  assert.equal(execCalled, true);
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'dispatch-branch-holder-blocked');
  assert.equal(result.skipMergeAgent, true);
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.state, 'dispatch-blocked-branch-holder');
  assert.equal(record.branchHolderBlockCount, 1);
});

test('same-PR hammer branch-holder collision tears down prior attempt and retries provision once', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-same-pr-holder-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const hqRoot = join(rootDir, 'hq');
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer' },
    dispatchContext: { rootDir, hqRoot },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  const holderPath = join(hqRoot, 'workers', 'hammer-ama-pr-1234-first', 'agent-os');
  const samePrHolderError = [
    "[hq] error: targeted worktree fallback could not find admin entry for '" + holderPath + "' in '" + join(hqRoot, 'repos', 'agent-os') + "'",
    "[hq] warning: provision cleanup for 'hammer-ama-pr-1234-first' was incomplete; continuing after releasing worktree mutation lock",
    '[hq] worker provision failed: branch-holder-collision',
    "fatal: branch 'codex/feature' is already checked out in worktree '" + holderPath + "'",
  ].join('\n');

  const calls = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === 'dispatch' && calls.filter((call) => call.args[0] === 'dispatch').length === 1) {
        const err = new Error('provision failed');
        err.stderr = samePrHolderError;
        throw err;
      }
      return { stdout: '{"dispatchId":"dispatch_after_reap","launchRequestId":"lrq_after_reap"}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.dispatchId, 'dispatch_after_reap');
  assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
    ['dispatch', '--worker-class', 'hammer'],
    ['-C', join(hqRoot, 'repos', 'agent-os'), 'worktree'],
    ['worker', 'tear-down', 'hammer-ama-pr-1234-first'],
    ['dispatch', '--worker-class', 'hammer'],
  ]);
  assert.equal(calls[1].args.includes(holderPath), true);
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.state, 'dispatched');
  assert.equal(record.branchHolderBlockCount, 0);
});

test('same-PR hammer holder path extraction tolerates spaces in hq root', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama dispatch same-pr holder spaces '));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const hqRoot = join(rootDir, 'hq root with spaces');
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer' },
    dispatchContext: { rootDir, hqRoot },
  });
  const holderPath = join(hqRoot, 'workers', 'hammer-ama-pr-1234-first', 'agent-os');
  const samePrHolderError = [
    "[hq] error: targeted worktree fallback could not find admin entry for '" + holderPath + "' in '" + join(hqRoot, 'repos', 'agent-os') + "'",
    "[hq] warning: provision cleanup for 'hammer-ama-pr-1234-first' was incomplete; continuing after releasing worktree mutation lock",
    '[hq] worker provision failed: branch-holder-collision',
    "fatal: branch 'codex/feature' is already checked out in worktree '" + holderPath + "'",
  ].join('\n');

  const calls = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === 'dispatch' && calls.filter((call) => call.args[0] === 'dispatch').length === 1) {
        const err = new Error('provision failed');
        err.stderr = samePrHolderError;
        throw err;
      }
      return { stdout: '{"dispatchId":"dispatch_after_space_reap","launchRequestId":"lrq_after_space_reap"}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
  });

  assert.equal(result.dispatched, true);
  assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
    ['dispatch', '--worker-class', 'hammer'],
    ['-C', join(hqRoot, 'repos', 'agent-os'), 'worktree'],
    ['worker', 'tear-down', 'hammer-ama-pr-1234-first'],
    ['dispatch', '--worker-class', 'hammer'],
  ]);
  assert.equal(calls[1].args.includes(holderPath), true);
});

test('same-PR hammer holder teardown does not retry when a real teardown step fails', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-same-pr-holder-partial-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const hqRoot = join(rootDir, 'hq');
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer' },
    dispatchContext: { rootDir, hqRoot },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  const holderPath = join(hqRoot, 'workers', 'hammer-ama-pr-1234-first', 'agent-os');
  const samePrHolderError = [
    "[hq] error: targeted worktree fallback could not find admin entry for '" + holderPath + "' in '" + join(hqRoot, 'repos', 'agent-os') + "'",
    "[hq] warning: provision cleanup for 'hammer-ama-pr-1234-first' was incomplete; continuing after releasing worktree mutation lock",
    '[hq] worker provision failed: branch-holder-collision',
    "fatal: branch 'codex/feature' is already checked out in worktree '" + holderPath + "'",
  ].join('\n');

  const calls = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === 'dispatch') {
        const err = new Error('provision failed');
        err.stderr = samePrHolderError;
        throw err;
      }
      if (args[0] === 'worker' && args[1] === 'tear-down') {
        const err = new Error('tear-down failed');
        err.stderr = 'worker tear-down failed with unrecovered local state';
        throw err;
      }
      return { stdout: '', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'dispatch-branch-holder-blocked');
  assert.equal(calls.filter((call) => call.args[0] === 'dispatch').length, 1);
  assert.equal(
    calls.some((call) => call.cmd === 'git' && call.args.includes('remove') && call.args.includes(holderPath)),
    true,
  );
  assert.equal(
    calls.some((call) => call.cmd === dispatchContext.hqPath && call.args[0] === 'worker' && call.args[1] === 'tear-down'),
    true,
  );
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.state, 'dispatch-blocked-branch-holder');
  assert.equal(record.branchHolderBlockCount, 1);
});

test('non-branch dispatch failures preserve branch-holder lifetime count', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-branch-holder-lifetime-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatch-failed',
    retryCount: 0,
    branchHolderBlockCount: 2,
    dispatchId: null,
    launchRequestId: null,
    lastError: 'previous transient dispatch failure',
  });

  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: async () => {
      throw new Error('network timeout while dispatching');
    },
    readTemplateImpl: () => 'stubbed',
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'dispatch-failed');
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.branchHolderBlockCount, 2);
});

test('alternating dispatch failures still exhaust branch-holder lifetime budget', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-branch-holder-alternating-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  const branchHolderError = [
    '[hq] worker provision failed: branch-holder-blocked',
    "fatal: branch 'codex-oap-05/OAP-05' is already checked out in worktree '/tmp/hq/workers/codex-oap-05/agent-os'",
  ].join('\n');
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatch-failed',
    retryCount: 1,
    branchHolderBlockCount: 2,
    dispatchId: null,
    launchRequestId: null,
    lastError: 'intervening non-branch dispatch failure',
  });

  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: async () => {
      const err = new Error('provision failed');
      err.stderr = branchHolderError;
      throw err;
    },
    readTemplateImpl: () => 'stubbed',
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'dispatch-branch-holder-block-exhausted');
  assert.equal(result.skipMergeAgent, true);
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.state, 'dispatch-branch-holder-block-exhausted');
  assert.equal(record.branchHolderBlockCount, 3);
});

test('branch-holder provision failures stop retrying after bounded cleanup-debt attempts', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-branch-holder-exhausted-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  const branchHolderError = [
    '[hq] worker provision failed:',
    "refusing grace-waived git worktree holder drop for branch 'codex-oap-05/OAP-05': holder has unrecovered local state or could not be safely inspected: /tmp/hq/workers/codex-oap-05/agent-os",
    "fatal: 'codex-oap-05/OAP-05' is already used by worktree at '/tmp/hq/workers/codex-oap-05/agent-os'",
  ].join('\n');
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatch-branch-holder-block-exhausted',
    retryCount: 2,
    branchHolderBlockCount: 3,
    dispatchId: null,
    launchRequestId: null,
    lastError: branchHolderError,
  });

  let execCalled = false;
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: async () => {
      execCalled = true;
      throw new Error('must not dispatch after exhausted branch-holder block');
    },
    readTemplateImpl: () => 'stubbed',
  });

  assert.equal(execCalled, false, 'exhausted branch-holder blockers must not retry every tick');
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'dispatch-branch-holder-block-exhausted');
  assert.equal(result.skipMergeAgent, true);
});

test('dispatch parses machine-readable JSON stdout and records the launch request id', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-json-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir },
  });
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: async () => ({
      stdout: '{"dispatchId":"dispatch-321","launchRequestId":"lrq_321"}',
      stderr: '',
    }),
    readTemplateImpl: () => 'stubbed',
  });
  assert.equal(result.dispatched, true);
  assert.equal(result.dispatchId, 'dispatch-321');
  assert.equal(result.launchRequestId, 'lrq_321');
});

test('existing AMA closer dispatch suppresses a duplicate launch for the same head (AMA-07 lease)', async (t) => {
  // AMA-07 — the closer lease is the upstream dedup. Once a launch is
  // in-flight for `(repo, prNumber, headSha)`, the next tick sees
  // `lease-held` BEFORE the AMA-03 dispatch-record / hq-status probe
  // path. The lease's `linkSync` is atomic at the OS level, so two
  // concurrent watchers also can't both pass this gate.
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-existing-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir },
  });
  const calls = [];
  const execImpl = async (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'dispatch' && args[1] === 'status') {
      return { stdout: '{"status":"running"}', stderr: '' };
    }
    return { stdout: '{"dispatchId":"dispatch-123","launchRequestId":"lrq_123"}', stderr: '' };
  };

  const first = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: execImpl,
    readTemplateImpl: () => 'stubbed',
  });
  assert.equal(first.dispatched, true);
  assert.equal(first.launchRequestId, 'lrq_123');

  const second = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: {
      ...dispatchContext,
      dispatchedAt: '2026-06-11T20:01:00Z',
    },
    execFileImpl: execImpl,
    readTemplateImpl: () => 'stubbed',
  });
  assert.equal(second.dispatched, false);
  assert.equal(second.reason, 'existing-dispatch-running');
  assert.equal(second.skipMergeAgent, true);
  // Once a dispatch record exists, the duplicate-dispatch guard is
  // surfaced through that durable record: the watcher gets the active
  // launch request id back and suppresses merge-agent fallback.
  assert.equal(second.launchRequestId, 'lrq_123');
  const hqStatusProbes = calls.filter((args) => args[0] === 'dispatch' && args[1] === 'status');
  assert.equal(hqStatusProbes.length, 1);
});

test('SSG-06: failed prior closer dispatch releases ownership and re-dispatches', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-ssg06-failed-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const ledgerDb = join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb, { runtimeSessions: [], workerRuns: [] });
  insertWorkerRun(ledgerDb, {
    runId: 'wr_failed',
    launchRequestId: 'lrq_failed',
    input: 10,
    output: 2,
    cost: 0.01,
    status: 'failed',
  });

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: {
      rootDir,
      ledgerTarget: { backend: 'sqlite', path: ledgerDb },
      closerTokenRollupPollDelaysMs: [],
    },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_failed',
    launchRequestId: 'lrq_failed',
    lastObservedStatus: 'starting',
    lastObservedAt: '2026-06-20T10:00:00Z',
    lastError: null,
  });
  acquireAmaCloserLease({
    rootDir,
    ...identity,
    watcherPid: 1001,
    now: '2026-06-20T10:00:00Z',
  });
  updateAmaCloserLease({
    rootDir,
    ...identity,
    status: 'dispatched',
    lrqId: 'lrq_failed',
    now: '2026-06-20T10:00:01Z',
  });

  const calls = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl: async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: '{"status":"failed"}', stderr: '' };
      }
      return { stdout: '{"dispatchId":"dispatch_retry","launchRequestId":"lrq_retry"}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.launchRequestId, 'lrq_retry');
  const dispatchLaunches = calls.filter((args) => args[0] === 'dispatch' && args[1] !== 'status');
  assert.equal(dispatchLaunches.length, 1, 'failed prior dispatch must not retain ownership');
});

test('SSG-06: live in-flight closer dispatch is the only retained ownership path', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-ssg06-live-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_running',
    launchRequestId: 'lrq_running',
    lastObservedStatus: 'starting',
    lastObservedAt: '2026-06-20T10:00:00Z',
    lastError: null,
  });

  let launchCalled = false;
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl: async (_cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: '{"status":"running"}', stderr: '' };
      }
      launchCalled = true;
      return { stdout: '{"dispatchId":"dispatch_new","launchRequestId":"lrq_new"}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'existing-dispatch-running');
  assert.equal(launchCalled, false, 'live in-flight dispatch must be retained');
});

test('SSG-06: active hq status retains ownership despite stale failed audit', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-ssg06-active-audit-race-'));
  const hqRoot = mkdtempSync(join(tmpdir(), 'ama-dispatch-ssg06-active-audit-hq-'));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(hqRoot, { recursive: true, force: true });
  });

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir, hqRoot },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_running',
    launchRequestId: 'lrq_running',
    lastObservedStatus: 'starting',
    lastObservedAt: '2026-06-20T10:00:00Z',
    lastError: null,
  });
  writeAmaAuditEntry({
    hqRoot,
    repo: identity.repo,
    prNumber: identity.prNumber,
    headSha: identity.headSha,
    now: '2026-06-20T10:01:00Z',
    attempt: { outcome: 'failed-without-merge' },
    metadata: {},
  });

  let launchCalled = false;
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, hqRoot, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl: async (_cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: '{"status":"running"}', stderr: '' };
      }
      launchCalled = true;
      return { stdout: '{"dispatchId":"dispatch_new","launchRequestId":"lrq_new"}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'existing-dispatch-running');
  assert.equal(launchCalled, false, 'stale failed audit must not override active hq status');
});

test('SSG-06: ledger merged signal resolves closer ownership as done', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-ssg06-merged-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir },
  });

  const execCalls = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl: async (_cmd, args) => {
      execCalls.push(args);
      return { stdout: '{"dispatchId":"dispatch_unexpected","launchRequestId":"lrq_unexpected"}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionSignalForPrImpl: () => ({
      ok: true,
      row: {
        completion_id: 'bcmp_merged',
        repo: dispatchContext.repo,
        pr_number: prMetadata.prNumber,
        head_sha: 'f'.repeat(40),
        signal_kind: 'merged',
      },
    }),
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'merged-signal-present');
  assert.equal(result.namedReason, 'merged-signal-present');
  assert.equal(result.mergedSignal.completion_id, 'bcmp_merged');
  assert.equal(result.mergedSignalProducerHeadSha, 'f'.repeat(40));
  assert.equal(result.mergedSignalHeadShaMatchesReviewed, false);
  // The merged signal is authoritative: no NEW dispatch or status probe is made.
  // (MSM-04 — the merged hammer worker is still torn down, which is a `hq worker
  // tear-down`, not a `dispatch`/`dispatch status` call.)
  assert.equal(
    execCalls.filter((args) => args[0] === 'dispatch').length,
    0,
    'merged signal is authoritative; no re-dispatch or status probe needed',
  );
});

test('merged hammer closer tears down deterministic worker after merged signal', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-merged-cleanup-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer' },
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    workerClass: 'hammer',
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_hammer_done',
    launchRequestId: 'lrq_hammer_done',
    lastObservedStatus: 'succeeded',
    lastObservedAt: '2026-06-20T10:02:00Z',
    lastError: null,
  });

  const calls = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '{}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionSignalForPrImpl: () => ({
      ok: true,
      row: {
        completion_id: 'bcmp_hammer_done',
        repo: dispatchContext.repo,
        pr_number: prMetadata.prNumber,
        head_sha: dispatchContext.reviewedSha,
        signal_kind: 'merged',
      },
    }),
  });

  assert.equal(result.reason, 'merged-signal-present');
  assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
    ['worker', 'tear-down', 'hammer-ama-pr-1234'],
  ]);
  assert.ok(calls[0].args.includes('--force'));
  assert.ok(calls[0].args.includes('--root'));
  assert.equal(result.hammerCleanup.ok, true);
});

test('merged hammer closer retries transient worker teardown before marking done', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-merged-cleanup-retry-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer' },
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    workerClass: 'hammer',
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_hammer_done',
    launchRequestId: 'lrq_hammer_done',
    lastObservedStatus: 'succeeded',
    lastObservedAt: '2026-06-20T10:02:00Z',
    lastError: null,
  });

  const calls = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === 'worker' && args[1] === 'tear-down' && calls.length < 3) {
        const err = new Error('transient launchd read failed');
        err.code = 'EIO';
        err.stderr = 'EIO: resource temporarily unavailable';
        throw err;
      }
      return { stdout: '{}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionSignalForPrImpl: () => ({
      ok: true,
      row: {
        completion_id: 'bcmp_hammer_done',
        repo: dispatchContext.repo,
        pr_number: prMetadata.prNumber,
        head_sha: dispatchContext.reviewedSha,
        signal_kind: 'merged',
      },
    }),
  });

  assert.equal(result.reason, 'merged-signal-present');
  assert.equal(result.hammerCleanup.ok, true);
  assert.equal(result.hammerCleanup.attempts, 3);
  assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
    ['worker', 'tear-down', 'hammer-ama-pr-1234'],
    ['worker', 'tear-down', 'hammer-ama-pr-1234'],
    ['worker', 'tear-down', 'hammer-ama-pr-1234'],
  ]);
});

test('merged hammer closer treats absent worker teardown as already clean', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-merged-cleanup-absent-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer' },
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    workerClass: 'hammer',
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_hammer_done',
    launchRequestId: 'lrq_hammer_done',
    lastObservedStatus: 'succeeded',
    lastObservedAt: '2026-06-20T10:02:00Z',
    lastError: null,
  });

  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl: async (_cmd, args) => {
      if (args[0] === 'worker' && args[1] === 'tear-down') {
        const err = new Error('Bad request.\nCould not find service "hammer-ama-pr-1234" in domain');
        err.stderr = 'Bad request.\nCould not find service "hammer-ama-pr-1234" in domain';
        throw err;
      }
      return { stdout: '{}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionSignalForPrImpl: () => ({
      ok: true,
      row: {
        completion_id: 'bcmp_hammer_done',
        repo: dispatchContext.repo,
        pr_number: prMetadata.prNumber,
        head_sha: dispatchContext.reviewedSha,
        signal_kind: 'merged',
      },
    }),
  });

  assert.equal(result.reason, 'merged-signal-present');
  assert.equal(result.hammerCleanup.ok, true);
  assert.equal(result.hammerCleanup.alreadyAbsent, true);
});

test('merged hammer closer aborts when worker teardown fails', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-merged-cleanup-fail-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer' },
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    workerClass: 'hammer',
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_hammer_done',
    launchRequestId: 'lrq_hammer_done',
    lastObservedStatus: 'succeeded',
    lastObservedAt: '2026-06-20T10:02:00Z',
    lastError: null,
  });

  await assert.rejects(
    () => maybeDispatchAmaCloser({
      reviewState,
      prMetadata,
      cfg,
      dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
      execFileImpl: async (_cmd, args) => {
        if (args[0] === 'worker' && args[1] === 'tear-down') {
          const err = new Error('fatal teardown failure');
          err.stderr = 'permission denied while tearing down worker';
          throw err;
        }
        return { stdout: '{}', stderr: '' };
      },
      readTemplateImpl: () => 'stubbed',
      readBuildCompletionSignalForPrImpl: () => ({
        ok: true,
        row: {
          completion_id: 'bcmp_hammer_done',
          repo: dispatchContext.repo,
          pr_number: prMetadata.prNumber,
          head_sha: dispatchContext.reviewedSha,
          signal_kind: 'merged',
        },
      }),
    }),
    /AMA hammer worker teardown failed for hammer-ama-pr-1234/,
  );
});

test('CAP-05: terminal closer records worker_run token usage after async ledger rollup', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-cap05-rollup-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const ledgerDb = join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb, {
    runtimeSessions: [],
    workerRuns: [{
      run_id: 'wr_delayed',
      launch_request_id: 'lrq_delayed',
      session_id: null,
      status: 'failed',
      token_usage_input: null,
      token_usage_output: null,
      token_usage_cost_usd: null,
      token_usage_source: null,
      started_at: '2026-06-20T10:00:00.000Z',
      ended_at: '2026-06-20T10:02:00.000Z',
      updated_at: '2026-06-20T10:02:00.000Z',
    }],
  });

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: {
      rootDir,
      ledgerTarget: { backend: 'sqlite', path: ledgerDb },
      closerTokenRollupPollDelaysMs: [10, 10],
    },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_delayed',
    launchRequestId: 'lrq_delayed',
    lastObservedStatus: 'starting',
    lastObservedAt: '2026-06-20T10:00:00Z',
    lastError: null,
  });
  acquireAmaCloserLease({
    rootDir,
    ...identity,
    watcherPid: 1001,
    now: '2026-06-20T10:00:00Z',
  });
  updateAmaCloserLease({
    rootDir,
    ...identity,
    status: 'dispatched',
    lrqId: 'lrq_delayed',
    now: '2026-06-20T10:00:01Z',
  });

  setTimeout(() => {
    const db = new Database(ledgerDb);
    db.prepare(
      `UPDATE worker_runs
          SET token_usage_input = 321,
              token_usage_output = 45,
              token_usage_cost_usd = 0.42,
              token_usage_source = 'session-ledger',
              updated_at = '2026-06-20T10:03:00.000Z'
        WHERE launch_request_id = 'lrq_delayed'`
    ).run();
    db.close();
  }, 5);

  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl: async (_cmd, args) => {
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: '{"status":"failed"}', stderr: '' };
      }
      return { stdout: '{"dispatchId":"dispatch_retry","launchRequestId":"lrq_retry"}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
  });

  assert.equal(result.dispatched, true);
  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare(
      `SELECT pass_kind, attempt_number, worker_run_id, token_input, token_output, token_total, token_cost_usd, token_source
         FROM reviewer_passes
        WHERE repo = ? AND pr_number = ? AND pass_kind = 'closer'`
    ).get(dispatchContext.repo, prMetadata.prNumber);
    assert.equal(row.pass_kind, 'closer');
    assert.equal(row.attempt_number, 1);
    assert.equal(row.worker_run_id, 'wr_delayed');
    assert.equal(row.token_input, 321);
    assert.equal(row.token_output, 45);
    assert.equal(row.token_total, null, 'must not persist a zero placeholder before rollup lands');
    assert.equal(row.token_cost_usd, 0.42);
    assert.equal(row.token_source, 'session-ledger');
  } finally {
    db.close();
  }
});

test('CAP-05: missing closer token rollup records empty usage and advances retry', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-cap05-rollup-missing-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const ledgerDb = join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb, {
    runtimeSessions: [],
    workerRuns: [{
      run_id: 'wr_missing_rollup',
      launch_request_id: 'lrq_missing_rollup',
      session_id: null,
      status: 'failed',
      token_usage_input: null,
      token_usage_output: null,
      token_usage_cost_usd: null,
      token_usage_source: null,
      started_at: '2026-06-20T10:00:00.000Z',
      ended_at: '2026-06-20T10:02:00.000Z',
      updated_at: '2026-06-20T10:02:00.000Z',
    }],
  });

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: {
      rootDir,
      ledgerTarget: { backend: 'sqlite', path: ledgerDb },
      closerTokenRollupPollDelaysMs: [],
    },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_missing_rollup',
    launchRequestId: 'lrq_missing_rollup',
    lastObservedStatus: 'starting',
    lastObservedAt: '2026-06-20T10:00:00Z',
    lastError: null,
  });

  const calls = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl: async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: '{"status":"failed"}', stderr: '' };
      }
      return { stdout: '{"dispatchId":"dispatch_retry","launchRequestId":"lrq_retry"}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.dispatchId, 'dispatch_retry');
  assert.equal(result.launchRequestId, 'lrq_retry');
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['dispatch', 'status'], ['dispatch', '--worker-class']]);
  const dispatchRecord = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(dispatchRecord.retryCount, 2);
  assert.equal(dispatchRecord.dispatchId, 'dispatch_retry');
  const db = openReviewStateDb(rootDir);
  try {
    const row = db.prepare(
      `SELECT attempt_number, status, worker_run_id, token_input, token_output,
              token_cache_read, token_cache_write, token_total, token_cost_usd,
              token_source, metadata_json
         FROM reviewer_passes
        WHERE repo = ? AND pr_number = ? AND pass_kind = 'closer'`
    ).get(dispatchContext.repo, prMetadata.prNumber);
    assert.equal(row.attempt_number, 1);
    assert.equal(row.status, 'failed');
    assert.equal(row.worker_run_id, null);
    assert.equal(row.token_input, null);
    assert.equal(row.token_output, null);
    assert.equal(row.token_cache_read, null);
    assert.equal(row.token_cache_write, null);
    assert.equal(row.token_total, null);
    assert.equal(row.token_cost_usd, null);
    assert.equal(row.token_source, null);
    assert.equal(JSON.parse(row.metadata_json).tokenUsageUnavailable, true);
  } finally {
    db.close();
  }
});

test('CAP-05: repeated closer token write for same attempt is idempotent', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-cap05-token-idempotent-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const ledgerDb = join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb, { runtimeSessions: [], workerRuns: [] });
  insertWorkerRun(ledgerDb, {
    runId: 'wr_idempotent',
    launchRequestId: 'lrq_idempotent',
    input: 111,
    output: 22,
    cost: 0.13,
    status: 'succeeded',
  });

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: {
      rootDir,
      ledgerTarget: { backend: 'sqlite', path: ledgerDb },
      closerTokenRollupPollDelaysMs: [],
    },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    workerClass: 'codex',
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_idempotent',
    launchRequestId: 'lrq_idempotent',
    lastObservedStatus: 'succeeded',
    lastObservedAt: '2026-06-20T10:02:00Z',
    lastError: null,
  });
  const mergedSignal = {
    ok: true,
    row: {
      completion_id: 'bcmp_idempotent',
      repo: dispatchContext.repo,
      pr_number: prMetadata.prNumber,
      head_sha: dispatchContext.reviewedSha,
      signal_kind: 'merged',
    },
  };
  const args = {
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl: async () => ({ stdout: '{}', stderr: '' }),
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionSignalForPrImpl: () => mergedSignal,
  };

  const first = await maybeDispatchAmaCloser(args);
  const second = await maybeDispatchAmaCloser(args);
  assert.equal(first.reason, 'merged-signal-present');
  assert.equal(second.reason, 'merged-signal-present');

  const db = openReviewStateDb(rootDir);
  try {
    const rows = db.prepare(
      `SELECT attempt_number, worker_run_id, token_input, token_output, token_cost_usd
         FROM reviewer_passes
        WHERE repo = ? AND pr_number = ? AND pass_kind = 'closer'`
    ).all(dispatchContext.repo, prMetadata.prNumber);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      attempt_number: 1,
      worker_run_id: 'wr_idempotent',
      token_input: 111,
      token_output: 22,
      token_cost_usd: 0.13,
    });
  } finally {
    db.close();
  }
});

test('CAP-05: redispatched closer rows accumulate under tokens --by-pr', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-cap05-redispatch-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const ledgerDb = join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb, { runtimeSessions: [], workerRuns: [] });

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: {
      rootDir,
      ledgerTarget: { backend: 'sqlite', path: ledgerDb },
      closerTokenRollupPollDelaysMs: [],
    },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  insertWorkerRun(ledgerDb, {
    runId: 'wr_close_1',
    launchRequestId: 'lrq_close_1',
    input: 100,
    output: 10,
    cost: 0.11,
    status: 'failed',
  });
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_close_1',
    launchRequestId: 'lrq_close_1',
    lastObservedStatus: 'starting',
    lastObservedAt: '2026-06-20T10:00:00Z',
    lastError: null,
  });
  acquireAmaCloserLease({
    rootDir,
    ...identity,
    watcherPid: 1001,
    now: '2026-06-20T10:00:00Z',
  });
  updateAmaCloserLease({
    rootDir,
    ...identity,
    status: 'dispatched',
    lrqId: 'lrq_close_1',
    now: '2026-06-20T10:00:01Z',
  });

  let launchCount = 1;
  const execFileImpl = async (_cmd, args) => {
    if (args[0] === 'dispatch' && args[1] === 'status') {
      return { stdout: '{"status":"failed"}', stderr: '' };
    }
    // MSM-04 — the surviving dispatch is the hammer, whose reconciliation tears
    // down the prior hammer worker (`hq worker tear-down`) before a redispatch.
    // That teardown is not a launch, so it must not advance the launch counter.
    if (args[0] !== 'dispatch') {
      return { stdout: '{}', stderr: '' };
    }
    launchCount += 1;
    return {
      stdout: JSON.stringify({
        dispatchId: `dispatch_close_${launchCount}`,
        launchRequestId: `lrq_close_${launchCount}`,
      }),
      stderr: '',
    };
  };

  const second = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl,
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
  });
  assert.equal(second.launchRequestId, 'lrq_close_2');

  insertWorkerRun(ledgerDb, {
    runId: 'wr_close_2',
    launchRequestId: 'lrq_close_2',
    input: 200,
    output: 20,
    cost: 0.22,
    status: 'failed',
  });
  const third = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:10:00Z' },
    execFileImpl,
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
  });
  assert.equal(third.launchRequestId, 'lrq_close_3');

  insertWorkerRun(ledgerDb, {
    runId: 'wr_close_3',
    launchRequestId: 'lrq_close_3',
    input: 300,
    output: 30,
    cost: 0.33,
    status: 'succeeded',
  });
  const merged = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:15:00Z' },
    execFileImpl,
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionSignalForPrImpl: () => ({
      ok: true,
      row: {
        completion_id: 'bcmp_close_3',
        repo: dispatchContext.repo,
        pr_number: prMetadata.prNumber,
        head_sha: dispatchContext.reviewedSha,
        signal_kind: 'merged',
      },
    }),
  });
  assert.equal(merged.reason, 'merged-signal-present');

  const db = openReviewStateDb(rootDir);
  try {
    const rows = db.prepare(
      `SELECT attempt_number, pass_kind, worker_run_id, token_input, token_output, token_cost_usd
         FROM reviewer_passes
        WHERE repo = ? AND pr_number = ? AND pass_kind = 'closer'
        ORDER BY attempt_number`
    ).all(dispatchContext.repo, prMetadata.prNumber);
    assert.deepEqual(rows.map((row) => row.attempt_number), [1, 2, 3]);
    assert.deepEqual(rows.map((row) => row.worker_run_id), ['wr_close_1', 'wr_close_2', 'wr_close_3']);
    assert.deepEqual(rows.map((row) => row.token_input + row.token_output), [110, 220, 330]);
  } finally {
    db.close();
  }

  const out = { value: '', write(chunk) { this.value += chunk; } };
  const err = { value: '', write(chunk) { this.value += chunk; } };
  const code = tokensMain(['--root-dir', rootDir, '--by-pr'], { stdout: out, stderr: err });
  assert.equal(code, 0, err.value);
  assert.match(out.value, /acme\/myrepo#1234/);
  assert.match(out.value, /\b3\b/);
  assert.match(out.value, /\b660\b/);
  // MSM-04 — the redispatched merge worker is the hammer, so its passes attribute
  // to `hammer`; the initial `codex` pass still accrues under `codex`. The per-PR
  // total (660 / $0.66 across the 3 rows) is unchanged.
  assert.match(out.value, /hammer:550\/\$0\.55/);
  assert.match(out.value, /codex:110\/\$0\.11/);
});

test('terminal failed hammer closer tears down stale worker before redispatch', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-terminal-cleanup-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer' },
    dispatchContext: {
      rootDir,
      closerTokenRollupPollDelaysMs: [],
    },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    workerClass: 'hammer',
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_hammer_failed',
    launchRequestId: 'lrq_hammer_failed',
    lastObservedStatus: 'starting',
    lastObservedAt: '2026-06-20T10:00:00Z',
    lastError: null,
  });

  const calls = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: '{"status":"failed"}', stderr: '' };
      }
      if (args[0] === 'worker' && args[1] === 'tear-down') {
        return { stdout: '{}', stderr: '' };
      }
      return { stdout: '{"dispatchId":"dispatch_hammer_new","launchRequestId":"lrq_hammer_new"}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
  });

  assert.equal(result.launchRequestId, 'lrq_hammer_new');
  assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
    ['dispatch', 'status', 'lrq_hammer_failed'],
    ['worker', 'tear-down', 'hammer-ama-pr-1234'],
    ['dispatch', '--worker-class', 'hammer'],
  ]);
});

test('terminal failed hammer closer aborts redispatch when worker teardown fails', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-terminal-cleanup-fail-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer' },
    dispatchContext: {
      rootDir,
      closerTokenRollupPollDelaysMs: [],
    },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    workerClass: 'hammer',
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_hammer_failed',
    launchRequestId: 'lrq_hammer_failed',
    lastObservedStatus: 'starting',
    lastObservedAt: '2026-06-20T10:00:00Z',
    lastError: null,
  });

  const calls = [];
  await assert.rejects(
    () => maybeDispatchAmaCloser({
      reviewState,
      prMetadata,
      cfg,
      dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
      execFileImpl: async (cmd, args) => {
        calls.push({ cmd, args });
        if (args[0] === 'dispatch' && args[1] === 'status') {
          return { stdout: '{"status":"failed"}', stderr: '' };
        }
        if (args[0] === 'worker' && args[1] === 'tear-down') {
          const err = new Error('fatal teardown failure');
          err.stderr = 'permission denied while tearing down worker';
          throw err;
        }
        return { stdout: '{"dispatchId":"dispatch_hammer_new","launchRequestId":"lrq_hammer_new"}', stderr: '' };
      },
      readTemplateImpl: () => 'stubbed',
      readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    }),
    /AMA hammer worker teardown failed for hammer-ama-pr-1234/,
  );

  assert.deepEqual(calls.map((call) => call.args.slice(0, 3)), [
    ['dispatch', 'status', 'lrq_hammer_failed'],
    ['worker', 'tear-down', 'hammer-ama-pr-1234'],
  ]);
});

test('terminal failed hammer closer records tokens only after teardown succeeds across polls', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-terminal-token-retry-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const ledgerDb = join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb, { runtimeSessions: [], workerRuns: [] });
  insertWorkerRun(ledgerDb, {
    runId: 'wr_hammer_failed',
    launchRequestId: 'lrq_hammer_failed',
    input: 123,
    output: 45,
    cost: 0.17,
    status: 'failed',
  });

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer' },
    dispatchContext: {
      rootDir,
      ledgerTarget: { backend: 'sqlite', path: ledgerDb },
      closerTokenRollupPollDelaysMs: [],
    },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    workerClass: 'hammer',
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_hammer_failed',
    launchRequestId: 'lrq_hammer_failed',
    lastObservedStatus: 'starting',
    lastObservedAt: '2026-06-20T10:00:00Z',
    lastError: null,
  });

  let tearDownAttempts = 0;
  const execFileImpl = async (_cmd, args) => {
    if (args[0] === 'dispatch' && args[1] === 'status') {
      return { stdout: '{"status":"failed"}', stderr: '' };
    }
    if (args[0] === 'worker' && args[1] === 'tear-down') {
      tearDownAttempts += 1;
      if (tearDownAttempts === 1) {
        const err = new Error('permission denied while tearing down worker');
        err.stderr = 'permission denied while tearing down worker';
        throw err;
      }
      return { stdout: '{}', stderr: '' };
    }
    return { stdout: '{"dispatchId":"dispatch_hammer_new","launchRequestId":"lrq_hammer_new"}', stderr: '' };
  };

  const args = {
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl,
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
  };

  await assert.rejects(
    () => maybeDispatchAmaCloser(args),
    /AMA hammer worker teardown failed for hammer-ama-pr-1234/,
  );

  let db = openReviewStateDb(rootDir);
  try {
    const hasPassTable = db.prepare(
      `SELECT 1 AS present
         FROM sqlite_master
        WHERE type = 'table' AND name = 'reviewer_passes'`
    ).get()?.present === 1;
    const rowCount = hasPassTable
      ? db.prepare(
        `SELECT COUNT(*) AS count
           FROM reviewer_passes
          WHERE repo = ? AND pr_number = ? AND pass_kind = 'closer'`
      ).get(dispatchContext.repo, prMetadata.prNumber).count
      : 0;
    assert.equal(rowCount, 0, 'failed teardown poll must not record closer tokens');
  } finally {
    db.close();
  }

  const result = await maybeDispatchAmaCloser({
    ...args,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:06:00Z' },
  });

  assert.equal(result.launchRequestId, 'lrq_hammer_new');
  db = openReviewStateDb(rootDir);
  try {
    const rows = db.prepare(
      `SELECT attempt_number, worker_run_id, token_input, token_output, token_cost_usd
         FROM reviewer_passes
        WHERE repo = ? AND pr_number = ? AND pass_kind = 'closer'`
    ).all(dispatchContext.repo, prMetadata.prNumber);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      attempt_number: 1,
      worker_run_id: 'wr_hammer_failed',
      token_input: 123,
      token_output: 45,
      token_cost_usd: 0.17,
    });
  } finally {
    db.close();
  }
});

test('SSG-06: hq succeeded status alone does not retain closer ownership', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-ssg06-succeeded-admit-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const ledgerDb = join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb, { runtimeSessions: [], workerRuns: [] });
  insertWorkerRun(ledgerDb, {
    runId: 'wr_admitted',
    launchRequestId: 'lrq_admitted',
    input: 10,
    output: 2,
    cost: 0.01,
    status: 'succeeded',
  });

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: {
      rootDir,
      ledgerTarget: { backend: 'sqlite', path: ledgerDb },
      closerTokenRollupPollDelaysMs: [],
    },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_admitted',
    launchRequestId: 'lrq_admitted',
    lastObservedStatus: 'starting',
    lastObservedAt: '2026-06-20T10:00:00Z',
    lastError: null,
  });
  acquireAmaCloserLease({
    rootDir,
    ...identity,
    watcherPid: 1001,
    now: '2026-06-20T10:00:00Z',
  });
  updateAmaCloserLease({
    rootDir,
    ...identity,
    status: 'dispatched',
    lrqId: 'lrq_admitted',
    now: '2026-06-20T10:00:01Z',
  });

  const calls = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl: async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: '{"status":"succeeded"}', stderr: '' };
      }
      return { stdout: '{"dispatchId":"dispatch_retry","launchRequestId":"lrq_retry"}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionProducerEvidenceImpl: () => ({
      ok: true,
      row: { completion_id: 'bcmp_prior', repo: dispatchContext.repo, signal_kind: 'merged' },
    }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.launchRequestId, 'lrq_retry');
  assert.ok(
    calls.some((args) => args[0] === 'dispatch' && args[1] !== 'status'),
    'unverified terminal success must release ownership and allow re-dispatch',
  );
});

test('SSG-06: hq succeeded status retains hold when merge producer has no repo evidence', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-ssg06-no-producer-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = liveHammerFixture({
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_succeeded',
    launchRequestId: 'lrq_succeeded',
    lastObservedStatus: 'starting',
    lastObservedAt: '2026-06-20T10:00:00Z',
    lastError: null,
  });

  const calls = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl: async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: '{"status":"succeeded"}', stderr: '' };
      }
      return { stdout: '{"dispatchId":"dispatch_unexpected","launchRequestId":"lrq_unexpected"}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionProducerEvidenceImpl: () => ({
      ok: false,
      reason: 'missing-build-completion-producer-evidence',
    }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'existing-dispatch-succeeded');
  assert.equal(
    calls.filter((args) => args[0] === 'dispatch' && args[1] !== 'status').length,
    0,
    'table-present-but-producer-absent must retain the terminal hold',
  );
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.lastError, 'merged-signal-read-missing-build-completion-producer-evidence');
});

test('SSG-06: transient merged-signal read failure retains terminal closer hold', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-ssg06-ledger-error-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = liveHammerFixture({
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatched',
    retryCount: 1,
    dispatchedAt: '2026-06-20T10:00:00Z',
    dispatchId: 'dispatch_succeeded',
    launchRequestId: 'lrq_succeeded',
    lastObservedStatus: 'starting',
    lastObservedAt: '2026-06-20T10:00:00Z',
    lastError: null,
  });
  acquireAmaCloserLease({
    rootDir,
    ...identity,
    watcherPid: 1001,
    now: '2026-06-20T10:00:00Z',
  });
  updateAmaCloserLease({
    rootDir,
    ...identity,
    status: 'dispatched',
    lrqId: 'lrq_succeeded',
    now: '2026-06-20T10:00:01Z',
  });

  const calls = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl: async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: '{"status":"succeeded"}', stderr: '' };
      }
      return { stdout: '{"dispatchId":"dispatch_unexpected","launchRequestId":"lrq_unexpected"}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'ledger-read-failed', detail: 'sqlite locked' }),
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'existing-dispatch-succeeded');
  assert.equal(
    calls.filter((args) => args[0] === 'dispatch' && args[1] !== 'status').length,
    0,
    'unknown merged-signal state must not release terminal ownership',
  );
  const record = JSON.parse(readFileSync(amaCloserDispatchFilePath(rootDir, identity), 'utf8'));
  assert.equal(record.lastError, 'merged-signal-read-ledger-read-failed');
});

test('AMA-07 lease blocks regardless of how hq dispatch status would have responded', async (t) => {
  // The AMA-07 lease is independent of hq dispatch status. Even if hq
  // status probing would return malformed output (the old test's
  // failure mode), the lease blocks at the file-system level before
  // any status probe runs. The watcher gets a clean `lease-held`
  // signal and falls through (or skips) on its own.
  //
  // The pre-AMA-07 test asserted on the hq-status probe retry count
  // (4 = retries hit before degraded-unknown surfaced). That code
  // path is now downstream of the lease; the assertion is replaced
  // with the lease-held contract.
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-status-noise-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir },
  });
  const calls = [];
  const execImpl = async (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'dispatch' && args[1] === 'status') {
      // Old test exercised this path; it's unreachable now.
      return { stdout: 'warning: daemon bounced\nnot-json\n', stderr: '' };
    }
    return { stdout: '{"dispatchId":"dispatch-123","launchRequestId":"lrq_123"}', stderr: '' };
  };

  const first = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: execImpl,
    readTemplateImpl: () => 'stubbed',
  });
  assert.equal(first.dispatched, true);

  const second = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: {
      ...dispatchContext,
      dispatchedAt: '2026-06-11T20:01:00Z',
    },
    execFileImpl: execImpl,
    readTemplateImpl: () => 'stubbed',
  });
  assert.equal(second.dispatched, false);
  assert.equal(second.reason, 'dispatch-status-unknown');
  assert.equal(second.namedReason, 'dispatch-status-unknown');
  assert.equal(second.skipMergeAgent, true);
  const hqStatusProbes = calls.filter((args) => args[0] === 'dispatch' && args[1] === 'status');
  assert.ok(hqStatusProbes.length >= 1);
});

test('ambiguous dispatch failure with launch request id suppresses merge-agent fallback', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-ambiguous-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir },
  });
  const err = new Error('dispatch transport failed');
  err.stderr = 'simulated dispatch failure';
  err.stdout = '{"dispatchId":"dispatch-999","launchRequestId":"lrq_999"}';

  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: async () => { throw err; },
    readTemplateImpl: () => 'stubbed',
  });
  assert.equal(result.dispatched, false);
  assert.equal(result.skipMergeAgent, true);
  assert.equal(result.reason, 'dispatch-response-ambiguous');
  assert.equal(result.launchRequestId, 'lrq_999');
});

test('stale pending lease from pre-dispatch failure is repaired on the next tick', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-stale-pending-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir },
  });
  acquireAmaCloserLease({
    rootDir,
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
    watcherPid: 999,
    now: dispatchContext.dispatchedAt,
  });

  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    processKillImpl: () => {
      const err = new Error('missing process');
      err.code = 'ESRCH';
      throw err;
    },
    execFileImpl: async () => ({
      stdout: '{"dispatchId":"dispatch-retry","launchRequestId":"lrq_retry"}',
      stderr: '',
    }),
    readTemplateImpl: () => 'stubbed',
  });
  assert.equal(result.dispatched, true);
  const repairedLease = readAmaCloserLease(rootDir, {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  });
  assert.equal(repairedLease.status, 'dispatched');
  assert.equal(repairedLease.lrqId, 'lrq_retry');
});

// ---------------------------------------------------------------------------
// Regression — interrupted in-flight dispatch (watcher SIGTERM'd mid-launch,
// e.g. a main-catchup deploy bounce) must be reclaimed, not miscounted as
// exhausted genuine failures. Reproduces the 2026-06-14 wedge: 10 eligible PRs
// stuck at retryCount=2 with `state:'dispatching', lrqId:null, lastError:null`,
// zero autonomous merges for hours.
// ---------------------------------------------------------------------------

function plantDispatchRecord(rootDir, identity, overrides) {
  const recordPath = amaCloserDispatchFilePath(rootDir, identity);
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(
    recordPath,
    `${JSON.stringify({ schemaVersion: 1, ...identity, workerClass: 'codex', ...overrides }, null, 2)}\n`,
  );
  return recordPath;
}

function insertWorkerRun(ledgerDb, {
  runId,
  launchRequestId,
  input,
  output,
  cost,
  status,
}) {
  const db = new Database(ledgerDb);
  try {
    db.prepare(
      `INSERT INTO worker_runs (
         run_id, launch_request_id, session_id, status, token_usage_input,
         token_usage_output, token_usage_cost_usd, token_usage_source,
         started_at, ended_at, updated_at
       ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'session-ledger',
         '2026-06-20T10:00:00.000Z',
         '2026-06-20T10:02:00.000Z',
         '2026-06-20T10:02:00.000Z')`
    ).run(runId, launchRequestId, status, input, output, cost);
  } finally {
    db.close();
  }
}

test('isInterruptedInFlightAmaCloserDispatch identifies a watcher-killed mid-dispatch record', () => {
  // The exact frozen signature: dispatching, no launch id, no error.
  assert.equal(
    isInterruptedInFlightAmaCloserDispatch(
      { state: 'dispatching', launchRequestId: null, dispatchId: null, lastError: null },
      {
        status: 'pending',
        acquiredAt: '2026-06-14T20:16:32Z',
        watcherPid: 4542,
      },
      {
        now: '2026-06-14T20:30:00Z',
        processKillImpl: () => {
          const err = new Error('missing process');
          err.code = 'ESRCH';
          throw err;
        },
      },
    ),
    true,
  );
  // The same frozen dispatch record is NOT reclaimable while its pending lease
  // still belongs to a live watcher inside the hq-dispatch launch window.
  assert.equal(
    isInterruptedInFlightAmaCloserDispatch(
      { state: 'dispatching', launchRequestId: null, dispatchId: null, lastError: null },
      {
        status: 'pending',
        acquiredAt: '2026-06-14T20:16:32Z',
        watcherPid: 4542,
      },
      {
        now: '2026-06-14T20:17:00Z',
        processKillImpl: () => {},
      },
    ),
    false,
  );
  // The live owner may still be inside the retry loop after the first 90s
  // execFile timeout plus both retry sleeps; do not reclaim at the old 96s mark.
  assert.equal(
    isInterruptedInFlightAmaCloserDispatch(
      { state: 'dispatching', launchRequestId: null, dispatchId: null, lastError: null },
      {
        status: 'pending',
        acquiredAt: '2026-06-14T20:16:32Z',
        watcherPid: 4542,
      },
      {
        now: '2026-06-14T20:18:08Z',
        processKillImpl: () => {},
      },
    ),
    false,
  );
  // A dispatch that DID launch (lrq recorded) is not an interruption.
  assert.equal(
    isInterruptedInFlightAmaCloserDispatch(
      { state: 'dispatching', launchRequestId: 'lrq_x', dispatchId: null, lastError: null },
      { status: 'pending', acquiredAt: '2026-06-14T20:16:32Z', watcherPid: 4542 },
      { now: '2026-06-14T20:30:00Z' },
    ),
    false,
  );
  // A genuine completed failure (lastError set) is bounded normally.
  assert.equal(
    isInterruptedInFlightAmaCloserDispatch(
      { state: 'dispatch-failed', launchRequestId: null, dispatchId: null, lastError: 'boom' },
      { status: 'pending', acquiredAt: '2026-06-14T20:16:32Z', watcherPid: 4542 },
      { now: '2026-06-14T20:30:00Z' },
    ),
    false,
  );
  assert.equal(isInterruptedInFlightAmaCloserDispatch({ state: 'dispatched', launchRequestId: 'lrq_y' }), false);
  assert.equal(isInterruptedInFlightAmaCloserDispatch(null), false);
});

test('interrupted in-flight dispatch at the redispatch bound is reclaimed, not exhausted', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-interrupted-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };

  // Two deploy-bounce interruptions left retryCount == REDISPATCH_BOUND (2),
  // frozen mid-launch, plus a stale pending lease from the dead watcher.
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatching',
    retryCount: 2,
    dispatchedAt: null,
    dispatchId: null,
    launchRequestId: null,
    lastError: null,
  });
  acquireAmaCloserLease({ rootDir, ...identity, watcherPid: 4542, now: '2026-06-14T20:16:32Z' });

  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-14T20:30:00Z' },
    processKillImpl: () => {
      const err = new Error('missing process');
      err.code = 'ESRCH';
      throw err;
    },
    execFileImpl: async () => ({
      stdout: '{"dispatchId":"dispatch-reclaim","launchRequestId":"lrq_reclaim"}',
      stderr: '',
    }),
    readTemplateImpl: () => 'stubbed',
  });

  // The whole point: the bound must NOT fire on an interrupted attempt.
  assert.equal(result.dispatched, true, 'interrupted dispatch must redispatch, not exhaust');
  assert.notEqual(result.reason, 'dispatch-retry-exhausted');
  assert.equal(result.launchRequestId, 'lrq_reclaim');
  const lease = readAmaCloserLease(rootDir, identity);
  assert.equal(lease.status, 'dispatched');
  assert.equal(lease.lrqId, 'lrq_reclaim');
});

test('live pending lease below redispatch bound does not consume a phantom retry', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-live-pending-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };

  const recordPath = plantDispatchRecord(rootDir, identity, {
    state: 'dispatching',
    retryCount: 1,
    dispatchedAt: null,
    dispatchId: null,
    launchRequestId: null,
    lastError: null,
  });
  acquireAmaCloserLease({
    rootDir,
    ...identity,
    watcherPid: 4542,
    now: '2026-06-14T20:16:32Z',
  });

  let execCalled = false;
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-14T20:17:00Z' },
    processKillImpl: () => {},
    execFileImpl: async () => {
      execCalled = true;
      return { stdout: '{"dispatchId":"dispatch-stolen","launchRequestId":"lrq_stolen"}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'lease-held');
  assert.equal(result.namedReason, 'lease-held');
  assert.equal(result.skipMergeAgent, true);
  assert.equal(execCalled, false, 'must not launch a duplicate AMA closer while the pending lease is live');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(record.retryCount, 1, 'must not consume retry budget for a launch it did not attempt');
  assert.equal(record.state, 'dispatching');
  assert.equal(record.lastAttemptedAt || null, null);
  const lease = readAmaCloserLease(rootDir, identity);
  assert.equal(lease.status, 'pending');
  assert.equal(lease.lrqId, null);
  assert.equal(lease.watcherPid, 4542);
});

test('genuine repeated dispatch failures at the bound are still exhausted', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-genuine-exhausted-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: { rootDir },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };

  // Completed failures (lastError set, state='dispatch-failed') stay bounded —
  // the exemption is narrowly the interrupted-in-flight signature only.
  plantDispatchRecord(rootDir, identity, {
    state: 'dispatch-failed',
    retryCount: 2,
    dispatchedAt: null,
    dispatchId: null,
    launchRequestId: null,
    lastError: 'hq dispatch failed (exit code 65)',
  });

  let execCalled = false;
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-14T20:30:00Z' },
    execFileImpl: async () => {
      execCalled = true;
      return { stdout: '{"dispatchId":"d","launchRequestId":"l"}', stderr: '' };
    },
    readTemplateImpl: () => 'stubbed',
  });

  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'dispatch-retry-exhausted');
  assert.equal(result.namedReason, 'dispatch-retry-exhausted');
  assert.equal(execCalled, false, 'must not redispatch a genuinely-exhausted closer');
});

test('terminal AMA audit releases a stale lease so the same head can be retried', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-terminal-repair-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const ledgerDb = join(rootDir, 'ledger.db');
  createSessionLedgerDb(ledgerDb, { runtimeSessions: [], workerRuns: [] });
  insertWorkerRun(ledgerDb, {
    runId: 'wr_bootstrap',
    launchRequestId: 'lrq_bootstrap',
    input: 10,
    output: 2,
    cost: 0.01,
    status: 'superseded',
  });

  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    dispatchContext: {
      rootDir,
      ledgerTarget: { backend: 'sqlite', path: ledgerDb },
      closerTokenRollupPollDelaysMs: [],
    },
  });
  const identity = {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: dispatchContext.reviewedSha,
  };

  acquireAmaCloserLease({
    rootDir,
    ...identity,
    watcherPid: 1001,
    now: dispatchContext.dispatchedAt,
  });
  const bootstrap = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: async () => ({
      stdout: '{"dispatchId":"dispatch-bootstrap","launchRequestId":"lrq_bootstrap"}',
      stderr: '',
    }),
    processKillImpl: () => {
      const err = new Error('dead watcher pid');
      err.code = 'ESRCH';
      throw err;
    },
    readTemplateImpl: () => 'stubbed',
  });
  assert.equal(bootstrap.dispatched, true);
  updateAmaCloserLease({
    rootDir,
    ...identity,
    status: 'terminal',
    terminalOutcome: 'deferred',
    now: '2026-06-11T20:10:00Z',
  });
  appendAmaAuditAttempt({
    hqRoot: dispatchContext.hqRoot,
    ...identity,
    attempt: { outcome: 'deferred', preMergeReasons: ['ci-not-green'] },
    now: '2026-06-11T20:10:00Z',
  });

  const retry = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: {
      ...dispatchContext,
      dispatchedAt: '2026-06-11T20:11:00Z',
    },
    execFileImpl: async (_cmd, args) => (
      args[0] === 'dispatch' && args[1] === 'status'
        ? { stdout: '{"status":"superseded"}', stderr: '' }
        : { stdout: '{"dispatchId":"dispatch-redo","launchRequestId":"lrq_redo"}', stderr: '' }
    ),
    readTemplateImpl: () => 'stubbed',
  });
  assert.equal(retry.dispatched, true);
  const repairedLease = readAmaCloserLease(rootDir, identity);
  assert.equal(repairedLease.status, 'dispatched');
  assert.equal(repairedLease.lrqId, 'lrq_redo');
});

/*
  // regenerate-golden:
  //
  //   import { readFileSync, writeFileSync } from 'node:fs';
  //   import { composeCloserPrompt } from '../src/ama/dispatch-closer.mjs';
  //   import { amaAuditTraceRef } from '../src/ama/audit.mjs';
  //   const tpl = readFileSync('templates/ama-closer-prompt.md', 'utf8');
  //   const repo = 'acme/myrepo';
  //   const prNumber = 1234;
  //   const reviewedSha = 'abc12345abc12345abc12345abc12345abc12345';
  //   const hqRoot = '/tmp/ama-test-hqroot';
  //   const auditPath = `${hqRoot}/dispatch/audit/adversarial-merge-authority/${repo.replace('/', '-')}-pr-${prNumber}-${reviewedSha}.json`;
  //   const auditRef = amaAuditTraceRef(repo, prNumber, reviewedSha);
  //   const prompt = composeCloserPrompt({
  //     prUrl: 'https://github.com/acme/myrepo/pull/1234',
  //     repo,
  //     prNumber,
  //     reviewedSha,
  //     riskClass: 'low',
  //     mergeMethod: 'squash',
  //     requiredGateContext: 'agent-os/adversarial-gate',
  //     auditPath,
  //     hqRoot,
  //     rootDir: '/tmp/ama-test-root',
  //     hqOwnerUser: 'unknown',
  //     reviewedBy: 'claude-reviewer-lacey',
  //     reviewer: 'claude',
  //     dispatchedAt: '2026-06-11T20:00:00Z',
  //     amaTrailers: [
  //       'Closed-By: codex-closer (adversarial-pipe-mode)',
  //       'Reviewed-By: claude-reviewer-lacey',
  //       'Risk-Class: low',
  //       'Eligibility-Reason: latest_review_settled_success, reviewer_family_recorded, risk_class_low_permitted, head_sha_matches_review, ci_all_green, no_blocking_labels, configured_gate_context_required',
  //       `Eligibility-Trace: ${auditRef}`,
  //     ].join('\\n'),
  //     templateBody: tpl,
  //   });
  //   writeFileSync('test/fixtures/ama-closer-prompt.golden.md', prompt);
*/

// --- Auto-hammer eligibility-miss gate (2026-06-19, final-cycle widened 2026-06-24) ---

test('isHammerRemediableEligibilityMiss fires narrowly before exhaustion and for any miss at exhaustion', () => {
  // Remediable: standing non-blocking findings (optionally + the strict
  // verdict-not-settled-success that accompanies them).
  assert.equal(isHammerRemediableEligibilityMiss(['non-blocking-findings-present']), true);
  assert.equal(
    isHammerRemediableEligibilityMiss(['non-blocking-findings-present', 'verdict-not-settled-success']),
    true,
  );
  assert.equal(
    isHammerRemediableEligibilityMiss(['verdict-not-settled-success', 'non-blocking-findings-present']),
    true,
  );

  // Remediable: the hammer owns merge-conflict / behind-base resolution, so a
  // not-mergeable PR routes to the hammer instead of parking await-operator —
  // alone, or alongside other hammer-remediable reasons.
  assert.equal(isHammerRemediableEligibilityMiss(['pr-not-mergeable']), true, 'pure conflict/behind → hammer');
  assert.equal(
    isHammerRemediableEligibilityMiss(['pr-not-mergeable', 'verdict-not-settled-success', 'non-blocking-findings-present']),
    true,
  );
  assert.equal(isHammerRemediableEligibilityMiss(['non-blocking-findings-present', 'pr-not-mergeable']), true);

  // Remediable: red CI routes to the hammer rescue (it fixes the failing
  // required checks / tests, then merges) — alone or with other remediable reasons.
  assert.equal(isHammerRemediableEligibilityMiss(['ci-not-green']), true, 'red CI → hammer rescue');
  assert.equal(isHammerRemediableEligibilityMiss(['non-blocking-findings-present', 'ci-not-green']), true);
  assert.equal(isHammerRemediableEligibilityMiss(['ci-not-green', 'pr-not-mergeable']), true);

  // NOT remediable — must stay await-operator:
  assert.equal(isHammerRemediableEligibilityMiss([]), false);
  assert.equal(isHammerRemediableEligibilityMiss(undefined), false);
  assert.equal(isHammerRemediableEligibilityMiss(['verdict-not-settled-success']), false, 'verdict-only (no actionable) is not auto-hammer');
  assert.equal(isHammerRemediableEligibilityMiss(['blocking-findings-present']), false);
  assert.equal(isHammerRemediableEligibilityMiss(['non-blocking-findings-present', 'blocking-findings-present']), false, 'any blocking finding disqualifies');
  assert.equal(isHammerRemediableEligibilityMiss(['pr-not-mergeable', 'blocking-findings-present']), false, 'blocking finding still disqualifies even with a conflict');
  assert.equal(isHammerRemediableEligibilityMiss(['ci-not-green', 'blocking-findings-present']), false, 'blocking finding still disqualifies even with red CI');
  assert.equal(isHammerRemediableEligibilityMiss(['non-blocking-findings-present', 'stale-review-head']), false);

  // At review-cycle exhaustion, the hammer is the terminal rescue lane. It
  // dispatches for any miss reason and re-validates fail-closed after repair.
  assert.equal(
    isHammerRemediableEligibilityMiss(
      ['verdict-not-settled-success'],
      { reviewCycleExhausted: true },
    ),
    true,
    'exhausted verdict-only miss routes to hammer',
  );
  assert.equal(
    isHammerRemediableEligibilityMiss(
      ['verdict-not-settled-success', 'blocking-findings-present'],
      { reviewCycleExhausted: true },
    ),
    true,
    'exhausted blocking findings route to hammer',
  );
  assert.equal(
    isHammerRemediableEligibilityMiss(
      ['ci-not-green', 'blocking-findings-present', 'risk-class-not-permitted'],
      { reviewCycleExhausted: true },
    ),
    true,
    'exhausted mixed misses route to hammer',
  );
  assert.equal(
    isHammerRemediableEligibilityMiss([], { reviewCycleExhausted: true }),
    false,
    'no miss reasons means there is no eligibility miss to route',
  );
});

// ---------------------------------------------------------------------------
// HHR — harness-fallback protection for the codex-capped closer/hammer.
//
// The AMA closer worker_class defaults to `hammer` (a codex/OpenAI harness).
// When codex OAuth is grounded the hammer cannot spawn, so settled PRs never
// close. These tests exercise the dispatch-time harness fallback that swaps the
// PHYSICAL `--worker-class` to an available harness while preserving the
// closer's terminal-remediation + merge-under-lease behavior, emits the
// `ama_closer.harness_fallback` audit, and auto-reverts when codex recovers.
// ---------------------------------------------------------------------------

// `hq fleet quota status --json` payload for the given provider→state map.
function fleetQuotaPayload(states = {}) {
  return JSON.stringify({
    providerStatuses: Object.entries(states).map(([provider, state]) => ({
      provider,
      authPath: 'oauth',
      state,
      lastProbeAt: '2026-07-05T00:00:00Z',
      lastGoodAt: '2026-07-04T00:00:00Z',
    })),
    lastProbeAt: '2026-07-05T00:00:00Z',
  });
}

// exec mock that answers `hq fleet quota status --json` with a scripted fleet
// payload and every other call (i.e. `hq dispatch`) with the dispatch id.
function buildFleetAwareExecMock({ providerStates = {}, dispatchStdout = 'dispatchId=lrq_test_0001\n' } = {}) {
  const calls = [];
  const impl = async (cmd, args) => {
    calls.push({ cmd, args });
    if (Array.isArray(args) && args[0] === 'fleet' && args[1] === 'quota' && args[2] === 'status') {
      return { stdout: fleetQuotaPayload(providerStates), stderr: '' };
    }
    return { stdout: dispatchStdout, stderr: '' };
  };
  const dispatchCall = () => calls.find((c) => Array.isArray(c.args) && c.args[0] === 'dispatch');
  const fleetCall = () => calls.find((c) => Array.isArray(c.args) && c.args[0] === 'fleet');
  return { impl, calls, dispatchCall, fleetCall };
}

test('HHR: codex grounded + hammer closer falls back to claude-code with harness_fallback audit', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-hhr-fallback-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer', workerClassFallback: ['claude-code'] },
    dispatchContext: { rootDir },
  });
  const exec = buildFleetAwareExecMock({ providerStates: { openai: 'exhausted', anthropic: 'ok' } });
  const write = buildWriteMock();
  const { events, logger } = buildStructuredLogger();
  const alertCalls = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: () => readFileSync(TEMPLATE_PATH, 'utf8'),
    deliverAlertImpl: async (text, opts) => { alertCalls.push({ text, opts }); },
    logger,
  });

  assert.equal(result.dispatched, true);
  // The LOGICAL worker class is unchanged (drives prompt/audit provenance)...
  assert.equal(result.workerClass, 'hammer');
  // ...but the PHYSICAL dispatch harness swapped to the available fallback.
  assert.equal(result.dispatchWorkerClass, 'claude-code');
  const dispatchArgs = exec.dispatchCall().args;
  assert.equal(dispatchArgs[dispatchArgs.indexOf('--worker-class') + 1], 'claude-code');

  // Fleet quota was consulted (authoritative signal, not a guess).
  assert.ok(exec.fleetCall(), 'hq fleet quota status was queried');

  // Merge-under-lease preserved: the closer lease was acquired for this head.
  assert.ok(result.leasePath, 'closer lease is acquired on the fallback path');

  // Loud audit fired with provider + from/to.
  const audit = events.find((e) => e.event === 'ama_closer.harness_fallback');
  assert.ok(audit, 'ama_closer.harness_fallback audit event fired');
  assert.equal(audit.provider, 'openai');
  assert.equal(audit.from, 'hammer');
  assert.equal(audit.to, 'claude-code');
  assert.equal(audit.primaryState, 'exhausted');
  assert.equal(audit.fallbackProvider, 'anthropic');
  assert.equal(result.harnessFallback.to, 'claude-code');

  // Operator alert delivered with the same from/to/provider payload.
  assert.equal(alertCalls.length, 1);
  assert.equal(alertCalls[0].opts.event, 'ama_closer.harness_fallback');
  assert.equal(alertCalls[0].opts.payload.provider, 'openai');
  assert.equal(alertCalls[0].opts.payload.from, 'hammer');
  assert.equal(alertCalls[0].opts.payload.to, 'claude-code');
});

test('HHR regression: codex healthy → closer dispatches on the configured primary (no fallback, auto-revert)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-hhr-healthy-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer', workerClassFallback: ['claude-code'] },
    dispatchContext: { rootDir },
  });
  const exec = buildFleetAwareExecMock({ providerStates: { openai: 'ok', anthropic: 'ok' } });
  const write = buildWriteMock();
  const { events, logger } = buildStructuredLogger();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: () => readFileSync(TEMPLATE_PATH, 'utf8'),
    logger,
  });

  assert.equal(result.dispatched, true);
  assert.equal(result.workerClass, 'hammer');
  assert.equal(result.dispatchWorkerClass, undefined, 'no dispatchWorkerClass override when primary is healthy');
  const dispatchArgs = exec.dispatchCall().args;
  assert.equal(dispatchArgs[dispatchArgs.indexOf('--worker-class') + 1], 'hammer');
  assert.equal(events.find((e) => e.event === 'ama_closer.harness_fallback'), undefined, 'no fallback audit when codex is healthy');
});

test('HHR: fallback preserves the hammer terminal-remediation prompt + merge-under-lease', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-hhr-terminal-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const reviewedHead = '40e302440e302440e302440e302440e302440e3024';
  const currentHead = '6358df76358df76358df76358df76358df76358d';
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: {
      workerClass: 'hammer',
      workerClassFallback: ['claude-code'],
      autoHammerOnEligibilityMiss: true,
    },
    reviewState: {
      verdict: 'request-changes',
      headSha: reviewedHead,
      riskClass: 'medium',
      reviewCycleExhausted: true,
      blockingFindingState: 'known',
      blockingFindingCount: 1,
    },
    prMetadata: { headSha: currentHead, mergeableState: 'MERGEABLE' },
    dispatchContext: { rootDir, reviewedSha: reviewedHead, riskClass: 'medium', templatePath: null },
  });
  const exec = buildFleetAwareExecMock({ providerStates: { openai: 'exhausted', anthropic: 'ok' } });
  const write = buildWriteMock();
  const templatePathsRead = [];
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: (p) => { templatePathsRead.push(p); return readFileSync(p, 'utf8'); },
    deliverAlertImpl: async () => {},
  });

  assert.equal(result.dispatched, true);
  // Physical harness fell back...
  assert.equal(result.dispatchWorkerClass, 'claude-code');
  const dispatchArgs = exec.dispatchCall().args;
  assert.equal(dispatchArgs[dispatchArgs.indexOf('--worker-class') + 1], 'claude-code');
  // ...but the HAMMER terminal-remediation template (not the plain closer
  // template) was still selected — terminal remediation is preserved.
  assert.ok(
    templatePathsRead.includes(HAMMER_TEMPLATE_PATH),
    'the hammer terminal-remediation template drives the prompt even under fallback',
  );
  // Merge-under-lease preserved.
  assert.ok(result.leasePath, 'closer lease is acquired');
  const lease = readAmaCloserLease(rootDir, {
    repo: dispatchContext.repo,
    prNumber: prMetadata.prNumber,
    headSha: reviewedHead,
  });
  assert.ok(lease, 'a closer lease persists for the reviewed head');
});

test('HHR: alert transport down → fail-open (dispatch still falls back and merges)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-hhr-alert-down-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer', workerClassFallback: ['claude-code'] },
    dispatchContext: { rootDir },
  });
  const exec = buildFleetAwareExecMock({ providerStates: { openai: 'exhausted', anthropic: 'ok' } });
  const write = buildWriteMock();
  const { events, logger } = buildStructuredLogger();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: () => readFileSync(TEMPLATE_PATH, 'utf8'),
    // Alert transport is down: throws on delivery.
    deliverAlertImpl: async () => { throw new Error('ALERT_TO must be configured for alert delivery'); },
    logger,
  });

  // The merge path is unaffected: fallback still fired and the closer dispatched.
  assert.equal(result.dispatched, true);
  assert.equal(result.dispatchWorkerClass, 'claude-code');
  const dispatchArgs = exec.dispatchCall().args;
  assert.equal(dispatchArgs[dispatchArgs.indexOf('--worker-class') + 1], 'claude-code');
  // The durable audit still fired; the alert failure was logged, not thrown.
  assert.ok(events.find((e) => e.event === 'ama_closer.harness_fallback'), 'audit fired despite alert transport failure');
});

test('HHR: no fallback configured ([]) keeps the codex-capped primary (no fleet query)', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-hhr-no-fallback-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = hammerFixture({
    cfg: { workerClass: 'hammer', workerClassFallback: [] },
    dispatchContext: { rootDir },
  });
  const exec = buildFleetAwareExecMock({ providerStates: { openai: 'exhausted', anthropic: 'ok' } });
  const write = buildWriteMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: write.impl,
    readTemplateImpl: () => readFileSync(TEMPLATE_PATH, 'utf8'),
  });
  assert.equal(result.dispatched, true);
  const dispatchArgs = exec.dispatchCall().args;
  assert.equal(dispatchArgs[dispatchArgs.indexOf('--worker-class') + 1], 'hammer');
  assert.equal(exec.fleetCall(), undefined, 'no fleet quota query when fallback is disabled');
});
