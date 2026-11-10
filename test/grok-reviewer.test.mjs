import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { reviewWithGrok } from '../src/grok-reviewer.mjs';
import { dispatchReviewerModel } from '../src/reviewer-harness.mjs';
import { reviewerRefusesBuilder, REVIEWER_ROUTE_BY_MODEL } from '../src/adapters/subject/github-pr/routing.mjs';
import { builderClassFromTitle } from '../src/adapters/subject/github-pr/title-tagging.mjs';
import { normalizeReviewerClass, readBestReviewerEvidenceTokenUsage } from '../src/reviewer-pass-tokens.mjs';
import { buildReviewerAttribution, validateReviewerAttribution } from '../src/reviewer-attribution.mjs';
import { emitReviewedAttestation } from '../src/reviewed-attestation.mjs';
import { probeReviewerCliOAuth } from '../src/adapters/reviewer-runtime/cli-direct/discovery.mjs';
import { applyAfhReviewerFallback, providerForReviewerModel } from '../src/afh-reviewer-fallback.mjs';
import { amaAuthoritativeReviewerLoginsForModel, amaReviewerFamilyForLogin,
  isCurrentAuthoritativeFamilyReview } from '../src/ama/reviewer-authority.mjs';
import { resolveReviewerBotLoginAliases } from '../src/review-body-capture.mjs';
import { reviewerBotLogin } from '../src/reviewer-reattach.mjs';

const body = '## Summary\nThe change preserves the documented behavior.\n\n## Blocking issues\n- None.\n\n## Non-blocking issues\n- None.\n\n## Verdict\nComment only';
const env = { GH_GROK_REVIEWER_TOKEN: 'synthetic-posting-authority' };
const config = enabled => () => ({ get: (key, fallback) =>
  ['grok.enabled', 'grok.reviewer.enabled'].includes(key) ? enabled : fallback });
const registry = { ok: true, data: { registrySource: 'db', classes: {
  'grok-reviewer': { enabled: true, harness: 'grok', defaultModel: 'grok-build', fallbackWorkerClasses: [] },
} } };
const options = overrides => ({
  builderClass: 'codex', subjectContext: { subjectExternalId: 'example/review#1' },
  env, loaderImpl: config(true), registryImpl: async () => registry,
  runtimeFactory: () => ({ spawnReviewer: async () => ({ ok: true, reviewBody: body, reattachToken: 'synthetic-dispatch' }) }),
  readUsageImpl: () => null, ...overrides,
});

test('Grok reviewer is opt-in and refuses every same-family alias before registry or auth', async () => {
  assert.equal(reviewerRefusesBuilder('codex', 'grok', { loaderImpl: config(false) }), true);
  const aliases = ['grok', 'grok-api', 'grok-reviewer', 'remediator-grok', 'hammer-grok'];
  for (const actor of aliases) {
    assert.equal(reviewerRefusesBuilder('codex', actor, { loaderImpl: config(true) }), false);
    for (const builder of [...aliases, 'unknown']) {
      assert.equal(reviewerRefusesBuilder(builder, actor, { loaderImpl: config(true) }), true);
      await assert.rejects(reviewWithGrok('', '', options({ builderClass: builder,
        registryImpl: () => assert.fail('refused builder reached registry') })), /family refused/);
    }
  }
  for (const prefix of ['', '[closer] ', '[hammer-grok] ', '[hammer-claude] ']) {
    const builder = builderClassFromTitle(`${prefix}[grok] Synthetic change`);
    assert.equal(reviewerRefusesBuilder(builder, 'grok-api', { loaderImpl: config(true) }), true);
  }
});

test('managed invocation preserves original provenance and common nullable telemetry', async () => {
  const usage = { input: 20, output: 10, costUSD: null, source: 'grok-session-usage' };
  let request;
  const result = await reviewWithGrok('synthetic diff', 'synthetic context', options({
    runtimeFactory: args => {
      assert.equal(args.workerClass, 'grok-reviewer');
      assert.equal(args.taskKind, 'review');
      return { spawnReviewer: async value => { request = value;
        return { ok: true, reviewBody: body, reattachToken: 'synthetic-dispatch' }; } };
    },
    readUsageImpl: args => {
      assert.equal(args.launchRequestId, 'synthetic-dispatch');
      return usage;
    },
  }));
  assert.equal(request.subjectContext.builderClass, 'codex');
  assert.equal(request.workerClass, 'grok-reviewer');
  assert.equal(request.subjectContext.nestedReviewerRuntime, true);
  assert.ok(request.timeoutMs < 20 * 60 * 1000);
  assert.match(request.prompt, /synthetic diff/);
  assert.strictEqual(result.tokenUsage, usage);
  assert.equal(result.execution.harness, 'grok');
  assert.equal(result.execution.model, null);
  assert.equal(result.execution.modelSource, 'unknown');
});

test('Grok execution uses a model reported by dispatch when present', async () => {
  const result = await reviewWithGrok('', '', options({
    runtimeFactory: () => ({ spawnReviewer: async () => ({ ok: true, reviewBody: body,
      reattachToken: 'synthetic-dispatch', execution: { model: 'grok-pinned' } }) }),
  }));
  assert.equal(result.execution.model, 'grok-pinned');
  assert.equal(result.execution.modelSource, 'dispatch-receipt');
});

test('unimported, disabled, missing, or fallback-bearing registry cannot execute', async () => {
  for (const data of [
    { ...registry.data, registrySource: 'json' },
    { ...registry.data, classes: {} },
    ...[{ enabled: false }, { harness: 'codex' }, { fallbackWorkerClasses: ['grok-api'] }]
      .map(patch => ({ ...registry.data, classes: { 'grok-reviewer': { ...registry.data.classes['grok-reviewer'], ...patch } } })),
  ]) {
    await assert.rejects(reviewWithGrok('', '', options({ registryImpl: async () => ({ ok: true, data }),
      runtimeFactory: () => assert.fail('unsafe import reached runtime') })), /registry import/);
  }
});

test('missing posting authority fails closed before execution', async () => {
  await assert.rejects(reviewWithGrok('', '', options({ env: {},
    runtimeFactory: () => assert.fail('missing authority reached runtime') })), /posting authority/);
});

test('pre-execution refusals are typed configuration errors', async () => {
  for (const overrides of [
    { loaderImpl: config(false) },
    { registryImpl: async () => ({ ok: false }) },
    { env: {} },
  ]) {
    await assert.rejects(reviewWithGrok('', '', options(overrides)),
      error => error.failureClass === 'reviewer-configuration-error');
  }
});

test('Grok GitHub reviews are authoritative and resolvable for capture and reattach', async () => {
  const logins = amaAuthoritativeReviewerLoginsForModel('grok');
  assert.deepEqual(logins, ['lacey-grok-reviewer', 'grok-reviewer-lacey']);
  assert.equal(reviewerBotLogin('grok'), 'lacey-grok-reviewer[bot]');
  assert.ok(resolveReviewerBotLoginAliases('GH_GROK_REVIEWER_TOKEN').length > 0);
  const review = { user: { login: 'lacey-grok-reviewer[bot]' }, state: 'COMMENTED',
    commit_id: 'a'.repeat(40), body: '## Verdict\nComment only' };
  assert.equal(amaReviewerFamilyForLogin(review.user.login), 'grok');
  assert.equal(await isCurrentAuthoritativeFamilyReview(review, [review], review.commit_id,
    async () => ({ status: 'identical' })), true);
});

test('typed quota, auth and timeout failures cannot become a review', async () => {
  for (const failureClass of ['quota-exhausted', 'oauth-broken', 'reviewer-timeout']) {
    await assert.rejects(reviewWithGrok('', '', options({
      runtimeFactory: () => ({ spawnReviewer: async () => ({ ok: false, failureClass,
        stderrTail: 'synthetic-private-output' }) }),
    })), error => error.failureClass === failureClass && !error.message.includes('private-output'));
  }
});

test('model dispatcher sanitizes Grok output and never invokes Codex', async () => {
  const result = await dispatchReviewerModel('grok', '', '', {
    builderClass: 'codex',
    reviewWithGrokImpl: async () => ({ reviewText: `runtime decoration\n${body}`, tokenUsage: { costUSD: 0.25 } }),
    reviewWithCodexImpl: () => assert.fail('Grok fell through to Codex'),
  });
  assert.equal(result.reviewText, body);
  assert.equal(result.tokenUsage.costUSD, 0.25);
  await assert.rejects(dispatchReviewerModel('grok', '', '', {
    reviewWithGrokImpl: async () => ({ reviewText: 'runtime failure' }),
  }));
});

test('Grok preflight delegates auth to the managed adapter', async () => {
  for (const model of ['grok', 'grok-build', 'grok-reviewer', 'GROK-4', 'remediator-grok']) {
    assert.deepEqual(await probeReviewerCliOAuth({ model,
      execFileImpl: () => assert.fail('Grok used a sibling credential probe') }), { managed: true });
  }
  assert.equal(REVIEWER_ROUTE_BY_MODEL.grok.botTokenEnv, 'GH_GROK_REVIEWER_TOKEN');
  assert.equal(normalizeReviewerClass('grok-reviewer'), 'grok');
  const attribution = buildReviewerAttribution({ reviewerModel: 'grok' });
  assert.equal(validateReviewerAttribution(attribution).reviewerSubject, 'grok-reviewer');
  assert.throws(() => validateReviewerAttribution(attribution, 'different-reviewer'), /subject mismatch/);
  const forbidden = new Proxy([], { get() { assert.fail('Grok consulted sibling transcript roots'); } });
  assert.equal(readBestReviewerEvidenceTokenUsage({
    reviewerModel: 'grok', codexSessionRoots: forbidden, claudeSessionRoots: forbidden,
    env: {},
  }), null);
});

test('Grok SIGTERM cancels only its dispatch and leaves outer async cleanup alive', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { reviewWithGrok } from ${JSON.stringify(new URL('../src/grok-reviewer.mjs', import.meta.url).href)};
    for (const cancelFails of [false, true]) {
      const originalListeners = process.listenerCount('SIGTERM');
      let outerCleaned = false;
      let request;
      let finish;
      const cancellations = [];
      const outer = () => { setImmediate(() => { outerCleaned = true; }); };
      process.once('SIGTERM', outer);
      const reviewing = reviewWithGrok('', '', {
        builderClass: 'codex',
        env: { GH_GROK_REVIEWER_TOKEN: 'synthetic-token' },
        loaderImpl: () => ({ get: (key, fallback) =>
          ['grok.enabled', 'grok.reviewer.enabled'].includes(key) ? true : fallback }),
        registryImpl: async () => ({ ok: true, data: { registrySource: 'db', classes: {
          'grok-reviewer': { enabled: true, harness: 'grok', fallbackWorkerClasses: [] },
        } } }),
        runtimeFactory: () => ({
          spawnReviewer: args => {
            request = args;
            return new Promise(resolve => { finish = resolve; });
          },
          cancel: async session => {
            cancellations.push(session);
            if (cancelFails) throw new Error('synthetic cancel failure');
          },
        }),
        readUsageImpl: () => null,
      });
      await new Promise(resolve => setImmediate(resolve));
      process.emit('SIGTERM');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(outerCleaned, true);
      assert.deepEqual(cancellations, [request.sessionUuid]);
      finish({ ok: true, reviewBody: 'synthetic review' });
      await reviewing;
      assert.equal(process.listenerCount('SIGTERM'), originalListeners);
    }
    console.log('outer cleanup completed');
  `], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /outer cleanup completed/);
});

test('AFH cannot retain a Grok reviewer for Grok provenance even on missing health or pins', () => {
  for (const builderClass of ['grok', 'grok-api', 'hammer-grok', 'unknown']) {
    for (const reviewerModel of ['grok', 'grok-api', 'grok-reviewer']) {
      const result = applyAfhReviewerFallback({
        builderClass, baseRoute: { reviewerModel, operatorPinnedReviewer: true },
        grounding: { available: false }, geminiReviewerMode: 'off',
      });
      assert.equal(result.integrityRefused, true);
      assert.equal(result.quotaBlocked, true);
    }
  }
});

test('AFH uses xai health and selects a different builder family when Grok is grounded', () => {
  assert.equal(providerForReviewerModel('grok-api'), 'xai');
    const status = grounded => ({ state: grounded ? 'exhausted' : 'ok',
      hardGrounded: grounded, softGrounded: false, grounded });
    const grounding = { available: true, providers: { xai: status(true),
      openai: status(false), anthropic: status(false), google: status(true) } };
    for (const [builderClass, expected] of [['claude-code', 'codex'], ['codex', 'claude']]) {
      const result = applyAfhReviewerFallback({ builderClass,
        baseRoute: REVIEWER_ROUTE_BY_MODEL.grok, grounding, geminiReviewerMode: 'off',
        env, loaderImpl: config(true) });
      assert.equal(result.reviewerModel, expected);
      assert.equal(reviewerRefusesBuilder(builderClass, result.reviewerModel,
        { env, loaderImpl: config(true) }), false);
    }
});

test('Grok reviewed signing failure never records an unsigned receipt', async () => {
  let records = 0;
  await assert.rejects(emitReviewedAttestation({
    repo: 'example/review', prNumber: 1, headSha: 'synthetic-head',
    reviewerIdentity: 'grok-reviewer', verdict: 'comment-only', reviewBody: body,
    env: {}, log: { log() {}, warn() {} },
    execFileImpl: async (_command, argv) => {
      if (argv[1] === 'record') records += 1;
      throw new Error('synthetic signer unavailable');
    },
  }));
  assert.equal(records, 0);
});
