import test from 'node:test';
import assert from 'node:assert/strict';
import { codexToolHostLogEvidence, readDispatchCodexToolHostEvidence } from '../src/codex-tool-host-failure.mjs';
import { recordedInfrastructureReason, infrastructureRefundReason } from '../src/remediation-infrastructure-refund.mjs';
import { unexecutedHammerReason } from '../src/ama/dead-hammer-rearm.mjs';

const timeout = 'timed out negotiating with the code-mode host';
const failures = [
  `ERROR codex_core::tools::router: error=${timeout}`,
  JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call',
    server: 'code_mode', tool: 'exec', error: timeout } }),
].join('\n');

test('both classifiers recognize prefixed harness failure fields', () => {
  for (const key of ['failureReason', 'failure_reason', 'failureClass', 'failure_class', 'failureCode', 'failure_code', 'failureDetail', 'failure_detail']) {
    const outcome = { status: 'failed', [key]: 'boot_readiness_probe_error: codex-tool-host-unavailable: harness infrastructure failure' };
    assert.equal(recordedInfrastructureReason(outcome), 'codex-tool-host-unavailable');
    if (['failure_class', 'failure_detail'].includes(key)) {
      assert.equal(unexecutedHammerReason(outcome), 'codex-tool-host-unavailable');
    }
  }
});

test('in-run failures before any command earn a bounded infrastructure refund in both classifiers', () => {
  const evidence = codexToolHostLogEvidence(failures);
  assert.ok(evidence);
  const outcome = { toolHostEvidence: evidence };
  assert.equal(recordedInfrastructureReason(outcome), 'codex-tool-host-unavailable');
  assert.equal(unexecutedHammerReason(outcome), 'codex-tool-host-unavailable');
  assert.equal(infrastructureRefundReason({ outcome, startHead: 'a', endHead: 'a', env: {} }), 'codex-tool-host-unavailable');
  assert.equal(infrastructureRefundReason({ outcome, startHead: 'a', endHead: 'b', env: {} }), null);
  assert.equal(infrastructureRefundReason({ outcome, startHead: 'a', endHead: 'a', refunds: 2, env: {} }), null);
});

test('narratives, near matches, prior commands and successful tool calls stay charged', () => {
  for (const text of [
    timeout,
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: timeout } }),
    JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'echo fixture' } }) + '\n' + failures,
    JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', result: 'done' } }) + '\n' + failures,
    JSON.stringify({ type: 'item.completed', item: { type: 'web_search', query: 'fixture' } }) + '\n' + failures,
    JSON.stringify({ type: 'item.completed', item: { type: 'file_change', status: 'completed' } }) + '\n' + failures,
  ]) assert.equal(codexToolHostLogEvidence(text), null);
  assert.equal(recordedInfrastructureReason({ status: 'failed', failureReason: 'not-codex-tool-host-unavailable' }), null);
  assert.equal(recordedInfrastructureReason({ status: 'succeeded', toolHostEvidence: codexToolHostLogEvidence(failures) }), null);
});

test('HQ in-run evidence requires both complete launch streams and rejects hidden earlier work', async () => {
  for (const [extra, stdout, expected] of [
    [{}, failures, true],
    [{ complete: false }, failures, false],
    [{ truncated: true }, failures, false],
    [{ offset: 128 }, failures, false],
    [{}, JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', exit_code: 0 } }) + '\n' + failures, false],
  ]) {
    const evidence = await readDispatchCodexToolHostEvidence({ launchRequestId: 'fixture-lrq' }, {
      readDispatchFilesImpl: async (selector) => {
        assert.equal(selector.launch_request_id, 'fixture-lrq');
        assert.equal(selector.tail, false);
        return { ok: true, log: { status: 'found', complete: true, truncated: false, offset: 0,
          text: selector.stream === 'stdout' ? stdout : '', ...extra } };
      },
    });
    assert.equal(Boolean(evidence), expected);
  }
});
