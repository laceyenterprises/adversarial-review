import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { acquireMergeLease, inspectMergeLease, mergeLeaseFilePath, releaseMergeLease,
  withMergeLeaseReviewClaim } from '../src/ama/merge-lease.mjs';
import { isDaemonMergeReviewAllowed } from '../src/ama/daemon-merge.mjs';
import { claimWithExhaustedHeadMergeCustody, exhaustedHeadMergeCustodyDeferral,
  exhaustedHeadVerdictReason } from '../src/exhausted-head-verdict.mjs';
import { repositoryRenamePendingPath } from '../src/repository-state-lock.mjs';
import { disputedFindingsReviewRequest, pendingExplicitReviewIntent,
  priorityReviewIntent, recordExplicitReviewIntent } from '../src/explicit-review-intent.mjs';
import { DISPUTE_REVIEW_REASON } from '../src/remediation-dispute-handoff.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { prepareMarkAttemptStarted } from '../src/review-state-statements.mjs';

const repo = 'offline/custody-keeper';
const base = 'main';
const headSha = 'b'.repeat(40);
const otherHead = 'c'.repeat(40);
const at = '2026-11-21T08:00:00.000Z';
const expiredAt = '2026-11-21T07:00:00.000Z';
const repeats = 12;
const repairReason = `system-repair-epoch:repair-22a92295-e0ce-44c9-a369-ba6b1829384c:${headSha}`;

function repeat(run) {
  const rootDir = mkdtempSync(join(tmpdir(), 'lac2293-custody-'));
  const path = join(rootDir, 'fixture.db');
  const db = new Database(path);
  const reader = new Database(path, { readonly: true });
  try {
    ensureReviewStateSchema(db);
    const insert = db.prepare(`INSERT INTO reviewed_prs
      (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, revision_ref,
       rereview_requested_at, rereview_reason, failed_at, review_attempts)
      VALUES (?, ?, ?, 'claude', 'open', 'pending', ?, ?, ?, ?, 2)`);
    const markAttempt = prepareMarkAttemptStarted(db);
    const read = reader.prepare('SELECT * FROM reviewed_prs WHERE repo=? AND pr_number=?');
    const readForWrite = db.prepare('SELECT * FROM reviewed_prs WHERE repo=? AND pr_number=?');
    for (let prNumber = 1; prNumber <= repeats; prNumber += 1) {
      const identity = { rootDir, repo, base, prNumber, headSha };
      const opts = { rootDir, repo, base, holderPr: prNumber, holderHead: headSha,
        holderPid: process.pid, now: at, deadlineSeconds: 10 };
      const captureProcessImpl = () => ({ startedAt: expiredAt });
      const grant = (overrides = {}) => acquireMergeLease({ ...opts, captureProcessImpl, ...overrides });
      const release = lease => assert.equal(releaseMergeLease({
        rootDir, ...lease, now: at, terminal: true, reason: 'fixture-release',
      }).released, true);
      const row = () => read.get(repo, prNumber);
      const claim = ({ beforeCAS, ...observations } = {}) => claimWithExhaustedHeadMergeCustody({
        ...identity, db, now: at, pidAliveFn: () => true, captureProcessImpl,
        readRow: () => readForWrite.get(repo, prNumber),
        hasPriorityIntent: () => priorityReviewIntent(pendingExplicitReviewIntent(db, identity)),
        readDeliveredHead: () => otherHead,
        ...observations,
      }, () => {
        beforeCAS?.();
        return markAttempt.run(at, 'fixture-reviewer', headSha, headSha, 60_000, at, headSha, repo, prNumber);
      });
      run({ identity, grant, release, row, claim,
        seed: ({ reason = exhaustedHeadVerdictReason(headSha), failedAt = null } = {}) =>
          insert.run(repo, prNumber, at, headSha, reason ? at : null, reason, failedAt),
        human: () => recordExplicitReviewIntent(db, { ...identity, requestId: 'label-fixture',
          actor: 'fixture-operator', requestedAt: at }),
        dispute: () => recordExplicitReviewIntent(db, { ...identity, ...disputedFindingsReviewRequest(headSha), requestedAt: at }),
      });
    }
  } finally {
    reader.close();
    db.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

const refreshReason = `auto-refresh: posted review on stale head ${otherHead.slice(0, 12)}; current head is ${headSha.slice(0, 12)}`;

test('LAC-2293: a full automatic refresh waits when an exact-head native closer grants first', () => {
  const trials = [];
  repeat(({ claim, grant, release, row, seed }) => {
    seed({ reason: refreshReason });
    const lease = assertGranted(grant());
    const whileHeld = claim();
    const { review_status: status, review_attempts: attempts } = row();
    release(lease);
    trials.push({ reason: whileHeld.reason, status, attempts, afterRelease: claim().claim?.changes });
  });
  assert.equal(trials.filter(trial => trial.status === 'reviewing').length, 0, 'late claims in 12 lease-first trials');
  assert.deepEqual(trials, Array.from({ length: repeats }, () => ({
    reason: 'native-merge-custody', status: 'pending', attempts: 2, afterRelease: 1,
  })));
});

test('LAC-2293: refresh marker without a delivered review leaves first review admission intact', () => {
  repeat(({ claim, grant, release, row, seed }) => {
    seed({ reason: refreshReason });
    const lease = assertGranted(grant());
    assert.equal(claim({ readDeliveredHead: () => null }).claim.changes, 1);
    assert.equal(row().review_status, 'reviewing');
    release(lease);
  });
});

test('LAC-2293: operator intent takes priority over a queued automatic refresh', () => {
  repeat(({ claim, grant, release, row, seed, human }) => {
    seed({ reason: refreshReason });
    const lease = assertGranted(grant());
    human();
    assert.equal(claim({ closureDeferral: () => assert.fail('operator review owns admission') }).claim.changes, 1);
    assert.equal(row().review_status, 'reviewing');
    assert.equal(row().reviewer_head_sha, headSha);
    release(lease);
  });
});

for (const camelCase of [false, true]) test(`LAC-2315: a dispute review receipt does not bypass native merge custody (camelCase: ${camelCase})`, () => {
  repeat(({ claim, dispute, grant, release, row, seed }) => {
    seed({ reason: DISPUTE_REVIEW_REASON });
    dispute();
    const lease = assertGranted(grant());
    const observations = camelCase
      ? { hasPriorityIntent: () => ({ ...disputedFindingsReviewRequest(headSha), headSha }) }
      : {};
    assert.equal(claim(observations).reason, 'native-merge-custody');
    assert.equal(row().review_status, 'pending');
    assert.equal(row().review_attempts, 2);
    release(lease);
    assert.equal(claim({ ...observations, closureDeferral: () => assert.fail('dispute review retains admission') }).claim.changes, 1);
  });
});

test('LAC-2293: scheduling precheck defers only automatic system verdicts', () => {
  repeat(({ identity, grant, release, row, seed, human }) => {
    seed();
    const lease = assertGranted(grant());
    const precheck = hasPriorityIntent => exhaustedHeadMergeCustodyDeferral({
      ...identity, row: row(), hasPriorityIntent, now: at,
      pidAliveFn: () => true, captureProcessImpl: () => ({ startedAt: expiredAt }),
    });
    assert.equal(precheck(() => false), 'native-merge-custody');
    human();
    assert.equal(precheck(() => true), null);
    release(lease);
    assert.equal(precheck(() => false), null);
    assert.equal(exhaustedHeadMergeCustodyDeferral({
      row: { ...row(), failed_at: at }, headSha,
      hasPriorityIntent: () => assert.fail('failed retries bypass the precheck'),
    }), null);
    assert.equal(exhaustedHeadMergeCustodyDeferral({
      row: { ...row(), rereview_reason: 'human' }, headSha,
      hasPriorityIntent: () => assert.fail('ordinary reviews bypass the precheck'),
    }), null);
  });
});

test('LAC-2293: liveness probe permits native release outside the mutation lock', () => {
  repeat(({ identity, grant, release, row, seed, claim }) => {
    seed();
    const lease = assertGranted(grant());
    let probed = false;
    const result = claim({ captureProcessImpl: () => {
      assert.equal(existsSync(`${mergeLeaseFilePath(identity.rootDir, identity)}.mutation.lock`), false);
      release(lease);
      probed = true;
      return { startedAt: expiredAt };
    } });
    assert.equal(probed, true);
    assert.equal(result.claim.changes, 1);
    assert.equal(row().review_status, 'reviewing');
  });
});

test('LAC-2293: a replacement holder cannot borrow a pre-lock death proof', () => {
  repeat(({ grant, release, row, seed, claim }) => {
    seed();
    const lease = assertGranted(grant());
    let replacement;
    const result = claim({ captureProcessImpl: () => {
      release(lease);
      replacement = assertGranted(grant());
      // Prove the original PID was reused, after a new holder was published.
      return { startedAt: at };
    } });
    assertNoClaim(result, row(), 'native-merge-custody');
    release(replacement);
    assert.equal(claim().claim.changes, 1);
  });
});

for (const mode of ['corrupt lease', 'unreadable lease', 'rename recovery', 'corrupt locked read']) {
  test(`LAC-2293: ${mode} defers with no claim or attempt charge`, () => {
    repeat(({ identity, grant, row, seed, claim }) => {
      seed();
      const path = mergeLeaseFilePath(identity.rootDir, identity);
      let observations = {};
      if (mode === 'rename recovery') {
        const pending = repositoryRenamePendingPath(identity.rootDir);
        mkdirSync(join(identity.rootDir, 'data', 'repository-renames'), { recursive: true });
        writeFileSync(pending, '{}');
      } else {
        assertGranted(grant());
        if (mode === 'corrupt locked read') {
          observations = { captureProcessImpl: () => {
            writeFileSync(path, '{');
            return { startedAt: expiredAt };
          } };
        } else if (mode === 'unreadable lease') {
          rmSync(path);
          mkdirSync(path);
        } else writeFileSync(path, '{');
      }
      const before = row();
      assertNoClaim(claim(observations), row(), 'merge-lease-state-unavailable');
      assert.deepEqual(row(), before);
      rmSync(path, { recursive: true, force: true });
      rmSync(repositoryRenamePendingPath(identity.rootDir), { force: true });
    });
  });
}

test('LAC-2293: claim exceptions propagate and release the mutation lock', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'lac2293-claim-error-'));
  const identity = { rootDir, repo, base, prNumber: 1, headSha };
  try {
    const error = new Error('fixture SQLite failure');
    assert.throws(() => withMergeLeaseReviewClaim(identity, () => { throw error; }), e => e === error);
    assert.equal(existsSync(`${mergeLeaseFilePath(rootDir, identity)}.mutation.lock`), false);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

function assertGranted(result) {
  assert.equal(result.acquired, true);
  return result.lease;
}

function assertNoClaim(claim, row, reason) {
  assert.deepEqual(claim, { reason });
  assert.equal(row.review_status, 'pending');
  assert.equal(row.reviewer_session_uuid, null);
  assert.equal(row.review_attempts, 2);
}

for (const reason of [exhaustedHeadVerdictReason(headSha), repairReason, refreshReason]) {
  test(`LAC-2293: a native lease granted after a precheck wins ${repeats}/${repeats} claims (${reason})`, () => {
    let lateClaims = 0;
    repeat(({ identity, grant, release, row, claim, seed }) => {
      seed({ reason });
      assert.equal(exhaustedHeadMergeCustodyDeferral({
        ...identity, row: row(), hasPriorityIntent: () => false, readDeliveredHead: () => otherHead,
      }) ?? null, null);
      const lease = assertGranted(grant({
        // Capture happens under the per-base lock, before holder publication.
        captureProcessImpl: () => {
          assert.equal(inspectMergeLease(identity).holder, null);
          const result = claim();
          if (result.claim?.changes) lateClaims += 1;
          else assertNoClaim(result, row(), 'merge-lease-mutation-busy');
          return { startedAt: expiredAt };
        },
      }));
      if (row().review_status === 'pending') {
        assertNoClaim(claim(), row(), 'native-merge-custody');
        assert.equal(row().rereview_reason, reason);
      }
      release(lease);
      if (row().review_status === 'pending') assert.equal(claim().claim.changes, 1);
    });
    assert.equal(lateClaims, 0, `${lateClaims}/${repeats} claims while the grant was publishing`);
  });

  test(`LAC-2293: reviewer-first commits before native owner check ${repeats}/${repeats} times (${reason})`, () => {
    let grantsBeforeCommit = 0;
    repeat(({ grant, release, row, claim, seed }) => {
      seed({ reason });
      let competingLease;
      assert.equal(claim({ beforeCAS: () => {
        assert.equal(row().review_status, 'pending');
        try {
          competingLease = assertGranted(grant());
          grantsBeforeCommit += 1;
        } catch (error) {
          assert.match(error.message, /mutation lock busy/);
        }
      } }).claim.changes, 1);
      if (competingLease) release(competingLease);
      const lease = assertGranted(grant({
        _afterHolderWrite: () => {
          const current = row(); // independent connection, after holder publication
          assert.equal(current.review_status, 'reviewing');
          assert.equal(current.reviewer_session_uuid, 'fixture-reviewer');
          assert.equal(current.reviewer_head_sha, headSha);
        },
      }));
      release(lease);
    });
    assert.equal(grantsBeforeCommit, 0, `${grantsBeforeCommit}/${repeats} grants before reviewer commit`);
  });
}

for (const [label, holderArgs, observations, priority, expected] of [
  ['matching live holder', {}, {}, false, 'native-merge-custody'],
  ['unknown local holder', { now: expiredAt }, { captureProcessImpl: () => null }, false, 'native-merge-custody'],
  ['another PR', { holderPr: 1987 }, {}, false, null],
  ['another head', { holderHead: otherHead }, {}, false, null],
  ['new operator request', {}, {}, true, null],
]) {
  test(`LAC-2293 recurrence: repair epoch and ${label}`, () => {
    const outcomes = [];
    repeat(({ identity, grant, release, row, claim, seed, human }) => {
      seed({ reason: repairReason });
      if (priority) human();
      const lease = assertGranted(grant(holderArgs));
      const before = row();
      const precheck = exhaustedHeadMergeCustodyDeferral({
        ...identity, row: before, hasPriorityIntent: () => priority, now: at,
        pidAliveFn: () => true, captureProcessImpl: () => ({ startedAt: expiredAt }), ...observations,
      });
      const result = claim(observations);
      outcomes.push([precheck ?? null, result.reason ?? null, result.claim?.changes ?? 0]);
      if (result.reason) assert.deepEqual(row(), before);
      release(lease);
      if (result.reason) assert.equal(claim().claim.changes, 1);
    });
    const wanted = [expected, expected, expected ? 0 : 1];
    assert.deepEqual(outcomes, Array.from({ length: repeats }, () => wanted),
      `${outcomes.filter(([, , changes]) => changes === 1).length}/${repeats} claims before release`);
  });
}

for (const [name, leaseArgs, claimArgs, mode] of [
  ['current owner', {}, {}, 'defer'],
  ['different PR', { holderPr: 1987 }, {}, 'claim'],
  ['wrong head', { holderHead: otherHead }, {}, 'claim'],
  ['expired remote', { holderHost: 'remote-fixture', now: expiredAt }, {}, 'claim'],
  ['dead local', {}, { pidAliveFn: () => false }, 'claim'],
  ['unknown local', { now: expiredAt }, { captureProcessImpl: () => null }, 'defer'],
  ['live local past deadline', { now: expiredAt }, {}, 'defer'],
  ['pending human priority', {}, {}, 'human'],
  ['initial review', {}, {}, 'initial'],
  ['missing review row', {}, {}, 'missing'],
  ['released failure retry', {}, {}, 'retry'],
  ['exhausted-but-unfixed findings', {}, {}, 'findings'],
]) {
  test(`LAC-2293: ${name} ${repeats}/${repeats}`, () => {
    repeat(({ grant, release, row, claim, seed, human }) => {
      if (mode !== 'missing') seed({
        ...(mode === 'initial' ? { reason: null } : {}),
        ...(mode === 'retry' ? { failedAt: at } : {}),
      });
      if (mode === 'human') human();
      const lease = assertGranted(grant({ holderHost: hostname(), ...leaseArgs }));
      const result = claim(claimArgs);
      if (mode === 'defer' || mode === 'findings') {
        assertNoClaim(result, row(), 'native-merge-custody');
      } else {
        assert.equal(result.claim.changes, mode === 'missing' ? 0 : 1);
      }
      if (mode === 'findings') {
        assert.equal(isDaemonMergeReviewAllowed({
          reviewCycleExhausted: true,
          blockingFindingState: 'known', blockingFindingCount: 0,
          nonBlockingFindingState: 'known', nonBlockingFindingCount: 1,
        }), false);
      }
      release(lease);
      if (mode === 'findings') assert.equal(claim().claim.changes, 1);
    });
  });
}
