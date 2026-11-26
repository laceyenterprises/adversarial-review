import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { grokReviewerLaneEnabled } from '../src/grok-reviewer-lane.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const HELPER = join(__dirname, '..', 'scripts', 'lib', 'reviewer-broker.sh');
const ZSH_PATH = '/bin/zsh';
const ZSH_AVAILABLE = existsSync(ZSH_PATH);
const SKIP_REASON_NO_ZSH = `${ZSH_PATH} is not available on this host`;

function writeExecutable(filePath, body) {
  writeFileSync(filePath, body, 'utf8');
  chmodSync(filePath, 0o755);
}

function runHelperShell(snippet, env = {}) {
  return execFileSync(
    '/bin/bash',
    [
      '-c',
      `source "${HELPER}"; ${snippet}`,
    ],
    {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    },
  );
}

test(
  'reviewer-broker helper sources cleanly under zsh (regression: bash-only ${!var} bad-substitution)',
  { skip: ZSH_AVAILABLE ? false : SKIP_REASON_NO_ZSH },
  () => {
    // Watcher entry scripts use #!/bin/zsh, so the sourced helper must
    // avoid bash-only indirect-variable expansion. Smoke under zsh.
    const onOut = execFileSync(
      ZSH_PATH,
      ['-c', `source "${HELPER}"; reviewer_broker_mode_enabled claude-reviewer && echo enabled || echo disabled`],
      { env: { ...process.env, CLAUDE_REVIEWER_AUTH_VIA_BROKER: 'true' }, encoding: 'utf8' },
    );
    assert.equal(onOut.trim(), 'enabled');
    const offOut = execFileSync(
      ZSH_PATH,
      ['-c', `source "${HELPER}"; reviewer_broker_mode_enabled claude-reviewer && echo enabled || echo disabled`],
      { env: { ...process.env, CLAUDE_REVIEWER_AUTH_VIA_BROKER: '' }, encoding: 'utf8' },
    );
    assert.equal(offOut.trim(), 'disabled');
  },
);

test('reviewer_broker_mode_enabled returns 0 (truthy) when the role flag is "true"', () => {
  const out = runHelperShell(
    'reviewer_broker_mode_enabled claude-reviewer && echo "yes" || echo "no"',
    { CLAUDE_REVIEWER_AUTH_VIA_BROKER: 'true' },
  );
  assert.equal(out.trim(), 'yes');
});

test('reviewer_broker_mode_enabled returns 1 when the role flag is unset', () => {
  const out = runHelperShell(
    'reviewer_broker_mode_enabled claude-reviewer && echo "yes" || echo "no"',
    { CLAUDE_REVIEWER_AUTH_VIA_BROKER: '' },
  );
  assert.equal(out.trim(), 'no');
});

test('reviewer_broker_mode_enabled returns 1 when the role flag is "false"', () => {
  const out = runHelperShell(
    'reviewer_broker_mode_enabled codex-reviewer && echo "yes" || echo "no"',
    { CODEX_REVIEWER_AUTH_VIA_BROKER: 'false' },
  );
  assert.equal(out.trim(), 'no');
});

test('shell helper requests the repo and role and clears a stale token on adapter refusal', t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-ghx-shell-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = join(root, 'github-adapter');
  writeExecutable(adapter, `#!/bin/sh
[ "$*" = 'token --role codex-reviewer --repo rundix/fixture' ] || exit 1
printf '%s\n' '{"ok":true,"access_token":"synthetic-reviewer"}'
`);
  const env = { GHA_ADAPTER_BIN: adapter, GH_CODEX_REVIEWER_TOKEN: 'stale-token' };
  assert.equal(runHelperShell('resolve_reviewer_token_via_broker GH_CODEX_REVIEWER_TOKEN codex-reviewer rundix/fixture && printf %s "$GH_CODEX_REVIEWER_TOKEN"', env), 'synthetic-reviewer');
  assert.equal(runHelperShell('resolve_reviewer_token_via_broker GH_CODEX_REVIEWER_TOKEN codex-reviewer fixture/other 2>/dev/null || printf %s "${GH_CODEX_REVIEWER_TOKEN:-cleared}"', env), 'cleared');
});

test('Grok lane CFG predicate requires both switches and refuses unreadable config', () => {
  for (const master of [false, true]) {
    for (const reviewer of [false, true]) {
      assert.equal(grokReviewerLaneEnabled({
        loaderImpl: () => ({ get: (key) => key === 'grok.enabled' ? master : reviewer }),
      }), master && reviewer);
    }
  }
  assert.equal(grokReviewerLaneEnabled({ loaderImpl: () => { throw new Error('synthetic CFG failure'); } }), false);
});
