import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      reviewerFamilyPolicy: 'audit_existing_gate_contract',
      ciGreenClassifier: 'existingAdversarialMergeClassifier',
    },
    branchProtection: { requiredGateContextSource: 'resolveGateStatusContext' },
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
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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
  // Risk class `high` blocks under the default `low`-only allowlist.
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
// Test 3 — cfg.enabled=true + eligible dispatches with default workerClass.
// ---------------------------------------------------------------------------

test('cfg.enabled=true + eligible dispatches with workerClass=hammer by default', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-default-'));
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
    readTemplateImpl: () => readFileSync(TEMPLATE_PATH, 'utf8'),
  });
  assert.equal(result.dispatched, true);
  assert.equal(result.workerClass, 'hammer');
  assert.equal(result.dispatchId, 'lrq_test_0001');
  assert.equal(exec.calls.length, 1);
  const args = exec.calls[0].args;
  assert.ok(args.includes('--worker-class'));
  const wcIdx = args.indexOf('--worker-class');
  assert.equal(args[wcIdx + 1], 'hammer');
  assert.ok(args.includes('--task-kind'));
  assert.equal(args[args.indexOf('--task-kind') + 1], 'merge');
  assert.ok(args.includes('--completion-shape'));
  assert.equal(args[args.indexOf('--completion-shape') + 1], 'decision-only');
  assert.ok(args.includes('--project'));
  assert.equal(args[args.indexOf('--project') + 1], 'adversarial-merge-authority');
  assert.equal(args[args.indexOf('--repo') + 1], 'myrepo');
  assert.deepEqual(
    args
      .map((value, index) => (value === '--additional-repo' ? args[index + 1] : null))
      .filter(Boolean),
    ['agent-os'],
  );
  // Prompt body was written; capture inspected for substitutions.
  assert.ok(write.captured.body, 'prompt body must be written');
  assert.equal(write.captured.dir, `${rootDir}/data/follow-up-jobs/ama-closer-prompts`);
  assert.ok(write.captured.body.includes(`PR ${dispatchContext.prUrl}`));
  assert.ok(write.captured.body.includes(reviewState.headSha));
  assert.ok(write.captured.body.includes('--squash'));
  assert.ok(write.captured.body.includes('--body-file "$TRAILERS_FILE"'));
  assert.ok(write.captured.body.includes('Closed-By: hammer-closer (adversarial-pipe-mode)'));
  assert.ok(write.captured.body.includes('Reviewed-By: claude-reviewer-lacey'));
  assert.ok(write.captured.body.includes('--reviewer claude'));
  assert.ok(write.captured.body.includes('Risk-Class: low'));
  assert.ok(write.captured.body.includes('Eligibility-Trace: ama-audit:acme/myrepo:pr-1234:head-abc12345abc12345abc12345abc12345abc12345'));
  assert.ok(write.captured.body.includes('attemptPhase: "before-gh-pr-merge"'));
});

test('eligible agent-os dispatch does not add agent-os as a duplicate workspace repo', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-agent-os-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

test('maybeDispatchAmaCloser is mode-invariant for merge-class dispatch', async (t) => {
  const dispatches = [];
  for (const orchestrationMode of ENUM_ROLES_ADVERSARIAL_ORCHESTRATION_MODE) {
    const rootDir = mkdtempSync(join(tmpdir(), `ama-dispatch-${orchestrationMode}-`));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
    prMetadata: { branchProtection: { requiredContexts: [] } },
    cfg: {
      branchProtection: {
        requiredGateContextSource: 'resolveGateStatusContext',
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
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

test('cfg.workerClass=gemini routes the closer to gemini with gemini-closer provenance', async (t) => {
  // GMW-04: gemini is a selectable AMA closer. Only the executing harness
  // changes — the dispatch shape (--task-kind merge --completion-shape
  // decision-only) and the generic `${workerClass}-closer` provenance are
  // unchanged, so the closer attributes as `gemini-closer`.
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-gemini-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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
    readTemplateImpl: () => readFileSync(TEMPLATE_PATH, 'utf8'),
  });
  assert.equal(result.dispatched, true);
  assert.equal(result.workerClass, 'gemini');
  const args = exec.calls[0].args;
  assert.equal(args[args.indexOf('--worker-class') + 1], 'gemini');
  // The AMA dispatch shape is unchanged — only the harness differs.
  assert.equal(args[args.indexOf('--task-kind') + 1], 'merge');
  assert.equal(args[args.indexOf('--completion-shape') + 1], 'decision-only');
  assert.ok(write.captured.body.includes('Closed-By: gemini-closer (adversarial-pipe-mode)'));
});

// HAM-04 §1.1.1 — the hammer worker class is now the DEFAULT closer class.
// Terminal-remediation prompt selection must NOT key off `workerClass ===
// 'hammer'` alone: a clean, finding-free closure has nothing for HAM to
// remediate. Routing it through `hammer-prompt.md` (a non-empty HAM
// provenance commit + `Remediated-Findings` audit comment mandate) either
// stalls the merge (HAM evidence cannot exist) or pushes the closer to invent
// an unreviewed post-review source change. A clean hammer closure must use the
// plain `ama-closer-prompt.md`.
test('cfg.workerClass=hammer on a clean exhausted closure uses the plain closer prompt', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-clean-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const readPaths = [];
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
    cfg: { workerClass: 'hammer' },
    // Clean settled-success review: zero blocking and zero non-blocking
    // findings. Even when the final round is exhausted, that alone must not
    // trigger the terminal-remediation prompt.
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
  assert.equal(result.dispatched, true);
  // The worker class itself stays `hammer` — only the prompt/mandate changes.
  assert.equal(result.workerClass, 'hammer');
  const args = exec.calls[0].args;
  assert.equal(args[args.indexOf('--worker-class') + 1], 'hammer');
  assert.deepEqual(readPaths, [TEMPLATE_PATH]);
  assert.ok(write.captured.body.includes('Closed-By: hammer-closer (adversarial-pipe-mode)'));
  assert.equal(write.captured.body.includes('Closed-By: hammer (adversarial-pipe-mode)'), false);
  // The hammer terminal-remediation mandate text must be absent on a clean
  // close (these phrases are unique to `hammer-prompt.md`).
  assert.doesNotMatch(write.captured.body, /remediate, commit, comment, validate, merge/i);
  assert.doesNotMatch(write.captured.body, /Do not request another adversarial review round/);
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
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
    cfg: { workerClass: 'hammer' },
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
  assert.match(write.captured.body, /--match-head-commit "\$POST_REMEDIATION_SHA"/);
  assert.match(write.captured.body, /failed, missing, stale, or\s+unchecked required checks/);
  assert.match(write.captured.body, /HAM-03 hard-blocker: rebase attempt cap exceeded/);
  assert.match(write.captured.body, /HAM_UPDATE_BRANCH_RETRY_CAP="\$\{HAM_UPDATE_BRANCH_RETRY_CAP:-3\}"/);
  assert.match(write.captured.body, /HAM_UPDATE_BRANCH_EXIT=\$\?/);
  assert.match(write.captured.body, /Rebase-Attempts: \${HAM_REBASE_ATTEMPTS:-0}/);
});

test('auto-hammer dispatches HAM terminal remediation at review-cycle exhaustion even for verdict-only misses', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-exhausted-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const readPaths = [];
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

// Unit coverage for the prompt-selection predicate itself (HAM-04, SPEC §1.1.1).
test('amaClosureNeedsTerminalRemediation gates the hammer mandate on real findings', () => {
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
  assert.equal(amaClosureNeedsTerminalRemediation(finalHammerWaivedVerdictGate), false);

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
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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
  const { prMetadata, cfg, dispatchContext } = eligibleFixture({
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
  assert.match(prompt, /gh pr merge[\s\S]*--match-head-commit "\$POST_REMEDIATION_SHA"/);
  assert.match(prompt, /merge-lease\.mjs release[\s\S]*--lease-id "\$HAM_MERGE_LEASE_ID"/);
  assert.match(prompt, /keeping EXIT trap armed/);
  assert.match(prompt, /do not continue while the lease is unconfirmed/);
  assert.match(prompt, /trap ham_release_merge_lease EXIT/);
  assert.match(prompt, /HAM_MERGE_LEASE_ID=""\n\s+trap - EXIT/);
  assert.match(prompt, /HAM-03 conflict: releasing merge lease before local conflict resolution/);
  assert.match(prompt, /re-acquire before the next rebase\/merge attempt/);
  assert.match(prompt, /HAM_MERGE_LEASE_ACQUIRE_EXIT" -eq 70/);
  assert.match(prompt, /parked PR 1234/);
  assert.match(prompt, /AMG-04 hard-blocker: no merge without holding the merge lease/);
  assert.match(prompt, /No merge without holding the merge lease/);
  assert.match(prompt, /<!-- hq:closeout:pr -->/);
});

test('composed prompt documents that branch_protection.required=false does not require the GitHub-plan sentinel', () => {
  const { cfg, dispatchContext, prMetadata } = eligibleFixture({
    cfg: {
      branchProtection: {
        requiredGateContextSource: 'resolveGateStatusContext',
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
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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
});

test('branch-holder provision failures use bounded cleanup-debt counter outside redispatch budget', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-branch-holder-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

test('branch-holder provision failures stop retrying after bounded cleanup-debt attempts', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-branch-holder-exhausted-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
    dispatchContext: { rootDir },
  });

  let execCalled = false;
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, dispatchedAt: '2026-06-20T10:05:00Z' },
    execFileImpl: async () => {
      execCalled = true;
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
  assert.equal(execCalled, false, 'merged signal is authoritative; no dispatch/status probe needed');
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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
  assert.match(out.value, /codex:660\/\$0\.66/);
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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
