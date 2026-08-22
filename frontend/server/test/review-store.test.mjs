import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MODE_IN_OS, MODE_STANDALONE, loadConfig } from '../src/config.mjs';
import { ReviewStore, openReviewStore } from '../src/store/review-store.mjs';
import { STANDALONE_SCHEMA_SQL } from '../src/store/schema.mjs';
import {
  ArfStoreError, openReadOnly, openWritableStandalone, storeAccess,
} from '../src/store/sqlite.mjs';
import { FIXTURE_PATH } from './fixtures/build-reviews-fixture.mjs';

const REPO = 'laceyenterprises/agent-os';

function tmpDir(prefix = 'arf-store-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A store over a copy of the committed fixture, in read-only in-os mode. */
function fixtureStore() {
  const dir = tmpDir('arf-fixture-');
  const path = join(dir, 'reviews.db');
  copyFileSync(FIXTURE_PATH, path);
  const config = loadConfig({
    env: { ARF_STATE_ROOT: dir, ARF_MODE: MODE_IN_OS, ARF_STORE_PATH: path },
  });
  return { store: new ReviewStore(config), path, dir };
}

function storeAt(path, { mode = MODE_IN_OS } = {}) {
  const config = loadConfig({
    env: { ARF_STATE_ROOT: tmpDir(), ARF_MODE: mode, ARF_STORE_PATH: path },
  });
  return new ReviewStore(config);
}

describe('ReviewStore against a live-shaped reviews.db fixture', () => {
  it('reports the store as available and read-only', () => {
    const { store, path } = fixtureStore();
    const described = store.describe();
    assert.equal(described.available, true);
    assert.equal(described.readOnly, true);
    assert.equal(described.ownsStore, false);
    assert.equal(described.path, path);
    assert.equal(described.reason, null);
  });

  it('lists open PRs and excludes merged ones', () => {
    const { store } = fixtureStore();
    const { pullRequests } = store.pullRequests();
    assert.deepEqual(pullRequests.map((pr) => pr.pr), [5543, 5539]);
    assert.equal(pullRequests.every((pr) => pr.repo === REPO), true);
  });

  it('lists merged/closed PRs under state=closed and everything under state=all', () => {
    const { store } = fixtureStore();
    assert.deepEqual(store.pullRequests({ state: 'closed' }).pullRequests.map((pr) => pr.pr), [5541]);
    assert.deepEqual(store.pullRequests({ state: 'all' }).pullRequests.map((pr) => pr.pr), [5543, 5541, 5539]);
  });

  it('carries the latest pass verdict and both heads on the list row', () => {
    const { store } = fixtureStore();
    const [pr] = store.pullRequests().pullRequests;
    assert.equal(pr.pr, 5543);
    // Latest pass is round 2, still in progress: no verdict yet, new head.
    assert.equal(pr.latestVerdict, null);
    assert.equal(pr.reviewer, 'claude-code');
    assert.equal(pr.latestRound, 2);
    assert.equal(pr.headShaShort, 'aaaaaaa');
    assert.equal(pr.verdictHeadShaShort, 'ccccccc');
    // The PR head and the head the latest pass ran on differ — the drill-in must
    // be able to say "this verdict is not on the current head".
    assert.equal(pr.verdictOnCurrentHead, false);
    assert.deepEqual(pr.labels, ['adversarial-review', 'agent-built']);
    assert.equal(pr.terminal, false);
  });

  it('marks a merged PR terminal', () => {
    const { store } = fixtureStore();
    const [pr] = store.pullRequests({ state: 'closed' }).pullRequests;
    assert.equal(pr.pr, 5541);
    assert.equal(pr.terminal, true);
    assert.equal(pr.mergedAt, '2026-08-15T11:30:00Z');
  });

  it('projects rounds, passes, and findings for one PR', () => {
    const { store } = fixtureStore();
    const detail = store.pullRequest({ repo: REPO, prNumber: 5543 });

    assert.equal(detail.pullRequest.pr, 5543);
    assert.equal(detail.passes.length, 3);
    assert.deepEqual(detail.rounds.map((round) => round.round), [1, 2]);

    const [round1, round2] = detail.rounds;
    assert.equal(round1.passes.length, 2, 'a round can hold several passes');
    // The round's verdict, findings, and counts all come from its LAST pass.
    // Round 1's first pass raised 2 blocking findings; the rereview that
    // followed it cleared them and returned comment-only. Carrying those 2
    // forward would have the round claim comment-only AND 2 blocking findings
    // at the same time — the superseded pass answering for the round.
    assert.equal(round1.verdict, 'comment-only');
    assert.equal(round1.blockingCount, 0);
    assert.equal(round1.nonBlockingCount, 1);
    assert.deepEqual(
      round1.findings.map((finding) => finding.title),
      ['Findings parser duplicates the pipeline grammar'],
      'only the surviving pass\'s findings belong to the round',
    );
    assert.equal(round1.findings.every((finding) => finding.passKind === 'rereview'), true);
    // Every pass is still reachable; superseded findings are not lost, just not
    // attributed to the round.
    assert.equal(round1.passes[0].blockingCount, 2);
    assert.equal(round1.passes[0].findings.length, 3);

    // Round 2's only pass is still running with no body yet. Unknown is not
    // zero: a 0 here would read as "the reviewer found nothing".
    assert.equal(round2.passes.length, 1);
    assert.equal(round2.verdict, null);
    assert.equal(round2.blockingCount, null);
    assert.equal(round2.nonBlockingCount, null);
    assert.deepEqual(round2.findings, []);
  });

  it('orders the PR list by most recent review activity, not by PR number', () => {
    const { store } = fixtureStore();
    // PR numbers are repository-local, so the list orders on activity. Here the
    // two happen to agree; the cross-repo case below is where it matters.
    assert.deepEqual(
      store.pullRequests({ state: 'all' }).pullRequests.map((pr) => pr.lastAttemptedAt),
      ['2026-08-16T12:00:00Z', '2026-08-15T10:00:00Z', '2026-08-14T08:05:00Z'],
    );
  });

  it('parses finding rows out of the pass body with their linkage intact', () => {
    const { store } = fixtureStore();
    const { findings } = store.findings({ repo: REPO, prNumber: 5543 });
    assert.equal(findings.length, 4);

    const blocking = findings.filter((finding) => finding.kind === 'blocking');
    assert.equal(blocking.length, 2);
    const [first] = blocking;
    assert.equal(first.title, 'Store adapter opens a writable handle in in-os mode');
    assert.equal(first.category, 'correctness');
    assert.equal(first.file, 'frontend/server/src/store/sqlite.mjs');
    assert.equal(first.lines, '40-52');
    assert.match(first.problem, /single-writer reviews\.db can\ncorrupt pipeline state/);
    assert.equal(first.recommendedFix, 'Derive readOnly from the mode.');
    // Linkage back to the pass/round/comment the finding came from.
    assert.equal(first.repo, REPO);
    assert.equal(first.pr, 5543);
    assert.equal(first.round, 1);
    assert.equal(first.passKind, 'review');
    assert.equal(first.reviewerClass, 'codex');
    assert.equal(first.ghCommentId, '900001');
    assert.equal(new Set(findings.map((finding) => finding.findingId)).size, findings.length);
  });

  it('distinguishes an explicit "None." from an off-template body', () => {
    const { store } = fixtureStore();
    const detail = store.pullRequest({ repo: REPO, prNumber: 5541 });
    const approved = detail.passes.find((pass) => pass.passKind === 'review');
    const closeout = detail.passes.find((pass) => pass.passKind === 'closeout');

    // "- None." is a reviewer saying zero.
    assert.equal(approved.blockingCount, 0);
    assert.equal(approved.nonBlockingCount, 0);
    // An off-template body is unknown, NOT zero — a zero here would read as
    // "reviewer found nothing" when the truth is "ARF could not tell".
    assert.equal(closeout.blockingCount, null);
    assert.equal(closeout.nonBlockingCount, null);
    assert.equal(detail.findings.length, 0);
  });

  it('returns a PR with empty rounds/passes/findings when it has no passes', () => {
    const { store } = fixtureStore();
    const detail = store.pullRequest({ repo: REPO, prNumber: 5539 });
    assert.equal(detail.pullRequest.pr, 5539);
    assert.equal(detail.pullRequest.failureMessage, 'reviewer spawn refused: drain in effect');
    assert.deepEqual(detail.rounds, []);
    assert.deepEqual(detail.passes, []);
    assert.deepEqual(detail.findings, []);
    assert.equal(detail.pullRequest.blockingCount, null);
    // With no pass there is no verdict, so there is no head to have cast it on.
    // Falling back to the PR's own head here would compare a value to itself and
    // claim `true` — a never-reviewed PR asserting its verdict is current.
    assert.equal(detail.pullRequest.verdictHeadSha, null);
    assert.equal(detail.pullRequest.verdictHeadShaShort, null);
    assert.equal(detail.pullRequest.verdictOnCurrentHead, null);
    assert.equal(detail.pullRequest.latestRound, null);
  });

  it('resolves the repo when only a PR number is given', () => {
    const { store } = fixtureStore();
    const detail = store.pullRequest({ prNumber: 5543 });
    assert.equal(detail.pullRequest.repo, REPO);
  });

  it('returns a null PR for an unknown PR number rather than throwing', () => {
    const { store } = fixtureStore();
    const detail = store.pullRequest({ prNumber: 999999 });
    assert.equal(detail.store.available, true);
    assert.equal(detail.pullRequest, null);
    assert.deepEqual(detail.findings, []);
  });

  it('does not write to the store it reads', () => {
    const { store, path, dir } = fixtureStore();
    const before = createHash('sha256').update(readFileSync(path)).digest('hex');
    store.describe();
    store.pullRequests({ state: 'all' });
    store.pullRequest({ repo: REPO, prNumber: 5543 });
    store.findings({ repo: REPO, prNumber: 5541 });
    const after = createHash('sha256').update(readFileSync(path)).digest('hex');
    assert.equal(after, before, 'reads must not mutate a pipeline-owned reviews.db');
    // No -wal / -journal siblings either: a writable handle would leave them.
    assert.deepEqual(readdirSync(dir).sort(), ['reviews.db']);
  });
});

describe('ReviewStore degrade-to-empty', () => {
  it('returns a valid empty projection when the store path does not exist', () => {
    const store = storeAt(join(tmpDir(), 'nope', 'reviews.db'));

    const described = store.describe();
    assert.equal(described.available, false);
    assert.match(described.reason, /reviews\.db/);

    const list = store.pullRequests();
    assert.deepEqual(list.pullRequests, []);
    assert.equal(list.store.available, false);

    const detail = store.pullRequest({ repo: REPO, prNumber: 5543 });
    assert.equal(detail.pullRequest, null);
    assert.deepEqual(detail.rounds, []);
    assert.deepEqual(detail.passes, []);
    assert.deepEqual(detail.findings, []);

    assert.deepEqual(store.findings({ prNumber: 5543 }).findings, []);
  });

  it('degrades when the path holds a file that is not a database', () => {
    const path = join(tmpDir(), 'reviews.db');
    writeFileSync(path, 'this is not a sqlite database');
    const store = storeAt(path);
    assert.equal(store.describe().available, false);
    assert.deepEqual(store.pullRequests().pullRequests, []);
  });

  it('degrades when the database has no review-state tables at all', () => {
    const dir = tmpDir();
    const path = join(dir, 'reviews.db');
    const foreign = openWritableStandalone(path, { mode: MODE_STANDALONE, readOnly: false });
    foreign.exec('CREATE TABLE something_else (a INTEGER)');
    foreign.close();

    const store = storeAt(path);
    assert.equal(store.describe().available, false);
    assert.deepEqual(store.pullRequests().pullRequests, []);
  });

  it('degrades field-by-field when a live store predates a column', () => {
    // An older adversarial-review install: reviewed_prs exists but has none of
    // the pass/verdict columns and no reviewer_passes table. The PR must still
    // list, with the missing fields null — not a blank dashboard.
    const dir = tmpDir();
    const path = join(dir, 'reviews.db');
    const old = openWritableStandalone(path, { mode: MODE_STANDALONE, readOnly: false });
    old.exec('CREATE TABLE reviewed_prs (repo TEXT NOT NULL, pr_number INTEGER NOT NULL)');
    old.prepare('INSERT INTO reviewed_prs (repo, pr_number) VALUES (?, ?)').run(REPO, 4242);
    old.close();

    const store = storeAt(path);
    assert.equal(store.describe().available, true);
    const [pr] = store.pullRequests().pullRequests;
    assert.equal(pr.pr, 4242);
    assert.equal(pr.prState, 'open');
    assert.equal(pr.latestVerdict, null);
    assert.equal(pr.blockingCount, null);
    // Synthesized defaults track the store's own column defaults. `pr_state`
    // and `review_status` are NOT NULL DEFAULT 'open' / 'posted' in the live
    // pipeline schema, so an install predating a column reads as the value
    // that column would have carried — not as an invented pipeline state.
    assert.equal(pr.reviewStatus, 'posted');

    const detail = store.pullRequest({ repo: REPO, prNumber: 4242 });
    assert.equal(detail.pullRequest.pr, 4242);
    assert.deepEqual(detail.passes, []);
    assert.deepEqual(detail.rounds, []);
  });

  it('keeps finding ids unique when the store predates pass_id', () => {
    const dir = tmpDir();
    const path = join(dir, 'reviews.db');
    const old = openWritableStandalone(path, { mode: MODE_STANDALONE, readOnly: false });
    old.exec(`
      CREATE TABLE reviewed_prs (repo TEXT NOT NULL, pr_number INTEGER NOT NULL);
      CREATE TABLE reviewer_passes (
        repo TEXT NOT NULL, pr_number INTEGER NOT NULL, attempt_number INTEGER NOT NULL,
        pass_kind TEXT, body_md TEXT, started_at TEXT
      );
    `);
    old.prepare('INSERT INTO reviewed_prs (repo, pr_number) VALUES (?, ?)').run(REPO, 4243);
    const body = '## Blocking issues\n\n- **A finding**\n  - **Category:** correctness\n';
    const insert = old.prepare(`INSERT INTO reviewer_passes
      (repo, pr_number, attempt_number, pass_kind, body_md, started_at) VALUES (?, ?, ?, ?, ?, ?)`);
    insert.run(REPO, 4243, 1, 'review', body, '2026-08-18T10:00:00Z');
    insert.run(REPO, 4243, 1, 'rereview', body, '2026-08-18T11:00:00Z');
    old.close();

    const { findings } = storeAt(path).findings({ repo: REPO, prNumber: 4243 });
    assert.equal(findings.length, 2);
    // Without pass_id both passes fall back to a synthesized key. If that key
    // were constant, a UI keying its list on findingId would collide the two.
    assert.equal(new Set(findings.map((finding) => finding.findingId)).size, 2);
  });

  it('infers pass status from completion markers when the store predates status', () => {
    // `reviewer_passes.status` is NOT NULL with no DEFAULT in the pipeline
    // schema, so there is no column default to mirror. Synthesizing a pending
    // state for a pass that plainly finished would leave every historical pass
    // stuck mid-flight on the dashboard.
    const path = join(tmpDir(), 'reviews.db');
    const old = openWritableStandalone(path, { mode: MODE_STANDALONE, readOnly: false });
    old.exec(`
      CREATE TABLE reviewed_prs (repo TEXT NOT NULL, pr_number INTEGER NOT NULL);
      CREATE TABLE reviewer_passes (
        pass_id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL, pr_number INTEGER NOT NULL, attempt_number INTEGER NOT NULL,
        pass_kind TEXT, verdict TEXT, started_at TEXT, ended_at TEXT
      );
    `);
    old.prepare('INSERT INTO reviewed_prs (repo, pr_number) VALUES (?, ?)').run(REPO, 4244);
    const insert = old.prepare(`INSERT INTO reviewer_passes
      (repo, pr_number, attempt_number, pass_kind, verdict, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insert.run(REPO, 4244, 1, 'review', 'request-changes', '2026-08-18T10:00:00Z', '2026-08-18T10:30:00Z');
    insert.run(REPO, 4244, 2, 'rereview', 'comment-only', '2026-08-18T11:00:00Z', null);
    insert.run(REPO, 4244, 3, 'rereview', null, '2026-08-18T12:00:00Z', null);
    old.close();

    const byRound = new Map(
      storeAt(path).pullRequest({ repo: REPO, prNumber: 4244 }).passes
        .map((pass) => [pass.round, pass.status]),
    );
    assert.equal(byRound.get(1), 'completed', 'ended_at means the pass finished');
    assert.equal(byRound.get(2), 'completed', 'a cast verdict means the pass finished');
    // Only a pass with neither marker is genuinely still in flight, and the
    // value is the pipeline's own `running`, not a PR-level review_status word.
    assert.equal(byRound.get(3), 'running');
  });

  it('never overrides a status the store actually recorded', () => {
    const { store } = fixtureStore();
    const detail = store.pullRequest({ repo: REPO, prNumber: 5543 });
    const stored = detail.passes.map((pass) => pass.status);
    assert.equal(stored.includes('completed'), true);
    assert.equal(stored.includes('running'), true);
  });
});

describe('cross-repo PR numbers', () => {
  /** Two repos carrying the same PR number, with distinct review activity. */
  function crossRepoStore() {
    const stateRoot = tmpDir();
    const config = loadConfig({ env: { ARF_STATE_ROOT: stateRoot, ARF_MODE: MODE_STANDALONE } });
    const store = openReviewStore(config);
    const db = openWritableStandalone(config.storePath, config);
    const insertPr = db.prepare(`INSERT INTO reviewed_prs
      (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, last_attempted_at)
      VALUES (?, ?, ?, 'codex', 'open', 'posted', 1, ?)`);
    // Higher PR number, older activity: number-ordering and activity-ordering
    // disagree, which is the whole point of the ordering contract.
    insertPr.run('laceyenterprises/other', 900, '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z');
    insertPr.run(REPO, 12, '2026-08-18T00:00:00Z', '2026-08-18T00:00:00Z');
    insertPr.run(REPO, 900, '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z');
    db.close();
    return store;
  }

  it('orders the cross-repo list by activity, not by repository-local number', () => {
    const { pullRequests } = crossRepoStore().pullRequests();
    assert.deepEqual(
      pullRequests.map((pr) => `${pr.repo}#${pr.pr}`),
      [`${REPO}#12`, `${REPO}#900`, 'laceyenterprises/other#900'],
      'PR numbers are repository-local; ordering by number interleaves repos',
    );
  });

  it('reports repo ambiguity through findings(), not as an empty list', () => {
    const store = crossRepoStore();
    const detail = store.pullRequest({ prNumber: 900 });
    assert.equal(detail.ambiguousRepo, true);

    // findings() must not flatten that ambiguity into a bare [] — a caller
    // cannot tell "ambiguous" from "no findings" without the flags.
    const result = store.findings({ prNumber: 900 });
    assert.deepEqual(result.findings, []);
    assert.equal(result.ambiguousRepo, true);
    assert.deepEqual(result.repoMatches, [REPO, 'laceyenterprises/other']);

    // Qualified by repo, there is no ambiguity to report.
    const qualified = store.findings({ repo: REPO, prNumber: 900 });
    assert.equal(qualified.ambiguousRepo, undefined);
  });
});

describe('standalone mode', () => {
  it('provisions its own store and serves a valid empty projection from it', () => {
    const stateRoot = tmpDir();
    const config = loadConfig({ env: { ARF_STATE_ROOT: stateRoot, ARF_MODE: MODE_STANDALONE } });
    const store = openReviewStore(config);

    const described = store.describe();
    assert.equal(described.mode, MODE_STANDALONE);
    assert.equal(described.ownsStore, true);
    assert.equal(described.readOnly, false);
    assert.equal(described.available, true, 'a provisioned standalone store is available');
    assert.deepEqual(store.pullRequests().pullRequests, [], 'empty, not absent');
    assert.equal(store.pullRequest({ prNumber: 1 }).pullRequest, null);
  });

  it('reads standalone rows through the same projection as a live store', () => {
    const stateRoot = tmpDir();
    const config = loadConfig({ env: { ARF_STATE_ROOT: stateRoot, ARF_MODE: MODE_STANDALONE } });
    const store = openReviewStore(config);

    const db = openWritableStandalone(config.storePath, config);
    db.prepare(`INSERT INTO reviewed_prs
      (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, reviewer_head_sha)
      VALUES (?, ?, ?, ?, 'open', 'posted', 1, ?)`)
      .run(REPO, 77, '2026-08-17T00:00:00Z', 'claude-code', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    db.prepare(`INSERT INTO reviewer_passes
      (repo, pr_number, attempt_number, reviewer_class, pass_kind, verdict, status, head_sha, body_md, started_at, ended_at)
      VALUES (?, ?, 1, 'codex', 'review', 'request-changes', 'completed', ?, ?, ?, ?)`)
      .run(
        REPO, 77, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        '## Blocking issues\n\n- **Standalone finding**\n  - **Category:** correctness\n\n## Non-blocking issues\n\n- None.\n',
        '2026-08-17T00:05:00Z', '2026-08-17T00:15:00Z',
      );
    db.close();

    const detail = store.pullRequest({ repo: REPO, prNumber: 77 });
    assert.equal(detail.pullRequest.latestVerdict, 'request-changes');
    assert.equal(detail.pullRequest.verdictOnCurrentHead, true);
    assert.deepEqual(detail.rounds.map((round) => round.round), [1]);
    assert.equal(detail.findings.length, 1);
    assert.equal(detail.findings[0].title, 'Standalone finding');
    assert.equal(detail.findings[0].kind, 'blocking');
  });
});

describe('read-only invariant', () => {
  it('refuses a writable handle whenever the config is read-only', () => {
    const path = join(tmpDir(), 'reviews.db');
    assert.throws(
      () => openWritableStandalone(path, { mode: MODE_IN_OS, readOnly: true }),
      ArfStoreError,
    );
  });

  it('never provisions a store in in-os mode', () => {
    const dir = tmpDir();
    const path = join(dir, 'reviews.db');
    const store = storeAt(path, { mode: MODE_IN_OS });
    assert.equal(store.provision(), false);
    assert.deepEqual(readdirSync(dir), [], 'in-os mode must not create the pipeline store');
  });

  it('opens the live store with a handle that refuses writes', () => {
    const { path } = fixtureStore();
    const { db } = openReadOnly(path);
    assert.notEqual(db, null);
    try {
      assert.throws(() => db.exec('CREATE TABLE injected (a INTEGER)'));
      assert.throws(() => db.exec("UPDATE reviewed_prs SET review_status = 'tampered'"));
    } finally {
      db.close();
    }
  });
});

describe('cross-owner WAL sidecar guard', () => {
  /** A WAL-mode store, which is what actually creates `-wal` / `-shm` on open. */
  function walStore() {
    const dir = tmpDir('arf-wal-');
    const path = join(dir, 'reviews.db');
    const db = openWritableStandalone(path, { mode: MODE_STANDALONE, readOnly: false });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(STANDALONE_SCHEMA_SQL);
    db.prepare('INSERT INTO reviewed_prs (repo, pr_number) VALUES (?, ?)').run(REPO, 4321);
    db.close();
    return { dir, path };
  }

  /** A uid the store file cannot be owned by, standing in for the other account. */
  const FOREIGN_UID = -1;

  it('a plain read-only open on a WAL store creates the sidecars', () => {
    // The hazard this guard exists for, asserted directly: SQLITE_OPEN_READONLY
    // does NOT stop SQLite from creating `-wal` / `-shm`, so a cross-account read
    // would leave the pipeline locked out of its own database.
    const { dir, path } = walStore();
    const { db } = openReadOnly(path);
    try {
      assert.notEqual(db, null);
      assert.deepEqual(
        readdirSync(dir).sort(),
        ['reviews.db', 'reviews.db-shm', 'reviews.db-wal'],
        'same-owner reads keep locking on, and the sidecars they create are ours',
      );
    } finally {
      db?.close();
    }
  });

  it('reads a cross-owner WAL store without creating a sidecar', () => {
    const { dir, path } = walStore();
    const { db, reason } = openReadOnly(path, { uid: FOREIGN_UID });
    try {
      assert.notEqual(db, null, 'a quiescent cross-owner store is still readable');
      assert.equal(reason, null);
      assert.equal(db.prepare('SELECT pr_number FROM reviewed_prs').get().pr_number, 4321);
      assert.deepEqual(
        readdirSync(dir),
        ['reviews.db'],
        'immutable=1 takes no locks, so no foreign-owned sidecar is left behind',
      );
    } finally {
      db?.close();
    }
  });

  it('fails closed, with a reason, on a cross-owner store with live sidecars', () => {
    const { dir, path } = walStore();
    // Leave the sidecars behind, as a live pipeline write would.
    writeFileSync(`${path}-wal`, '');
    writeFileSync(`${path}-shm`, '');

    const access = storeAccess(path, { uid: FOREIGN_UID });
    assert.equal(access.open, false);
    assert.match(access.reason, /live WAL sidecars/);

    const { db, reason } = openReadOnly(path, { uid: FOREIGN_UID });
    assert.equal(db, null);
    assert.match(reason, /live WAL sidecars/);
    assert.deepEqual(
      readdirSync(dir).sort(),
      ['reviews.db', 'reviews.db-shm', 'reviews.db-wal'],
      'a refused open touches nothing',
    );
  });

  it('surfaces the refusal as an honest unavailable with its own reason', () => {
    const { path } = walStore();
    writeFileSync(`${path}-wal`, '');
    const config = loadConfig({
      env: { ARF_STATE_ROOT: tmpDir(), ARF_MODE: MODE_IN_OS, ARF_STORE_PATH: path },
    });
    const store = new ReviewStore(config, { uid: FOREIGN_UID });

    const described = store.describe();
    assert.equal(described.available, false);
    // Not the generic "pipeline has not run yet" sentence: that would send an
    // operator looking for a missing pipeline when the fix is to run as the owner.
    assert.match(described.reason, /live WAL sidecars/);
    assert.match(described.reason, /run ARF as uid/);

    const list = store.pullRequests();
    assert.deepEqual(list.pullRequests, []);
    assert.match(list.store.reason, /live WAL sidecars/);
    assert.match(
      store.pullRequest({ repo: REPO, prNumber: 4321 }).store.reason,
      /live WAL sidecars/,
    );
  });

  it('keeps the generic reason for an ordinary absent store', () => {
    const store = storeAt(join(tmpDir(), 'nope', 'reviews.db'));
    assert.match(store.describe().reason, /pipeline not present or not yet run/);
  });

  it('finds the sidecars of a symlinked store beside the target', () => {
    // SQLite creates `-wal` / `-shm` next to the file it opens, not next to the
    // symlink that pointed at it. Suffixing the link path would find nothing,
    // downgrade to `immutable=1`, and read straight past a live WAL — a stale
    // dashboard that looks perfectly current.
    const { path: target } = walStore();
    writeFileSync(`${target}-wal`, '');
    const link = join(tmpDir('arf-link-'), 'reviews.db');
    symlinkSync(target, link);

    const access = storeAccess(link, { uid: FOREIGN_UID });
    assert.equal(access.open, false, 'the target has a live WAL, so the link must fail closed');
    assert.equal(access.immutable, false);
    assert.match(access.reason, /live WAL sidecars/);
  });

  it('reads a quiescent symlinked cross-owner store', () => {
    // The other half of the same seam: resolving the link must not turn every
    // symlinked store into a refusal, only the ones with a live WAL.
    const { path: target } = walStore();
    const link = join(tmpDir('arf-link-'), 'reviews.db');
    symlinkSync(target, link);

    const { db, reason } = openReadOnly(link, { uid: FOREIGN_UID });
    try {
      assert.notEqual(db, null);
      assert.equal(reason, null);
      assert.equal(db.prepare('SELECT pr_number FROM reviewed_prs').get().pr_number, 4321);
    } finally {
      db?.close();
    }
  });
});
