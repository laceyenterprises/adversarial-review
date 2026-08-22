/**
 * The harness manifest's validation rules (ARF-06).
 *
 * These are the refusals that have to happen at registration, while an operator
 * is still looking at the form, rather than at first dispatch or at deploy time.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  HarnessManifestError, harnessRecord, normalizeHarnessSpec, postingLogins, stripBotSuffix,
} from '../src/standup/harness-manifest.mjs';
import { harnessCatalog } from '../src/standup/catalog.mjs';
import { harnessSpec } from './helpers/standup-fixtures.mjs';

describe('harness spec validation', () => {
  it('normalizes a complete reviewer spec', () => {
    const spec = normalizeHarnessSpec(harnessSpec());
    assert.equal(spec.class, 'claude-reviewer');
    assert.equal(spec.entitlement, 'claude-reviewer-worker');
    assert.equal(spec.defaultModel, 'claude-opus-5');
    assert.equal(spec.modelAuth.mode, 'broker-oauth');
    assert.equal(spec.modelAuth.brokerRole, 'claude-reviewer');
    assert.equal(spec.runtime.command, 'claude');
    // Reviewers are allowlisted by default: the whole failure mode is a reviewer
    // whose posts are not counted, so opting out has to be typed.
    assert.equal(spec.reviewerAllowlist.enabled, true);
  });

  it('requires an entitlement', () => {
    const spec = harnessSpec();
    delete spec.entitlement;
    assert.throws(() => normalizeHarnessSpec(spec), (err) => {
      assert.ok(err instanceof HarnessManifestError);
      assert.match(err.message, /harness\.entitlement is required/);
      return true;
    });
  });

  it('refuses a defaultModel outside allowedModels', () => {
    // allowedModels is a fail-closed allowlist in the registry this shape comes
    // from: a default outside it registers cleanly and then never dispatches.
    assert.throws(
      () => normalizeHarnessSpec(harnessSpec({ defaultModel: 'claude-something-else' })),
      /is not in harness\.allowedModels/,
    );
  });

  it('refuses an empty or duplicated model allowlist', () => {
    assert.throws(() => normalizeHarnessSpec(harnessSpec({ allowedModels: [] })), /at least 1 entry/);
    assert.throws(
      () => normalizeHarnessSpec(harnessSpec({ allowedModels: ['a', 'a'], defaultModel: 'a' })),
      /lists "a" twice/,
    );
  });

  it('refuses an unknown key rather than ignoring it', () => {
    assert.throws(
      () => normalizeHarnessSpec({ ...harnessSpec(), allowdModels: ['x'] }),
      /unknown key "allowdModels"/,
    );
  });

  it('refuses request-controlled runtime probe and install arguments', () => {
    assert.throws(
      () => normalizeHarnessSpec(harnessSpec({
        runtime: { command: 'node', versionArgs: ['-e', 'process.exit(0)'] },
      })),
      /harness\.runtime has unknown key "versionArgs"/,
    );
    assert.throws(
      () => normalizeHarnessSpec(harnessSpec({
        runtime: { command: 'python3', installCommand: 'python3', installArgs: ['-c', 'print(1)'] },
      })),
      /harness\.runtime has unknown key "installCommand"/,
    );
  });

  it('uses server-owned runtime argv for accepted runtime declarations', () => {
    const spec = normalizeHarnessSpec(harnessSpec({ runtime: { command: 'node', minVersion: '20.0.0' } }));
    assert.deepEqual(spec.runtime.versionArgs, ['--version']);
    assert.equal(spec.runtime.installCommand, null);
    assert.deepEqual(spec.runtime.installArgs, []);
    assert.equal(spec.runtime.minVersion, '20.0.0');
  });

  it('keeps every catalog template in the accepted request shape', () => {
    for (const template of harnessCatalog()) {
      const spec = normalizeHarnessSpec(template.spec);
      assert.deepEqual(spec.runtime.versionArgs, ['--version']);
    }
  });

  it('refuses a raw secret where a model-auth token reference belongs', () => {
    assert.throws(
      () => normalizeHarnessSpec(harnessSpec({
        modelAuth: { mode: 'standalone-token', tokenRef: 'sk-ant-not-a-reference' },
      })),
      /no recognised scheme/,
    );
  });

  it('refuses two credential sources on one harness', () => {
    assert.throws(
      () => normalizeHarnessSpec(harnessSpec({
        modelAuth: { mode: 'broker-oauth', brokerRole: 'r', tokenRef: 'env:TOKEN' },
      })),
      /tokenRef is not valid in mode=broker-oauth/,
    );
    assert.throws(
      () => normalizeHarnessSpec(harnessSpec({
        modelAuth: { mode: 'standalone-token', tokenRef: 'env:TOKEN', brokerRole: 'r' },
      })),
      /brokerRole is not valid in mode=standalone-token/,
    );
  });

  it('requires a broker role for broker-OAuth', () => {
    assert.throws(
      () => normalizeHarnessSpec(harnessSpec({ modelAuth: { mode: 'broker-oauth' } })),
      /modelAuth\.brokerRole is required/,
    );
  });
});

describe('posting logins', () => {
  it('derives the [bot] form for a GitHub App identity', () => {
    // An App's posts are authored by `<slug>[bot]`, never by the bare slug, so
    // an allowlist holding the slug matches nothing the App ever writes.
    const spec = normalizeHarnessSpec(harnessSpec());
    assert.deepEqual(spec.botIdentity.postingLogins, ['claude-reviewer[bot]']);
  });

  it('keeps a user identity as typed', () => {
    const spec = normalizeHarnessSpec(harnessSpec({
      botIdentity: { login: 'lacey-claude-reviewer', kind: 'github_user' },
    }));
    assert.deepEqual(spec.botIdentity.postingLogins, ['lacey-claude-reviewer']);
  });

  it('refuses a [bot] suffix on a user identity', () => {
    assert.throws(
      () => normalizeHarnessSpec(harnessSpec({
        botIdentity: { login: 'someone[bot]', kind: 'github_user' },
      })),
      /carries the "\[bot\]" App suffix but/,
    );
  });

  it('carries declared aliases, primary first and deduplicated', () => {
    // A fleet accumulates spellings for one identity; an allowlist that knows
    // only one of them counts only some of that identity's reviews.
    const spec = normalizeHarnessSpec(harnessSpec({
      botIdentity: {
        login: 'claude-reviewer',
        kind: 'github_app',
        aliases: ['lacey-claude-reviewer', 'claude-reviewer-lacey', 'CLAUDE-REVIEWER[bot]'],
      },
    }));
    assert.deepEqual(spec.botIdentity.postingLogins, [
      'claude-reviewer[bot]', 'lacey-claude-reviewer', 'claude-reviewer-lacey',
    ]);
  });

  it('strips the suffix case-insensitively', () => {
    assert.equal(stripBotSuffix('Foo[BOT]'), 'Foo');
    assert.equal(stripBotSuffix('foo'), 'foo');
    assert.deepEqual(
      postingLogins({ login: 'foo[bot]', kind: 'github_app', aliases: [] }),
      ['foo[bot]'],
    );
  });
});

describe('harness record', () => {
  it('starts unprovisioned, unverified, and not ready', () => {
    const record = harnessRecord(normalizeHarnessSpec(harnessSpec()), {
      registeredAt: '2026-08-19T00:00:00.000Z',
    });
    assert.equal(record.status, 'registering');
    assert.equal(record.modelAuth.provisioned, false);
    assert.equal(record.runtime.verified, false);
    assert.equal(record.reviewerAllowlist.wired, false);
    assert.equal(record.reviewerAllowlist.verified, false);
    assert.deepEqual(record.reviewerAllowlist.logins, ['claude-reviewer[bot]']);
  });

  it('records a token reference, never a value', () => {
    const record = harnessRecord(
      normalizeHarnessSpec(harnessSpec({
        modelAuth: { mode: 'standalone-token', tokenRef: 'env:ANTHROPIC_API_KEY' },
      })),
      { registeredAt: '2026-08-19T00:00:00.000Z' },
    );
    assert.equal(record.modelAuth.tokenRef, 'env:ANTHROPIC_API_KEY');
    assert.equal(record.modelAuth.credential, null);
  });
});
