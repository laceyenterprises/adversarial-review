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
import { REVIEWER_EMPTY_OUTPUT_FAILURE_CLASS } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';

test('oauth-broken spawn failure is infra-recoverable (the 2026-06-13 incident shape)', () => {
  const row = {
    failure_message:
      '[oauth-broken] Command failed with code 2\nstdout tail:\n[reviewer] Starting review: laceyenterprises/agent-os#1727 model=codex (OAuth-only mode; prompt stage=first)',
  };
  // The stored-row classifier recognizes the persisted oauth-broken tag...
  assert.equal(reviewerFailureClassFromStoredRow(row), 'oauth-broken');
  // ...and the infra-recoverable superset preserves that classification.
  assert.equal(infraRecoverableFailureClass(row), 'oauth-broken');
});

test('stored-row classifier reads pass metadata when failure_message is absent', () => {
  const row = {
    metadata_json: JSON.stringify({ failureClass: 'dispatch-failed' }),
  };
  assert.equal(reviewerFailureClassFromStoredRow(row), 'dispatch-failed');
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
  assert.equal(
    infraRecoverableFailureClass({ failure_message: '[reviewer-empty-output] Gemini returned empty output.' }),
    REVIEWER_EMPTY_OUTPUT_FAILURE_CLASS
  );
  assert.equal(
    infraRecoverableFailureClass({ failure_message: '[reviewer-output] review artifact missing recognized Verdict value' }),
    'reviewer-output'
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

test('an expired reviewer GitHub token classifies as oauth-broken, not unknown', () => {
  // The 2026-09-03 review outage. The reviewer's bot token is a broker-minted
  // GitHub App INSTALLATION token (1h lifetime); a watcher outliving its mint
  // keeps using the stale value and every `gh` call 401s. The reviewer still
  // runs and still generates a verdict -- it just cannot post it.
  //
  // This text is verbatim from the incident, and it carries NO tag: it used to
  // fall through to 'unknown' and be charged to the reviewer attempt budget
  // ("Reviewer unknown-class failure on #6117; counting against attempt budget
  // (1/4)") instead of the bounded oauth-broken auto-recovery path that exists
  // for exactly this. 8 of 12 open PRs went unreviewed for ~1.5h while the
  // liveness probe still reported the pipeline healthy.
  const row = {
    failure_message:
      'Command failed: gh api repos/laceyenterprises/agent-os/pulls/6117\ngh: Bad credentials (HTTP 401)\n',
  };
  assert.equal(reviewerFailureClassFromStoredRow(row), 'oauth-broken');
  // And it must reach the bounded auto-recovery path, not the attempt budget.
  assert.equal(infraRecoverableFailureClass(row), 'oauth-broken');
  assert.equal(unknownReviewerCommandFailureClass(row), null);
});

test('other GitHub auth-rejection phrasings also classify as oauth-broken', () => {
  for (const text of [
    'gh: Bad credentials (HTTP 401)',
    'HTTP 401: Unauthorized (https://api.github.com/graphql)',
    'Status 401: Unauthorized (https://api.github.com/graphql)',
    '401: Unauthorized (https://api.github.com/graphql)',
    'gh: Requires authentication (HTTP 401)',
  ]) {
    assert.equal(
      reviewerFailureClassFromStoredRow({ failure_message: text }),
      'oauth-broken',
      `expected oauth-broken for: ${text}`,
    );
  }
});

test('incidental auth phrases embedded in unrelated failures do not classify as oauth-broken', () => {
  for (const text of [
    'Command failed with code 124\nstderr tail:\nTimed out while reviewing PR title: fix bad credentials',
    'Command failed with code 124\nstderr tail:\nTimed out while reviewing branch topic/status 401: unauthorized',
    'Command failed with code 124\nstderr tail:\nTimed out while rendering body: requires authentication docs',
  ]) {
    assert.notEqual(
      reviewerFailureClassFromStoredRow({ failure_message: text }),
      'oauth-broken',
      `did not expect oauth-broken for: ${text}`,
    );
  }
});

test('a 403 rate-limit is NOT reclassified as oauth-broken', () => {
  // Guard the blast radius: only credential REJECTION is oauth-broken. A 403
  // rate-limit is a different failure with a different remedy, and folding it
  // into oauth-broken would send it down the re-mint path pointlessly.
  const row = {
    failure_message: 'gh: API rate limit exceeded (HTTP 403)',
  };
  assert.notEqual(reviewerFailureClassFromStoredRow(row), 'oauth-broken');
});
