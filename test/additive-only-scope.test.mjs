import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ADDITIVE_ONLY_LABEL,
  SCOPE_EXPAND_LABEL,
  appendScopeViolationFinding,
  evaluateAdditiveOnlyScope,
  fetchAdditiveOnlyScopeSnapshot,
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
    repo: 'example/review-service',
    prNumber: 57,
    prCreatedAt: '2026-06-19T10:00:00.000Z',
    prAuthor: 'codex-worker',
    currentHeadSha: 'later',
    labels: [],
    openingHeadSha: 'initial',
    openingFiles: { files: [{ filename: 'projects/sample-pack/plan.json' }], truncated: false },
    commits: [
      commit('initial', '2026-06-19T09:55:00.000Z'),
      commit('later', '2026-06-19T10:10:00.000Z'),
    ],
    filesByCommit: {
      initial: [{ filename: 'projects/sample-pack/plan.json' }],
      later: [{ filename: 'src/feature.mjs' }],
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
  assert.deepEqual(result.finding?.violating_files, ['src/feature.mjs']);
  assert.match(result.finding?.detail, /commit later/);
});

test('backdated later commit is still scanned using PR commit order', () => {
  const result = evaluate({
    labels: [{ name: ADDITIVE_ONLY_LABEL }],
    commits: [
      commit('initial', '2026-06-19T09:55:00.000Z'),
      commit('backdated-later', '2026-06-19T09:50:00.000Z'),
    ],
    filesByCommit: {
      initial: [{ filename: 'projects/sample-pack/plan.json' }],
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

test('labeled additive-only PR scans initial commit violations too', () => {
  const result = evaluate({
    labels: [{ name: ADDITIVE_ONLY_LABEL }],
    commits: [
      commit('initial', '2026-06-19T09:55:00.000Z'),
      commit('later', '2026-06-19T10:10:00.000Z'),
    ],
    filesByCommit: {
      initial: [{ filename: 'src/initial-escape.mjs' }],
      later: [{ filename: 'docs/AUDIT-2026-06-19.md' }],
    },
  });

  assert.equal(result.finding?.kind, 'scope-violation');
  assert.deepEqual(result.finding?.violating_files, ['src/initial-escape.mjs']);
});

test('unlabeled PR derives additive-only from initial diff and is enforced without being branded', () => {
  const result = evaluate();

  assert.equal(result.derivedAdditiveOnly, true);
  assert.equal(result.finding?.kind, 'scope-violation');
  assert.equal(result.backfillNeeded, false);
});

test('opening head whitespace preserves derivation and the later-commit boundary', () => {
  const result = evaluate({ openingHeadSha: ' \tinitial\n' });

  assert.equal(result.initialHeadSha, 'initial');
  assert.equal(result.derivedAdditiveOnly, true);
  assert.equal(result.violatingCommitSha, 'later');
  assert.deepEqual(result.finding?.violating_files, ['src/feature.mjs']);
  assert.equal(result.backfillNeeded, false);

  const clean = evaluate({ openingHeadSha: ' \tlater\n' });
  assert.equal(clean.initialHeadSha, 'later');
  assert.equal(clean.derivedAdditiveOnly, true);
  assert.equal(clean.finding, null);
});

test('resolver attempts additive-only label backfill without depending on delivery success', async () => {
  // The snapshot below is clean, so the resolver reaches the backfill. Delivery
  // failure must still not stop enforcement. (A snapshot carrying a violation
  // never reaches the backfill at all -- see
  // additive-only-scope-backfill-on-violation.test.mjs.)
  const calls = [];
  const result = await resolveAdditiveOnlyScopeReview({
    repo: 'example/review-service',
    prNumber: 57,
    snapshot: {
      prCreatedAt: '2026-06-19T10:00:00.000Z',
      currentHeadSha: 'later',
      labels: [],
      openingHeadSha: 'initial',
      openingFiles: { files: [{ filename: 'projects/sample-pack/plan.json' }], truncated: false },
      commits: [
        commit('initial', '2026-06-19T09:55:00.000Z'),
        commit('later', '2026-06-19T10:10:00.000Z'),
      ],
      filesByCommit: {
        initial: [{ filename: 'projects/sample-pack/plan.json' }],
        later: [{ filename: 'projects/sample-pack/SPEC.md' }],
      },
      timeline: [],
    },
    backfillLabelImpl: async (args) => {
      calls.push(args);
      return { attempted: true, added: false, error: 'missing label provisioning' };
    },
  });

  assert.equal(result.finding, null);
  assert.deepEqual(result.backfill, { attempted: true, added: false, error: 'missing label provisioning' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].repo, 'example/review-service');
});

test('labeled additive-only PR with allowlist-only later commit has no finding', () => {
  const result = evaluate({
    labels: [{ name: ADDITIVE_ONLY_LABEL }],
    filesByCommit: {
      initial: [{ filename: 'projects/sample-pack/plan.json' }],
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
      {
        event: 'labeled',
        created_at: '2026-06-19T10:11:00.000Z',
        label: { name: SCOPE_EXPAND_LABEL },
        actor: { login: 'operator' },
      },
    ],
  });

  assert.equal(result.overrideActive, true);
  assert.equal(result.finding, null);
});

test('author-applied scope-expand label does not suppress additive-only scope violation', () => {
  const result = evaluate({
    labels: [{ name: ADDITIVE_ONLY_LABEL }, { name: SCOPE_EXPAND_LABEL }],
    timeline: [
      committedTimelineEvent('later', '2026-06-19T10:10:00.000Z'),
      {
        event: 'labeled',
        created_at: '2026-06-19T10:11:00.000Z',
        label: { name: SCOPE_EXPAND_LABEL },
        actor: { login: 'codex-worker' },
      },
    ],
  });

  assert.equal(result.overrideActive, undefined);
  assert.equal(result.finding?.kind, 'scope-violation');
});

test('unattributed scope-expand label fails closed', () => {
  const result = evaluate({
    labels: [{ name: ADDITIVE_ONLY_LABEL }, { name: SCOPE_EXPAND_LABEL }],
    timeline: [
      committedTimelineEvent('later', '2026-06-19T10:10:00.000Z'),
      { event: 'labeled', created_at: '2026-06-19T10:11:00.000Z', label: { name: SCOPE_EXPAND_LABEL } },
    ],
  });

  assert.equal(result.overrideActive, undefined);
  assert.equal(result.finding?.kind, 'scope-violation');
});

test('scope-expand label fails closed when latest observed head differs from current head', () => {
  const result = evaluate({
    labels: [{ name: ADDITIVE_ONLY_LABEL }, { name: SCOPE_EXPAND_LABEL }],
    timeline: [
      committedTimelineEvent('different-head', '2026-06-19T10:10:00.000Z'),
      {
        event: 'labeled',
        created_at: '2026-06-19T10:11:00.000Z',
        label: { name: SCOPE_EXPAND_LABEL },
        actor: { login: 'operator' },
      },
    ],
  });

  assert.equal(result.overrideActive, undefined);
  assert.equal(result.finding?.kind, 'scope-violation');
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

test('truncated commit file coverage fails closed as an inconclusive scope violation', () => {
  const result = evaluate({
    labels: [{ name: ADDITIVE_ONLY_LABEL }],
    filesByCommit: {
      initial: [{ filename: 'projects/sample-pack/plan.json' }],
      later: { files: [{ filename: 'docs/AUDIT-2026-06-19.md' }], truncated: true },
    },
  });

  assert.equal(result.finding?.kind, 'scope-violation');
  assert.equal(result.finding?.file_list_truncated, true);
  assert.deepEqual(result.finding?.violating_files, []);
  assert.match(result.finding?.detail, /inconclusive/i);
});

test('unlabeled PR whose initial diff was mixed is ignored regardless of later paths', () => {
  const result = evaluate({
    openingFiles: { files: [{ filename: 'src/watcher.mjs' }], truncated: false },
    filesByCommit: {
      initial: [{ filename: 'src/watcher.mjs' }],
      later: [{ filename: 'src/feature.mjs' }],
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

test('scope finding detector ignores unstructured discussion of scope-violation', () => {
  const body = [
    '## Non-blocking issues',
    '- This review mentions `"kind": "scope-violation"` as prose.',
    '- It also mentions kind: scope-violation without the emitted JSON block.',
  ].join('\n');

  assert.equal(reviewBodyHasScopeViolationFinding(body), false);
});

test('doc-first PR opened with implementation does not derive additive-only', () => {
  const result = evaluate({
    openingHeadSha: 'later',
    openingFiles: { files: [
      { filename: 'projects/sample/SCOPE.md' },
      { filename: 'src/feature.mjs' },
    ], truncated: false },
  });
  assert.equal(result.additiveOnly, false);
  assert.equal(result.finding, null);
  assert.equal(result.backfillNeeded, false);
});

test('unknown, truncated or rebased opening evidence does not derive a class', () => {
  for (const evidence of [
    { openingHeadSha: null },
    { openingHeadSha: 'rebased-away' },
    { openingFiles: null },
    { openingFiles: { files: [{ filename: 'projects/sample/SCOPE.md' }], truncated: true } },
  ]) {
    const result = evaluate(evidence);
    assert.equal(result.additiveOnly, false);
    assert.equal(result.finding, null);
    assert.equal(result.backfillNeeded, false);
    assert.equal(evaluate({ ...evidence, labels: [ADDITIVE_ONLY_LABEL] }).finding?.kind, 'scope-violation');
  }
});

test('resolver re-derives every pass and withdraws a prior scope finding without branding', async () => {
  const snapshots = [
    { openingHeadSha: 'initial', openingFiles: { files: [{ filename: 'projects/sample/SCOPE.md' }], truncated: false } },
    { openingHeadSha: 'later', openingFiles: { files: [{ filename: 'projects/sample/SCOPE.md' }, { filename: 'src/feature.mjs' }], truncated: false } },
  ];
  let fetches = 0;
  const options = {
    repo: 'example/review-service', prNumber: 57,
    fetchSnapshotImpl: async () => ({
      currentHeadSha: 'later', commits: [{ sha: 'initial' }, { sha: 'later' }],
      filesByCommit: { initial: [{ filename: 'projects/sample/SCOPE.md' }], later: [{ filename: 'src/feature.mjs' }] },
      ...snapshots[fetches++],
    }),
    backfillLabelImpl: async () => assert.fail('a violating or non-additive PR must not be branded'),
  };
  assert.equal((await resolveAdditiveOnlyScopeReview(options)).finding?.kind, 'scope-violation');
  const next = await resolveAdditiveOnlyScopeReview(options);
  assert.equal(next.additiveOnly, false);
  assert.equal(next.finding, null);
  assert.equal(fetches, 2);
});

function snapshotExecutor({ events = [], openingFiles = [], fail = null, labeled = false } = {}) {
  const calls = [];
  return {
    calls,
    execFileImpl: async (_file, args) => {
      const endpoint = args[1];
      calls.push(endpoint);
      if (fail && endpoint.includes(fail)) throw new Error('synthetic lookup failure');
      let data;
      if (endpoint === 'repos/example/review-service/pulls/57') data = { id: 42, head: { sha: 'later' } };
      else if (endpoint.includes('/labels?')) data = labeled ? [{ name: ADDITIVE_ONLY_LABEL }] : [];
      else if (endpoint.includes('/pulls/57/commits?')) data = [{ sha: 'initial' }, { sha: 'later' }];
      else if (endpoint.includes('/timeline?')) data = [];
      else if (endpoint.includes('/events?')) data = typeof events === 'function' ? events(endpoint) : events;
      else if (endpoint.includes('/compare/')) data = { files: openingFiles };
      else if (endpoint.includes('/commits/initial?')) data = { files: [{ filename: 'projects/sample/SCOPE.md' }] };
      else if (endpoint.includes('/commits/later?')) data = { files: [{ filename: 'src/feature.mjs' }] };
      else assert.fail(`unexpected endpoint ${endpoint}`);
      return { stdout: JSON.stringify(data) };
    },
  };
}

function openedEvent(head = 'later', overrides = {}) {
  return { type: 'PullRequestEvent', payload: {
    action: 'opened', number: 57,
    pull_request: { id: 42, base: { sha: 'base' }, head: { sha: head } },
    ...overrides,
  } };
}

async function acquire(options) {
  const executor = snapshotExecutor(options);
  const snapshot = await fetchAdditiveOnlyScopeSnapshot({
    repo: 'example/review-service', prNumber: 57, execFileImpl: executor.execFileImpl,
    logger: { warn() {} },
  });
  return { snapshot, calls: executor.calls, result: evaluateAdditiveOnlyScope(snapshot) };
}

test('snapshot classifies the net diff of both opening SHAs, including all opening commits', async () => {
  const { result, calls } = await acquire({ events: [openedEvent()], openingFiles: [
    { filename: 'projects/sample/SCOPE.md' }, { filename: 'src/feature.mjs' },
  ] });
  assert.equal(result.additiveOnly, false);
  assert.equal(result.finding, null);
  assert.ok(calls.includes('repos/example/review-service/compare/base...later?per_page=1'));
});

test('snapshot retains enforcement for code pushed after a doc-only opening', async () => {
  const { result } = await acquire({ events: [openedEvent('initial')], openingFiles: [{ filename: 'projects/sample/SCOPE.md' }] });
  assert.equal(result.derivedAdditiveOnly, true);
  assert.deepEqual(result.finding?.violating_files, ['src/feature.mjs']);
  assert.equal(result.backfillNeeded, false);
});

test('clean net opening diff does not brand a PR that the wider labeled scan would flag', async () => {
  const { result } = await acquire({ events: [openedEvent()], openingFiles: [{ filename: 'projects/sample/SCOPE.md' }] });
  assert.equal(result.derivedAdditiveOnly, true);
  assert.equal(result.finding, null);
  assert.equal(result.backfillNeeded, false);
});

test('opening event lookup paginates and ignores other PRs and later actions', async () => {
  const { result, calls } = await acquire({
    events: (endpoint) => endpoint.endsWith('page=1')
      ? Array.from({ length: 100 }, () => openedEvent('initial', { number: 99 }))
      : [openedEvent('initial', { action: 'reopened' }), openedEvent()],
    openingFiles: [{ filename: 'src/feature.mjs' }],
  });
  assert.equal(result.additiveOnly, false);
  assert.ok(calls.some((endpoint) => endpoint.endsWith('/events?per_page=100&page=2')));
  assert.ok(calls.includes('repos/example/review-service/compare/base...later?per_page=1'));
});

test('missing, expired, mismatched, rebased or unreadable opening evidence declines derivation', async () => {
  for (const options of [
    {}, { events: [openedEvent('rebased-away')] },
    { events: [openedEvent(null)] }, { events: [openedEvent()], openingFiles: null },
    { events: [openedEvent('initial', { pull_request: { id: 99, head: { sha: 'initial' }, base: { sha: 'base' } } })] },
    { fail: '/events?' }, { events: [openedEvent()], fail: '/compare/' },
    { events: [openedEvent()], openingFiles: Array.from({ length: 300 }, () => ({ filename: 'projects/sample/SCOPE.md' })) },
  ]) {
    const { result } = await acquire(options);
    assert.equal(result.additiveOnly, false);
    assert.equal(result.finding, null);
  }
});

test('labeled snapshot does not depend on opening evidence and scans all commits', async () => {
  const { result, calls } = await acquire({ labeled: true, fail: '/events?' });
  assert.equal(result.finding?.kind, 'scope-violation');
  assert.equal(calls.some((endpoint) => endpoint.includes('/events?')), false);
});

test('derived class retains current-head, non-author scope-expand authority rules', () => {
  for (const labels of [[SCOPE_EXPAND_LABEL], [ADDITIVE_ONLY_LABEL, SCOPE_EXPAND_LABEL]]) {
    for (const [actor, afterHead, accepted] of [
      ['operator', true, true], ['codex-worker', true, false], ['operator', false, false],
    ]) {
      const approval = { event: 'labeled', label: { name: SCOPE_EXPAND_LABEL }, actor: { login: actor } };
      const pushed = committedTimelineEvent('later', '2026-06-19T10:10:00.000Z');
      const result = evaluate({ labels, timeline: afterHead ? [pushed, approval] : [approval, pushed] });
      assert.equal(Boolean(result.overrideActive), accepted);
      assert.equal(Boolean(result.finding), !accepted);
      assert.equal(result.backfillNeeded, false);
    }
  }
});


test('opening lookup is bounded when the opening event has left the activity window', async () => {
  const { result, calls } = await acquire({
    events: Array.from({ length: 100 }, () => openedEvent('initial', { number: 99 })),
  });
  assert.equal(result.additiveOnly, false);
  assert.equal(calls.filter((endpoint) => endpoint.includes('/events?')).length, 3);
  assert.equal(calls.some((endpoint) => endpoint.includes('/compare/')), false);
});


test('net opening evidence derives freely but never brands unreadable opening history', () => {
  const result = evaluate({
    openingHeadSha: 'later',
    openingFiles: { files: [{ filename: 'projects/sample/SCOPE.md' }], truncated: false },
    filesByCommit: {
      initial: { files: [{ filename: 'projects/sample/SCOPE.md' }], truncated: true },
      later: [{ filename: 'projects/sample/PLAN.md' }],
    },
  });
  assert.equal(result.derivedAdditiveOnly, true);
  assert.equal(result.finding, null);
  assert.equal(result.backfillNeeded, false);
});
