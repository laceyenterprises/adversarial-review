/** ASR-06 — the no-drop regression guard.
 *
 * ASR-04 fixed the drop. This file exists so it cannot come back, and it is
 * deliberately shaped as a GUARD rather than as more examples: `bot-pr-not-
 * malformed.test.mjs` already covers the individual dispositions case by case,
 * and a case-by-case test only catches the regressions someone anticipated. The
 * failure being guarded against is a new branch added later that reaches the
 * terminal write by a path nobody listed, so the assertion here is exhaustive
 * over the input space instead.
 *
 * Two properties:
 *
 *   1. While the route is enabled, NO combination of inputs lets a bot-authored
 *      PR reach terminal `unroutable-bot-author`.
 *   2. `#909` and `#910` — the two PRs that sat 14 hours, and the fixtures the
 *      manual pass was transcribed from — replay end to end to the dispositions
 *      that pass reached.
 *
 * Property 2 is the cross-repo half. ASR-05 proves the RUBRIC reproduces the
 * manual conclusions (modules/argus/test/test_argus_security_rubric.py against
 * modules/argus/test/fixtures/security-review/expected-dispositions.json). What
 * that cannot see is whether the conclusion survives the trip to the gate — a
 * rubric that correctly approves #909 is still a dropped PR if the gate then
 * holds it at `pending` forever. This asserts the last leg.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LEGACY_UNROUTABLE_BOT_STATUS,
  isArgusSecurityRouteEnabled,
} from '../src/argus-security-route.mjs';
import { markUnroutableTitleDisposition } from '../src/pollonce-phases.mjs';
import {
  completeArgusJob,
  enqueueArgusSecurityReview,
} from '../src/argus-security-queue.mjs';
import { resolveArgusSecurityVerdict } from '../src/argus-security-verdict.mjs';
import { pickAdversarialGateStatus } from '../src/adversarial-gate-status.mjs';

const SILENT = { warn: () => {}, log: () => {}, error: () => {} };

function recordingStatements() {
  const calls = [];
  return {
    calls,
    markMalformedStatement: { run: (...args) => calls.push(['malformed', args]) },
    markUnroutableBotStatement: { run: (...args) => calls.push(['unroutable-bot', args]) },
    markArgusSecurityQueuedStatement: { run: (...args) => calls.push(['argus-queued', args]) },
  };
}

// ---------------------------------------------------------------------------
// Property 1 — no bot PR reaches terminal state while the route is enabled.
// ---------------------------------------------------------------------------

test('no bot-authored PR can reach terminal unroutable-bot-author while the route is enabled', () => {
  // Every representable combination of the inputs that steer the bot branch.
  // The point is coverage of the SPACE, not of a list: a future branch that
  // reaches the terminal write for, say, an empty title fails here without
  // anyone having predicted it.
  const titles = ['chore(deps): bump better-sqlite3', '', 'no prefix at all', '[claude-code] fine'];
  const queuedStates = [true, false];
  let checked = 0;

  for (const prTitle of titles) {
    for (const argusSecurityQueued of queuedStates) {
      const { calls, ...statements } = recordingStatements();
      const status = markUnroutableTitleDisposition({
        prTitle,
        failureAt: '2026-08-24T19:30:00.000Z',
        repoPath: 'laceyenterprises/adversarial-review',
        prNumber: 909,
        unroutableBot: true,
        argusRouteEnabled: true,
        argusSecurityQueued,
        logger: SILENT,
        ...statements,
      });

      const context = `title=${JSON.stringify(prTitle)} queued=${argusSecurityQueued}`;
      assert.notEqual(status, LEGACY_UNROUTABLE_BOT_STATUS, `terminal status reached: ${context}`);
      assert.equal(
        calls.some(([kind]) => kind === 'unroutable-bot'),
        false,
        `terminal row written: ${context}`
      );
      checked += 1;
    }
  }

  assert.equal(checked, titles.length * queuedStates.length);
});

test('the only writer of the terminal bot status is the kill switch', () => {
  // A rollback lever has to still work, so this asserts the terminal path is
  // reachable — but ONLY through `argusRouteEnabled: false`, and only loudly.
  const { calls, ...statements } = recordingStatements();
  const warnings = [];
  const status = markUnroutableTitleDisposition({
    prTitle: 'chore(deps): bump better-sqlite3',
    failureAt: '2026-08-24T19:30:00.000Z',
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 909,
    unroutableBot: true,
    argusRouteEnabled: false,
    logger: { warn: (msg) => warnings.push(msg) },
    ...statements,
  });

  assert.equal(status, LEGACY_UNROUTABLE_BOT_STATUS);
  assert.equal(calls.filter(([kind]) => kind === 'unroutable-bot').length, 1);
  assert.ok(
    warnings.some((msg) => String(msg).includes('ARGUS_ROUTE_DISABLED')),
    'the terminal write must announce itself'
  );
});

test('the route is enabled by default, so the guard describes the shipped posture', () => {
  // The property above is conditioned on the route being on. If the default
  // flipped, the guard would still pass while the fleet dropped PRs again.
  assert.equal(isArgusSecurityRouteEnabled({}), true);
  assert.equal(isArgusSecurityRouteEnabled({ ADVERSARIAL_ARGUS_SECURITY_ROUTE: '' }), true);
  assert.equal(isArgusSecurityRouteEnabled({ ADVERSARIAL_ARGUS_SECURITY_ROUTE: 'false' }), false);
});

test('a human PR with a bad title is still terminal-malformed', () => {
  // The distinction ASR-04 was careful not to blur. "Fix your title" is an
  // accurate, actionable finding for a human; widening the bot branch over it
  // would destroy the reason the bot branch exists.
  const { calls, ...statements } = recordingStatements();
  const status = markUnroutableTitleDisposition({
    prTitle: 'fix the thing',
    failureAt: '2026-08-24T19:30:00.000Z',
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 912,
    unroutableBot: false,
    argusRouteEnabled: true,
    logger: SILENT,
    ...statements,
  });

  assert.equal(status, 'malformed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'malformed');
});

// ---------------------------------------------------------------------------
// Property 2 — #909 and #910 replay to the manual-pass dispositions.
// ---------------------------------------------------------------------------

/**
 * The two reference dispositions, transcribed from the ASR-05 result documents
 * these fixtures actually produce.
 *
 * Verified at authoring time by running the rubric over the committed fixtures:
 *
 *   PYTHONPATH=modules/argus/lib/python python3 -m argus_review review \
 *     modules/argus/test/fixtures/security-review/pr-909.json --format json
 *
 * #909 is the one that matters. A naive "major bump = risky" rubric inverts it:
 * it is a MAJOR bump of the native driver behind reviews.db, and it is a
 * security IMPROVEMENT — it drops an install script and 37 transitive packages.
 * The manual pass approved it. If this route cannot also approve it, ASR has
 * replaced a lane that dropped PRs with a lane that only ever objects, which is
 * the same unattended queue wearing a different colour.
 */
const REFERENCE_REVIEWS = [
  {
    prNumber: 909,
    headSha: '370c2fb0933615e06133aaf4ea8025acfbd9b83d',
    baseSha: '6c03a8da78e3f0ef3e7407dfdb02c4cb3c81873a',
    manualVerdict: 'approve',
    depthTier: 'deep',
    riskDirection: 'reduced',
    result: {
      schemaVersion: 1,
      verdict: 'approve',
      blocksMerge: false,
      isApproval: true,
      highestSeverity: 'medium',
      riskDirection: 'reduced',
      triggerReasons: ['bot-author', 'dependency-manifest'],
      findings: [
        {
          severity: 'medium',
          category: 'runtime_floor',
          title: 'Declared support range excludes the deploy host runtime',
        },
        {
          severity: 'medium',
          category: 'runtime_floor',
          title: 'better-sqlite3@13.0.3 rejects runtimes this repo still claims to support',
        },
        {
          severity: 'low',
          category: 'version_distance',
          title: 'better-sqlite3 crosses a major version',
        },
      ],
    },
  },
  {
    prNumber: 910,
    headSha: '1000c91fef7ee59656368c79d1ae36aa6bc5e065',
    baseSha: '6c03a8da78e3f0ef3e7407dfdb02c4cb3c81873a',
    manualVerdict: 'approve',
    depthTier: 'fast',
    riskDirection: 'unchanged',
    result: {
      schemaVersion: 1,
      verdict: 'approve',
      blocksMerge: false,
      isApproval: true,
      highestSeverity: null,
      riskDirection: 'unchanged',
      triggerReasons: ['bot-author', 'dependency-manifest'],
      findings: [],
    },
  },
];

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'asr06-replay-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const reference of REFERENCE_REVIEWS) {
  test(`#${reference.prNumber} replays to the disposition the manual pass reached`, () => withRoot((root) => {
    const repo = 'laceyenterprises/adversarial-review';

    // The route: enqueue exactly as ASR-04 would for a bot-authored PR.
    const { jobPath } = enqueueArgusSecurityReview({
      rootDir: root,
      repo,
      prNumber: reference.prNumber,
      headSha: reference.headSha,
      reasons: reference.result.triggerReasons.map((trigger) => ({ trigger })),
    });

    // The review: ASR-05's result document lands on the job.
    completeArgusJob({ rootDir: root, jobPath, result: reference.result });

    // The verdict.
    const verdict = resolveArgusSecurityVerdict({
      rootDir: root,
      repo,
      prNumber: reference.prNumber,
      headSha: reference.headSha,
    });
    assert.equal(verdict.state, 'approved');
    assert.equal(verdict.blocks, false, 'the manual pass approved; the route must not block');
    assert.equal(verdict.satisfiesGate, true);
    assert.equal(verdict.blockingFindings.length, 0, 'no high finding exists on either reference PR');

    // The gate: an Argus-owned row reaches success, so the PR can actually
    // merge. `pending` here would be the 14-hour drop with a nicer status.
    const decision = pickAdversarialGateStatus({
      reviewRow: { review_status: 'argus-security-queued', reviewer: 'argus-security' },
      headSha: reference.headSha,
      argusVerdict: verdict,
    });
    assert.equal(decision.state, 'success');
    assert.equal(decision.reason, 'argus-security-approved');
  }));
}

test('#909 approves while still reporting its advisory findings', () => withRoot((root) => {
  // Non-blocking must not mean invisible. #909 carries two medium and one low
  // finding; an approval that swallowed them would be a worse review than the
  // manual pass, which named all three.
  const reference = REFERENCE_REVIEWS[0];
  const repo = 'laceyenterprises/adversarial-review';
  const { jobPath } = enqueueArgusSecurityReview({
    rootDir: root,
    repo,
    prNumber: reference.prNumber,
    headSha: reference.headSha,
    reasons: [{ trigger: 'bot-author' }],
  });
  completeArgusJob({ rootDir: root, jobPath, result: reference.result });

  const verdict = resolveArgusSecurityVerdict({
    rootDir: root,
    repo,
    prNumber: reference.prNumber,
    headSha: reference.headSha,
  });

  assert.equal(verdict.advisoryFindings.length, 3);
  assert.equal(verdict.satisfiesGate, true);
  assert.match(verdict.summary, /3 advisory findings/);
}));

test('the same reference PR blocks the moment a high finding appears', () => withRoot((root) => {
  // The counterfactual that proves the approval above is a decision and not a
  // rubber stamp. #909 with an install-script finding is #909 blocked.
  const reference = REFERENCE_REVIEWS[0];
  const repo = 'laceyenterprises/adversarial-review';
  const { jobPath } = enqueueArgusSecurityReview({
    rootDir: root,
    repo,
    prNumber: reference.prNumber,
    headSha: reference.headSha,
    reasons: [{ trigger: 'bot-author' }],
  });
  completeArgusJob({
    rootDir: root,
    jobPath,
    result: {
      ...reference.result,
      findings: [
        ...reference.result.findings,
        {
          severity: 'high',
          category: 'install_execution',
          title: 'postinstall script added',
        },
      ],
    },
  });

  const verdict = resolveArgusSecurityVerdict({
    rootDir: root,
    repo,
    prNumber: reference.prNumber,
    headSha: reference.headSha,
  });
  const decision = pickAdversarialGateStatus({
    reviewRow: { review_status: 'argus-security-queued', reviewer: 'argus-security' },
    headSha: reference.headSha,
    argusVerdict: verdict,
  });

  assert.equal(decision.state, 'failure');
  assert.equal(decision.reason, 'argus-security-blocked');
}));

test('a high finding blocks a routable PR whose own review came back clean', () => withRoot((root) => {
  // The additive case, and the one most likely to be lost in a refactor. A
  // human PR that adds a dependency gets a normal adversarial review; that
  // review reads the diff, not the lockfile, so it approves. Argus is the only
  // thing that looked at the dependency surface.
  const repo = 'laceyenterprises/adversarial-review';
  const headSha = 'c'.repeat(40);
  const { jobPath } = enqueueArgusSecurityReview({
    rootDir: root,
    repo,
    prNumber: 1234,
    headSha,
    reasons: [{ trigger: 'dependency-manifest' }],
  });
  completeArgusJob({
    rootDir: root,
    jobPath,
    result: {
      schemaVersion: 1,
      verdict: 'block',
      blocksMerge: true,
      isApproval: false,
      highestSeverity: 'high',
      findings: [{ severity: 'high', category: 'install_execution', title: 'preinstall added' }],
    },
  });

  const verdict = resolveArgusSecurityVerdict({ rootDir: root, repo, prNumber: 1234, headSha });
  const decision = pickAdversarialGateStatus({
    // A clean, settled row from the ordinary lane.
    reviewRow: {
      review_status: 'reviewed',
      reviewer: 'claude-code',
      reviewer_head_sha: headSha,
      verdict: 'approve',
    },
    headSha,
    argusVerdict: verdict,
  });

  assert.equal(decision.state, 'failure');
  assert.equal(decision.reason, 'argus-security-blocked');
}));

test('a PR Argus never reviewed is unaffected by the verdict wiring', () => withRoot((root) => {
  // The regression that would matter most in production: the gate runs for
  // every PR, and the overwhelming majority fired no security trigger.
  const repo = 'laceyenterprises/adversarial-review';
  const headSha = 'd'.repeat(40);
  const verdict = resolveArgusSecurityVerdict({ rootDir: root, repo, prNumber: 4321, headSha });

  assert.equal(verdict.state, 'missing');
  assert.equal(verdict.blocks, false);

  const decision = pickAdversarialGateStatus({
    reviewRow: { review_status: 'pending', reviewer: 'claude-code' },
    headSha,
    argusVerdict: verdict,
  });
  assert.equal(decision.reason, 'review-queued', 'an unreviewed PR must take its normal path');
}));
