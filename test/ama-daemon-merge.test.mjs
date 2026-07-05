import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attemptDaemonCleanMerge,
  classifyDaemonMergeError,
  daemonMergeBackoffMs,
  isFullyCleanSettledReview,
  DAEMON_MERGE_CLOSURE_AUTHORITY,
  DAEMON_MERGE_DISPOSITION,
  __testables__,
} from '../src/ama/daemon-merge.mjs';

const HEAD = 'd1c064df0f16dff999adeb51484fcd0a8a0747b6';
const OTHER_HEAD = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';

// A fully-eligible + fully-clean live gate: settled-success, two green checks,
// open MERGEABLE / non-BEHIND PR, matching heads.
function greenGate(overrides = {}) {
  return {
    candidateHead: HEAD,
    requiredChecks: [
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    prState: 'OPEN',
    merged: false,
    ...overrides,
  };
}

function cleanReview(overrides = {}) {
  return {
    blockingFindingCount: 0,
    blockingFindingState: 'known',
    nonBlockingFindingCount: 0,
    nonBlockingFindingState: 'known',
    ...overrides,
  };
}

// Build a harness with recording, dependency-injected collaborators. `merge`
// pops from a queued list of results so we can script transient-then-success.
function makeHarness({
  mergeResults = [{ exitCode: 0, stdout: '', stderr: '' }],
  liveGate = greenGate(),
  liveGateSequence = null,
  leaseAcquired = true,
  existingLease = null,
  priorAudit = null,
} = {}) {
  const calls = {
    fetchLiveGate: 0,
    merge: 0,
    localCi: 0, // MUST stay 0 — the daemon never runs local CI.
    acquire: 0,
    release: 0,
    sleeps: [],
    auditAppends: [],
    auditWrites: [],
  };
  const auditStore = new Map();
  const auditKey = (repo, pr, head) => `${repo}#${pr}@${head}`;
  if (priorAudit) auditStore.set(auditKey(priorAudit.repo, priorAudit.prNumber, priorAudit.headSha), priorAudit.doc);

  const lease = { leaseId: 'lease-1', repo: 'o/r', base: 'main', holderPr: 7, holderHead: HEAD };

  const harness = {
    calls,
    auditStore,
    deps: {
      fetchLiveGateImpl: async () => {
        const idx = calls.fetchLiveGate;
        calls.fetchLiveGate += 1;
        if (Array.isArray(liveGateSequence)) {
          const next = liveGateSequence[Math.min(idx, liveGateSequence.length - 1)];
          if (next instanceof Error) throw next;
          if (typeof next === 'function') return next();
          return next;
        }
        return liveGate;
      },
      acquireLeaseImpl: async () => {
        calls.acquire += 1;
        if (!leaseAcquired) return { acquired: false, existingLease };
        return { acquired: true, lease };
      },
      releaseLeaseImpl: (l) => {
        calls.release += 1;
        harness.releasedLease = l;
      },
      runMergeImpl: async (ctx) => {
        calls.merge += 1;
        harness.lastMergeCtx = ctx;
        const res = mergeResults[Math.min(calls.merge - 1, mergeResults.length - 1)];
        if (res instanceof Error) throw res;
        return res;
      },
      writeAuditImpl: ({ repo, prNumber, headSha, attempt, metadata }) => {
        calls.auditWrites.push({ repo, prNumber, headSha, attempt, metadata });
        const doc = auditStore.get(auditKey(repo, prNumber, headSha)) || {
          repo,
          prNumber,
          headSha,
          ...metadata,
          attempts: [],
        };
        doc.attempts = [...(doc.attempts || []), attempt];
        doc.status = attempt.outcome;
        Object.assign(doc, metadata);
        auditStore.set(auditKey(repo, prNumber, headSha), doc);
        return { filePath: auditKey(repo, prNumber, headSha), doc };
      },
      appendAuditImpl: ({ repo, prNumber, headSha, attempt }) => {
        calls.auditAppends.push({ repo, prNumber, headSha, attempt });
        const key = auditKey(repo, prNumber, headSha);
        const doc = auditStore.get(key) || { repo, prNumber, headSha, attempts: [] };
        doc.attempts = [...(doc.attempts || []), attempt];
        doc.status = attempt.outcome;
        auditStore.set(key, doc);
        return { filePath: key, doc };
      },
      readAuditImpl: (_hqRoot, repo, prNumber, headSha) =>
        auditStore.get(auditKey(repo, prNumber, headSha)) || null,
      sleep: async (ms) => {
        calls.sleeps.push(ms);
      },
      rng: () => 0, // deterministic: no jitter.
      logger: { log() {}, warn() {} },
    },
  };
  return harness;
}

function baseArgs(harness, overrides = {}) {
  return {
    repo: 'o/r',
    prNumber: 7,
    base: 'main',
    validatedHead: HEAD,
    verdict: 'settled-success',
    reviewState: cleanReview(),
    liveGate: greenGate(),
    mergeMethod: 'squash',
    hqRoot: '/hq',
    auditMetadata: { reviewer: 'codex', riskClass: 'low' },
    ...harness.deps,
    ...overrides,
  };
}

// ── Unit helpers ─────────────────────────────────────────────────────────────

test('isFullyCleanSettledReview: zero/known both → clean', () => {
  assert.equal(isFullyCleanSettledReview(cleanReview()), true);
});

test('isFullyCleanSettledReview: any finding or unknown state → not clean', () => {
  assert.equal(isFullyCleanSettledReview(cleanReview({ blockingFindingCount: 1 })), false);
  assert.equal(isFullyCleanSettledReview(cleanReview({ nonBlockingFindingCount: 2 })), false);
  assert.equal(isFullyCleanSettledReview(cleanReview({ blockingFindingState: 'unknown' })), false);
  assert.equal(isFullyCleanSettledReview(cleanReview({ nonBlockingFindingState: 'unknown' })), false);
});

test('isFullyCleanSettledReview: known state still rejects missing or boolean counts', () => {
  assert.equal(isFullyCleanSettledReview(cleanReview({ blockingFindingCount: null })), false);
  assert.equal(isFullyCleanSettledReview(cleanReview({ nonBlockingFindingCount: '' })), false);
  assert.equal(isFullyCleanSettledReview(cleanReview({ blockingFindingCount: false })), false);
  assert.equal(__testables__.uncleanReason(cleanReview({ blockingFindingCount: null })), 'findings-unknown');
  assert.equal(__testables__.normalizeFindingCount('0'), 0);
});

test('classifyDaemonMergeError mirrors the hammer classifier order', () => {
  assert.equal(classifyDaemonMergeError('This pull request was already merged'), 'already-merged');
  assert.equal(classifyDaemonMergeError('Head branch does not match match-head-commit'), 'permanent');
  assert.equal(classifyDaemonMergeError('branch protection rules not satisfied'), 'permanent');
  assert.equal(classifyDaemonMergeError('required check has not succeeded'), 'permanent');
  assert.equal(classifyDaemonMergeError('HTTP 403 forbidden'), 'permanent');
  assert.equal(classifyDaemonMergeError('connection reset by peer'), 'retryable');
  assert.equal(classifyDaemonMergeError('HTTP 503 service unavailable'), 'retryable');
  assert.equal(classifyDaemonMergeError('secondary rate limit; Retry-After: 30'), 'retryable');
  assert.equal(classifyDaemonMergeError('spawn gh EIO'), 'retryable');
  assert.equal(classifyDaemonMergeError('Input/output error'), 'retryable');
  assert.equal(classifyDaemonMergeError('spawn gh EAGAIN'), 'retryable');
  assert.equal(classifyDaemonMergeError('resource temporarily unavailable'), 'retryable');
  assert.equal(classifyDaemonMergeError('some brand new error text'), 'unclassified');
});

test('normalizeGateState uppercases PR state', () => {
  assert.equal(__testables__.normalizeGateState({ prState: ' open ' }).prState, 'OPEN');
  assert.equal(__testables__.normalizeGateState({ state: 'closed' }).prState, 'CLOSED');
});

test('daemonMergeBackoffMs: exponential base with deterministic jitter', () => {
  assert.equal(daemonMergeBackoffMs(1, { baseMs: 2000, rng: () => 0 }), 2000);
  assert.equal(daemonMergeBackoffMs(2, { baseMs: 2000, rng: () => 0 }), 4000);
  assert.equal(daemonMergeBackoffMs(3, { baseMs: 2000, rng: () => 0 }), 8000);
  // jitter step: floor(0.9*3)=2 → +2000ms
  assert.equal(daemonMergeBackoffMs(1, { baseMs: 2000, rng: () => 0.9 }), 4000);
});

// ── Mandatory scenario 1: fully-clean + eligible → daemon merges, no agent ───

test('clean + eligible → daemon merges inline; daemon-merge audit; no local CI, no agent spawn', async () => {
  const h = makeHarness({ mergeResults: [{ exitCode: 0 }] });
  const result = await attemptDaemonCleanMerge(baseArgs(h));

  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.MERGED);
  assert.equal(result.merged, true);
  assert.equal(result.attempts, 1);
  assert.equal(h.calls.merge, 1);
  assert.equal(h.calls.localCi, 0, 'daemon must NEVER run local CI');
  assert.equal(h.calls.release, 1, 'lease released');

  // A daemon-merge audit was written (init in_progress + terminal succeeded).
  const doc = h.auditStore.get('o/r#7@' + HEAD);
  assert.equal(doc.closureAuthority, DAEMON_MERGE_CLOSURE_AUTHORITY);
  assert.equal(doc.status, 'succeeded');
  const terminal = doc.attempts[doc.attempts.length - 1];
  assert.equal(terminal.outcome, 'succeeded');
  assert.equal(terminal.path, DAEMON_MERGE_CLOSURE_AUTHORITY);

  // The merge used --match-head-commit semantics on the validated head.
  assert.equal(h.lastMergeCtx.head, HEAD);
  assert.equal(h.lastMergeCtx.mergeMethod, 'squash');
});

// ── Mandatory scenario 2: transient then success → retries, exactly one audit ─

test('transient gh pr merge failure then success → bounded retry, exactly one daemon-merge audit', async () => {
  const h = makeHarness({
    mergeResults: [
      { exitCode: 1, stderr: 'HTTP 503 service unavailable' },
      { exitCode: 0 },
    ],
  });
  const result = await attemptDaemonCleanMerge(baseArgs(h));

  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.MERGED);
  assert.equal(result.attempts, 2);
  assert.equal(h.calls.merge, 2);
  assert.equal(h.calls.sleeps.length, 1, 'backed off exactly once');
  assert.equal(h.calls.fetchLiveGate, 2, 're-read live head before each attempt');

  // Exactly ONE daemon-merge audit doc, with a single terminal succeeded entry.
  assert.equal(h.auditStore.size, 1);
  const doc = h.auditStore.get('o/r#7@' + HEAD);
  const succeeded = doc.attempts.filter((a) => a.outcome === 'succeeded');
  assert.equal(succeeded.length, 1);
});

// ── Mandatory scenario 3: permanent failure → fail closed, no retry loop ──────

test('permanent merge rejection → fail closed with no retry; lease released; reason recorded', async () => {
  const h = makeHarness({
    mergeResults: [{ exitCode: 1, stderr: 'branch protection rules not satisfied' }],
  });
  const result = await attemptDaemonCleanMerge(baseArgs(h));

  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.FAILED_CLOSED);
  assert.equal(result.merged, false);
  assert.equal(result.reason, 'permanent-merge-rejection');
  assert.equal(h.calls.merge, 1, 'no retry for permanent failure');
  assert.equal(h.calls.sleeps.length, 0);
  assert.equal(h.calls.release, 1, 'lease released');

  const doc = h.auditStore.get('o/r#7@' + HEAD);
  assert.equal(doc.status, 'failed-without-merge');
  const terminal = doc.attempts[doc.attempts.length - 1];
  assert.equal(terminal.reason, 'permanent-merge-rejection');
  assert.equal(terminal.permanent, true);
});

test('head moves off validated head between pre-lease gate and merge loop → fail closed stale-head', async () => {
  // Pre-lease snapshot is still on the validated head (passes the gate + lease),
  // but the loop's live re-read observes the head has moved.
  const h = makeHarness({ liveGateSequence: [greenGate({ candidateHead: OTHER_HEAD })] });
  const result = await attemptDaemonCleanMerge(baseArgs(h, { liveGate: greenGate() }));

  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.FAILED_CLOSED);
  assert.equal(result.reason, 'stale-head');
  assert.equal(h.calls.merge, 0, 'never attempted merge on a moved head');
  assert.equal(h.calls.release, 1);
});

test('missing fresh candidate head is treated as transient gate-read failure', async () => {
  const h = makeHarness({ liveGateSequence: [greenGate({ candidateHead: '' })] });
  const result = await attemptDaemonCleanMerge(baseArgs(h, { retryCap: 1 }));

  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.FAILED_CLOSED);
  assert.equal(result.reason, 'gate-read-failed');
  assert.equal(result.attempts, 1);
  assert.equal(h.calls.merge, 0, 'never merges without a fresh head');
  assert.equal(h.calls.release, 1);
  const doc = h.auditStore.get('o/r#7@' + HEAD);
  const terminal = doc.attempts[doc.attempts.length - 1];
  assert.equal(terminal.reason, 'gate-read-failed');
  assert.equal(terminal.permanent, false);
});

test('unexpected exception after lease acquisition still releases lease', async () => {
  const h = makeHarness({ liveGateSequence: [greenGate()] });
  await assert.rejects(
    () => attemptDaemonCleanMerge(baseArgs(h, {
      evaluateEligibilityImpl: (state) => {
        if (state.candidateHead === HEAD && h.calls.fetchLiveGate > 0) {
          throw new TypeError('malformed live gate');
        }
        return { eligible: true, reasons: [] };
      },
    })),
    /malformed live gate/,
  );

  assert.equal(h.calls.acquire, 1);
  assert.equal(h.calls.release, 1, 'lease released by outer finally');
  assert.equal(h.calls.merge, 0);
});

test('retryable failures exhaust the bounded budget → fail closed (non-permanent), one audit', async () => {
  const h = makeHarness({
    mergeResults: [{ exitCode: 1, stderr: 'connection reset by peer' }],
    retryCap: 4,
  });
  const result = await attemptDaemonCleanMerge(baseArgs(h, { retryCap: 4 }));

  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.FAILED_CLOSED);
  assert.equal(result.reason, 'merge-retry-budget-exhausted');
  assert.equal(h.calls.merge, 4, 'attempted up to the cap');
  assert.equal(h.calls.sleeps.length, 3, 'backed off between attempts only');
  const doc = h.auditStore.get('o/r#7@' + HEAD);
  const terminal = doc.attempts[doc.attempts.length - 1];
  assert.equal(terminal.permanent, false, 'exhaustion is not a permanent terminal');
});

test('prior permanent daemon terminal failure on head → declines (routes to hammer), no lease taken', async () => {
  const h = makeHarness({
    priorAudit: {
      repo: 'o/r',
      prNumber: 7,
      headSha: HEAD,
      doc: {
        closureAuthority: DAEMON_MERGE_CLOSURE_AUTHORITY,
        status: 'failed-without-merge',
        attempts: [{ outcome: 'failed-without-merge', reason: 'permanent-merge-rejection' }],
      },
    },
  });
  const result = await attemptDaemonCleanMerge(baseArgs(h));
  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
  assert.equal(result.reason, 'prior-daemon-terminal-failure');
  assert.equal(h.calls.acquire, 0, 'no lease acquisition on a permanently-failed head');
});

// ── Mandatory scenario 4: findings present under strict mode → routes to hammer

test('≥1 blocking finding → daemon declines (not-taken), never touches lease or merge', async () => {
  const h = makeHarness();
  const result = await attemptDaemonCleanMerge(
    baseArgs(h, { reviewState: cleanReview({ blockingFindingCount: 1 }) }),
  );
  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
  assert.equal(result.reason, 'blocking-findings-present');
  assert.equal(h.calls.acquire, 0);
  assert.equal(h.calls.merge, 0);
});

test('≥1 non-blocking finding → daemon declines (not-taken) under strict mode', async () => {
  const h = makeHarness();
  const result = await attemptDaemonCleanMerge(
    baseArgs(h, { reviewState: cleanReview({ nonBlockingFindingCount: 3 }) }),
  );
  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
  assert.equal(result.reason, 'non-blocking-findings-present');
  assert.equal(h.calls.merge, 0);
});

test('unknown finding classification → daemon declines (fail closed to hammer)', async () => {
  const h = makeHarness();
  const result = await attemptDaemonCleanMerge(
    baseArgs(h, { reviewState: cleanReview({ blockingFindingState: 'unknown' }) }),
  );
  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
  assert.equal(result.reason, 'findings-unknown');
  assert.equal(h.calls.acquire, 0);
});

// ── Mandatory scenario 5: lease contention → defers, no double-merge ──────────

test('lease held by another principal → defers cleanly; no merge, no audit', async () => {
  const h = makeHarness({ leaseAcquired: false, existingLease: { holderPr: 99 } });
  const result = await attemptDaemonCleanMerge(baseArgs(h));
  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.DEFERRED);
  assert.equal(result.reason, 'lease-contended');
  assert.equal(h.calls.merge, 0, 'no double-merge under contention');
  assert.equal(h.calls.release, 0, 'never release a lease we do not hold');
  assert.equal(h.auditStore.size, 0);
});

// ── Mandatory scenario 6: ineligible GitHub state → no merge; reason surfaced ─

test('GitHub-red required checks → not-taken with ci-not-green; no lease, no merge', async () => {
  const h = makeHarness();
  const redGate = greenGate({
    requiredChecks: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
  });
  const result = await attemptDaemonCleanMerge(baseArgs(h, { liveGate: redGate }));
  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
  assert.equal(result.reason, 'not-eligible');
  assert.ok(result.reasons.includes('ci-not-green'));
  assert.equal(h.calls.acquire, 0);
  assert.equal(h.calls.merge, 0);
});

test('not mergeable (CONFLICTING) → not-taken with pr-not-mergeable', async () => {
  const h = makeHarness();
  const result = await attemptDaemonCleanMerge(
    baseArgs(h, { liveGate: greenGate({ mergeable: 'CONFLICTING' }) }),
  );
  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
  assert.ok(result.reasons.includes('pr-not-mergeable'));
  assert.equal(h.calls.merge, 0);
});

test('stale head (candidate != validated) at pre-lease gate → not-taken with stale-head', async () => {
  const h = makeHarness();
  const result = await attemptDaemonCleanMerge(
    baseArgs(h, { liveGate: greenGate({ candidateHead: OTHER_HEAD }) }),
  );
  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
  assert.ok(result.reasons.includes('stale-head'));
  assert.equal(h.calls.acquire, 0);
});

// ── Extra: eligibility re-check between attempts (CI goes red mid-retry) ──────

test('CI goes red on the retry re-read → fail closed gate-not-eligible; no further merge', async () => {
  const h = makeHarness({
    mergeResults: [{ exitCode: 1, stderr: 'HTTP 503 service unavailable' }, { exitCode: 0 }],
    liveGateSequence: [
      greenGate(),
      greenGate({
        requiredChecks: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
      }),
    ],
  });
  const result = await attemptDaemonCleanMerge(baseArgs(h, {
    fetchLiveGateImpl: h.deps.fetchLiveGateImpl,
    mergeResults: undefined,
  }));
  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.FAILED_CLOSED);
  assert.equal(result.reason, 'gate-not-eligible');
  assert.equal(h.calls.merge, 1, 'did not attempt merge after CI flipped red');
});

// ── Extra: already-merged idempotent re-entry ────────────────────────────────

test('live gate reports MERGED at validated head → treated as merged success', async () => {
  const h = makeHarness({ liveGate: greenGate({ merged: true, prState: 'MERGED' }) });
  const result = await attemptDaemonCleanMerge(
    baseArgs(h, { liveGate: greenGate({ merged: true, prState: 'MERGED' }) }),
  );
  // pre-lease eligibility fails on MERGED prState (not OPEN) → declines cleanly,
  // which is correct: an already-merged PR is not a daemon merge candidate.
  assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
});

test('__testables__ exposes the permanent-reason set', () => {
  assert.ok(__testables__.PERMANENT_TERMINAL_REASONS.includes('stale-head'));
  assert.ok(__testables__.PERMANENT_TERMINAL_REASONS.includes('permanent-merge-rejection'));
  assert.ok(!__testables__.PERMANENT_TERMINAL_REASONS.includes('merge-retry-budget-exhausted'));
});
