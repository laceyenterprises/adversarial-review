// ARGUSDRAIN-01 item 3 — the Argus reviewer runs while codex is exhausted:
// routed through the adversarial reviewer's harness across Claude, Gemini and
// codex, honouring builder diversity, reviewer.gemini.mode and the HHR quota
// probe. No worker-class change, so no session-ledger migration.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  builderClassFromTitle,
  createArgusReviewerModelResolver,
  orderArgusReviewerModels,
  readFleetQuotaStatuses,
} from '../src/argus-reviewer-routing.mjs';

const CONFIGURED = ['claude', 'gemini', 'codex'];
const quiet = { log() {}, warn() {}, error() {} };

function status(provider, state, afhGrounding = null) {
  return { provider, authPath: 'oauth', state, afhGrounding };
}

const CODEX_EXHAUSTED = [
  status('openai', 'exhausted'),
  status('anthropic', 'ok'),
  status('google', 'ok'),
];

test('gemini placement follows reviewer.gemini.mode', () => {
  assert.deepEqual(orderArgusReviewerModels({ configured: CONFIGURED, geminiMode: 'always-on' }).models, ['gemini', 'claude', 'codex']);
  assert.deepEqual(orderArgusReviewerModels({ configured: CONFIGURED, geminiMode: 'fallback' }).models, ['claude', 'codex', 'gemini']);
  const off = orderArgusReviewerModels({ configured: CONFIGURED, geminiMode: 'off' });
  assert.deepEqual(off.models, ['claude', 'codex']);
  assert.deepEqual(off.excluded, [{ model: 'gemini', reason: 'reviewer.gemini.mode=off' }]);
});

test('the builder never reviews its own work; a bot PR has no builder', () => {
  assert.equal(builderClassFromTitle('[claude-code] (fix) X-01: thing'), 'claude-code');
  assert.equal(builderClassFromTitle('chore(deps): bump x from 1 to 2'), null);
  const claudeBuilt = orderArgusReviewerModels({ configured: CONFIGURED, geminiMode: 'always-on', builderClass: 'claude-code' });
  assert.deepEqual(claudeBuilt.models, ['gemini', 'codex']);
  assert.match(claudeBuilt.excluded[0].reason, /builder-claude-code-never-reviews-its-own-work/u);
  assert.deepEqual(orderArgusReviewerModels({ configured: CONFIGURED, geminiMode: 'always-on', builderClass: 'codex' }).models, ['gemini', 'claude']);
});

test('with codex exhausted every PR still has a reviewer', () => {
  const bot = orderArgusReviewerModels({ configured: CONFIGURED, geminiMode: 'always-on', statuses: CODEX_EXHAUSTED });
  assert.deepEqual(bot.models, ['gemini', 'claude']);
  assert.deepEqual(bot.excluded, [{ model: 'codex', reason: 'provider-openai-exhausted' }]);

  const claudeBuilt = orderArgusReviewerModels({ configured: CONFIGURED, geminiMode: 'always-on', builderClass: 'claude-code', statuses: CODEX_EXHAUSTED });
  assert.deepEqual(claudeBuilt.models, ['gemini']);

  const codexBuilt = orderArgusReviewerModels({ configured: CONFIGURED, geminiMode: 'always-on', builderClass: 'codex', statuses: CODEX_EXHAUSTED });
  assert.deepEqual(codexBuilt.models, ['gemini', 'claude']);
});

test('a soft-grounded provider goes last; an ambiguous state is not a grounding', () => {
  const statuses = [
    status('openai', 'unknown'),
    status('anthropic', 'ok', { grounded: true, reason: 'sustained quota kills' }),
    status('google', 'degraded'),
  ];
  assert.deepEqual(orderArgusReviewerModels({ configured: CONFIGURED, geminiMode: 'always-on', statuses }).models, ['gemini', 'codex', 'claude']);
});

test('the fleet quota read tolerates the warnings hq prints before the JSON', async () => {
  const statuses = await readFleetQuotaStatuses({
    env: {},
    hqPath: 'hq',
    execFileImpl: async () => ({
      stdout: 'session-ledger.pg_schema_version_orphan: warning\n'
        + JSON.stringify({ providerStatuses: CODEX_EXHAUSTED }),
    }),
  });
  assert.deepEqual(statuses.map((entry) => [entry.provider, entry.state]), [['openai', 'exhausted'], ['anthropic', 'ok'], ['google', 'ok']]);
});

test('the production resolver fails open when the quota probe or gemini mode is unreadable', async () => {
  const resolve = createArgusReviewerModelResolver({
    env: {},
    readStatuses: async () => {
      throw new Error('hq not found');
    },
    resolveGeminiMode: () => {
      throw new Error('config unreadable');
    },
    logger: quiet,
  });
  assert.deepEqual(await resolve({ job: { repo: 'o/r', prNumber: 1 }, pr: { title: 'chore(deps): bump' } }), ['claude', 'codex']);

  const live = createArgusReviewerModelResolver({
    env: { ADVERSARIAL_ARGUS_REVIEWER_MODELS: 'codex,claude,gemini' },
    readStatuses: async () => CODEX_EXHAUSTED,
    resolveGeminiMode: () => 'always-on',
    logger: quiet,
  });
  assert.deepEqual(await live({ job: { repo: 'o/r', prNumber: 1 }, pr: { title: '[claude-code] feat' } }), ['gemini']);
});
