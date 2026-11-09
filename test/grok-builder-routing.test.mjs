import './helpers/registry-session-fixture.mjs';
import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTaggedTitle, builderClassFromTitle, hasCanonicalTaggedTitle } from '../src/adapters/subject/github-pr/title-tagging.mjs';
import { routePR, routeSubject, reviewerRefusesBuilder, normalizeBuilderClass, normalizeReviewerModel, applyGeminiReviewerRoute } from '../src/adapters/subject/github-pr/routing.mjs';
import { pickRemediationWorkerClass } from '../src/remediation-worker-routing.mjs';
import { remediationSubjectRefusal, resolveClaimedRemediatorRouting, resolveRemediationWorkerClassWithFallback } from '../src/remediation-worker-class-fallback.mjs';
import { violatesWriterDiversity } from '../src/review-worker-class-fallback.mjs';
import { applyAfhReviewerFallback } from '../src/afh-reviewer-fallback.mjs';
import { spawnReviewer } from '../src/reviewer-spawn-settle.mjs';

const aliases = ['grok', 'grok-api', 'grok-reviewer', 'remediator-grok', 'hammer-grok'];
const env = { AGENT_OS_CONFIG_PATH: '/dev/null' };
const loaderImpl = () => ({ get: (_key, fallback) => fallback });
const route = builderClass => routeSubject({ builderClass }, { env, loaderImpl, geminiReviewerMode: 'off' });

test('Grok title tagging and closer wrappers retain original builder provenance', () => {
  assert.equal(buildTaggedTitle(' GROK ', 'Synthetic change'), '[grok] Synthetic change');
  for (const prefix of ['', '[closer] ', '[hammer] ', '[hammer-corp] ', '[hammer-claude] ', '[hammer-claude-corp] ', '[hammer-grok] ']) {
    assert.equal(builderClassFromTitle(`${prefix}[GrOk] Synthetic change`), 'grok');
    assert.equal(builderClassFromTitle(`${prefix}[codex] Synthetic change`), 'codex');
    const routed = routePR(`${prefix}[GrOk] Synthetic change`, null,
      { env, loaderImpl, geminiReviewerMode: 'off' });
    assert.equal(routed.builderClass, 'grok');
    assert.equal(routed.reviewerModel, 'codex');
    assert.equal(pickRemediationWorkerClass({ builderTag: routed.builderClass },
      { env, loaderImpl }), 'remediator-codex');
  }
  for (const title of ['[grok]', '[grok] [codex] change', '[hammer-grok] change', '[unknown] change', '[hammer] [hammer-grok] [grok] change']) {
    assert.equal(hasCanonicalTaggedTitle(title), false, title);
    assert.equal(builderClassFromTitle(title), null, title);
  }
});

test('Grok aliases route to Codex while existing alternative builder routes remain unchanged', () => {
  for (const alias of aliases) {
    assert.equal(normalizeBuilderClass(alias), 'grok');
    assert.equal(route(alias).reviewerModel, 'codex');
    assert.equal(pickRemediationWorkerClass({ builderTag: alias }, { env, loaderImpl }), 'remediator-codex');
  }
  for (const builderClass of ['pi', 'opencode', 'hermes']) {
    assert.equal(route(builderClass).reviewerModel, 'codex');
    assert.equal(pickRemediationWorkerClass({ builderTag: builderClass }, { env, loaderImpl }), 'codex');
  }
  assert.equal(route('unknown'), null);
  assert.equal(reviewerRefusesBuilder('unknown', 'codex'), true);
  assert.equal(violatesWriterDiversity('unknown', 'codex'), true);
});

test('Grok acting aliases are refused before reviewer runtime or account selection', async t => {
  const rootDir = await mkdtemp(join(tmpdir(), 'grok-routing-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  for (const actor of aliases) {
    assert.equal(normalizeReviewerModel(actor), 'grok');
    for (const builderTag of [...aliases, 'codex', 'unknown']) {
      assert.equal(reviewerRefusesBuilder(builderTag, actor), true);
      assert.equal(violatesWriterDiversity(builderTag, actor), true);
      const result = await spawnReviewer({ rootDir, builderTag, reviewerModel: actor,
        ensureWorkerRegistryReadyImpl: () => assert.fail('refused actor reached registry'),
        readReviewerQuotaDecisionImpl: () => assert.fail('refused actor reached quota'),
        reviewerRuntimeAdapterOverride: { spawn: () => assert.fail('refused actor reached runtime') } });
      assert.equal(result.routingRefusal, true);
      assert.equal(result.ok, false);
    }
  }
  const result = await spawnReviewer({ rootDir, builderTag: 'unknown', reviewerModel: 'codex' });
  assert.equal(result.routingRefusal, true);
  const repaired = applyGeminiReviewerRoute({ builderClass: 'grok', mode: 'off', baseRoute: { reviewerModel: 'grok-api' } });
  assert.equal(repaired.reviewerModel, 'codex');
});

test('refused or missing configured reviewer models return null through public route entry points', () => {
  for (const reviewerModel of ['grok-api', 'unknown', undefined]) {
    for (const applyGeminiReviewerMode of [true, false]) {
      const options = { env, loaderImpl, geminiReviewerMode: 'off', applyGeminiReviewerMode,
        routeTable: { grok: { reviewerModel } } };
      assert.equal(routeSubject({ builderClass: 'grok' }, options), null);
      assert.equal(routePR('[grok] Synthetic change', null, options), null);
    }
  }
});

test('Claude remediation aliases normalize consistently and retain family refusal', () => {
  for (const workerClass of ['remediator-claude', 'remediator-claude-corp']) {
    assert.equal(normalizeReviewerModel(workerClass), 'claude');
    assert.equal(reviewerRefusesBuilder('claude-code', workerClass), true);
    assert.equal(reviewerRefusesBuilder('grok', workerClass), false);
  }
});

test('Codex outage uses an eligible Claude reviewer or defers under existing AFH policy', () => {
  for (const claudeGrounded of [false, true]) {
    const grounded = hardGrounded => ({ state: hardGrounded ? 'exhausted' : 'ok', hardGrounded, softGrounded: false, grounded: hardGrounded });
    const result = applyAfhReviewerFallback({ builderClass: 'grok', baseRoute: route('grok'), geminiReviewerMode: 'off',
      grounding: { available: true, providers: { openai: grounded(true), anthropic: grounded(claudeGrounded), google: grounded(true) } } });
    if (claudeGrounded) assert.equal(result.quotaBlocked, true);
    else assert.equal(result.reviewerModel, 'claude');
    assert.notEqual(result.reviewerModel, 'grok');
  }
});

test('remediator refuses every Grok alias and unknown builder before account selection', async () => {
  for (const primary of aliases) {
    const result = await resolveRemediationWorkerClassWithFallback({ primary, job: { builderTag: 'grok' },
      ensureWorkerRegistryReadyImpl: () => assert.fail('refused actor reached registry') });
    assert.equal(result.hold, true);
    assert.equal(result.reason, 'grok-acting-lane-unavailable');
  }
  assert.equal(remediationSubjectRefusal({ builderTag: 'unknown' }, 'codex'), 'unknown-builder-family');
  for (const workerClass of aliases) {
    const result = await resolveClaimedRemediatorRouting({ job: { builderTag: 'grok' }, primary: 'remediator-codex', env, loaderImpl,
      ensureWorkerRegistryReadyImpl: async () => {}, resolveImpl: async () => ({ workerClass, hold: false }) });
    assert.equal(result.hold, true);
  }
});

test('exhausted Codex remediation filters Grok fallbacks before selecting Claude or deferring', async () => {
  for (const available of [true, false]) {
    const seen = [];
    const result = await resolveRemediationWorkerClassWithFallback({ primary: 'remediator-codex',
      fallbackWorkerClasses: [...aliases, 'remediator-claude'], job: { builderTag: 'grok' }, env, loaderImpl,
      ensureWorkerRegistryReadyImpl: async () => {}, modelForClass: () => 'synthetic-model',
      selectAccountImpl: async ({ identity }) => {
        seen.push(identity);
        const selected = identity === 'remediator-claude' && available;
        return { identity, pooled: true, hold: !selected, status: selected ? 'selected' : 'unavailable',
          reason: selected ? 'fallback-ready' : 'accounts-unavailable', tokenAccountId: selected ? 'synthetic-secondary' : null };
      }, execFileImpl: () => assert.fail('pool evidence must remain offline') });
    assert.deepEqual(seen, ['remediator-codex', 'remediator-claude']);
    assert.equal(result.hold, !available);
    if (available) assert.equal(result.workerClass, 'remediator-claude');
  }
});
