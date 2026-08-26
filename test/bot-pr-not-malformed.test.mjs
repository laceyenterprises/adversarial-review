import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isUnroutableBotAuthor,
  markUnroutableTitleDisposition,
} from '../src/pollonce-phases.mjs';

// MAL-01. A PR with no worker prefix was always recorded
// `review_status='malformed'` with "Malformed PR title: <title>". For a fleet
// worker that skipped `hq pr open` that is accurate and actionable. For a bot it
// is a category error: Dependabot owns its own titles (`chore(deps): bump X`),
// can never carry a worker prefix, and retitling would break its update flow.
//
// Measured 2026-08-24: of 51 malformed rows in reviews.db, 33 (65%) were
// `chore(deps...` bot PRs — every one an unfixable, permanent ticket.

test('dependabot is recognised as unroutable', () => {
  assert.equal(isUnroutableBotAuthor('dependabot[bot]'), true);
  assert.equal(isUnroutableBotAuthor('Dependabot[bot]'), true);
  assert.equal(isUnroutableBotAuthor('dependabot-preview[bot]'), true);
});

test('the app/<name> rendering is recognised too', () => {
  // `gh pr view --json author` renders the same author as `app/dependabot`.
  assert.equal(isUnroutableBotAuthor('app/dependabot'), true);
  assert.equal(isUnroutableBotAuthor('app/renovate'), true);
});

test('other known CI bots are recognised', () => {
  assert.equal(isUnroutableBotAuthor('renovate[bot]'), true);
  assert.equal(isUnroutableBotAuthor('github-actions[bot]'), true);
});

test('human and fleet-worker authors are NOT treated as bots', () => {
  // These must keep the actionable "fix your title" malformed classification.
  for (const login of ['VirtualPaul', 'lacey-claude-agent', 'lacey-codex-agent', 'app/lacey-claude-agent']) {
    assert.equal(isUnroutableBotAuthor(login), false, `${login} must stay malformed-eligible`);
  }
});

test('empty and missing authors are not bots', () => {
  assert.equal(isUnroutableBotAuthor(''), false);
  assert.equal(isUnroutableBotAuthor(null), false);
  assert.equal(isUnroutableBotAuthor(undefined), false);
});

test('a lookalike name is not silently treated as a bot', () => {
  // Guard against the prefix-strip accidentally matching a real account.
  assert.equal(isUnroutableBotAuthor('dependabot'), false);
  assert.equal(isUnroutableBotAuthor('not-dependabot[bot]'), false);
});

function recordingStatements() {
  const calls = [];
  return {
    calls,
    markMalformedStatement: { run: (...args) => calls.push(['malformed', args]) },
    markUnroutableBotStatement: { run: (...args) => calls.push(['unroutable', args]) },
    markArgusSecurityQueuedStatement: { run: (...args) => calls.push(['argus-queued', args]) },
  };
}

const SILENT = { warn: () => {}, log: () => {}, error: () => {} };

// ASR-04. The bot branch no longer terminates; it records that Argus owns the
// PR. `#909` and `#910` are what the old write cost: a terminal row means no
// reviewer, no retry and no escalation, so the PR was not refused, it was
// dropped -- for 14 hours, on a major bump of the native driver behind the very
// database the review pipeline runs on.
test('a bot PR with a queued security review is recorded routed, not terminal', () => {
  const { calls, ...statements } = recordingStatements();
  const status = markUnroutableTitleDisposition({
    prTitle: 'chore(deps): bump sqlite',
    failureAt: '2026-08-24T19:30:00.000Z',
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 909,
    unroutableBot: true,
    argusSecurityQueued: true,
    argusReasonSummary: 'bot-author, manifest-change',
    logger: SILENT,
    ...statements,
  });

  assert.equal(status, 'argus-security-queued');
  assert.deepEqual(calls, [[
    'argus-queued',
    [
      'Routed to the Argus security queue (bot-author, manifest-change).',
      '2026-08-24T19:30:00.000Z',
      'laceyenterprises/adversarial-review',
      909,
    ],
  ]]);
});

// The property this whole ticket turns on: no path through the bot branch may
// write terminal state while the route is enabled. An enqueue that could not be
// confirmed this tick is unfinished work, not refused work.
test('a bot PR whose enqueue is unconfirmed writes NOTHING and stays live', () => {
  const { calls, ...statements } = recordingStatements();
  const status = markUnroutableTitleDisposition({
    prTitle: 'chore(deps): bump sqlite',
    failureAt: '2026-08-24T19:30:00.000Z',
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 910,
    unroutableBot: true,
    argusSecurityQueued: false,
    logger: SILENT,
    ...statements,
  });

  assert.equal(status, 'deferred');
  assert.deepEqual(calls, [], 'a deferred bot PR must not be marked terminal or routed');
});

// The kill switch is the ONLY remaining writer of the terminal bot status, and
// it must reproduce the pre-ASR-04 row byte for byte -- a rollback lever whose
// fallback is a third, untested behaviour is not a rollback lever.
test('with the route disabled, a bot PR takes the pre-ASR-04 terminal path', () => {
  const { calls, ...statements } = recordingStatements();
  const warnings = [];
  const status = markUnroutableTitleDisposition({
    prTitle: 'chore(deps): bump sqlite',
    failureAt: '2026-08-24T19:30:00.000Z',
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 911,
    unroutableBot: true,
    argusRouteEnabled: false,
    logger: { warn: (msg) => warnings.push(msg) },
    ...statements,
  });

  assert.equal(status, 'unroutable-bot-author');
  assert.deepEqual(calls, [[
    'unroutable',
    [
      'Unroutable bot-authored PR (no worker prefix is possible): chore(deps): bump sqlite',
      '2026-08-24T19:30:00.000Z',
      '2026-08-24T19:30:00.000Z',
      'laceyenterprises/adversarial-review',
      911,
    ],
  ]]);
  assert.equal(warnings.length, 1, 'a flipped kill switch must never be silent');
  assert.match(warnings[0], /ARGUS_ROUTE_DISABLED/);
});

// The distinction the bot branch exists to make must not blur in either
// direction: a human PR with a bad title prefix is still terminal-malformed, and
// no Argus routing changes that.
test('human malformed title terminal marking is unchanged', () => {
  const { calls, ...statements } = recordingStatements();
  const status = markUnroutableTitleDisposition({
    prTitle: 'fix typo',
    failureAt: '2026-08-24T19:31:00.000Z',
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 912,
    unroutableBot: false,
    logger: SILENT,
    ...statements,
  });

  assert.equal(status, 'malformed');
  assert.deepEqual(calls, [[
    'malformed',
    [
      'Malformed PR title: fix typo',
      '2026-08-24T19:31:00.000Z',
      '2026-08-24T19:31:00.000Z',
      'laceyenterprises/adversarial-review',
      912,
    ],
  ]]);
});

test('a human PR with a security surface is STILL terminal-malformed', () => {
  // The Argus enqueue for a manifest-touching human PR is additive and happens
  // elsewhere; it must never rescue a title the author can and should fix.
  const { calls, ...statements } = recordingStatements();
  const status = markUnroutableTitleDisposition({
    prTitle: 'bump lockfile',
    failureAt: '2026-08-24T19:32:00.000Z',
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 913,
    unroutableBot: false,
    argusSecurityQueued: true,
    argusReasonSummary: 'manifest-change',
    logger: SILENT,
    ...statements,
  });

  assert.equal(status, 'malformed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'malformed');
});
