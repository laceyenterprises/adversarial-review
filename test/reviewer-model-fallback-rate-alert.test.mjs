import test from 'node:test';
import assert from 'node:assert/strict';

import {
  recordReviewerModelFallbackForAlert,
  reviewerModelFallbackAlertConfig,
} from '../src/pollonce-phases.mjs';

const fallback = {
  fromReviewerModel: 'claude',
  toReviewerModel: 'gemini',
  failureClass: 'launchctl-bootstrap',
};

test('reviewer model fallback rate warning counts distinct subjects in a window', () => {
  const warnings = [];
  const state = { events: [], lastAlertMs: null };
  const config = { windowMs: 60_000, threshold: 3 };
  const log = { warn: (line) => warnings.push(line) };

  recordReviewerModelFallbackForAlert({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 6501,
    fallback,
    nowMs: 1_000,
    state,
    config,
    log,
  });
  recordReviewerModelFallbackForAlert({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 6501,
    fallback,
    nowMs: 2_000,
    state,
    config,
    log,
  });
  const belowThreshold = recordReviewerModelFallbackForAlert({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 6502,
    fallback,
    nowMs: 3_000,
    state,
    config,
    log,
  });

  assert.equal(belowThreshold.alerted, false);
  assert.equal(belowThreshold.distinctSubjects, 2);
  assert.deepEqual(warnings, []);

  const thresholdCrossed = recordReviewerModelFallbackForAlert({
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 1013,
    fallback,
    nowMs: 4_000,
    state,
    config,
    log,
  });

  assert.equal(thresholdCrossed.alerted, true);
  assert.equal(thresholdCrossed.distinctSubjects, 3);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /reviewer-lane-fallback-rate-high/);
  assert.match(warnings[0], /distinctSubjects=3/);
  assert.match(warnings[0], /threshold=3/);
  assert.match(warnings[0], /classes=launchctl-bootstrap/);
  assert.match(warnings[0], /routes=claude->gemini/);
});

test('reviewer model fallback rate warning uses a trailing cooldown after threshold', () => {
  const warnings = [];
  const state = { events: [], lastAlertMs: null };
  const config = { windowMs: 60_000, threshold: 3 };
  const log = { warn: (line) => warnings.push(line) };

  for (const prNumber of [6501, 6502, 6503, 6504, 6505]) {
    recordReviewerModelFallbackForAlert({
      repoPath: 'laceyenterprises/agent-os',
      prNumber,
      fallback,
      nowMs: prNumber,
      state,
      config,
      log,
    });
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /distinctSubjects=3/);
  assert.equal(state.lastAlertMs, 6503);
});

test('reviewer model fallback rate warning does not duplicate across bucket boundaries', () => {
  const warnings = [];
  const state = { events: [], lastAlertMs: null };
  const config = { windowMs: 60_000, threshold: 3 };
  const log = { warn: (line) => warnings.push(line) };

  for (const [prNumber, nowMs] of [
    [6501, 59_900],
    [6502, 59_950],
    [6503, 59_990],
  ]) {
    recordReviewerModelFallbackForAlert({
      repoPath: 'laceyenterprises/agent-os',
      prNumber,
      fallback,
      nowMs,
      state,
      config,
      log,
    });
  }

  const duplicate = recordReviewerModelFallbackForAlert({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 6504,
    fallback,
    nowMs: 60_001,
    state,
    config,
    log,
  });

  assert.equal(duplicate.alerted, false);
  assert.equal(duplicate.distinctSubjects, 4);
  assert.equal(warnings.length, 1);
});

test('reviewer model fallback rate warning drops events outside the window', () => {
  const warnings = [];
  const state = { events: [], lastAlertMs: null };
  const config = { windowMs: 10_000, threshold: 2 };
  const log = { warn: (line) => warnings.push(line) };

  recordReviewerModelFallbackForAlert({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 6501,
    fallback,
    nowMs: 1_000,
    state,
    config,
    log,
  });
  const result = recordReviewerModelFallbackForAlert({
    repoPath: 'laceyenterprises/agent-os',
    prNumber: 6502,
    fallback,
    nowMs: 20_000,
    state,
    config,
    log,
  });

  assert.equal(result.alerted, false);
  assert.equal(result.distinctSubjects, 1);
  assert.deepEqual(warnings, []);
});

test('reviewer model fallback rate warning rejects non-positive and coerced PR numbers', () => {
  const warnings = [];
  const state = { events: [], lastAlertMs: null };
  const config = { windowMs: 60_000, threshold: 1 };
  const log = { warn: (line) => warnings.push(line) };

  for (const prNumber of [null, false, '', [], 0, -1]) {
    const result = recordReviewerModelFallbackForAlert({
      repoPath: 'laceyenterprises/agent-os',
      prNumber,
      fallback,
      nowMs: 1_000,
      state,
      config,
      log,
    });
    assert.deepEqual(result, { alerted: false, distinctSubjects: 0 });
  }

  assert.deepEqual(state.events, []);
  assert.deepEqual(warnings, []);
});

test('reviewer model fallback alert config uses bounded defaults and env overrides', () => {
  assert.deepEqual(
    reviewerModelFallbackAlertConfig({
      ADVERSARIAL_REVIEWER_MODEL_FALLBACK_ALERT_WINDOW_MS: '120000',
      ADVERSARIAL_REVIEWER_MODEL_FALLBACK_ALERT_THRESHOLD: '7',
    }),
    { windowMs: 120_000, threshold: 7 },
  );
  assert.deepEqual(
    reviewerModelFallbackAlertConfig({
      ADVERSARIAL_REVIEWER_MODEL_FALLBACK_ALERT_WINDOW_MS: '0',
      ADVERSARIAL_REVIEWER_MODEL_FALLBACK_ALERT_THRESHOLD: 'bad',
    }),
    { windowMs: 600_000, threshold: 5 },
  );
});
