import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STUCK_REREVIEW_APPLY_ENABLED_ENV,
  resolveStuckRereviewApplyEnabled,
} from '../scripts/adversarial-follow-up-daemon.mjs';

// The `stuck-rereview-apply` tick step is the only part of the follow-up daemon
// tick that writes review-pipeline state on behalf of a stuck row. Every other
// comparably autonomous behavior in this pipeline (merge authority, strict
// mode) is arming-gated; this pins that the watchdog step has a sub-minute
// disarm too, and that the disarm is opt-in rather than a footgun that silently
// turns the watchdog off.

test('stuck-rereview watchdog step is armed by default', () => {
  assert.equal(resolveStuckRereviewApplyEnabled({}), true);
  assert.equal(resolveStuckRereviewApplyEnabled({ [STUCK_REREVIEW_APPLY_ENABLED_ENV]: '' }), true);
  assert.equal(resolveStuckRereviewApplyEnabled({ [STUCK_REREVIEW_APPLY_ENABLED_ENV]: '   ' }), true);
  assert.equal(resolveStuckRereviewApplyEnabled({ [STUCK_REREVIEW_APPLY_ENABLED_ENV]: undefined }), true);
  assert.equal(resolveStuckRereviewApplyEnabled(undefined), true);
});

test('stuck-rereview watchdog step disarms on the documented falsey values', () => {
  for (const value of ['0', 'false', 'FALSE', 'no', 'off', ' Off ']) {
    assert.equal(
      resolveStuckRereviewApplyEnabled({ [STUCK_REREVIEW_APPLY_ENABLED_ENV]: value }),
      false,
      `expected ${JSON.stringify(value)} to disarm the watchdog step`
    );
  }
});

test('stuck-rereview watchdog step stays armed for truthy and unrecognized values', () => {
  for (const value of ['1', 'true', 'yes', 'on', 'enabled', 'maybe']) {
    assert.equal(
      resolveStuckRereviewApplyEnabled({ [STUCK_REREVIEW_APPLY_ENABLED_ENV]: value }),
      true,
      `expected ${JSON.stringify(value)} to leave the watchdog step armed`
    );
  }
});

test('kill switch env var name is stable', () => {
  assert.equal(STUCK_REREVIEW_APPLY_ENABLED_ENV, 'ADVERSARIAL_STUCK_REREVIEW_APPLY_ENABLED');
});
