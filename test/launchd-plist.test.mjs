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
