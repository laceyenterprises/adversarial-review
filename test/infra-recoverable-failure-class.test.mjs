// infra-recoverable-failure-class.test.mjs — proves infraRecoverableFailureClass
// recognizes the infrastructure-class reviewer failures the watcher may
// boundedly auto-recover after the normal dispatch path claims the row,
// INCLUDING the oauth-broken spawn failure that grounded the codex reviewer
// fleet on 2026-06-13 (a missing hq-gh.sh source mislabeled as oauth-broken).
// Security-class failures (forbidden-fallback) and real review verdicts must
// NOT be recoverable.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  infraRecoverableFailureClass,
  reviewerFailureClassFromStoredRow,
  unknownReviewerCommandFailureClass,
} from '../src/reviewer-failure-classification.mjs';
import { PROVIDER_OVERLOADED_FAILURE_CLASS } from '../src/reviewer-cascade.mjs';
import { QUOTA_EXHAUSTED_FAILURE_CLASS } from '../src/quota-exhaustion.mjs';

test('oauth-broken spawn failure is infra-recoverable (the 2026-06-13 incident shape)', () => {
  const row = {
    failure_message:
      '[oauth-broken] Command failed with code 2\nstdout tail:\n[reviewer] Starting review: laceyenterprises/agent-os#1727 model=codex (OAuth-only mode; prompt stage=first)',
  };
  // The narrow stored-row classifier does NOT recover oauth-broken...
  assert.equal(reviewerFailureClassFromStoredRow(row), null);
  // ...but the infra-recoverable superset does.
  assert.equal(infraRecoverableFailureClass(row), 'oauth-broken');
});

test('cascade / reviewer-timeout / launchctl-bootstrap / provider degradation remain infra-recoverable', () => {
  assert.equal(
    infraRecoverableFailureClass({ failure_message: '[cascade] Routing-tier readiness probe could not connect.' }),
    'cascade'
  );
  assert.equal(
    infraRecoverableFailureClass({ failure_message: '[reviewer-timeout] reviewer wall-clock exceeded' }),
    'reviewer-timeout'
  );
  assert.equal(
    infraRecoverableFailureClass({ failure_message: '[launchctl-bootstrap] claude launchctl session bootstrap failed' }),
    'launchctl-bootstrap'
  );
  assert.equal(
    infraRecoverableFailureClass({ failure_message: '[provider-overloaded] HTTP 529 provider overloaded' }),
    PROVIDER_OVERLOADED_FAILURE_CLASS
  );
  assert.equal(
    infraRecoverableFailureClass({ failure_message: '[quota-exhausted] usage limit; try again later' }),
    QUOTA_EXHAUSTED_FAILURE_CLASS
  );
});

test('forbidden-fallback is NOT infra-recoverable (security must stay terminal)', () => {
  const row = { failure_message: 'forbidden fallback: api-key fallback detected; env-strip violation' };
  assert.equal(infraRecoverableFailureClass(row), null);
  assert.equal(unknownReviewerCommandFailureClass(row), null);
});

test('a real review verdict / unknown failure is NOT infra-recoverable', () => {
  assert.equal(infraRecoverableFailureClass({ failure_message: 'Request changes: the patch drops a test.' }), null);
  assert.equal(infraRecoverableFailureClass({ failure_message: '' }), null);
  assert.equal(infraRecoverableFailureClass({}), null);
});

test('unknown reviewer command failures route through tagged infra recovery or untagged bounded retry', () => {
  assert.equal(
    infraRecoverableFailureClass({ failure_message: '[unknown] Command failed with code 1' }),
    'reviewer-command-failed'
  );
  assert.equal(
    infraRecoverableFailureClass({ failure_message: 'Command failed with code 1' }),
    null
  );
  assert.equal(
    unknownReviewerCommandFailureClass({ failure_message: '[unknown] Command failed with code 1' }),
    'unknown'
  );
  assert.equal(
    unknownReviewerCommandFailureClass({ failure_message: 'Command failed with code 1' }),
    'unknown'
  );
});

test('terminal tagged failures are not reclassified as retryable unknown failures', () => {
  assert.equal(
    unknownReviewerCommandFailureClass({ failure_message: '[forbidden-fallback] Command failed with code 1' }),
    null
  );
  assert.equal(
    unknownReviewerCommandFailureClass({ failure_message: '[bug] Command failed with code 1' }),
    null
  );
  assert.equal(
    unknownReviewerCommandFailureClass({ failure_message: 'Request changes: the patch drops a test.' }),
    null
  );
});
