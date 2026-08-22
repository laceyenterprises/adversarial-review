/**
 * Check-rollup tests (ARF-02 required-check rollup).
 *
 * The bias under test is conservatism about green. This repo merged PR #4223
 * over a repo-guards FAILURE and #4224/#4233/#4235 with zero reviews; a rollup
 * that rounds toward "looks fine" is how a dashboard participates in that.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ROLLUP_FAILURE,
  ROLLUP_NONE,
  ROLLUP_PENDING,
  ROLLUP_SUCCESS,
  normalizeCheckRun,
  normalizeCommitStatus,
  summarizeChecks,
} from '../src/github/checks.mjs';

const run = (name, status, conclusion) => normalizeCheckRun({ name, status, conclusion });

describe('check normalization', () => {
  it('maps a check run onto the entry shape', () => {
    assert.deepEqual(normalizeCheckRun({
      name: 'tests',
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://gh/1',
      completed_at: '2026-08-16T10:00:00Z',
    }), {
      name: 'tests',
      kind: 'check-run',
      status: 'completed',
      conclusion: 'success',
      url: 'https://gh/1',
      completedAt: '2026-08-16T10:00:00Z',
    });
  });

  it('maps a legacy commit status onto the same vocabulary', () => {
    assert.deepEqual(normalizeCommitStatus({ context: 'ci/build', state: 'error', target_url: 'https://ci/1' }), {
      name: 'ci/build',
      kind: 'status',
      status: 'completed',
      // `error` is a failure: a status that errored did not pass.
      conclusion: 'failure',
      url: 'https://ci/1',
      completedAt: null,
    });
    assert.equal(normalizeCommitStatus({ context: 'ci/build', state: 'pending' }).status, 'in_progress');
    // An unrecognised state is not asserted finished.
    assert.equal(normalizeCommitStatus({ context: 'x', state: 'weird' }).status, null);
  });
});

describe('required-check rollup', () => {
  it('is success only when every required check has concluded green', () => {
    const summary = summarizeChecks(
      [run('repo-guards', 'completed', 'success'), run('tests', 'completed', 'success')],
      { requiredContexts: ['repo-guards', 'tests'] },
    );
    assert.equal(summary.rollup, ROLLUP_SUCCESS);
    assert.equal(summary.requiredKnown, true);
    assert.equal(summary.success, 2);
    assert.deepEqual(summary.missingRequired, []);
  });

  it('is failure when a required check failed', () => {
    const summary = summarizeChecks(
      [run('repo-guards', 'completed', 'failure'), run('tests', 'completed', 'success')],
      { requiredContexts: ['repo-guards', 'tests'] },
    );
    assert.equal(summary.rollup, ROLLUP_FAILURE);
    assert.equal(summary.failure, 1);
  });

  it('does not let a non-required failure block, but still reports it', () => {
    const summary = summarizeChecks(
      [run('repo-guards', 'completed', 'success'), run('optional-lint', 'completed', 'failure')],
      { requiredContexts: ['repo-guards'] },
    );
    assert.equal(summary.rollup, ROLLUP_SUCCESS);
    assert.equal(summary.total, 2);
    assert.equal(summary.gating, 1);
    assert.equal(summary.entries.find((e) => e.name === 'optional-lint').required, false);
  });

  it('is pending — not success — when a required check never reported', () => {
    // The failure mode that matters: a rollup computed only over checks that
    // showed up calls a PR green when its required workflow never started.
    const summary = summarizeChecks(
      [run('repo-guards', 'completed', 'success')],
      { requiredContexts: ['repo-guards', 'tests'] },
    );
    assert.equal(summary.rollup, ROLLUP_PENDING);
    assert.deepEqual(summary.missingRequired, ['tests']);
  });

  it('treats neutral and skipped as passing, matching branch protection', () => {
    const summary = summarizeChecks(
      [run('a', 'completed', 'neutral'), run('b', 'completed', 'skipped')],
      { requiredContexts: ['a', 'b'] },
    );
    assert.equal(summary.rollup, ROLLUP_SUCCESS);
  });

  it('treats stale and cancelled as blocking', () => {
    for (const conclusion of ['stale', 'cancelled', 'timed_out', 'action_required']) {
      const summary = summarizeChecks([run('a', 'completed', conclusion)], { requiredContexts: ['a'] });
      assert.equal(summary.rollup, ROLLUP_FAILURE, `${conclusion} should block`);
    }
  });

  it('treats an unknown conclusion as pending rather than success', () => {
    const summary = summarizeChecks([run('a', 'completed', 'invented_by_github')], { requiredContexts: ['a'] });
    assert.equal(summary.rollup, ROLLUP_PENDING);
  });

  it('gates on every reported check when protection is unreadable', () => {
    // A reviewer identity is not a repo admin, so this is the common case. The
    // gate widens and says so; it does not pretend to know the required set.
    const summary = summarizeChecks(
      [run('repo-guards', 'completed', 'success'), run('optional-lint', 'completed', 'failure')],
      { requiredContexts: null },
    );
    assert.equal(summary.requiredKnown, false);
    assert.equal(summary.rollup, ROLLUP_FAILURE);
    assert.equal(summary.entries[0].required, null, 'unknown-required is null, not false');
  });

  it('reports none when a PR has no checks at all', () => {
    assert.equal(summarizeChecks([], { requiredContexts: [] }).rollup, ROLLUP_NONE);
    assert.equal(summarizeChecks([], { requiredContexts: null }).rollup, ROLLUP_NONE);
  });

  it('reports pending when required contexts exist but nothing has reported', () => {
    const summary = summarizeChecks([], { requiredContexts: ['tests'] });
    assert.equal(summary.rollup, ROLLUP_PENDING);
    assert.deepEqual(summary.missingRequired, ['tests']);
  });
});
