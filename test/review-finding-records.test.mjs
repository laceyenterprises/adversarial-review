import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { updateReviewerPassBodyCapture } from '../src/review-body-capture.mjs';
import Database from 'better-sqlite3';
import { attributeFindingCommits } from '../src/finding-commit-attribution.mjs';
import { main as findingsCli } from '../bin/review-findings.mjs';

const body = `## Blocking Issues
- **Validate the input**
  - **Category:** correctness
  - **File:** \`input.mjs\`
  - **Lines:** 2-3
  - **Problem:** Missing validation accepts an invalid value.
## Non-blocking Issues
- **Describe the result**
  - **Category:** documentation
  - **File:** \`guide.md\`
  - **Lines:** 1
  - **Problem:** The result lacks a description.
`;

function fixture(t, { capture = true, headSha = 'a'.repeat(40) } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'finding-records-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const key = { repo: 'sample/service', prNumber: 7, attemptNumber: 1, passKind: 'first-pass' };
  const pass = beginReviewerPass(root, { ...key, reviewerClass: 'codex',
    reviewerModel: 'sample-model', reasoningEffort: 'high', headSha });
  if (capture) updateReviewerPassBodyCapture(root, { ...key, bodyMd: body,
    verdict: 'request-changes', execution: { model: 'sample-model', effort: 'high' } });
  const db = openReviewStateDb(root);
  ensureReviewStateSchema(db);
  t.after(() => db.close());
  return { root, db, pass, key };
}

async function api() { return import('../src/review-finding-records.mjs'); }

function rawDiff(patch, file = 'input.mjs') {
  return `:100644 100644 aaaaaaa bbbbbbb M\0${file}\0\0diff --git a/${file} b/${file}\n${patch}`;
}



test('OSG-03: capture persists both severities and stable ids across a re-parse', async t => {
  const { db, pass } = fixture(t);
  const rows = db.prepare('SELECT * FROM review_findings ORDER BY ordinal').all();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.blocking), [1, 0]);
  assert.equal(rows[0].category, 'correctness');
  assert.equal(rows[0].reviewer_model, 'sample-model');
  assert.equal(rows[0].reasoning_effort, 'high');
  const { persistReviewFindings } = await api();
  persistReviewFindings(db, pass.pass_id);
  assert.deepEqual(db.prepare('SELECT * FROM review_findings ORDER BY ordinal').all(), rows);
});

test('OSG-03: remediation links an overlapping commit and leaves untouched findings unaddressed', async t => {
  const root = mkdtempSync(join(tmpdir(), 'finding-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'input.mjs'), 'one\ntwo\nthree\nfour\n');
  writeFileSync(join(root, 'guide.md'), 'guide\n');
  git('add', 'input.mjs', 'guide.md'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Initial fixture');
  const start = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'input.mjs'), 'prefix\nmore\none\ntwo\nthree\nfour\n');
  git('add', 'input.mjs'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Insert unrelated prefix');
  writeFileSync(join(root, 'input.mjs'), 'prefix\nmore\none\nvalidated\nthree\nfour\n');
  git('add', 'input.mjs'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Validate input');
  const fixed = git('rev-parse', 'HEAD');
  const { db, root: stateRoot } = fixture(t, { headSha: start });
  const { linkFindingRemediation, readReviewFindings } = await api();
  const job = { jobId: 'fixture-job', repo: 'sample/service', prNumber: 7,
    revisionRef: start, reviewBody: body, remediationPlan: { currentRound: 1, rounds: [{ round: 1,
      startHeadSha: start, resultingHeadSha: fixed }] }, remediationReply: { payload: {
      addressed: [{ title: 'Validate the input', finding: 'Validate input', action: 'Added validation', files: ['input.mjs'] }],
      nonBlocking: [{ title: 'Describe the result', finding: 'Describe result', action: 'Checked documentation', files: ['guide.md'] }],
    } } };
  linkFindingRemediation(db, { job, workspaceDir: root });
  linkFindingRemediation(db, { job, workspaceDir: root });
  const rows = readReviewFindings(db, { repo: job.repo, prNumber: job.prNumber });
  assert.equal(rows[0].remediations[0].commit_sha, fixed);
  assert.equal(rows[0].status, 'addressed');
  assert.equal(rows[1].remediations[0].commit_sha, null);
  assert.equal(rows[1].status, 'unaddressed');
  assert.equal(rows[1].remediations[0].reason, 'no-overlapping-commit');
  assert.equal(rows[0].remediations.length, 1);
  const { captureFindingRemediationSafe } = await import('../src/finding-remediation-capture.mjs');
  job.workspaceDir = root;
  assert.equal(captureFindingRemediationSafe({ rootDir: stateRoot, job }).linked, 2);
  const wrongHead = { ...job, jobId: 'other-job', revisionRef: 'f'.repeat(40) };
  assert.equal(linkFindingRemediation(db, { job: wrongHead, workspaceDir: root }).linked, 0);
});

test('single-line citations are addressed by a pure insertion at the cited line', async t => {
  const root = mkdtempSync(join(tmpdir(), 'finding-insertion-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const lines = Array.from({ length: 15 }, (_, i) => `line ${i + 1}\n`);
  writeFileSync(join(root, 'input.mjs'), lines.join(''));
  git('add', 'input.mjs');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Initial fixture');
  const start = git('rev-parse', 'HEAD');
  lines.splice(10, 0, 'validation guard\n');
  writeFileSync(join(root, 'input.mjs'), lines.join(''));
  git('add', 'input.mjs');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Insert validation');
  const fixed = git('rev-parse', 'HEAD');
  assert.match(git('diff', '--unified=0', start, fixed), /@@ -10,0 \+11 @@/);
  const { db, pass } = fixture(t, { capture: false, headSha: start });
  const { linkFindingRemediation, readReviewFindings } = await api();
  for (const citation of ['10', '10-10']) {
    const reviewBody = body.replace('**Lines:** 2-3', `**Lines:** ${citation}`);
    db.prepare('UPDATE reviewer_passes SET body_md=? WHERE pass_id=?').run(reviewBody, pass.pass_id);
    const job = { jobId: `insertion-${citation}`, repo: 'sample/service', prNumber: 7,
      revisionRef: start, reviewBody, remediationPlan: { currentRound: 1, rounds: [{ round: 1,
        startHeadSha: start, publishedHeadSha: fixed }] }, remediationReply: { payload: {
        addressed: [{ title: 'Validate the input', files: ['input.mjs'] }],
      } } };
    linkFindingRemediation(db, { job, workspaceDir: root });
    const [finding] = readReviewFindings(db);
    assert.equal(finding.status, 'addressed', citation);
    assert.equal(finding.remediations[0].commit_sha, fixed);
    assert.equal(finding.remediations[0].reason, 'overlapping-diff');
  }
});

test('dispute backfill waits for a posted comment and remains idempotent after posting', async t => {
  const { db, pass } = fixture(t, { capture: false });
  const { blockingFindingIdentity } = await import('../src/ama/hammer-adjudication.mjs');
  const { parseReviewFindings } = await import('../src/kernel/review-findings.mjs');
  const identity = blockingFindingIdentity(parseReviewFindings(body).blocking.findings[0]);
  db.prepare(`INSERT INTO ham_finding_disputes(repo, pr_number, identity, head_sha,
    finding_reviewed_head) VALUES (?, ?, ?, ?, ?)`)
    .run('sample/service', 7, identity, 'b'.repeat(40), 'a'.repeat(40));
  db.prepare('UPDATE reviewer_passes SET body_md=? WHERE pass_id=?').run(body, pass.pass_id);
  const { backfillReviewFindings, persistReviewFindings, syncFindingDisputes, readReviewFindings } = await api();
  assert.equal(backfillReviewFindings(db).inserted, 2);
  persistReviewFindings(db, pass.pass_id);
  syncFindingDisputes(db);
  assert.deepEqual(readReviewFindings(db)[0].disputes, []);
  assert.equal(readReviewFindings(db)[0].status, 'unaddressed');
  db.prepare(`UPDATE ham_finding_disputes SET comment_id=?, resolution='withdrawn-by-hammer'
    WHERE identity=?`).run('posted-comment', identity);
  syncFindingDisputes(db);
  backfillReviewFindings(db);
  const [finding] = readReviewFindings(db);
  assert.equal(finding.status, 'withdrawn');
  assert.deepEqual(finding.disputes.map(d => d.comment_id), ['posted-comment']);
  // Backfill must also link evidence posted before the finding was captured.
  db.prepare('DELETE FROM review_finding_disputes').run();
  assert.equal(syncFindingDisputes(db, { passId: pass.pass_id }), 1);
  assert.deepEqual(readReviewFindings(db)[0].disputes, finding.disputes);
});

test('OSG-03: hammer withdrawal is recorded only for the reviewed finding head', async t => {
  const { db } = fixture(t);
  const { blockingFindingIdentity } = await import('../src/ama/hammer-adjudication.mjs');
  const { parseReviewFindings } = await import('../src/kernel/review-findings.mjs');
  const identity = blockingFindingIdentity(parseReviewFindings(body).blocking.findings[0]);
  db.prepare(`INSERT INTO ham_finding_disputes(repo, pr_number, identity, head_sha,
    finding_reviewed_head, resolution, comment_id, evidence_sha256)
    VALUES (?, ?, ?, ?, ?, 'withdrawn-by-hammer', 'synthetic-comment', ?)`)
    .run('sample/service', 7, identity, 'b'.repeat(40), 'a'.repeat(40), 'c'.repeat(64));
  const { syncFindingDisputes, readReviewFindings } = await api();
  const rows = readReviewFindings(db, { repo: 'sample/service', prNumber: 7 });
  assert.equal(rows[0].status, 'withdrawn');
  assert.equal(rows[0].disputes[0].comment_id, 'synthetic-comment');
  assert.equal(rows[1].status, 'unaddressed');
  // A newer review's dispute must not overwrite the earlier observation.
  db.prepare(`UPDATE ham_finding_disputes SET finding_reviewed_head=?, head_sha=?, comment_id=?
    WHERE identity=?`).run('d'.repeat(40), 'e'.repeat(40), 'new-comment', identity);
  syncFindingDisputes(db);
  const retained = readReviewFindings(db, { repo: 'sample/service', prNumber: 7 });
  assert.equal(retained[0].disputes.length, 1);
  assert.equal(retained[0].disputes[0].comment_id, 'synthetic-comment');
});

test('OSG-03: stored-body backfill is idempotent', async t => {
  const { db, pass } = fixture(t, { capture: false });
  db.prepare('UPDATE reviewer_passes SET body_md = ? WHERE pass_id = ?').run(body, pass.pass_id);
  const { backfillReviewFindings } = await api();
  assert.equal(backfillReviewFindings(db).inserted, 2);
  const first = db.prepare('SELECT * FROM review_findings ORDER BY ordinal').all();
  assert.equal(backfillReviewFindings(db).inserted, 0);
  assert.deepEqual(db.prepare('SELECT * FROM review_findings ORDER BY ordinal').all(), first);
});

test('read API paginates within a pass and supports a read-only database', async t => {
  const { db, root, pass } = fixture(t);
  const { readReviewFindings } = await api();
  const readonly = new Database(join(root, 'data', 'reviews.db'), { readonly: true });
  t.after(() => readonly.close());
  const first = readReviewFindings(readonly, { limit: 1 });
  const next = readReviewFindings(readonly, { afterPassId: first[0].pass_id, afterOrdinal: first[0].ordinal, limit: 1 });
  assert.equal(next[0].blocking, 0);
  assert.equal(findingsCli(['show', '--db', join(root, 'data', 'reviews.db'), '--limit', '1']).findings.length, 1);
  db.prepare("UPDATE reviewer_passes SET verdict='dismissed', reviewer_model='actual-model', reasoning_effort='low' WHERE pass_id=?")
    .run(pass.pass_id);
  const updated = readReviewFindings(readonly);
  assert.equal(updated[0].status, 'dismissed');
  assert.equal(updated[0].reviewer_model, 'actual-model');
  assert.equal(updated[0].reasoning_effort, 'low');
});

test('changed bodies preserve history without counting obsolete findings', async t => {
  const { db, pass } = fixture(t);
  const { persistReviewFindings, readReviewFindings } = await api();
  db.prepare('UPDATE reviewer_passes SET body_md=? WHERE pass_id=?').run(body.replace('Validate the input', 'Check the input'), pass.pass_id);
  persistReviewFindings(db, pass.pass_id);
  assert.equal(readReviewFindings(db).length, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM review_findings').get().n, 3);
  assert.equal(readReviewFindings(db)[0].title, 'Check the input');
});

test('legacy review bodies and CRLF preserve their parsed identities', async t => {
  const { db, pass } = fixture(t, { capture: false });
  const { persistReviewFindings } = await api();
  const legacy = '## Blocking Issues\n- Title: Legacy finding\n  File: input.mjs\n  Lines: 2\n  Problem: Reject invalid input\n## Non-blocking Issues\n- None.\n';
  db.prepare('UPDATE reviewer_passes SET body_md=? WHERE pass_id=?').run(legacy, pass.pass_id);
  persistReviewFindings(db, pass.pass_id);
  const before = db.prepare('SELECT finding_id FROM review_findings').all();
  db.prepare('UPDATE reviewer_passes SET body_md=? WHERE pass_id=?').run(legacy.replaceAll('\n', '\r\n'), pass.pass_id);
  persistReviewFindings(db, pass.pass_id);
  assert.deepEqual(db.prepare('SELECT finding_id FROM review_findings').all(), before);
  ensureReviewStateSchema(db);
  assert.deepEqual(db.prepare('SELECT finding_id FROM review_findings').all(), before);
});

test('projection failure preserves body capture and reports the backfill requirement', t => {
  const { root, db, key } = fixture(t, { capture: false });
  db.exec("CREATE TRIGGER synthetic_projection_failure BEFORE INSERT ON review_findings BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
  const warnings = [];
  updateReviewerPassBodyCapture(root, { ...key, bodyMd: body, log: { warn: value => warnings.push(value) } });
  assert.equal(db.prepare('SELECT body_md FROM reviewer_passes').get().body_md, body);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_findings').get().n, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /backfill required/);
});

test('missing, nonlinear and over-budget history never invent addressing commits', () => {
  const findings = [{ finding_id: 'fixture', file: 'input.mjs', lines: '2' }];
  const base = { findings, workspaceDir: '/synthetic', startHead: 'a'.repeat(40), publishedHead: 'b'.repeat(40) };
  const missing = attributeFindingCommits({ ...base, exec: () => { throw new Error('fixture missing object'); } });
  assert.deepEqual(missing.get('fixture'), { commitSha: null, reason: 'missing-history' });
  assert.equal(attributeFindingCommits({ ...base, budgetMs: 0 }).get('fixture').reason, 'attribution-budget');
});

test('same-file changes outside the finding range do not count as addressing it', () => {
  const finding = { finding_id: 'fixture', file: 'input.mjs', lines: '2-3' };
  const start = 'a'.repeat(40), commit = 'b'.repeat(40);
  const result = attributeFindingCommits({ findings: [finding], workspaceDir: '/synthetic', startHead: start, publishedHead: commit,
    exec: (_command, args) => args.includes('rev-list') ? commit
      : args.includes('rev-parse') ? start
        : args.includes('diff') ? rawDiff('@@ -7 +7 @@\n-old\n+new\n') : '' });
  assert.equal(result.get('fixture').commitSha, null);
  assert.equal(result.get('fixture').reason, 'no-overlapping-commit');
});

test('pure insertion boundaries include the last cited line and shift earlier insertions', () => {
  const start = 'a'.repeat(40), prefix = 'b'.repeat(40), fixed = 'c'.repeat(40);
  const findings = ['10', '10-10', '8-10', '10-12', '11', '1'].map(lines => ({
    finding_id: lines, file: 'input.mjs', lines,
  }));
  const result = attributeFindingCommits({ findings, workspaceDir: '/synthetic', startHead: start, publishedHead: fixed,
    exec: (_command, args) => args.includes('rev-list') ? `${fixed}\n${prefix}`
      : args.includes('rev-parse') ? (args.includes(`${prefix}^1`) ? start : prefix)
        : args.includes('diff') ? (args.includes(prefix) && args.includes(fixed)
          ? rawDiff('@@ -11 +11 @@\n-old\n+new\n') : rawDiff('@@ -10,0 +11 @@\n+guard\n')) : '' });
  for (const lines of ['10', '10-10', '8-10', '10-12']) {
    assert.equal(result.get(lines).commitSha, prefix, lines);
  }
  // Inserting before line 11 shifts it to 12; changing line 11 later cannot
  // supply evidence for the original line 11. A distant finding is untouched.
  for (const lines of ['11', '1']) {
    assert.deepEqual(result.get(lines), { commitSha: null, reason: 'no-overlapping-commit' }, lines);
  }
});

test('attribution shares reviewer line formats and rejects invalid coordinates', () => {
  const start = 'a'.repeat(40), commit = 'b'.repeat(40);
  const inputs = ['~2-3', 'handler (~2-3)', '2 (RIGHT side, diff line 99)', '2; 8-9', 'input.mjs:2-3', '0', '-2', '4-2'];
  const findings = inputs.map((lines, i) => ({ finding_id: String(i), file: 'input.mjs', lines }));
  const results = attributeFindingCommits({ findings, workspaceDir: '/synthetic', startHead: start, publishedHead: commit,
    exec: (_command, args) => args.includes('rev-list') ? commit
      : args.includes('rev-parse') ? start
        : args.includes('diff') ? rawDiff('@@ -2 +2 @@\n-old\n+new\n') : '' });
  inputs.forEach((_input, i) => assert.equal(results.get(String(i)).commitSha, i < 5 ? commit : null));
});

test('ambiguous replies and pushback never supply addressing commits', async t => {
  const { db, pass } = fixture(t, { capture: false });
  const { persistReviewFindings, linkFindingRemediation, readReviewFindings } = await api();
  const repeated = body.replace('Describe the result', 'Validate the input')
    .replace('## Non-blocking Issues', '');
  db.prepare('UPDATE reviewer_passes SET body_md=? WHERE pass_id=?').run(repeated, pass.pass_id);
  persistReviewFindings(db, pass.pass_id);
  const job = { jobId: 'duplicate-job', repo: 'sample/service', prNumber: 7,
    revisionRef: 'a'.repeat(40), reviewBody: repeated,
    remediationPlan: { currentRound: 1, rounds: [{ round: 1, startHeadSha: 'a'.repeat(40), resultingHeadSha: 'b'.repeat(40) }] },
    remediationReply: { payload: { addressed: [{ title: 'Validate the input' }] } } };
  const attribute = ({ findings }) => new Map(findings.map(f => [f.finding_id, { commitSha: 'b'.repeat(40), reason: 'overlapping-diff' }]));
  linkFindingRemediation(db, { job, attribute });
  const ambiguous = readReviewFindings(db);
  assert.ok(ambiguous.every(r => r.status === 'unaddressed'));
  assert.ok(ambiguous.every(r => r.remediations[0].reason === 'ambiguous-reply'));
  job.remediationReply.payload = { addressed: [{ title: 'Validate the input', files: ['input.mjs'] }],
    pushback: [{ title: 'Validate the input', files: ['guide.md'] }] };
  linkFindingRemediation(db, { job, attribute });
  const linked = readReviewFindings(db);
  assert.equal(linked[0].status, 'addressed');
  assert.equal(linked[1].status, 'unaddressed');
  assert.ok(linked[1].remediations.some(r => r.reason === 'pushback'));
});


test('rescue: findings CLI retains the actionable argument error', () => {
  const command = fileURLToPath(new URL('../bin/review-findings.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [command, 'unknown-command'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /expected show, backlog, backfill or link-job/);
});

test('rescue: finding read executes three queries for a populated page', async t => {
  const { db } = fixture(t);
  const { readReviewFindings } = await api();
  let queries = 0;
  const counted = { prepare(sql) {
    const statement = db.prepare(sql);
    return { all(...args) { queries++; return statement.all(...args); } };
  } };
  const rows = readReviewFindings(counted);
  assert.equal(rows.length, 2);
  assert.equal(queries, 3);
  assert.ok(rows.every(row => row.remediations.length === 0 && row.disputes.length === 0));
});

test('rescue: posted dispute waits for its evidence head in triggers and backfill', async t => {
  const { db } = fixture(t);
  const { blockingFindingIdentity } = await import('../src/ama/hammer-adjudication.mjs');
  const { parseReviewFindings } = await import('../src/kernel/review-findings.mjs');
  const identity = blockingFindingIdentity(parseReviewFindings(body).blocking.findings[0]);
  const { syncFindingDisputes, readReviewFindings } = await api();
  db.prepare(`INSERT INTO ham_finding_disputes(repo, pr_number, identity,
    finding_reviewed_head, comment_id, resolution) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('sample/service', 7, identity, 'a'.repeat(40), 'head-late-comment', 'withdrawn-by-hammer');
  syncFindingDisputes(db);
  assert.deepEqual(readReviewFindings(db)[0].disputes, []);
  db.prepare('UPDATE ham_finding_disputes SET head_sha=? WHERE identity=?')
    .run('b'.repeat(40), identity);
  syncFindingDisputes(db);
  syncFindingDisputes(db);
  const [finding] = readReviewFindings(db);
  assert.equal(finding.status, 'withdrawn');
  assert.deepEqual(finding.disputes.map(d => [d.head_sha, d.comment_id]),
    [['b'.repeat(40), 'head-late-comment']]);
});

test('rescue: attribution batches candidate paths in one diff per commit', t => {
  const root = mkdtempSync(join(tmpdir(), 'finding-batch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env }).trim();
  git('init', '-q'); git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const files = ['ordinary.mjs', 'tab\tand-\u00e9.mjs', 'line\nbreak.mjs'];
  for (const file of files) writeFileSync(join(root, file), 'one\ntwo\n');
  git('add', '--', ...files); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Initial');
  const start = git('rev-parse', 'HEAD');
  for (const file of files) writeFileSync(join(root, file), 'fixed\ntwo\n');
  git('add', '--', ...files); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Fix all paths');
  const fixed = git('rev-parse', 'HEAD');
  let diffs = 0;
  const result = attributeFindingCommits({
    findings: files.map(file => ({ finding_id: file, file, lines: '1' })),
    workspaceDir: root, startHead: start, publishedHead: fixed, budgetMs: 15000,
    exec(command, args, options) {
      if (args.includes('diff')) diffs++;
      return execFileSync(command, args, { ...options, env });
    },
  });
  for (const file of files) assert.equal(result.get(file).commitSha, fixed, file);
  assert.equal(diffs, 1);
});
