import { renderHammerProcedure } from '../src/hammer-procedure.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disputeFinding } from '../src/ama/finding-dispute.mjs';
import { dismissWithdrawnReviews } from '../src/ama/withdrawn-review-dismissal.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { composeAmaTrailers } from '../src/ama/audit.mjs';

const root = new URL('..', import.meta.url).pathname;
const repo = 'fixture/repo', prNumber = 42, headSha = 'a'.repeat(40);
const body = '## Blocking issues\n- **False finding**\n  - **File:** `src/example.mjs`\n  - **Problem:** Broken.\n\n## Non-blocking issues\n- None.\n\n## Verdict\nRequest changes';
const review = { id: 17, node_id: 'PRR_17', html_url: 'https://github.com/fixture/repo/pull/42#pullrequestreview-17',
  commit_id: headSha, body, state: 'CHANGES_REQUESTED', user: { login: 'lacey-codex-reviewer[bot]' } };

async function fixture(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'withdrawn-review-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const db = openReviewStateDb(rootDir); ensureReviewStateSchema(db); t.after(() => db.close());
  const comments = [], reviews = [structuredClone(review)], mutations = [];
  let headReads = 0;
  const identity = { rootDir, repo, prNumber, headSha };
  const deps = {
    get: async (path) => {
      if (path.includes('/reviews?')) return reviews;
      if (path.includes('/comments?')) return comments;
      if (path.endsWith('/reviews/17')) return reviews[0];
      headReads++;
      return { state: 'open', head: { sha: headSha } };
    },
    dismiss: async (path, message) => { mutations.push({ path, message }); reviews[0].state = 'DISMISSED'; },
  };
  await disputeFinding({ ...identity, reviewRef: review.node_id, findingNumber: 1,
    evidence: '```\n$ node repro.mjs\nPASS\n```' }, { ...deps, db, logger: {}, postComment: async (body) => {
    const comment = { node_id: 'IC_1', body, user: { login: 'the-hammer-lacey[bot]' } };
    comments.push(comment); return comment;
  } });
  return { ...identity, identity, deps, db, comments, reviews, mutations, headReads: () => headReads };
}

const reviewedHead = 'b'.repeat(40), queuedHead = 'c'.repeat(40);

function dismissedAfterHeadMove(f) {
  f.reviews[0] = { ...review, commit_id: reviewedHead, state: 'DISMISSED',
    user: { login: 'lacey-gemini-reviewer[bot]' },
    body: body.replace('False finding', 'Admission stall').replace('- None.', '- **Optional-chain advisory**') };
  // Terminal validation repaired the blocker. Only the advisory was disputed,
  // so the full predicate supplies no HAMFINAL blocker identities.
  f.db.prepare('DELETE FROM ham_finding_disputes').run();
  f.comments.splice(0, 1, {
    node_id: 'IC_audit', user: { login: 'the-hammer-lacey[bot]' },
    body: '## Findings addressed\n- **Admission stall** (blocking)\n'
      + '- **Optional-chain advisory** (non-blocking)\n\nResolution: withdrawn-by-hammer\n'
      + '```js\nconst row = null;\nconsole.log(row?.[3].match(/node/)?.[1]); // undefined\n```',
  });
  return {
    id: 37162162876, event: 'review_dismissed',
    actor: { login: 'lacey-merge-agent[bot]', type: 'Bot' },
    dismissed_review: { review_id: 17, state: 'changes_requested',
      dismissal_message: `Request changes judged commit ${reviewedHead}; current head is ${queuedHead}. `
        + 'Re-review requested at 2026-11-24T17:51:24.176Z is queued or running for the current head; dismissing the superseded review.' },
  };
}

test('repaired blocker and disputed advisory survive an authenticated queued re-review dismissal', async t => {
  const f = await fixture(t);
  const event = dismissedAfterHeadMove(f);
  const admission = { ...f.identity, terminalReviewedHead: reviewedHead, expectedWithdrawnIdentities: [] };
  const run = ({ input = admission, events = [event], liveReview = f.reviews[0], livePr } = {}) =>
    dismissWithdrawnReviews(input, { ...f.deps, get: async path => {
      if (path.includes('/compare/')) return { status: 'ahead' };
      if (path === `repos/${repo}/issues/${prNumber}/timeline?per_page=100`) return events;
      if (path.endsWith('/reviews/17')) return liveReview;
      if (livePr && path.endsWith('/pulls/42')) return livePr;
      return f.deps.get(path);
    } });
  assert.deepEqual(await run(), { dismissed: [] });
  for (const [name, invalid] of Object.entries({
    'missing event': { events: [] },
    'ambiguous events': { events: [event, { ...event, id: event.id + 1 }] },
    'wrong reviewer ID': { events: [{ ...event, dismissed_review: { ...event.dismissed_review, review_id: 18 } }] },
    'human actor': { events: [{ ...event, actor: { ...event.actor, type: 'User' } }] },
    'foreign bot': { events: [{ ...event, actor: { ...event.actor, login: 'other[bot]' } }] },
    'withdrawal dismissal': { events: [{ ...event, dismissed_review: { ...event.dismissed_review, dismissal_message: 'HAMFINAL-01: all findings withdrawn-by-hammer' } }] },
    'wrong judged head': { events: [{ ...event, dismissed_review: { ...event.dismissed_review,
      dismissal_message: event.dismissed_review.dismissal_message.replace(reviewedHead, headSha) } }] },
    'no head move': { events: [{ ...event, dismissed_review: { ...event.dismissed_review,
      dismissal_message: event.dismissed_review.dismissal_message.replace(queuedHead, reviewedHead) } }] },
    'wrong terminal reviewed head': { input: { ...admission, terminalReviewedHead: queuedHead } },
  })) {
    await t.test(name, async () => assert.rejects(run(invalid), /dismissed review withdrawal authority is missing or invalid/));
  }
  await assert.rejects(run({ input: { ...admission, expectedWithdrawnIdentities: ['invalid'] } }),
    /admitted withdrawal authority is missing or invalid/);
  for (const replacement of [
    { body: 'edited review' }, { user: { login: 'other[bot]' } }, { commit_id: headSha }, { state: 'CHANGES_REQUESTED' },
  ]) {
    await assert.rejects(run({ liveReview: { ...f.reviews[0], ...replacement } }), /review changed before dismissal/);
  }
  await assert.rejects(run({ livePr: { state: 'closed', head: { sha: headSha } } }), /head is not live\/open/);
  f.reviews[0].body = '## Verdict\nRequest changes';
  await assert.rejects(run(), /dismissed review withdrawal authority is missing or invalid/);
  assert.deepEqual(f.mutations, []);
});

test('only authoritative exact-head reviews with complete verified withdrawals lose their veto', async t => {
  const f = await fixture(t);
  f.reviews.push(
    { ...review, id: 18, body: body.replace('False finding', 'Standing finding') },
    { ...review, id: 19, user: { login: 'human-operator' } },
    { ...review, id: 20, commit_id: 'b'.repeat(40) },
    { ...review, id: 21, body: '## Verdict\nRequest changes' },
  );
  assert.deepEqual(await dismissWithdrawnReviews(f.identity, f.deps), { dismissed: [17] });
  assert.equal(f.mutations.length, 1);
  assert.match(f.mutations[0].message, /all 1 blocking findings withdrawn-by-hammer/);
  assert.match(f.mutations[0].message, new RegExp(headSha));
  assert.ok(f.reviews.slice(1).every(r => r.state === 'CHANGES_REQUESTED'));
  assert.deepEqual(await dismissWithdrawnReviews(f.identity, f.deps), { dismissed: [] });
});

for (const scenario of ['edited comment', 'untrusted comment', 'unrecorded comment', 'wrong evidence head',
  'wrong reviewed head', 'missing evidence', 'partial blockers', 'unknown blockers']) {
  test(`dismissal retains veto with ${scenario}`, async t => {
    const f = await fixture(t);
    if (scenario === 'edited comment') f.comments[0].body += '\nEdit';
    if (scenario === 'untrusted comment') f.comments[0].user.login = 'pr-author';
    if (scenario === 'unrecorded comment') f.comments[0].node_id = 'IC_other';
    if (scenario === 'wrong evidence head') f.db.prepare('UPDATE ham_finding_disputes SET head_sha=?').run('b'.repeat(40));
    if (scenario === 'wrong reviewed head') f.db.prepare('UPDATE ham_finding_disputes SET finding_reviewed_head=?').run('b'.repeat(40));
    if (scenario === 'missing evidence') f.comments.length = 0;
    if (scenario === 'partial blockers') f.reviews[0].body = body.replace('\n## Non-blocking', '\n- **Standing finding**\n  - **File:** `src/other.mjs`\n  - **Problem:** Broken.\n\n## Non-blocking');
    if (scenario === 'unknown blockers') f.reviews[0].body = '## Verdict\nRequest changes';
    assert.deepEqual(await dismissWithdrawnReviews(f.identity, f.deps), { dismissed: [] });
    assert.equal(f.mutations.length, 0);
  });
}

for (const scenario of ['head moved', 'review edited', 'reviews unreadable', 'dismissal refused']) {
  test(`dismissal fails closed when ${scenario}`, async t => {
    const f = await fixture(t);
    let reads = 0;
    const get = async path => {
      if (scenario === 'head moved' && path.endsWith('/pulls/42') && ++reads > 1) return { state: 'open', head: { sha: 'b'.repeat(40) } };
      if (scenario === 'review edited' && path.endsWith('/reviews/17')) return { ...review, body: 'new blockers' };
      if (scenario === 'reviews unreadable' && path.includes('/reviews?')) throw new Error('read failed');
      return f.deps.get(path);
    };
    await assert.rejects(dismissWithdrawnReviews(f.identity, { ...f.deps, get, dismiss: async () => {
      if (scenario === 'dismissal refused') throw new Error('permission denied');
      assert.fail('must not dismiss');
    } }));
    assert.equal(f.reviews[0].state, 'CHANGES_REQUESTED');
  });
}

for (const scenario of ['withdrawn', 'standing', 'dismissal refused', 'terminal remediation']) {
  test(`rendered hammer merge respects the GitHub review veto: ${scenario}`, async t => {
    const f = await fixture(t);
    const dir = f.rootDir, bin = join(dir, 'fixture-bin'); mkdirSync(bin);
    // The CI harness preserves symlinks; bin imports resolve through this fixture.
    for (const entry of ['bin', 'src', 'node_modules', 'domains', 'migrations', 'templates', 'config.yaml', 'package.json', 'package-lock.json']) symlinkSync(join(root, entry), join(dir, entry));
    writeFileSync(join(dir, 'config.json'), '{}\n');
    const stateFile = join(dir, 'github.json');
    if (scenario === 'standing') f.reviews[0].body = body.replace('False finding', 'Standing finding');
    const timeline = scenario === 'terminal remediation' ? [dismissedAfterHeadMove(f)] : [];
    writeFileSync(stateFile, JSON.stringify({ reviews: f.reviews, comments: f.comments, timeline, events: [] }));
    writeFileSync(join(bin, 'gh'), `#!${process.execPath}
import fs from 'node:fs';
const path = ${JSON.stringify(stateFile)};
const s = JSON.parse(fs.readFileSync(path)), a = process.argv.slice(2);
if (a[0] === 'pr' && a[1] === 'view' && a[a.indexOf('-R') + 1] !== ${JSON.stringify(repo)}) {
  process.stderr.write('missing explicit repository selector'); process.exit(1);
}
let result;
if (a[0] === 'api') {
  const p = a.find(x => x.startsWith('repos/'));
  if (p.endsWith('/dismissals')) {
    if (${JSON.stringify(scenario)} === 'dismissal refused') { process.stderr.write('HTTP 403 forbidden'); process.exit(1); }
    s.reviews[0].state = 'DISMISSED'; s.events.push('dismiss'); result = s.reviews[0];
  } else if (p.includes('/reviews?')) result = [s.reviews];
  else if (p.includes('/comments?')) result = [s.comments];
  else if (p.includes('/timeline?')) {
    if (!a.includes('--paginate') || !a.includes('--slurp')) process.exit(1);
    result = [[], s.timeline];
  }
  else if (p.includes('/compare/')) result = {status:'ahead'};
  else if (p.endsWith('/reviews/17')) result = s.reviews[0];
  else result = {state:'open', head:{sha:${JSON.stringify(headSha)}}};
} else if (a[1] === 'merge') {
  s.events.push('merge'); fs.writeFileSync(path, JSON.stringify(s));
  if (s.reviews.some(r => r.state === 'CHANGES_REQUESTED')) { process.stderr.write('branch protection review veto'); process.exit(1); }
  s.merged = true;
} else if (a.includes('body')) { process.exit(0); }
else if (a.includes('title')) { console.log('Fix fixture'); process.exit(0); }
else result = {state:s.merged?'MERGED':'OPEN', mergedAt:'2026-10-10T16:00:00Z', mergeCommit:{oid:'c'.repeat(40)},headRefOid:${JSON.stringify(headSha)}};
fs.writeFileSync(path, JSON.stringify(s));
if (result) console.log(JSON.stringify(result));
`, { mode: 0o755 });
    const nodeStub = join(bin, 'fixture-node');
    writeFileSync(nodeStub, `#!/bin/sh
case "$1" in
  */bin/legacy-lane-write.mjs) shift; while [ "$1" != -- ]; do shift; done; shift; exec "$@" ;;
  */bin/metered-gh.mjs) shift 2; exec gh "$@" ;;
  */bin/hammer-pr-read.mjs) repo="$2"; shift 2; number="$1"; shift; exec gh pr view "$number" -R "$repo" "$@" ;;
  --input-type=module) cat >/dev/null; echo '{"ok":true,"state":"OPEN","headMatches":true,"checksConclusion":"SUCCESS"}' ;;
  */bin/dismiss-withdrawn-reviews.mjs|*/bin/merge-commit-body.mjs) exec "${process.execPath}" "$@" ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
    for (const path of ['modules/worker-pool/lib/python', 'platform/session-ledger/src']) mkdirSync(join(dir, path), { recursive: true });
    const python = join(bin, 'fixture-python'); writeFileSync(python, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = { ...process.env, HAM_RUN_DIR: dir, HAM_ROOT_DIR: dir, HAM_PR_URL: 'https://github.com/fixture/repo/pull/42',
      HAM_REPO: repo, HAM_PR_NUMBER: '42', HAM_REVIEWED_SHA: scenario === 'terminal remediation' ? reviewedHead : headSha,
      HAM_TARGET_REMEDIATION_SHA: headSha,
      HAM_RISK_CLASS: 'critical', HAM_MERGE_METHOD: 'squash', HAM_HQ_ROOT: dir, HAM_REVIEWER: 'codex',
      HAM_AMA_TRAILERS: composeAmaTrailers({ workerClass: 'hammer', reviewerFamily: 'codex', riskClass: 'critical',
        eligibilityReason: 'hammer-adjudicated', auditRef: `ama-audit:${repo}:pr-42:head-${headSha}` }),
      AGENT_OS_GITHUB_TOKEN_CLASS: 'hammer',
      PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, AGENT_OS_ROOT: dir, HAM_PYTHON_BIN: python };
    const verdict = join(dir, 'verdict.json');
    const trace = { headMatch: { current: headSha }, branchProtection: { required: true } };
    if (scenario === 'terminal remediation') {
      trace.headMatch = { ...trace.headMatch, reviewed: reviewedHead, ok: true };
      trace.hamTerminalRemediation = { ok: true, remediationHead: headSha, terminalReviewProof: { ok: true },
        waived: ['verdict-not-settled-success', 'blocking-findings-present'] };
      for (const [key, value] of [
        ['remediationHead', queuedHead], ['terminalReviewProof', { ok: false }], ['waived', ['verdict-not-settled-success']],
      ]) {
        writeFileSync(verdict, JSON.stringify({ eligible: true, trace: { ...trace,
          hamTerminalRemediation: { ...trace.hamTerminalRemediation, [key]: value } } }));
        const cleanup = spawnSync(process.execPath, [join(root, 'bin/dismiss-withdrawn-reviews.mjs'),
          '--root-dir', dir, '--repo', repo, '--pr', String(prNumber), '--head-sha', headSha, '--verdict-file', verdict],
        { env, encoding: 'utf8', timeout: 15000 });
        assert.equal(cleanup.status, 1, cleanup.stderr);
        assert.match(cleanup.stderr, /dismissed review withdrawal authority is missing or invalid/);
      }
    }
    writeFileSync(verdict, JSON.stringify({ eligible: true, trace }));
    const script = join(dir, 'merge.sh');
    writeFileSync(script, renderHammerProcedure('hammer-merge', Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('HAM_')).map(([key, value]) => [key.slice(4), value]))));
    const shell = `HAM_MERGE_LEASE_HELD=1 HAM_MERGE_LEASE_ID=fixture POST_REMEDIATION_SHA=${headSha} HAM_PUBLISHED_AUDIT_HEAD=${headSha} HAM_NODE_BIN=${nodeStub} HAM_VERDICT_FILE=${verdict} HAM_VERDICT_READY_FILE=${verdict} HAM_MERGE_RETRY_CAP=1
ham_release_merge_lease() { HAM_MERGE_LEASE_HELD=0; }
ham_acquire_merge_lease() { HAM_MERGE_LEASE_HELD=1; }
ham_base_touches_pr_files() { return 1; }
ham_capture_current_base_sha() { HAM_CAPTURED_BASE_SHA=${'b'.repeat(40)}; }
ham_mark_merge_lease_retryable_abort() { :; }
sleep() { :; }
source "$1"
exit "$?"
`;
    const merged = spawnSync('/bin/bash', ['-c', shell, '_', script], { env, encoding: 'utf8', timeout: 15000 });
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (scenario === 'withdrawn' || scenario === 'terminal remediation') {
      assert.equal(merged.status, 0, merged.stdout + merged.stderr);
      assert.equal(state.merged, true);
      assert.deepEqual(state.events, scenario === 'withdrawn' ? ['dismiss', 'merge'] : ['merge']);
    } else {
      assert.notEqual(merged.status, 0);
      assert.equal(state.merged, undefined);
      assert.deepEqual(state.events, scenario === 'standing' ? ['merge'] : []);
      assert.equal(state.reviews[0].state, 'CHANGES_REQUESTED');
      assert.match(merged.stderr, scenario === 'standing' ? /branch protection review veto/ : /HTTP 403 forbidden/);
    }
  });
}

for (const scenario of ['deleted comment', 'edited comment', 'empty store', 'unreadable store']) {
  test(`merge retry revalidates dismissed authority: ${scenario}`, async t => {
    const f = await fixture(t);
    await dismissWithdrawnReviews(f.identity, f.deps);
    if (scenario === 'deleted comment') f.comments.length = 0;
    if (scenario === 'edited comment') f.comments[0].body += '\nchanged';
    const deps = { ...f.deps };
    if (scenario === 'empty store') f.db.prepare('DELETE FROM ham_finding_disputes').run();
    if (scenario === 'unreadable store') deps.readWithdrawals = ({ strict }) => {
      assert.equal(strict, true); throw new Error('store unavailable');
    };
    await assert.rejects(dismissWithdrawnReviews(f.identity, deps));
    assert.equal(f.mutations.length, 1);
  });
}
