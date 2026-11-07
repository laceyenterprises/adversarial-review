import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { buildPrBlocker, reviewCoverage, formatPrBlockers, makePrBlockersReport, reportAction } from '../src/pr-blockers.mjs';
import { collectPrBlockers, readPages, readReviewStore, readCloserLeases,
  readConflictFiles, readRemediation, readCloserReceipts } from '../src/pr-blockers-read.mjs';
import { parsePrBlockersArgs } from '../bin/pr-blockers.mjs';
import { nextAction, deriveNextActionSnapshot } from '../src/pr-next-action.mjs';

const repo = 'example/project', head = 'a'.repeat(40), previous = 'b'.repeat(40);
const now = Date.parse('2026-01-02T12:00:00Z');
const body = '# Adversarial Review\n\n## Verdict\nComment only\n\n## Blocking issues\n- None.\n\n## Non-blocking issues\n- None.\n';
const review = { headSha: head, body, postedAt: '2026-01-02T11:55:00Z' };
const green = { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-01-02T11:50:00Z' };
const pr = { number: 7, title: 'Synthetic change', state: 'OPEN', headRefOid: head, baseRefOid: previous,
  mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', labels: [], statusCheckRollup: [green],
  createdAt: '2026-01-01T12:00:00Z', updatedAt: '2026-01-02T11:55:00Z' };
const policy = { autonomousMergeExecutionEnabled: true, strictMode: true };
const observations = { leases: { closer: null }, launches: { closer: null },
  remediation: { roundsLeft: false } };
const row = changes => buildPrBlocker({ repo, pr: structuredClone(pr), review, observations, policy, now, ...changes });
const fixture = async t => {
  const root = await mkdtemp(join(tmpdir(), 'pr-blockers-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

test('coverage distinguishes no review, exact head, post-review authors and rebase', () => {
  assert.equal(reviewCoverage(null, head).kind, 'no-review');
  assert.equal(reviewCoverage(review, head).kind, 'exact-head');
  const stale = { ...review, headSha: previous };
  const coverage = reviewCoverage(stale, head, { status: 'ahead', commits: [
    { sha: head, author: { login: 'synthetic-builder' } },
    { sha: 'c'.repeat(40), commit: { author: { name: 'Synthetic Author' } } },
  ] });
  assert.equal(coverage.kind, 'post-review');
  assert.deepEqual(coverage.commits.map(commit => commit.author), ['synthetic-builder', 'Synthetic Author']);
  assert.ok(coverage.commits.every(commit => !commit.closerAttested));
  for (const status of ['behind', 'diverged']) assert.equal(reviewCoverage(stale, head, { status }).kind, 'rebased-since-review');
  assert.equal(reviewCoverage(stale, head, null).kind, 'unknown');
});

test('copied HAM trailers by an untrusted commenter never attest commits', () => {
  const coverage = reviewCoverage({ headSha: previous }, head, { status: 'ahead', commits: [{ sha: head }] },
    [{ user: { login: 'synthetic-builder' }, body: `HAM-Base-Head: ${previous}\nHAM-Pushed-Head: ${head}` }]);
  assert.equal(coverage.commits[0].closerAttested, false);
});

test('post-review authors distinguish authenticated closer edges from other commits', () => {
  const another = 'c'.repeat(40);
  const result = reviewCoverage({ headSha: previous }, head, { status: 'ahead',
    commits: [{ sha: another, author: { login: 'synthetic-builder' } },
      { sha: head, author: { login: 'synthetic-closer' } }] },
  [{ syntheticTrustedEdge: { base: another, head } }], comment => comment.syntheticTrustedEdge);
  assert.deepEqual(result.commits.map(commit => commit.closerAttested), [false, true]);
});

test('a closer edge attests intermediate commits, but never preceding or unknown-base commits', () => {
  const first = 'c'.repeat(40), middle = 'd'.repeat(40);
  const comparison = { status: 'ahead', commits: [first, middle, head].map(sha => ({ sha })) };
  const edge = base => [{ syntheticTrustedEdge: { base, head } }];
  const attest = base => reviewCoverage({ headSha: previous }, head, comparison, edge(base),
    comment => comment.syntheticTrustedEdge).commits.map(commit => commit.closerAttested);
  assert.deepEqual(attest(previous), [true, true, true]);
  assert.deepEqual(attest(first), [false, true, true]);
  assert.deepEqual(attest('e'.repeat(40)), [false, false, false]);
});

test('unreadable attestation evidence is not evidence that post-review commits are unattested', () => {
  const result = reviewCoverage({ headSha: previous }, head,
    { status: 'ahead', commits: [{ sha: head, author: { login: 'synthetic-closer' } }] }, null);
  assert.equal(result.commits[0].closerAttested, null);
});

test('clean exact-head green review is eligible and uses the shared daemon action', () => {
  const result = row();
  assert.equal(result.eligible, true);
  assert.equal(result.nextAction, 'merge-ready');
  assert.equal(result.decision.action, 'daemon-merge');
  assert.equal(result.ageMs, 86400000);
  assert.equal(result.review.blockingEmpty, true);
  const snapshot = deriveNextActionSnapshot({ subjectKey: `${repo}#7`, head, observedAt: new Date(now).toISOString(),
    anchors: { reviewPostedAt: review.postedAt, prUpdatedAt: pr.updatedAt },
    observations: { ...observations, pr, reviews: result.review,
      checks: { conclusion: 'SUCCESS', rollup: [green] }, policy } });
  assert.equal(result.decision.action, nextAction(snapshot).action);
  assert.equal(result.decision.reason, nextAction(snapshot).reason);
});

test('eligibility fails closed on missing findings, stale review, empty checks, and dirty head', () => {
  for (const changes of [
    { review: null }, { review: { ...review, body: '## Verdict\nApproved\n' } },
    { review: { ...review, headSha: previous } },
    { pr: { ...pr, statusCheckRollup: [] } }, { pr: { ...pr, mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' } },
    { reviewKnown: false }, { pr: { ...pr, state: 'MERGED' } },
  ]) assert.equal(row(changes).eligible, false);
});

test('each unreviewed coverage routes through exact-head review', () => {
  for (const changes of [{ review: null }, { review: { ...review, headSha: previous }, comparison: { status: 'diverged' } },
    { review: { ...review, headSha: previous }, comparison: { status: 'ahead', commits: [] } }]) {
    assert.equal(row(changes).nextAction, 'rereview-exact-head');
  }
});

test('strict mode retains non-blocking findings with the hammer', () => {
  const finding = '- **Synthetic finding**\n  - **File:** src/example.mjs\n  - **Lines:** 1\n  - **Problem:** incomplete result\n  - **Why it matters:** incorrect result\n  - **Recommended fix:** handle the case';
  const result = row({ review: { ...review, body: body.replace('## Non-blocking issues\n- None.', `## Non-blocking issues\n${finding}`) } });
  assert.equal(result.eligible, true); // diagnostic column is the ticket's blocking-only formula
  assert.equal(result.nextAction, 'hammer');
  assert.equal(result.decision.reason, 'review-findings-final');
});

test('PR-specific red CI projects shared repair, pending and empty CI remain waits', () => {
  const failed = { ...green, conclusion: 'FAILURE', steps: [{ status: 'completed', conclusion: 'failure' }] };
  const result = row({ pr: { ...pr, statusCheckRollup: [failed] } });
  assert.equal(result.nextAction, 'ci-fix');
  assert.deepEqual(result.ci.failing, ['unit']);
  assert.equal(result.eligible, false);
  const pending = row({ pr: { ...pr, statusCheckRollup: [{ ...green, status: 'QUEUED', conclusion: null }] } });
  assert.equal(pending.nextAction, 'wait-for-CI');
  assert.equal(pending.ci.pending, 1);
  assert.equal(row({ pr: { ...pr, statusCheckRollup: [] } }).ci.conclusion, null);
});

test('CI details use latest run and include required missing contexts', () => {
  const result = row({ pr: { ...pr, statusCheckRollup: [
    { ...green, conclusion: 'FAILURE', startedAt: '2026-01-02T11:40:00Z' }, green,
  ] }, cfg: { requiredCheckContexts: ['unit', 'integration'] } });
  assert.deepEqual(result.ci.failing, []);
  assert.equal(result.ci.pending, 1);
  assert.equal(result.eligible, false);
});

test('durable ownership and deadlines precede CI repair and stale review', () => {
  const lease = { headSha: head, status: 'dispatched', acquiredAt: '2026-01-02T11:40:00Z',
    deadlineAt: '2026-01-02T12:10:00Z', lrqId: 'synthetic-launch' };
  const owned = { ...observations, leases: { closer: lease }, launches: { closer: {
    headSha: head, row: { status: 'running' }, retryChain: [], deadlineAt: lease.deadlineAt,
  } } };
  const result = row({ observations: owned, review: { ...review, headSha: previous } });
  assert.equal(result.nextAction, 'wait-closer');
  assert.equal(result.closer.ageMs, 20 * 60000);
  assert.equal(result.closer.deadlineStatus, 'within-deadline');
  const overdue = row({ observations: { ...owned, launches: { closer: {
    ...owned.launches.closer, deadlineAt: '2026-01-02T11:59:00Z',
  } } } });
  assert.equal(overdue.nextAction, 'closer-overdue');
});

test('expired unlaunched lease and unknown ownership cannot suggest merge-ready', () => {
  const expired = row({ observations: { ...observations, leases: { closer: {
    headSha: head, status: 'pending', acquiredAt: '2026-01-01T12:00:00Z',
  } } } });
  assert.equal(expired.nextAction, 'closer-overdue');
  const unknown = row({ observations: { ...observations, leases: { state: 'error', value: null } } });
  assert.equal(unknown.nextAction, 'wait-closer');
  assert.equal(unknown.decision.reason, 'ownership-unreadable');
});

test('expired owner deadline is distinct from a freshly anchored recovery deadline', () => {
  const result = row({ pr: { ...pr, updatedAt: '2026-01-02T11:59:00Z' },
    observations: { ...observations, leases: { closer: {
      headSha: head, status: 'dispatched', acquiredAt: '2026-01-02T10:00:00Z',
    } } } });
  assert.equal(result.nextAction, 'closer-overdue');
  assert.equal(result.closer.deadline, '2026-01-02T10:30:00.000Z');
  assert.equal(result.closer.deadlineStatus, 'overdue');
  assert.equal(result.decision.deadline.at, '2026-01-02T12:04:00.000Z');
});

test('live reviewer and remediator retain their shared actions even past the decision deadline', () => {
  for (const [actor, action] of [['reviewer', 'review'], ['remediator', 'remediate']]) {
    assert.equal(reportAction({ actor, action, reason: 'live-owner',
      deadline: { at: '2026-01-01T12:00:00Z' } }, { now }), action);
  }
});

test('CI observer deadlines and terminal lease deadlines never become owner deadlines', () => {
  for (const lease of [null, { status: 'terminal', headSha: head,
    acquiredAt: '2026-01-01T12:00:00Z', deadlineAt: '2026-01-01T12:30:00Z' }]) {
    const result = row({ pr: { ...pr, statusCheckRollup: [{ ...green, status: 'QUEUED', conclusion: null }] },
      observations: { ...observations, leases: { closer: lease } } });
    assert.equal(result.closer.deadline, null);
    assert.equal(result.closer.deadlineStatus, 'unknown');
    assert.ok(result.decision.deadline.at);
    const text = formatPrBlockers(makePrBlockersReport([result], new Date(now).toISOString()));
    assert.ok(text.includes('NEXT ACTOR DEADLINE'));
    assert.ok(text.includes(result.decision.deadline.at));
  }
});

test('stale duplicate hold is only a superseded question and preserves safety refusal', () => {
  const result = row({ pr: { ...pr, labels: ['duplicate-family-hold'] },
    review: { ...review, headSha: previous }, comparison: { status: 'diverged' } });
  assert.equal(result.nextAction, 'superseded?');
  assert.equal(result.decision.reason, 'safety-refusal');
  assert.equal(row({ pr: { ...pr, labels: ['do-not-merge'] } }).nextAction, 'operator-hold');
});

test('generated-only conflict action requires complete nonempty conflict evidence', () => {
  const dirty = { ...pr, mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' };
  const result = row({ pr: dirty, conflicts: { state: 'complete', files: [
    { path: 'docs/catalog.json', generated: true },
  ], generatedOnly: true } });
  assert.equal(result.nextAction, 'rebase-generated-only');
  assert.equal(result.eligible, false);
  for (const conflicts of [{ state: 'unavailable', files: [], generatedOnly: false },
    { state: 'complete', files: [{ path: 'src/example.mjs', generated: false }], generatedOnly: false }]) {
    assert.equal(row({ pr: dirty, conflicts }).nextAction, 'hammer');
  }
});

test('text output includes all columns, full conflict names, and strips terminal controls', () => {
  const result = row({ pr: { ...pr, title: '\u001b[31mSynthetic' } });
  const output = formatPrBlockers(makePrBlockersReport([result], new Date(now).toISOString()));
  for (const column of ['COVERAGE', 'VERDICT', 'CI FAIL', 'OWNER', 'ELIGIBLE', 'NEXT ACTION', 'CONFLICTS']) {
    assert.ok(output.includes(column));
  }
  assert.ok(!output.includes('\u001b'));
});

test('pagination does not silently omit open PRs after the first page', async () => {
  const calls = [];
  const rows = await readPages(async path => {
    calls.push(path);
    return path.endsWith('page=1') ? Array.from({ length: 100 }, (_, number) => ({ number })) : [{ number: 101 }];
  }, 'repos/example/project/pulls?state=open');
  assert.equal(rows.length, 101);
  assert.equal(calls.length, 2);
});

test('CLI requires explicit repositories and validates repeated options', () => {
  assert.throws(() => parsePrBlockersArgs([]));
  assert.throws(() => parsePrBlockersArgs(['--repo', '../project']));
  const args = parsePrBlockersArgs(['--repo', repo, '--repo', 'example/other', '--json',
    '--checkout', 'example/project=synthetic-checkout']);
  assert.deepEqual(args.repos, [repo, 'example/other']);
  assert.equal(args.json, true);
  assert.equal(args.checkouts[repo], 'synthetic-checkout');
});

test('review store reads genuine posted passes without bootstrapping or changing bytes', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'data'));
  const path = join(root, 'data', 'reviews.db');
  const db = new Database(path);
  db.exec(`CREATE TABLE reviewed_prs(repo TEXT, pr_number INTEGER, reviewer TEXT);
    CREATE TABLE reviewer_passes(repo TEXT, pr_number INTEGER, pass_id INTEGER,
      pass_kind TEXT, head_sha TEXT, body_md TEXT, gh_comment_id TEXT, body_captured_at TEXT, ended_at TEXT);
    INSERT INTO reviewed_prs VALUES('example/project', 7, 'lacey-claude-reviewer');`);
  const insert = db.prepare('INSERT INTO reviewer_passes VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run(repo, 7, 1, 'first-pass', head, body, '11', review.postedAt, review.postedAt);
  insert.run(repo, 7, 2, 'rereview', previous, body, null, review.postedAt, review.postedAt);
  db.close();
  const before = await readFile(path);
  assert.equal(readReviewStore(root, repo, 7).pass.head_sha, head);
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readdir(join(root, 'data')), ['reviews.db']);
  const missing = await fixture(t);
  assert.throws(() => readReviewStore(missing, repo, 7));
  assert.deepEqual(await readdir(missing), []);
});

test('lease reads isolate repository and PR identities and create no lock files', async t => {
  const root = await fixture(t);
  const dir = join(root, 'data', 'ama-closer-leases');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `example__project-pr-7-${head}.json`), JSON.stringify({ repo, prNumber: 7, headSha: head, status: 'pending' }));
  await writeFile(join(dir, `example__project-pr-77-${head}.json`), '{invalid');
  const result = await readCloserLeases(root, repo, 7);
  assert.equal(result.length, 1);
  assert.deepEqual(await readdir(join(root, 'data')), ['ama-closer-leases']);
  await writeFile(join(dir, `example__project-pr-7-${head}.json`), JSON.stringify({ repo, prNumber: 7, headSha: head, status: 'unknown-status' }));
  await assert.rejects(readCloserLeases(root, repo, 7), /unknown closer lease status/);
});

test('a historical no-sha or malformed receipt explicitly fails the whole ownership read', async t => {
  const root = await fixture(t);
  const dir = join(root, 'data', 'follow-up-jobs', 'ama-closer-dispatches');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'example__project-pr-7-no-sha.json');
  await writeFile(path, JSON.stringify({ repo, prNumber: 7, headSha: null }));
  await assert.rejects(readCloserReceipts(root, repo, 7), /malformed ownership record.*no-sha/);
  await writeFile(path, '{invalid');
  await assert.rejects(readCloserReceipts(root, repo, 7), SyntaxError);
  const report = await collectPrBlockers(collectorOptions({ root }));
  assert.equal(report.rows[0].decision.reason, 'ownership-unreadable');
  assert.ok(report.rows[0].errors.includes('closer receipts unavailable'));
});

test('remediation reader treats an active job without a ledger observation as unknown', async t => {
  const root = await fixture(t);
  const dir = join(root, 'data', 'follow-up-jobs', 'in-progress');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'example__project-pr-7-job.json'), JSON.stringify({
    repo, prNumber: 7, status: 'in_progress', createdAt: review.postedAt,
  }));
  const result = await readRemediation(root, repo, 7);
  assert.equal(result.ownershipUnknown, true);
  assert.equal(result.job.live, false);
});

test('real offline merge-tree detects generated-only conflicts without modifying checkout or objects', async t => {
  const root = await fixture(t);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Synthetic Author', GIT_AUTHOR_EMAIL: 'author@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic Author', GIT_COMMITTER_EMAIL: 'author@example.invalid' } }).trim();
  git(['init', '-q']);
  await writeFile(join(root, 'catalog.json'), 'initial\n');
  git(['add', 'catalog.json']); git(['commit', '-qm', 'initial']);
  const base = git(['rev-parse', 'HEAD']);
  await writeFile(join(root, 'catalog.json'), 'left\n');
  git(['commit', '-qam', 'left']);
  const left = git(['rev-parse', 'HEAD']);
  git(['checkout', '-q', '--detach', base]);
  await writeFile(join(root, 'catalog.json'), 'right\n');
  git(['commit', '-qam', 'right']);
  const right = git(['rev-parse', 'HEAD']);
  const before = git(['count-objects', '-v']);
  const conflicts = await readConflictFiles({ checkout: root, base: left, head: right, generatedPaths: ['catalog.json'] });
  assert.deepEqual(conflicts, { state: 'complete', files: [{ path: 'catalog.json', generated: true }], generatedOnly: true });
  assert.equal(git(['rev-parse', 'HEAD']), right);
  assert.equal(git(['status', '--porcelain']), '');
  assert.equal(git(['count-objects', '-v']), before);
  assert.equal((await readConflictFiles({ checkout: root, base: 'c'.repeat(40), head: right })).state, 'unavailable');
});

const collectorOptions = changes => ({
  repos: [repo], root: 'synthetic-root', now, cfg: { getMergeAuthorityConfig: () => policy },
  fetchPr: async () => pr, readStore: () => ({ row: null, pass: null }),
  leasesRead: async () => [], remediationRead: async () => ({ job: null, roundsLeft: false }),
  enrichChecks: async ({ rollup }) => rollup,
  authoritativeLogins: ['lacey-claude-reviewer'],
  get: async path => {
    if (path === 'rate_limit') return { resources: { core: { remaining: 5000 } } };
    if (path.includes('/reviews?')) return [];
    if (path.includes('/pulls?')) return [{ number: 7, created_at: pr.createdAt }];
    return { state: 'open', head: { sha: head } };
  }, ...changes,
});

test('collector refuses low or unreadable core rate budgets before any PR reads', async () => {
  for (const rate of [{ resources: { core: { remaining: 999 } } }, {}]) {
    const calls = [];
    const report = await collectPrBlockers(collectorOptions({ get: async path => {
      calls.push(path);
      return rate;
    } }));
    assert.deepEqual(calls, ['rate_limit']);
    assert.deepEqual(report.rows, []);
    assert.match(report.errors[0], /rate budget/);
  }
});

test('a pathological paginated list cannot exceed the report REST budget', async () => {
  let calls = 0;
  const report = await collectPrBlockers(collectorOptions({ get: async path => {
    calls++;
    if (path === 'rate_limit') return { resources: { core: { remaining: 5000 } } };
    if (path.includes('/reviews?')) return Array.from({ length: 100 }, () => ({ state: 'PENDING' }));
    if (path.includes('/pulls?')) return [{ number: 7 }];
    return { state: 'open', head: { sha: head } };
  } }));
  assert.equal(calls, 200);
  assert.equal(report.rows[0].eligible, false);
  assert.ok(report.errors.some(error => error.includes('REST read budget')));
});

test('collector caps PR reads across repositories and reports omitted rows', async () => {
  const options = collectorOptions({ limit: 1, repos: [repo, 'example/other'] });
  const calls = [];
  const report = await collectPrBlockers({ ...options, get: async path => {
    calls.push(path);
    if (path.includes('/pulls?')) return [{ number: 7 }, { number: 8 }];
    return options.get(path);
  } });
  assert.equal(report.rows.length, 1);
  assert.ok(report.errors.some(error => error.includes('additional PRs omitted')));
  assert.ok(!calls.some(path => path.includes('/pulls/8') || path.includes('example/other')));
  assert.equal(parsePrBlockersArgs(['--repo', repo]).limit, 25);
  assert.equal(parsePrBlockersArgs(['--repo', repo, '--limit', '2']).limit, 2);
  for (const limit of ['0', '-1', '101', '1.5', 'NaN']) {
    assert.throws(() => parsePrBlockersArgs(['--repo', repo, '--limit', limit]));
  }
});

test('real remediationWorker job shapes resolve live HQ ownership without treating dispatchId as LRQ', async t => {
  const root = await fixture(t);
  const dir = join(root, 'data', 'follow-up-jobs', 'in-progress');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'example__project-pr-7-job.json');
  for (const key of ['launchRequestId', 'launchRequestID', 'lrq']) {
    await writeFile(path, JSON.stringify({ repo, prNumber: 7, status: 'in_progress',
      headSha: head, createdAt: review.postedAt,
      remediationWorker: { dispatchMode: 'hq', [key]: 'synthetic-remediator' } }));
    const report = await collectPrBlockers(collectorOptions({ root, remediationRead: readRemediation,
      launchRead: async ({ launchRequestId }) => {
        assert.equal(launchRequestId, 'synthetic-remediator');
        return { state: 'complete', value: { launch: { status: 'running' }, retryChain: [] } };
      } }));
    assert.equal(report.rows[0].decision.reason, 'live-owner');
    assert.equal(report.rows[0].decision.actor, 'remediator');
    assert.equal(report.rows[0].nextAction, 'remediate');
    assert.deepEqual(report.rows[0].errors, []);
  }
  for (const status of ['pending', 'in_progress']) {
    await writeFile(path, JSON.stringify({ repo, prNumber: 7, status,
      createdAt: review.postedAt, remediationWorker: { dispatchMode: 'hq', dispatchId: 'not-an-lrq' } }));
    assert.equal((await readRemediation(root, repo, 7)).launchRequestId, null);
    const report = await collectPrBlockers(collectorOptions({ root, remediationRead: readRemediation }));
    assert.equal(report.rows[0].decision.reason, 'ownership-unreadable');
    assert.ok(report.rows[0].errors.includes('active remediation has no launch-request ID; ownership unknown'));
  }
});

test('review families sharing a head are unknown rather than optimistic eligibility', async () => {
  const options = collectorOptions({ authoritativeLogins: ['lacey-claude-reviewer', 'lacey-codex-reviewer'] });
  const report = await collectPrBlockers({ ...options, get: async path => path.includes('/reviews?')
    ? [{ user: { login: 'lacey-claude-reviewer' }, state: 'CHANGES_REQUESTED', commit_id: head,
      body: '## Verdict\nRequest changes', submitted_at: review.postedAt },
    { user: { login: 'lacey-codex-reviewer' }, state: 'COMMENTED', commit_id: head,
      body, submitted_at: '2026-01-02T11:59:00Z' }] : options.get(path) });
  assert.equal(report.rows[0].eligible, false);
  assert.equal(report.rows[0].coverage.kind, 'unknown');
  assert.equal(report.rows[0].decision.reason, 'reviews-unknown');
  assert.equal(report.rows[0].review.blockingEmpty, null);
});

test('review selection walks ancestry past a newer review from a discarded branch', async () => {
  const options = collectorOptions();
  const report = await collectPrBlockers({ ...options, get: async path => {
    if (path.includes('/reviews?')) return [
      { user: { login: 'lacey-claude-reviewer' }, state: 'COMMENTED', commit_id: head,
        body, submitted_at: review.postedAt },
      { user: { login: 'lacey-claude-reviewer' }, state: 'COMMENTED', commit_id: previous,
        body, submitted_at: '2026-01-02T11:59:00Z' }];
    if (path.includes('/compare/')) return { status: 'diverged', commits: [] };
    return options.get(path);
  } });
  assert.equal(report.rows[0].coverage.kind, 'exact-head');
  assert.equal(report.rows[0].nextAction, 'merge-ready');
});

test('collector reports unreadable reviews as unknown and preserves partial repository errors', async () => {
  const options = collectorOptions();
  const report = await collectPrBlockers({ ...options, repos: [repo, 'example/other'], get: async path => {
    if (path.includes('example/other') || path.includes('/reviews?')) throw new Error('synthetic read error');
    return options.get(path);
  } });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].coverage.kind, 'unknown');
  assert.equal(report.rows[0].eligible, false);
  assert.equal(report.rows[0].decision.reason, 'reviews-unknown');
  assert.deepEqual(report.errors, ['example/other: open PR list unavailable']);
});

test('collector selects the latest authenticated submitted review and ignores a copied approval', async () => {
  const options = collectorOptions();
  const result = await collectPrBlockers({ ...options, get: async path => path.includes('/reviews?')
    ? [{ user: { login: 'lacey-claude-reviewer' }, state: 'COMMENTED', commit_id: head,
      body, submitted_at: review.postedAt },
    { user: { login: 'synthetic-builder' }, state: 'APPROVED', commit_id: previous,
      body, submitted_at: '2026-01-02T11:59:00Z' }] : options.get(path) });
  assert.equal(result.rows[0].coverage.kind, 'exact-head');
  assert.equal(result.rows[0].nextAction, 'merge-ready');
  assert.deepEqual(result.rows[0].errors, []);
});

test('collector retains live launch receipt ownership after its lease disappears', async () => {
  const options = collectorOptions({
    receiptsRead: async () => [{ repo, prNumber: 7, headSha: head, launchRequestId: 'synthetic-launch' }],
    launchRead: async () => ({ state: 'complete', value: {
      launch: { status: 'running' }, retryChain: [], launchRequestId: 'synthetic-launch',
    } }),
  });
  const result = await collectPrBlockers(options);
  assert.equal(result.rows[0].nextAction, 'wait-closer');
  assert.equal(result.rows[0].decision.reason, 'live-owner');
});

test('an earlier-head closer lease requests reconciliation instead of inventing absent ownership', async () => {
  const report = await collectPrBlockers(collectorOptions({
    leasesRead: async () => [{ headSha: previous, status: 'dispatched', acquiredAt: review.postedAt }],
  }));
  assert.equal(report.rows[0].nextAction, 'wait-closer');
  assert.equal(report.rows[0].decision.reason, 'ownership-unreadable');
  assert.equal(report.rows[0].closer.headSha, previous);
  assert.equal(report.rows[0].closer.status, 'dispatched');
});

test('collector retains unknown currency when closer comments cannot be read', async () => {
  const options = collectorOptions();
  const report = await collectPrBlockers({ ...options, get: async path => {
    if (path.includes('/reviews?')) return [{ user: { login: 'lacey-claude-reviewer' }, state: 'COMMENTED',
      commit_id: previous, body, submitted_at: review.postedAt }];
    if (path.includes('/compare/')) return { status: 'ahead', total_commits: 1, commits: [{ sha: head }] };
    if (path.includes('/comments?')) throw new Error('synthetic comment read failure');
    return options.get(path);
  } });
  assert.equal(report.rows[0].coverage.kind, 'post-review');
  assert.equal(report.rows[0].coverage.commits[0].closerAttested, null);
  assert.equal(report.rows[0].decision.reason, 'reviews-unknown');
  assert.equal(report.rows[0].nextAction, 'wait-for-CI');
});

test('unreadable receipt and remediation ownership remain unknown rather than absent', async () => {
  for (const changes of [
    { receiptsRead: async () => { throw new Error('synthetic unreadable record'); } },
    { receiptsRead: async () => [{ headSha: head, state: 'dispatching' }] },
    { remediationRead: async () => ({ job: { status: 'in_progress' }, ownershipUnknown: true }) },
  ]) {
    const result = await collectPrBlockers(collectorOptions(changes));
    assert.equal(result.rows[0].nextAction, 'wait-closer');
    assert.equal(result.rows[0].decision.reason, 'ownership-unreadable');
  }
});

test('collector uses base-pinned declarations for generated-only dirty conflicts', async () => {
  const calls = [];
  const options = collectorOptions({
    fetchPr: async () => ({ ...pr, mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }),
    guardsRead: async args => {
      calls.push(args.baseRef);
      return [{ path: 'docs/catalog.json', check: 'generated outputs' }];
    },
    conflictRead: async args => {
      assert.deepEqual(args.generatedPaths, ['docs/catalog.json']);
      return { state: 'complete', files: [{ path: 'docs/catalog.json', generated: true }], generatedOnly: true };
    },
  });
  const result = await collectPrBlockers(options);
  assert.equal(result.rows[0].nextAction, 'rebase-generated-only');
  assert.deepEqual(calls, [previous]);
});

test('collector excludes terminal PRs on final live read', async () => {
  const options = collectorOptions();
  const report = await collectPrBlockers({ ...options, get: async path => path.endsWith('/pulls/7')
    ? { state: 'closed', merged_at: '2026-01-02T12:00:00Z' } : options.get(path) });
  assert.deepEqual(report.rows, []);
});

test('collector detects a head race and never carries CI onto the new head', async () => {
  const options = collectorOptions();
  const report = await collectPrBlockers({ ...options, get: async path => path.endsWith('/pulls/7')
    ? { state: 'open', head: { sha: previous } } : options.get(path) });
  assert.equal(report.rows[0].eligible, false);
  assert.equal(report.rows[0].ci.conclusion, null);
  assert.ok(report.rows[0].errors.includes('head changed or could not be verified; refresh report'));
});

function validateSchema(value, schema) {
  if (schema.const !== undefined) assert.deepEqual(value, schema.const);
  if (schema.enum) assert.ok(schema.enum.includes(value), `unexpected enum value: ${value}`);
  if (schema.type) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    assert.ok([schema.type].flat().some(type => actual === type || type === 'integer' && Number.isInteger(value)),
      `expected ${schema.type}, got ${actual}`);
  }
  if (schema.minimum !== undefined && value !== null) assert.ok(value >= schema.minimum);
  for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), `missing ${key}`);
  if (schema.type === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (schema.additionalProperties === false) assert.ok(Object.hasOwn(schema.properties, key), `unexpected ${key}`);
      if (schema.properties?.[key]) validateSchema(item, schema.properties[key]);
    }
  }
  if (schema.items) for (const item of value) validateSchema(item, schema.items);
}

test('JSON v1 round trips and validates field types and enums against the documented schema', async () => {
  const schema = JSON.parse(await readFile(new URL('../docs/pr-blockers.schema.json', import.meta.url), 'utf8'));
  const report = JSON.parse(JSON.stringify(makePrBlockersReport([row()], new Date(now).toISOString())));
  validateSchema(report, schema);
  assert.throws(() => validateSchema({ ...report, schemaVersion: 2 }, schema));
  assert.throws(() => validateSchema({ ...report, rows: [{ ...report.rows[0], eligible: 'yes' }] }, schema));
  const partial = await collectPrBlockers(collectorOptions({ fetchPr: async () => { throw new Error('synthetic outage'); } }));
  validateSchema(JSON.parse(JSON.stringify(partial)), schema);
});
