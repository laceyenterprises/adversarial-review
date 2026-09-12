import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  detectDuplicateFamiliesForRepo,
  duplicateFamilyCandidateRows,
  ensureDuplicateFamilySchema,
  listDuplicateFamilies,
  readDuplicateFamilyForPr,
  reconcileDuplicateFamiliesForRepo,
  runDuplicateFamilyCensusForWatcher,
} from '../src/duplicate-family-state.mjs';

const REPO = 'laceyenterprises/agent-os';

function subject(prNumber, overrides = {}) {
  return {
    prNumber,
    subject: {
      number: prNumber,
      title: overrides.title || `[codex] DPA-01: work identity extraction ${prNumber}`,
      state: overrides.state || 'OPEN',
      baseRefName: overrides.baseRefName || 'main',
      headRefName: overrides.headRefName || `codex/dpa-01-${prNumber}`,
      headSha: Object.hasOwn(overrides, 'headSha') ? overrides.headSha : `head-${prNumber}`,
      baseSha: overrides.baseSha || 'base-main',
      labels: overrides.labels || [],
    },
    current: overrides.current || null,
  };
}

function provenanceReader(rowsByPr) {
  return ({ prNumber }) => {
    const row = rowsByPr[Number(prNumber)];
    if (!row) return { ok: false, reason: 'missing-build-completion-signal' };
    return { ok: true, row };
  };
}

function memoryDb() {
  const db = new Database(':memory:');
  ensureDuplicateFamilySchema(db);
  return db;
}

test('dispatch-provenance duplicate fixture becomes one advisory family', () => {
  const entries = [
    subject(101, { headSha: 'head-a' }),
    subject(102, { headSha: 'head-b' }),
  ];
  const families = detectDuplicateFamiliesForRepo(entries, {
    repoPath: REPO,
    now: '2026-09-11T00:00:00.000Z',
    readBuildCompletionSignalForPrImpl: provenanceReader({
      101: {
        ticket_id: 'DPA-01',
        spec_ref: 'adversarial-review-duplicate-pr-adjudication@d64170434fdc',
        branch: 'codex/dpa-01-a',
        worker_class: 'codex',
        head_sha: 'head-a',
      },
      102: {
        ticket_id: 'DPA-01',
        spec_ref: 'adversarial-review-duplicate-pr-adjudication@d64170434fdc',
        branch: 'codex/dpa-01-b',
        worker_class: 'codex',
        head_sha: 'head-b',
      },
    }),
  });

  assert.equal(families.length, 1);
  assert.equal(families[0].status, 'advisory');
  assert.equal(families[0].candidates.length, 2);
  assert.equal(families[0].allCandidates.length, 2);
  assert.deepEqual(families[0].commonSignals, [
    'branch-ticket',
    'dispatch-spec',
    'dispatch-ticket',
    'title-ticket',
  ]);

  const db = memoryDb();
  try {
    const result = reconcileDuplicateFamiliesForRepo(db, entries, {
      repoPath: REPO,
      now: '2026-09-11T00:00:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        101: {
          ticket_id: 'DPA-01',
          spec_ref: 'adversarial-review-duplicate-pr-adjudication@d64170434fdc',
          branch: 'codex/dpa-01-a',
          worker_class: 'codex',
          head_sha: 'head-a',
        },
        102: {
          ticket_id: 'DPA-01',
          spec_ref: 'adversarial-review-duplicate-pr-adjudication@d64170434fdc',
          branch: 'codex/dpa-01-b',
          worker_class: 'codex',
          head_sha: 'head-b',
        },
      }),
    });
    assert.equal(result.familyIds.length, 1);
    assert.equal(listDuplicateFamilies(db, { repo: REPO }).length, 1);
    assert.equal(duplicateFamilyCandidateRows(db, result.familyIds[0]).length, 2);
  } finally {
    db.close();
  }
});

test('title fallback needs a second corroborating strong signal', () => {
  const titleOnly = [
    subject(201, { title: '[codex] DPA-01: one', headRefName: 'codex/alpha' }),
    subject(202, { title: '[claude-code] DPA-01: two', headRefName: 'claude/bravo' }),
  ];
  const noFamily = detectDuplicateFamiliesForRepo(titleOnly, {
    repoPath: REPO,
    readBuildCompletionSignalForPrImpl: provenanceReader({}),
  });
  assert.equal(noFamily.length, 0);

  const titleAndBranch = [
    subject(203, { title: '[codex] DPA-01: one', headRefName: 'codex/dpa-01-alpha' }),
    subject(204, { title: '[claude-code] DPA-01: two', headRefName: 'claude/dpa-01-bravo' }),
  ];
  const family = detectDuplicateFamiliesForRepo(titleAndBranch, {
    repoPath: REPO,
    readBuildCompletionSignalForPrImpl: provenanceReader({}),
  });
  assert.equal(family.length, 1);
  assert.deepEqual(family[0].commonSignals, ['branch-ticket', 'title-ticket']);
});

test('head-independent dispatch provenance is not queried twice when head SHA is absent', () => {
  const calls = [];
  detectDuplicateFamiliesForRepo([
    subject(251, { headSha: null }),
    subject(252, { headSha: null }),
  ], {
    repoPath: REPO,
    readBuildCompletionSignalForPrImpl: (args) => {
      calls.push({ prNumber: args.prNumber, headSha: args.headSha });
      return { ok: false, reason: 'missing-build-completion-signal' };
    },
  });

  assert.deepEqual(calls, [
    { prNumber: 251, headSha: null },
    { prNumber: 252, headSha: null },
  ]);
});

test('stack, follow-up, and same-branch remediation candidates are suppressed', () => {
  const stacked = detectDuplicateFamiliesForRepo([
    subject(301, { headSha: 'merged-predecessor', state: 'MERGED' }),
    subject(302, {
      baseSha: 'merged-predecessor',
      headSha: 'follow-up-head',
      headRefName: 'codex/dpa-01-follow-up',
    }),
  ], {
    repoPath: REPO,
    readBuildCompletionSignalForPrImpl: provenanceReader({
      301: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      302: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
    }),
  });
  assert.equal(stacked.length, 0);

  const declaredStack = detectDuplicateFamiliesForRepo([
    subject(303, { labels: ['stack:depends-on-302'] }),
    subject(304, {}),
  ], {
    repoPath: REPO,
    readBuildCompletionSignalForPrImpl: provenanceReader({
      303: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      304: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
    }),
  });
  assert.equal(declaredStack.length, 0);

  const sameBranch = detectDuplicateFamiliesForRepo([
    subject(305, { headRefName: 'codex/dpa-01' }),
    subject(306, { headRefName: 'codex/dpa-01' }),
  ], {
    repoPath: REPO,
    readBuildCompletionSignalForPrImpl: provenanceReader({
      305: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      306: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
    }),
  });
  assert.equal(sameBranch.length, 0);
});

test('idempotent re-census does not duplicate family, candidates, or transitions', () => {
  const db = memoryDb();
  const entries = [
    subject(401),
    subject(402),
  ];
  const options = {
    repoPath: REPO,
    now: '2026-09-11T00:00:00.000Z',
    readBuildCompletionSignalForPrImpl: provenanceReader({
      401: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      402: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
    }),
  };
  try {
    const first = reconcileDuplicateFamiliesForRepo(db, entries, options);
    const second = reconcileDuplicateFamiliesForRepo(db, entries, {
      ...options,
      now: '2026-09-11T00:01:00.000Z',
    });
    assert.deepEqual(second.familyIds, first.familyIds);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM duplicate_families').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM duplicate_family_candidates').get().n, 2);
    const family = listDuplicateFamilies(db)[0];
    assert.equal(JSON.parse(family.transition_log_json).length, 1);
  } finally {
    db.close();
  }
});

test('re-census persists terminal candidates while family remains active', () => {
  const db = memoryDb();
  const entries = [
    subject(421),
    subject(422),
    subject(423),
  ];
  const provenance = provenanceReader({
    421: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
    422: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
    423: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
  });
  try {
    const first = reconcileDuplicateFamiliesForRepo(db, entries, {
      repoPath: REPO,
      now: '2026-09-11T00:00:00.000Z',
      readBuildCompletionSignalForPrImpl: provenance,
    });
    assert.equal(first.familyIds.length, 1);

    reconcileDuplicateFamiliesForRepo(db, [
      subject(421, { state: 'MERGED' }),
      subject(422),
      subject(423),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:05:00.000Z',
      readBuildCompletionSignalForPrImpl: provenance,
    });

    const family = listDuplicateFamilies(db)[0];
    assert.equal(family.status, 'advisory');
    assert.equal(family.candidate_count, 2);
    const rows = duplicateFamilyCandidateRows(db, first.familyIds[0]);
    assert.equal(rows.length, 3);
    assert.equal(rows.find((row) => row.pr_number === 421)?.pr_state, 'merged');
    assert.equal(rows.find((row) => row.pr_number === 421)?.last_seen_at, '2026-09-11T00:05:00.000Z');
  } finally {
    db.close();
  }
});

test('re-census marks absent advisory families inactive without duplicate transitions', () => {
  const db = memoryDb();
  const duplicateEntries = [
    subject(451),
    subject(452),
  ];
  const options = {
    repoPath: REPO,
    now: '2026-09-11T00:00:00.000Z',
    readBuildCompletionSignalForPrImpl: provenanceReader({
      451: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      452: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
    }),
  };
  try {
    reconcileDuplicateFamiliesForRepo(db, duplicateEntries, options);
    reconcileDuplicateFamiliesForRepo(db, [subject(451, { state: 'CLOSED' })], {
      ...options,
      now: '2026-09-11T00:05:00.000Z',
    });
    reconcileDuplicateFamiliesForRepo(db, [subject(451, { state: 'CLOSED' })], {
      ...options,
      now: '2026-09-11T00:06:00.000Z',
    });
    const family = listDuplicateFamilies(db)[0];
    assert.equal(family.status, 'inactive');
    const transitions = JSON.parse(family.transition_log_json);
    assert.deepEqual(transitions.map((entry) => entry.transition), [
      'detected-advisory',
      'census-no-longer-duplicate',
    ]);
  } finally {
    db.close();
  }
});

test('re-census records reactivation when an inactive family becomes advisory again', () => {
  const db = memoryDb();
  const duplicateEntries = [
    subject(471),
    subject(472),
  ];
  const options = {
    repoPath: REPO,
    now: '2026-09-11T00:00:00.000Z',
    readBuildCompletionSignalForPrImpl: provenanceReader({
      471: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      472: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
    }),
  };
  try {
    reconcileDuplicateFamiliesForRepo(db, duplicateEntries, options);
    reconcileDuplicateFamiliesForRepo(db, [subject(471, { state: 'CLOSED' })], {
      ...options,
      now: '2026-09-11T00:05:00.000Z',
    });
    reconcileDuplicateFamiliesForRepo(db, duplicateEntries, {
      ...options,
      now: '2026-09-11T00:10:00.000Z',
    });

    const family = listDuplicateFamilies(db)[0];
    assert.equal(family.status, 'advisory');
    const transitions = JSON.parse(family.transition_log_json);
    assert.deepEqual(transitions.map((entry) => entry.transition), [
      'detected-advisory',
      'census-no-longer-duplicate',
      'reactivated-advisory',
    ]);
    assert.equal(transitions[2].reason, 'duplicate-census-detected-again');
  } finally {
    db.close();
  }
});

test('transition log records recurring inactive and reactivated cycles', () => {
  const db = memoryDb();
  const duplicateEntries = [
    subject(475),
    subject(476),
  ];
  const options = {
    repoPath: REPO,
    now: '2026-09-11T00:00:00.000Z',
    readBuildCompletionSignalForPrImpl: provenanceReader({
      475: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      476: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
    }),
  };
  try {
    reconcileDuplicateFamiliesForRepo(db, duplicateEntries, options);
    reconcileDuplicateFamiliesForRepo(db, [subject(475, { state: 'CLOSED' })], {
      ...options,
      now: '2026-09-11T00:05:00.000Z',
    });
    reconcileDuplicateFamiliesForRepo(db, duplicateEntries, {
      ...options,
      now: '2026-09-11T00:10:00.000Z',
    });
    reconcileDuplicateFamiliesForRepo(db, [subject(475, { state: 'CLOSED' })], {
      ...options,
      now: '2026-09-11T00:15:00.000Z',
    });
    reconcileDuplicateFamiliesForRepo(db, duplicateEntries, {
      ...options,
      now: '2026-09-11T00:20:00.000Z',
    });

    const transitions = JSON.parse(listDuplicateFamilies(db)[0].transition_log_json);
    assert.deepEqual(transitions.map((entry) => entry.transition), [
      'detected-advisory',
      'census-no-longer-duplicate',
      'reactivated-advisory',
      'census-no-longer-duplicate',
      'reactivated-advisory',
    ]);
  } finally {
    db.close();
  }
});

test('candidate reassignment keeps one family mapping per PR', () => {
  const db = memoryDb();
  try {
    const dpaFamily = reconcileDuplicateFamiliesForRepo(db, [
      subject(601, { title: '[codex] DPA-01: first', headRefName: 'codex/dpa-01-a' }),
      subject(602, { title: '[codex] DPA-01: second', headRefName: 'codex/dpa-01-b' }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:00:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        601: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        602: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });
    const dpaFamilyId = dpaFamily.familyIds[0];

    const dpbFamily = reconcileDuplicateFamiliesForRepo(db, [
      subject(601, { title: '[codex] DPB-02: moved', headRefName: 'codex/dpb-02-a' }),
      subject(603, { title: '[codex] DPB-02: sibling', headRefName: 'codex/dpb-02-b' }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:05:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        601: { ticket_id: 'DPB-02', spec_ref: 'spec@2' },
        603: { ticket_id: 'DPB-02', spec_ref: 'spec@2' },
      }),
    });

    assert.notEqual(dpbFamily.familyIds[0], dpaFamilyId);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM duplicate_family_candidates WHERE repo = ? AND pr_number = ?').get(REPO, 601).n,
      1
    );
    assert.equal(readDuplicateFamilyForPr(db, { repo: REPO, prNumber: 601 })?.family_id, dpbFamily.familyIds[0]);

    db.prepare('UPDATE duplicate_families SET updated_at = ? WHERE family_id = ?')
      .run('2026-09-11T00:10:00.000Z', dpaFamilyId);
    assert.equal(readDuplicateFamilyForPr(db, { repo: REPO, prNumber: 601 })?.family_id, dpbFamily.familyIds[0]);
  } finally {
    db.close();
  }
});

test('windowed census preserves active families when no candidate is observed', () => {
  const db = memoryDb();
  const duplicateEntries = [
    subject(701),
    subject(702),
  ];
  const options = {
    repoPath: REPO,
    now: '2026-09-11T00:00:00.000Z',
    readBuildCompletionSignalForPrImpl: provenanceReader({
      701: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      702: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      801: { ticket_id: 'OTHER-01', spec_ref: 'spec@other' },
    }),
  };
  try {
    const first = reconcileDuplicateFamiliesForRepo(db, duplicateEntries, options);
    assert.equal(first.familyIds.length, 1);

    reconcileDuplicateFamiliesForRepo(db, [subject(801, {
      title: '[codex] OTHER-01: unrelated',
      headRefName: 'codex/other-01',
    })], {
      ...options,
      now: '2026-09-11T00:05:00.000Z',
    });

    const family = listDuplicateFamilies(db).find((row) => row.family_id === first.familyIds[0]);
    assert.equal(family.status, 'advisory');
    assert.deepEqual(JSON.parse(family.transition_log_json).map((entry) => entry.transition), [
      'detected-advisory',
    ]);
  } finally {
    db.close();
  }
});

test('watcher census aborts transient provenance failures without deactivating active families', async () => {
  const db = memoryDb();
  const duplicateEntries = [
    subject(481),
    subject(482),
  ];
  try {
    reconcileDuplicateFamiliesForRepo(db, duplicateEntries, {
      repoPath: REPO,
      now: '2026-09-11T00:00:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        481: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        482: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });

    const result = await runDuplicateFamilyCensusForWatcher({
      db,
      subjectEntries: duplicateEntries,
      repoPath: REPO,
      rootDir: '/private/tmp/nonexistent-agent-os-root',
      env: {
        AGENT_OS_SESSION_LEDGER_DB_PATH: '/private/tmp/nonexistent-session-ledger.db',
      },
      log: { log() {}, error() {} },
    });

    assert.match(
      result.error?.message || '',
      /^Transient provenance failure: (malformed-ledger-target|missing-ledger-target)$/
    );
    const family = listDuplicateFamilies(db)[0];
    assert.equal(family.status, 'advisory');
    assert.equal(family.candidate_count, 2);
    assert.deepEqual(JSON.parse(family.transition_log_json).map((entry) => entry.transition), [
      'detected-advisory',
    ]);
  } finally {
    db.close();
  }
});

test('head movement ignores current-head suppressions and stales operator overrides', () => {
  const suppressed = detectDuplicateFamiliesForRepo([
    subject(501, { labels: ['not-a-duplicate-stack'], headSha: 'old-head' }),
    subject(502, { headSha: 'sibling-head' }),
  ], {
    repoPath: REPO,
    readBuildCompletionSignalForPrImpl: provenanceReader({
      501: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      502: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
    }),
  });
  assert.equal(suppressed.length, 0);

  const db = memoryDb();
  try {
    const first = reconcileDuplicateFamiliesForRepo(db, [
      subject(501, { headSha: 'new-head' }),
      subject(502, { headSha: 'sibling-head' }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:00:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        501: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        502: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });
    assert.equal(first.familyIds.length, 1);
    const family = listDuplicateFamilies(db)[0];
    db.prepare(
      'UPDATE duplicate_families SET operator_override_json = ? WHERE family_id = ?'
    ).run(JSON.stringify({
      disposition: 'ignored-not-duplicate',
      candidatePrNumber: 501,
      candidateHeadSha: 'new-head',
    }), family.family_id);

    reconcileDuplicateFamiliesForRepo(db, [
      subject(501, { headSha: 'moved-head' }),
      subject(502, { headSha: 'sibling-head' }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:02:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        501: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        502: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });
    const updated = listDuplicateFamilies(db)[0];
    const override = JSON.parse(updated.operator_override_json);
    assert.equal(override.stale, true);
    assert.equal(override.staleReason, 'candidate-head-moved');
    assert.equal(override.staleObservedHeadSha, 'moved-head');

    reconcileDuplicateFamiliesForRepo(db, [
      subject(501, { headSha: 'moved-head' }),
      subject(502, { headSha: 'sibling-head' }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:03:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        501: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        502: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });
    assert.equal(listDuplicateFamilies(db)[0].operator_override_json, updated.operator_override_json);
  } finally {
    db.close();
  }
});
