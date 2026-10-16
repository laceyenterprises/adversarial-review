import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoProgressLaneGate } from '../src/posted-review-row.mjs';

const headSha = 'a'.repeat(40);
const handler = { repoPath: 'example/project', prNumber: 42, headSha };
const logger = { log() {}, warn() {}, error() {} };
const finalGate = { operatorDecisionRequired: true, reason: 'remediation-stopped' };
const pending = { outcome: 'ama-pending', hammerRouteActive: true, gateDecision: finalGate,
  amaClosureResult: { reason: 'ama-closer-dispatch-backgrounded', skipMergeAgent: true } };

function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamlane-'));
  const gate = createNoProgressLaneGate({ rootDir, hqRoot: rootDir, logger,
    readReviewRow: () => ({ review_status: 'posted', reviewer_head_sha: headSha,
      posted_at: '2026-10-16T12:00:00Z' }), deliverAlertFn: async () => {} });
  return { rootDir, gate };
}

test('HAMLANE-01 final NOT CONVERGED with retained hammer route walks every next tick', async () => {
  const { rootDir, gate } = fixture();
  try {
    for (let tick = 0; tick < 12; tick++) {
      const outcome = await gate.record(handler, { value: pending });
      assert.equal(outcome.lane, 'active');
      assert.equal(gate.evaluate(handler).run, true);
    }
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('HAMLANE-01 a real operator hold replaces hammer urgency and keeps its cadence', async () => {
  const { rootDir, gate } = fixture();
  try {
    await gate.record(handler, { value: pending });
    assert.equal(gate.evaluate(handler).run, true);
    for (const operatorReason of ['hammer-stop-awaiting-input-change',
      'hammer-lifetime-dispatch-ceiling', 'pr-is-draft', 'hard-stop-label']) {
      const outcome = await gate.record(handler, { value: { outcome: 'await-operator',
        gateDecision: finalGate, amaClosureResult: { needsOperator: true, operatorReason } } });
      assert.equal(outcome.lane, 'operator-blocked');
      for (let tick = 0; tick < 3; tick++) assert.equal(gate.evaluate(handler).run, false);
      assert.equal(gate.evaluate(handler).run, true);
    }
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
