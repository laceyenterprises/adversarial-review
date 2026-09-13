import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const installer = readFileSync('scripts/install-claude-reviewer-runtime-probe-helper.sh', 'utf8');
const helperMatch = installer.match(/sudoers_escape_command_path\(\) \{\n(?:.*\n)*?\}/);

assert.ok(helperMatch, 'installer should define sudoers_escape_command_path');

function escapeWithInstallerHelper(path) {
  const result = spawnSync(
    'bash',
    ['-c', `${helperMatch[0]}\nsudoers_escape_command_path "$1"`, 'bash', path],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('sudoers helper path is unchanged when no escaping is needed', () => {
  assert.equal(
    escapeWithInstallerHelper('/usr/local/libexec/agent-os/claude-reviewer-runtime-probe'),
    '/usr/local/libexec/agent-os/claude-reviewer-runtime-probe',
  );
});

test('sudoers helper path escapes spaces for custom destinations', () => {
  assert.equal(
    escapeWithInstallerHelper('/Library/Application Support/Agent OS/claude reviewer runtime probe'),
    '/Library/Application\\ Support/Agent\\ OS/claude\\ reviewer\\ runtime\\ probe',
  );
});
