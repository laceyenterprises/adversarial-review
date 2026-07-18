import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPipelineRollup, shortRevision } from '../src/kernel/pipeline-rollup.mjs';

// ── Snapshots (SPEC §1 Win 2) ────────────────────────────────────────────────

test('rollup snapshot: BLOCKED at security (Win 2)', () => {
  const body = renderPipelineRollup({
    revisionRef: '4f2c9a1abcdef',
    rows: [
      { stageId: 'code-quality', roleId: 'code-quality-reviewer', verdict: 'comment-only', round: 1, roundBudget: 2 },
      { stageId: 'security', roleId: 'security-reviewer', verdict: 'request-changes', round: 1, roundBudget: 3 },
    ],
    disposition: 'blocking',
    blockingStageId: 'security',
    blockingFindingsCount: 2,
  });
  assert.equal(body, [
    '## Adversarial review — pipeline rollup (rev 4f2c9a1)',
    '| stage        | reviewer role         | verdict         | round |',
    '| ------------ | --------------------- | --------------- | ----- |',
    '| code-quality | code-quality-reviewer | comment-only    | 1/2   |',
    '| security     | security-reviewer     | request-changes | 1/3   |',
    'pipeline: BLOCKED at security — 2 blocking findings routed to remediation',
  ].join('\n'));
});

test('rollup snapshot: CLEAN across both stages', () => {
  const body = renderPipelineRollup({
    revisionRef: 'deadbeef1234',
    rows: [
      { stageId: 'code-quality', roleId: 'code-quality-reviewer', verdict: 'comment-only', round: 1, roundBudget: 2 },
      { stageId: 'security', roleId: 'security-reviewer', verdict: 'approved', round: 2, roundBudget: 3 },
    ],
    disposition: 'clean',
  });
  assert.equal(body, [
    '## Adversarial review — pipeline rollup (rev deadbee)',
    '| stage        | reviewer role         | verdict      | round |',
    '| ------------ | --------------------- | ------------ | ----- |',
    '| code-quality | code-quality-reviewer | comment-only | 1/2   |',
    '| security     | security-reviewer     | approved     | 2/3   |',
    'pipeline: CLEAN — all 2 stages clean at rev deadbee',
  ].join('\n'));
});

test('rollup snapshot: a downstream stage that did not run renders "not run"', () => {
  const body = renderPipelineRollup({
    revisionRef: 'abc1234def',
    rows: [
      { stageId: 'code-quality', roleId: 'code-quality-reviewer', verdict: 'request-changes', round: 1, roundBudget: 2 },
      { stageId: 'security', roleId: 'security-reviewer', verdict: null, round: null, roundBudget: 3 },
    ],
    disposition: 'blocking',
    blockingStageId: 'code-quality',
    blockingFindingsCount: 1,
  });
  assert.equal(body, [
    '## Adversarial review — pipeline rollup (rev abc1234)',
    '| stage        | reviewer role         | verdict         | round |',
    '| ------------ | --------------------- | --------------- | ----- |',
    '| code-quality | code-quality-reviewer | request-changes | 1/2   |',
    '| security     | security-reviewer     | not run         | —     |',
    'pipeline: BLOCKED at code-quality — 1 blocking finding routed to remediation',
  ].join('\n'));
});

test('rollup snapshot: PENDING when a stage has no verdict yet', () => {
  const body = renderPipelineRollup({
    revisionRef: 'feedface99',
    rows: [
      { stageId: 'code-quality', roleId: 'code-quality-reviewer', verdict: 'unknown', round: 1, roundBudget: 2 },
      { stageId: 'security', roleId: 'security-reviewer', verdict: null, round: null, roundBudget: 3 },
    ],
    disposition: 'pending',
    pendingStageId: 'code-quality',
  });
  assert.match(body, /pipeline: PENDING at code-quality — awaiting verdict at rev feedfac/);
});

// ── Units ────────────────────────────────────────────────────────────────────

test('shortRevision abbreviates to 7 chars and tolerates short/empty refs', () => {
  assert.equal(shortRevision('4f2c9a1abcdef'), '4f2c9a1');
  assert.equal(shortRevision('abc'), 'abc');
  assert.equal(shortRevision(''), '(unknown)');
  assert.equal(shortRevision(null), '(unknown)');
});

test('blocking-findings count is singular for one finding, plural otherwise', () => {
  const one = renderPipelineRollup({ revisionRef: 'r', rows: [], disposition: 'blocking', blockingStageId: 's', blockingFindingsCount: 1 });
  assert.match(one, /1 blocking finding routed/);
  const many = renderPipelineRollup({ revisionRef: 'r', rows: [], disposition: 'blocking', blockingStageId: 's', blockingFindingsCount: 3 });
  assert.match(many, /3 blocking findings routed/);
});
