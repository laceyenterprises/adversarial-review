import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { main as backfillReviewBodiesMain } from '../scripts/backfill-review-bodies.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';

function makeRootDir() {
  return mkdtempSync(path.join(tmpdir(), 'adversarial-review-backfill-'));
}

function withDb(rootDir, fn) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    return fn(db);
  } finally {
    db.close();
  }
}

function seedReviewedPr(db, {
  repo = 'laceyenterprises/adversarial-review',
  prNumber,
  prState = 'merged',
  mergedAt = '2026-05-29T12:00:00.000Z',
}) {
  db.prepare(
    `INSERT INTO reviewed_prs (
       repo, pr_number, reviewed_at, reviewer, pr_state, merged_at, review_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(repo, prNumber, '2026-05-29T11:50:00.000Z', 'codex', prState, mergedAt, 'posted');
}

function seedReviewerPass(db, row) {
  db.prepare(
    `INSERT INTO reviewer_passes (
       repo, pr_number, attempt_number, reviewer_class, reviewer_model, pass_kind,
       started_at, ended_at, status, metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.repo ?? 'laceyenterprises/adversarial-review',
    row.prNumber,
    row.attemptNumber,
    row.reviewerClass,
    row.reviewerModel ?? row.reviewerClass,
    row.passKind,
    row.startedAt,
    row.endedAt,
    row.status,
    '{}'
  );
}

function jsonLines(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

function makeExecFileStub(fixtures) {
  const calls = [];
  async function execFileImpl(_cmd, args) {
    calls.push(args);
    const endpoint = args[2];
    if (!(endpoint in fixtures)) {
      throw new Error(`unexpected gh endpoint: ${endpoint}`);
    }
    return { stdout: fixtures[endpoint], stderr: '' };
  }
  execFileImpl.calls = calls;
  return execFileImpl;
}

async function runCli(rootDir, argv, deps = {}) {
  let stdout = '';
  let stderr = '';
  const code = await backfillReviewBodiesMain(
    ['--root-dir', rootDir, ...argv],
    {
      stdout: { write: (chunk) => { stdout += String(chunk); } },
      stderr: { write: (chunk) => { stderr += String(chunk); } },
    },
    deps
  );
  return { code, stdout, stderr };
}

function buildBodiesFixtureRoot() {
  const rootDir = makeRootDir();
  withDb(rootDir, (db) => {
    seedReviewedPr(db, { prNumber: 101 });
    seedReviewedPr(db, { prNumber: 102 });
    seedReviewedPr(db, { prNumber: 103 });
    seedReviewedPr(db, { prNumber: 104 });
    seedReviewedPr(db, { prNumber: 105 });

    seedReviewerPass(db, {
      prNumber: 101,
      attemptNumber: 1,
      reviewerClass: 'codex',
      passKind: 'first-pass',
      startedAt: '2026-05-29T10:00:00.000Z',
      endedAt: '2026-05-29T10:15:00.000Z',
      status: 'completed',
    });
    seedReviewerPass(db, {
      prNumber: 102,
      attemptNumber: 1,
      reviewerClass: 'claude',
      passKind: 'rereview',
      startedAt: '2026-05-29T10:20:00.000Z',
      endedAt: '2026-05-29T10:35:00.000Z',
      status: 'completed',
    });
    seedReviewerPass(db, {
      prNumber: 103,
      attemptNumber: 2,
      reviewerClass: 'codex',
      passKind: 'remediation',
      startedAt: '2026-05-29T10:40:00.000Z',
      endedAt: '2026-05-29T10:55:00.000Z',
      status: 'completed',
    });
    seedReviewerPass(db, {
      prNumber: 104,
      attemptNumber: 3,
      reviewerClass: 'claude',
      passKind: 'remediation',
      startedAt: '2026-05-03T10:40:00.000Z',
      endedAt: '2026-05-03T10:55:00.000Z',
      status: 'failed',
    });
    seedReviewerPass(db, {
      prNumber: 105,
      attemptNumber: 4,
      reviewerClass: 'codex',
      passKind: 'remediation',
      startedAt: '2026-05-29T11:00:00.000Z',
      endedAt: '2026-05-29T11:15:00.000Z',
      status: 'stopped',
    });
  });
  return rootDir;
}

function buildBodiesFixtures() {
  return {
    'repos/laceyenterprises/adversarial-review/pulls/101/reviews': jsonLines([
      {
        node_id: 'RV_101',
        submitted_at: '2026-05-29T10:10:00.000Z',
        state: 'CHANGES_REQUESTED',
        body: 'body 101',
        user: { login: 'codex-reviewer-lacey' },
      },
    ]),
    'repos/laceyenterprises/adversarial-review/issues/101/comments': '\n',
    'repos/laceyenterprises/adversarial-review/pulls/102/reviews': jsonLines([
      {
        node_id: 'RV_102',
        submitted_at: '2026-05-29T10:30:00.000Z',
        state: 'COMMENTED',
        body: 'body 102',
        user: { login: 'claude-reviewer-lacey' },
      },
    ]),
    'repos/laceyenterprises/adversarial-review/issues/102/comments': '\n',
    'repos/laceyenterprises/adversarial-review/pulls/103/reviews': '\n',
    'repos/laceyenterprises/adversarial-review/issues/103/comments': jsonLines([
      {
        node_id: 'IC_103',
        created_at: '2026-05-29T10:50:00.000Z',
        body: '<!-- adversarial-review-remediation-marker:job-103:r2:completed -->\nremediation 103',
        user: { login: 'codex-reviewer-lacey' },
      },
    ]),
    'repos/laceyenterprises/adversarial-review/pulls/104/reviews': '\n',
    'repos/laceyenterprises/adversarial-review/issues/104/comments': jsonLines([
      {
        node_id: 'IC_104',
        created_at: '2026-05-03T10:52:00.000Z',
        body: 'legacy remediation 104',
        user: { login: 'claude-reviewer-lacey' },
      },
    ]),
    'repos/laceyenterprises/adversarial-review/pulls/105/reviews': '\n',
    'repos/laceyenterprises/adversarial-review/issues/105/comments': jsonLines([
      {
        node_id: 'IC_105',
        created_at: '2026-05-29T11:10:00.000Z',
        body: 'missing marker 105',
        user: { login: 'codex-reviewer-lacey' },
      },
    ]),
  };
}

test('dry-run pass (A) logs four proposed updates, leaves DB untouched, and reports the unmatched row', async () => {
  const rootDir = buildBodiesFixtureRoot();
  const execFileImpl = makeExecFileStub(buildBodiesFixtures());

  const result = await runCli(rootDir, ['--dry-run', '--pass', 'bodies'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /matched pass_id=/);
  assert.match(result.stdout, /reason=legacy_login_window/);
  assert.match(result.stdout, /unmatched .*reason=marker_missing/);
  assert.match(result.stdout, /candidates considered:\s+5/);
  assert.match(result.stdout, /bodies populated:\s+4/);

  withDb(rootDir, (db) => {
    const rows = db.prepare('SELECT COUNT(*) AS count FROM reviewer_passes WHERE body_md IS NOT NULL').get();
    assert.equal(rows.count, 0);
  });
});

test('apply pass (A) populates four rows and leaves the marker-missing row NULL', async () => {
  const rootDir = buildBodiesFixtureRoot();
  const execFileImpl = makeExecFileStub(buildBodiesFixtures());

  const result = await runCli(rootDir, ['--apply', '--pass', 'bodies'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /unmatched .*reason=marker_missing/);

  withDb(rootDir, (db) => {
    const rows = db.prepare(
      'SELECT pr_number, verdict, body_md, gh_comment_id, body_captured_at FROM reviewer_passes ORDER BY pr_number'
    ).all();
    assert.equal(rows.filter((row) => row.body_md !== null).length, 4);
    assert.equal(rows.find((row) => row.pr_number === 101).verdict, 'request-changes');
    assert.equal(rows.find((row) => row.pr_number === 102).verdict, 'comment-only');
    assert.equal(rows.find((row) => row.pr_number === 103).verdict, null);
    assert.equal(rows.find((row) => row.pr_number === 105).body_md, null);
  });
});

test('remediation terminal statuses completed, stopped, and failed are all eligible for body capture', async () => {
  const rootDir = makeRootDir();
  withDb(rootDir, (db) => {
    for (const [prNumber, status] of [[201, 'completed'], [202, 'stopped'], [203, 'failed']]) {
      seedReviewedPr(db, { prNumber });
      seedReviewerPass(db, {
        prNumber,
        attemptNumber: 1,
        reviewerClass: 'codex',
        passKind: 'remediation',
        startedAt: '2026-05-29T10:00:00.000Z',
        endedAt: '2026-05-29T10:05:00.000Z',
        status,
      });
    }
  });
  const execFileImpl = makeExecFileStub({
    'repos/laceyenterprises/adversarial-review/pulls/201/reviews': '\n',
    'repos/laceyenterprises/adversarial-review/pulls/202/reviews': '\n',
    'repos/laceyenterprises/adversarial-review/pulls/203/reviews': '\n',
    'repos/laceyenterprises/adversarial-review/issues/201/comments': jsonLines([{ node_id: 'IC_201', created_at: '2026-05-29T10:02:00.000Z', body: '<!-- adversarial-review-remediation-marker:a -->\n201', user: { login: 'codex-reviewer-lacey' } }]),
    'repos/laceyenterprises/adversarial-review/issues/202/comments': jsonLines([{ node_id: 'IC_202', created_at: '2026-05-29T10:02:00.000Z', body: '<!-- adversarial-review-remediation-marker:b -->\n202', user: { login: 'codex-reviewer-lacey' } }]),
    'repos/laceyenterprises/adversarial-review/issues/203/comments': jsonLines([{ node_id: 'IC_203', created_at: '2026-05-29T10:02:00.000Z', body: '<!-- adversarial-review-remediation-marker:c -->\n203', user: { login: 'codex-reviewer-lacey' } }]),
  });

  await runCli(rootDir, ['--apply', '--pass', 'bodies'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });

  withDb(rootDir, (db) => {
    const count = db.prepare('SELECT COUNT(*) AS count FROM reviewer_passes WHERE body_md IS NOT NULL').get();
    assert.equal(count.count, 3);
  });
});

test('reviewer-bot remediation author selection does not rely on imagined worker logins', async () => {
  const rootDir = makeRootDir();
  withDb(rootDir, (db) => {
    seedReviewedPr(db, { prNumber: 301 });
    seedReviewerPass(db, {
      prNumber: 301,
      attemptNumber: 1,
      reviewerClass: 'claude',
      passKind: 'remediation',
      startedAt: '2026-05-29T10:00:00.000Z',
      endedAt: '2026-05-29T10:05:00.000Z',
      status: 'completed',
    });
  });
  const execFileImpl = makeExecFileStub({
    'repos/laceyenterprises/adversarial-review/pulls/301/reviews': '\n',
    'repos/laceyenterprises/adversarial-review/issues/301/comments': jsonLines([
      { node_id: 'IC_worker', created_at: '2026-05-29T10:01:00.000Z', body: '<!-- adversarial-review-remediation-marker:x -->\nworker', user: { login: 'claude-worker-lacey' } },
      { node_id: 'IC_bot', created_at: '2026-05-29T10:02:00.000Z', body: '<!-- adversarial-review-remediation-marker:y -->\nbot', user: { login: 'claude-reviewer-lacey' } },
    ]),
  });

  await runCli(rootDir, ['--apply', '--pass', 'bodies'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });

  withDb(rootDir, (db) => {
    const row = db.prepare('SELECT body_md, gh_comment_id FROM reviewer_passes WHERE pr_number = 301').get();
    assert.equal(row.body_md, '<!-- adversarial-review-remediation-marker:y -->\nbot');
    assert.equal(row.gh_comment_id, 'IC_bot');
  });
});

test('multiple candidates and clock skew remain unmatched deterministically', async () => {
  const rootDir = makeRootDir();
  withDb(rootDir, (db) => {
    seedReviewedPr(db, { prNumber: 401 });
    seedReviewerPass(db, {
      prNumber: 401,
      attemptNumber: 1,
      reviewerClass: 'codex',
      passKind: 'first-pass',
      startedAt: '2026-05-29T09:00:00.000Z',
      endedAt: '2026-05-29T09:10:00.000Z',
      status: 'completed',
    });
    seedReviewedPr(db, { prNumber: 402 });
    seedReviewerPass(db, {
      prNumber: 402,
      attemptNumber: 1,
      reviewerClass: 'codex',
      passKind: 'first-pass',
      startedAt: '2026-05-29T09:00:00.000Z',
      endedAt: '2026-05-29T09:10:00.000Z',
      status: 'completed',
    });
  });
  const execFileImpl = makeExecFileStub({
    'repos/laceyenterprises/adversarial-review/pulls/401/reviews': jsonLines([
      { node_id: 'RV_1', submitted_at: '2026-05-29T09:05:00.000Z', state: 'COMMENTED', body: 'a', user: { login: 'codex-reviewer-lacey' } },
      { node_id: 'RV_2', submitted_at: '2026-05-29T09:06:00.000Z', state: 'COMMENTED', body: 'b', user: { login: 'codex-reviewer-lacey' } },
      { node_id: 'RV_3', submitted_at: '2026-05-29T09:07:00.000Z', state: 'COMMENTED', body: 'c', user: { login: 'codex-reviewer-lacey' } },
    ]),
    'repos/laceyenterprises/adversarial-review/issues/401/comments': '\n',
    'repos/laceyenterprises/adversarial-review/pulls/402/reviews': jsonLines([
      { node_id: 'RV_skew', submitted_at: '2026-05-29T09:15:30.000Z', state: 'COMMENTED', body: 'skew', user: { login: 'codex-reviewer-lacey' } },
    ]),
    'repos/laceyenterprises/adversarial-review/issues/402/comments': '\n',
  });

  const result = await runCli(rootDir, ['--dry-run', '--pass', 'bodies'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });

  assert.match(result.stdout, /reason=multiple_candidates/);
  assert.match(result.stdout, /reason=no_artifact_in_window/);
});

test('remediation marker disambiguation selects the single marked comment in-window', async () => {
  const rootDir = makeRootDir();
  withDb(rootDir, (db) => {
    seedReviewedPr(db, { prNumber: 501 });
    seedReviewerPass(db, {
      prNumber: 501,
      attemptNumber: 1,
      reviewerClass: 'codex',
      passKind: 'remediation',
      startedAt: '2026-05-29T09:00:00.000Z',
      endedAt: '2026-05-29T09:10:00.000Z',
      status: 'completed',
    });
  });
  const execFileImpl = makeExecFileStub({
    'repos/laceyenterprises/adversarial-review/pulls/501/reviews': '\n',
    'repos/laceyenterprises/adversarial-review/issues/501/comments': jsonLines([
      { node_id: 'IC_unmarked', created_at: '2026-05-29T09:05:00.000Z', body: 'plain', user: { login: 'codex-reviewer-lacey' } },
      { node_id: 'IC_marked', created_at: '2026-05-29T09:06:00.000Z', body: '<!-- adversarial-review-remediation-marker:z -->\nmarked', user: { login: 'codex-reviewer-lacey' } },
    ]),
  });

  await runCli(rootDir, ['--apply', '--pass', 'bodies'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });

  withDb(rootDir, (db) => {
    const row = db.prepare('SELECT gh_comment_id FROM reviewer_passes WHERE pr_number = 501').get();
    assert.equal(row.gh_comment_id, 'IC_marked');
  });
});

test('idempotency keeps captured body timestamps stable on a second apply run', async () => {
  const rootDir = buildBodiesFixtureRoot();
  const fixtures = buildBodiesFixtures();
  const execFileImpl = makeExecFileStub(fixtures);

  await runCli(rootDir, ['--apply', '--pass', 'bodies'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });
  const firstCapturedAt = withDb(rootDir, (db) => (
    db.prepare('SELECT body_captured_at FROM reviewer_passes WHERE pr_number = 101').get().body_captured_at
  ));

  const second = await runCli(rootDir, ['--apply', '--pass', 'bodies'], {
    execFileImpl,
    now: () => '2026-05-29T13:30:00.000Z',
  });

  assert.match(second.stdout, /candidates considered:\s+1/);
  assert.match(second.stdout, /bodies populated:\s+0/);
  assert.match(second.stdout, /unmatched:\s+1/);
  const secondCapturedAt = withDb(rootDir, (db) => (
    db.prepare('SELECT body_captured_at FROM reviewer_passes WHERE pr_number = 101').get().body_captured_at
  ));
  assert.equal(secondCapturedAt, firstCapturedAt);
});

function buildCloseoutFixtureRoot() {
  const rootDir = makeRootDir();
  withDb(rootDir, (db) => {
    seedReviewedPr(db, { prNumber: 601, mergedAt: '2026-05-29T12:00:00.000Z' });
    seedReviewedPr(db, { prNumber: 602, mergedAt: '2026-05-29T12:01:00.000Z' });
    seedReviewedPr(db, { prNumber: 603, mergedAt: '2026-05-29T12:02:00.000Z' });
  });
  return rootDir;
}

function buildCloseoutFixtures() {
  return {
    'repos/laceyenterprises/adversarial-review/issues/601/comments': jsonLines([
      { node_id: 'CO_601', created_at: '2026-05-29T12:05:00.000Z', body: '<!-- hq:closeout:pr -->\ncloseout 601', user: { login: 'alice' } },
    ]),
    'repos/laceyenterprises/adversarial-review/issues/602/comments': jsonLines([
      { node_id: 'CO_602', created_at: '2026-05-29T12:06:00.000Z', body: '<!-- hq:closeout:pr -->\ncloseout 602', user: { login: 'bob' } },
    ]),
    'repos/laceyenterprises/adversarial-review/issues/603/comments': jsonLines([
      { node_id: 'CO_603', created_at: '2026-05-29T12:07:00.000Z', body: '<!-- hq:closeout:pr -->\ncloseout 603', user: { login: 'carol' } },
    ]),
  };
}

test('dry-run pass (B) logs proposed closeout upserts and leaves pr_merge_closeouts untouched', async () => {
  const rootDir = buildCloseoutFixtureRoot();
  const execFileImpl = makeExecFileStub(buildCloseoutFixtures());
  const result = await runCli(rootDir, ['--dry-run', '--pass', 'closeouts'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /closeout repo=.* outcome=body_captured/g);
  assert.match(result.stdout, /merged PRs scanned:\s+3/);
  withDb(rootDir, (db) => {
    const count = db.prepare('SELECT COUNT(*) AS count FROM pr_merge_closeouts').get();
    assert.equal(count.count, 0);
  });
});

test('apply pass (B) inserts closeout rows, respects settling policy, and does not erase populated bodies on rerun', async () => {
  const rootDir = buildCloseoutFixtureRoot();
  const execFileImpl = makeExecFileStub(buildCloseoutFixtures());

  await runCli(rootDir, ['--apply', '--pass', 'closeouts'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });
  withDb(rootDir, (db) => {
    const count = db.prepare('SELECT COUNT(*) AS count FROM pr_merge_closeouts WHERE closeout_body_md IS NOT NULL').get();
    assert.equal(count.count, 3);
  });

  withDb(rootDir, (db) => {
    seedReviewedPr(db, { prNumber: 604, mergedAt: '2026-05-29T12:25:00.000Z' });
  });
  const settlingExec = makeExecFileStub({
    ...buildCloseoutFixtures(),
    'repos/laceyenterprises/adversarial-review/issues/604/comments': '\n',
  });
  await runCli(rootDir, ['--apply', '--pass', 'closeouts'], {
    execFileImpl: settlingExec,
    now: () => '2026-05-29T12:29:00.000Z',
  });
  withDb(rootDir, (db) => {
    const row = db.prepare('SELECT empty_confirmed_at FROM pr_merge_closeouts WHERE pr_number = 604').get();
    assert.equal(row.empty_confirmed_at, null);
  });
  await runCli(rootDir, ['--apply', '--pass', 'closeouts'], {
    execFileImpl: settlingExec,
    now: () => '2026-05-29T12:36:00.000Z',
  });
  withDb(rootDir, (db) => {
    const row = db.prepare('SELECT empty_confirmed_at FROM pr_merge_closeouts WHERE pr_number = 604').get();
    assert.equal(row.empty_confirmed_at, '2026-05-29T12:36:00.000Z');
  });

  withDb(rootDir, (db) => {
    seedReviewedPr(db, { prNumber: 605, mergedAt: '2026-05-29T12:00:00.000Z' });
    db.prepare(
      `INSERT INTO pr_merge_closeouts (
         repo, pr_number, closeout_body_md, closeout_authors_json, closeout_posted_at, body_captured_at,
         scrape_last_checked_at, empty_confirmed_at, merged_at, gh_artifact_refs
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'laceyenterprises/adversarial-review',
      605,
      'kept body',
      '["alice"]',
      '2026-05-29T12:05:00.000Z',
      '2026-05-29T12:05:30.000Z',
      '2026-05-29T12:06:00.000Z',
      null,
      '2026-05-29T12:00:00.000Z',
      '[{"kind":"comment","id":"CO_keep"}]'
    );
  });
  const rerun = await runCli(rootDir, ['--apply', '--pass', 'closeouts'], {
    execFileImpl: settlingExec,
    now: () => '2026-05-29T12:40:00.000Z',
  });
  assert.match(rerun.stdout, /merged PRs scanned:\s+0/);
  withDb(rootDir, (db) => {
    const row = db.prepare('SELECT closeout_body_md, gh_artifact_refs FROM pr_merge_closeouts WHERE pr_number = 605').get();
    assert.equal(row.closeout_body_md, 'kept body');
    assert.equal(row.gh_artifact_refs, '[{"kind":"comment","id":"CO_keep"}]');
  });
});

test('--pass independence and coverage summary correctness', async () => {
  const rootDir = buildBodiesFixtureRoot();
  const execFileImpl = makeExecFileStub({
    ...buildBodiesFixtures(),
    'repos/laceyenterprises/adversarial-review/issues/601/comments': jsonLines([
      { node_id: 'CO_601', created_at: '2026-05-29T12:05:00.000Z', body: '<!-- hq:closeout:pr -->\ncloseout 601', user: { login: 'alice' } },
    ]),
  });
  const bodiesOnly = await runCli(rootDir, ['--dry-run', '--pass', 'bodies'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });
  assert.match(bodiesOnly.stdout, /merged PRs scanned:\s+0/);
  withDb(rootDir, (db) => {
    const count = db.prepare('SELECT COUNT(*) AS count FROM pr_merge_closeouts').get();
    assert.equal(count.count, 0);
  });

  const closeoutRoot = buildCloseoutFixtureRoot();
  const closeoutsOnly = await runCli(closeoutRoot, ['--dry-run', '--pass', 'closeouts'], {
    execFileImpl: makeExecFileStub(buildCloseoutFixtures()),
    now: () => '2026-05-29T12:30:00.000Z',
  });
  assert.match(closeoutsOnly.stdout, /candidates considered:\s+0/);
  assert.match(closeoutsOnly.stdout, /merged PRs scanned:\s+3/);
});

test('body-pass gh fetch error charges the group as unmatched and keeps the run alive', async () => {
  const rootDir = makeRootDir();
  withDb(rootDir, (db) => {
    seedReviewedPr(db, { prNumber: 701 });
    seedReviewerPass(db, {
      prNumber: 701,
      attemptNumber: 1,
      reviewerClass: 'codex',
      passKind: 'first-pass',
      startedAt: '2026-05-29T10:00:00.000Z',
      endedAt: '2026-05-29T10:10:00.000Z',
      status: 'completed',
    });
    seedReviewedPr(db, { prNumber: 702 });
    seedReviewerPass(db, {
      prNumber: 702,
      attemptNumber: 1,
      reviewerClass: 'codex',
      passKind: 'first-pass',
      startedAt: '2026-05-29T10:30:00.000Z',
      endedAt: '2026-05-29T10:40:00.000Z',
      status: 'completed',
    });
  });
  // First group raises a transient gh error; second group must still complete.
  const execFileImpl = async (_cmd, args) => {
    const endpoint = args[2];
    if (endpoint === 'repos/laceyenterprises/adversarial-review/pulls/701/reviews') {
      const err = new Error('gh request timed out');
      err.code = 'ETIMEDOUT';
      throw err;
    }
    if (endpoint === 'repos/laceyenterprises/adversarial-review/pulls/702/reviews') {
      return {
        stdout: jsonLines([
          {
            node_id: 'RV_702',
            submitted_at: '2026-05-29T10:35:00.000Z',
            state: 'COMMENTED',
            body: 'body 702',
            user: { login: 'codex-reviewer-lacey' },
          },
        ]),
        stderr: '',
      };
    }
    if (endpoint.endsWith('/issues/702/comments')) {
      return { stdout: '\n', stderr: '' };
    }
    throw new Error(`unexpected gh endpoint: ${endpoint}`);
  };

  const result = await runCli(rootDir, ['--apply', '--pass', 'bodies'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /unmatched .*pr=701 .*reason=gh_fetch_error/);
  assert.match(result.stdout, /bodies populated:\s+1/);
  assert.match(result.stdout, /gh_fetch_error:\s+1/);

  withDb(rootDir, (db) => {
    const populated = db.prepare(
      'SELECT pr_number FROM reviewer_passes WHERE body_md IS NOT NULL ORDER BY pr_number'
    ).all();
    assert.deepEqual(populated.map((row) => row.pr_number), [702]);
  });
});

test('overlapping same-reviewer passes do not crash on the gh_comment_id UNIQUE index', async () => {
  const rootDir = makeRootDir();
  withDb(rootDir, (db) => {
    seedReviewedPr(db, { prNumber: 801 });
    // Two passes by the same reviewer with windows overlapping inside the 5min grace.
    // First pass: 10:00 - 10:10 (grace -> 10:15)
    // Second pass: 10:14 - 10:20 (grace -> 10:25)
    // Single review artifact submitted at 10:14:30 sits in both windows.
    seedReviewerPass(db, {
      prNumber: 801,
      attemptNumber: 1,
      reviewerClass: 'codex',
      passKind: 'first-pass',
      startedAt: '2026-05-29T10:00:00.000Z',
      endedAt: '2026-05-29T10:10:00.000Z',
      status: 'completed',
    });
    seedReviewerPass(db, {
      prNumber: 801,
      attemptNumber: 2,
      reviewerClass: 'codex',
      passKind: 'rereview',
      startedAt: '2026-05-29T10:14:00.000Z',
      endedAt: '2026-05-29T10:20:00.000Z',
      status: 'completed',
    });
  });
  const execFileImpl = makeExecFileStub({
    'repos/laceyenterprises/adversarial-review/pulls/801/reviews': jsonLines([
      {
        node_id: 'RV_801_shared',
        submitted_at: '2026-05-29T10:14:30.000Z',
        state: 'COMMENTED',
        body: 'shared artifact',
        user: { login: 'codex-reviewer-lacey' },
      },
    ]),
    'repos/laceyenterprises/adversarial-review/issues/801/comments': '\n',
  });

  const result = await runCli(rootDir, ['--apply', '--pass', 'bodies'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /reason=duplicate_artifact_claim/);
  assert.match(result.stdout, /duplicate_artifact_claim:\s+1/);

  withDb(rootDir, (db) => {
    const populated = db.prepare(
      'SELECT COUNT(*) AS count FROM reviewer_passes WHERE pr_number = 801 AND gh_comment_id IS NOT NULL'
    ).get();
    assert.equal(populated.count, 1);
  });
});

test('DISMISSED review state captures verdict=dismissed instead of failing the CHECK constraint', async () => {
  // Branch protection's "Dismiss stale pull request approvals when new commits
  // are pushed" auto-dismisses prior reviewer-bot reviews. The DB column
  // accepts 'dismissed' (per the 20260529 migration); the backfill must
  // populate the body rather than dropping the row as an
  // apply_constraint_violation.
  const rootDir = makeRootDir();
  withDb(rootDir, (db) => {
    seedReviewedPr(db, { prNumber: 1101 });
    seedReviewerPass(db, {
      prNumber: 1101,
      attemptNumber: 1,
      reviewerClass: 'claude',
      passKind: 'first-pass',
      startedAt: '2026-05-29T10:00:00.000Z',
      endedAt: '2026-05-29T10:10:00.000Z',
      status: 'completed',
    });
  });
  const execFileImpl = makeExecFileStub({
    'repos/laceyenterprises/adversarial-review/pulls/1101/reviews': jsonLines([
      {
        node_id: 'RV_dismissed',
        submitted_at: '2026-05-29T10:05:00.000Z',
        state: 'DISMISSED',
        body: 'dismissed body',
        user: { login: 'claude-reviewer-lacey' },
      },
    ]),
    'repos/laceyenterprises/adversarial-review/issues/1101/comments': '\n',
  });

  const result = await runCli(rootDir, ['--apply', '--pass', 'bodies'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });

  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /apply_constraint_violation/);
  assert.doesNotMatch(result.stdout, /would_violate_verdict_check/);
  assert.match(result.stdout, /bodies populated:\s+1/);

  withDb(rootDir, (db) => {
    const row = db.prepare(
      'SELECT verdict, body_md, gh_comment_id FROM reviewer_passes WHERE pr_number = 1101'
    ).get();
    assert.equal(row.verdict, 'dismissed');
    assert.equal(row.body_md, 'dismissed body');
    assert.equal(row.gh_comment_id, 'RV_dismissed');
  });
});

test('unrecognized GH review state falls back to verdict=null so the body is still captured', async () => {
  // Unknown future GH review states map to a null verdict (which the
  // migration's CHECK allows) instead of silently dropping the row. Dry-run
  // reports the same outcome apply would, so the populated count stays
  // honest.
  const rootDir = makeRootDir();
  withDb(rootDir, (db) => {
    seedReviewedPr(db, { prNumber: 1102 });
    seedReviewerPass(db, {
      prNumber: 1102,
      attemptNumber: 1,
      reviewerClass: 'claude',
      passKind: 'first-pass',
      startedAt: '2026-05-29T10:00:00.000Z',
      endedAt: '2026-05-29T10:10:00.000Z',
      status: 'completed',
    });
  });
  const execFileImpl = makeExecFileStub({
    'repos/laceyenterprises/adversarial-review/pulls/1102/reviews': jsonLines([
      {
        node_id: 'RV_future',
        submitted_at: '2026-05-29T10:05:00.000Z',
        state: 'PENDING',
        body: 'future state body',
        user: { login: 'claude-reviewer-lacey' },
      },
    ]),
    'repos/laceyenterprises/adversarial-review/issues/1102/comments': '\n',
  });

  const result = await runCli(rootDir, ['--apply', '--pass', 'bodies'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });

  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stdout, /apply_constraint_violation/);
  assert.match(result.stdout, /bodies populated:\s+1/);

  withDb(rootDir, (db) => {
    const row = db.prepare(
      'SELECT verdict, body_md FROM reviewer_passes WHERE pr_number = 1102'
    ).get();
    assert.equal(row.verdict, null);
    assert.equal(row.body_md, 'future state body');
  });
});

test('--limit rejects 0 with a clear error', async () => {
  const rootDir = makeRootDir();
  const execFileImpl = makeExecFileStub({});
  const result = await runCli(rootDir, ['--dry-run', '--pass', 'bodies', '--limit', '0'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });
  assert.equal(result.code, 2);
  assert.match(result.stderr, /invalid --limit value: 0/);
});

test('closeout multi-author collection writes a deduped array, last marked body wins', async () => {
  const rootDir = makeRootDir();
  withDb(rootDir, (db) => {
    seedReviewedPr(db, { prNumber: 901, mergedAt: '2026-05-29T12:00:00.000Z' });
  });
  const execFileImpl = makeExecFileStub({
    'repos/laceyenterprises/adversarial-review/issues/901/comments': jsonLines([
      { node_id: 'CO_a', created_at: '2026-05-29T12:01:00.000Z', body: '<!-- hq:closeout:pr -->\nfirst', user: { login: 'alice' } },
      { node_id: 'CO_b', created_at: '2026-05-29T12:02:00.000Z', body: '<!-- hq:closeout:pr -->\nsecond', user: { login: 'bob' } },
      { node_id: 'CO_c', created_at: '2026-05-29T12:03:00.000Z', body: '<!-- hq:closeout:pr -->\nfinal', user: { login: 'alice' } },
    ]),
  });

  await runCli(rootDir, ['--apply', '--pass', 'closeouts'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });

  withDb(rootDir, (db) => {
    const row = db.prepare(
      'SELECT closeout_body_md, closeout_authors_json, gh_artifact_refs FROM pr_merge_closeouts WHERE pr_number = 901'
    ).get();
    assert.equal(row.closeout_body_md, 'final');
    assert.deepEqual(JSON.parse(row.closeout_authors_json), ['alice', 'bob']);
    const refs = JSON.parse(row.gh_artifact_refs);
    assert.equal(refs.length, 3);
    assert.deepEqual(refs.map((ref) => ref.id), ['CO_a', 'CO_b', 'CO_c']);
  });
});

test('closeout summary splits body captured, empty confirmed, and empty retryable', async () => {
  const rootDir = makeRootDir();
  withDb(rootDir, (db) => {
    seedReviewedPr(db, { prNumber: 1001, mergedAt: '2026-05-29T12:00:00.000Z' });
    seedReviewedPr(db, { prNumber: 1002, mergedAt: '2026-05-29T11:00:00.000Z' });
    seedReviewedPr(db, { prNumber: 1003, mergedAt: '2026-05-29T12:25:00.000Z' });
  });
  const execFileImpl = makeExecFileStub({
    'repos/laceyenterprises/adversarial-review/issues/1001/comments': jsonLines([
      { node_id: 'CO_1001', created_at: '2026-05-29T12:05:00.000Z', body: '<!-- hq:closeout:pr -->\nbody', user: { login: 'alice' } },
    ]),
    'repos/laceyenterprises/adversarial-review/issues/1002/comments': '\n',
    'repos/laceyenterprises/adversarial-review/issues/1003/comments': '\n',
  });

  const result = await runCli(rootDir, ['--dry-run', '--pass', 'closeouts'], {
    execFileImpl,
    now: () => '2026-05-29T12:30:00.000Z',
  });

  assert.match(result.stdout, /body captured:\s+1/);
  assert.match(result.stdout, /empty confirmed:\s+1/);
  assert.match(result.stdout, /empty retryable:\s+1/);
  // advanced reports bodyCaptured + emptyConfirmed only — the retryable
  // closeout no longer inflates the "advanced" counter.
  assert.match(result.stdout, /closeout rows advanced:\s+2\s+\(66\.7%\)/);
});
