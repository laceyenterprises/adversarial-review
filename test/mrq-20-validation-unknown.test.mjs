// MRQ-20: a host-local validation that times out, is killed for load or is
// denied process inspection is UNKNOWN. UNKNOWN never blocks a merge whose
// exact head's declared required contexts are green, never passes when they
// are red, pending, absent or undeclared, and a genuine local failure still
// blocks. Synthetic repositories and checks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config-loader.mjs';
import { classifyCheckRollup } from '../src/checks-summary.mjs';
import { evaluateMergeEligibility } from '../src/ama/merge-eligibility.mjs';
import { resolveRepositoryRequiredCheckContexts, resolveRequiredCheckContextsFromCfg }
  from '../src/ama/required-check-contexts.mjs';
import {
  UNKNOWN_CONTEXTS_NOT_GREEN, UNKNOWN_CONTEXTS_UNDECLARED, recordedUnknownDefersToCi,
  unknownValidationCiGate, unknownValidationDeferral,
} from '../src/ama/local-validation-unknown.mjs';
import { classifyQueueChecks, resolveQueueRequiredSet } from '../src/finalization/queue-check-reader.mjs';
import { queueLocalValidationUnknown, validateQueueHandoff } from '../src/finalization/queue-handoff.mjs';
import { queueHandoffFixture } from './helpers/queue-handoff-fixture.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';

const REPO = 'example/alpha';
const OTHER = 'example/beta';
const HEAD = 'a'.repeat(40);
const cfg = { requiredCheckContexts: [],
  requiredCheckContextsByRepository: [{ repository: REPO, contexts: ['repo-guards'] }] };
const run = (name, conclusion = 'SUCCESS') => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion });
const green = [run('repo-guards'), run('lint')];

test('repository-scoped contexts bind to one repository and keep global callers unchanged', () => {
  assert.deepEqual(resolveRequiredCheckContextsFromCfg(cfg, { repository: REPO }), ['repo-guards']);
  assert.deepEqual(resolveRequiredCheckContextsFromCfg(cfg, { repository: 'Example/Alpha' }), ['repo-guards']);
  assert.deepEqual(resolveRequiredCheckContextsFromCfg(cfg, { repository: OTHER }), []);
  // No repository: exactly the pre-MRQ-20 global list.
  assert.deepEqual(resolveRequiredCheckContextsFromCfg(cfg), []);
  const both = { requiredCheckContexts: ['unit'], requiredCheckContextsByRepository: cfg.requiredCheckContextsByRepository };
  assert.deepEqual(resolveRequiredCheckContextsFromCfg(both, { repository: REPO }), ['unit', 'repo-guards']);
  assert.deepEqual(resolveRequiredCheckContextsFromCfg(both, { repository: OTHER }), ['unit']);
  assert.deepEqual(resolveRepositoryRequiredCheckContexts({ requiredCheckContextsByRepository: 'bad' }, REPO), []);
});

test('the config loader round-trips repository-scoped required contexts and rejects malformed entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrq20-config-'));
  try {
    const top = join(dir, 'config.yaml');
    writeFileSync(top, 'version: 1\n');
    assert.deepEqual(loadConfig({ topPath: top, env: {} }).getMergeAuthorityConfig().requiredCheckContextsByRepository, []);
    writeFileSync(top, `version: 1\nroles:\n  adversarial:\n    merge_authority:\n      required_check_contexts_by_repository:\n        - repository: ${REPO}\n          contexts: [repo-guards]\n`);
    const loaded = loadConfig({ topPath: top, env: {} });
    assert.deepEqual(loaded.getMergeAuthorityConfig().requiredCheckContextsByRepository,
      [{ repository: REPO, contexts: ['repo-guards'] }]);
    assert.deepEqual(resolveRequiredCheckContextsFromCfg(loaded, { repository: REPO }), ['repo-guards']);
    for (const entry of ['        - repository: not-a-repo\n          contexts: [x]\n',
      `        - repository: ${REPO}\n          contexts: []\n`, '        - contexts: [x]\n']) {
      writeFileSync(top, `version: 1\nroles:\n  adversarial:\n    merge_authority:\n      required_check_contexts_by_repository:\n${entry}`);
      assert.throws(() => loadConfig({ topPath: top, env: {} }), entry);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('timeout + green declared CI => eligible; timeout + red CI => blocked', () => {
  const requiredContexts = resolveRequiredCheckContextsFromCfg(cfg, { repository: REPO });
  assert.equal(unknownValidationDeferral({ reason: 'absolute-timeout', requiredContexts }).ciAuthoritative, true);
  assert.deepEqual(unknownValidationCiGate({ checks: green, requiredContexts }), { ok: true, conclusion: 'SUCCESS' });
  const red = unknownValidationCiGate({ checks: [run('repo-guards', 'FAILURE'), run('lint')], requiredContexts });
  assert.equal(red.ok, false);
  assert.equal(red.reason, UNKNOWN_CONTEXTS_NOT_GREEN);
  const pending = unknownValidationCiGate({ checks: [{ __typename: 'CheckRun', name: 'repo-guards', status: 'IN_PROGRESS' }], requiredContexts });
  assert.equal(pending.ok, false);
});

test('a declared-but-absent required context is not green', () => {
  const requiredContexts = ['repo-guards'];
  assert.equal(classifyCheckRollup([run('lint')], { requiredContexts }), 'PENDING');
  assert.equal(unknownValidationCiGate({ checks: [run('lint')], requiredContexts }).ok, false);
  const state = { verdict: 'settled-success', leaseHeld: true, mergeable: 'MERGEABLE', labels: [],
    branchProtectionRequired: false, candidateHead: HEAD, validatedHead: HEAD, requiredChecks: [run('lint')] };
  assert.equal(evaluateMergeEligibility(state).eligible, true, 'without a declaration the old shape still reads green');
  assert.deepEqual(evaluateMergeEligibility({ ...state, requiredCheckContexts: requiredContexts }).reasons, ['ci-not-green']);
});

test('UNKNOWN with no declared contexts, a real failure, or an ineligible stop never defers to CI', () => {
  assert.equal(unknownValidationCiGate({ checks: green, requiredContexts: [] }).reason, UNKNOWN_CONTEXTS_UNDECLARED);
  const contexts = ['repo-guards'];
  assert.equal(unknownValidationDeferral({ reason: 'absolute-timeout', requiredContexts: [] }).ciAuthoritative, false);
  assert.equal(unknownValidationDeferral({ reason: 'absolute-timeout', requiredContexts: contexts,
    localFailureObserved: true }).ciAuthoritative, false);
  for (const reason of ['validation-drain-unconfirmed', 'canceled:SIGTERM', undefined]) {
    assert.equal(unknownValidationDeferral({ reason, requiredContexts: contexts }).ciAuthoritative, false, reason);
  }
  for (const reason of ['no-progress-timeout', 'child-check-timeout', 'process-inspection-unavailable',
    'validation-budget-exceeded', 'validation-killed']) {
    assert.equal(unknownValidationDeferral({ reason, requiredContexts: contexts }).ciAuthoritative, true, reason);
  }
  const receipt = { validation: 'unknown', reason: 'absolute-timeout', ciAuthoritative: true,
    cleanup: 'finished', coverageComplete: true, localFailureObserved: false };
  assert.equal(recordedUnknownDefersToCi(receipt, contexts), true);
  assert.equal(recordedUnknownDefersToCi(receipt, []), false);
  for (const ciAuthoritative of [false, undefined]) {
    assert.equal(recordedUnknownDefersToCi({ ...receipt, ciAuthoritative }, contexts), false);
  }
  assert.equal(recordedUnknownDefersToCi({ unreadable: true }, contexts), false);
});

// ---- bin/hammer-validate.mjs, with only the process boundary replaced ----

const validator = new URL('../bin/hammer-validate.mjs', import.meta.url).pathname;
const boundedHref = new URL('../bin/hammer-validate.mjs', import.meta.url).href;

function fixture(t, { declared = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mrq20-validate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts/ci-mirror'), { recursive: true });
  writeFileSync(join(root, 'scripts/ci-mirror/run-ci-mirror.py'), '');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--no-verify', '--allow-empty', '-qm', 'Synthetic validation');
  const config = join(root, 'cfg', 'config.yaml');
  mkdirSync(join(root, 'cfg'));
  writeFileSync(config, declared
    ? `version: 1\nroles:\n  adversarial:\n    merge_authority:\n      required_check_contexts_by_repository:\n        - repository: ${REPO}\n          contexts: [repo-guards]\n`
    : 'version: 1\n');
  return { root, head: git('rev-parse', 'HEAD'), config };
}

// scenario: { stop?: [reason, status], rows?: [...], output?: string, exit: number }
function runValidator({ root, head, config }, scenario, extraArgs = ['--canonical', '--', 'src/example.py']) {
  const receipt = join(root, 'validation.json');
  const calls = join(root, 'battery-calls');
  const runner = `
    import { appendFileSync, writeFileSync } from 'node:fs';
    export async function runBounded(_command, _args, options) {
      appendFileSync(${JSON.stringify(calls)}, 'run\\n');
      const scenario = ${JSON.stringify(scenario)};
      if (scenario.rows) writeFileSync(process.env.HAM_CLOSE_VALIDATION_RECEIPT, JSON.stringify({ checks: scenario.rows }));
      if (scenario.output) options.observeOutput(scenario.output);
      if (scenario.concurrentReceipt) writeFileSync(${JSON.stringify(join(root, `validation-deferred-${head}.json`))},
        JSON.stringify(scenario.concurrentReceipt));
      if (scenario.stop) options.observeStop(...scenario.stop);
      return scenario.exit;
    }`;
  const loader = join(root, 'loader.mjs');
  writeFileSync(loader, `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL === ${JSON.stringify(boundedHref)} && specifier === '../src/ama/bounded-command.mjs') {
        return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(runner)}) };
      }
      return next(specifier, context);
    } });
  `);
  const env = { ...process.env, HAM_RUN_DIR: root, HAM_CLOSE_VALIDATION_RECEIPT: receipt,
    HAM_LOCAL_VALIDATION_CI_DEDUP: '0', HAM_HQ_ROOT: root, HAM_REPO: REPO, HAM_PR_NUMBER: '42',
    AGENT_OS_CONFIG_PATH: config, TMPDIR: root };
  for (const key of ['HQ_LAUNCH_REQUEST_ID', 'LAUNCH_REQUEST_ID', 'HQ_WORKER_RUN_ID', 'HAM_CONTROLLER_RECORD']) delete env[key];
  const result = spawnSync(process.execPath, ['--import', loader, validator, ...extraArgs], {
    cwd: root, encoding: 'utf8', timeout: 20_000, env });
  assert.ifError(result.error);
  return { ...result, batteries: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0 };
}

const deferralOf = ({ root, head }) => {
  const path = join(root, `validation-deferred-${head}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
};

test('hammer-validate: declared contexts without proof of local guards leave a timeout blocking', t => {
  const repo = fixture(t);
  const first = runValidator(repo, { stop: ['absolute-timeout', 124], exit: 124 });
  assert.equal(first.status, 124, first.stderr);
  assert.match(first.stderr, /canonical-validation-deferred/);
  const receipt = deferralOf(repo);
  assert.equal(receipt.validation, 'unknown');
  assert.equal(receipt.ciAuthoritative, false);
  assert.deepEqual(receipt.requiredContexts, ['repo-guards']);
  const check = runValidator(repo, { exit: 0 }, ['--check-deferred']);
  assert.equal(check.status, 75, check.stderr);
  const again = runValidator(repo, { exit: 1 });
  assert.equal(again.status, 75, again.stderr);
  assert.equal(again.batteries, 1, 'the recorded UNKNOWN is reused, not re-run');
});

test('hammer-validate: without declared contexts a timeout keeps the existing deferral', t => {
  const repo = fixture(t, { declared: false });
  const result = runValidator(repo, { stop: ['absolute-timeout', 124], exit: 124 });
  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stderr, /canonical-validation-deferred/);
  assert.equal(deferralOf(repo).ciAuthoritative, false);
  assert.equal(runValidator(repo, { exit: 0 }, ['--check-deferred']).status, 75);
});

test('hammer-validate: a concurrently recorded deferral decides only if its exact-head evidence permits CI', t => {
  for (const [receiptOverride, exit, expected] of [[{}, 124, 0], [{ ciAuthoritative: false }, 124, 75],
    [{ head: HEAD }, 124, 75], [{}, 125, 125]]) {
    const repo = fixture(t);
    const concurrentReceipt = { head: repo.head, validation: 'unknown', reason: 'absolute-timeout',
      ciAuthoritative: true, localFailureObserved: false, ...receiptOverride };
    const first = runValidator(repo, { concurrentReceipt, stop: ['absolute-timeout', 124], exit });
    assert.equal(first.status, expected, first.stderr);
    assert.deepEqual(deferralOf(repo), concurrentReceipt);
  }
});

test('a clean conflict rebase retains cleanup evidence for publication after a timeout', t => {
  for (const declared of [true, false]) {
    const repo = fixture(t, { declared });
    writeFileSync(join(repo.root, '.git/info/exclude'), '/*\n');
    writeFileSync(join(repo.root, 'conflict-repair-publish.env'),
      `source=${HEAD}\nhead=${repo.head}\nbranch=feature\n`);
    const result = runValidator(repo, { stop: ['absolute-timeout', 124], exit: 124 });
    assert.equal(result.status, declared ? 0 : 124, result.stderr);
    const receipt = deferralOf(repo);
    assert.equal(receipt.cleanCheckout, true);
    assert.equal(receipt.cleanupConfirmed, true);
    assert.equal(receipt.localValidationReceipt, join(repo.root, 'validation.json'));
    const state = runValidator(repo, { exit: 1 }, ['--check-rebase-publication']);
    assert.equal(state.status, 0, state.stderr);
    assert.equal(state.stdout.trim(), declared ? 'ci' : 'redrive');
    assert.equal(state.batteries, 1);
    const repeated = runValidator(repo, { exit: 1 });
    assert.equal(repeated.status, declared ? 0 : 75, repeated.stderr);
    assert.equal(repeated.batteries, 1);
    for (const evidence of ['{"checks":[{"result":"fail"}]}', '{']) {
      writeFileSync(receipt.localValidationReceipt, evidence);
      const blocked = runValidator(repo, { exit: 1 }, ['--check-rebase-publication']);
      assert.equal(blocked.status, 0, blocked.stderr);
      assert.equal(blocked.stdout.trim(), 'blocked');
      assert.equal(blocked.batteries, 1);
    }
    writeFileSync(receipt.localValidationReceipt, '{"checks":[]}');
    writeFileSync(join(repo.root, `validation-deferred-${repo.head}.json`), JSON.stringify({
      ...receipt, cleanupConfirmed: false,
    }));
    const undrained = runValidator(repo, { exit: 1 });
    assert.equal(undrained.status, 75, undrained.stderr);
    assert.equal(undrained.batteries, 1);
  }
});

test('hammer-validate: a real local failure still blocks', t => {
  const repo = fixture(t);
  const failed = runValidator(repo, { rows: [{ name: 'unit', status: 'failed', result: 'fail' }], exit: 42 });
  assert.equal(failed.status, 42, failed.stderr);
  assert.equal(deferralOf(repo), null, 'a red check is not UNKNOWN');
});

test('hammer-validate: a failure observed before the stop keeps the head blocking', t => {
  const mirror = fixture(t);
  const afterRed = runValidator(mirror, { rows: [{ name: 'unit', status: 'failed', result: 'fail' }],
    stop: ['absolute-timeout', 124], exit: 124 });
  assert.notEqual(afterRed.status, 0);
  assert.equal(deferralOf(mirror).ciAuthoritative, false);
  assert.equal(deferralOf(mirror).localFailureObserved, true);
  const tap = fixture(t);
  const afterNotOk = runValidator(tap, { output: 'ok 1 - a\nnot ok 2 - b\n', stop: ['no-progress-timeout', 124], exit: 124 });
  assert.notEqual(afterNotOk.status, 0);
  assert.equal(deferralOf(tap).ciAuthoritative, false);
});

test('hammer-validate: the mirror budget stop and an external kill are UNKNOWN, not failed checks', t => {
  const budget = fixture(t);
  const overBudget = runValidator(budget, { rows: [{ name: 'unit', status: 'run', result: 'pass' }], exit: 75 });
  assert.equal(overBudget.status, 75, overBudget.stderr);
  assert.equal(deferralOf(budget).reason, 'validation-budget-exceeded');
  const killed = fixture(t);
  const sigkill = runValidator(killed, { exit: 137 });
  assert.equal(sigkill.status, 137, sigkill.stderr);
  assert.equal(deferralOf(killed).reason, 'validation-killed');
  // Without declared contexts the same stop is an UNKNOWN deferral, never a pass.
  const undeclared = fixture(t, { declared: false });
  const deferred = runValidator(undeclared, { exit: 137 });
  assert.equal(deferred.status, 137);
  assert.equal(deferralOf(undeclared).ciAuthoritative, false);
});

// ---- the hammer's exact-head merge gate (bin/hammer-merge.sh), I/O stubbed ----

function runGate(t, { checks, contexts, unknown, receipt = {
  schemaVersion: 1, head: HEAD, validation: 'unknown', reason: 'absolute-timeout', ciAuthoritative: true,
  cleanup: 'finished', coverageComplete: true, localFailureObserved: false,
} }) {
  const root = new URL('../', import.meta.url);
  const script = readFileSync(new URL('bin/hammer-merge.sh', root), 'utf8');
  const gateCode = script.match(/<<'NODE' > "\$HAM_GATE_JSON"\n([\s\S]*?)\nNODE/)[1];
  const runDir = mkdtempSync(join(tmpdir(), 'mrq20-gate-'));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  if (unknown) writeFileSync(join(runDir, `validation-deferred-${HEAD}.json`),
    typeof receipt === 'string' ? receipt : JSON.stringify(receipt));
  const href = path => JSON.stringify(new URL(path, root).href);
  const code = `
import { evaluateMergeEligibility } from ${href('src/ama/merge-eligibility.mjs')};
import { classifyCheckRollup, latestCheckRollupItems } from ${href('src/checks-summary.mjs')};
import { tenureHeadNeedsReview } from ${href('src/pr-tenure.mjs')};
import { resolveRequiredCheckContextsFromCfg } from ${href('src/ama/required-check-contexts.mjs')};
import { readUnknownValidationReceipt, recordedUnknownDefersToCi, unknownValidationCiGate } from ${href('src/ama/local-validation-unknown.mjs')};
const fetchHammerPr = async () => ({ headSha: ${JSON.stringify(HEAD)}, state: 'OPEN', mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN', labels: [], checks: ${JSON.stringify(checks)} });
const loadEffectiveMergeAuthorityConfig = () => ({ requiredCheckContexts: [],
  requiredCheckContextsByRepository: ${JSON.stringify(contexts.length ? [{ repository: REPO, contexts }] : [])} });
const createHistoryReader = () => async () => { throw new Error('offline'); };
const fetchPrimaryChange = async () => (${JSON.stringify(primaryChangeFixture(HEAD))});
const checkPrimaryChange = () => ({ ok: true });
const closerReviewProof = async () => ({ ok: true });
${gateCode.replace(/^import .*;\n/gm, '').replaceAll('<<REPO>>', REPO).replaceAll('<<PR_NUMBER>>', '42')
    .replaceAll('<<TENURE_REVIEW_ARG>>', '').replaceAll('<<REVIEWED_SHA>>', HEAD).replaceAll('<<RUN_DIR>>', runDir)}`;
  const result = spawnSync(process.execPath, ['--input-type=module'], { input: code, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, POST_REMEDIATION_SHA: HEAD, HAM_REVIEW_PROOF_REQUIRED: '0', HAM_BRANCH_PROTECTION_REQUIRED: 'false' } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('hammer gate: UNKNOWN + green declared contexts merges; red, absent or undeclared does not', t => {
  const ok = runGate(t, { checks: green, contexts: ['repo-guards'], unknown: true });
  assert.equal(ok.checksConclusion, 'SUCCESS');
  assert.deepEqual(ok.localValidationUnknown, { ok: true, conclusion: 'SUCCESS' });
  assert.equal(ok.ok, true, JSON.stringify(ok));

  const red = runGate(t, { checks: [run('repo-guards', 'FAILURE'), run('lint')], contexts: ['repo-guards'], unknown: true });
  assert.equal(red.ok, false);
  assert.deepEqual(red.reasons, ['ci-not-green']);
  assert.equal(red.localValidationUnknown.reason, UNKNOWN_CONTEXTS_NOT_GREEN);

  const absent = runGate(t, { checks: [run('lint')], contexts: ['repo-guards'], unknown: true });
  assert.equal(absent.ok, false);
  assert.equal(absent.checksConclusion, 'PENDING');
  // Pending-only, so the existing bounded CI wait and retryable deferral apply.
  assert.deepEqual(absent.reasons, ['ci-not-green']);

  const undeclared = runGate(t, { checks: green, contexts: [], unknown: true });
  assert.equal(undeclared.ok, false);
  assert.ok(undeclared.reasons.includes('absolute-timeout'));
});

test('hammer gate: green CI never overrides failure-tainted or invalid UNKNOWN receipts', t => {
  const base = { schemaVersion: 1, head: HEAD, validation: 'unknown', reason: 'absolute-timeout',
    ciAuthoritative: true, cleanup: 'finished', coverageComplete: true, localFailureObserved: false };
  for (const receipt of [
    { ...base, localFailureObserved: true },
    { ...base, ciAuthoritative: false },
    { ...base, ciAuthoritative: undefined },
    { ...base, cleanup: 'unconfirmed' },
    { ...base, cleanup: 'controller-owned' },
    { ...base, coverageComplete: false },
    { ...base, head: 'b'.repeat(40), reason: undefined },
    { ...base, reason: 'validation-drain-unconfirmed' },
    { ...base, validation: 'fail' },
    '{unreadable',
    'null',
  ]) {
    const result = runGate(t, { checks: green, contexts: ['repo-guards'], unknown: true, receipt });
    assert.equal(result.checksConclusion, 'SUCCESS');
    assert.equal(result.ok, false, JSON.stringify(receipt));
    assert.equal(result.localValidationUnknown.ok, false);
    assert.ok(result.reasons.includes(receipt.reason || 'local-validation-unknown-not-deferrable'));
  }
});

test('hammer gate: a declared context that never reported is pending for every hammer merge', t => {
  const absent = runGate(t, { checks: [run('lint')], contexts: ['repo-guards'], unknown: false });
  assert.equal(absent.checksConclusion, 'PENDING');
  assert.ok(absent.reasons.includes('ci-not-green'));
  assert.equal(absent.localValidationUnknown, null);
  // Another repository's declaration never stalls this one.
  const undeclared = runGate(t, { checks: [run('lint')], contexts: [], unknown: false });
  assert.equal(undeclared.checksConclusion, 'SUCCESS');
});

// ---- queue-v2 equivalent ----

test('queue-v2: repository-scoped contexts join the lane required set; UNKNOWN validation is admissible', () => {
  const rules = { complete: true, contexts: [], sourceRef: 'rules:fixture', version: '1' };
  const scoped = resolveQueueRequiredSet({ cfg, rules, repository: REPO });
  assert.deepEqual(scoped.contexts, ['repo-guards']);
  assert.deepEqual(resolveQueueRequiredSet({ cfg, rules, repository: OTHER }).contexts, []);
  const snapshot = results => ({ complete: true, head: HEAD, requiredSet: scoped,
    results: results.map(result => ({ ...result, head: HEAD })) });
  assert.equal(classifyQueueChecks(snapshot([run('lint')])).kind, 'wait');
  assert.equal(classifyQueueChecks(snapshot(green)).kind, 'green');

  const { h: handoff, e: evidence } = queueHandoffFixture();
  const unknown = { ...evidence, localValidation: { ...handoff.localValidation, ok: false, result: 'unknown',
    ciAuthoritative: true, localFailureObserved: false, coverageComplete: true, cleanup: 'finished' } };
  assert.equal(queueLocalValidationUnknown(unknown), true);
  assert.equal(validateQueueHandoff(handoff, unknown), true);
  const failed = { ...unknown, localValidation: { ...unknown.localValidation, result: 'fail' } };
  assert.throws(() => validateQueueHandoff(handoff, failed), /failed localValidation/);
  for (const patch of [{ ciAuthoritative: false }, { ciAuthoritative: undefined }, { localFailureObserved: true },
    { cleanup: 'unconfirmed' }, { coverageComplete: false }]) {
    for (const ok of [false, true]) {
      const invalid = { ...unknown, localValidation: { ...unknown.localValidation, ...patch, ok } };
      assert.equal(queueLocalValidationUnknown(invalid), false);
      assert.throws(() => validateQueueHandoff(handoff, invalid), /failed localValidation/);
    }
  }
});
