// reviewer-command-failed-recovery.test.mjs — LAC-1359 regression target.
//
// A reviewer that exited non-zero WITHOUT posting a verdict surfaces as
// `[unknown] Command failed with code N`. Before LAC-1359, the watcher's
// infraRecoverableFailureClass() returned null for that shape, so the watcher
// hit `review_status === 'failed' && !infraRecoveryClass` and STRANDED the PR
// permanently ("Skipping failed review: failure is not infrastructure-
// recoverable; leaving evidence intact"). ~10 OPEN PRs were orphaned this way
// on 2026-06-21. The fix classifies it as a boundedly-recoverable infra class
// ('reviewer-command-failed') so the watcher's INFRA_AUTO_RECOVER_CAP retries
// it a few times, then goes terminal for operator inspection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  infraRecoverableFailureClass,
} from '../src/reviewer-failure-classification.mjs';

test('`[unknown] Command failed with code 1` is boundedly recoverable (was stranded)', () => {
  // Verbatim shape of the failure_message observed for the orphaned 2026-06-21
  // OPEN PRs (#2290, #2321, #2322, #2325, ...).
  const row = {
    failure_message:
      '[unknown] Command failed with code 1\nstdout tail:\n[reviewer] Starting review: laceyenterprises/agent-os#2322',
  };
  assert.equal(infraRecoverableFailureClass(row), 'reviewer-command-failed');
});

test('`[unknown] Command failed` (no exit code) also recovers', () => {
  const row = { failure_message: '[unknown] Command failed' };
  assert.equal(infraRecoverableFailureClass(row), 'reviewer-command-failed');
});

test('forbidden-fallback stays terminal (security-class, NOT recovered)', () => {
  const row = { failure_message: '[forbidden-fallback] api-key fallback detected' };
  assert.equal(infraRecoverableFailureClass(row), null);
});

test('a non-command-failed unknown message stays terminal', () => {
  // Only the command-failed-no-verdict shape is treated as infra; other
  // uncategorized failures remain terminal so they surface to the operator.
  const row = { failure_message: '[unknown] reviewer produced malformed verdict json' };
  assert.equal(infraRecoverableFailureClass(row), null);
});

test('known infra classes are unchanged', () => {
  assert.equal(
    infraRecoverableFailureClass({ failure_message: '[reviewer-timeout] exceeded 1800s' }),
    'reviewer-timeout',
  );
  assert.equal(
    infraRecoverableFailureClass({ failure_message: '[oauth-broken] token refresh failed' }),
    'oauth-broken',
  );
});
