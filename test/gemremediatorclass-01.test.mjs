import './helpers/review-cli-resolver-fixture.mjs';
import './helpers/dispatch-files-preload.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedWorkerRegistry } from './helpers/dispatch-files-fixture.mjs';
import { normalizeRemediationWorkerClass, resolveRemediationWorkerClassWithFallback } from '../src/remediation-worker-class-fallback.mjs';
import { dispatchRemediationViaHq } from '../src/follow-up-remediation.mjs';
import { resolveRemediationRuntimeMode } from '../src/remediation-dispatch-mode.mjs';
import { resolveReconcileWorkerClass } from '../src/remediation-worker-routing.mjs';
import { remediatorClassForQuotaLabel } from '../src/remediation-quota-evidence.mjs';
import { providerForQuotaHarness } from '../src/fleet-quota-status.mjs';
import { remediationWorkerGitIdentity, remediationWorkerPushProvider, remediationWorkerTrailerClass } from '../src/remediation-worker-provenance.mjs';
import { assertHarnessIdentityMatch, resolveGeminiRemediationModel } from '../src/adapters/agent-runtime/local/remediation.mjs';
import { isCrossModelReviewWaived } from '../src/adapters/subject/github-pr/routing.mjs';

const fixture = new URL('./fixtures/gemremediatorclass-01/', import.meta.url);
const sources = JSON.parse(readFileSync(new URL('sources.json', fixture)));
const aliases = ['gemini', 'gemini-remediation', 'remediator-gemini'];
const google = { provider: 'google', authPath: 'agy', state: 'ok' };

for (const alias of aliases) {
  test(`${alias} retains logical quota, review, identity and recovery attribution`, () => {
    assert.equal(normalizeRemediationWorkerClass(alias), 'gemini');
    assert.equal(remediatorClassForQuotaLabel(alias), 'gemini');
    const route = normalizeRemediationWorkerClass(alias);
    assert.equal(providerForQuotaHarness(route), 'google');
    assert.equal(remediationWorkerTrailerClass(route), 'gemini-remediation');
    assert.equal(isCrossModelReviewWaived(route, 'gemini-reviewer'), true);
    assert.equal(isCrossModelReviewWaived(route, 'codex'), false);
    assert.equal(resolveReconcileWorkerClass({}, { model: alias, fallbackFrom: 'codex' }), 'gemini');
  });
}

test('concrete remediation identity enforces both Git attribution and broker provider', () => {
  const workerClass = 'remediator-gemini';
  assert.equal(providerForQuotaHarness(workerClass), 'google');
  assert.equal(remediationWorkerTrailerClass(workerClass), 'gemini-remediation');
  assert.equal(isCrossModelReviewWaived(workerClass, 'gemini-reviewer'), true);
  const gitIdentity = remediationWorkerGitIdentity(workerClass);
  assert.deepEqual(gitIdentity, remediationWorkerGitIdentity('gemini'));
  assert.equal(remediationWorkerPushProvider(workerClass, {}).provider, 'github-app-gemini-agent');
  const check = overrides => assertHarnessIdentityMatch({
    workerClass, gitIdentity, env: {}, log: { error() {} },
    brokerEvidence: { enabled: true, provider: 'github-app-gemini-agent', fellBack: false },
    ...overrides,
  });
  assert.equal(check({}).match, true);
  assert.throws(() => check({ gitIdentity: remediationWorkerGitIdentity('codex') }), /identity mismatch/);
  assert.throws(() => check({ brokerEvidence: { enabled: true, provider: 'github-app-codex-agent' } }), /identity mismatch/);
  assert.equal(check({ requiresWorkflowPush: true,
    brokerEvidence: { enabled: true, provider: 'github-app-merge-agent' } }).match, true);
});

test('Gemini model default and pins use only the remediator registry allowlist', t => {
  const root = mkdtempSync(join(tmpdir(), 'gemrem-model-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedWorkerRegistry(root, {
    gemini: { defaultModel: 'builder-only', allowedModels: ['builder-only'] },
    'remediator-gemini': { defaultModel: 'remediator-default', allowedModels: ['remediator-default', 'remediator-pin'] },
  });
  const env = { HQ_ROOT: root };
  assert.equal(resolveGeminiRemediationModel(env), 'remediator-default');
  assert.equal(resolveGeminiRemediationModel({ ...env, GEMINI_REMEDIATION_MODEL: 'remediator-pin' }), 'remediator-pin');
  assert.throws(() => resolveGeminiRemediationModel({ ...env, GEMINI_REMEDIATION_MODEL: 'builder-only' }), /outside registry allowedModels/);
});

for (const remediationMode of ['os', 'local']) {
  for (const [label, rows, reviewerModels, expected] of [
    ['available', [google], [], false],
    ['capped', [{ ...google, state: 'exhausted' }], [], true],
    ['busy', [{ ...google, state: 'degraded' }], [], true],
    ['missing evidence', [], [], true],
    ['next reviewer', [google], ['gemini-reviewer'], true],
  ]) {
    test(`pooled Codex refusal preserves concrete Gemini fallback order: ${remediationMode}, ${label}`, async () => {
      const consulted = [];
      const result = await resolveRemediationWorkerClassWithFallback({
        primary: 'codex', fallbackWorkerClasses: ['remediator-gemini', 'remediator-claude'],
        remediationMode, reviewerModels, env: { AGENT_OS_CONFIG_PATH: '/dev/null' },
        ensureWorkerRegistryReadyImpl: async () => true, modelForClass: () => 'fixture-model',
        execFileImpl: async () => ({ stdout: JSON.stringify({ providerStatuses: rows }) }),
        selectAccountImpl: async ({ identity }) => {
          consulted.push(identity);
          return { identity, workerClass: identity, pooled: true, hold: true,
            status: 'unavailable', reason: 'accounts-unavailable' };
        },
      });
      assert.equal(result.hold, expected);
      assert.equal(result.workerClass, expected ? 'remediator-codex' : 'gemini');
      assert.deepEqual(consulted, expected ? ['remediator-codex', 'remediator-claude'] : ['remediator-codex']);
      if (!expected) assert.equal(result.reason, 'primary-grounded-fallback');
    });
  }
}

for (const alias of aliases) {
  test(`native HQ producer ${alias} crosses the real dedicated-builder consumer with an empty builder pool`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'gemrem-native-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const promptPath = join(root, 'prompt.md');
    const replyPath = join(root, 'round-2-reply.json');
    writeFileSync(promptPath, 'round 2 remediation');
    const calls = [];
    const worker = await dispatchRemediationViaHq({
      hqRoot: root, workerClass: alias, repo: 'example/repo', prNumber: 17,
      branch: 'codex/round-2', promptPath, replyPath, jobId: 'stable-round-2',
      env: { HQ_ROOT: root, HQ_PARENT_SESSION: 'session:fixture', HQ_PROJECT: 'fixture',
        AGENT_OS_ROLES_ADVERSARIAL_ORCHESTRATION_MODE: 'native' },
      execFileImpl: async (_command, args) => {
        calls.push(args);
        return { stdout: JSON.stringify(args[1] === 'status'
          ? { status: 'queued', workspacePath: root }
          : { launch_request_id: 'lrq-fixture', dispatch_id: 'disp-fixture' }) };
      },
    });
    const argv = calls[0];
    const value = flag => argv[argv.indexOf(flag) + 1];
    assert.equal(value('--worker-class'), 'remediator-gemini');
    assert.equal(value('--task-kind'), 'coding');
    assert.equal(value('--completion-shape'), 'branch-push');
    assert.equal(value('--required-outcome'), 'push');
    assert.equal(value('--branch'), 'codex/round-2');
    assert.equal(value('--ticket'), 'stable-round-2');
    assert.equal(worker.model, 'gemini');
    assert.equal(worker.workerClass, 'remediator-gemini');
    assert.equal(worker.replyPath, replyPath);
    assert.equal(worker.dispatchId, 'disp-fixture');
    assert.equal(worker.launchRequestId, 'lrq-fixture');
    assert.equal(worker.requestId, 'stable-round-2');
    assert.equal(worker.ticketRef, 'stable-round-2');
    assert.equal(resolveRemediationRuntimeMode({ remediationWorker: worker }), 'os');
    assert.equal(resolveReconcileWorkerClass({}, { ...worker, fallbackFrom: 'codex' }), 'gemini');
    for (const file of ['adapters.py', 'agy_builder.py', 'gemini_runtime.py']) {
      const hash = createHash('sha256').update(readFileSync(new URL(file, fixture))).digest('hex');
      assert.equal(hash, sources[file].sha256, 'consumer snapshot must remain verbatim');
    }
    const result = JSON.parse(execFileSync('python3', [new URL('consumer.py', fixture).pathname], {
      input: JSON.stringify({ workerClass: value('--worker-class'), taskKind: value('--task-kind'),
        launchRequestId: worker.launchRequestId, runId: 'run-fixture' }),
      encoding: 'utf8', timeout: 10000,
    }));
    assert.equal(result.emptyBuilderPoolRefusesBuilder, true);
    assert.equal(result.remediatorAccepted, true);
    assert.equal(result.entitlement, 'foundry-remediator-worker');
  });
}
