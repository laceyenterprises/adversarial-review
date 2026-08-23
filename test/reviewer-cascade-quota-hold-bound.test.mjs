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

test('a provider reset SHORTER than the backoff is still honoured', () => {
  // Clamping must only ever shorten a hold, never extend one: if the provider
  // says it recovers before our backoff elapses, retry then.
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
    assert.equal(state.nextRetryAfter, soon);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
