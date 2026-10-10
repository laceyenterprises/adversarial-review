import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openReviewStateDb } from '../src/review-state.mjs';
import { readFindingDisputeReservations } from '../src/ama/finding-dispute-context.mjs';
import { checkPrimaryChange, fetchPrimaryChange as fetchPrimaryChangeWithCost } from '../src/ama/primary-change.mjs';
import { disputeFinding } from '../src/ama/finding-dispute.mjs';
import { assertFindingDisputeOwner } from '../src/ama/finding-dispute-owner.mjs';
import { recordPrimaryChangeRefusal } from '../src/ama/primary-change-refusal.mjs';
import { ensureReviewStateSchema } from '../src/review-state.mjs';
import { alertPresentationForDoc } from '../src/alert-delivery.mjs';
import { formatFindingDisputeContext } from '../src/prompt-context.mjs';
const head = 'c'.repeat(40), author = 'a'.repeat(40), base = 'b'.repeat(40);
// Preservation fixtures model a separately successful, exact-head cost read.
const fetchPrimaryChange = (args) => fetchPrimaryChangeWithCost(args, {
  fetchCiCostImpl: async ({ headSha }) => ({ headSha, ok: true, failedCheck: false }),
});
const path = 'scripts/ci-mirror/checks.agent-os.json';
const file = { filename: path, status: 'modified', additions: 1, deletions: 1,
  patch: '@@ -10 +10 @@\n-enforcement: false\n+enforcement: true' };
const body = `## Blocking issues\n- **Narrow push enforcement**\n  - **File:** \`${path}\`\n  - **Lines:** \`10\`\n  - **Problem:** Push ratchet blocks unrelated work.\n  - **Recommended fix:** Revert this push enforcement.\n## Non-blocking issues\n- None.\n## Verdict\nRequest changes`;
const review = { node_id: 'PRR_fixture', html_url: 'https://github.com/fixture/repo/pull/1#pullrequestreview-1',
  commit_id: author, state: 'CHANGES_REQUESTED', user: { login: 'lacey-codex-reviewer[bot]' }, body };
const commit = { sha: head, parents: [{ sha: author }], author: { login: null }, committer: { login: 'the-hammer-lacey[bot]' },
  commit: { message: `HAM repair\n\nWorker-Class: hammer\nWorker-Ticket: HAM\nClosed-By: hammer (adversarial-pipe-mode)\nReviewed-Head: ${author}\nReversal-Authorized-By: PRR_fixture finding=1` },
  files: [{ ...file, patch: '@@ -10 +10 @@\n-enforcement: true\n+enforcement: false' }] };
function evidence() {
  return { ciCost: { headSha: head, ok: true, failedCheck: false }, headSha: head, hasHammerCommits: true, primaryHead: author, mergeBase: base,
    primaryFiles: [file], finalFiles: [], reversalAuthorizations: [{ commit, review, reviewedFiles: [file], parentFiles: [file] }] };
}
test('blocking finding authorizes the overlapping HAM reversion; #1207 and invalid citations still refuse', () => {
  assert.equal(checkPrimaryChange(evidence(), head).ok, true);
  for (const mutate of [
    (e) => { e.reversalAuthorizations = []; },
    (e) => { e.reversalAuthorizations[0].commit.commit.message = 'HAM\n\nWorker-Class: hammer'; },
    (e) => { e.reversalAuthorizations[0].review.body = body.replace('## Blocking issues', '## Non-blocking issues'); },
    (e) => { e.reversalAuthorizations[0].review.body = body.replace('`10`', '`40`'); },
    (e) => { e.reversalAuthorizations[0].review.body = body.replace(path, 'other.json'); },
    (e) => { e.reversalAuthorizations[0].review.user.login = 'author'; },
    (e) => { e.reversalAuthorizations[0].review.commit_id = head; },
    (e) => { e.reversalAuthorizations[0].commit.files[0].patch = '@@ -9 +9 @@\n-enforcement: true\n+enforcement: false'; },
    (e) => { e.reversalAuthorizations[0].commit.commit.message = commit.commit.message.replace('Worker-Ticket: HAM', 'Worker-Ticket: AUTHOR'); },
  ]) {
    const e = structuredClone(evidence()); mutate(e);
    assert.equal(checkPrimaryChange(e, head).reason, 'primary-change-reverted');
  }
});
test('collector binds authorization to closure history, review ancestry and live commit patch', async () => {
  const compare = { merge_base_commit: { sha: base }, status: 'ahead', files: [file] };
  const get = async (url) => {
    if (url.endsWith('/pulls/1')) return { head: { sha: head }, base: { sha: base } };
    if (url.includes('/reviews?')) return [review];
    if (url.includes('/commits/')) return commit;
    if (url.endsWith(`${base}...${head}`)) return { ...compare, files: [], total_commits: 2,
      commits: [{ sha: author, commit: { message: 'author' } }, commit] };
    return compare;
  };
  const e = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head, get });
  assert.equal(e.reversalAuthorizations.length, 1);
  assert.equal(checkPrimaryChange(e, head).ok, true);
  const outside = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head,
    get: async (url) => url.endsWith(`${author}...${author}`) ? { status: 'diverged' } : get(url) });
  assert.equal(checkPrimaryChange(outside, head).reason, 'primary-change-reverted');
});
test('a contextual hunk cannot authorize another region, and line shifts are mapped', () => {
  const e = evidence();
  const mapped = { ...file, additions: 2, deletions: 1,
    patch: '@@ -1,11 +1,12 @@\n+insert\n one\n two\n three\n four\n five\n six\n seven\n eight\n nine\n-enforcement: false\n+enforcement: true\n eleven' };
  e.reversalAuthorizations[0] = structuredClone(e.reversalAuthorizations[0]);
  e.reversalAuthorizations[0].reviewedFiles = [mapped];
  e.reversalAuthorizations[0].parentFiles = [mapped];
  e.reversalAuthorizations[0].review.body = body.replace('`10`', '`11`');
  e.reversalAuthorizations[0].commit.files[0].patch = '@@ -11 +11 @@\n-enforcement: true\n+enforcement: false';
  assert.equal(checkPrimaryChange(e, head).ok, true);
  e.reversalAuthorizations[0].review.body = body.replace('`10`', '`2`');
  assert.equal(checkPrimaryChange(e, head).reason, 'primary-change-reverted');
});
// HAMFINAL-01: withdrawal evidence is a fenced exact-head repro + output.
const jsonbEvidence = '```\n$ psql -c "UPDATE t SET doc = \'x\'::text"\nERROR:  column "doc" is of type jsonb but expression is of type text\n```\nGenerated destination is JSONB; TEXT assignment fails.';
function disputeHarness(t, overrides = {}) {
  const db = new Database(':memory:'); ensureReviewStateSchema(db); t.after(() => db.close());
  db.prepare(`INSERT INTO reviewed_prs(repo, pr_number, reviewer, review_status, pr_state, reviewed_at, revision_ref)
    VALUES ('fixture/repo', 1, 'codex', 'posted', 'open', '2026-10-03T00:00:00Z', ?)`).run(head);
  const calls = [];
  const args = { rootDir: '/fixture', repo: 'fixture/repo', prNumber: 1, headSha: head,
    reviewRef: review.node_id, findingNumber: 1, evidence: jsonbEvidence };
  const deps = { db, get: async (url) => url.includes('/reviews?') ? [{ ...review, commit_id: head }]
    : { state: 'open', head: { sha: head } },
  postComment: async (text) => { calls.push(['comment', text]); return { node_id: `IC_${calls.length}`, user: { login: 'the-hammer-lacey[bot]' }, body: text }; },
  wake: async (input) => calls.push(['wake', input]),
  logger: { error: (text) => calls.push(['event', text]), info() {}, warn() {} }, ...overrides };
  return { db, calls, args, deps };
}
test('dispute records a final withdrawn-by-hammer adjudication with no re-review and no operator decision', async (t) => {
  // Operator decision 2026-10-10: "Hammers judgement is final".
  const h = disputeHarness(t);
  const result = await disputeFinding(h.args, h.deps);
  assert.equal(result.withdrawn, true);
  assert.equal(result.resolution, 'withdrawn-by-hammer');
  assert.deepEqual(h.calls.map(([kind]) => kind), ['comment', 'wake']);
  assert.match(h.calls[0][1], /finding=1/);
  assert.match(h.calls[0][1], /JSONB/);
  assert.match(h.calls[0][1], /^Resolution: withdrawn-by-hammer$/m);
  assert.match(h.calls[0][1], new RegExp(`^Evidence-SHA256: ${result.evidenceSha256}$`, 'm'));
  assert.equal(h.calls[1][1].headSha, head);
  // The review row is untouched: nothing for the same-head duplicate guard to drop.
  assert.equal(h.db.prepare('SELECT revision_ref, review_status FROM reviewed_prs').get().review_status, 'posted');
  const reservations = h.db.prepare('SELECT * FROM ham_finding_disputes').all();
  assert.equal(reservations[0].resolution, 'withdrawn-by-hammer');
  assert.equal(reservations[0].finding_reviewed_head, head);
  assert.equal(reservations[0].evidence_sha256, result.evidenceSha256);
  const comment = { id: reservations[0].comment_id, author: 'the-hammer-lacey', body: h.calls[0][1] };
  const context = formatFindingDisputeContext({ headRefOid: head, comments: [comment] }, reservations);
  assert.match(context, /adjudication is final/); assert.match(context, /JSONB/);
  assert.equal(formatFindingDisputeContext({ headRefOid: author, comments: [comment] }, reservations), '');
});
test('a repeated dispute of the same finding on the same head reuses the recorded withdrawal', async (t) => {
  const h = disputeHarness(t);
  const first = await disputeFinding(h.args, h.deps);
  for (let i = 0; i < 3; i++) {
    const again = await disputeFinding(h.args, h.deps);
    assert.equal(again.withdrawn, true); assert.equal(again.alreadyRecorded, true);
    assert.equal(again.commentId, first.commentId);
  }
  assert.equal(h.calls.filter(([kind]) => kind === 'comment').length, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'page' || kind === 'event').length, 0);
  assert.equal(h.db.prepare('SELECT requests FROM ham_finding_disputes').get().requests, 1);
});
test('an exhausted review-cycle cap no longer blocks a withdrawal', async (t) => {
  const h = disputeHarness(t, { loadedConfig: { get: (key, fallback) => key === 'review_cycle_cap' ? 1 : fallback } });
  h.db.prepare(`INSERT INTO review_cycle_verdicts(pr_url, head_sha, verdict_count, verdict_at)
    VALUES ('https://github.com/fixture/repo/pull/1', ?, 10, ?)`).run(head, new Date().toISOString());
  assert.equal((await disputeFinding(h.args, h.deps)).withdrawn, true);
  assert.equal(h.calls.filter(([kind]) => kind === 'comment').length, 1);
  assert.equal(h.calls.filter(([kind]) => kind === 'page').length, 0);
});
test('head movement never re-arms a dispute', async (t) => {
  const h = disputeHarness(t); let reads = 0;
  h.deps.get = async (url) => url.includes('/reviews?') ? [{ ...review, commit_id: head }]
    : { state: 'open', head: { sha: ++reads === 1 ? head : author } };
  await assert.rejects(disputeFinding(h.args, h.deps), /head moved/);
  assert.equal(h.calls.filter(([kind]) => kind === 'wake').length, 0);
  assert.equal(h.db.prepare('SELECT resolution FROM ham_finding_disputes').get().resolution, null);
  assert.equal(h.db.prepare('SELECT requests FROM ham_finding_disputes').get().requests, 0);
  assert.equal(h.db.prepare('SELECT comment_id FROM ham_finding_disputes').get().comment_id, null);
});
test('repeated preservation refusals retain the hold and page once across restarts', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamintent-refusal-')); t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const pages = [], events = [];
  for (let i = 0; i < 5; i++) await recordPrimaryChangeRefusal({ rootDir, repo: 'fixture/repo', prNumber: 1,
    headSha: head, reasons: ['primary-change-reverted'] }, { page: async (...args) => pages.push(args), logger: { error: (text) => events.push(text) } });
  assert.equal(pages.length, 1); assert.equal(events.length, 1); assert.match(events[0], /SEV1/);
});

test('exhaustion events use the real pager presentation', () => {
  for (const event of ['ama_finding_dispute_exhausted', 'ama_primary_change_refusal_exhausted']) {
    assert.equal(alertPresentationForDoc({ event, payload: { repo: 'fixture/repo', prNumber: 1 } }).severity, 'SEV1');
  }
});

test('a dispute after other repairs binds the withdrawal to live head and verifies finding ancestry', async (t) => {
  const h = disputeHarness(t);
  h.deps.get = async (url) => url.includes('/reviews?') ? [review]
    : url.includes('/compare/') ? { status: 'ahead' } : { state: 'open', head: { sha: head } };
  const result = await disputeFinding(h.args, h.deps);
  assert.equal(result.withdrawn, true);
  assert.equal(result.headSha, head); assert.equal(result.findingReviewedHead, author);
  assert.match(h.calls[0][1], new RegExp(`^Reviewed-Head: ${head}$`, 'm'));
  assert.match(h.calls[0][1], new RegExp(`Finding-Reviewed-Head: ${author}`));
});

test('partial authorization permits one repeated removal while preserving the other region', () => {
  const e = evidence();
  e.primaryFiles = [{ ...file, additions: 2, deletions: 2,
    patch: '@@ -10 +10 @@\n-enforcement: false\n+enforcement: true\n@@ -40 +40 @@\n-enforcement: false\n+enforcement: true' }];
  e.finalFiles = [{ ...file, patch: '@@ -40 +40 @@\n-enforcement: false\n+enforcement: true' }];
  assert.equal(checkPrimaryChange(e, head).ok, true);
  e.finalFiles = [];
  assert.equal(checkPrimaryChange(e, head).reason, 'primary-change-reverted');
});

test('reviewer includes reserved HAM evidence in both full and slim prompt paths', async () => {
  const { __test__ } = await import('../src/reviewer.mjs');
  const comment = { id: 'IC_verified', author: 'the-hammer-lacey',
    body: `HAM finding dispute — PRR_fixture finding=1\nReviewed-Head: ${head}\nJSONB proof` };
  const reservations = [{ head_sha: head, comment_id: comment.id, comment_author: 'the-hammer-lacey[bot]',
    comment_sha256: createHash('sha256').update(comment.body).digest('hex') }];
  for (const slim of [false, true]) {
    const context = await __test__.buildReviewerExtraContext({ repo: 'fixture/repo', prNumber: 1,
      prContext: { headRefOid: head, comments: [comment] },
      readFindingDisputeReservationsImpl: () => reservations,
      reviewModeDecision: { slim, lowRiskClasses: [], reasons: [], files: [], stats: { files: 1, added: 1, removed: 0 } },
      fetchLinkedSpecContentsImpl: async () => '', buildHardeningReviewContextImpl: async () => '', log: { error() {} } });
    assert.match(context, /JSONB proof/); assert.match(context, /adjudication is final/);
  }
});

test('a one-line finding cannot waive a contiguous multi-line author rewrite', () => {
  const e = structuredClone(evidence());
  const primary = { ...file, additions: 3, deletions: 3,
    patch: '@@ -10,3 +10,3 @@\n-old one\n-old two\n-old three\n+new one\n+new two\n+new three' };
  const revert = { ...primary, patch: '@@ -10,3 +10,3 @@\n-new one\n-new two\n-new three\n+old one\n+old two\n+old three' };
  e.primaryFiles = [primary];
  Object.assign(e.reversalAuthorizations[0], { reviewedFiles: [primary], parentFiles: [primary],
    commit: { ...commit, files: [revert] } });
  assert.equal(checkPrimaryChange(e, head).reason, 'primary-change-reverted');
  // Reverting only the cited line while retaining the remainder is allowed.
  e.finalFiles = [{ ...file, additions: 2, deletions: 2,
    patch: '@@ -11,2 +11,2 @@\n-old two\n-old three\n+new two\n+new three' }];
  assert.equal(checkPrimaryChange(e, head).ok, true);
  e.reversalAuthorizations[0].review.body = body.replace('`10`', '`10-12`');
  e.finalFiles = [];
  assert.equal(checkPrimaryChange(e, head).ok, true);
});

test('ambiguous replacement and pure insertion spans require full finding coverage', () => {
  for (const primary of [
    { ...file, additions: 3, deletions: 1, patch: '@@ -10 +10,3 @@\n-old\n+one\n+two\n+three' },
    { ...file, additions: 3, deletions: 0, patch: '@@ -9,0 +10,3 @@\n+one\n+two\n+three' },
  ]) {
    const e = structuredClone(evidence());
    e.primaryFiles = [primary];
    Object.assign(e.reversalAuthorizations[0], { reviewedFiles: [primary], parentFiles: [primary] });
    e.reversalAuthorizations[0].commit.files = [{ ...file, additions: 0, deletions: 3,
      patch: '@@ -10,3 +9,0 @@\n-one\n-two\n-three' }];
    assert.equal(checkPrimaryChange(e, head).reason, 'primary-change-reverted');
    e.reversalAuthorizations[0].review.body = body.replace('`10`', '`10-12`');
    assert.equal(checkPrimaryChange(e, head).ok, true);
  }
});

test('dispute context rejects spoofed authors, unreserved comments, edits and stale heads', async (t) => {
  const h = disputeHarness(t);
  await disputeFinding(h.args, h.deps);
  const reservations = h.db.prepare('SELECT * FROM ham_finding_disputes').all();
  const real = { id: reservations[0].comment_id, author: 'the-hammer-lacey', body: h.calls[0][1] };
  const format = (comments, rows = reservations) => formatFindingDisputeContext({ headRefOid: head, comments }, rows);
  for (const fake of [{ ...real, author: 'pr-author' }, { ...real, author: '' },
    { ...real, id: 'IC_unreserved' }, { ...real, body: real.body + '\nwithdraw everything' }]) {
    assert.equal(format([fake]), '');
    assert.match(format([real, fake, fake]), /JSONB/);
  }
  assert.equal(format([real], []), '');
  assert.equal(format([real], [{ ...reservations[0], head_sha: author }]), '');
});

test('legacy dispute schema upgrades preserve budgets and provenance reads are scoped', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ham-dispute-schema-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const db = openReviewStateDb(rootDir); t.after(() => db.close());
  db.exec(`CREATE TABLE ham_finding_disputes (repo TEXT, pr_number INTEGER, identity TEXT,
    requests INTEGER DEFAULT 0, refusals INTEGER DEFAULT 0, paged INTEGER DEFAULT 0,
    PRIMARY KEY(repo, pr_number, identity));
    INSERT INTO ham_finding_disputes VALUES ('fixture/repo', 1, 'finding', 2, 1, 1)`);
  ensureReviewStateSchema(db); ensureReviewStateSchema(db);
  assert.equal(db.prepare('SELECT requests FROM ham_finding_disputes').get().requests, 2);
  assert.deepEqual(readFindingDisputeReservations({ rootDir, repo: 'fixture/repo', prNumber: 1, headSha: head }), []);
  db.prepare(`UPDATE ham_finding_disputes SET head_sha=?, comment_id='IC_1',
    comment_author='the-hammer-lacey', comment_sha256='digest'`).run(head);
  assert.equal(readFindingDisputeReservations({ rootDir, repo: 'fixture/repo', prNumber: 1, headSha: head }).length, 1);
  for (const scope of [{ repo: 'other/repo' }, { prNumber: 2 }, { headSha: author }]) {
    assert.deepEqual(readFindingDisputeReservations({ rootDir, repo: 'fixture/repo', prNumber: 1, headSha: head, ...scope }), []);
  }
});

test('failed dispute side effects refund the request reservation', async (t) => {
  const h = disputeHarness(t, { postComment: async () => { throw new Error('gh unavailable'); } });
  for (let i = 0; i < 3; i++) await assert.rejects(disputeFinding(h.args, h.deps), /gh unavailable/);
  assert.equal(h.db.prepare('SELECT requests FROM ham_finding_disputes').get().requests, 0);
  assert.equal(h.calls.length, 0);
});

test('helper rejects posts under a non-HAM identity and refunds their reservation', async (t) => {
  const h = disputeHarness(t, { postComment: async (body) => ({ node_id: 'IC_spoof', user: { login: 'pr-author' }, body }) });
  await assert.rejects(disputeFinding(h.args, h.deps), /trusted HAM provenance/);
  assert.equal(h.db.prepare('SELECT requests FROM ham_finding_disputes').get().requests, 0);
  assert.equal(h.db.prepare('SELECT comment_id FROM ham_finding_disputes').get().comment_id, null);
});

test('dispute ownership preflight checks the DB, directory, sidecars and actual configured alert sink', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ham-dispute-owner-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  openReviewStateDb(rootDir).close();
  const dbPath = join(rootDir, 'data', 'reviews.db');
  const alertRoot = mkdtempSync(join(tmpdir(), 'ham-dispute-alert-'));
  t.after(() => rmSync(alertRoot, { recursive: true, force: true }));
  const options = { env: { ADVERSARIAL_ALERT_DELIVERY_ROOT: alertRoot }, geteuidImpl: () => process.geteuid() };
  assert.doesNotThrow(() => assertFindingDisputeOwner(rootDir, options));
  for (const foreignPath of [join(rootDir, 'data'), dbPath, `${dbPath}-wal`, `${dbPath}-shm`, alertRoot]) {
    assert.throws(() => assertFindingDisputeOwner(rootDir, {
      ...options,
      existsSyncImpl: (path) => path === foreignPath || existsSync(path),
      statSyncImpl: (path) => path === foreignPath
        ? { uid: process.geteuid() + 1, isDirectory: () => true } : statSync(path),
    }), /refusing cross-user write/);
  }
  assert.throws(() => assertFindingDisputeOwner(rootDir, { ...options, geteuidImpl: null }), /effective uid/);
  rmSync(dbPath);
  assert.throws(() => assertFindingDisputeOwner(rootDir, options), /ENOENT/);
  assert.equal(existsSync(dbPath), false);
});

test('CLI refuses a different effective uid before schema or sidecar writes', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ham-dispute-cli-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const db = openReviewStateDb(rootDir); db.exec('CREATE TABLE sentinel (id INTEGER)'); db.close();
  const result = spawnSync(process.execPath, [
    '--import', `data:text/javascript,process.geteuid=()=>${process.geteuid() + 1}`,
    new URL('../bin/dispute-finding.mjs', import.meta.url).pathname, '--root-dir', rootDir,
  ], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /ama_finding_dispute_owner_refused/);
  assert.match(result.stderr, /refusing cross-user write.*canonical daemon owner/);
  const dbPath = join(rootDir, 'data', 'reviews.db');
  assert.equal(existsSync(`${dbPath}-wal`), false);
  assert.equal(existsSync(`${dbPath}-shm`), false);
  const check = new Database(dbPath, { readonly: true });
  try { assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), [{ name: 'sentinel' }]); }
  finally { check.close(); }
});

test('legacy REST and adapter comment normalization preserve the reservation node ID', async (t) => {
  // Prevent any adapter discovery: all HTTP reads in this test are fixture calls.
  const previous = process.env.AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY;
  process.env.AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY = '0';
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY;
    else process.env.AGENT_OS_GITHUB_ADAPTER_AUTO_DISCOVERY = previous;
  });
  const { __test__ } = await import('../src/github-api.mjs');
  const h = disputeHarness(t);
  await disputeFinding(h.args, h.deps);
  const rows = h.db.prepare('SELECT * FROM ham_finding_disputes').all();
  const comments = await __test__.fetchLegacyComments(async () => ({ stdout: JSON.stringify([
    { id: 42, node_id: rows[0].comment_id, user: { login: 'the-hammer-lacey[bot]' }, body: h.calls[0][1] },
  ]) }), 'fixture/repo', 1);
  assert.equal(comments[0].id, '42');
  assert.equal(comments[0].node_id, rows[0].comment_id);
  assert.match(formatFindingDisputeContext({ headRefOid: head, comments }, rows), /JSONB/);
  const adapterComments = comments.map(__test__.normalizeComment);
  assert.match(formatFindingDisputeContext({ headRefOid: head, comments: adapterComments }, rows), /JSONB/);
});

test('context includes every reserved finding, only its latest comment, with a total byte cap', () => {
  const comments = [], reservations = [];
  for (let index = 0; index < 4; index++) {
    const body = `HAM finding dispute — PRR_fixture finding=${index + 1}\nReviewed-Head: ${head}\nEvidence ${index}`;
    comments.push({ id: `IC_${index}`, author: 'the-hammer-lacey', body });
    reservations.push({ comment_id: `IC_${index}`, head_sha: head, comment_author: 'the-hammer-lacey',
      comment_sha256: createHash('sha256').update(body).digest('hex') });
  }
  comments.unshift({ ...comments[0], id: 'IC_old', body: comments[0].body + ' superseded' });
  const context = formatFindingDisputeContext({ headRefOid: head, comments }, reservations);
  for (let index = 0; index < 4; index++) assert.match(context, new RegExp(`Evidence ${index}`));
  assert.doesNotMatch(context, /superseded/);
  for (let index = 4; index < 40; index++) {
    const body = `HAM finding dispute — PRR_fixture finding=${index + 1}\nReviewed-Head: ${head}\n` + 'x'.repeat(16000);
    comments.push({ id: `IC_${index}`, author: 'the-hammer-lacey', body });
    reservations.push({ comment_id: `IC_${index}`, head_sha: head, comment_author: 'the-hammer-lacey',
      comment_sha256: createHash('sha256').update(body).digest('hex') });
  }
  const bounded = formatFindingDisputeContext({ headRefOid: head, comments }, reservations);
  assert.ok(Buffer.byteLength(bounded, 'utf8') <= 256000);
  assert.ok(bounded.length > 240000);
});

test('reversal rejects either linked foreign identity in collector and predicate', async () => {
  const compare = { merge_base_commit: { sha: base }, status: 'ahead', files: [file] };
  for (const [identity, allowed] of [
    [{ committer: { login: 'pr-author' }, author: { login: 'the-hammer-lacey[bot]' } }, false],
    [{ committer: null, author: { login: 'pr-author' } }, false],
    [{ committer: null, author: null }, false],
    [{ committer: { login: 'the-hammer-lacey[bot]' }, author: null }, true],
    [{ committer: null, author: { login: 'the-hammer-lacey[bot]' } }, true],
    [{ committer: { login: 'merge-agent-lacey' }, author: { login: 'pr-author' } }, false],
    [{ committer: { login: 'merge-agent-lacey' }, author: { login: 'the-hammer-lacey[bot]' } }, true],
  ]) {
    const liveCommit = { ...commit, ...identity };
    const e = structuredClone(evidence()); e.reversalAuthorizations[0].commit = liveCommit;
    assert.equal(checkPrimaryChange(e, head).ok, Boolean(allowed));
    const collected = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head,
      get: async (url) => {
        if (url.endsWith('/pulls/1')) return { head: { sha: head }, base: { sha: base } };
        if (url.includes('/reviews?')) return [review];
        if (url.includes('/commits/')) return liveCommit;
        if (url.endsWith(`${base}...${head}`)) return { ...compare, files: [], total_commits: 2,
          commits: [{ sha: author, commit: { message: 'author' } }, commit] };
        return compare;
      } });
    assert.equal(checkPrimaryChange(collected, head).ok, Boolean(allowed));
  }
});

test('superseded authoritative reviews cannot spend the dispute budget', async (t) => {
  for (const state of ['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED']) {
    const h = disputeHarness(t);
    h.deps.get = async (url) => url.includes('/reviews?') ? [review,
      { ...review, node_id: 'PRR_newer', commit_id: head, state }]
      : { state: 'open', head: { sha: head } };
    await assert.rejects(disputeFinding(h.args, h.deps), /latest authoritative review/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM ham_finding_disputes').get().count, 0);
  }
});

test('newer dismissed, untrusted or non-ancestor reviews do not supersede a live blocking review', async (t) => {
  for (const overrides of [
    { state: 'DISMISSED' }, { state: 'PENDING' }, { user: { login: 'pr-author' } }, { commit_id: author },
  ]) {
    const h = disputeHarness(t);
    h.deps.get = async (url) => url.includes('/reviews?') ? [{ ...review, commit_id: head },
      { ...review, node_id: 'PRR_other', ...overrides }]
      : url.includes('/compare/') ? { status: 'diverged' } : { state: 'open', head: { sha: head } };
    assert.equal((await disputeFinding(h.args, h.deps)).withdrawn, true);
  }
});


test('closer refusal retries failed enqueue and retains guard after success', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamintent-retry-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const args = { rootDir, repo: 'fixture/repo', prNumber: 1, headSha: head, reasons: ['primary-change-reverted'] };
  let fail = true, pages = 0;
  const deps = { logger: { error() {} }, page: async () => {
    if (fail) throw new Error('enqueue unavailable');
    pages += 1;
  } };
  await recordPrimaryChangeRefusal(args, deps); await recordPrimaryChangeRefusal(args, deps);
  await assert.rejects(recordPrimaryChangeRefusal(args, deps), /enqueue unavailable/);
  fail = false;
  await recordPrimaryChangeRefusal(args, deps); await recordPrimaryChangeRefusal(args, deps);
  assert.equal(pages, 1);
});

test('reversal verdict survives mutable REST posting and dismissal state', () => {
  for (const state of ['COMMENTED', 'DISMISSED']) {
    const e = structuredClone(evidence()); e.reversalAuthorizations[0].review.state = state;
    assert.equal(checkPrimaryChange(e, head).ok, true);
  }
});

function collectorFixture(reviews, failure = null) {
  const compare = { merge_base_commit: { sha: base }, status: 'ahead', files: [file] };
  return async (url) => {
    if (failure?.(url)) throw new Error('404 Not Found');
    if (url.endsWith('/pulls/1')) return { head: { sha: head }, base: { sha: base } };
    if (url.includes('/reviews?')) return reviews;
    if (url.includes('/commits/')) return commit;
    if (url.endsWith(`${base}...${head}`)) return { ...compare, files: [], total_commits: 2,
      commits: [{ sha: author, commit: { message: 'author' } }, commit] };
    return compare;
  };
}

test('withdrawn finding cannot authorize a later HAM reversion', async () => {
  const later = { ...review, node_id: 'PRR_withdrawn', html_url: 'https://fixture/withdrawn', state: 'COMMENTED',
    body: '## Blocking issues\n- None.\n## Verdict\nComment only' };
  const e = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head,
    get: collectorFixture([review, later]) });
  assert.equal(checkPrimaryChange(e, head).reason, 'primary-change-reverted');
});

test('unreadable or capped citation refuses its waiver without poisoning author evidence', async () => {
  for (const get of [collectorFixture([review], (url) => url.includes('/commits/')),
    collectorFixture(Array.from({ length: 100 }, () => review))]) {
    const e = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head, get });
    assert.equal(e.hasHammerCommits, true);
    assert.equal(checkPrimaryChange(e, head).reason, 'primary-change-reverted');
  }
});

test('prose-only dispute evidence is refused before any reservation or post', async (t) => {
  for (const evidence of ['Generated destination is JSONB; TEXT assignment fails.', '```\n```\nempty fence', '```\nunterminated']) {
    const h = disputeHarness(t);
    await assert.rejects(disputeFinding({ ...h.args, evidence }, h.deps), /exact-head repro command and output, or the head file/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS count FROM ham_finding_disputes').get().count, 0);
  }
});


test('CLI refuses non-HAM comment provenance and refunds its reservation', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'ham-dispute-identity-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const db = openReviewStateDb(rootDir); ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs(repo, pr_number, reviewer, review_status, pr_state, reviewed_at, revision_ref)
    VALUES ('fixture/repo', 1, 'codex', 'posted', 'open', '2026-10-03T00:00:00Z', ?)`).run(head);
  db.close();
  writeFileSync(join(rootDir, 'evidence.txt'), jsonbEvidence);
  const fakeGh = `#!${process.execPath}
const args=process.argv.slice(2);
let response;
if(args.includes('POST')) response={node_id:'IC_bad',user:{login:'operator'},body:args.find(x=>x.startsWith('body=')).slice(5)};
else if(args.some(x=>x.includes('/reviews?'))) response=${JSON.stringify([{ ...review, commit_id: head }])};
else response={state:'open',head:{sha:'${head}'}};
console.log(JSON.stringify(response));
`;
  writeFileSync(join(rootDir, 'gh'), fakeGh, { mode: 0o755 });
  const result = spawnSync(process.execPath, [
    new URL('../bin/dispute-finding.mjs', import.meta.url).pathname, '--root-dir', rootDir,
    '--repo', 'fixture/repo', '--pr', '1', '--head-sha', head,
    '--review', review.node_id, '--finding', '1', '--evidence-file', join(rootDir, 'evidence.txt'),
  ], { encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: rootDir + ':' + process.env.PATH } });
  assert.equal(result.status, 79, result.stderr);
  assert.match(result.stderr, /ama_finding_dispute_identity_refused/);
  const check = new Database(join(rootDir, 'data', 'reviews.db'), { readonly: true });
  try {
    const row = check.prepare('SELECT requests, comment_id FROM ham_finding_disputes').get();
    assert.equal(row.requests, 0); assert.equal(row.comment_id, null);
    assert.equal(check.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'posted');
  } finally { check.close(); }
});

test('pending and malformed REST review states never grant reversal authority', () => {
  for (const state of ['PENDING', '', undefined]) {
    const e = structuredClone(evidence()); e.reversalAuthorizations[0].review.state = state;
    assert.equal(checkPrimaryChange(e, head).reason, 'primary-change-reverted');
  }
});


test('malformed newer authoritative review refuses an older reversal waiver', async () => {
  const e = await fetchPrimaryChange({ repo: 'fixture/repo', prNumber: 1, headSha: head,
    get: collectorFixture([review, { ...review, node_id: 'PRR_bad', commit_id: '' }]) });
  assert.equal(e.hasHammerCommits, true);
  assert.equal(checkPrimaryChange(e, head).reason, 'primary-change-reverted');
});

 test('stale killed reservation is reclaimed before budget enforcement', async (t) => {
  const h = disputeHarness(t);
  await disputeFinding(h.args, h.deps);
  // A killed caller left a stale reservation and recorded no withdrawal.
  h.db.prepare(`UPDATE ham_finding_disputes SET requests=2, reserved_at='2000-01-01T00:00:00.000Z',
    resolution=NULL, comment_id=NULL`).run();
  assert.equal((await disputeFinding(h.args, h.deps)).withdrawn, true);
  const row = h.db.prepare('SELECT * FROM ham_finding_disputes').get();
  assert.equal(row.requests, 2);
  assert.equal(row.reserved_at, null);
  assert.equal(row.resolution, 'withdrawn-by-hammer');
 });
 test('blocking COMMENTED and DISMISSED reviews can be disputed', async (t) => {
  for (const state of ['COMMENTED', 'DISMISSED']) {
    const h = disputeHarness(t);
    const get = h.deps.get;
    h.deps.get = async (url) => url.includes('/reviews?') ? [{ ...review, commit_id: head, state }] : get(url);
    assert.equal((await disputeFinding(h.args, h.deps)).withdrawn, true);
  }
 });

test('capped authorization comparison refuses the waiver', () => {
  for (const key of ['reviewedFiles', 'parentFiles']) {
    const e = structuredClone(evidence());
    e.reversalAuthorizations[0][key] = Array.from({ length: 300 }, () => file);
    assert.equal(checkPrimaryChange(e, head).reason, 'primary-change-reverted');
  }
});
test('same-head cross-family dispute withdraws the cited family finding without touching the review row', async (t) => {
  const h = disputeHarness(t);
  h.db.prepare("UPDATE reviewed_prs SET reviewer='claude'").run();
  const cited = { ...review, commit_id: head };
  h.deps.get = async (url) => url.includes('/reviews?') ? [cited,
    { ...cited, node_id: 'PRR_other_family', user: { login: 'lacey-gemini-reviewer[bot]' } }]
    : { state: 'open', head: { sha: head } };
  assert.equal((await disputeFinding(h.args, h.deps)).withdrawn, true);
  assert.ok(h.calls[0][1].startsWith(`HAM finding dispute — ${review.html_url} finding=1\n`));
  assert.deepEqual(h.db.prepare('SELECT reviewer, review_status FROM reviewed_prs').get(), { reviewer: 'claude', review_status: 'posted' });
});

test('primary-change reversal shares exact HAM and AMA dispatch ticket provenance', () => {
  for (const [ticket, allowed] of [['HAM', true], ['AMA-PR-42', true], ['ham', true],
    ['HAM-123', false], ['HAM anything', false], ['AMA-PR-x', false]]) {
    const e = structuredClone(evidence());
    e.reversalAuthorizations[0].commit.commit.message = commit.commit.message.replace('Worker-Ticket: HAM', `Worker-Ticket: ${ticket}`);
    assert.equal(checkPrimaryChange(e, head).ok, allowed, ticket);
  }
});


test('unlinked-author HAM reversal requires every terminal provenance trailer; bare rebase stamps refuse', () => {
  assert.equal(commit.author.login, null); // Captured production identity shape.
  for (const trailer of ['Worker-Class: hammer', 'Worker-Ticket: HAM',
    'Closed-By: hammer (adversarial-pipe-mode)']) {
    const e = structuredClone(evidence());
    e.reversalAuthorizations[0].commit.commit.message = commit.commit.message.replace(trailer, '');
    assert.equal(checkPrimaryChange(e, head).reason, 'primary-change-reverted', trailer);
  }
  const e = structuredClone(evidence());
  e.reversalAuthorizations[0].commit.author = { login: 'codex-worker-bot' };
  e.reversalAuthorizations[0].commit.commit.message = commit.commit.message.replace(
    'Closed-By: hammer (adversarial-pipe-mode)', '');
  assert.equal(checkPrimaryChange(e, head).reason, 'primary-change-reverted');
});
