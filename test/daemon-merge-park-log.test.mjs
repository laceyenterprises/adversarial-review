import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  PARK_REMEDIES,
  clearDaemonMergePark,
  parkRecordPath,
  readDaemonMergeParks,
  recordDaemonMergePark,
} from '../src/daemon-merge-park-log.mjs';
import { collectReviewPipelineHealth } from '../src/review-pipeline-health.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';

function withRoot(fn) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'daemon-merge-park-'));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function insertReviewRow(rootDir, { repo, prNumber, prState = 'open' }) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    db.prepare(
      `INSERT INTO reviewed_prs
         (repo, pr_number, reviewed_at, reviewer, pr_state, review_status,
          review_attempts, last_attempted_at, posted_at, failed_at, failure_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      repo,
      prNumber,
      '2026-08-23T17:00:00.000Z',
      'gemini',
      prState,
      'posted',
      1,
      '2026-08-23T17:00:00.000Z',
      '2026-08-23T17:01:00.000Z',
      null,
      null,
    );
  } finally {
    db.close();
  }
}

test('records a park with observationCount 1 and the reason-specific remedy', () => {
  withRoot((rootDir) => {
    const record = recordDaemonMergePark({
      rootDir,
      repo: 'laceyenterprises/foundry',
      prNumber: 35,
      headSha: '1f457cfcb6b74ddb57a2c0f781406feacaa79df4',
      reason: 'worker-identity-unresolved',
      observedAt: '2026-08-23T17:00:00.000Z',
    });

    assert.equal(record.observationCount, 1);
    assert.equal(record.firstObservedAt, '2026-08-23T17:00:00.000Z');
    assert.equal(record.lastObservedAt, '2026-08-23T17:00:00.000Z');
    assert.equal(record.remedy, PARK_REMEDIES['worker-identity-unresolved']);
    assert.match(record.remedy, /hq pr sign/);

    const onDisk = JSON.parse(
      readFileSync(parkRecordPath(rootDir, 'laceyenterprises/foundry', 35), 'utf8'),
    );
    assert.equal(onDisk.prNumber, 35);
    assert.equal(onDisk.reason, 'worker-identity-unresolved');
  });
});

test('a repeat park with the same reason increments and preserves firstObservedAt', () => {
  withRoot((rootDir) => {
    const args = {
      rootDir,
      repo: 'laceyenterprises/foundry',
      prNumber: 35,
      reason: 'worker-identity-unresolved',
    };
    recordDaemonMergePark({ ...args, observedAt: '2026-08-23T17:00:00.000Z' });
    recordDaemonMergePark({ ...args, observedAt: '2026-08-23T17:07:00.000Z' });
    const third = recordDaemonMergePark({ ...args, observedAt: '2026-08-23T17:14:00.000Z' });

    assert.equal(third.observationCount, 3);
    assert.equal(third.firstObservedAt, '2026-08-23T17:00:00.000Z');
    assert.equal(third.lastObservedAt, '2026-08-23T17:14:00.000Z');
  });
});

test('a park with a different reason restarts the record', () => {
  withRoot((rootDir) => {
    const base = { rootDir, repo: 'laceyenterprises/agent-os', prNumber: 5789 };
    recordDaemonMergePark({
      ...base,
      reason: 'worker-identity-unresolved',
      observedAt: '2026-08-23T17:00:00.000Z',
    });
    recordDaemonMergePark({
      ...base,
      reason: 'worker-identity-unresolved',
      observedAt: '2026-08-23T17:07:00.000Z',
    });
    const switched = recordDaemonMergePark({
      ...base,
      reason: 'lease-not-held',
      observedAt: '2026-08-23T17:14:00.000Z',
    });

    // The previous reason is no longer what blocks the merge, so the run resets
    // rather than inheriting a count earned under a different cause.
    assert.equal(switched.reason, 'lease-not-held');
    assert.equal(switched.observationCount, 1);
    assert.equal(switched.firstObservedAt, '2026-08-23T17:14:00.000Z');
  });
});

test('clearing a park removes it from the read set', () => {
  withRoot((rootDir) => {
    recordDaemonMergePark({
      rootDir,
      repo: 'laceyenterprises/foundry',
      prNumber: 35,
      reason: 'worker-identity-unresolved',
      observedAt: '2026-08-23T17:00:00.000Z',
    });
    assert.equal(readDaemonMergeParks({ rootDir }).length, 1);

    clearDaemonMergePark({ rootDir, repo: 'laceyenterprises/foundry', prNumber: 35 });
    assert.deepEqual(readDaemonMergeParks({ rootDir }), []);
  });
});

test('clearing a park that was never recorded is a no-op, not a throw', () => {
  withRoot((rootDir) => {
    assert.equal(
      clearDaemonMergePark({ rootDir, repo: 'laceyenterprises/foundry', prNumber: 999 }),
      true,
    );
  });
});

test('a corrupt record is skipped instead of blinding the whole read', () => {
  withRoot((rootDir) => {
    recordDaemonMergePark({
      rootDir,
      repo: 'laceyenterprises/foundry',
      prNumber: 35,
      reason: 'worker-identity-unresolved',
      observedAt: '2026-08-23T17:00:00.000Z',
    });
    mkdirSync(path.join(rootDir, 'data', 'daemon-merge-parks'), { recursive: true });
    writeFileSync(
      path.join(rootDir, 'data', 'daemon-merge-parks', 'corrupt__pr-1.json'),
      '{ this is not json',
      'utf8',
    );
    writeFileSync(
      path.join(rootDir, 'data', 'daemon-merge-parks', 'malformed__pr-2.json'),
      '{"repo":"laceyenterprises/foundry"}\n',
      'utf8',
    );

    const parks = readDaemonMergeParks({ rootDir });
    assert.equal(parks.length, 1);
    assert.equal(parks[0].prNumber, 35);
    assert.equal(
      existsSync(path.join(rootDir, 'data', 'daemon-merge-parks', 'corrupt__pr-1.json')),
      false,
    );
    assert.equal(
      existsSync(path.join(rootDir, 'data', 'daemon-merge-parks', 'malformed__pr-2.json')),
      false,
    );
  });
});

test('reading an absent park directory returns empty rather than throwing', () => {
  withRoot((rootDir) => {
    assert.deepEqual(readDaemonMergeParks({ rootDir }), []);
  });
});

test('a write failure never propagates out of the merge path', () => {
  withRoot((rootDir) => {
    const record = recordDaemonMergePark({
      rootDir,
      repo: 'laceyenterprises/foundry',
      prNumber: 35,
      reason: 'worker-identity-unresolved',
      observedAt: '2026-08-23T17:00:00.000Z',
      writeFileAtomicImpl: () => {
        throw new Error('disk full');
      },
    });
    // Diagnostics are best-effort: the daemon that observed the park must not
    // fail because recording it failed.
    assert.equal(record, null);
  });
});

test('an async atomic-write rejection is observed instead of becoming unhandled', () => {
  withRoot((rootDir) => {
    let catchAttached = false;
    const record = recordDaemonMergePark({
      rootDir,
      repo: 'laceyenterprises/foundry',
      prNumber: 35,
      reason: 'worker-identity-unresolved',
      observedAt: '2026-08-23T17:00:00.000Z',
      writeFileAtomicImpl: () => ({
        catch(onRejected) {
          catchAttached = true;
          onRejected(new Error('disk full'));
        },
      }),
    });

    assert.equal(record.prNumber, 35);
    assert.equal(catchAttached, true);
  });
});

test('records are ignored when required identity fields are missing', () => {
  withRoot((rootDir) => {
    assert.equal(recordDaemonMergePark({ rootDir, repo: '', prNumber: 1, reason: 'x' }), null);
    assert.equal(
      recordDaemonMergePark({ rootDir, repo: 'a/b', prNumber: Number.NaN, reason: 'x' }),
      null,
    );
    assert.equal(recordDaemonMergePark({ rootDir, repo: 'a/b', prNumber: 1, reason: '' }), null);
    assert.deepEqual(readDaemonMergeParks({ rootDir }), []);
  });
});

test('a standing park surfaces as a health finding that names the reason and the lever', () => {
  withRoot((rootDir) => {
    insertReviewRow(rootDir, {
      repo: 'laceyenterprises/foundry',
      prNumber: 35,
    });

    // Replays laceyenterprises/foundry#35 (2026-08-23): the daemon declined it
    // every tick on `worker-identity-unresolved` while the review sat settled
    // clean. Before this finding existed the only symptom was a generic
    // `terminal_but_unmerged` and the PR stalled 8.8 hours.
    for (const at of ['17:00', '17:07', '17:14']) {
      recordDaemonMergePark({
        rootDir,
        repo: 'laceyenterprises/foundry',
        prNumber: 35,
        headSha: '1f457cfcb6b74ddb57a2c0f781406feacaa79df4',
        reason: 'worker-identity-unresolved',
        observedAt: `2026-08-23T${at}:00.000Z`,
      });
    }

    const snapshot = collectReviewPipelineHealth({
      rootDir,
      now: () => new Date('2026-08-23T17:20:00Z'),
    });
    const findings = snapshot.findings.filter((f) => f.code === 'review:daemon_merge_parked');

    assert.equal(findings.length, 1);
    assert.match(findings[0].subject, /worker-identity-unresolved/);
    assert.match(findings[0].message, /laceyenterprises\/foundry#35/);
    assert.match(findings[0].message, /3 consecutive time\(s\)/);
    // The whole point: the ticket names the lever instead of listing candidates.
    assert.match(findings[0].recommended_action, /hq pr sign/);
    assert.equal(findings[0].details.parks.length, 1);
  });
});

test('health collection expires stale park records for PRs no longer evaluated', () => {
  withRoot((rootDir) => {
    insertReviewRow(rootDir, {
      repo: 'laceyenterprises/foundry',
      prNumber: 35,
    });
    for (const at of ['17:00', '17:07', '17:14']) {
      recordDaemonMergePark({
        rootDir,
        repo: 'laceyenterprises/foundry',
        prNumber: 35,
        headSha: '1f457cfcb6b74ddb57a2c0f781406feacaa79df4',
        reason: 'worker-identity-unresolved',
        observedAt: `2026-08-23T${at}:00.000Z`,
      });
    }

    const snapshot = collectReviewPipelineHealth({
      rootDir,
      now: () => new Date('2026-08-23T17:30:01Z'),
    });

    assert.deepEqual(snapshot.daemonMergeParks, []);
    assert.deepEqual(
      snapshot.findings.filter((f) => f.code === 'review:daemon_merge_parked'),
      [],
    );
    assert.equal(existsSync(parkRecordPath(rootDir, 'laceyenterprises/foundry', 35)), false);
  });
});

test('health collection prunes park records for PRs no longer active', () => {
  withRoot((rootDir) => {
    insertReviewRow(rootDir, {
      repo: 'laceyenterprises/foundry',
      prNumber: 35,
      prState: 'closed',
    });
    for (const at of ['17:00', '17:07', '17:14']) {
      recordDaemonMergePark({
        rootDir,
        repo: 'laceyenterprises/foundry',
        prNumber: 35,
        headSha: '1f457cfcb6b74ddb57a2c0f781406feacaa79df4',
        reason: 'worker-identity-unresolved',
        observedAt: `2026-08-23T${at}:00.000Z`,
      });
    }

    const snapshot = collectReviewPipelineHealth({
      rootDir,
      now: () => new Date('2026-08-24T01:50:00Z'),
    });

    assert.deepEqual(snapshot.daemonMergeParks, []);
    assert.deepEqual(
      snapshot.findings.filter((f) => f.code === 'review:daemon_merge_parked'),
      [],
    );
    assert.equal(existsSync(parkRecordPath(rootDir, 'laceyenterprises/foundry', 35)), false);
  });
});

test('health collection preserves park records when the review DB is unavailable', () => {
  withRoot((rootDir) => {
    recordDaemonMergePark({
      rootDir,
      repo: 'laceyenterprises/foundry',
      prNumber: 35,
      reason: 'worker-identity-unresolved',
      observedAt: '2026-08-23T17:00:00.000Z',
    });

    const snapshot = collectReviewPipelineHealth({
      rootDir,
      now: () => new Date('2026-08-23T17:05:00Z'),
    });

    assert.equal(snapshot.daemonMergeParks.length, 1);
    assert.equal(snapshot.daemonMergeParks[0].prNumber, 35);
    assert.equal(existsSync(parkRecordPath(rootDir, 'laceyenterprises/foundry', 35)), true);
  });
});

test('health collection accepts iterable active rows when pruning park records', () => {
  withRoot((rootDir) => {
    recordDaemonMergePark({
      rootDir,
      repo: 'laceyenterprises/foundry',
      prNumber: 35,
      reason: 'worker-identity-unresolved',
      observedAt: '2026-08-23T17:00:00.000Z',
    });

    const parks = readDaemonMergeParks({
      rootDir,
      activeReviewRows: new Set([
        {
          repo: 'laceyenterprises/foundry',
          prNumber: 35,
          prState: 'open',
        },
      ]),
    });

    assert.equal(parks.length, 1);
    assert.equal(parks[0].prNumber, 35);
    assert.equal(existsSync(parkRecordPath(rootDir, 'laceyenterprises/foundry', 35)), true);
  });
});

test('a park below the observation threshold does not ticket', () => {
  withRoot((rootDir) => {
    insertReviewRow(rootDir, {
      repo: 'laceyenterprises/foundry',
      prNumber: 35,
    });

    recordDaemonMergePark({
      rootDir,
      repo: 'laceyenterprises/foundry',
      prNumber: 35,
      reason: 'worker-identity-unresolved',
      observedAt: '2026-08-23T17:00:00.000Z',
    });

    const snapshot = collectReviewPipelineHealth({
      rootDir,
      now: () => new Date('2026-08-23T17:05:00Z'),
    });
    assert.deepEqual(
      snapshot.findings.filter((f) => f.code === 'review:daemon_merge_parked'),
      [],
    );
  });
});
