import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_RECONCILE_STALE_AFTER_MS,
  classifyTerminalTransition,
  evaluateReconcileFreshness,
  isPrUnverified,
  readPrTerminalReconcileState,
  reconcileTerminalPrState,
  writePrTerminalReconcileState,
} from '../src/pr-terminal-reconcile.mjs';

// TREC-01 regression suite.
//
// The defect shipped because the existing coverage only exercised the open-PR
// path. Nothing asserted what happens when a PR reaches a terminal state on
// GitHub WITHOUT the mirror learning about it — which is the only condition
// under which either alert misfires. These tests drive exactly that.

function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'trec01-reconcile-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The live 2026-09-07 population: three merged, one closed, one genuinely open.
const ROWS = [
  { repo: 'laceyenterprises/agent-os', pr_number: 6364 },
  { repo: 'laceyenterprises/agent-os', pr_number: 6383 },
  { repo: 'laceyenterprises/agent-os', pr_number: 6384 },
  { repo: 'laceyenterprises/agent-os', pr_number: 6394 },
  { repo: 'laceyenterprises/agent-os', pr_number: 6393 },
];

const LIVE = {
  6364: { state: 'MERGED', mergedAt: '2026-09-07T05:10:03Z', closedAt: '2026-09-07T05:10:03Z' },
  6383: { state: 'MERGED', mergedAt: '2026-09-07T04:43:31Z', closedAt: '2026-09-07T04:43:31Z' },
  6384: { state: 'MERGED', mergedAt: '2026-09-07T05:24:52Z', closedAt: '2026-09-07T05:24:52Z' },
  6394: { state: 'CLOSED', mergedAt: null, closedAt: '2026-09-07T05:50:15Z' },
  6393: { state: 'OPEN', mergedAt: null, closedAt: null },
};

function fakeMirror(rows) {
  // Minimal stand-in for reviewed_prs: enough to run the two real health
  // predicates against, without a SQLite fixture.
  const state = new Map(rows.map((row) => [row.pr_number, {
    ...row,
    pr_state: 'open',
    review_status: row.pr_number === 6394 ? 'pending' : 'posted',
    merged_at: null,
    closed_at: null,
  }]));
  return {
    state,
    markMerged: (mergedAt, repo, prNumber) => {
      const row = state.get(prNumber);
      row.pr_state = 'merged';
      row.merged_at = mergedAt;
    },
    markClosed: (closedAt, repo, prNumber) => {
      const row = state.get(prNumber);
      row.pr_state = 'closed';
      row.closed_at = closedAt;
    },
    // `summarizeFirstPassQueue`: WHERE pr_state='open' AND review_status='pending'
    firstPassQueue: () => [...state.values()].filter(
      (row) => row.pr_state === 'open' && row.review_status === 'pending'
    ),
    // `evaluateTtmTimelines`: `if (row.prState !== 'open') continue`
    terminalCandidates: () => [...state.values()].filter((row) => row.pr_state === 'open'),
  };
}

test('a flagged PR merged out-of-band and a queued PR closed out-of-band both clear', async () => {
  const mirror = fakeMirror(ROWS);

  // Before: every row is 'open', so both alert populations include the
  // already-terminal PRs. This is the shipped state on 2026-09-07.
  assert.deepEqual(
    mirror.firstPassQueue().map((r) => r.pr_number),
    [6394],
    'the CLOSED PR is in the first-pass queue before reconciliation',
  );
  assert.equal(
    mirror.terminalCandidates().length,
    5,
    'all five rows are terminal_but_unmerged candidates before reconciliation',
  );

  const summary = await reconcileTerminalPrState({
    rows: ROWS,
    fetchLiveState: async (repo, prNumber) => LIVE[prNumber],
    markMerged: mirror.markMerged,
    markClosed: mirror.markClosed,
    logger: { error() {}, log() {} },
  });

  assert.equal(summary.merged, 3);
  assert.equal(summary.closed, 1);
  assert.equal(summary.stillOpen, 1);
  assert.equal(summary.unresolvedCount, 0);

  // FAULT 1 cleared: the closed PR is evicted from the first-pass queue.
  assert.deepEqual(
    mirror.firstPassQueue().map((r) => r.pr_number),
    [],
    'queue_starvation must no longer see the closed PR',
  );

  // FAULT 2 cleared: merged PRs leave the terminal_but_unmerged population and
  // carry a real mergedAt.
  assert.deepEqual(
    mirror.terminalCandidates().map((r) => r.pr_number),
    [6393],
    'only the genuinely open PR remains a terminal_but_unmerged candidate',
  );
  assert.equal(mirror.state.get(6364).merged_at, '2026-09-07T05:10:03Z');
  assert.equal(mirror.state.get(6383).merged_at, '2026-09-07T04:43:31Z');
  assert.equal(mirror.state.get(6384).merged_at, '2026-09-07T05:24:52Z');
  assert.equal(mirror.state.get(6394).closed_at, '2026-09-07T05:50:15Z');
});

test('the genuinely open backlog is never suppressed', async () => {
  // The explicit constraint on this ticket: 11 of the 15 terminal_but_unmerged
  // flags were REAL. A sweep that "fixes" the alert by draining open rows would
  // hide a real backlog, which is strictly worse than the bug.
  const mirror = fakeMirror(ROWS);
  await reconcileTerminalPrState({
    rows: ROWS,
    fetchLiveState: async (repo, prNumber) => LIVE[prNumber],
    markMerged: mirror.markMerged,
    markClosed: mirror.markClosed,
    logger: { error() {}, log() {} },
  });
  const stillOpen = mirror.state.get(6393);
  assert.equal(stillOpen.pr_state, 'open');
  assert.equal(stillOpen.merged_at, null);
  assert.equal(stillOpen.closed_at, null);
});

test('one PR failing to resolve does not blind the sweep for the rest', async () => {
  // The live trigger on 2026-09-07 was a `gh: Bad credentials (HTTP 401)` burst.
  // The pre-fix loop `continue`d on a fetch throw with no record, so a single
  // bad tick left every row stale and silent.
  const mirror = fakeMirror(ROWS);
  const summary = await reconcileTerminalPrState({
    rows: ROWS,
    fetchLiveState: async (repo, prNumber) => {
      if (prNumber === 6383) {
        throw new Error('Command failed: gh api -i graphql\ngh: Bad credentials (HTTP 401)');
      }
      return LIVE[prNumber];
    },
    markMerged: mirror.markMerged,
    markClosed: mirror.markClosed,
    logger: { error() {}, log() {} },
  });

  assert.equal(summary.merged, 2, 'the other merged PRs must still be reconciled');
  assert.equal(summary.closed, 1);
  assert.equal(summary.unresolvedCount, 1);
  assert.deepEqual(summary.unresolved[0].repo, 'laceyenterprises/agent-os');
  assert.equal(summary.unresolved[0].prNumber, 6383);
  assert.match(
    summary.unresolved[0].reason,
    /Bad credentials \(HTTP 401\)/,
    'the recorded reason must name the actual fault, not a generic failure',
  );
  assert.equal(
    summary.unresolved[0].reason.includes('query PullRequestHeadState'),
    false,
    'the GraphQL document must not be inlined into the operator-facing reason',
  );
});

test('a merged PR reported by GitHub as state=CLOSED is filed as merged', async () => {
  // GraphQL says MERGED, some REST shapes say CLOSED with a non-null mergedAt.
  // Mis-filing a merge as a close would skip the merge closeout work entirely.
  assert.equal(classifyTerminalTransition({ state: 'CLOSED', mergedAt: '2026-09-07T05:10:03Z' }), 'merged');
  assert.equal(classifyTerminalTransition({ state: 'MERGED', mergedAt: null }), 'merged');
  assert.equal(classifyTerminalTransition({ state: 'CLOSED', mergedAt: null }), 'closed');
  assert.equal(classifyTerminalTransition({ state: 'OPEN', mergedAt: null }), null);
  assert.equal(classifyTerminalTransition(null), null, 'no information is not a transition');
});

test('a never-reconciled mirror reads as blind, not as clean', () => {
  withTempRoot((root) => {
    assert.equal(readPrTerminalReconcileState(root), null);
    const freshness = evaluateReconcileFreshness(null, { nowMs: Date.parse('2026-09-07T06:18:52Z') });
    assert.equal(freshness.blind, true);
    assert.equal(freshness.present, false);
    assert.equal(freshness.reason, 'no-reconcile-record');
    // Every PR is unverified when nothing has ever reconciled.
    assert.equal(isPrUnverified(freshness, 'laceyenterprises/agent-os', 6394), true);
  });
});

test('a corrupt reconcile record reads as blind rather than throwing', () => {
  withTempRoot((root) => {
    writePrTerminalReconcileState(root, { observedAt: '2026-09-07T06:00:00Z', checked: 1 });
    writeFileSync(join(root, 'data', 'pr-lifecycle-reconcile', 'state.json'), '{ not json');
    assert.equal(readPrTerminalReconcileState(root), null);
  });
});

test('a fresh clean sweep marks every PR verified; a stale one marks them all unverified', () => {
  withTempRoot((root) => {
    const nowMs = Date.parse('2026-09-07T06:18:52Z');
    writePrTerminalReconcileState(root, {
      observedAt: '2026-09-07T06:18:00Z',
      completedAt: '2026-09-07T06:18:10Z',
      checked: 5,
      merged: 3,
      closed: 1,
      unresolved: [],
    });
    const fresh = evaluateReconcileFreshness(readPrTerminalReconcileState(root), { nowMs });
    assert.equal(fresh.blind, false);
    assert.equal(isPrUnverified(fresh, 'laceyenterprises/agent-os', 6393), false);

    const stale = evaluateReconcileFreshness(
      { completedAt: '2026-09-07T05:00:00Z', checked: 5, unresolved: [] },
      { nowMs },
    );
    assert.equal(stale.blind, true, `78m > ${DEFAULT_RECONCILE_STALE_AFTER_MS}ms window`);
    assert.equal(stale.reason, 'reconcile-record-stale');
    assert.equal(
      isPrUnverified(stale, 'laceyenterprises/agent-os', 6393),
      true,
      'a stale whole-record attestation makes every PR unverified',
    );
  });
});

test('only the PRs that failed to resolve are marked unverified', () => {
  const freshness = evaluateReconcileFreshness({
    completedAt: '2026-09-07T06:18:10Z',
    checked: 5,
    unresolved: [{ repo: 'laceyenterprises/agent-os', prNumber: 6383, reason: 'HTTP 401' }],
  }, { nowMs: Date.parse('2026-09-07T06:18:52Z') });

  assert.equal(freshness.blind, true, 'an unresolved PR makes the surface partially blind');
  assert.equal(freshness.reason, 'live-state-unresolved');
  // This is the property that lets an operator tell a phantom from a real
  // finding: per-PR, not a blanket verdict over the whole population.
  assert.equal(isPrUnverified(freshness, 'laceyenterprises/agent-os', 6383), true);
  assert.equal(isPrUnverified(freshness, 'laceyenterprises/agent-os', 6393), false);
});

test('the sweep honours a per-run cap without silently dropping the remainder', async () => {
  const mirror = fakeMirror(ROWS);
  const summary = await reconcileTerminalPrState({
    rows: ROWS,
    fetchLiveState: async (repo, prNumber) => LIVE[prNumber],
    markMerged: mirror.markMerged,
    markClosed: mirror.markClosed,
    cap: 2,
    logger: { error() {}, log() {} },
  });
  assert.equal(summary.checked, 2);
  assert.equal(summary.skippedOverCap, 3, 'the skipped remainder must be counted, not hidden');
});
