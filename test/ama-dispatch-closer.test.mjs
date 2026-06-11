import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

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
    hqRoot: mkdtempSync(join(tmpdir(), 'ama-test-hqroot-')),
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
function buildExecMock({
  stdout = JSON.stringify({ dispatchId: 'disp_test_0001', lrq: 'lrq_test_0001' }),
  throwOn = null,
  errorFactory = null,
} = {}) {
  const calls = [];
  let callCount = 0;
  const impl = async (cmd, args, _opts) => {
    calls.push({ cmd, args });
    callCount += 1;
    if (throwOn && throwOn(cmd, args, callCount)) {
      const err = errorFactory ? errorFactory(callCount) : new Error('exec failed');
      err.stderr ||= 'simulated dispatch failure';
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

test('cfg.enabled=true + eligible dispatches with workerClass=codex by default', async () => {
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture();
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
  assert.equal(result.dispatchId, 'disp_test_0001');
  assert.equal(result.launchRequestId, 'lrq_test_0001');
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
  assert.ok(write.captured.body.includes(`PR ${dispatchContext.prUrl}`));
  assert.ok(write.captured.body.includes(reviewState.headSha));
  assert.ok(write.captured.body.includes('--squash'));
});

test('eligible AMA dispatch writes watcher-owned in_progress audit state before handoff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ama-audit-'));
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
    dispatchContext: { hqRoot: root },
  });
  const exec = buildExecMock();
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext: { ...dispatchContext, hqRoot: root },
    execFileImpl: exec.impl,
    readTemplateImpl: () => 'stubbed',
  });
  assert.equal(result.dispatched, true);
  const audit = JSON.parse(readFileSync(result.auditPath, 'utf8'));
  assert.equal(audit.status, 'in_progress');
  assert.equal(audit.reviewSha, reviewState.headSha);
  assert.equal(audit.authorizingEvidence.blockingFindingCount, 0);
  assert.equal(audit.closerDispatch.dispatchId, 'disp_test_0001');
  assert.equal(audit.closerDispatch.launchRequestId, 'lrq_test_0001');
});

// ---------------------------------------------------------------------------
// Test 4 — cfg.workerClass=claude-code surfaces in the hq dispatch args.
// ---------------------------------------------------------------------------

test('cfg.workerClass=claude-code routes the closer to claude-code', async () => {
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture({
    cfg: { workerClass: 'claude-code' },
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
  const { prMetadata, cfg, dispatchContext } = eligibleFixture({
    dispatchContext: { hqRoot: '/tmp/ama-test-hqroot' },
  });
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

test('dispatch failure returns dispatched=false, reason=dispatch-failed (caller falls through)', async () => {
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture();
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

test('AMA dispatch retries transient HQ failures before succeeding', async () => {
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture();
  const exec = buildExecMock({
    throwOn: (_cmd, _args, callCount) => callCount < 3,
    errorFactory: () => {
      const err = new Error('timed out');
      err.code = 'ETIMEDOUT';
      return err;
    },
  });
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: buildWriteMock().impl,
    readTemplateImpl: () => 'stubbed',
  });
  assert.equal(result.dispatched, true);
  assert.equal(exec.calls.length, 3);
});

test('AMA dispatch accepts legacy key=value stdout as a fallback', async () => {
  const { reviewState, prMetadata, cfg, dispatchContext } = eligibleFixture();
  const exec = buildExecMock({ stdout: 'dispatchId=legacy_ama_001\n' });
  const result = await maybeDispatchAmaCloser({
    reviewState,
    prMetadata,
    cfg,
    dispatchContext,
    execFileImpl: exec.impl,
    writeFileImpl: buildWriteMock().impl,
    readTemplateImpl: () => 'stubbed',
  });
  assert.equal(result.dispatched, true);
  assert.equal(result.dispatchId, 'legacy_ama_001');
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
