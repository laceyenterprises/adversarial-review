import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { evaluateDuplicateFamilyCandidate } from '../src/duplicate-family-gate.mjs';
import {
  detectDuplicateFamiliesForRepo,
  duplicateFamilyCandidateRows,
  ensureDuplicateFamilySchema,
  listDuplicateFamilies,
  readDuplicateFamilyForPr,
  reconcileDuplicateFamilyLabels,
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
      duplicateContent: { headSha: Object.hasOwn(overrides, 'headSha') ? overrides.headSha : `head-${prNumber}`, paths: overrides.paths || ['src/shared.mjs'] },
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

function installLegacyCandidateTable(db) {
  db.exec(`
    DROP TABLE duplicate_family_candidates;
    CREATE TABLE duplicate_family_candidates (
      family_id                 TEXT NOT NULL,
      repo                      TEXT NOT NULL,
      pr_number                 INTEGER NOT NULL,
      title                     TEXT,
      pr_state                  TEXT,
      base_branch               TEXT,
      head_branch               TEXT,
      head_sha                  TEXT,
      base_sha                  TEXT,
      role                      TEXT NOT NULL DEFAULT 'candidate',
      work_identity_json        TEXT NOT NULL,
      signals_json              TEXT NOT NULL,
      suppressions_json         TEXT NOT NULL DEFAULT '[]',
      labels_json               TEXT NOT NULL DEFAULT '[]',
      first_seen_at             TEXT NOT NULL,
      last_seen_at              TEXT NOT NULL,
      updated_at                TEXT NOT NULL,
      PRIMARY KEY (family_id, repo, pr_number),
      FOREIGN KEY (family_id) REFERENCES duplicate_families(family_id) ON DELETE CASCADE
    );
  `);
}

function insertFamilyRow(db, familyId, familyKey, updatedAt) {
  db.prepare(`
    INSERT INTO duplicate_families (
      family_id, family_key, target_repo, base_branch, normalized_work_identity,
      status, strongest_signal, transition_log_json, candidate_count,
      first_detected_at, last_seen_at, updated_at
    ) VALUES (?, ?, ?, 'main', ?, 'advisory', 'dispatch-ticket', '[]', 1, ?, ?, ?)
  `).run(familyId, familyKey, REPO, familyKey, updatedAt, updatedAt, updatedAt);
}

function insertLegacyCandidateRow(db, familyId, prNumber, updatedAt) {
  db.prepare(`
    INSERT INTO duplicate_family_candidates (
      family_id, repo, pr_number, title, pr_state, base_branch, head_branch,
      head_sha, base_sha, role, work_identity_json, signals_json,
      suppressions_json, labels_json, first_seen_at, last_seen_at, updated_at
    ) VALUES (
      ?, ?, ?, '[codex] DPA-01: legacy candidate', 'open', 'main', 'codex/dpa-01',
      ?, 'base-main', 'candidate', '{}', '[]', '[]', '[]', ?, ?, ?
    )
  `).run(familyId, REPO, prNumber, `head-${familyId}`, updatedAt, updatedAt, updatedAt);
}

function installIncompleteLegacyCandidateTable(db) {
  db.exec(`
    DROP TABLE duplicate_family_candidates;
    CREATE TABLE duplicate_family_candidates (
      family_id                 TEXT NOT NULL,
      repo                      TEXT NOT NULL,
      pr_number                 INTEGER NOT NULL,
      title                     TEXT,
      pr_state                  TEXT,
      base_branch               TEXT,
      head_branch               TEXT,
      head_sha                  TEXT,
      base_sha                  TEXT,
      role                      TEXT NOT NULL DEFAULT 'candidate',
      work_identity_json        TEXT NOT NULL,
      signals_json              TEXT NOT NULL,
      suppressions_json         TEXT NOT NULL DEFAULT '[]',
      first_seen_at             TEXT NOT NULL,
      last_seen_at              TEXT NOT NULL,
      updated_at                TEXT NOT NULL,
      PRIMARY KEY (family_id, repo, pr_number)
    );
  `);
}

function insertIncompleteLegacyCandidateRow(db, familyId, prNumber, updatedAt) {
  db.prepare(`
    INSERT INTO duplicate_family_candidates (
      family_id, repo, pr_number, title, pr_state, base_branch, head_branch,
      head_sha, base_sha, role, work_identity_json, signals_json,
      suppressions_json, first_seen_at, last_seen_at, updated_at
    ) VALUES (
      ?, ?, ?, '[codex] DPA-01: legacy candidate', 'open', 'main', 'codex/dpa-01',
      ?, 'base-main', 'candidate', '{}', '[]', '[]', ?, ?, ?
    )
  `).run(familyId, REPO, prNumber, `head-${familyId}`, updatedAt, updatedAt, updatedAt);
}

test('legacy candidate primary key migration keeps one row per PR', () => {
  const db = memoryDb();
  try {
    installLegacyCandidateTable(db);
    insertFamilyRow(db, 'legacy-family-a', 'legacy-key-a', '2026-09-11T00:00:00.000Z');
    insertFamilyRow(db, 'legacy-family-b', 'legacy-key-b', '2026-09-11T00:05:00.000Z');
    insertLegacyCandidateRow(db, 'legacy-family-a', 601, '2026-09-11T00:00:00.000Z');
    insertLegacyCandidateRow(db, 'legacy-family-b', 601, '2026-09-11T00:05:00.000Z');

    ensureDuplicateFamilySchema(db);

    const primaryKeyColumns = db.prepare('PRAGMA table_info(duplicate_family_candidates)')
      .all()
      .filter((column) => Number(column.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((column) => column.name);
    assert.deepEqual(primaryKeyColumns, ['repo', 'pr_number']);
    assert.deepEqual(
      db.prepare("PRAGMA index_info('idx_duplicate_family_candidates_family_id')")
        .all()
        .map((column) => column.name),
      ['family_id']
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM duplicate_family_candidates WHERE repo = ? AND pr_number = ?').get(REPO, 601).n,
      1
    );
    assert.equal(readDuplicateFamilyForPr(db, { repo: REPO, prNumber: 601 })?.family_id, 'legacy-family-b');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'duplicate_family_candidates_legacy_%'")
        .get().n,
      0
    );
  } finally {
    db.close();
  }
});

test('candidate primary-key migration rolls back partial rebuild failures', () => {
  const db = memoryDb();
  try {
    installIncompleteLegacyCandidateTable(db);
    insertFamilyRow(db, 'legacy-family-a', 'legacy-key-a', '2026-09-11T00:00:00.000Z');
    insertIncompleteLegacyCandidateRow(db, 'legacy-family-a', 991, '2026-09-11T00:00:00.000Z');

    assert.throws(
      () => ensureDuplicateFamilySchema(db),
      /no such column: labels_json/
    );
    assert.deepEqual(
      db.prepare('PRAGMA table_info(duplicate_family_candidates)')
        .all()
        .filter((column) => Number(column.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((column) => column.name),
      ['family_id', 'repo', 'pr_number']
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM duplicate_family_candidates WHERE repo = ? AND pr_number = ?')
        .get(REPO, 991).n,
      1
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'duplicate_family_candidates_legacy_%'")
        .get().n,
      0
    );
  } finally {
    db.close();
  }
});

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

test('label reconciler does not hold candidates suppressed by the census', async () => {
  const db = memoryDb();
  try {
    const result = reconcileDuplicateFamiliesForRepo(db, [
      subject(331, {}),
      subject(332, {}),
      subject(333, { labels: ['stack:depends-on-331'] }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:00:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        331: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        332: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        333: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });
    assert.equal(result.familyIds.length, 1);
    assert.equal(duplicateFamilyCandidateRows(db, result.familyIds[0]).length, 3);

    const labelAdds = [];
    const labelRemovals = [];
    const octokit = {
      rest: {
        issues: {
          addLabels: async (payload) => labelAdds.push(payload),
          removeLabel: async (payload) => labelRemovals.push(payload),
        },
      },
    };

    const labels = await reconcileDuplicateFamilyLabels({
      db,
      octokit,
      repoPath: REPO,
      logger: { error() {} },
    });

    assert.equal(labels.inspected, 3);
    assert.deepEqual(
      labelAdds.find((entry) => entry.issue_number === 333)?.labels,
      ['duplicate-family'],
    );
    assert.deepEqual(labelRemovals, []);
  } finally {
    db.close();
  }
});

test('label reconciler removes loser role label from suppressed candidates', async () => {
  const db = memoryDb();
  try {
    const result = reconcileDuplicateFamiliesForRepo(db, [
      subject(334, {}),
      subject(335, {}),
      subject(336, { labels: ['stack:depends-on-334', 'duplicate-family-loser'] }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:00:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        334: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        335: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        336: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });
    db.prepare("UPDATE duplicate_family_candidates SET role = 'loser', labels_json = ? WHERE pr_number = 336")
      .run(JSON.stringify(['duplicate-family', 'duplicate-family-loser']));

    const removeCalls = [];
    await reconcileDuplicateFamilyLabels({
      db,
      repoPath: REPO,
      logger: { error() {} },
      octokit: { rest: { issues: {
        addLabels: async () => {},
        removeLabel: async (payload) => removeCalls.push(payload),
      } } },
      census: { families: [], familyIds: result.familyIds },
    });

    assert.deepEqual(removeCalls.map((entry) => [entry.issue_number, entry.name]), [
      [336, 'duplicate-family-loser'],
    ]);
  } finally {
    db.close();
  }
});

test('label reconciler releases inactive family hold once and persists label cache', async () => {
  const db = memoryDb();
  try {
    const first = reconcileDuplicateFamiliesForRepo(db, [
      subject(341, { labels: [] }),
      subject(342, { labels: [] }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:00:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        341: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        342: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });
    assert.equal(first.familyIds.length, 1);

    const addCalls = [];
    const removeCalls = [];
    const octokit = {
      rest: {
        issues: {
          addLabels: async (payload) => addCalls.push(payload),
          removeLabel: async (payload) => removeCalls.push(payload),
        },
      },
    };

    await reconcileDuplicateFamilyLabels({ db, octokit, repoPath: REPO, logger: { error() {} } });
    assert.equal(addCalls.length, 2);
    assert.deepEqual(addCalls.map((entry) => entry.labels), [
      ['duplicate-family', 'duplicate-family-hold'],
      ['duplicate-family', 'duplicate-family-hold'],
    ]);

    reconcileDuplicateFamiliesForRepo(db, [
      subject(341, { labels: ['duplicate-family', 'duplicate-family-hold'] }),
      subject(342, { state: 'CLOSED', labels: ['duplicate-family', 'duplicate-family-hold'] }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:01:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        341: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        342: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });

    await reconcileDuplicateFamilyLabels({ db, octokit, repoPath: REPO, logger: { error() {} } });
    assert.deepEqual(removeCalls.map((entry) => [entry.issue_number, entry.name]), [
      [341, 'duplicate-family-hold'],
      [341, 'duplicate-family'],
    ]);

    await reconcileDuplicateFamilyLabels({ db, octokit, repoPath: REPO, logger: { error() {} } });
    assert.equal(removeCalls.length, 2);

    const labels = JSON.parse(db.prepare(
      'SELECT labels_json FROM duplicate_family_candidates WHERE repo = ? AND pr_number = ?'
    ).get(REPO, 341).labels_json);
    assert.deepEqual(labels, []);
  } finally {
    db.close();
  }
});

test('windowed duplicate-family census does not close unobserved siblings', async () => {
  const db = memoryDb();
  try {
    const first = reconcileDuplicateFamiliesForRepo(db, [
      subject(345, { labels: [] }),
      subject(346, { labels: [] }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:00:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        345: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        346: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });
    assert.equal(first.familyIds.length, 1);

    const second = reconcileDuplicateFamiliesForRepo(db, [
      subject(345, { labels: ['duplicate-family', 'duplicate-family-hold'] }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:01:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        345: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        346: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });

    assert.deepEqual(second.familyIds, first.familyIds);
    const family = listDuplicateFamilies(db)[0];
    assert.equal(family.status, 'advisory');
    const sibling = db.prepare(
      'SELECT pr_state FROM duplicate_family_candidates WHERE repo = ? AND pr_number = ?'
    ).get(REPO, 346);
    assert.equal(sibling.pr_state, 'open');

    const addCalls = [];
    const removeCalls = [];
    const octokit = {
      rest: {
        issues: {
          addLabels: async (payload) => addCalls.push(payload),
          removeLabel: async (payload) => removeCalls.push(payload),
        },
      },
    };
    await reconcileDuplicateFamilyLabels({ db, octokit, repoPath: REPO, logger: { error() {} } });
    assert.deepEqual(removeCalls, []);
    assert.deepEqual(addCalls.map((entry) => entry.issue_number), [346]);
  } finally {
    db.close();
  }
});

test('authoritative reviewed_prs terminal state releases a vanished sibling', () => {
  const db = memoryDb();
  const options = {
    repoPath: REPO,
    now: '2026-09-11T00:00:00.000Z',
    readBuildCompletionSignalForPrImpl: provenanceReader({
      347: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      348: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
    }),
  };
  try {
    reconcileDuplicateFamiliesForRepo(db, [subject(347), subject(348)], options);
    db.exec(`CREATE TABLE reviewed_prs (repo TEXT NOT NULL, pr_number INTEGER NOT NULL, pr_state TEXT NOT NULL)`);
    db.prepare('INSERT INTO reviewed_prs (repo, pr_number, pr_state) VALUES (?, ?, ?)')
      .run(REPO, 348, 'closed');

    reconcileDuplicateFamiliesForRepo(db, [subject(347)], {
      ...options,
      now: '2026-09-11T00:01:00.000Z',
    });

    assert.equal(listDuplicateFamilies(db)[0].status, 'inactive');
    const terminal = db.prepare('SELECT pr_state, updated_at FROM duplicate_family_candidates WHERE pr_number = 348').get();
    assert.equal(terminal.pr_state, 'closed');
    assert.equal(terminal.updated_at, '2026-09-11T00:01:00.000Z');
  } finally {
    db.close();
  }
});

test('label reconciler skips hold additions when the census failed this tick', async () => {
  const db = memoryDb();
  try {
    const first = reconcileDuplicateFamiliesForRepo(db, [
      subject(351, { labels: [] }),
      subject(352, { labels: [] }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:00:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        351: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        352: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });
    assert.equal(first.familyIds.length, 1);

    const addCalls = [];
    const logLines = [];
    const octokit = {
      rest: {
        issues: {
          addLabels: async (payload) => addCalls.push(payload),
          removeLabel: async () => {},
        },
      },
    };

    const result = await reconcileDuplicateFamilyLabels({
      db,
      octokit,
      repoPath: REPO,
      logger: { log: (line) => logLines.push(line), error() {} },
      census: { families: [], familyIds: [], error: new Error('missing-ledger-target') },
    });

    assert.equal(result.inspected, 2);
    assert.equal(result.changed, 0);
    assert.deepEqual(addCalls, []);
    assert.match(logLines.join('\n'), /hold projection skipped/);
  } finally {
    db.close();
  }
});

test('resolved family reactivates and clears stale survivor selection on a fresh duplicate census', () => {
  const db = memoryDb();
  try {
    const first = reconcileDuplicateFamiliesForRepo(db, [
      subject(361, { headSha: 'old-head-361' }),
      subject(362, { headSha: 'old-head-362' }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:00:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        361: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        362: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });
    const familyId = first.familyIds[0];
    db.prepare(
      `UPDATE duplicate_families
          SET status = 'resolved',
              selected_survivor_pr_number = 361,
              report_path = 'docs/research/duplicate-pr-divergence/reports/old.md',
              operator_override_json = ?
        WHERE family_id = ?`
    ).run(JSON.stringify({ selection: { candidatePrNumber: 361, candidateHeadSha: 'old-head-361' } }), familyId);

    reconcileDuplicateFamiliesForRepo(db, [
      subject(363, { headSha: 'new-head-363' }),
      subject(364, { headSha: 'new-head-364' }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:01:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        363: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        364: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });

    const family = listDuplicateFamilies(db)[0];
    assert.equal(family.status, 'advisory');
    assert.equal(family.selected_survivor_pr_number, null);
    assert.equal(family.report_path, null);
    assert.equal(family.operator_override_json, null);
    assert.equal(JSON.parse(family.transition_log_json).at(-1).transition, 'reactivated-advisory');
  } finally {
    db.close();
  }
});

test('survivor-merged family does not reactivate while loser closeout is unfinished', () => {
  const db = memoryDb();
  try {
    const first = reconcileDuplicateFamiliesForRepo(db, [
      subject(367, { headSha: 'survivor-head' }),
      subject(368, { headSha: 'loser-head' }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:00:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        367: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        368: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });
    const familyId = first.familyIds[0];
    const override = {
      selection: {
        candidatePrNumber: 367,
        candidateHeadSha: 'survivor-head',
        reportPath: 'docs/research/duplicate-pr-divergence/reports/old.md',
        reportVerifiedHeadSha: 'survivor-head',
      },
    };
    db.prepare(
      `UPDATE duplicate_families
          SET status = 'survivor-merged',
              selected_survivor_pr_number = 367,
              report_path = 'docs/research/duplicate-pr-divergence/reports/old.md',
              operator_override_json = ?
        WHERE family_id = ?`
    ).run(JSON.stringify(override), familyId);

    reconcileDuplicateFamiliesForRepo(db, [
      subject(367, { headSha: 'survivor-head', state: 'MERGED' }),
      subject(368, { headSha: 'loser-head' }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:01:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        367: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        368: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });

    const family = listDuplicateFamilies(db)[0];
    assert.equal(family.status, 'survivor-merged');
    assert.equal(family.selected_survivor_pr_number, 367);
    assert.equal(family.report_path, 'docs/research/duplicate-pr-divergence/reports/old.md');
    assert.deepEqual(JSON.parse(family.operator_override_json), override);
    assert.notEqual(JSON.parse(family.transition_log_json).at(-1).transition, 'reactivated-advisory');
  } finally {
    db.close();
  }
});

test('adjudicated family deactivates when an observed census no longer has duplicates', () => {
  const db = memoryDb();
  try {
    const first = reconcileDuplicateFamiliesForRepo(db, [
      subject(365),
      subject(366),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:00:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        365: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        366: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });
    db.prepare("UPDATE duplicate_families SET status = 'abandoned' WHERE family_id = ?").run(first.familyIds[0]);

    reconcileDuplicateFamiliesForRepo(db, [
      subject(365),
      subject(366, { state: 'CLOSED' }),
    ], {
      repoPath: REPO,
      now: '2026-09-11T00:01:00.000Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        365: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        366: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    });

    const family = listDuplicateFamilies(db)[0];
    assert.equal(family.status, 'inactive');
    assert.equal(JSON.parse(family.transition_log_json).at(-1).transition, 'census-no-longer-duplicate');
  } finally {
    db.close();
  }
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
    const preserved = db.prepare(
      'SELECT pr_state FROM duplicate_family_candidates WHERE repo = ? AND pr_number = ?'
    ).all(REPO, 701).map((row) => row.pr_state);
    assert.deepEqual(preserved, ['open']);
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
    const sibling = db.prepare(
      'SELECT pr_state FROM duplicate_family_candidates WHERE repo = ? AND pr_number = ?'
    ).get(REPO, 482);
    assert.equal(sibling.pr_state, 'open');
  } finally {
    db.close();
  }
});

test('PR-wide suppression remains label-driven while head movement stales operator overrides', () => {
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

test('DUPFAM-01 replay remains advisory across ignored head changes', () => {
  const db = memoryDb();
  try {
    const entries = [subject(7635, { paths: ['docs/postmortems/SEV3-walkcancel.md'] }),
      subject(7643, { paths: ['modules/worker-pool/worker.mjs', 'modules/worker-pool/cancel.mjs'] })];
    const options = { repoPath: REPO, readBuildCompletionSignalForPrImpl: provenanceReader({}) };
    const first = reconcileDuplicateFamiliesForRepo(db, entries, options);
    assert.equal(first.families.length, 1);
    assert.equal(first.families[0].contentEvidence.held, false);
    assert.equal(first.families[0].contentEvidence.pairs[0].reason, 'incident-record-code-pair');
    const id = first.familyIds[0];
    db.prepare('UPDATE duplicate_families SET operator_override_json = ? WHERE family_id = ?')
      .run(JSON.stringify({ ignoredCandidates: [{ candidatePrNumber: 7643, candidateHeadSha: 'head-7643' }] }), id);
    entries[1].subject.headSha = 'moved';
    entries[1].subject.duplicateContent.headSha = 'moved';
    const next = reconcileDuplicateFamiliesForRepo(db, entries, options);
    assert.equal(next.families[0].contentEvidence.held, false);
    const family = readDuplicateFamilyForPr(db, { repo: REPO, prNumber: 7643, headSha: 'moved' });
    assert.equal(evaluateDuplicateFamilyCandidate(family, { prNumber: 7643, headSha: 'moved' }).held, false);
  } finally { db.close(); }
});

test('DUPFAM-01 overlap is pairwise, excludes generated files and requires current-head content', () => {
  const options = { repoPath: REPO, readBuildCompletionSignalForPrImpl: provenanceReader({}) };
  const entries = [subject(1, { paths: ['src/a.mjs', 'src/b.mjs', 'dist/generated.js'] }),
    subject(2, { paths: ['src/a.mjs', 'src/c.mjs', 'dist/generated.js'] }),
    subject(3, { paths: ['src/disjoint.mjs', 'dist/generated.js'] })];
  const family = detectDuplicateFamiliesForRepo(entries, options)[0];
  assert.equal(family.contentEvidence.pairs[0].jaccard, 1 / 3);
  const row = { status: 'advisory', content_evidence_json: JSON.stringify(family.contentEvidence) };
  assert.equal(evaluateDuplicateFamilyCandidate(row, { prNumber: 1, headSha: 'head-1' }).held, true);
  assert.equal(evaluateDuplicateFamilyCandidate(row, { prNumber: 3, headSha: 'head-3' }).held, false);
  assert.equal(evaluateDuplicateFamilyCandidate(row, { prNumber: 1, headSha: 'moved' }).held, false);
  entries[0].subject.headSha = 'moved';
  assert.equal(detectDuplicateFamiliesForRepo(entries, options)[0].contentEvidence.held, false);
});

test('DUPFAM-01 removes legacy hold labels for identity-only families', async () => {
  const db = memoryDb();
  try {
    const result = reconcileDuplicateFamiliesForRepo(db, [
      subject(7635, { paths: ['docs/reports/SEV3.md'], labels: ['duplicate-family-hold'] }),
      subject(7643, { paths: ['src/fix.mjs'], labels: ['duplicate-family-hold'] }),
    ], { repoPath: REPO, readBuildCompletionSignalForPrImpl: provenanceReader({}) });
    const removed = [];
    const added = [];
    await reconcileDuplicateFamilyLabels({ db, repoPath: REPO, census: result, octokit: { rest: { issues: {
      removeLabel: async (input) => removed.push(input),
      addLabels: async (input) => added.push(input),
    } } } });
    assert.deepEqual(removed.map((entry) => entry.issue_number), [7635, 7643]);
    assert.ok(removed.every((entry) => entry.name === 'duplicate-family-hold'));
    assert.ok(added.every((entry) => !entry.labels.includes('duplicate-family-hold')));
  } finally { db.close(); }
});

test('watcher caches paginated content by head and isolates moving heads', async () => {
  const db = memoryDb();
  try {
    const calls = [];
    let moved = false;
    const entries = [subject(1), subject(2), subject(3, { title: 'unrelated', headRefName: 'unrelated' })];
    const args = { db, subjectEntries: entries, repoPath: REPO, env: {},
      readBuildCompletionSignalForPrImpl: provenanceReader({}), log: { log() {}, error() {} },
      octokit: { rest: { pulls: {
        listFiles: async ({ pull_number, page }) => {
          calls.push([pull_number, page]);
          return { data: page === 1 ? Array.from({ length: 100 }, (_, i) => ({ filename: `src/file-${i}.mjs` })) : [{ filename: 'src/last.mjs' }] };
        },
        get: async ({ pull_number }) => ({ data: { head: { sha: moved ? 'moved' : `head-${pull_number}` } } }),
      } } } };
    const first = await runDuplicateFamilyCensusForWatcher(args);
    assert.equal(first.error, undefined);
    assert.equal(first.families[0].contentEvidence.held, true);
    assert.equal(first.families[0].contentEvidence.pairs[0].overlap.length, 101);
    assert.deepEqual(calls, [[1, 1], [1, 2], [2, 1], [2, 2]]);
    await runDuplicateFamilyCensusForWatcher(args);
    assert.equal(calls.length, 4, 'unchanged heads reuse persisted content');
    moved = true;
    entries[0].subject.headSha = 'new-head-1';
    const next = await runDuplicateFamilyCensusForWatcher(args);
    assert.equal(next.error, undefined);
    assert.equal(next.families[0].contentEvidence.held, true);
    assert.equal(next.families[0].contentEvidence.pairs[0].reason, 'content-pending');
    assert.deepEqual(calls.slice(4), [[1, 1], [1, 2]]);
  } finally { db.close(); }
});

for (const failure of ['truncated', 'moved', 'api-error']) {
  test(`one ${failure} PR does not abort healthy family detection`, async () => {
    const db = memoryDb();
    let failedCalls = 0;
    try {
      const result = await runDuplicateFamilyCensusForWatcher({
        db, repoPath: REPO, env: {},
        subjectEntries: [subject(1), subject(2), subject(3), subject(4, {
          title: '[codex] OTHER-01 separate', headRefName: 'codex/other-01',
        }), subject(5, { title: '[codex] OTHER-01 separate', headRefName: 'claude/other-01' })],
        readBuildCompletionSignalForPrImpl: provenanceReader({}), log: { log() {}, error() {} },
        octokit: { rest: { pulls: {
          listFiles: async ({ pull_number, page }) => {
            if (pull_number === 1) {
              failedCalls += 1;
              if (failure === 'api-error') throw Object.assign(new Error('upstream failed'), { status: 503 });
              if (failure === 'truncated') return { data: Array.from({ length: 100 }, (_, i) => ({ filename: `src/${page}-${i}.mjs` })) };
            }
            return { data: [{ filename: 'src/shared.mjs' }] };
          },
          get: async ({ pull_number }) => ({ data: { head: { sha: pull_number === 1 && failure === 'moved' ? 'new-head' : `head-${pull_number}` } } }),
        } } },
      });
      assert.equal(result.error, undefined);
      assert.equal(result.families.length, 2);
      const family = result.families.find((row) => row.candidates.some((candidate) => candidate.prNumber === 1));
      assert.equal(family.contentEvidence.held, true, 'healthy siblings still corroborate');
      assert.equal(family.contentEvidence.pairs.find((pair) => pair.members.some((member) => member.prNumber === 1)).reason, 'content-pending');
      const persisted = readDuplicateFamilyForPr(db, { repo: REPO, prNumber: 1 });
      assert.equal(evaluateDuplicateFamilyCandidate(persisted, { prNumber: 1, headSha: 'head-1' }).held, false);
      assert.equal(evaluateDuplicateFamilyCandidate(persisted, { prNumber: 2, headSha: 'head-2' }).held, true);
      assert.equal(failedCalls, failure === 'truncated' ? 30 : failure === 'api-error' ? 3 : 1);
    } finally { db.close(); }
  });
}

test('incident record exclusions beat overlap for every supported record directory', () => {
  for (const path of ['docs/postmortems/SEV3.md', 'docs/reports/report.md', 'service/docs/SEV3-record.md']) {
    const family = detectDuplicateFamiliesForRepo([
      subject(1, { paths: [path] }), subject(2, { paths: [path, 'src/fix.mjs'] }),
    ], { repoPath: REPO, readBuildCompletionSignalForPrImpl: provenanceReader({}) })[0];
    assert.equal(family.contentEvidence.pairs[0].jaccard, 0.5);
    assert.equal(family.contentEvidence.held, false);
    assert.equal(family.contentEvidence.pairs[0].reason, 'incident-record-code-pair');
  }
});

test('stale ignores cannot release a previously corroborated pending pair', () => {
  const db = memoryDb();
  try {
    const entries = [subject(1), subject(2)];
    const options = { repoPath: REPO, readBuildCompletionSignalForPrImpl: provenanceReader({}) };
    reconcileDuplicateFamiliesForRepo(db, entries, options);
    db.prepare('UPDATE duplicate_families SET operator_override_json = ?')
      .run(JSON.stringify({ ignoredCandidates: [{ candidatePrNumber: 1, candidateHeadSha: 'head-1' }] }));
    const gate = (headSha) => evaluateDuplicateFamilyCandidate(readDuplicateFamilyForPr(db, { repo: REPO, prNumber: 1 }), { prNumber: 1, headSha });
    assert.equal(gate('head-1').held, false);
    entries[0].subject.headSha = 'moved';
    reconcileDuplicateFamiliesForRepo(db, entries, options);
    assert.equal(gate('moved').held, true);
    entries[0].subject.duplicateContent.headSha = 'moved';
    reconcileDuplicateFamiliesForRepo(db, entries, options);
    assert.equal(gate('moved').held, true);
  } finally { db.close(); }
});

for (const failure of ['503', 'content-head-moved', 'content-truncated']) {
  test(`corroborated holds survive a head move and ${failure} until complete negative evidence`, async () => {
    const db = memoryDb();
    try {
      const entries = [subject(1), subject(2)];
      let failing = false;
      let negative = false;
      let attempts = 0;
      const labels = new Map([[1, new Set()], [2, new Set()]]);
      const removals = [];
      const logs = [];
      const args = { db, subjectEntries: entries, repoPath: REPO, env: {},
        readBuildCompletionSignalForPrImpl: provenanceReader({}),
        log: { log: (line) => logs.push(line), error() {} },
        octokit: { rest: {
          pulls: {
            listFiles: async ({ pull_number, page }) => {
              if (failing && pull_number === 1) {
                attempts += 1;
                if (failure === '503') throw Object.assign(new Error('unavailable'), { status: 503 });
                if (failure === 'content-truncated') return { data: Array.from({ length: 100 }, (_, i) => ({ filename: `src/${page}-${i}.mjs` })) };
              }
              return { data: [{ filename: negative && pull_number === 1 ? 'src/different.mjs' : 'src/shared.mjs' }] };
            },
            get: async ({ pull_number }) => ({ data: { head: {
              sha: failing && failure === 'content-head-moved' && pull_number === 1 ? 'newer-head' : entries[pull_number - 1].subject.headSha,
            } } }),
          },
          issues: {
            addLabels: async ({ issue_number, labels: additions }) => {
              for (const label of additions) labels.get(issue_number).add(label);
            },
            removeLabel: async ({ issue_number, name }) => {
              removals.push([issue_number, name]);
              labels.get(issue_number).delete(name);
            },
          },
        } } };
      const tick = async () => {
        for (const entry of entries) entry.subject.labels = [...labels.get(entry.prNumber)];
        const census = await runDuplicateFamilyCensusForWatcher(args);
        assert.equal(census.error, undefined);
        await reconcileDuplicateFamilyLabels({ db, repoPath: REPO, census, octokit: args.octokit });
        return census;
      };
      await tick();
      failing = true;
      entries[0].subject.headSha = 'moved-head';
      for (let i = 0; i < 2; i += 1) {
        const census = await tick();
        assert.equal(census.families[0].contentEvidence.pairs[0].pending, true);
        assert.equal(census.families[0].contentEvidence.pairs[0].held, true);
        for (const entry of entries) {
          const family = readDuplicateFamilyForPr(db, { repo: REPO, prNumber: entry.prNumber });
          assert.equal(evaluateDuplicateFamilyCandidate(family, { prNumber: entry.prNumber, headSha: entry.subject.headSha }).held, true);
          assert.ok(labels.get(entry.prNumber).has('duplicate-family-hold'));
        }
      }
      assert.deepEqual(removals, []);
      assert.equal(attempts, failure === '503' ? 6 : failure === 'content-truncated' ? 60 : 2);
      const logged = logs.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
      assert.equal(logged[0].contentSignals.pairs[0].overlapCount, 1);
      assert.ok(logged.every((line) => !Object.hasOwn(line.contentSignals.pairs[0], 'overlap')));
      failing = false;
      negative = true;
      await tick();
      assert.deepEqual(removals, [[1, 'duplicate-family-hold'], [2, 'duplicate-family-hold']]);
    } finally { db.close(); }
  });
}

test('pending or unverified evidence never removes existing advisory hold labels', async () => {
  for (const pending of [true, false]) {
    const db = memoryDb();
    try {
      const entries = [subject(1, { paths: ['src/a.mjs'], labels: ['duplicate-family-hold'] }),
        subject(2, { paths: ['src/b.mjs'], labels: ['duplicate-family-hold'] })];
      if (pending) entries[0].subject.duplicateContent = null;
      const census = reconcileDuplicateFamiliesForRepo(db, entries, {
        repoPath: REPO, readBuildCompletionSignalForPrImpl: provenanceReader({}),
      });
      const removed = [];
      await reconcileDuplicateFamilyLabels({ db, repoPath: REPO,
        census: pending ? census : { error: new Error('unverified') },
        logger: { log() {}, error() {} }, octokit: { rest: { issues: {
          addLabels: async () => {}, removeLabel: async (input) => removed.push(input),
        } } },
      });
      assert.deepEqual(removed, []);
    } finally { db.close(); }
  }
});

test('nested source build directories and code under docs count toward overlap', () => {
  for (const path of ['src/build/compile.mjs', 'src/vendor/library.go', 'tools/docs/gen.mjs']) {
    const family = detectDuplicateFamiliesForRepo([subject(1, { paths: [path] }), subject(2, { paths: [path] })], {
      repoPath: REPO, readBuildCompletionSignalForPrImpl: provenanceReader({}),
    })[0];
    assert.equal(family.contentEvidence.held, true);
  }
  const excluded = detectDuplicateFamiliesForRepo([
    subject(1, { paths: ['docs/reports/incident.md'] }),
    subject(2, { paths: ['docs/reports/incident.md', 'tools/docs/gen.mjs'] }),
  ], { repoPath: REPO, readBuildCompletionSignalForPrImpl: provenanceReader({}) })[0];
  assert.equal(excluded.contentEvidence.pairs[0].reason, 'incident-record-code-pair');
});

// DUPTERM-01 / LAC-1895: terminal siblings can all leave discovery together.
for (const [identity, states] of [
  ['HEALTHMEM-01', { 6674: 'closed', 6680: 'merged' }],
  ['SPAWNTMO-01', { 6801: 'merged', 6802: 'closed', 6812: 'merged' }],
]) {
  test(`DUPTERM-01: empty discovery naturally reconciles ${identity} terminal members`, async () => {
    const db = memoryDb();
    const numbers = Object.keys(states).map(Number);
    const options = { repoPath: REPO, now: '2026-09-20T16:02:35.058Z',
      readBuildCompletionSignalForPrImpl: provenanceReader(Object.fromEntries(numbers.map((n) =>
        [n, { ticket_id: identity, spec_ref: 'spec@1' }]))),
    };
    try {
      reconcileDuplicateFamiliesForRepo(db, numbers.map((n) => subject(n)), options);
      db.exec('CREATE TABLE reviewed_prs (repo TEXT, pr_number INTEGER, pr_state TEXT)');
      for (const n of numbers) db.prepare('INSERT INTO reviewed_prs VALUES (?, ?, ?)').run(REPO, n, states[n]);
      const census = await runDuplicateFamilyCensusForWatcher({ db, subjectEntries: [], repoPath: REPO,
        env: {}, log: { log() {}, error() {} },
        readBuildCompletionSignalForPrImpl: options.readBuildCompletionSignalForPrImpl });
      assert.equal(census.error, undefined);
      assert.equal(listDuplicateFamilies(db)[0].status, 'inactive');
      for (const n of numbers) {
        const row = db.prepare('SELECT * FROM duplicate_family_candidates WHERE repo = ? AND pr_number = ?').get(REPO, n);
        assert.equal(row.pr_state, states[n]);
        assert.notEqual(row.updated_at, options.now);
        assert.notEqual(row.last_seen_at, options.now);
      }
      const before = listDuplicateFamilies(db)[0].transition_log_json;
      reconcileDuplicateFamiliesForRepo(db, [], options);
      assert.equal(listDuplicateFamilies(db)[0].transition_log_json, before);
    } finally { db.close(); }
  });
}

test('DUPTERM-01: terminal evidence refreshes mixed families without discarding absent live siblings', () => {
  const db = memoryDb();
  const numbers = [6674, 6680, 6812];
  const options = { repoPath: REPO, now: '2026-09-20T16:02:35.058Z',
    readBuildCompletionSignalForPrImpl: provenanceReader(Object.fromEntries(numbers.map((n) =>
      [n, { ticket_id: 'DPA-01', spec_ref: 'spec@1' }]))),
  };
  try {
    reconcileDuplicateFamiliesForRepo(db, numbers.map((n) => subject(n)), options);
    db.exec('CREATE TABLE reviewed_prs (repo TEXT, pr_number INTEGER, pr_state TEXT)');
    db.prepare('INSERT INTO reviewed_prs VALUES (?, ?, ?)').run(REPO, 6674, 'closed');
    reconcileDuplicateFamiliesForRepo(db, [], { ...options, now: '2026-10-08T20:47:00Z' });
    assert.equal(listDuplicateFamilies(db)[0].status, 'advisory');
    assert.equal(listDuplicateFamilies(db)[0].candidate_count, 2);
    assert.equal(db.prepare('SELECT pr_state FROM duplicate_family_candidates WHERE pr_number = 6674').get().pr_state, 'closed');
    for (const n of [6680, 6812]) assert.equal(db.prepare('SELECT pr_state FROM duplicate_family_candidates WHERE pr_number = ?').get(n).pr_state, 'open');
  } finally { db.close(); }
});

for (const state of [null, 'unknown', 'error', 'open']) {
  test(`DUPTERM-01: absent discovery with reviewed state ${state} preserves cached holds`, () => {
    const db = memoryDb();
    const options = { repoPath: REPO, now: '2026-09-20T16:02:35.058Z',
      readBuildCompletionSignalForPrImpl: provenanceReader({
        6674: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
        6680: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
      }),
    };
    try {
      reconcileDuplicateFamiliesForRepo(db, [subject(6674), subject(6680)], options);
      db.exec('CREATE TABLE reviewed_prs (repo TEXT, pr_number INTEGER, pr_state TEXT)');
      if (state !== null) db.prepare('INSERT INTO reviewed_prs VALUES (?, ?, ?)').run(REPO, 6674, state);
      reconcileDuplicateFamiliesForRepo(db, [], { ...options, now: '2026-10-08T20:47:00Z' });
      assert.equal(listDuplicateFamilies(db)[0].status, 'advisory');
      assert.equal(evaluateDuplicateFamilyCandidate(readDuplicateFamilyForPr(db, { repo: REPO, prNumber: 6674 }), { prNumber: 6674, headSha: 'head-6674' }).held, true);
      const row = db.prepare('SELECT * FROM duplicate_family_candidates WHERE pr_number = 6674').get();
      assert.equal(row.pr_state, 'open');
    } finally { db.close(); }
  });
}


test('DUPTERM-01: discovery reopen wins over older reviewed terminal state', () => {
  const db = memoryDb();
  const options = { repoPath: REPO, readBuildCompletionSignalForPrImpl: provenanceReader({
    6674: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
    6680: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
  }) };
  try {
    reconcileDuplicateFamiliesForRepo(db, [subject(6674), subject(6680)], options);
    db.exec('CREATE TABLE reviewed_prs (repo TEXT, pr_number INTEGER, pr_state TEXT)');
    db.prepare('INSERT INTO reviewed_prs VALUES (?, ?, ?)').run(REPO, 6674, 'closed');
    reconcileDuplicateFamiliesForRepo(db, [subject(6674)], options);
    assert.equal(listDuplicateFamilies(db)[0].status, 'advisory');
    assert.equal(db.prepare('SELECT pr_state FROM duplicate_family_candidates WHERE pr_number = 6674').get().pr_state, 'open');
  } finally { db.close(); }
});

test('DUPTERM-01: unverified empty census preserves terminal reconciliation for a later healthy tick', async () => {
  const db = memoryDb();
  const options = { repoPath: REPO, readBuildCompletionSignalForPrImpl: provenanceReader({
    6674: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
    6680: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
  }) };
  try {
    reconcileDuplicateFamiliesForRepo(db, [subject(6674), subject(6680)], options);
    db.exec('CREATE TABLE reviewed_prs (repo TEXT, pr_number INTEGER, pr_state TEXT)');
    for (const n of [6674, 6680]) db.prepare('INSERT INTO reviewed_prs VALUES (?, ?, ?)').run(REPO, n, 'merged');
    const result = await runDuplicateFamilyCensusForWatcher({ db, subjectEntries: [], repoPath: REPO,
      env: { AGENT_OS_SESSION_LEDGER_DB_PATH: '/private/tmp/dupterm-nonexistent-ledger.db' },
      log: { log() {}, error() {} } });
    assert.match(result.error.message, /missing-ledger-target/);
    assert.equal(listDuplicateFamilies(db)[0].status, 'advisory');
    assert.deepEqual(db.prepare('SELECT pr_state FROM duplicate_family_candidates').all(),
      [{ pr_state: 'open' }, { pr_state: 'open' }]);
    const mutations = [];
    await reconcileDuplicateFamilyLabels({ db, repoPath: REPO, census: result,
      octokit: { rest: { issues: { addLabels: async (p) => mutations.push(p), removeLabel: async (p) => mutations.push(p) } } } });
    assert.deepEqual(mutations, []);
    reconcileDuplicateFamiliesForRepo(db, [], options);
    assert.equal(listDuplicateFamilies(db)[0].status, 'inactive');
  } finally { db.close(); }
});


test('DUPTERM-01: unreadable reviewed-state join fails the census without releasing cached holds', async () => {
  const db = memoryDb();
  const options = { repoPath: REPO, readBuildCompletionSignalForPrImpl: provenanceReader({
    6674: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
    6680: { ticket_id: 'DPA-01', spec_ref: 'spec@1' },
  }) };
  try {
    reconcileDuplicateFamiliesForRepo(db, [subject(6674), subject(6680)], options);
    // A malformed joined table models a real SQLite read failure, not a PR closure.
    db.exec('CREATE TABLE reviewed_prs (repo TEXT, pr_number INTEGER)');
    const result = await runDuplicateFamilyCensusForWatcher({ db, subjectEntries: [], repoPath: REPO,
      env: {}, log: { log() {}, error() {} } });
    assert.match(result.error.message, /no such column/);
    assert.equal(listDuplicateFamilies(db)[0].status, 'advisory');
    assert.equal(evaluateDuplicateFamilyCandidate(readDuplicateFamilyForPr(db, { repo: REPO, prNumber: 6674 }),
      { prNumber: 6674, headSha: 'head-6674' }).held, true);
    assert.deepEqual(db.prepare('SELECT pr_state FROM duplicate_family_candidates').all(),
      [{ pr_state: 'open' }, { pr_state: 'open' }]);
  } finally { db.close(); }
});
