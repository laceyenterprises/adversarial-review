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
