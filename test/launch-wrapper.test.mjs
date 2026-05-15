import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

function readScript(name) {
  return readFileSync(join(REPO_ROOT, 'scripts', name), 'utf8');
}

test('placey launcher pins AGENT_OS_ROOT to the legacy shared checkout', () => {
  const script = readScript('adversarial-watcher-start-placey.sh');
  assert.match(script, /export AGENT_OS_ROOT="\/Users\/airlock\/agent-os"/);
});

test('wrapper launchers pass ADV_OP_TOKEN_TAG into the resolver subprocess', () => {
  for (const [scriptName, tag] of [
    ['adversarial-watcher-start.sh', 'adversarial-watcher'],
    ['adversarial-watcher-start-placey.sh', 'adversarial-watcher'],
    ['adversarial-follow-up-tick.sh', 'follow-up-tick'],
  ]) {
    const script = readScript(scriptName);
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      script,
      new RegExp(`OP_SERVICE_ACCOUNT_TOKEN=\\$\\(env ADV_OP_TOKEN_TAG="${escapedTag}" /opt/homebrew/bin/node `),
      `${scriptName} must inject ${tag} into the resolver subprocess`,
    );
  }
});
