// ARGUSDRAIN-01 item 4 — retire the Argus backlog safely. A job is closed
// `superseded` only when a live GitHub listing proves its PR is not open or its
// head moved; a live head is never touched, and uncertainty retires nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ARGUS_CLAIM_LEASE_MS,
  createGhOpenPullHeadsLister,
  retireArgusBacklog,
} from '../src/argus-backlog-retirement.mjs';
import {
  claimNextArgusJob,
  completeArgusJob,
  enqueueArgusSecurityReview,
  findArgusJob,
  readArgusQueueDepth,
} from '../src/argus-security-queue.mjs';
import { createArgusSecurityDrain } from '../src/argus-security-drain.mjs';
import { ARGUS_VERDICT_STATES, resolveArgusSecurityVerdict } from '../src/argus-security-verdict.mjs';
import { routeSecuritySurfaceToArgus } from '../src/argus-security-route.mjs';

const AR = 'laceyenterprises/adversarial-review';
const AOS = 'laceyenterprises/agent-os';
const CLIO = 'laceyenterprises/clio';
const T0 = Date.parse('2026-09-29T10:00:00.000Z');
const quiet = { log() {}, warn() {}, error() {} };
const REASONS = [{ trigger: 'sensitive-path', matches: [{ path: 'src/auth.mjs' }] }];

const sha = (n) => n.toString(16).padStart(40, '0');

async function withRoot(fn) {
  const rootDir = mkdtempSync(join(tmpdir(), 'argus-retire-'));
  try {
    return await fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function enqueue(rootDir, repo, prNumber, headSha, reasons = REASONS) {
  enqueueArgusSecurityReview({ rootDir, repo, prNumber, headSha, reasons, enqueuedAt: new Date(T0 - prNumber * 1000).toISOString() });
}

function bucketOf(rootDir, repo, prNumber, headSha) {
  return findArgusJob(rootDir, { repo, prNumber, headSha })?.bucket ?? null;
}

function lister(map) {
  return async (repo) => {
    const entry = map[repo];
    if (entry instanceof Error) throw entry;
    return entry;
  };
}

test('retirement closes dead heads and never touches a live head', async () => withRoot(async (rootDir) => {
  enqueue(rootDir, AR, 1, sha(1)); // open at this head: LIVE
  enqueue(rootDir, AR, 2, sha(2)); // open, head moved on
  enqueue(rootDir, AR, 3, sha(3)); // not open: merged or closed
  enqueue(rootDir, AOS, 10, sha(10)); // repo listing fails
  enqueue(rootDir, CLIO, 20, sha(20)); // repo listing may be truncated
  const lines = [];

  const summary = await retireArgusBacklog({
    rootDir,
    nowMs: T0,
    logger: { log: (line) => lines.push(line) },
    listOpenPullHeads: lister({
      [AR]: { complete: true, heads: new Map([[1, sha(1)], [2, sha(22)]]) },
      [AOS]: new Error('HTTP 502'),
      [CLIO]: { complete: false, heads: new Map() },
    }),
  });

  assert.equal(bucketOf(rootDir, AR, 1, sha(1)), 'pending', 'the live head is untouched');
  assert.equal(bucketOf(rootDir, AOS, 10, sha(10)), 'pending', 'a failed listing retires nothing');
  assert.equal(bucketOf(rootDir, CLIO, 20, sha(20)), 'pending', 'a possibly-truncated listing retires nothing');

  const moved = findArgusJob(rootDir, { repo: AR, prNumber: 2, headSha: sha(2) });
  assert.equal(moved.bucket, 'completed');
  assert.equal(moved.job.result.verdict, 'superseded');
  assert.equal(moved.job.result.supersededReason, 'head-superseded');
  assert.equal(moved.job.result.observedHeadSha, sha(22));
  assert.equal(moved.job.result.retiredBy, 'backlog-retirement');
  const closed = findArgusJob(rootDir, { repo: AR, prNumber: 3, headSha: sha(3) });
  assert.equal(closed.job.result.supersededReason, 'pr-merged-or-closed');

  assert.equal(summary.retired, 2);
  assert.deepEqual(summary.retiredByReason, { 'pr-merged-or-closed': 1, 'head-superseded': 1 });
  assert.equal(summary.liveHeads, 1);
  assert.equal(summary.oldestLiveHead.prNumber, 1);
  assert.deepEqual(summary.skippedRepos.map((entry) => entry.repo).sort(), [AOS, CLIO].sort());
  assert.match(lines.join('\n'), /backlog retirement: retired=2 \(pr-merged-or-closed=1 head-superseded=1\) live_heads=1/u);
}));

test('a retired job is neither green nor red at the gate', async () => withRoot(async (rootDir) => {
  enqueue(rootDir, AR, 3, sha(3));
  await retireArgusBacklog({ rootDir, nowMs: T0, logger: quiet, listOpenPullHeads: lister({ [AR]: { complete: true, heads: new Map() } }) });
  const verdict = resolveArgusSecurityVerdict({ rootDir, repo: AR, prNumber: 3, headSha: sha(3), nowMs: T0 });
  assert.equal(verdict.state, ARGUS_VERDICT_STATES.SUPERSEDED);
  assert.equal(verdict.satisfiesGate, false);
  assert.equal(verdict.blocks, false);
}));

test('a legacy route-for-review completion whose head is live goes back to the drain', async () => withRoot(async (rootDir) => {
  const bot = [{ trigger: 'bot-author', author: 'dependabot[bot]' }, { trigger: 'manifest-change', ecosystems: ['npm'] }];
  const legacy = (reason) => ({
    schemaVersion: 1,
    kind: 'argus-security-result',
    verdict: 'needs_verification',
    findings: [],
    autoadjudication: { decision: 'route-for-review', reason, inputs: { packageName: 'better-sqlite3', bumpKind: 'major' }, completedAt: '2026-09-28T16:14:18.684Z' },
  });
  for (const [pr, reason] of [[1172, 'semver-major'], [1171, 'semver-major'], [1170, 'merge-withheld-not-eligible']]) {
    enqueue(rootDir, AR, pr, sha(pr), bot);
    const found = findArgusJob(rootDir, { repo: AR, prNumber: pr, headSha: sha(pr) });
    completeArgusJob({ rootDir, jobPath: found.jobPath, job: found.job, result: legacy(reason) });
  }

  const summary = await retireArgusBacklog({
    rootDir,
    nowMs: T0,
    logger: quiet,
    // #1171 moved to a new head; #1172 is live; #1170 was withheld, not routed.
    listOpenPullHeads: lister({ [AR]: { complete: true, heads: new Map([[1172, sha(1172)], [1171, sha(9999)], [1170, sha(1170)]]) } }),
  });

  const reopened = findArgusJob(rootDir, { repo: AR, prNumber: 1172, headSha: sha(1172) });
  assert.equal(reopened.bucket, 'pending');
  assert.equal(reopened.job.routedForReview.reason, 'semver-major');
  assert.equal(reopened.job.routedForReview.requeuedFrom, 'legacy-route-for-review-completion');
  assert.equal(reopened.job.priorResult.verdict, 'needs_verification');
  assert.equal(reopened.job.result, null);
  assert.equal(bucketOf(rootDir, AR, 1171, sha(1171)), 'completed', 'a superseded legacy head stays closed');
  assert.equal(bucketOf(rootDir, AR, 1170, sha(1170)), 'completed', 'a withheld merge is not a review question');
  assert.equal(summary.requeued, 1);
}));

test('claims orphaned by a restart return to pending; a live or fresh claim is left alone', async () => withRoot(async (rootDir) => {
  enqueue(rootDir, AR, 1, sha(1));
  enqueue(rootDir, AR, 2, sha(2));
  enqueue(rootDir, AR, 3, sha(3));
  const stale = new Date(T0 - ARGUS_CLAIM_LEASE_MS - 1).toISOString();
  const first = claimNextArgusJob({ rootDir, claimedAt: stale });
  const second = claimNextArgusJob({ rootDir, claimedAt: stale });
  claimNextArgusJob({ rootDir, claimedAt: new Date(T0 - 60_000).toISOString() });

  const summary = await retireArgusBacklog({
    rootDir,
    nowMs: T0,
    logger: quiet,
    runningJobIds: [second.job.jobId],
    listOpenPullHeads: lister({ [AR]: { complete: true, heads: new Map([[1, sha(1)], [2, sha(2)], [3, sha(3)]]) } }),
  });
  assert.equal(summary.reclaimed, 1);
  const released = findArgusJob(rootDir, { repo: AR, prNumber: first.job.prNumber, headSha: first.job.headSha });
  assert.equal(released.bucket, 'pending');
  assert.match(released.job.drain.lastError, /stale claim/u);
  assert.equal(readArgusQueueDepth(rootDir).depth.inProgress, 2);
}));

test('the drain retires the backlog before its first claim, then reviews only live heads', async () => withRoot(async (rootDir) => {
  enqueue(rootDir, AR, 1, sha(1));
  enqueue(rootDir, AR, 2, sha(2));
  enqueue(rootDir, AR, 3, sha(3));
  let finishRetirement;
  const reviewed = [];
  const drain = createArgusSecurityDrain({
    rootDir,
    maxConcurrent: 3,
    nowMs: () => T0,
    logger: quiet,
    retireBacklog: ({ nowMs }) => new Promise((resolve) => {
      finishRetirement = () => resolve(retireArgusBacklog({
        rootDir, nowMs, logger: quiet, listOpenPullHeads: lister({ [AR]: { complete: true, heads: new Map([[2, sha(2)]]) } }),
      }));
    }),
    runJob: async ({ job }) => {
      reviewed.push(job.prNumber);
      return { kind: 'complete', result: { verdict: 'approve', findings: [], summary: 's' } };
    },
  });

  assert.equal(drain.tick().skipped, 'awaiting-backlog-retirement');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drain.tick().skipped, 'awaiting-backlog-retirement', 'a second tick does not start a second pass');
  finishRetirement();
  await drain.drain();
  assert.equal(drain.snapshot().retirement.lastSummary.retired, 2);

  drain.tick();
  await drain.drain();
  assert.deepEqual(reviewed, [2]);
}));

test('a retired job whose PR is live again is revived by the route', async () => withRoot(async (rootDir) => {
  enqueue(rootDir, AR, 7, sha(7));
  await retireArgusBacklog({ rootDir, nowMs: T0, logger: quiet, listOpenPullHeads: lister({ [AR]: { complete: true, heads: new Map() } }) });
  assert.equal(bucketOf(rootDir, AR, 7, sha(7)), 'completed');

  // The PR reopened at the same head. The route's memo path finds the retired job.
  const memo = await routeSecuritySurfaceToArgus({
    rootDir, repoPath: AR, prNumber: 7, headSha: sha(7), lastClassifiedHeadSha: sha(7), logger: quiet,
  });
  assert.equal(memo.queued, true);
  assert.equal(memo.bucket, 'pending');
  const revived = findArgusJob(rootDir, { repo: AR, prNumber: 7, headSha: sha(7) });
  assert.equal(revived.job.priorResult.verdict, 'superseded');
  assert.ok(revived.job.revivedAt);

  // And through a fresh classification (enqueue returns the duplicate).
  await retireArgusBacklog({ rootDir, nowMs: T0, logger: quiet, listOpenPullHeads: lister({ [AR]: { complete: true, heads: new Map() } }) });
  const fresh = await routeSecuritySurfaceToArgus({
    rootDir, repoPath: AR, prNumber: 7, headSha: sha(7), authorRef: 'dependabot[bot]', fetchChangedFiles: async () => ['package.json'], logger: quiet,
  });
  assert.equal(fresh.outcome, 'duplicate');
  assert.equal(fresh.bucket, 'pending');
}));

test('the live lister reads open heads and flags a listing that filled its limit', async () => {
  const rows = [{ number: 1, headRefOid: sha(1).toUpperCase() }, { number: 2, headRefOid: sha(2) }];
  const full = createGhOpenPullHeadsLister({ limit: 2, logger: quiet, execGhWithRetryImpl: async ({ args }) => {
    assert.deepEqual(args.slice(0, 6), ['pr', 'list', '--repo', AR, '--state', 'open']);
    return { stdout: JSON.stringify(rows) };
  } });
  const listing = await full(AR);
  assert.equal(listing.complete, false);
  assert.equal(listing.heads.get(1), sha(1));
  const roomy = createGhOpenPullHeadsLister({ limit: 1000, logger: quiet, execGhWithRetryImpl: async () => ({ stdout: JSON.stringify(rows) }) });
  assert.equal((await roomy(AR)).complete, true);
});
