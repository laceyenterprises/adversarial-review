import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { recordCascadeFailure, readCascadeState } from '../src/reviewer-cascade.mjs';

const REPO = 'laceyenterprises/agent-os';

test('a provider quota reset cannot hold a PR past its own backoff', () => {
  // Regression for 2026-08-23. `recordCascadeFailure` took the caller-supplied
  // `nextRetryAfter` verbatim, and reviewer-spawn-settle passes the PROVIDER's
  // quota reset there. Cascade state is reviewer-AGNOSTIC -- it holds the PR
  // against every eligible reviewer -- so a codex weekly cap wrote
  // nextRetryAfter=2026-08-27T04:38Z onto agent-os#5715 and
  // adversarial-review#892 while backoffMinutes was 2. Both PRs were stranded
  // for FOUR DAYS against gemini, which was uncapped and idle. The review lane
  // went silent and the merge backlog froze.
  //
  // Provider outages have their own correct gate (the provider suspension in
  // `hq fleet quota status`), which blocks only the capped classes.
  const root = mkdtempSync(path.join(tmpdir(), 'cascade-bound-'));
  try {
    const failedAt = '2026-08-23T01:15:25.567Z';
    const providerReset = '2026-08-27T04:38:00.000Z'; // four days out
    recordCascadeFailure(root, {
      repo: REPO,
      prNumber: 5715,
      failedAt,
      failureClass: 'quota-exhausted',
      nextRetryAfter: providerReset,
    });

    const state = readCascadeState(root, { repo: REPO, prNumber: 5715 });
    const retryMs = Date.parse(state.nextRetryAfter);
    const failedMs = Date.parse(failedAt);
    const boundMs = failedMs + state.backoffMinutes * 60_000;

    assert.ok(
      retryMs <= boundMs,
      `hold ${state.nextRetryAfter} must not exceed the computed backoff bound ` +
        `(${state.backoffMinutes}m -> ${new Date(boundMs).toISOString()})`
    );
    assert.notEqual(state.nextRetryAfter, providerReset);
    // The provider's own estimate is still recorded, for diagnosis only.
    assert.equal(state.providerRetryAfter, providerReset);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a provider reset SHORTER than the backoff cannot bypass the backoff floor', () => {
  // The clamp is symmetric: the PR-level hold is the computed backoff in BOTH
  // directions. A provider that reports a near-immediate reset (or a stale one
  // already in the past) must not drop the hold below the exponential
  // schedule -- otherwise `consecutiveTransientFailures` climbs while the PR
  // tight-loops against the whole reviewer network, which is precisely what
  // the backoff exists to prevent. Provider-specific recovery is the provider
  // gate's job (`hq fleet quota status`), not this reviewer-agnostic state's.
  const root = mkdtempSync(path.join(tmpdir(), 'cascade-bound-'));
  try {
    const failedAt = '2026-08-23T01:15:25.567Z';
    const soon = '2026-08-23T01:15:55.567Z'; // 30s out, inside any backoff
    recordCascadeFailure(root, {
      repo: REPO,
      prNumber: 4242,
      failedAt,
      failureClass: 'quota-exhausted',
      nextRetryAfter: soon,
    });
    const state = readCascadeState(root, { repo: REPO, prNumber: 4242 });
    const failedMs = Date.parse(failedAt);
    assert.equal(
      state.nextRetryAfter,
      new Date(failedMs + state.backoffMinutes * 60_000).toISOString()
    );
    assert.ok(Date.parse(state.nextRetryAfter) > Date.parse(soon));
    // The provider's own estimate is still recorded, for diagnosis only.
    assert.equal(state.providerRetryAfter, soon);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unparseable failedAt still records a hold instead of throwing', () => {
  // recordCascadeFailure runs inside the watcher's failure-settle path; a
  // malformed timestamp must not crash the code that is recording a failure.
  const root = mkdtempSync(path.join(tmpdir(), 'cascade-bound-'));
  try {
    recordCascadeFailure(root, {
      repo: REPO,
      prNumber: 909,
      failedAt: 'not-a-date',
      failureClass: 'cascade',
      nextRetryAfter: '2026-08-27T04:38:00.000Z',
    });
    const state = readCascadeState(root, { repo: REPO, prNumber: 909 });
    assert.ok(Number.isFinite(Date.parse(state.nextRetryAfter)));
    assert.equal(state.backoffMinutes, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed failedAt is normalized before it reaches durable state', () => {
  // `lastFailureAt` is republished verbatim by `review-pipeline-health` as the
  // `since` field of a transient-backoff entry, so writing the caller's raw
  // value would leak a non-ISO string (or, for null, drop the key) into a
  // surface whose consumers parse it as a timestamp. Normalize on the same
  // `Date.now()` anchor `nextRetryAfter` already uses, so the two agree.
  const root = mkdtempSync(path.join(tmpdir(), 'cascade-bound-'));
  try {
    for (const [prNumber, failedAt] of [[911, 'not-a-date'], [912, null]]) {
      recordCascadeFailure(root, {
        repo: REPO,
        prNumber,
        failedAt,
        failureClass: 'cascade',
      });
      const state = readCascadeState(root, { repo: REPO, prNumber });
      assert.equal(typeof state.lastFailureAt, 'string');
      const sinceMs = Date.parse(state.lastFailureAt);
      assert.ok(
        Number.isFinite(sinceMs),
        `lastFailureAt ${JSON.stringify(state.lastFailureAt)} must parse as a timestamp`
      );
      // Round-trips as canonical ISO-8601, not merely as something Date.parse
      // happens to accept.
      assert.equal(new Date(sinceMs).toISOString(), state.lastFailureAt);
      // Same anchor as the hold computed beside it: the two must not disagree.
      assert.equal(
        Date.parse(state.nextRetryAfter) - sinceMs,
        state.backoffMinutes * 60_000
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a parseable failedAt is still stored byte-for-byte as the caller gave it', () => {
  // The normalization above must not rewrite good input -- cascade state is a
  // durable artifact and callers already pass canonical ISO strings.
  const root = mkdtempSync(path.join(tmpdir(), 'cascade-bound-'));
  try {
    const failedAt = '2026-08-23T01:15:25.567Z';
    recordCascadeFailure(root, {
      repo: REPO,
      prNumber: 913,
      failedAt,
      failureClass: 'cascade',
    });
    assert.equal(
      readCascadeState(root, { repo: REPO, prNumber: 913 }).lastFailureAt,
      failedAt
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a later failure without a provider hint does not inherit the old providerRetryAfter', () => {
  // Guards the diagnostic field against the leak an adversarial review raised
  // on 2026-08-23: if a quota-exhausted failure records a providerRetryAfter
  // and the NEXT failure is a generic class with no provider hint, the newer
  // state must not still carry the stale provider window -- an operator
  // reading it would attribute a codex quota reset to a launchctl-bootstrap
  // failure. `recordCascadeFailure` builds a fresh object and
  // `writeCascadeState` replaces the whole file (tmp+fsync+rename), so no
  // field survives implicitly; this test keeps it that way if either ever
  // grows a merge against the previous state.
  const root = mkdtempSync(path.join(tmpdir(), 'cascade-bound-'));
  try {
    recordCascadeFailure(root, {
      repo: REPO,
      prNumber: 896,
      failedAt: '2026-08-23T01:15:25.567Z',
      failureClass: 'quota-exhausted',
      nextRetryAfter: '2026-08-27T04:38:00.000Z',
    });
    assert.equal(
      readCascadeState(root, { repo: REPO, prNumber: 896 }).providerRetryAfter,
      '2026-08-27T04:38:00.000Z'
    );

    recordCascadeFailure(root, {
      repo: REPO,
      prNumber: 896,
      failedAt: '2026-08-23T01:25:25.567Z',
      failureClass: 'launchctl-bootstrap',
    });

    const state = readCascadeState(root, { repo: REPO, prNumber: 896 });
    assert.equal(state.lastFailureClass, 'launchctl-bootstrap');
    assert.equal(state.providerRetryAfter, undefined);
    assert.ok(!Object.hasOwn(state, 'providerRetryAfter'));
    // The counters that ARE meant to carry forward still do.
    assert.equal(state.consecutiveTransientFailures, 2);
    assert.deepEqual(state.transientFailureBreakdown, {
      'quota-exhausted': 1,
      'launchctl-bootstrap': 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
