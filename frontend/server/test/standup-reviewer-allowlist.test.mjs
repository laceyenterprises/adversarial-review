/**
 * The reviewer allowlist (ARF-06).
 *
 * The property under test is the one the ticket names: a bot login goes in, and
 * a verify step confirms it is there. Everything else in this file exists
 * because of a way that has gone wrong before — case, the `[bot]` suffix,
 * alternate spellings of one identity, and a file that is present but not the
 * shape ARF expects.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ReviewerAllowlistError, addAllowlistEntry, describeVerificationFailure,
  emptyReviewerAllowlist, findAllowlistEntry, parseReviewerAllowlist, verifyAllowlist,
} from '../src/standup/reviewer-allowlist.mjs';

const AT = '2026-08-19T12:00:00.000Z';

function seed() {
  return addAllowlistEntry(emptyReviewerAllowlist(), {
    login: 'claude-reviewer[bot]',
    logins: ['claude-reviewer[bot]', 'lacey-claude-reviewer'],
    harnessClass: 'claude-reviewer',
    entitlement: 'claude-reviewer-worker',
    kind: 'github_app',
    at: AT,
  }).state;
}

describe('reviewer allowlist wiring', () => {
  it('adds the bot login and every declared form of it', () => {
    const state = seed();
    assert.equal(state.entries.length, 1);
    assert.equal(state.entries[0].login, 'claude-reviewer[bot]');
    assert.deepEqual(state.entries[0].logins, ['claude-reviewer[bot]', 'lacey-claude-reviewer']);
    assert.equal(state.entries[0].harnessClass, 'claude-reviewer');
    assert.equal(state.entries[0].addedBy, 'arf-harness-standup');
  });

  it('persists the documented allowlist entry shape', () => {
    const [entry] = seed().entries;
    assert.deepEqual(Object.keys(entry).sort(), [
      'addedAt',
      'addedBy',
      'entitlement',
      'harnessClass',
      'kind',
      'login',
      'logins',
      'note',
      'updatedAt',
    ]);
  });

  it('matches case-insensitively — GitHub logins are', () => {
    const state = seed();
    assert.ok(findAllowlistEntry(state, 'Claude-Reviewer[Bot]'));
    assert.ok(findAllowlistEntry(state, 'LACEY-CLAUDE-REVIEWER'));
  });

  it('does not treat an App entry as allowlisting the bare slug', () => {
    // `foo` and `foo[bot]` are different accounts. Folding them together would
    // count a human's comments as the App's reviews.
    assert.equal(findAllowlistEntry(seed(), 'claude-reviewer'), null);
  });

  it('is idempotent: re-adding the same entry changes nothing', () => {
    const state = seed();
    const again = addAllowlistEntry(state, {
      login: 'claude-reviewer[bot]',
      logins: ['claude-reviewer[bot]', 'lacey-claude-reviewer'],
      harnessClass: 'claude-reviewer',
      entitlement: 'claude-reviewer-worker',
      kind: 'github_app',
      at: '2026-08-20T00:00:00.000Z',
    });
    assert.equal(again.changed, false);
    assert.equal(again.state.entries.length, 1);
    assert.equal(again.state.entries[0].updatedAt, AT, 'an unchanged entry keeps its timestamps');
  });

  it('updates in place when the identity gains an alias', () => {
    const next = addAllowlistEntry(seed(), {
      login: 'claude-reviewer[bot]',
      logins: ['claude-reviewer[bot]', 'lacey-claude-reviewer', 'claude-reviewer-lacey'],
      harnessClass: 'claude-reviewer',
      entitlement: 'claude-reviewer-worker',
      kind: 'github_app',
      at: '2026-08-20T00:00:00.000Z',
    });
    assert.equal(next.changed, true);
    assert.equal(next.state.entries.length, 1);
    assert.equal(next.state.entries[0].addedAt, AT, 'the original registration time survives');
    assert.equal(next.state.entries[0].updatedAt, '2026-08-20T00:00:00.000Z');
  });

  it('refuses to let two harness classes share one review identity', () => {
    assert.throws(() => addAllowlistEntry(seed(), {
      login: 'claude-reviewer[bot]',
      logins: ['claude-reviewer[bot]'],
      harnessClass: 'some-other-class',
      entitlement: 'other-worker',
      kind: 'github_app',
      at: AT,
    }), (err) => {
      assert.ok(err instanceof ReviewerAllowlistError);
      assert.equal(err.code, 'reviewer_allowlist_conflict');
      return true;
    });
  });
});

describe('reviewer allowlist verification', () => {
  it('confirms every declared posting login', () => {
    const verdict = verifyAllowlist(seed(), {
      logins: ['claude-reviewer[bot]', 'lacey-claude-reviewer'],
      harnessClass: 'claude-reviewer',
    });
    assert.equal(verdict.present, true);
    assert.deepEqual(verdict.missing, []);
    assert.equal(verdict.entry.harnessClass, 'claude-reviewer');
  });

  it('fails on a partially-allowlisted identity', () => {
    // Half the identity's reviews counting and half not reads as a flaky
    // pipeline rather than as a configuration gap, so a partial match is a fail.
    const verdict = verifyAllowlist(seed(), {
      logins: ['claude-reviewer[bot]', 'claude-reviewer-lacey'],
      harnessClass: 'claude-reviewer',
    });
    assert.equal(verdict.present, false);
    assert.deepEqual(verdict.missing, ['claude-reviewer-lacey']);
  });

  it('fails when the login is allowlisted for a different class', () => {
    const verdict = verifyAllowlist(seed(), {
      logins: ['claude-reviewer[bot]'],
      harnessClass: 'gemini-reviewer',
    });
    assert.equal(verdict.present, false);
    assert.deepEqual(verdict.mismatched, [
      { login: 'claude-reviewer[bot]', allowlistedFor: 'claude-reviewer' },
    ]);
  });

  it('fails against an empty allowlist and says what that means', () => {
    const verdict = verifyAllowlist(emptyReviewerAllowlist(), {
      logins: ['claude-reviewer[bot]'],
      harnessClass: 'claude-reviewer',
    });
    assert.equal(verdict.present, false);
    const message = describeVerificationFailure(verdict, { path: '/tmp/allowlist.json' });
    assert.match(message, /not in the reviewer allowlist at \/tmp\/allowlist\.json/);
    assert.match(message, /reads as unreviewed with no error anywhere/);
  });
});

describe('reviewer allowlist parsing', () => {
  it('reads a document written by an earlier run', () => {
    const state = parseReviewerAllowlist(seed(), { source: 'file' });
    assert.equal(state.entries.length, 1);
  });

  it('refuses a present-but-malformed document rather than treating it as empty', () => {
    // Treating it as empty would have the next write replace it, silently
    // discarding entries nobody knew were at risk.
    assert.throws(() => parseReviewerAllowlist({ entries: 'nope' }), /"entries" must be an array/);
    assert.throws(() => parseReviewerAllowlist({ entries: [{}] }), /has no "login"/);
    assert.throws(() => parseReviewerAllowlist([]), /must contain a JSON object/);
  });

  it('reads an absent document as empty', () => {
    assert.deepEqual(parseReviewerAllowlist(null).entries, []);
  });
});
