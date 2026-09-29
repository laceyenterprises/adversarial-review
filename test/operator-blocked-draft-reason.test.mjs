// COMMENTCLOSE-01 item 4: a draft PR parked for an operator is named as a draft
// in the operator-blocked lane, not reported as unresolved findings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNoProgressLaneGate } from '../src/posted-review-row.mjs';
import {
  DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS,
  LANE_OPERATOR_BLOCKED,
  maybeFireOperatorDecisionRequiredAlert,
  readNoProgressLane,
} from '../src/watcher-no-progress-lane.mjs';

const REPO = 'laceyenterprises/agent-os';
const HEAD = 'c1bc531623756ca7f423e5b62575ca5ebfb2207f';
const silent = { log() {}, warn() {}, error() {} };

test('the operator-blocked lane records and alerts a draft as the reason', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'operator-blocked-draft-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const alerts = [];
  const gate = createNoProgressLaneGate({
    rootDir,
    readReviewRow: () => ({ repo: REPO, pr_number: 7311, review_status: 'posted', reviewer_head_sha: HEAD }),
    deliverAlertFn: async (text, meta) => { alerts.push({ text, meta }); },
    now: () => '2026-09-28T22:00:00.000Z',
    logger: silent,
  });
  const handler = { repoPath: REPO, prNumber: 7311, headSha: HEAD };
  const value = {
    outcome: 'await-operator',
    amaClosureResult: { reason: 'background-pr-draft', skipMergeAgent: true, needsOperator: true, operatorReason: 'pr-is-draft' },
  };
  for (let tick = 0; tick <= DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS; tick += 1) {
    await gate.record(handler, { value });
  }
  const ledger = readNoProgressLane(rootDir, { repo: REPO, prNumber: 7311 }, { logger: silent });
  assert.equal(ledger.lane, LANE_OPERATOR_BLOCKED);
  assert.equal(ledger.operatorReason, 'pr-is-draft');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /The PR is a draft/);
  assert.match(alerts[0].text, /gh pr ready/);
  assert.doesNotMatch(alerts[0].text, /findings unresolved/);
  assert.equal(alerts[0].meta.payload.reason, 'pr-is-draft');
});

test('an unnamed operator block keeps the findings-unresolved alert text', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'operator-blocked-default-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const alerts = [];
  await maybeFireOperatorDecisionRequiredAlert({
    rootDir,
    identity: { repo: REPO, prNumber: 7312 },
    headSha: HEAD,
    operatorReason: 'not-eligible:risk-class-not-permitted',
    noProgressTicks: DEFAULT_OPERATOR_BLOCKED_ALERT_NO_PROGRESS_TICKS,
    deliverAlertFn: async (text, meta) => { alerts.push({ text, meta }); },
    logger: silent,
  });
  assert.match(alerts[0].text, /Remediation stopped or failed with findings unresolved/);
  assert.equal(alerts[0].meta.payload.reason, 'remediation-terminal-findings-unresolved');
});
