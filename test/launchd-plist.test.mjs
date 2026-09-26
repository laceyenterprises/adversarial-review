import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHD_DIR = path.join(TEST_DIR, '..', 'launchd');

function readLaunchdPlist(name) {
  return readFileSync(path.join(LAUNCHD_DIR, name), 'utf8');
}

function assertStringKey(plist, key, value) {
  assert.match(plist, new RegExp(`<key>${key}</key>\\s*<string>${value}</string>`));
}

test('airlock adversarial daemons run under the airlock account', () => {
  for (const name of [
    'ai.laceyenterprises.adversarial-watcher.airlock.plist',
    'ai.laceyenterprises.adversarial-follow-up.airlock.plist',
  ]) {
    assertStringKey(readLaunchdPlist(name), 'UserName', 'airlock');
  }
});

test('the watcher runs Interactive so a loaded host cannot starve its event loop', () => {
  // WATCHQOS-01: with no ProcessType launchd runs the watcher at PRI 20; at
  // load 120 its readiness probe and `hq attest sign` children timed out.
  for (const name of [
    'ai.laceyenterprises.adversarial-watcher.airlock.plist',
    'ai.laceyenterprises.adversarial-watcher.placey.plist',
  ]) {
    assertStringKey(readLaunchdPlist(name), 'ProcessType', 'Interactive');
  }
});
