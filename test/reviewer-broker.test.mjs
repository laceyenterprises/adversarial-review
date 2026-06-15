// Tests for the reviewer-token OAuth broker helper (2026-06-07).
// Mirrors the GAB-02 merge-agent.sh broker branch contract from
// agent-os modules/worker-pool/lib/hq-gh.sh::_hq_resolve_merge_agent_broker_token,
// but in bash for the watcher's reviewer-token resolution path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const HELPER = join(__dirname, '..', 'scripts', 'lib', 'reviewer-broker.sh');
const SCRIPTS_DIR = join(__dirname, '..', 'scripts');
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

test('resolve_reviewer_token_via_broker fails closed when OAUTH_BROKER_SHARED_SECRET_FILE is empty', () => {
  const out = execFileSync(
    '/bin/bash',
    [
      '-c',
      `source "${HELPER}"; resolve_reviewer_token_via_broker GH_FAKE_REVIEWER_TOKEN claude-reviewer 2>&1; echo "rc=$?"`,
    ],
    {
      env: {
        ...process.env,
        OAUTH_BROKER_SHARED_SECRET_FILE: '',
      },
      encoding: 'utf8',
    },
  );
  assert.match(out, /OAUTH_BROKER_SHARED_SECRET_FILE is empty/);
  assert.match(out, /rc=1\n?$/);
});

test('resolve_reviewer_token_via_broker fails closed when the secret file is unreadable', () => {
  const out = execFileSync(
    '/bin/bash',
    [
      '-c',
      `source "${HELPER}"; resolve_reviewer_token_via_broker GH_FAKE_REVIEWER_TOKEN claude-reviewer 2>&1; echo "rc=$?"`,
    ],
    {
      env: {
        ...process.env,
        OAUTH_BROKER_SHARED_SECRET_FILE: '/no/such/secret/file/exists',
      },
      encoding: 'utf8',
    },
  );
  assert.match(out, /is unreadable/);
  assert.match(out, /rc=1\n?$/);
});

test('resolve_reviewer_token_via_broker bounds broker curl with fetch timeout options', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-broker-timeout-'));
  const bin = join(root, 'bin');
  const secretFile = join(root, 'secret');
  const curlArgsFile = join(root, 'curl-args.txt');
  mkdirSync(bin, { recursive: true });
  writeFileSync(secretFile, 'shared-secret', 'utf8');
  writeExecutable(
    join(bin, 'curl'),
    '#!/bin/bash\n'
      + 'printf "%s\\n" "$@" >"$TEST_CURL_ARGS_FILE"\n'
      + 'exit 28\n',
  );
  writeExecutable(
    join(bin, 'jq'),
    '#!/bin/bash\n'
      + 'exit 1\n',
  );
  const out = execFileSync(
    '/bin/bash',
    [
      '-c',
      `source "${HELPER}"; resolve_reviewer_token_via_broker GH_FAKE_REVIEWER_TOKEN claude-reviewer 2>&1; echo "rc=$?"`,
    ],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        OAUTH_BROKER_SHARED_SECRET_FILE: secretFile,
        REVIEWER_TOKEN_FETCH_TIMEOUT_MS: '250',
        TEST_CURL_ARGS_FILE: curlArgsFile,
      },
      encoding: 'utf8',
    },
  );
  assert.match(out, /rc=1\n?$/);
  const curlArgs = readFileSync(curlArgsFile, 'utf8');
  assert.match(curlArgs, /--connect-timeout\n0\.250\n/);
  assert.match(curlArgs, /--max-time\n0\.250\n/);
});

test('watcher start scripts source the reviewer-broker helper', () => {
  for (const name of [
    'adversarial-watcher-start.sh',
    'adversarial-watcher-start-placey.sh',
  ]) {
    const script = readFileSync(join(SCRIPTS_DIR, name), 'utf8');
    assert.match(
      script,
      /_REVIEWER_BROKER_HELPER=.*scripts\/lib\/reviewer-broker\.sh/,
      `${name} must reference the broker helper path`,
    );
    assert.match(
      script,
      /if ! source "\$_REVIEWER_BROKER_HELPER"; then/,
      `${name} must source the broker helper non-silently`,
    );
    assert.match(
      script,
      /refusing to start without the broker primitive/,
      `${name} must fail closed on broker-helper load failure`,
    );
    assert.match(
      script,
      /reviewer_broker_mode_enabled "claude-reviewer"/,
      `${name} must consult the claude-reviewer broker flag`,
    );
    assert.match(
      script,
      /reviewer_broker_mode_enabled "codex-reviewer"/,
      `${name} must consult the codex-reviewer broker flag`,
    );
    assert.match(
      script,
      /refusing to fall back to op-read PAT path/,
      `${name} must fail closed when broker mode is set but fetch fails`,
    );
  }
});

test('follow-up-tick script sources the broker helper + gates op-read on the flag', () => {
  const script = readFileSync(join(SCRIPTS_DIR, 'adversarial-follow-up-tick.sh'), 'utf8');
  assert.match(
    script,
    /_FOLLOW_UP_TICK_REVIEWER_BROKER_HELPER=.*lib\/reviewer-broker\.sh/,
    'follow-up-tick must reference the broker helper path',
  );
  assert.match(
    script,
    /reviewer_broker_mode_enabled "claude-reviewer"/,
    'follow-up-tick must consult the claude-reviewer broker flag',
  );
  assert.match(
    script,
    /reviewer_broker_mode_enabled "codex-reviewer"/,
    'follow-up-tick must consult the codex-reviewer broker flag',
  );
  assert.match(
    script,
    /reviewer_broker_mode_enabled "gemini-reviewer"/,
    'follow-up-tick must consult the gemini-reviewer broker flag',
  );
  // The op-read fallback must remain present (default-off broker mode
  // preserves existing behavior) but inside the `else` branch.
  assert.match(
    script,
    /_tick_op_read_reviewer_pat 'op:\/\/Cliovault\/claude-reviewer-pat\/credential'/,
    'follow-up-tick must preserve the claude-reviewer op-read fallback',
  );
  assert.match(
    script,
    /_tick_op_read_reviewer_pat 'op:\/\/Cliovault\/codex-reviewer-pat\/credential'/,
    'follow-up-tick must preserve the codex-reviewer op-read fallback',
  );
  assert.match(
    script,
    /_tick_op_read_reviewer_pat 'op:\/\/Cliovault\/GEMINI_REVIEWER_GH_TOKEN\/credential'/,
    'follow-up-tick must preserve the gemini-reviewer op-read fallback',
  );
});
