import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isUnroutableBotAuthor,
  markMalformedTitleTerminalState,
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

test('unroutable bot terminal marking is a single full-row update', () => {
  const calls = [];
  const status = markMalformedTitleTerminalState({
    prTitle: 'chore(deps): bump sqlite',
    failureAt: '2026-08-24T19:30:00.000Z',
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 911,
    unroutableBot: true,
    markMalformedStatement: {
      run: (...args) => calls.push(['malformed', args]),
    },
    markUnroutableBotStatement: {
      run: (...args) => calls.push(['unroutable', args]),
    },
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
});

test('human malformed title terminal marking does not touch the bot status', () => {
  const calls = [];
  const status = markMalformedTitleTerminalState({
    prTitle: 'fix typo',
    failureAt: '2026-08-24T19:31:00.000Z',
    repoPath: 'laceyenterprises/adversarial-review',
    prNumber: 912,
    unroutableBot: false,
    markMalformedStatement: {
      run: (...args) => calls.push(['malformed', args]),
    },
    markUnroutableBotStatement: {
      run: (...args) => calls.push(['unroutable', args]),
    },
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
