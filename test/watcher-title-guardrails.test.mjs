import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MALFORMED_TITLE_COMMENT_HEADER,
  REQUIRED_PREFIXES,
  buildMalformedTitleFailureComment,
  routePR,
} from '../src/watcher-title-guardrails.mjs';
import { TAG_PREFIXES } from '../src/pr-title-tagging.mjs';
import { signalMalformedTitleFailure } from '../src/watcher-fail-loud.mjs';

test('routePR maps known title prefixes to opposite-model reviewers', () => {
  assert.deepEqual(routePR('[codex] LAC-181: tighten watcher'), {
    tag: 'codex',
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
  });

  assert.deepEqual(routePR('[claude-code] LAC-181: tighten watcher'), {
    tag: 'claude-code',
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  });

  assert.deepEqual(routePR('[clio-agent] LAC-181: tighten watcher'), {
    tag: 'clio-agent',
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  });
});

test('routePR returns null for malformed titles missing required prefix', () => {
  assert.equal(routePR('LAC-181: missing reviewer tag'), null);
  assert.equal(routePR('[codex LAC-181 malformed prefix'), null);
  assert.equal(routePR('[codex]'), null);
  assert.equal(routePR('[codex] [claude-code] stacked prefix'), null);
  assert.equal(routePR('[other] LAC-181: unknown tag'), null);
});

test('required prefixes are derived from canonical tag prefixes', () => {
  assert.deepEqual(REQUIRED_PREFIXES, Object.values(TAG_PREFIXES));
});

test('buildMalformedTitleFailureComment explains creation-time tag requirement', () => {
  const body = buildMalformedTitleFailureComment({ prTitle: 'LAC-181: missing `tag`' });

  assert.match(body, new RegExp(MALFORMED_TITLE_COMMENT_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const prefix of REQUIRED_PREFIXES) {
    assert.match(body, new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(body, /must be present at PR creation time/i);
  assert.match(body, /retitling may not retrigger adversarial review/i);
  assert.match(body, /Safe recovery path: open a new PR/i);
  assert.match(body, /`LAC-181: missing \\`tag\\``/);
});

test('signalMalformedTitleFailure posts fail-loud PR comment', async () => {
  const calls = [];
  const octokit = {
    rest: {
      issues: {
        createComment: async (payload) => {
          calls.push(payload);
          return { data: { id: 1 } };
        },
      },
    },
  };

  await signalMalformedTitleFailure(octokit, {
    repoPath: 'laceyenterprises/clio',
    owner: 'laceyenterprises',
    repo: 'clio',
    prNumber: 42,
    prTitle: 'LAC-181: missing tag',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].owner, 'laceyenterprises');
  assert.equal(calls[0].repo, 'clio');
  assert.equal(calls[0].issue_number, 42);
  assert.match(calls[0].body, /Adversarial review did not trigger/i);
  assert.match(calls[0].body, /retitling may not retrigger adversarial review/i);
});
