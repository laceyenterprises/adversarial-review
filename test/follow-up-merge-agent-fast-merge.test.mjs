import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

import {
  buildFastMergeCloseAuditEntry,
  pollFastMergeQueue,
  processFastMergePR,
  resolveFastMergePerPollCap,
  writeFastMergeCloseAuditEntry,
} from '../src/follow-up-merge-agent.mjs';
import { fastMergeAuditDir } from '../src/fast-merge-audit-storage.mjs';
import { ensureReviewStateSchema, getReviewRow } from '../src/review-state.mjs';

const REPO = 'laceyenterprises/adversarial-review';

function makeDb() {
  const db = new Database(':memory:');
  ensureReviewStateSchema(db);
  return db;
}

function seedFastMerge(db, prNumber, {
  repo = REPO,
  authorizedHeadSha = 'sha-A',
  reviewedAt = `2026-05-24T12:${String(prNumber).slice(-2).padStart(2, '0')}:00.000Z`,
} = {}) {
  db.prepare(
    `INSERT INTO reviewed_prs
       (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, review_attempts, fast_merge_authorized_head_sha)
     VALUES (?, ?, ?, 'codex', 'fast_merge_skipped', 'fast_merge_skipped', 0, ?)`
  ).run(repo, prNumber, reviewedAt, authorizedHeadSha);
}

function row(db, prNumber, repo = REPO) {
  return getReviewRow(db, { repo, prNumber });
}

function openView(head = 'sha-A', labels = [{ name: 'fast-merge:docs' }]) {
  return {
    state: 'OPEN',
    isDraft: false,
    mergedAt: null,
    closedAt: null,
    headRefOid: head,
    labels,
  };
}

function successChecks() {
  return [{ name: 'ci', state: 'SUCCESS', bucket: 'pass' }];
}

function pendingChecks() {
  return [{ name: 'ci', state: 'IN_PROGRESS', bucket: 'pending' }];
}

function failedChecks() {
  return [{ name: 'ci', state: 'FAILURE', bucket: 'fail' }];
}

function hamCommit(headSha = 'sha-B', parentSha = 'sha-A') {
  return {
    sha: headSha,
    parents: [{ sha: parentSha }],
    author: { login: 'hammer-worker' },
    committer: { login: 'hammer-worker' },
    commit: {
      message: [
        'HAM-02 remediate final adversarial findings',
        '',
        'Worker-Class: hammer',
        'Worker-Ticket: HAM-02',
        'Closed-By: hammer (adversarial-pipe-mode)',
        'Remediated-Findings: 1 addressed (0 blocking, 1 non-blocking)',
      ].join('\n'),
    },
    files: [{ filename: 'README.md' }],
  };
}

function hamAuditComment(headSha = 'sha-B') {
  return {
    id: 9001,
    created_at: '2026-06-20T12:34:56Z',
    user: { login: 'hammer-worker' },
    body: [
      `HAM audit: remediated post-review findings at ${headSha}.`,
      'Closed-By: hammer (adversarial-pipe-mode)',
      'Remediated-Findings: 1 addressed (0 blocking, 1 non-blocking)',
    ].join('\n'),
  };
}

function transportError(message = 'timed out') {
  const err = new Error(message);
  err.code = 'ETIMEDOUT';
  return err;
}

function refusalError(message = 'GraphQL: Pull request is not mergeable') {
  const err = new Error(message);
  err.stderr = message;
  err.code = 1;
  return err;
}

function checksCliError(code, payload, message = `gh pr checks exited ${code}`) {
  const err = new Error(message);
  err.code = code;
  err.stdout = JSON.stringify(payload);
  err.stderr = message;
  return err;
}

function noChecksReportedError() {
  const err = new Error("no checks reported on the 'sha-A' branch");
  err.code = 1;
  err.stdout = '';
  err.stderr = "no checks reported on the 'sha-A' branch";
  return err;
}

function makeGhStub({
  views = [],
  checks = [],
  merges = [],
  api = [],
} = {}) {
  const calls = [];
  const queues = {
    views: [...views],
    checks: [...checks],
    merges: [...merges],
    api: [...api],
  };
  async function execFileImpl(cmd, args) {
    calls.push({ cmd, args });
    if (args[0] === 'api') {
      const item = queues.api.length ? queues.api.shift() : {};
      if (item instanceof Error) throw item;
      return { stdout: JSON.stringify(item), stderr: '' };
    }
    const command = args.slice(0, 2).join(' ');
    if (command === 'pr view') {
      if (args.includes('mergeCommit')) {
        return {
          stdout: JSON.stringify({ mergeCommit: { oid: 'feedfacefeedfacefeedfacefeedfacefeedface' } }),
          stderr: '',
        };
      }
      const item = queues.views.length ? queues.views.shift() : openView();
      if (item instanceof Error) throw item;
      return { stdout: JSON.stringify(item), stderr: '' };
    }
    if (command === 'pr checks') {
      const item = queues.checks.length ? queues.checks.shift() : successChecks();
      if (item instanceof Error) throw item;
      return { stdout: JSON.stringify(item), stderr: '' };
    }
    if (command === 'pr merge') {
      const item = queues.merges.length ? queues.merges.shift() : { stdout: 'Merged abcdef1234567890abcdef1234567890abcdef12\n', stderr: '' };
      if (item instanceof Error) throw item;
      return item;
    }
    throw new Error(`unexpected gh call: ${cmd} ${args.join(' ')}`);
  }
  execFileImpl.calls = calls;
  return execFileImpl;
}

function mergeCalls(gh) {
  return gh.calls.filter((call) => call.args.slice(0, 2).join(' ') === 'pr merge');
}

function claimWithWatcherCas(db, prNumber) {
  return db.prepare(
    `UPDATE reviewed_prs
        SET review_status = 'reviewing',
            last_attempted_at = '2026-05-24T13:00:00.000Z'
      WHERE repo = ?
        AND pr_number = ?
        AND review_status IN ('pending', 'pending-upstream')`
  ).run(REPO, prNumber);
}

test('fast-merge happy path merges authorized green head and writes audit', async () => {
  const db = makeDb();
  seedFastMerge(db, 801);
  const audits = [];
  const gh = makeGhStub({ views: [openView('sha-A'), openView('sha-A')], checks: [successChecks()] });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 801,
    authorizedHeadSha: 'sha-A',
    auditWriter: (entry) => audits.push(entry),
  });

  assert.equal(result.status, 'merged');
  assert.equal(row(db, 801).pr_state, 'fast_merge_merged');
  assert.equal(row(db, 801).review_status, 'fast_merge_merged');
  assert.equal(mergeCalls(gh).length, 1);
  assert.equal(audits.at(-1).authorized_head_sha, 'sha-A');
  assert.equal(audits.at(-1).merged_head_sha, 'sha-A');
  assert.equal(audits.at(-1).merge_sha, 'feedfacefeedfacefeedfacefeedfacefeedface');
  assert.deepEqual(mergeCalls(gh)[0].args.slice(-3), ['--match-head-commit', 'sha-A', '--delete-branch']);
});

test('fast-merge head change requeues through canonical review reset and never merges', async () => {
  const db = makeDb();
  seedFastMerge(db, 802);
  const audits = [];
  const gh = makeGhStub({ views: [openView('sha-B')] });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 802,
    authorizedHeadSha: 'sha-A',
    auditWriter: (entry) => audits.push(entry),
  });

  assert.equal(result.status, 'requeued_head_change');
  assert.equal(mergeCalls(gh).length, 0);
  assert.equal(row(db, 802).pr_state, 'open');
  assert.equal(row(db, 802).review_status, 'pending');
  assert.equal(audits.at(-1).head_changed, true);
  assert.equal(audits.at(-1).authorized_head_sha, 'sha-A');
  assert.equal(audits.at(-1).current_head_sha, 'sha-B');
  assert.equal(audits.at(-1).requeue_path, 'retrigger_helper');
  assert.equal(claimWithWatcherCas(db, 802).changes, 1);
});

test('fast-merge HAM-provenance remediation head is authorized and merged with exact new head', async () => {
  const db = makeDb();
  seedFastMerge(db, 8021);
  const audits = [];
  const gh = makeGhStub({
    views: [openView('sha-B'), openView('sha-B')],
    checks: [successChecks()],
    api: [
      hamCommit('sha-B', 'sha-A'),
      [hamAuditComment('sha-B')],
    ],
  });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 8021,
    authorizedHeadSha: 'sha-A',
    auditWriter: (entry) => audits.push(entry),
  });

  assert.equal(result.status, 'merged');
  assert.equal(row(db, 8021).review_status, 'fast_merge_merged');
  assert.equal(mergeCalls(gh).length, 1);
  assert.deepEqual(mergeCalls(gh)[0].args.slice(-3), ['--match-head-commit', 'sha-B', '--delete-branch']);
  assert.equal(audits.at(-1).authorized_head_sha, 'sha-B');
  assert.equal(audits.at(-1).merged_head_sha, 'sha-B');
  assert.equal(audits.some((entry) => entry.action === 'head-changed-requeued'), false);
  assert.equal(claimWithWatcherCas(db, 8021).changes, 0);
});

test('fast-merge head change between CI and merge requeues and never merges', async () => {
  const db = makeDb();
  seedFastMerge(db, 803);
  const audits = [];
  const gh = makeGhStub({ views: [openView('sha-A'), openView('sha-B')], checks: [successChecks()] });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 803,
    authorizedHeadSha: 'sha-A',
    auditWriter: (entry) => audits.push(entry),
  });

  assert.equal(result.status, 'requeued_head_change');
  assert.equal(mergeCalls(gh).length, 0);
  assert.equal(row(db, 803).review_status, 'pending');
  assert.equal(audits.at(-1).current_head_sha, 'sha-B');
});

test('fast-merge veto racing before merge requeues and never merges', async () => {
  const db = makeDb();
  seedFastMerge(db, 804);
  const audits = [];
  const gh = makeGhStub({
    views: [openView('sha-A', [{ name: 'fast-merge:docs' }]), openView('sha-A', [{ name: 'fast-merge-veto' }])],
    checks: [successChecks()],
  });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 804,
    authorizedHeadSha: 'sha-A',
    auditWriter: (entry) => audits.push(entry),
  });

  assert.equal(result.status, 'requeued_veto');
  assert.equal(mergeCalls(gh).length, 0);
  assert.equal(row(db, 804).review_status, 'pending');
  assert.equal(audits.at(-1).veto_detected, true);
  assert.equal(claimWithWatcherCas(db, 804).changes, 1);
});

test('fast-merge removed authorization label requeues before merge', async () => {
  const db = makeDb();
  seedFastMerge(db, 8041);
  const audits = [];
  const gh = makeGhStub({ views: [openView('sha-A', [])] });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 8041,
    authorizedHeadSha: 'sha-A',
    auditWriter: (entry) => audits.push(entry),
  });

  assert.equal(result.status, 'requeued_label_removed');
  assert.equal(mergeCalls(gh).length, 0);
  assert.equal(row(db, 8041).review_status, 'pending');
  assert.equal(audits.at(-1).label_removed, true);
  assert.equal(audits.at(-1).action, 'label-removed-requeued');
});

test('fast-merge pending CI leaves row unchanged and writes no audit', async () => {
  const db = makeDb();
  seedFastMerge(db, 805);
  const audits = [];
  const gh = makeGhStub({ views: [openView('sha-A')], checks: [pendingChecks()] });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 805,
    authorizedHeadSha: 'sha-A',
    auditWriter: (entry) => audits.push(entry),
  });

  assert.equal(result.status, 'skipped_still_pending');
  assert.equal(row(db, 805).pr_state, 'fast_merge_skipped');
  assert.equal(row(db, 805).review_status, 'fast_merge_skipped');
  assert.equal(audits.length, 0);
});

test('fast-merge failed CI blocks with failure message and audit', async () => {
  const db = makeDb();
  seedFastMerge(db, 806);
  const audits = [];
  const gh = makeGhStub({ views: [openView('sha-A')], checks: [failedChecks()] });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 806,
    authorizedHeadSha: 'sha-A',
    auditWriter: (entry) => audits.push(entry),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(row(db, 806).pr_state, 'fast_merge_blocked');
  assert.match(row(db, 806).failure_message, /ci failed/i);
  assert.equal(audits.at(-1).failure_reason, row(db, 806).failure_message);
});

test('fast-merge failed CI from gh non-zero exit still blocks with audit', async () => {
  const db = makeDb();
  seedFastMerge(db, 8061);
  const audits = [];
  const gh = makeGhStub({
    views: [openView('sha-A')],
    checks: [checksCliError(1, [{ name: 'ci', state: 'FAILURE', bucket: 'fail' }])],
  });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 8061,
    authorizedHeadSha: 'sha-A',
    auditWriter: (entry) => audits.push(entry),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(row(db, 8061).pr_state, 'fast_merge_blocked');
  assert.match(row(db, 8061).failure_message, /ci failed/i);
  assert.equal(audits.at(-1).failure_reason, row(db, 8061).failure_message);
});

test('fast-merge pending CI from gh exit 8 stays skipped', async () => {
  const db = makeDb();
  seedFastMerge(db, 8062);
  const gh = makeGhStub({
    views: [openView('sha-A')],
    checks: [checksCliError(8, [{ name: 'ci', state: 'IN_PROGRESS', bucket: 'pending' }])],
  });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 8062,
    authorizedHeadSha: 'sha-A',
    auditWriter: () => {},
  });

  assert.equal(result.status, 'skipped_still_pending');
  assert.equal(row(db, 8062).pr_state, 'fast_merge_skipped');
});

test('fast-merge manual merge race records merged without gh merge call', async () => {
  const db = makeDb();
  seedFastMerge(db, 807);
  const audits = [];
  const gh = makeGhStub({
    views: [{
      ...openView('sha-A'),
      state: 'MERGED',
      mergedAt: '2026-05-24T12:30:00.000Z',
    }],
  });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 807,
    authorizedHeadSha: 'sha-A',
    auditWriter: (entry) => audits.push(entry),
  });

  assert.equal(result.status, 'merged');
  assert.equal(row(db, 807).pr_state, 'fast_merge_merged');
  assert.equal(mergeCalls(gh).length, 0);
  assert.equal(audits.at(-1).manual_merge_detected, true);
});

test('fast-merge closed without merge records fast_merge_closed and never merges', async () => {
  const db = makeDb();
  seedFastMerge(db, 808);
  const audits = [];
  const gh = makeGhStub({
    views: [{
      ...openView('sha-A'),
      state: 'CLOSED',
      closedAt: '2026-05-24T12:31:00.000Z',
    }],
  });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 808,
    authorizedHeadSha: 'sha-A',
    auditWriter: (entry) => audits.push(entry),
  });

  assert.equal(result.status, 'closed');
  assert.equal(row(db, 808).pr_state, 'fast_merge_closed');
  assert.equal(mergeCalls(gh).length, 0);
  assert.equal(audits.at(-1).closed_without_merge, true);
});

test('fast-merge no CI configured still attempts merge', async () => {
  const db = makeDb();
  seedFastMerge(db, 809);
  const gh = makeGhStub({ views: [openView('sha-A'), openView('sha-A')], checks: [[]] });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 809,
    authorizedHeadSha: 'sha-A',
    auditWriter: () => {},
  });

  assert.equal(result.status, 'merged');
  assert.equal(mergeCalls(gh).length, 1);
});

test('fast-merge no checks reported diagnostic is treated as empty checks', async () => {
  const db = makeDb();
  seedFastMerge(db, 8091);
  const gh = makeGhStub({
    views: [openView('sha-A'), openView('sha-A')],
    checks: [noChecksReportedError(), noChecksReportedError()],
  });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 8091,
    authorizedHeadSha: 'sha-A',
    auditWriter: () => {},
  });

  assert.equal(result.status, 'merged');
  assert.equal(mergeCalls(gh).length, 1);
});

test('fast-merge per-poll cap defaults to 5 and next poll handles the sixth', async () => {
  const db = makeDb();
  for (let pr = 810; pr <= 815; pr += 1) seedFastMerge(db, pr);
  const gh = makeGhStub({
    views: Array.from({ length: 12 }, () => openView('sha-A')),
    checks: Array.from({ length: 6 }, () => successChecks()),
  });

  const first = await pollFastMergeQueue({ db, ghClient: gh, auditWriter: () => {} });
  assert.equal(first.processed, 5);
  assert.equal(first.merged, 5);
  assert.equal(row(db, 815).pr_state, 'fast_merge_skipped');

  const second = await pollFastMergeQueue({ db, ghClient: gh, auditWriter: () => {} });
  assert.equal(second.processed, 1);
  assert.equal(second.merged, 1);
  assert.equal(row(db, 815).pr_state, 'fast_merge_merged');
});

test('fast-merge pending rows do not starve later mergeable rows behind the cap', async () => {
  const db = makeDb();
  for (let pr = 830; pr <= 835; pr += 1) seedFastMerge(db, pr);
  const gh = async (_cmd, args) => {
    const command = args.slice(0, 2).join(' ');
    const prNumber = Number(args[2]);
    if (command === 'pr view') {
      if (args.includes('mergeCommit')) {
        return {
          stdout: JSON.stringify({ mergeCommit: { oid: 'feedfacefeedfacefeedfacefeedfacefeedface' } }),
          stderr: '',
        };
      }
      return { stdout: JSON.stringify(openView('sha-A')), stderr: '' };
    }
    if (command === 'pr checks') {
      return { stdout: JSON.stringify(prNumber < 835 ? pendingChecks() : successChecks()), stderr: '' };
    }
    if (command === 'pr merge') return { stdout: 'Merged\n', stderr: '' };
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };

  const summary = await pollFastMergeQueue({ db, ghClient: gh, perPollCap: 5, auditWriter: () => {} });

  assert.equal(summary.processed, 6);
  assert.equal(summary.skipped_still_pending, 5);
  assert.equal(summary.merged, 1);
  assert.equal(row(db, 835).pr_state, 'fast_merge_merged');
});

test('fast-merge per-poll cap resolves from env var', async () => {
  const db = makeDb();
  for (let pr = 816; pr <= 820; pr += 1) seedFastMerge(db, pr);
  const gh = makeGhStub({
    views: Array.from({ length: 4 }, () => openView('sha-A')),
    checks: Array.from({ length: 2 }, () => successChecks()),
  });
  const cap = resolveFastMergePerPollCap({ FML_MERGE_AGENT_PER_POLL_CAP: '2' });

  const summary = await pollFastMergeQueue({ db, ghClient: gh, perPollCap: cap, auditWriter: () => {} });
  assert.equal(summary.processed, 2);
  assert.equal(summary.merged, 2);
  assert.equal(row(db, 818).pr_state, 'fast_merge_skipped');
});

test('fast-merge deterministic refusal blocks one PR without stopping others', async () => {
  const db = makeDb();
  for (let pr = 821; pr <= 823; pr += 1) seedFastMerge(db, pr);
  const gh = makeGhStub({
    views: Array.from({ length: 6 }, () => openView('sha-A')),
    checks: Array.from({ length: 3 }, () => successChecks()),
    merges: [refusalError(), { stdout: 'Merged\n', stderr: '' }, { stdout: 'Merged\n', stderr: '' }],
  });

  const summary = await pollFastMergeQueue({ db, ghClient: gh, perPollCap: 3, auditWriter: () => {} });

  assert.equal(summary.processed, 3);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.merged, 2);
  assert.equal(row(db, 821).pr_state, 'fast_merge_blocked');
  assert.equal(row(db, 822).pr_state, 'fast_merge_merged');
  assert.equal(row(db, 823).pr_state, 'fast_merge_merged');
});

test('fast-merge transient checks failure retries and exhausted retry leaves skipped', async () => {
  const db = makeDb();
  seedFastMerge(db, 824);
  seedFastMerge(db, 825);
  const succeedsEventually = makeGhStub({
    views: [openView('sha-A'), openView('sha-A')],
    checks: [transportError(), transportError(), successChecks()],
  });
  const exhausted = makeGhStub({
    views: [openView('sha-A')],
    checks: [transportError(), transportError(), transportError()],
  });

  const first = await processFastMergePR({
    db,
    ghClient: succeedsEventually,
    repo: REPO,
    prNumber: 824,
    authorizedHeadSha: 'sha-A',
    auditWriter: () => {},
  });
  const second = await processFastMergePR({
    db,
    ghClient: exhausted,
    repo: REPO,
    prNumber: 825,
    authorizedHeadSha: 'sha-A',
    auditWriter: () => {},
  });

  assert.equal(first.status, 'merged');
  assert.equal(row(db, 824).pr_state, 'fast_merge_merged');
  assert.equal(second.status, 'skipped_still_pending');
  assert.equal(row(db, 825).pr_state, 'fast_merge_skipped');
});

test('fast-merge transient merge transport exhaustion leaves skipped', async () => {
  const db = makeDb();
  seedFastMerge(db, 826);
  const gh = makeGhStub({
    views: [openView('sha-A'), openView('sha-A')],
    checks: [successChecks()],
    merges: [transportError(), transportError(), transportError()],
  });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 826,
    authorizedHeadSha: 'sha-A',
    auditWriter: () => {},
  });

  assert.equal(result.status, 'skipped_still_pending');
  assert.equal(row(db, 826).pr_state, 'fast_merge_skipped');
});

test('fast-merge CI failure in pre-merge recheck blocks and never merges', async () => {
  const db = makeDb();
  seedFastMerge(db, 8261);
  const audits = [];
  const gh = makeGhStub({
    views: [openView('sha-A'), openView('sha-A')],
    checks: [successChecks(), failedChecks()],
  });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 8261,
    authorizedHeadSha: 'sha-A',
    auditWriter: (entry) => audits.push(entry),
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'ci-failed-before-merge');
  assert.equal(mergeCalls(gh).length, 0);
  assert.equal(row(db, 8261).pr_state, 'fast_merge_blocked');
  assert.match(audits.at(-1).failure_reason, /ci failed/i);
});

test('fast-merge merge refusal that already landed records merged instead of blocked', async () => {
  const db = makeDb();
  seedFastMerge(db, 827);
  const audits = [];
  const gh = makeGhStub({
    views: [
      openView('sha-A'),
      openView('sha-A'),
      {
        ...openView('sha-A'),
        state: 'MERGED',
        mergedAt: '2026-05-24T12:40:00.000Z',
      },
    ],
    checks: [successChecks()],
    merges: [refusalError('Pull request is already merged')],
  });

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 827,
    authorizedHeadSha: 'sha-A',
    auditWriter: (entry) => audits.push(entry),
  });

  assert.equal(result.status, 'merged');
  assert.equal(row(db, 827).pr_state, 'fast_merge_merged');
  assert.equal(row(db, 827).review_status, 'fast_merge_merged');
  assert.equal(audits.at(-1).merge_sha, 'feedfacefeedfacefeedfacefeedfacefeedface');
});

test('fast-merge checks request only real gh JSON fields', async () => {
  const db = makeDb();
  seedFastMerge(db, 828);
  const calls = [];
  const gh = async (cmd, args) => {
    calls.push({ cmd, args });
    const command = args.slice(0, 2).join(' ');
    if (command === 'pr view') {
      return { stdout: JSON.stringify(openView('sha-A')), stderr: '' };
    }
    if (command === 'pr checks') {
      const jsonFields = args[args.indexOf('--json') + 1];
      assert.equal(jsonFields, 'name,state,bucket,workflow,link');
      return { stdout: JSON.stringify(successChecks()), stderr: '' };
    }
    if (command === 'pr merge') {
      return { stdout: 'Merged\n', stderr: '' };
    }
    throw new Error(`unexpected gh call: ${cmd} ${args.join(' ')}`);
  };

  const result = await processFastMergePR({
    db,
    ghClient: gh,
    repo: REPO,
    prNumber: 828,
    authorizedHeadSha: 'sha-A',
    auditWriter: () => {},
  });

  assert.equal(result.status, 'merged');
  assert.ok(calls.some((call) => call.args.slice(0, 2).join(' ') === 'pr checks'));
});

test('fast-merge close audits write to dedicated fast-merge audit directory', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'fast-merge-audit-'));
  const entry = buildFastMergeCloseAuditEntry({
    action: 'merged',
    repo: REPO,
    prNumber: 829,
    at: '2026-05-24T20:00:00.000Z',
  });

  const writtenPath = writeFastMergeCloseAuditEntry(rootDir, entry);
  const payload = JSON.parse(readFileSync(writtenPath, 'utf8'));

  assert.ok(writtenPath.startsWith(fastMergeAuditDir(rootDir)));
  assert.ok(existsSync(writtenPath));
  assert.equal(payload.kind, 'fast-merge-audit');
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.auditType, 'fast-merge-close');
});

test('fast-merge close audit write failure leaves retry sentinel on row', async () => {
  const db = makeDb();
  seedFastMerge(db, 8291);
  const result = await processFastMergePR({
    db,
    ghClient: makeGhStub({ views: [openView('sha-A')], checks: [failedChecks()] }),
    repo: REPO,
    prNumber: 8291,
    authorizedHeadSha: 'sha-A',
    auditWriter: () => {
      throw new Error('audit disk full');
    },
  });
  const updated = row(db, 8291);

  assert.equal(result.status, 'blocked');
  assert.equal(updated.fast_merge_audit_status, 'pending');
  assert.match(updated.fast_merge_audit_error, /audit disk full/);
  assert.equal(JSON.parse(updated.fast_merge_audit_payload_json).action, 'blocked');
});
