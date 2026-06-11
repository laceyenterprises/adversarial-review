import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeCloserPrompt,
  maybeDispatchAmaCloser,
  substituteTemplate,
} from '../src/ama/dispatch-closer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TEMPLATE_PATH = join(REPO_ROOT, 'templates', 'ama-closer-prompt.md');
const GOLDEN_PROMPT_PATH = join(__dirname, 'fixtures', 'ama-closer-prompt.golden.md');

/**
 * Default eligible (reviewState, prMetadata, cfg, dispatchContext)
 * tuple. The 5 test cases mutate one input at a time.
 */
function eligibleFixture(overrides = {}) {
  const headSha = 'abc12345abc12345abc12345abc12345abc12345';
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
    parentSession: 'session:test:watcher',
    hqProject: 'adversarial-merge-authority',
    hqPath: '/bin/true-stub-hq',
    hqRoot: '/tmp/ama-test-hqroot',
    rootDir: '/tmp/ama-test-root',
    templatePath: TEMPLATE_PATH,
    dispatchedAt: '2026-06-11T20:00:00Z',
    ...overrides.dispatchContext,
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
// Test 3 — cfg.enabled=true + eligible dispatches with workerClass=codex.
// ---------------------------------------------------------------------------

test('cfg.enabled=true + eligible dispatches with workerClass=codex by default', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-codex-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
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
  assert.equal(result.workerClass, 'codex');
  assert.equal(result.dispatchId, 'lrq_test_0001');
  assert.equal(exec.calls.length, 1);
  const args = exec.calls[0].args;
  assert.ok(args.includes('--worker-class'));
  const wcIdx = args.indexOf('--worker-class');
  assert.equal(args[wcIdx + 1], 'codex');
  assert.ok(args.includes('--task-kind'));
  assert.equal(args[args.indexOf('--task-kind') + 1], 'merge');
  assert.ok(args.includes('--completion-shape'));
  assert.equal(args[args.indexOf('--completion-shape') + 1], 'decision-only');
  assert.ok(args.includes('--project'));
  assert.equal(args[args.indexOf('--project') + 1], 'adversarial-merge-authority');
  // Prompt body was written; capture inspected for substitutions.
  assert.ok(write.captured.body, 'prompt body must be written');
  assert.equal(write.captured.dir, `${rootDir}/data/follow-up-jobs/ama-closer-prompts`);
  assert.ok(write.captured.body.includes(`PR ${dispatchContext.prUrl}`));
  assert.ok(write.captured.body.includes(reviewState.headSha));
  assert.ok(write.captured.body.includes('--squash'));
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

// ---------------------------------------------------------------------------
// Test 5 — Prompt body snapshot vs the golden file.
// ---------------------------------------------------------------------------

test('composed prompt body matches the checked-in golden snapshot', () => {
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture();
  // Use the same substitution values the dispatch site composes.
  const templateBody = readFileSync(TEMPLATE_PATH, 'utf8');
  const auditPath =
    `${dispatchContext.hqRoot}/dispatch/audit/adversarial-merge-authority/` +
    `${dispatchContext.repo.replace('/', '-')}-pr-${prMetadata.prNumber}-${dispatchContext.reviewedSha}.json`;
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
    hqOwnerUser: 'unknown',
    reviewedBy: dispatchContext.reviewedBy,
    dispatchedAt: dispatchContext.dispatchedAt,
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

test('existing AMA closer dispatch suppresses a duplicate launch for the same head', async (t) => {
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
  assert.equal(second.skipMergeAgent, true);
  assert.equal(second.reason, 'existing-dispatch-running');
  assert.equal(second.launchRequestId, 'lrq_123');
  assert.equal(calls.length, 2, 'second call should probe status but not re-dispatch');
});

test('existing AMA closer dispatch falls back instead of wedging on non-JSON status output', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ama-dispatch-status-noise-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
    dispatchContext: { rootDir },
  });
  const calls = [];
  const execImpl = async (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'dispatch' && args[1] === 'status') {
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
  assert.equal(second.skipMergeAgent, undefined);
  assert.equal(second.reason, 'dispatch-status-unknown');
  assert.equal(calls.filter((args) => args[0] === 'dispatch' && args[1] === 'status').length, 4);
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
  //     reviewedBy: 'claude-reviewer-lacey',
  //     dispatchedAt: '2026-06-11T20:00:00Z',
  //     templateBody: tpl,
  //   });
  //   writeFileSync('test/fixtures/ama-closer-prompt.golden.md', prompt);
*/
