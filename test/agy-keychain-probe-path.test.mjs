import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AGY_KEYCHAIN_ACCOUNT,
  AGY_KEYCHAIN_SERVICE,
  DEFAULT_AGY_KEYCHAIN_RELATIVE_PATH,
  agyKeychainProbeArgs,
  checkAgyReviewerAuth,
  clearAgyReviewerAuthCache,
  resolveAgyKeychainPath,
} from '../src/agy-reviewer-auth.mjs';

// Regression: the keychain probe used to omit the keychain operand entirely, so
// `security find-generic-password` searched the calling security session's default
// search list. Under the system bootstrap namespace the per-user login keychain is
// absent from that list, so a launchd-spawned watcher reported `keychain-missing`
// for an item that existed and was readable from a login shell. The reader must name
// the same keychain the bootstrap writer uses.

test('keychain probe names the per-user login keychain derived from HOME', () => {
  const args = agyKeychainProbeArgs({ HOME: '/Users/airlock' });
  assert.deepEqual(args, [
    'find-generic-password',
    '-s',
    AGY_KEYCHAIN_SERVICE,
    '-a',
    AGY_KEYCHAIN_ACCOUNT,
    `/Users/airlock/${DEFAULT_AGY_KEYCHAIN_RELATIVE_PATH}`,
  ]);
});

test('AGY_KEYCHAIN_PATH overrides the derived keychain path', () => {
  const args = agyKeychainProbeArgs({
    HOME: '/Users/airlock',
    AGY_KEYCHAIN_PATH: '/tmp/custom.keychain-db',
  });
  assert.equal(args.at(-1), '/tmp/custom.keychain-db');
});

test('trailing slashes in HOME do not produce a doubled separator', () => {
  assert.equal(
    resolveAgyKeychainPath({ HOME: '/Users/airlock//' }),
    `/Users/airlock/${DEFAULT_AGY_KEYCHAIN_RELATIVE_PATH}`,
  );
});

test('probe falls back to the session search list when HOME is unset', () => {
  assert.equal(resolveAgyKeychainPath({}), '');
  const args = agyKeychainProbeArgs({});
  // No empty operand: `security` rejects an empty keychain argument outright.
  assert.deepEqual(args, ['find-generic-password', '-s', AGY_KEYCHAIN_SERVICE, '-a', AGY_KEYCHAIN_ACCOUNT]);
});

test('checkAgyReviewerAuth passes the keychain path through to the security CLI', async () => {
  clearAgyReviewerAuthCache();
  const calls = [];
  const result = await checkAgyReviewerAuth({
    env: { HOME: '/Users/airlock', PATH: '/opt/homebrew/bin', USER: 'airlock' },
    agyCli: 'agy',
    securityCli: 'security',
    execFileImpl: (file, args) => {
      calls.push({ file, args });
      if (args?.[0] === 'find-generic-password') return Promise.resolve({ stdout: 'ok', stderr: '' });
      return Promise.resolve({ stdout: 'gemini-3.6-flash-high\n', stderr: '' });
    },
  });

  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  const probe = calls.find((call) => call.args?.[0] === 'find-generic-password');
  assert.ok(probe, 'expected a find-generic-password probe');
  assert.equal(probe.args.at(-1), `/Users/airlock/${DEFAULT_AGY_KEYCHAIN_RELATIVE_PATH}`);
});

test('a success cached under one keychain does not satisfy a different keychain', async () => {
  clearAgyReviewerAuthCache();
  let probes = 0;
  const execFileImpl = (file, args) => {
    if (args?.[0] === 'find-generic-password') {
      probes += 1;
      return Promise.resolve({ stdout: 'ok', stderr: '' });
    }
    return Promise.resolve({ stdout: 'gemini-3.6-flash-high\n', stderr: '' });
  };
  const base = { HOME: '/Users/airlock', PATH: '/opt/homebrew/bin', USER: 'airlock' };

  await checkAgyReviewerAuth({ env: base, execFileImpl });
  assert.equal(probes, 1);
  // Same env except the keychain override -> must re-probe rather than reuse the hit.
  await checkAgyReviewerAuth({ env: { ...base, AGY_KEYCHAIN_PATH: '/tmp/other.keychain-db' }, execFileImpl });
  assert.equal(probes, 2, 'keychain path must participate in the success cache key');
});
