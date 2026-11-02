import './helpers/review-cli-resolver-fixture.mjs';
import './helpers/registry-session-fixture.mjs';
// MES-06: the review service records one shadow MES decision per review pass
// and per local remediation round through `hq mes decide --record --json`.
// Synthetic fixtures only: fake hq scripts, a synthetic diff, no host ledger.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MES_REMEDIATION_SIGNAL_KEYS, MES_REVIEW_SIGNAL_KEYS, mesActualExecution, mesDiffStats,
  mesRiskPathCount, recordMesDecision, recordRemediationMesShadow, recordReviewMesShadow,
  remediationMesSignals, reviewMesSignals,
} from '../src/mes-shadow-hook.mjs';
import { __test__ as harness, resolveReviewerExecution, resolveReviewerExecutionAsync } from '../src/reviewer-harness.mjs';
import { serviceFixtureExec, writeDummyCodexAuth } from './helpers/codex-service-fixture.mjs';

const quiet = { info() {}, log() {}, warn() {}, error() {} };
const HEAD = 'a'.repeat(40);
const TITLE = '[codex] (feat) EXAMPLE-01: synthetic change';
const SYNTHETIC_DIFF = [
  'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
  'index 1111111..2222222 100644',
  '--- a/.github/workflows/ci.yml',
  '+++ b/.github/workflows/ci.yml',
  '@@ -1,3 +1,4 @@',
  ' name: ci',
  '-on: push',
  '+on: [push, pull_request]',
  '+# synthetic',
  'diff --git a/src/example.mjs b/src/example.mjs',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/example.mjs',
  '@@ -0,0 +1,2 @@',
  '+export const a = 1;',
  '+--- not a header inside a hunk',
  'diff --git a/docs/old.md b/docs/old.md',
  'deleted file mode 100644',
  '--- a/docs/old.md',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-gone',
  '\\ No newline at end of file',
  '',
].join('\n');
const PATTERNS = ['*:.github/**', 'example-repo:secrets/**', 'other-repo:src/**'];

function decision(overrides = {}) {
  return { schemaVersion: 1, decisionId: 'mesd_synthetic', apply: false, recorded: true, recordError: null,
    reason: 'shadow', ...overrides };
}

// A fake exec that records argv and answers with scripted CLI outcomes.
function fakeExec(answers) {
  const calls = [];
  const impl = (file, args, options, callback) => {
    calls.push({ file, args, options, request: args[0] === 'mes' ? JSON.parse(args.at(-1)) : null });
    const answer = typeof answers === 'function' ? answers(calls.length, args) : answers[calls.length - 1];
    if (answer === 'hang') return {};
    queueMicrotask(() => {
      if (answer instanceof Error) callback(answer, '', '');
      else callback(answer.exitCode ? Object.assign(new Error('exit'), { code: answer.exitCode }) : null,
        answer.stdout ?? '', '');
    });
    return {};
  };
  return { impl, calls };
}

function fakeHq(t, body) {
  const root = mkdtempSync(join(tmpdir(), 'mes-shadow-hq-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'hq');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${root}/argv"\n${body}\n`, { mode: 0o700 });
  return { env: { ...process.env, HQ_BIN: bin }, argv: () => readFileSync(join(root, 'argv'), 'utf8') };
}

test('review signals are computed from a synthetic diff, with value-free closed keys', () => {
  const stats = mesDiffStats(SYNTHETIC_DIFF);
  assert.deepEqual(stats, { addedLines: 4, deletedLines: 2,
    paths: ['.github/workflows/ci.yml', 'src/example.mjs', 'docs/old.md'] });
  const signals = reviewMesSignals({ diff: SYNTHETIC_DIFF, title: TITLE, repo: 'example-org/example-repo',
    restrictedPatterns: PATTERNS });
  assert.deepEqual(signals, { diff_lines: 6, file_count: 3, risk_path_count: 1, risk_paths_touched: true,
    change_kind: 'feature', builder_prefix: 'codex' });
  assert.deepEqual(Object.keys(signals), MES_REVIEW_SIGNAL_KEYS);
  for (const value of Object.values(signals)) assert.ok(value === null || ['number', 'boolean'].includes(typeof value)
    || ['feature', 'codex'].includes(value));
});

test('unknown review evidence is null, never zero', () => {
  assert.deepEqual(reviewMesSignals({ diff: null }), { diff_lines: null, file_count: null, risk_path_count: null,
    risk_paths_touched: null, change_kind: null, builder_prefix: null });
  // No pattern source, a malformed pattern, or a noncanonical path cannot be counted.
  assert.equal(reviewMesSignals({ diff: SYNTHETIC_DIFF, repo: 'o/example-repo' }).risk_path_count, null);
  assert.equal(mesRiskPathCount(['src/a.mjs'], ['example-repo:src/{a,b}.mjs'], 'o/example-repo'), null);
  assert.equal(mesRiskPathCount(['src/a b.mjs'], PATTERNS, 'o/example-repo'), null);
  assert.equal(mesRiskPathCount(['src/a.mjs'], PATTERNS, null), null);
  // Repository qualification is honored; '**' spans components; '*' does not.
  assert.equal(mesRiskPathCount(['src/a.mjs', 'secrets/x/y'], PATTERNS, 'o/example-repo'), 1);
  assert.equal(mesRiskPathCount(['src/a.mjs'], PATTERNS, 'o/other-repo'), 1);
  assert.equal(mesRiskPathCount(['a/b/c.env'], ['*:a/*.env'], 'o/r'), 0);
  assert.equal(mesRiskPathCount(['a/b/c.env'], ['*:a/**/[!x]*.env'], 'o/r'), 1);
  // Unknown or untagged titles produce no enumeration value.
  assert.equal(reviewMesSignals({ diff: '', title: '[someone] EXAMPLE-01: x' }).builder_prefix, null);
  assert.equal(reviewMesSignals({ diff: '', title: '[codex] EXAMPLE-01: x' }).change_kind, null);
  assert.equal(reviewMesSignals({ diff: '', title: 'fix: x' }).change_kind, 'bug-fix');
});

test('remediation signals carry counts and the round fraction only', () => {
  const signals = remediationMesSignals({ blockingFindings: 4, nonBlockingFindings: 1, addedLines: 10,
    deletedLines: 2, fileCount: 3, roundsSoFar: 1, roundBudget: 3 });
  assert.deepEqual(signals, { blocking_findings: 4, nonblocking_findings: 1, diff_lines: 12, file_count: 3,
    rounds_so_far: 1, round_budget: 3, round_fraction: 1 / 3 });
  assert.deepEqual(Object.keys(signals), MES_REMEDIATION_SIGNAL_KEYS);
  assert.deepEqual(remediationMesSignals({ roundsSoFar: 0, roundBudget: 0, addedLines: 1 }), {
    blocking_findings: null, nonblocking_findings: null, diff_lines: null, file_count: null,
    rounds_so_far: 0, round_budget: 0, round_fraction: null });
});

test('resolver provenance maps to ledger sources; explicit sources are never defaults', () => {
  const base = { workerClass: 'codex-reviewer', model: 'm', effort: 'medium' };
  assert.equal(mesActualExecution({ ...base, modelSource: 'registry', effortSource: 'registry' }).source, 'registry');
  assert.equal(mesActualExecution({ ...base, modelSource: 'committed-seed' }).source, 'static-default');
  assert.equal(mesActualExecution({ ...base, modelSource: 'env-pin' }).source, 'env');
  assert.equal(mesActualExecution({ ...base, modelSource: 'registry', effortSource: 'env' }).source, 'env');
  assert.equal(mesActualExecution({ ...base, modelSource: 'env-pin', reviewerArm: true }).source, 'reviewerArm');
  assert.equal(mesActualExecution({ ...base, source: 'osg-remediator' }).source, 'osg-apply');
  assert.equal(mesActualExecution({ ...base, modelSource: 'non-blocking-config' }).source, 'env');
  assert.equal(mesActualExecution({ ...base, modelSource: 'something-new' }), null);
});

test('real exec: CLI absent, timeout, garbage and CLI errors fail open with a fixed reason', async t => {
  const request = { workKind: 'review', subjectKey: 'o/r/pr/1/review/x', signals: {}, actual: {} };
  const absent = await recordMesDecision(request, { execFileImpl: execFile,
    env: { ...process.env, HQ_BIN: join(tmpdir(), 'mes-shadow-no-such-hq') } });
  assert.deepEqual(absent, { recorded: false, reason: 'cli-absent', attempt: 1 });

  const slow = fakeHq(t, 'sleep 5');
  const startedMs = Date.now();
  const timedOut = await recordMesDecision(request, { execFileImpl: execFile, env: slow.env, timeoutMs: 300 });
  assert.equal(timedOut.reason, 'timeout');
  assert.ok(Date.now() - startedMs < 3_000, 'the bound holds');

  const garbage = fakeHq(t, "echo 'Traceback (most recent call last):'; exit 1");
  assert.equal((await recordMesDecision(request, { execFileImpl: execFile, env: garbage.env })).reason, 'garbage-output');

  const unavailable = fakeHq(t, `echo '{"schemaVersion": 1, "apply": false, "error": "mes-unavailable"}'; exit 1`);
  assert.equal((await recordMesDecision(request, { execFileImpl: execFile, env: unavailable.env })).reason, 'mes-unavailable');

  const recorded = fakeHq(t, `echo 'warning on stdout'; echo '${JSON.stringify(decision())}'`);
  const ok = await recordMesDecision(request, { execFileImpl: execFile, env: recorded.env });
  assert.equal(ok.recorded, true);
  assert.equal(ok.decisionId, 'mesd_synthetic');
  const argv = recorded.argv().trim().split('\n');
  assert.deepEqual(argv.slice(0, 5), ['mes', 'decide', '--record', '--json', '--request-json']);
  assert.deepEqual(JSON.parse(argv[5]), { ...request, attempt: 1 });
});

test('a duplicate subject attempt advances to the next attempt; the ledger key arbitrates', async () => {
  const exec = fakeExec([{ exitCode: 1, stdout: JSON.stringify(decision({ recorded: false, recordError: 'duplicate' })) },
    { stdout: JSON.stringify(decision({ decisionId: 'mesd_second' })) }]);
  const result = await recordMesDecision({ workKind: 'review' }, { execFileImpl: exec.impl, env: {} });
  assert.equal(result.recorded, true);
  assert.equal(result.attempt, 2);
  assert.deepEqual(exec.calls.map(call => call.request.attempt), [1, 2]);
  const exhausted = fakeExec(() => ({ exitCode: 1, stdout: JSON.stringify(decision({ recorded: false, recordError: 'duplicate' })) }));
  assert.equal((await recordMesDecision({}, { execFileImpl: exhausted.impl, env: {}, maxAttempts: 2 })).reason, 'attempts-exhausted');
  assert.equal(exhausted.calls.length, 2);
  const ledger = fakeExec([{ exitCode: 1, stdout: JSON.stringify(decision({ recorded: false, recordError: 'ledger-error' })) }]);
  assert.equal((await recordMesDecision({}, { execFileImpl: ledger.impl, env: {} })).reason, 'ledger-error');
  const throwing = await recordMesDecision({}, { execFileImpl: () => { throw new Error('boom'); }, env: {} });
  assert.equal(throwing.reason, 'exec-error');
});

test('offline suites never reach a host hq without an injected exec', async () => {
  assert.equal(process.env.NODE_TEST_CONTEXT !== undefined || process.env.ADVERSARIAL_REVIEW_TEST_SANDBOX_ROOT !== undefined, true);
  assert.deepEqual(await recordMesDecision({}, { env: {} }), { recorded: false, reason: 'test-context' });
  assert.deepEqual(await recordReviewMesShadow({ harness: 'codex', execution: {}, log: quiet }),
    { recorded: false, reason: 'test-context' });
});

test('review: the reported actual execution equals the resolver output, which is returned unchanged', async () => {
  const exec = fakeExec(() => ({ stdout: JSON.stringify(decision()) }));
  const mes = { repo: 'example-org/example-repo', prNumber: 7, headSha: HEAD, title: TITLE, diff: SYNTHETIC_DIFF,
    restrictedPatterns: PATTERNS, execFileImpl: exec.impl };
  const ready = async () => true;
  for (const [harnessName, pins] of [['codex', {}], ['claude', { modelPin: '', reasoningPin: '' }],
    ['codex', { reasoningPin: 'low' }]]) {
    exec.calls.length = 0;
    const expected = resolveReviewerExecution(harnessName, { env: {}, log: quiet, ...pins });
    const actual = await resolveReviewerExecutionAsync(harnessName, { env: {}, log: quiet, ...pins, mes,
      ensureWorkerRegistryReadyImpl: ready });
    assert.deepEqual(actual, expected);
    assert.equal(exec.calls.length, 1, 'one decision for the pass');
    const { request } = exec.calls[0];
    assert.deepEqual({ model: request.actual.model, effort: request.actual.effort },
      { model: expected.model, effort: expected.effort });
    assert.equal(request.actual.workerClass, `${harnessName}-reviewer`);
    assert.equal(request.actual.source, pins.reasoningPin ? 'env' : 'registry');
    assert.deepEqual(request, { workKind: 'review', subjectKey: `example-org/example-repo/pr/7/review/${HEAD}`,
      prNumber: 7, headSha: HEAD, attempt: 1, actual: request.actual,
      signals: { diff_lines: 6, file_count: 3, risk_path_count: 1, risk_paths_touched: true,
        change_kind: 'feature', builder_prefix: 'codex' } });
    // Value-free: no title or path text crosses the process boundary.
    const sent = exec.calls[0].args.join(' ');
    for (const secret of ['synthetic change', '.github', 'src/example.mjs', 'EXAMPLE-01']) assert.ok(!sent.includes(secret));
  }
});

test('review: CLI absent, timeout or garbage output leaves the execution unchanged', async () => {
  const expected = resolveReviewerExecution('codex', { env: {}, log: quiet });
  const outcomes = [Object.assign(new Error('spawn hq ENOENT'), { code: 'ENOENT' }), 'hang', { stdout: 'not json' },
    { stdout: JSON.stringify({ schemaVersion: 2 }) }, { stdout: JSON.stringify(decision({ apply: true,
      choice: { workerClass: 'codex-reviewer', model: 'other-model', effort: 'low' } })) }];
  for (const outcome of outcomes) {
    const warnings = [];
    const exec = fakeExec([outcome]);
    const startedMs = Date.now();
    const actual = await resolveReviewerExecutionAsync('codex', { env: {}, ensureWorkerRegistryReadyImpl: async () => true,
      log: { ...quiet, warn: message => warnings.push(message) },
      mes: { repo: 'o/r', prNumber: 1, headSha: HEAD, diff: '', restrictedPatterns: [], execFileImpl: exec.impl, timeoutMs: 200 } });
    assert.deepEqual(actual, expected, 'shadow never changes the chosen execution, even when the CLI says apply');
    assert.ok(Date.now() - startedMs < 2_000);
    if (outcome?.stdout?.includes('"recorded":true')) continue;
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^\[mes-shadow\] review decision not recorded reason=(cli-absent|timeout|garbage-output); execution unchanged$/);
  }
});

test('review: no subject means no record, with a logged reason; resolution without a pass context never records', async () => {
  const exec = fakeExec(() => ({ stdout: JSON.stringify(decision()) }));
  const warnings = [];
  const log = { ...quiet, warn: message => warnings.push(message) };
  await resolveReviewerExecutionAsync('codex', { env: {}, log, ensureWorkerRegistryReadyImpl: async () => true,
    mes: { repo: 'o/r', prNumber: 1, headSha: 'not-a-sha', diff: '', execFileImpl: exec.impl } });
  await resolveReviewerExecutionAsync('codex', { env: {}, log, ensureWorkerRegistryReadyImpl: async () => true });
  resolveReviewerExecution('codex', { env: {}, log });
  assert.equal(exec.calls.length, 0);
  assert.deepEqual(warnings, ['[mes-shadow] review decision not recorded reason=invalid-subject; execution unchanged']);
});

test('review: dispatchReviewerModel forwards the pass context once and marks reviewerArm pins', async () => {
  const seen = [];
  const reviewWithCodexImpl = async (_diff, _context, options) => {
    seen.push(options);
    return { reviewText: 'x', tokenUsage: null, execution: null };
  };
  await harness.dispatchReviewerModel('codex', '+x', '', { reviewWithCodexImpl });
  assert.equal('mes' in seen[0], false, 'no context, no option: callers without MES are byte-identical');
  const mes = { repo: 'o/r', prNumber: 1, headSha: HEAD, diff: '+x' };
  await harness.dispatchReviewerModel('codex', '+x', '', { reviewWithCodexImpl, mes,
    reviewerArm: { harness: 'codex', model: 'arm-model', effort: 'low' } });
  assert.deepEqual(seen[1].mes, { ...mes, reviewerArm: true });
  assert.equal(seen[1].modelPin, 'arm-model');
  await harness.dispatchReviewerModel('codex', '+x', '', { reviewWithCodexImpl, mes });
  assert.deepEqual(seen[2].mes, { ...mes, reviewerArm: false });
  // Gemini receives no arm pins, so its env pin is never labelled as the arm's.
  await harness.dispatchReviewerModel('gemini', '+x', '', { reviewWithGeminiImpl: reviewWithCodexImpl, mes,
    reviewerArm: { harness: 'gemini', model: 'arm-model', effort: 'low' } });
  assert.deepEqual(seen[3].mes, { ...mes, reviewerArm: false });
  assert.equal('modelPin' in seen[3], false);
});

test('review: a full codex pass writes exactly one decision and runs the resolver execution', async t => {
  const authRoot = mkdtempSync(join(tmpdir(), 'mes-shadow-auth-'));
  t.after(() => rmSync(authRoot, { recursive: true, force: true }));
  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  Object.assign(process.env, { AGENT_OS_CODEX_PER_WORKER_AUTH: '0', CODEX_BROKER_PROVIDER: 'codex',
    CODEX_REVIEWER_AUTH_PROVIDER: '', CODEX_HOME: '', CODEX_AUTH_PATH: writeDummyCodexAuth(join(authRoot, 'auth.json')) });
  const exec = fakeExec(() => ({ stdout: JSON.stringify(decision()) }));
  const expected = resolveReviewerExecution('codex', { log: quiet });
  let sent = null;
  const result = await harness.reviewWithCodex(SYNTHETIC_DIFF, '', {
    log: quiet, codexCli: process.execPath, assertCodexOAuthImpl: async () => {}, execFileSyncImpl: serviceFixtureExec,
    mes: { repo: 'o/r', prNumber: 3, headSha: HEAD, diff: SYNTHETIC_DIFF, restrictedPatterns: [], execFileImpl: exec.impl },
    spawnCodexReviewImpl: async ({ model, configOverrides }) => {
      sent = { model, effort: configOverrides.find(item => item.key === 'model_reasoning_effort')?.value ?? null };
      return { stdout: '## Summary\nSynthetic.\n\n## Verdict\nComment only', stderr: '' };
    },
  });
  assert.equal(exec.calls.length, 1);
  assert.deepEqual(sent, { model: expected.model, effort: expected.effort });
  assert.deepEqual({ model: result.execution.model, effort: result.execution.effort }, sent);
  assert.deepEqual({ model: exec.calls[0].request.actual.model, effort: exec.calls[0].request.actual.effort }, sent);
});

function remediationJob(overrides = {}) {
  return {
    repo: 'example-org/example-repo', prNumber: 12, baseBranch: 'main', revisionRef: HEAD,
    reviewBody: 'synthetic review body', remediationPlan: { currentRound: 2, maxRounds: 3 }, ...overrides,
  };
}

const codexWorker = { resolvedModel: 'gpt-6.1-sol', resolvedReasoningLevel: 'medium', modelSource: 'registry',
  reasoningSource: 'registry', launchRequestId: 'local-reply-key', processId: 1 };

test('remediation: one decision per round with the spawned worker resolution as actual', async () => {
  const exec = fakeExec((_n, args) => (args[0] === '--no-optional-locks'
    ? { stdout: '3\t1\tsrc/a.mjs\n5\t0\tsrc/b.mjs\n' } : { stdout: JSON.stringify(decision()) }));
  const workerBefore = structuredClone(codexWorker);
  const outcome = await recordRemediationMesShadow({ job: remediationJob(), workerClass: 'codex', worker: codexWorker,
    workspaceDir: '/synthetic/workspace', env: {}, execFileImpl: exec.impl, log: quiet,
    classifyFindingsImpl: async () => ({ blockingFindings: 4, nonBlockingFindings: 2 }) });
  assert.equal(outcome.recorded, true);
  assert.deepEqual(codexWorker, workerBefore, 'the worker descriptor is read, never modified');
  const hqCalls = exec.calls.filter(call => call.request);
  assert.equal(hqCalls.length, 1);
  assert.deepEqual(exec.calls[0].args, ['--no-optional-locks', '-C', '/synthetic/workspace', 'diff', '--numstat',
    'origin/main...HEAD']);
  assert.deepEqual(hqCalls[0].request, {
    workKind: 'remediation', subjectKey: 'example-org/example-repo/pr/12/remediation/round-2', prNumber: 12,
    headSha: HEAD, attempt: 1,
    signals: { blocking_findings: 4, nonblocking_findings: 2, diff_lines: 9, file_count: 2, rounds_so_far: 1,
      round_budget: 3, round_fraction: 1 / 3 },
    actual: { workerClass: 'remediator-codex', model: 'gpt-6.1-sol', effort: 'medium', source: 'registry' },
  });
  assert.equal('launchRequestId' in hqCalls[0].request, false, 'local remediation has no dispatcher LRQ');
});

test('remediation: real review-body classification, explicit sources and failure modes never throw', async () => {
  const exec = fakeExec((_n, args) => (args[0] === '--no-optional-locks' ? new Error('git failed')
    : { stdout: JSON.stringify(decision()) }));
  const reviewBody = '## Summary\nS.\n\n## Blocking issues\n- **A**\n  - **Problem:** p\n\n## Non-blocking issues\n- None.\n\n## Verdict\nRequest changes';
  await recordRemediationMesShadow({ job: remediationJob({ reviewBody }), workerClass: 'remediator-claude',
    worker: { resolvedModel: 'claude-opus-5-5', resolvedReasoningLevel: 'high', modelSource: 'env-pin', reasoningSource: 'env' },
    workspaceDir: '/w', env: {}, execFileImpl: exec.impl, log: quiet });
  const { request } = exec.calls.find(call => call.request);
  assert.equal(request.actual.workerClass, 'remediator-claude');
  assert.equal(request.actual.source, 'env');
  assert.equal(request.signals.blocking_findings, 1);
  assert.equal(request.signals.nonblocking_findings, 0);
  assert.equal(request.signals.diff_lines, null, 'an unreadable diff is unknown, never zero');

  const warnings = [];
  const log = { ...quiet, warn: message => warnings.push(message) };
  const absent = fakeExec(() => Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  assert.equal((await recordRemediationMesShadow({ job: remediationJob(), workerClass: 'codex', worker: codexWorker,
    env: {}, execFileImpl: absent.impl, log })).reason, 'cli-absent');
  assert.equal((await recordRemediationMesShadow({ job: remediationJob(), workerClass: 'unknown', worker: codexWorker,
    env: {}, execFileImpl: absent.impl, log })).reason, 'unmapped-worker-class');
  assert.equal((await recordRemediationMesShadow({ job: remediationJob({ remediationPlan: {} }), workerClass: 'codex',
    worker: codexWorker, env: {}, execFileImpl: absent.impl, log })).reason, 'invalid-subject');
  assert.equal((await recordRemediationMesShadow({ job: null, workerClass: 'codex', worker: null, env: {},
    execFileImpl: absent.impl, log })).reason, 'unmapped-source');
  assert.equal(warnings.length, 4);
  // The OSG remediator arm is an explicit source that wins over MES.
  const osg = fakeExec(() => ({ stdout: JSON.stringify(decision()) }));
  await recordRemediationMesShadow({ job: remediationJob(), workerClass: 'codex', env: {}, execFileImpl: osg.impl,
    log: quiet, worker: { resolvedModel: 'gpt-6-luna', resolvedReasoningLevel: 'low', source: 'osg-remediator' } });
  assert.equal(osg.calls.find(call => call.request).request.actual.source, 'osg-apply');
});

test('remediation: request resolution fallback, binary numstat file count and uppercase head normalization', async () => {
  const exec = fakeExec((_n, args) => (args[0] === '--no-optional-locks'
    ? { stdout: '3\t1\tsrc/a.mjs\n-\t-\tassets/logo.png\n' } : { stdout: JSON.stringify(decision()) }));
  // A process-handle-shaped worker without resolution fields falls back to the request's resolution whole.
  await recordRemediationMesShadow({ job: remediationJob({ revisionRef: 'A'.repeat(40) }), workerClass: 'codex',
    worker: { launchRequestId: 'local-reply-key', processId: 1 }, modelResolution: codexWorker,
    workspaceDir: '/synthetic/workspace', env: {}, execFileImpl: exec.impl, log: quiet,
    classifyFindingsImpl: async () => ({}) });
  const { request } = exec.calls.find(call => call.request);
  assert.deepEqual(request.actual, { workerClass: 'remediator-codex', model: 'gpt-6.1-sol', effort: 'medium',
    source: 'registry' });
  assert.equal(request.signals.diff_lines, null, 'a binary file leaves line counts unknown');
  assert.equal(request.signals.file_count, 2, 'a binary file still counts as a changed file');
  assert.equal(request.headSha, HEAD, 'an uppercase head is normalized to git lowercase hex');

  // A descriptor that carries its own resolution wins; fields are never mixed with the request's.
  const own = fakeExec(() => ({ stdout: JSON.stringify(decision()) }));
  await recordRemediationMesShadow({ job: remediationJob(), workerClass: 'codex', env: {}, execFileImpl: own.impl,
    log: quiet, worker: { resolvedModel: 'gpt-6-luna', modelSource: 'env-pin' }, modelResolution: codexWorker });
  assert.deepEqual(own.calls.find(call => call.request).request.actual,
    { workerClass: 'remediator-codex', model: 'gpt-6-luna', effort: null, source: 'env' });

  const review = fakeExec(() => ({ stdout: JSON.stringify(decision()) }));
  await recordReviewMesShadow({ harness: 'codex', repo: 'o/r', prNumber: 1, headSha: 'A'.repeat(40), diff: '',
    restrictedPatterns: [], env: {}, execFileImpl: review.impl, log: quiet,
    execution: { model: 'gpt-6.1-sol', effort: 'high', modelSource: 'registry', effortSource: 'registry' } });
  const reviewRequest = review.calls.find(call => call.request).request;
  assert.equal(reviewRequest.headSha, HEAD);
  assert.equal(reviewRequest.subjectKey, `o/r/pr/1/review/${HEAD}`);
});
