import test from 'node:test';
import assert from 'node:assert/strict';
import { __test__ as harness } from '../src/reviewer-harness.mjs';

test('per-review effort reaches the existing reasoning pin and Codex CLI arguments', () => {
  const execution = harness.resolveCodexExecOverrides({ env: {}, log: { info() {} },
    modelPin: 'gpt-6-luna', reasoningPin: 'low' });
  assert.equal(execution.model, 'gpt-6-luna');
  assert.equal(execution.reasoningEffort, 'low');
  const args = harness.buildCodexReviewArgs({ prompt: 'synthetic diff', outputPath: '/tmp/fixture-review.md',
    model: execution.model, configOverrides: execution.configOverrides });
  assert.ok(args.includes('model_reasoning_effort="low"'));
});

test('Claude broker preparation uses the selected model', async () => {
  let prepared;
  await harness.assertClaudeOAuth({ model: 'fixture-model', platform: 'linux',
    prepareClaudeOAuthEnvImpl: async options => { prepared = options; return { env: {}, transport: 'broker' }; },
    spawnClaudeImpl: async () => ({ stdout: '{"loggedIn":true}', stderr: '' }),
  });
  assert.equal(prepared.model, 'fixture-model');
});
