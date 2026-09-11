import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  detectDuplicateFamiliesForRepo,
  duplicateFamilyCandidateRows,
  ensureDuplicateFamilySchema,
  listDuplicateFamilies,
  reconcileDuplicateFamiliesForRepo,
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
      headSha: overrides.headSha || `head-${prNumber}`,
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
    reconcileDuplicateFamiliesForRepo(db, [subject(451)], {
      ...options,
      now: '2026-09-11T00:05:00.000Z',
    });
    reconcileDuplicateFamiliesForRepo(db, [subject(451)], {
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
  } finally {
    db.close();
  }
});
