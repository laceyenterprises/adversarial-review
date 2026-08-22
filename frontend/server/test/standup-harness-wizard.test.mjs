/**
 * The harness standup wizard end to end (ARF-06 acceptance).
 *
 * The three properties the ticket asks for, in order:
 *
 *   1. the harness manifest is written with class + entitlement + model-auth mode;
 *   2. allowlist wiring adds the bot login and a verify step confirms it;
 *   3. a standalone-token run completes with no in-OS broker dependency.
 *
 * Plus the negative that gives (2) its teeth: when the allowlist entry is not
 * there, the run fails and the harness never reads as ready.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createHarnessStandup } from '../src/standup/harness-wizard.mjs';
import {
  fakeBinary, fakeBroker, fakeExecFile, fakeSecretResolver, forbiddenBroker, harnessSpec,
  testConfig, tmpStateRoot, withConfigFile,
} from './helpers/standup-fixtures.mjs';

/** A wizard whose runtime probe finds a real (fake) binary in the state root. */
function wizard({ stateRoot = tmpStateRoot(), broker = fakeBroker(), resolveSecret = null, env = {} } = {}) {
  const binDir = join(stateRoot, 'bin');
  fakeBinary(binDir, 'claude');
  const config = testConfig(withConfigFile(stateRoot, {
    standup: { runtimeSearchPath: [binDir] },
  }));
  return {
    stateRoot,
    config,
    standup: createHarnessStandup({
      config,
      broker,
      resolveSecret,
      execFileImpl: fakeExecFile({ claude: { stdout: 'claude 1.4.2 (fixture)\n' } }),
      env: { PATH: '', ...env },
    }),
    manifest: () => JSON.parse(readFileSync(config.standup.harnessManifestPath, 'utf8')),
    allowlist: () => JSON.parse(readFileSync(config.standup.reviewerAllowlistPath, 'utf8')),
  };
}

function collect() {
  const events = [];
  return { events, emit: (event) => events.push(event) };
}

describe('harness standup: the manifest', () => {
  it('writes class + entitlement + model-auth mode, and reaches ready', async () => {
    const app = wizard();
    const stream = collect();
    const summary = await app.standup.run(harnessSpec(), { emit: stream.emit });

    assert.equal(summary.status, 'ready');
    assert.equal(summary.failedStep, null);
    assert.deepEqual(summary.steps.map((step) => step.status), ['ok', 'ok', 'ok', 'ok', 'ok']);

    const record = app.manifest().harnesses['claude-reviewer'];
    assert.equal(record.class, 'claude-reviewer');
    assert.equal(record.entitlement, 'claude-reviewer-worker');
    assert.equal(record.modelAuth.mode, 'broker-oauth');
    assert.equal(record.modelAuth.brokerRole, 'claude-reviewer');
    assert.equal(record.modelAuth.provisioned, true);
    assert.deepEqual(record.allowedModels, ['claude-opus-5', 'claude-sonnet-5']);
    assert.equal(record.defaultModel, 'claude-opus-5');
    assert.equal(record.status, 'ready');
    assert.equal(record.runtime.verified, true);
    assert.match(record.runtime.version, /claude 1\.4\.2/);

    // The credential is described, never carried.
    assert.equal(record.modelAuth.credential.fingerprint, 'abc123def456');
    assert.equal(JSON.stringify(record).includes('ghs_'), false);

    const names = stream.events.map((event) => event.event);
    assert.equal(names[0], 'run.start');
    assert.equal(names.at(-1), 'run.done');
    assert.equal(names.filter((name) => name === 'step.ok').length, 5);
  });

  it('re-running is idempotent and keeps the original registration time', async () => {
    const app = wizard();
    await app.standup.run(harnessSpec());
    const first = app.manifest().harnesses['claude-reviewer'];
    const allowlistBefore = app.allowlist();

    const second = await app.standup.run(harnessSpec());
    assert.equal(second.status, 'ready');
    const after = app.manifest().harnesses['claude-reviewer'];
    assert.equal(after.registeredAt, first.registeredAt);
    assert.deepEqual(app.allowlist().entries, allowlistBefore.entries);
  });
});

describe('harness standup: allowlist wiring and verification', () => {
  it('adds the bot login to the allowlist and confirms it by re-reading the file', async () => {
    const app = wizard();
    const stream = collect();
    await app.standup.run(harnessSpec(), { emit: stream.emit });

    const allowlist = app.allowlist();
    assert.equal(allowlist.entries.length, 1);
    assert.equal(allowlist.entries[0].login, 'claude-reviewer[bot]');
    assert.equal(allowlist.entries[0].harnessClass, 'claude-reviewer');

    const verify = stream.events.find(
      (event) => event.data.step === 'verify-allowlist' && event.event === 'step.ok',
    );
    assert.ok(verify, 'the verify step ran and passed');
    assert.equal(verify.data.detail.verified, true);
    assert.match(verify.data.detail.detail, /confirmed by re-reading/);

    const record = app.manifest().harnesses['claude-reviewer'];
    assert.equal(record.reviewerAllowlist.wired, true);
    assert.equal(record.reviewerAllowlist.verified, true);
    assert.deepEqual(record.reviewerAllowlist.logins, ['claude-reviewer[bot]']);
  });

  it('fails the run — and refuses "ready" — when the entry is not really there', async () => {
    // The scenario the ticket is about: the allowlist write does not stick. This
    // is what makes the verify step a verify step rather than a formality, so it
    // is simulated by emptying the file between wiring and verification.
    const app = wizard();
    const allowlistPath = app.config.standup.reviewerAllowlistPath;
    const original = app.standup.run.bind(app.standup);

    const stream = collect();
    const summary = await original(harnessSpec(), {
      emit: (event) => {
        stream.emit(event);
        if (event.event === 'step.ok' && event.data.step === 'wire-allowlist') {
          writeFileSync(allowlistPath, JSON.stringify({ version: 1, entries: [] }));
        }
      },
    });

    assert.equal(summary.status, 'failed');
    assert.equal(summary.failedStep, 'verify-allowlist');
    const failure = summary.steps.at(-1);
    assert.equal(failure.code, 'reviewer_allowlist_unverified');
    assert.match(failure.message, /not in the reviewer allowlist/);

    const record = app.manifest().harnesses['claude-reviewer'];
    assert.equal(record.status, 'incomplete');
    assert.equal(record.failedStep, 'verify-allowlist');
    assert.equal(record.reviewerAllowlist.verified, false);
  });

  it('records an explicit opt-out instead of quietly not wiring', async () => {
    const app = wizard();
    const summary = await app.standup.run(harnessSpec({
      kind: 'worker',
      reviewerAllowlist: { enabled: false },
    }));
    assert.equal(summary.status, 'ready');
    const wiring = summary.steps.find((step) => step.step === 'wire-allowlist');
    assert.equal(wiring.status, 'skipped');
    assert.match(wiring.detail.reason, /will not\s+be counted as reviews/);
    assert.equal(app.manifest().harnesses['claude-reviewer'].reviewerAllowlist.enabled, false);
  });
});

describe('harness standup: standalone-token mode', () => {
  it('completes with no broker: nothing calls one, and nothing needs one', async () => {
    // `forbiddenBroker` throws on any contact, so this passing means the
    // standalone path never reached for a broker — not merely that it survived
    // one being absent.
    const stateRoot = tmpStateRoot();
    const app = wizard({
      stateRoot,
      broker: forbiddenBroker(),
      resolveSecret: fakeSecretResolver({ 'env:ANTHROPIC_API_KEY': 'sk-ant-fixture-value-0123456789' }),
    });

    const summary = await app.standup.run(harnessSpec({
      modelAuth: { mode: 'standalone-token', tokenRef: 'env:ANTHROPIC_API_KEY', provider: 'anthropic' },
    }));

    assert.equal(summary.status, 'ready');
    const record = app.manifest().harnesses['claude-reviewer'];
    assert.equal(record.modelAuth.mode, 'standalone-token');
    assert.equal(record.modelAuth.tokenRef, 'env:ANTHROPIC_API_KEY');
    assert.equal(record.modelAuth.brokerRole, null);
    assert.equal(record.modelAuth.provisioned, true);
    assert.equal(record.modelAuth.credential.source, 'standalone_token_ref');
    assert.equal(record.modelAuth.credential.tokenType, 'anthropic_api_key');
    assert.equal(record.reviewerAllowlist.verified, true);

    // The value never lands in the manifest — only the reference and a digest.
    const raw = readFileSync(app.config.standup.harnessManifestPath, 'utf8');
    assert.equal(raw.includes('sk-ant-fixture-value'), false);
    assert.match(raw, /"fingerprint": "[0-9a-f]{12}"/);
  });

  it('fails loud when the token reference cannot be resolved', async () => {
    const app = wizard({
      broker: forbiddenBroker(),
      resolveSecret: fakeSecretResolver({}),
    });
    const summary = await app.standup.run(harnessSpec({
      modelAuth: { mode: 'standalone-token', tokenRef: 'env:MISSING_KEY' },
    }));
    assert.equal(summary.status, 'failed');
    assert.equal(summary.failedStep, 'provision-model-auth');
    assert.equal(app.manifest().harnesses['claude-reviewer'].status, 'incomplete');
  });
});

describe('harness standup: broker-OAuth mode', () => {
  it('fails loud on an unmapped role and never substitutes another identity', async () => {
    const broker = fakeBroker({ roles: ['some-other-role'] });
    const app = wizard({ broker });
    const summary = await app.standup.run(harnessSpec());

    assert.equal(summary.status, 'failed');
    assert.equal(summary.failedStep, 'provision-model-auth');
    assert.equal(summary.steps[1].code, 'unmapped_role');
    assert.match(summary.steps[1].message, /refuses to fall back to an ambient or default identity/);

    // The gate is the mapping lookup: no token was ever requested for the role.
    assert.equal(broker.calls.some((call) => call.call === 'resolveToken'), false);

    const record = app.manifest().harnesses['claude-reviewer'];
    assert.equal(record.status, 'incomplete');
    assert.equal(record.modelAuth.provisioned, false);
    // And the steps after it never ran, so nothing downstream reports success
    // on a harness with no credential.
    assert.deepEqual(summary.steps.slice(2).map((step) => step.status), ['skipped', 'skipped', 'skipped']);
    assert.throws(() => app.allowlist(), /ENOENT/, 'a failed run wrote no allowlist entry');
  });
});

describe('harness standup: dry runs', () => {
  it('completes without writing anything, and says every result is a dry one', async () => {
    const app = wizard();
    const summary = await app.standup.run(harnessSpec(), { dryRun: true });

    assert.equal(summary.status, 'ready');
    assert.equal(summary.dryRun, true);
    assert.equal(summary.harness, null);
    for (const step of summary.steps) {
      assert.equal(step.detail.dryRun, true, `${step.step} is marked as a dry run`);
    }
    assert.throws(() => app.manifest(), /ENOENT/, 'no manifest was written');
    assert.throws(() => app.allowlist(), /ENOENT/, 'no allowlist was written');
  });

  it('still fails a dry run whose broker role is unmapped', async () => {
    // A dry run that passed regardless would be worthless as a pre-flight.
    const app = wizard({ broker: fakeBroker({ roles: [] }) });
    const summary = await app.standup.run(harnessSpec(), { dryRun: true });
    assert.equal(summary.status, 'failed');
    assert.equal(summary.failedStep, 'provision-model-auth');
  });
});
