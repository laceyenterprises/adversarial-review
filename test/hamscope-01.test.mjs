import './helpers/dispatch-read-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../bin/hammer-edit-plan.mjs';
import { checkHammerEditPlan } from '../src/ama/hammer-edit-plan.mjs';
import { assertFindingDisputeOwner } from '../src/ama/finding-dispute-owner.mjs';
import { checkPrimaryChange } from '../src/ama/primary-change.mjs';
import { amaAllAuthoritativeReviewerLogins } from '../src/ama/reviewer-authority.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { updateReviewerPassBodyCapture } from '../src/review-body-capture.mjs';
import { collect, review as historyReview } from './helpers/hamclose-history.mjs';
import { captureReadyFindings, findingBacklogAlert, summarizeFindingBacklog } from '../src/findings-backlog.mjs';
import { createHash } from 'node:crypto';

const head = 'a'.repeat(40), repo = 'sample/service';
const body = `## Blocking Issues
- None.
## Non-blocking Issues
- **Keep routing simple**
  - **File:** \`src/router.mjs\`
  - **Lines:** 2
  - **Problem:** The routing table can be simplified.
## Verdict
Comment only
`;
const review = { id: 1, node_id: 'PRR_synthetic', state: 'COMMENTED', commit_id: head,
  user: { login: amaAllAuthoritativeReviewerLogins()[0] }, body };
const plan = { reviewedHead: head, kind: 'non-blocking', findingNumber: 1,
  editKind: 'author-lines', path: 'src/router.mjs', startLine: 2, endLine: 2 };

function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'hamscope-'));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  t.after(() => { db.close(); rmSync(rootDir, { recursive: true, force: true }); });
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,revision_ref)
    VALUES (?,7,'2026-01-01','codex','open',?)`).run(repo, head);
  const key = { repo, prNumber: 7, attemptNumber: 1, passKind: 'first-pass' };
  const pass = beginReviewerPass(rootDir, { ...key, reviewerClass: 'codex', headSha: head });
  updateReviewerPassBodyCapture(rootDir, { ...key, bodyMd: body, verdict: 'comment-only' });
  db.prepare("UPDATE reviewer_passes SET gh_comment_id='1',body_captured_at='2026-01-01' WHERE pass_id=?")
    .run(pass.pass_id);
  const planFile = join(rootDir, 'plan.json');
  const authorFile = join(rootDir, 'router.mjs');
  writeFileSync(planFile, JSON.stringify(plan));
  writeFileSync(authorFile, 'const routes = new Map();\n');
  return { rootDir, db, planFile, authorFile };
}

test('advisory author-line edit is deferred durably through the backlog with no author edit', async t => {
  const { rootDir, db, planFile, authorFile } = fixture(t);
  const before = readFileSync(authorFile, 'utf8');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await main([repo, '7', '1', planFile], {
      rootDir, readReviewImpl: async () => review,
      loadPolicy: () => ({ strictNonBlockingRemediation: false }),
    });
    assert.equal(result.action, 'defer');
    assert.equal(result.backlogRecorded, true);
    assert.match(result.reason, /^Deferred to findings backlog: [^\r\n]+$/);
    assert.equal(readFileSync(authorFile, 'utf8'), before);
  }
  const reopened = openReviewStateDb(rootDir);
  try {
    const rows = reopened.prepare('SELECT * FROM finding_backlog').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].head_sha, head);
    assert.equal(rows[0].outcome, null);
    assert.match(rows[0].reason, /advisory finding would change reviewed author code/);
  } finally { reopened.close(); }
  assert.equal(db.prepare('SELECT count(*) n FROM finding_batches').get().n, 0);
});

test('open-PR deferrals become overdue only after the source merges', t => {
  const { rootDir, db } = fixture(t);
  captureReadyFindings({ rootDir, repo, prNumber: 7, headSha: head, count: 1,
    version: createHash('sha256').update(body).digest('hex'),
    deferredFinding: { findingNumber: 1, reason: 'Deferred.' } });
  const now = Date.now() + 72 * 3600_000;
  const open = summarizeFindingBacklog(db, now);
  assert.equal(open.openCount, 1);
  assert.equal(open.areas[0].waitingForMerge, 1);
  assert.equal(findingBacklogAlert(open), null);
  db.prepare("UPDATE reviewed_prs SET pr_state='merged' WHERE repo=? AND pr_number=7").run(repo);
  assert.equal(findingBacklogAlert(summarizeFindingBacklog(db, now)).code, 'review:findings_backlog_overdue');
});

test('in-place CI and blocking repairs do not require reversal coverage', () => {
  const target = { ...plan, kind: undefined, findingNumber: undefined };
  const emptyReview = { ...review, body: '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nComment only' };
  assert.equal(checkHammerEditPlan(emptyReview,
    { ...target, editKind: 'in-place', requiredCiRepair: true }).action, 'allow');
  const blocking = historyReview();
  assert.equal(checkHammerEditPlan(blocking, { ...plan, reviewedHead: blocking.commit_id,
    editKind: 'in-place', kind: 'blocking', startLine: 45, endLine: 45 }).action, 'allow');
  assert.equal(checkHammerEditPlan(review, { ...plan, editKind: 'in-place' }).action, 'defer');
});

test('strict advisory in-place is a disallowed category, not malformed input, at helper and CLI seams', async t => {
  const { rootDir, db, planFile, authorFile } = fixture(t);
  const before = readFileSync(authorFile, 'utf8');
  const inPlace = { ...plan, editKind: 'in-place' };
  writeFileSync(planFile, JSON.stringify(inPlace));
  const expected = { action: 'stop', reason: 'advisory-in-place-disallowed' };
  assert.deepEqual(checkHammerEditPlan(review, inPlace, {
    strictNonBlockingRemediation: true,
  }), expected);
  // Missing strict policy also defaults to strict at the CLI boundary.
  for (const policy of [{}, { strictNonBlockingRemediation: true }]) {
    assert.deepEqual(await main([repo, '7', '1', planFile], {
      rootDir, readReviewImpl: async () => review, loadPolicy: () => policy,
      captureImpl: () => assert.fail('strict stops must not capture a deferral'),
    }), expected);
  }
  assert.deepEqual(checkHammerEditPlan(review, { ...inPlace, requiredCiRepair: true }, {
    strictNonBlockingRemediation: true,
  }), expected);
  writeFileSync(planFile, JSON.stringify({ ...inPlace, editKind: 'typo' }));
  assert.deepEqual(await main([repo, '7', '1', planFile], {
    rootDir, readReviewImpl: async () => review,
    loadPolicy: () => ({ strictNonBlockingRemediation: true }),
    captureImpl: () => assert.fail('malformed stops must not capture a deferral'),
  }), { action: 'stop', reason: 'edit-kind-invalid' });
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog').get().n, 0);
  assert.equal(readFileSync(authorFile, 'utf8'), before);
});

test('non-strict advisory in-place defers durably and cannot masquerade as CI repair', async t => {
  const { rootDir, db, planFile } = fixture(t);
  writeFileSync(planFile, JSON.stringify({ ...plan, editKind: 'in-place', requiredCiRepair: true }));
  const result = await main([repo, '7', '1', planFile], {
    rootDir, readReviewImpl: async () => review,
    loadPolicy: () => ({ strictNonBlockingRemediation: false }),
  });
  assert.equal(result.action, 'defer');
  assert.equal(result.backlogRecorded, true);
  assert.equal(db.prepare('SELECT head_sha FROM finding_backlog').get().head_sha, head);
});

test('strict advisory alternatives retain additive preservation and reviewed-coordinate coverage', () => {
  const strict = { strictNonBlockingRemediation: true };
  assert.deepEqual(checkHammerEditPlan(review, { ...plan, editKind: 'additive' }, strict),
    { action: 'allow', reason: 'additive-fix' });
  assert.deepEqual(checkHammerEditPlan(review, plan, strict),
    { action: 'allow', reason: 'finding-authorizes-planned-region' });
  assert.match(checkHammerEditPlan({
    ...review, body: body.replace('**Lines:** 2', '**Lines:** unknown'),
  }, { ...plan, editKind: 'in-place' }, strict).reason, /^finding-lines-unreadable:/);
  for (const changed of [{ path: 'src/other.mjs' }, { endLine: 3 }]) {
    assert.deepEqual(checkHammerEditPlan(review, { ...plan, ...changed }, strict),
      { action: 'stop', reason: 'not-covered-by-cited-finding' });
  }
  for (const strictNonBlockingRemediation of [false, true]) {
    const options = { strictNonBlockingRemediation };
    const inPlace = { ...plan, editKind: 'in-place' };
    assert.deepEqual(checkHammerEditPlan(review, { ...inPlace, startLine: 0 }, options),
      { action: 'stop', reason: 'edit-location-invalid' });
    assert.deepEqual(checkHammerEditPlan(review, { ...inPlace, findingNumber: 2 }, options),
      { action: 'stop', reason: 'finding-evidence-invalid' });
    assert.deepEqual(checkHammerEditPlan(review, { ...plan, editKind: 'typo' }, options),
      { action: 'stop', reason: 'edit-kind-invalid' });
    assert.deepEqual(checkHammerEditPlan({ ...review, commit_id: 'b'.repeat(40) }, inPlace, options),
      { action: 'stop', reason: 'review-evidence-invalid' });
    assert.deepEqual(checkHammerEditPlan({ ...review, user: { login: 'untrusted' } }, inPlace, options),
      { action: 'stop', reason: 'review-evidence-invalid' });
  }
});

test('advisory additive test is allowed and does not defer the finding', async t => {
  const { rootDir, db, planFile } = fixture(t);
  writeFileSync(planFile, JSON.stringify({ ...plan, editKind: 'additive', path: 'test/router.test.mjs' }));
  const result = await main([repo, '7', '1', planFile], {
    rootDir, readReviewImpl: async () => review,
    loadPolicy: () => ({ strictNonBlockingRemediation: false }),
  });
  assert.equal(result.action, 'allow');
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog').get().n, 0);
});

test('pre-edit and merge use the same finding predicate for blocking and strict non-blocking reversals', async () => {
  for (const kind of ['blocking', 'non-blocking']) for (const strict of [false, true]) {
    const cited = historyReview();
    if (kind === 'non-blocking') {
      cited.body = cited.body.replace('## Blocking issues', '## Non-blocking issues')
        .replace('## Non-blocking issues\n- None.', '').replace('Request changes', 'Comment only');
      cited.state = 'COMMENTED';
    }
    const planned = checkHammerEditPlan(cited, { ...plan, reviewedHead: cited.commit_id, kind,
      path: 'src/a.mjs', startLine: 10, endLine: 11 }, { strictNonBlockingRemediation: strict });
    const { evidence } = await collect({ reviews: [cited], cites: [`PRR_cited finding=1 kind=${kind}`] });
    const gated = checkPrimaryChange(evidence, evidence.headSha, { strictNonBlockingRemediation: strict });
    assert.equal(planned.action, kind === 'blocking' || strict ? 'allow' : 'defer');
    assert.equal(gated.ok, planned.action === 'allow', JSON.stringify(gated));
    if (!gated.ok) assert.equal(gated.reason, 'primary-change-reverted');
  }
});

test('untrusted, stale, malformed and uncovered evidence never permits an author-line edit', () => {
  for (const [candidate, edit] of [
    [{ ...review, commit_id: 'b'.repeat(40) }, plan],
    [{ ...review, user: { login: 'synthetic-author' } }, plan],
    [review, { ...plan, kind: 'unknown' }],
    [review, { ...plan, findingNumber: 2 }],
    [review, { ...plan, editKind: 'unknown' }],
    [review, { ...plan, endLine: 3 }],
    [review, { ...plan, path: 'src/other.mjs' }],
    [{ ...review, body: body.replace('**Lines:** 2', '**Lines:** unknown') }, plan],
  ]) {
    assert.equal(checkHammerEditPlan(candidate, edit, { strictNonBlockingRemediation: true }).action, 'stop');
  }
});

test('failed or stale backlog capture cannot return a successful deferral receipt', async t => {
  const { rootDir, db, planFile } = fixture(t);
  db.prepare("UPDATE reviewer_passes SET head_sha=?").run('b'.repeat(40));
  await assert.rejects(main([repo, '7', '1', planFile], {
    rootDir, readReviewImpl: async () => review,
    loadPolicy: () => ({ strictNonBlockingRemediation: false }),
  }), /findings-capture-not-current/);
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog').get().n, 0);
});

test('owner mismatch refuses deferral before any database write', async t => {
  const { rootDir, db, planFile } = fixture(t);
  let captured = false;
  await assert.rejects(main([repo, '7', '1', planFile], {
    rootDir, readReviewImpl: async () => review,
    loadPolicy: () => ({ strictNonBlockingRemediation: false }),
    assertOwner: (root) => assertFindingDisputeOwner(root, {
      geteuidImpl: () => process.geteuid() + 1,
    }),
    captureImpl: () => { captured = true; },
  }), error => error.exitCode === 78 && /refusing cross-user write/.test(error.message));
  assert.equal(captured, false);
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog').get().n, 0);
});

test('unknown canonical findings refuse deferral before capture', async t => {
  const { rootDir, planFile } = fixture(t);
  let captured = false;
  const malformed = { ...review, body: body.replace('**Keep routing simple**', '**<title>**')
    .replace('`src/router.mjs`', '`<path>`') };
  await assert.rejects(main([repo, '7', '1', planFile], {
    rootDir, readReviewImpl: async () => malformed,
    loadPolicy: () => ({ strictNonBlockingRemediation: false }),
    captureImpl: () => { captured = true; },
  }), /non-blocking-findings-unknown/);
  assert.equal(captured, false);
});

test('duplicate captured passes reuse the existing pending content identity', async t => {
  const { rootDir, db, planFile } = fixture(t);
  const dependencies = { rootDir, readReviewImpl: async () => review,
    loadPolicy: () => ({ strictNonBlockingRemediation: false }) };
  await main([repo, '7', '1', planFile], dependencies);
  const key = { repo, prNumber: 7, attemptNumber: 2, passKind: 'rereview' };
  const pass = beginReviewerPass(rootDir, { ...key, reviewerClass: 'codex', headSha: head });
  updateReviewerPassBodyCapture(rootDir, { ...key, bodyMd: body, verdict: 'comment-only' });
  db.prepare("UPDATE reviewer_passes SET gh_comment_id='2',body_captured_at='2026-01-02' WHERE pass_id=?")
    .run(pass.pass_id);
  assert.equal((await main([repo, '7', '2', planFile], dependencies)).action, 'defer');
  assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog').get().n, 1);
});

test('ordinary ready capture stays compatible and invalid deferral rolls back', t => {
  const { rootDir, db } = fixture(t);
  const args = { rootDir, repo, prNumber: 7, headSha: head, count: 1,
    version: createHash('sha256').update(body).digest('hex') };
  for (const deferredFinding of [
    { findingNumber: 2, reason: 'Deferred.' },
    { findingNumber: 1, reason: 'two\nlines' },
  ]) {
    assert.throws(() => captureReadyFindings({ ...args, deferredFinding }), /findings-deferral/);
    assert.equal(db.prepare('SELECT count(*) n FROM finding_backlog').get().n, 0);
  }
  assert.equal(captureReadyFindings(args), 1);
  assert.equal(captureReadyFindings(args), 0);
  assert.equal(db.prepare('SELECT reason FROM finding_backlog').get().reason, null);
});

test('hammer contract invokes the pre-edit helper and distinguishes deferred audit counts', () => {
  const prompt = readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8');
  assert.match(prompt, /Before editing any author-introduced line,[^\n]*bounded helper/);
  assert.match(prompt, /HAM_DISPUTE_OWNER=\$\(stat -f '%Su' <<ROOT_DIR>>\/data\/reviews\.db\)/);
  assert.match(prompt, /HAM_DISPUTE_RUN=\(sudo -A -H -u "\$HAM_DISPUTE_OWNER"/);
  assert.match(prompt, /alarm shift; exec @ARGV' 90 "\$\{HAM_DISPUTE_RUN\[@\]\}" "\$HAM_NODE_BIN" \\\n  <<ROOT_DIR>>\/bin\/hammer-edit-plan\.mjs/);
  assert.match(prompt, /Exit 20 records the non-blocking finding[^\n]*\nand means make no edit/);
  assert.match(prompt, /separate counts\n   for remediated and deferred findings/);
  const runbook = readFileSync(new URL('../docs/RUNBOOK-ama-closure.md', import.meta.url), 'utf8');
  for (const text of [prompt, runbook]) {
    assert.match(text, /stop\/advisory-in-place-disallowed/);
    assert.match(text, /both `kind` and `findingNumber` omitted/);
    assert.match(text, /mandate 0b/);
    assert.match(text, /`edit-kind-invalid`[\s\S]*unknown[\s\S]*category/);
  }
  assert.match(runbook, /B1[\s\S]*withdrawal[\s\S]*false blocking finding/);
});
