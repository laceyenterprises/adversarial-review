import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  amaCloserDispatchFilePath,
  composeCloserPrompt,
  isInterruptedInFlightAmaCloserDispatch,
  maybeDispatchAmaCloser,
  substituteTemplate,
} from '../src/ama/dispatch-closer.mjs';
import {
  DEFAULT_ADVERSARIAL_MERGE_AUTHORITY_WORKER_CLASS,
  ENUM_ROLES_ADVERSARIAL_ORCHESTRATION_MODE,
} from '../src/config-loader.mjs';
import {
  amaAuditFilePath,
  amaAuditTraceRef,
  appendAmaAuditAttempt,
  readAmaAuditEntry,
} from '../src/ama/audit.mjs';
import {
  acquireAmaCloserLease,
  readAmaCloserLease,
  updateAmaCloserLease,
} from '../src/ama/closer-lease.mjs';

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
  assert.ok(Array.isArray(result.reasons));
  assert.ok(result.reasons.includes('risk-class-not-permitted'));
  assert.equal(exec.calls.length, 0, 'hq dispatch must not be invoked when ineligible');
});

// ---------------------------------------------------------------------------
// Test 3 — cfg.enabled=true + eligible dispatches with the AMA default worker.
// ---------------------------------------------------------------------------

test('cfg.enabled=true + eligible dispatches with workerClass=hammer by default', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-default-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
    cfg: { workerClass: undefined },
    dispatchContext: { rootDir, templatePath: null },
  });
  const readPaths = [];
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
  assert.equal(result.workerClass, DEFAULT_ADVERSARIAL_MERGE_AUTHORITY_WORKER_CLASS);
  assert.equal(result.dispatchId, 'lrq_test_0001');
  assert.equal(exec.calls.length, 1);
  const args = exec.calls[0].args;
  assert.ok(args.includes('--worker-class'));
  const wcIdx = args.indexOf('--worker-class');
  assert.equal(args[wcIdx + 1], DEFAULT_ADVERSARIAL_MERGE_AUTHORITY_WORKER_CLASS);
  assert.deepEqual(readPaths, [HAMMER_TEMPLATE_PATH]);
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
  assert.ok(write.captured.body.includes('Closed-By: hammer (adversarial-pipe-mode)'));
  assert.ok(write.captured.body.includes('Reviewed-By: claude-reviewer-lacey'));
  assert.ok(write.captured.body.includes('--reviewer claude'));
  assert.ok(write.captured.body.includes('Risk-Class: low'));
  assert.ok(write.captured.body.includes('Eligibility-Trace: ama-audit:acme/myrepo:pr-1234:head-abc12345abc12345abc12345abc12345abc12345'));
  assert.match(write.captured.body, /Do not request another adversarial review round/);
  assert.match(write.captured.body, /ham_terminal_remediation_validated/);
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

test('cfg.workerClass=hammer selects the terminal HAM mandate prompt', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-hammer-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const readPaths = [];
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
    cfg: { workerClass: 'hammer' },
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
  assert.equal(args[args.indexOf('--task-kind') + 1], 'merge');
  assert.equal(args[args.indexOf('--completion-shape') + 1], 'decision-only');
  assert.deepEqual(readPaths, [HAMMER_TEMPLATE_PATH]);
  assert.match(write.captured.body, /remediate, commit, comment, validate, merge/i);
  assert.match(write.captured.body, /Do not request another adversarial review round/);
  assert.match(write.captured.body, /Do not defer the review findings into follow-up PRs/);
  assert.match(write.captured.body, /ham_terminal_remediation_validated/);
  assert.match(write.captured.body, /--match-head-commit "\$POST_REMEDIATION_SHA"/);
  assert.match(write.captured.body, /failed, missing, stale, or\s+unchecked required checks/);
  assert.match(write.captured.body, /HAM-03 hard-blocker: rebase attempt cap exceeded/);
  assert.match(write.captured.body, /HAM_UPDATE_BRANCH_RETRY_CAP="\$\{HAM_UPDATE_BRANCH_RETRY_CAP:-3\}"/);
  assert.match(write.captured.body, /HAM_UPDATE_BRANCH_EXIT=\$\?/);
  assert.match(write.captured.body, /Rebase-Attempts: \${HAM_REBASE_ATTEMPTS:-0}/);
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
  assert.doesNotMatch(prompt, /@SECURITY\.md/);
  assert.match(prompt, /is_update_branch_conflict/);
  assert.match(prompt, /is_update_branch_transient/);
  assert.match(prompt, /HARD_BLOCKER_REASON=update-branch-failure/);
  assert.match(prompt, /content_equivalent_rebased_head/);
  assert.match(prompt, /Rebase-Attempts: \${REBASE_ATTEMPTS:-0}/);
  assert.match(prompt, /ham_terminal_remediation_validated/);
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
  assert.match(prompt, /ham_update_branch_conflict/);
  assert.match(prompt, /ham_update_branch_transient/);
  assert.match(prompt, /No unbounded rebase\/update-branch retries/);
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
  assert.ok(result.error.includes('simulated dispatch failure'));
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
  assert.equal(execCalled, false, 'must not redispatch a genuinely-exhausted closer');
});

test('terminal AMA audit releases a stale lease so the same head can be retried', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-terminal-repair-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
    dispatchContext: { rootDir },
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
  //   const tpl = readFileSync('templates/ama-closer-prompt.md', 'utf8');
  //   const prompt = composeCloserPrompt({
  //     prUrl: 'https://github.com/acme/myrepo/pull/1234',
  //     repo: 'acme/myrepo',
  //     prNumber: 1234,
  //     reviewedSha: 'abc12345abc12345abc12345abc12345abc12345',
  //     riskClass: 'low',
  //     mergeMethod: 'squash',
  //     requiredGateContext: 'agent-os/adversarial-gate',
  //     auditPath: '/tmp/ama-test-hqroot/dispatch/audit/adversarial-merge-authority/acme-myrepo-pr-1234-abc12345abc12345abc12345abc12345abc12345.json',
  //     hqOwnerUser: 'unknown',
  //     reviewedBy: 'claude-reviewer-lacey',
  //     dispatchedAt: '2026-06-11T20:00:00Z',
  //     amaTrailers: [
  //       'Closed-By: codex-closer (adversarial-pipe-mode)',
  //       'Reviewed-By: claude-reviewer-lacey',
  //       'Risk-Class: low',
  //       'Eligibility-Reason: latest_review_settled_success, reviewer_family_recorded, risk_class_low_permitted, head_sha_matches_review, ci_all_green, no_blocking_labels, configured_gate_context_required',
  //       'Eligibility-Trace: ama-audit:acme/myrepo:pr-1234:head-abc12345abc12345abc12345abc12345abc12345',
  //     ].join('\\n'),
  //     templateBody: tpl,
  //   });
  //   writeFileSync('test/fixtures/ama-closer-prompt.golden.md', prompt);
*/
