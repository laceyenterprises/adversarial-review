import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDomainPipeline } from '../src/domain-pipeline.mjs';
import { runGatedReviewPipeline, defaultStageDomainId } from '../src/watcher-review-pipeline.mjs';

const REGISTRY = {
  roles: {
    'code-quality-reviewer': { id: 'code-quality-reviewer', promptSet: 'code-pr', workerClass: 'codex', taskKind: 'review', completionShape: 'decision-only' },
    'security-reviewer': { id: 'security-reviewer', promptSet: 'code-pr-security', workerClass: 'codex', taskKind: 'review', completionShape: 'decision-only' },
  },
  routing: { neverReviewOwnBuilderClass: true },
};

const CONFIG = {
  id: 'code-pr',
  riskClasses: { low: { maxRemediationRounds: 1 }, medium: { maxRemediationRounds: 2 }, high: { maxRemediationRounds: 3 }, critical: { maxRemediationRounds: 4 } },
  pipeline: {
    enabled: true,
    stages: [
      { id: 'code-quality', panel: ['code-quality-reviewer'], aggregation: { kind: 'unanimous-clean' } },
      { id: 'security', panel: ['security-reviewer'], aggregation: { kind: 'unanimous-clean' } },
    ],
  },
};

function resolved() {
  return resolveDomainPipeline(CONFIG, { roleRegistry: REGISTRY });
}

function cleanBody(note) {
  return ['## Summary', `no blocking issues (${note})`, '', '## Blocking issues', '- None.', '', '## Verdict', 'Comment only'].join('\n');
}
function blockingBody(findings) {
  return ['## Summary', 'found problems', '', '## Blocking issues', ...findings.map((f) => `- **${f}**`), '', '## Verdict', 'Request changes'].join('\n');
}

// A fake watcher spawnReviewer keyed by the domain id each stage maps to.
function fakeSpawnReviewer(bodyByDomain) {
  const calls = [];
  const spawnReviewer = async (args) => {
    calls.push({ domainId: args.domainId, reviewerModel: args.reviewerModel, sessionUuid: args.reviewerSessionUuid, headSha: args.reviewerHeadSha });
    const body = bodyByDomain[args.domainId];
    return body ? { ok: true, reviewBody: body } : { ok: false, reviewBody: null, failureClass: 'reviewer-timeout' };
  };
  return { spawnReviewer, calls };
}

function fakeComms() {
  const rollups = [];
  return {
    rollups,
    postPipelineRollup: async (rollup, key) => { rollups.push({ rollup, key }); return { deliveryExternalId: `rollup-${rollups.length}` }; },
  };
}

const BASE_ARGS = {
  repo: 'laceyenterprises/demo', prNumber: 7, reviewerModel: 'codex', botTokenEnv: 'GH_BOT', reviewerSessionUuid: 'sess-1',
};

test('stage → prompt-set domain mapping follows the role promptSet', () => {
  assert.equal(defaultStageDomainId({ promptSet: 'code-pr' }), 'code-pr');
  assert.equal(defaultStageDomainId({ promptSet: 'code-pr-security' }), 'code-pr-security');
});

test('gated hook drives both stages under their own prompt-set domains and posts the rollup', async () => {
  const { spawnReviewer, calls } = fakeSpawnReviewer({
    'code-pr': cleanBody('cq'),
    'code-pr-security': blockingBody(['sql injection', 'idor']),
  });
  const comms = fakeComms();
  const result = await runGatedReviewPipeline({
    resolvedPipeline: resolved(),
    currentRevisionRef: 'headsha1',
    riskClass: 'high',
    observedAt: '2026-07-17T00:00:00Z',
    spawnReviewer,
    spawnReviewerArgs: BASE_ARGS,
    comms,
    rollupDeliveryKey: { domainId: 'code-pr', subjectExternalId: 'laceyenterprises/demo#7', revisionRef: 'headsha1', round: 1, kind: 'review' },
  });

  // Each stage reviewed under its own prompt-set domain, in order.
  assert.deepEqual(calls.map((c) => c.domainId), ['code-pr', 'code-pr-security']);
  // Distinct per-stage session uuids so reviewer-run claims don't collide.
  assert.equal(calls[0].sessionUuid, 'sess-1:code-quality:r1');
  assert.equal(calls[1].sessionUuid, 'sess-1:security:r1');
  assert.equal(calls[0].headSha, 'headsha1');

  // The rollup posted exactly once, carrying the Win 2 body.
  assert.equal(comms.rollups.length, 1);
  assert.match(comms.rollups[0].rollup.body, /pipeline: BLOCKED at security — 2 blocking findings routed/);

  // Drop-in result: aggregate verdict is the blocking stage's body, ok=true so
  // the watcher's settle path routes to remediation exactly like a v1 review.
  assert.equal(result.ok, true);
  assert.match(result.reviewBody, /Request changes/);
  assert.equal(result.pipeline.disposition, 'blocking');
});

test('gated hook: stage 1 blocks → stage 2 never spawns; drop-in body carries the block', async () => {
  const { spawnReviewer, calls } = fakeSpawnReviewer({
    'code-pr': blockingBody(['null deref']),
    'code-pr-security': cleanBody('should not run'),
  });
  const result = await runGatedReviewPipeline({
    resolvedPipeline: resolved(), currentRevisionRef: 'h2', riskClass: 'medium', observedAt: '2026-07-17T00:00:00Z',
    spawnReviewer, spawnReviewerArgs: BASE_ARGS, comms: fakeComms(),
    rollupDeliveryKey: { domainId: 'code-pr', subjectExternalId: 'laceyenterprises/demo#7', revisionRef: 'h2', round: 1, kind: 'review' },
  });
  assert.deepEqual(calls.map((c) => c.domainId), ['code-pr'], 'security stage never spawned');
  assert.equal(result.ok, true);
  assert.match(result.reviewBody, /Request changes/);
  assert.equal(result.pipeline.blockingStageId, 'code-quality');
});

test('gated hook: both stages clean → drop-in ok result with a clean verdict body', async () => {
  const { spawnReviewer } = fakeSpawnReviewer({
    'code-pr': cleanBody('cq'),
    'code-pr-security': cleanBody('sec'),
  });
  const result = await runGatedReviewPipeline({
    resolvedPipeline: resolved(), currentRevisionRef: 'h3', riskClass: 'low', observedAt: '2026-07-17T00:00:00Z',
    spawnReviewer, spawnReviewerArgs: BASE_ARGS, comms: fakeComms(),
    rollupDeliveryKey: { domainId: 'code-pr', subjectExternalId: 'laceyenterprises/demo#7', revisionRef: 'h3', round: 1, kind: 'review' },
  });
  assert.equal(result.ok, true);
  assert.match(result.reviewBody, /Comment only/);
  assert.equal(result.pipeline.disposition, 'clean');
});

test('gated hook: a reviewer failure yields a not-ok drop-in result (watcher retries)', async () => {
  const { spawnReviewer } = fakeSpawnReviewer({}); // every domain → ok:false
  const result = await runGatedReviewPipeline({
    resolvedPipeline: resolved(), currentRevisionRef: 'h4', riskClass: 'high', observedAt: '2026-07-17T00:00:00Z',
    spawnReviewer, spawnReviewerArgs: BASE_ARGS, comms: fakeComms(),
    rollupDeliveryKey: { domainId: 'code-pr', subjectExternalId: 'laceyenterprises/demo#7', revisionRef: 'h4', round: 1, kind: 'review' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reviewBody, null);
  assert.equal(result.failureClass, 'reviewer-output');
});
