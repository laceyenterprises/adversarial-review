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

test('watcher launchers require explicit opt-in before running without ALERT_TO', () => {
  for (const scriptName of [
    'adversarial-watcher-start.sh',
    'adversarial-watcher-start-placey.sh',
  ]) {
    const script = readScript(scriptName);
    assert.match(script, /ADVERSARIAL_REVIEW_ALLOW_MISSING_ALERT_TO=1/);
    assert.match(script, /resolve_alert_to_optional/);
    assert.match(script, /unset ALERT_TO/);
    assert.match(script, /status -eq 4/);
    assert.match(script, /ADVERSARIAL_REVIEW_OP_CLI/);
    assert.match(script, /command -v op/);
    assert.match(script, /OP_BIN="\$\(resolve_op_bin\)"/);
    assert.match(script, /"\$OP_BIN" read/);
    assert.doesNotMatch(script, /\/opt\/homebrew\/bin\/op read/);
  }
});
