import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { reconcileTerminalPrState } from '../src/pr-terminal-reconcile.mjs';
import { logLifecycleReconcileSummary } from '../src/pr-lifecycle-sync.mjs';
import {
  attemptPendingTriageSync,
  listPendingTriageSyncs,
  queuePendingTriageSync,
  retryPendingTriageSyncs,
} from '../src/pending-triage-sync.mjs';

// TREC-01 replaced the source-grep guard that used to live here.
//
// The old guard asserted the literal source ordering
// `syncTriageStatus -> stmtMarkMerged -> branch-level catch`, and that the
// triage call must NOT have an isolated catch. Its stated reason was sound:
// "Swallowing this remote failure would mark the row merged/closed while
// leaving Linear permanently stale."
//
// That ordering enforced the invariant by making the OPEN ROW the retry vehicle
// for the Linear obligation. Which is exactly what made
// `review:queue_starvation` and `review:terminal_but_unmerged` fire forever on
// already-terminal PRs: both select on `pr_state='open'` and threshold on
// elapsed age, so a row held open for a remote retry becomes an alert that can
// never clear (2026-09-07: 4 merged PRs flagged unmerged, 1 closed PR still
// `firstPassQueue.oldest` 28.6 minutes after closing).
//
// The obligation now has its own durable record, so BOTH invariants hold at
// once. These are behavioural tests rather than source greps: they exercise the
// real code paths, so they keep holding under refactors that a string match
// would either miss or falsely fail.
//
// The properties pinned here:
//   1. A Linear failure does NOT prevent the terminal mark.  (the TREC-01 fix)
//   2. A Linear failure is NOT lost — it stays durably queued and a later drain
//      completes it.                                        (the OLD invariant)
//   3. Owed work that fails to PERSIST still defers the mark, because at that
//      point the open row really is the only record of the obligation.

async function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'trec01-triage-'));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const MERGED_ROW = { repo: 'laceyenterprises/agent-os', pr_number: 6364 };
const MERGED_LIVE = {
  state: 'MERGED',
  mergedAt: '2026-09-07T05:10:03Z',
  closedAt: '2026-09-07T05:10:03Z',
  headRefOid: 'c04ab8fb48',
  labels: [],
};

test('a Linear triage failure does not prevent the terminal mark', async () => {
  await withTempRoot(async (root) => {
    const marks = [];
    const summary = await reconcileTerminalPrState({
      rows: [MERGED_ROW],
      fetchLiveState: async () => MERGED_LIVE,
      onBeforeMark: async ({ repo, prNumber, transition }) => {
        queuePendingTriageSync(root, {
          repo, prNumber, transition, status: 'finalized', linearTicketId: 'ENG-1',
        });
      },
      onAfterMark: async () => {
        throw new Error('Linear API is down');
      },
      markMerged: (mergedAt, repo, prNumber) => marks.push({ mergedAt, repo, prNumber }),
      markClosed: () => assert.fail('a merged PR must not be marked closed'),
      logger: { error() {}, log() {} },
    });

    assert.equal(summary.merged, 1, 'the merge must be recorded despite the Linear failure');
    assert.deepEqual(marks, [{
      mergedAt: '2026-09-07T05:10:03Z',
      repo: MERGED_ROW.repo,
      prNumber: MERGED_ROW.pr_number,
    }]);
    assert.equal(summary.reportFailureCount, 1, 'the reporting failure must still be surfaced');
    assert.match(summary.reportFailures[0].reason, /Linear API is down/);
  });
});

test('a Linear triage failure stays durably queued and a later drain completes it', async () => {
  await withTempRoot(async (root) => {
    queuePendingTriageSync(root, {
      repo: MERGED_ROW.repo,
      prNumber: MERGED_ROW.pr_number,
      transition: 'merged',
      status: 'finalized',
      linearTicketId: 'ENG-1',
      labels: ['claude-code'],
      revisionRef: 'c04ab8fb48',
    });

    // First attempt fails, exactly as it would during a Linear outage.
    const failing = await attemptPendingTriageSync({
      rootDir: root,
      record: listPendingTriageSyncs(root)[0].record,
      operatorSurface: { syncTriageStatus: async () => { throw new Error('502'); } },
      buildSubjectRef: (record) => record,
      logger: { error() {} },
    });
    assert.equal(failing.ok, false);
    assert.equal(
      listPendingTriageSyncs(root).length,
      1,
      'the obligation must survive a failed attempt — this is the invariant the old guard protected',
    );

    // A later tick drains it. `retryMs: 0` stands in for the elapsed interval.
    const seen = [];
    const drained = await retryPendingTriageSyncs({
      rootDir: root,
      operatorSurface: {
        syncTriageStatus: async (subjectRef, status) => { seen.push({ subjectRef, status }); },
      },
      buildSubjectRef: (record) => ({ repo: record.repo, prNumber: record.prNumber }),
      retryMs: 0,
      logger: { error() {}, log() {} },
    });

    assert.equal(drained.synced, 1, 'the drain must complete the owed sync');
    assert.deepEqual(seen, [{
      subjectRef: { repo: MERGED_ROW.repo, prNumber: MERGED_ROW.pr_number },
      status: 'finalized',
    }], 'the replayed call must carry the transition status recorded at queue time');
    assert.equal(
      listPendingTriageSyncs(root).length,
      0,
      'a completed obligation must be cleared so it cannot be replayed forever',
    );
  });
});

test('owed work that fails to persist still defers the mark', async () => {
  await withTempRoot(async () => {
    const marks = [];
    const summary = await reconcileTerminalPrState({
      rows: [MERGED_ROW],
      fetchLiveState: async () => MERGED_LIVE,
      onBeforeMark: async () => {
        // e.g. fireDagAutowalkOnMerge or queuePendingTriageSync failing to
        // write. Nothing durable now remembers the obligation, so the row must
        // stay open — it is the only remaining record that work is owed.
        throw new Error('ENOSPC writing owed-work record');
      },
      markMerged: (...args) => marks.push(args),
      markClosed: () => assert.fail('must not mark'),
      logger: { error() {}, log() {} },
    });

    assert.equal(marks.length, 0, 'the mark must be deferred when owed work did not persist');
    assert.equal(summary.merged, 0);
    assert.equal(summary.deferredCount, 1);
    assert.match(summary.deferred[0].reason, /ENOSPC/);
  });
});

test('deferred lifecycle marks are logged loudly for daemon operators', () => {
  const errors = [];
  logLifecycleReconcileSummary({
    checked: 2,
    merged: 0,
    closed: 0,
    stillOpen: 1,
    unresolvedCount: 0,
    deferredCount: 1,
    unresolved: [],
    deferred: [{
      repo: MERGED_ROW.repo,
      prNumber: MERGED_ROW.pr_number,
      transition: 'merged',
      reason: 'ENOSPC writing owed-work record',
    }],
  }, {
    error: (message) => errors.push(message),
    log: () => {},
  });

  assert.equal(errors.length, 2);
  assert.match(errors[0], /Deferred terminal mark for PR laceyenterprises\/agent-os#6364/);
  assert.match(errors[0], /ENOSPC writing owed-work record/);
  assert.match(errors[1], /deferred 1\/2 terminal mark/);
});

test('the queued record carries everything the drain needs without the reviewed_prs row', async () => {
  await withTempRoot(async (root) => {
    // Once the row is marked terminal it leaves `stmtGetOpenPRs`, so a drain on
    // a later tick cannot look the subject ref back up. Regression guard: the
    // record must be self-sufficient.
    queuePendingTriageSync(root, {
      repo: MERGED_ROW.repo,
      prNumber: MERGED_ROW.pr_number,
      transition: 'closed',
      status: 'halted',
      domainId: 'code-pr',
      linearTicketId: 'ENG-42',
      labels: ['codex'],
      revisionRef: 'deadbeef',
    });
    const { record } = listPendingTriageSyncs(root)[0];
    assert.equal(record.domainId, 'code-pr');
    assert.equal(record.linearTicketId, 'ENG-42');
    assert.equal(record.triageStatus, 'halted');
    assert.equal(record.revisionRef, 'deadbeef');
    assert.deepEqual(record.labels, ['codex']);
  });
});

test('a new triage obligation resets retry exhaustion from an older transition', async () => {
  await withTempRoot(async (root) => {
    queuePendingTriageSync(root, {
      repo: MERGED_ROW.repo,
      prNumber: MERGED_ROW.pr_number,
      transition: 'closed',
      status: 'halted',
      linearTicketId: 'ENG-1',
      now: new Date('2026-09-07T05:00:00.000Z'),
    });
    await attemptPendingTriageSync({
      rootDir: root,
      record: listPendingTriageSyncs(root)[0].record,
      operatorSurface: { syncTriageStatus: async () => { throw new Error('502'); } },
      buildSubjectRef: (record) => record,
      logger: { error() {} },
      maxAttempts: 1,
    });

    queuePendingTriageSync(root, {
      repo: MERGED_ROW.repo,
      prNumber: MERGED_ROW.pr_number,
      transition: 'merged',
      status: 'finalized',
      linearTicketId: 'ENG-1',
      now: new Date('2026-09-07T06:00:00.000Z'),
    });

    const { record } = listPendingTriageSyncs(root)[0];
    assert.equal(record.transition, 'merged');
    assert.equal(record.triageStatus, 'finalized');
    assert.equal(record.status, 'pending');
    assert.equal(record.attempts, 0);
    assert.equal(record.lastAttemptAt, null);
    assert.equal(record.lastError, null);
  });
});

test('idempotently re-queueing the same triage obligation preserves retry state', async () => {
  await withTempRoot(async (root) => {
    queuePendingTriageSync(root, {
      repo: MERGED_ROW.repo,
      prNumber: MERGED_ROW.pr_number,
      transition: 'merged',
      status: 'finalized',
      linearTicketId: 'ENG-1',
      now: new Date('2026-09-07T05:00:00.000Z'),
    });
    await attemptPendingTriageSync({
      rootDir: root,
      record: listPendingTriageSyncs(root)[0].record,
      operatorSurface: { syncTriageStatus: async () => { throw new Error('502'); } },
      buildSubjectRef: (record) => record,
      logger: { error() {} },
      maxAttempts: 12,
    });

    queuePendingTriageSync(root, {
      repo: MERGED_ROW.repo,
      prNumber: MERGED_ROW.pr_number,
      transition: 'merged',
      status: 'finalized',
      linearTicketId: 'ENG-1',
      now: new Date('2026-09-07T06:00:00.000Z'),
    });

    const { record } = listPendingTriageSyncs(root)[0];
    assert.equal(record.attempts, 1);
    assert.match(record.lastAttemptAt, /^2026-/);
    assert.equal(record.lastError.message, '502');
  });
});

test('malformed pending triage sync records are quarantined out of the active drain', async () => {
  await withTempRoot(async (root) => {
    const malformedPath = join(root, 'data', 'follow-up-jobs', 'pending-triage-sync', 'malformed.json');
    mkdirSync(dirname(malformedPath), { recursive: true });
    writeFileSync(malformedPath, `${JSON.stringify({ schemaVersion: 1, prNumber: 6364 })}\n`);
    const errors = [];

    const drained = await retryPendingTriageSyncs({
      rootDir: root,
      operatorSurface: {
        syncTriageStatus: async () => assert.fail('malformed record must not call Linear'),
      },
      buildSubjectRef: (record) => record,
      retryMs: 0,
      logger: { error: (message) => errors.push(message), log() {} },
    });

    assert.equal(drained.attempted, 1);
    assert.equal(drained.synced, 0);
    assert.equal(drained.pending, 1);
    assert.equal(listPendingTriageSyncs(root).length, 0);
    assert.equal(existsSync(malformedPath), false);
    assert.equal(existsSync(`${malformedPath}.failed`), true);
    assert.equal(
      errors.some((message) => message.includes('malformed triage sync record moved')),
      true,
      'the quarantine must be loud in daemon logs',
    );
  });
});

test('unparseable pending triage sync JSON is quarantined out of the active drain', async () => {
  await withTempRoot(async (root) => {
    const malformedPath = join(root, 'data', 'follow-up-jobs', 'pending-triage-sync', 'broken.json');
    mkdirSync(dirname(malformedPath), { recursive: true });
    writeFileSync(malformedPath, '{ not valid json\n');
    const errors = [];

    const drained = await retryPendingTriageSyncs({
      rootDir: root,
      operatorSurface: {
        syncTriageStatus: async () => assert.fail('unparseable record must not call Linear'),
      },
      buildSubjectRef: (record) => record,
      retryMs: 0,
      logger: { error: (message) => errors.push(message), log() {} },
    });

    assert.equal(drained.attempted, 1);
    assert.equal(drained.synced, 0);
    assert.equal(drained.pending, 1);
    assert.equal(listPendingTriageSyncs(root).length, 0);
    assert.equal(existsSync(malformedPath), false);
    assert.equal(existsSync(`${malformedPath}.failed`), true);
    assert.equal(
      errors.some((message) => message.includes('malformed triage sync record moved')),
      true,
      'the quarantine must be loud in daemon logs',
    );
  });
});
