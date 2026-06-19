import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADDITIVE_ONLY_LABEL,
  SCOPE_EXPAND_LABEL,
  appendScopeViolationFinding,
  evaluateAdditiveOnlyScope,
  resolveAdditiveOnlyScopeReview,
  reviewBodyHasScopeViolationFinding,
} from '../src/additive-only-scope.mjs';

function commit(sha, committedAt) {
  return { sha, commit: { author: { date: committedAt }, committer: { date: committedAt } } };
}

function committedTimelineEvent(sha, committedAt) {
  return { event: 'committed', sha, committer: { date: committedAt } };
}

function evaluate(overrides = {}) {
  return evaluateAdditiveOnlyScope({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 57,
    prCreatedAt: '2026-06-19T10:00:00.000Z',
    currentHeadSha: 'later',
    labels: [],
    commits: [
      commit('initial', '2026-06-19T09:55:00.000Z'),
      commit('later', '2026-06-19T10:10:00.000Z'),
    ],
    filesByCommit: {
      initial: [{ filename: 'projects/codex-runaway-guardrails/plan.json' }],
      later: [{ filename: 'modules/sentinel/lib/scope.mjs' }],
    },
    timeline: [
      committedTimelineEvent('later', '2026-06-19T10:10:00.000Z'),
    ],
    ...overrides,
  });
}

test('labeled additive-only PR with later outside-allowlist commit emits high scope violation', () => {
  const result = evaluate({
    labels: [{ name: ADDITIVE_ONLY_LABEL }],
  });

  assert.equal(result.additiveOnly, true);
  assert.equal(result.finding?.kind, 'scope-violation');
  assert.equal(result.finding?.severity, 'high');
  assert.deepEqual(result.finding?.violating_files, ['modules/sentinel/lib/scope.mjs']);
  assert.match(result.finding?.detail, /commit later/);
});

test('backdated later commit is still scanned using server timeline ordering', () => {
  const result = evaluate({
    labels: [{ name: ADDITIVE_ONLY_LABEL }],
    commits: [
      commit('initial', '2026-06-19T09:55:00.000Z'),
      commit('backdated-later', '2026-06-19T09:50:00.000Z'),
    ],
    filesByCommit: {
      initial: [{ filename: 'projects/codex-runaway-guardrails/plan.json' }],
      'backdated-later': [{ filename: 'src/evil.mjs' }],
    },
    timeline: [
      committedTimelineEvent('initial', '2026-06-19T09:55:00.000Z'),
      committedTimelineEvent('backdated-later', '2026-06-19T10:10:00.000Z'),
    ],
  });

  assert.equal(result.finding?.kind, 'scope-violation');
  assert.deepEqual(result.finding?.violating_files, ['src/evil.mjs']);
  assert.match(result.finding?.detail, /commit backdated-later/);
});

test('unlabeled PR derives additive-only from initial diff and requests label backfill', () => {
  const result = evaluate();

  assert.equal(result.derivedAdditiveOnly, true);
  assert.equal(result.backfillNeeded, true);
  assert.equal(result.finding?.kind, 'scope-violation');
});

test('resolver attempts additive-only label backfill without depending on delivery success', async () => {
  const calls = [];
  const result = await resolveAdditiveOnlyScopeReview({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 57,
    snapshot: {
      prCreatedAt: '2026-06-19T10:00:00.000Z',
      currentHeadSha: 'later',
      labels: [],
      commits: [
        commit('initial', '2026-06-19T09:55:00.000Z'),
        commit('later', '2026-06-19T10:10:00.000Z'),
      ],
      filesByCommit: {
        initial: [{ filename: 'projects/codex-runaway-guardrails/plan.json' }],
        later: [{ filename: 'modules/sentinel/lib/scope.mjs' }],
      },
      timeline: [],
    },
    backfillLabelImpl: async (args) => {
      calls.push(args);
      return { attempted: true, added: false, error: 'missing label provisioning' };
    },
  });

  assert.equal(result.finding?.kind, 'scope-violation');
  assert.deepEqual(result.backfill, { attempted: true, added: false, error: 'missing label provisioning' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].repo, 'laceyenterprises/adversarial-review');
});

test('labeled additive-only PR with allowlist-only later commit has no finding', () => {
  const result = evaluate({
    labels: [{ name: ADDITIVE_ONLY_LABEL }],
    filesByCommit: {
      initial: [{ filename: 'projects/codex-runaway-guardrails/plan.json' }],
      later: [{ filename: 'docs/AUDIT-2026-06-19.md' }],
    },
  });

  assert.equal(result.additiveOnly, true);
  assert.equal(result.finding, null);
});

test('current-head scope-expand label suppresses additive-only scope violation', () => {
  const result = evaluate({
    labels: [{ name: ADDITIVE_ONLY_LABEL }, { name: SCOPE_EXPAND_LABEL }],
    timeline: [
      committedTimelineEvent('later', '2026-06-19T10:10:00.000Z'),
      { event: 'labeled', created_at: '2026-06-19T10:11:00.000Z', label: { name: SCOPE_EXPAND_LABEL } },
    ],
  });

  assert.equal(result.overrideActive, true);
  assert.equal(result.finding, null);
});

test('stale scope-expand label does not bless later violating commits', () => {
  const result = evaluate({
    labels: [{ name: ADDITIVE_ONLY_LABEL }, { name: SCOPE_EXPAND_LABEL }],
    timeline: [
      { event: 'labeled', created_at: '2026-06-19T10:05:00.000Z', label: { name: SCOPE_EXPAND_LABEL } },
      committedTimelineEvent('later', '2026-06-19T10:10:00.000Z'),
    ],
  });

  assert.equal(result.overrideActive, undefined);
  assert.equal(result.finding?.kind, 'scope-violation');
});

test('unlabeled PR whose initial diff was mixed is ignored regardless of later paths', () => {
  const result = evaluate({
    filesByCommit: {
      initial: [{ filename: 'src/watcher.mjs' }],
      later: [{ filename: 'modules/sentinel/lib/scope.mjs' }],
    },
  });

  assert.equal(result.additiveOnly, false);
  assert.equal(result.finding, null);
  assert.equal(result.backfillNeeded, false);
});

test('scope finding appender produces detectable structured JSON block', () => {
  const result = evaluate({ labels: [{ name: ADDITIVE_ONLY_LABEL }] });
  const body = appendScopeViolationFinding('## Verdict\nRequest changes\n', result.finding);

  assert.equal(reviewBodyHasScopeViolationFinding(body), true);
  assert.match(body, /"kind": "scope-violation"/);
  assert.match(body, /"violating_files": \[/);
});
