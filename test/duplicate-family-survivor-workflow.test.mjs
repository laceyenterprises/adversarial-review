import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { evaluateDuplicateFamilyCandidate } from '../src/duplicate-family-gate.mjs';
import { verifyCommittedReport } from '../src/duplicate-family-workflow-cli.mjs';
import {
  abandonDuplicateFamily,
  ensureDuplicateFamilySchema,
  ignoreDuplicateFamilyCandidate,
  reconcileDuplicateFamilyCloseouts,
  selectDuplicateFamilySurvivor,
} from '../src/duplicate-family-state.mjs';

const REPO = 'laceyenterprises/agent-os';
const FAMILY = 'agent-os-main-dpa-04-2026-09-20';

function fixture() {
  const db = new Database(':memory:');
  ensureDuplicateFamilySchema(db);
  const now = '2026-09-20T12:00:00.000Z';
  db.prepare(
    `INSERT INTO duplicate_families (
       family_id, family_key, target_repo, base_branch, normalized_work_identity,
       status, strongest_signal, transition_log_json, candidate_count,
       first_detected_at, last_seen_at, updated_at
     ) VALUES (?, ?, ?, 'main', 'dpa-04', 'advisory', 'dispatch-ticket', '[]', 3, ?, ?, ?)`
  ).run(FAMILY, `${REPO}|main|dpa-04`, REPO, now, now, now);
  const insert = db.prepare(
    `INSERT INTO duplicate_family_candidates (
       family_id, repo, pr_number, title, pr_state, base_branch, head_branch,
       head_sha, base_sha, role, work_identity_json, signals_json,
       suppressions_json, labels_json, first_seen_at, last_seen_at, updated_at
     ) VALUES (?, ?, ?, ?, 'open', 'main', ?, ?, 'base', 'candidate', '{}', '[]', '[]', '[]', ?, ?, ?)`
  );
  for (const prNumber of [101, 102, 103]) {
    insert.run(FAMILY, REPO, prNumber, `DPA-04 ${prNumber}`, `branch-${prNumber}`, `head-${prNumber}`, now, now, now);
  }
  return db;
}

function familyFor(db, prNumber) {
  return db.prepare(
    `SELECT duplicate_families.*, duplicate_family_candidates.role AS candidate_role
       FROM duplicate_families JOIN duplicate_family_candidates USING (family_id)
      WHERE duplicate_families.family_id = ? AND duplicate_family_candidates.pr_number = ?`
  ).get(FAMILY, prNumber);
}

function select(db) {
  return selectDuplicateFamilySurvivor(db, {
    familyId: FAMILY,
    survivorPrNumber: 101,
    reportPath: 'docs/research/duplicate-pr-divergence/reports/2026-09-20-dpa-04.md',
    reportVerifiedHeadSha: 'head-101',
    actor: 'operator',
    reason: 'best ownership boundary',
    salvage: 'ported the narrow parser test from #102',
    validation: 'lint, full test, typecheck, walkthrough',
    now: '2026-09-20T12:05:00.000Z',
  });
}

test('exactly one selected survivor releases while every loser stays held', () => {
  const db = fixture();
  try {
    select(db);
    const survivor = evaluateDuplicateFamilyCandidate(familyFor(db, 101), { prNumber: 101, headSha: 'head-101' });
    const loser = evaluateDuplicateFamilyCandidate(familyFor(db, 102), { prNumber: 102, headSha: 'head-102' });
    assert.equal(survivor.held, false);
    assert.equal(survivor.release, 'survivor-selected');
    assert.equal(loser.held, true);
    assert.deepEqual(
      db.prepare('SELECT pr_number, role FROM duplicate_family_candidates ORDER BY pr_number').all(),
      [{ pr_number: 101, role: 'survivor' }, { pr_number: 102, role: 'loser' }, { pr_number: 103, role: 'loser' }],
    );
  } finally { db.close(); }
});

test('report enforcement rejects unverified paths and head movement invalidates selection', () => {
  const db = fixture();
  try {
    assert.throws(() => selectDuplicateFamilySurvivor(db, {
      familyId: FAMILY, survivorPrNumber: 101,
      reportPath: 'docs/research/duplicate-pr-divergence/reports/report.md',
      reportVerifiedHeadSha: 'wrong-head', actor: 'operator', reason: 'choice',
    }), /verification must be bound/);
    select(db);
    assert.equal(
      evaluateDuplicateFamilyCandidate(familyFor(db, 101), { prNumber: 101, headSha: 'head-101-moved' }).held,
      true,
    );
  } finally { db.close(); }
});

test('report verification reads the committed file at the exact survivor head', async () => {
  const calls = [];
  const execFileImpl = async (command, args) => {
    calls.push([command, args]);
    return { stdout: JSON.stringify({ type: 'file', sha: 'blob-sha' }) };
  };
  await verifyCommittedReport({
    repo: REPO,
    headSha: 'head-101',
    reportPath: 'docs/research/duplicate-pr-divergence/reports/report.md',
    execFileImpl,
  });
  assert.deepEqual(calls, [[
    'gh',
    ['api', 'repos/laceyenterprises/agent-os/contents/docs/research/duplicate-pr-divergence/reports/report.md?ref=head-101'],
  ]]);
  await assert.rejects(
    verifyCommittedReport({
      repo: REPO, headSha: 'head-101', reportPath: 'docs/research/duplicate-pr-divergence/reports/report.md',
      execFileImpl: async () => ({ stdout: JSON.stringify({ type: 'dir' }) }),
    }),
    /not a committed file/,
  );
});

test('current-head ignored-not-duplicate releases only that loser', () => {
  const db = fixture();
  try {
    select(db);
    ignoreDuplicateFamilyCandidate(db, {
      familyId: FAMILY, prNumber: 102, candidateHeadSha: 'head-102',
      actor: 'operator', reason: 'sequential follow-up',
    });
    assert.equal(evaluateDuplicateFamilyCandidate(familyFor(db, 102), { prNumber: 102, headSha: 'head-102' }).held, false);
    assert.equal(evaluateDuplicateFamilyCandidate(familyFor(db, 103), { prNumber: 103, headSha: 'head-103' }).held, true);
    assert.equal(evaluateDuplicateFamilyCandidate(familyFor(db, 102), { prNumber: 102, headSha: 'head-102-moved' }).held, true);
  } finally { db.close(); }
});

test('abandoned family blocks every candidate and records an auditable reason', () => {
  const db = fixture();
  try {
    abandonDuplicateFamily(db, { familyId: FAMILY, actor: 'operator', reason: 'no safe survivor' });
    const family = familyFor(db, 101);
    assert.equal(family.status, 'abandoned');
    assert.equal(evaluateDuplicateFamilyCandidate(family, { prNumber: 101, headSha: 'head-101' }).held, true);
    assert.equal(JSON.parse(family.transition_log_json).at(-1).reason, 'no safe survivor');
  } finally { db.close(); }
});

test('survivor merge closes losers with survivor and committed report links then resolves', async () => {
  const db = fixture();
  const comments = [];
  const closes = [];
  try {
    select(db);
    db.prepare("UPDATE duplicate_family_candidates SET pr_state = 'merged' WHERE pr_number = 101").run();
    const octokit = { rest: {
      issues: { createComment: async (input) => { comments.push(input); } },
      pulls: { update: async (input) => { closes.push(input); } },
    } };
    const result = await reconcileDuplicateFamilyCloseouts({ db, octokit, repoPath: REPO });
    assert.equal(result.closed, 2);
    assert.deepEqual(closes.map((entry) => entry.pull_number), [102, 103]);
    for (const comment of comments) {
      assert.match(comment.body, /https:\/\/github\.com\/laceyenterprises\/agent-os\/pull\/101/);
      assert.match(comment.body, /blob\/head-101\/docs\/research\/duplicate-pr-divergence\/reports\/2026-09-20-dpa-04\.md/);
    }
    const family = familyFor(db, 101);
    assert.equal(family.status, 'resolved');
    assert.deepEqual(JSON.parse(family.transition_log_json).slice(-2).map((entry) => entry.transition), ['survivor-merged', 'resolved']);
  } finally { db.close(); }
});
