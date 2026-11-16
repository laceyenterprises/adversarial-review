// Tests for the reviewer-token OAuth broker helper (2026-06-07).
// Mirrors the GAB-02 merge-agent.sh broker branch contract from
// agent-os modules/worker-pool/lib/hq-gh.sh::_hq_resolve_merge_agent_broker_token,
// but in bash for the watcher's reviewer-token resolution path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { grokReviewerLaneEnabled } from '../src/grok-reviewer-lane.mjs';

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
      `source "${HELPER}"; resolve_reviewer_token_via_broker GH_FAKE_REVIEWER_TOKEN claude-reviewer 2>&1; echo "rc=$? class=$REVIEWER_BROKER_FAILURE_CLASS"`,
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
  assert.match(out, /rc=1 class=permanent\n?$/);
});

test('resolve_reviewer_token_via_broker fails closed when the secret file is unreadable', () => {
  const out = execFileSync(
    '/bin/bash',
    [
      '-c',
      `source "${HELPER}"; resolve_reviewer_token_via_broker GH_FAKE_REVIEWER_TOKEN claude-reviewer 2>&1; echo "rc=$? class=$REVIEWER_BROKER_FAILURE_CLASS"`,
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
  assert.match(out, /rc=1 class=permanent\n?$/);
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
      + 'printf "000"\n'
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
      `source "${HELPER}"; resolve_reviewer_token_via_broker GH_FAKE_REVIEWER_TOKEN claude-reviewer 2>&1; echo "rc=$? class=$REVIEWER_BROKER_FAILURE_CLASS"`,
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
  assert.match(out, /rc=1 class=transient\n?$/);
  const curlArgs = readFileSync(curlArgsFile, 'utf8');
  assert.match(curlArgs, /--connect-timeout\n0\.250\n/);
  assert.match(curlArgs, /--max-time\n0\.250\n/);
});

test('resolve_reviewer_token_via_broker uses standby after transient primary failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewer-broker-fallback-'));
  const bin = join(root, 'bin');
  const secretFile = join(root, 'secret');
  const urlsFile = join(root, 'curl-urls.txt');
  mkdirSync(bin, { recursive: true });
  writeFileSync(secretFile, 'shared-secret', 'utf8');
  writeExecutable(
    join(bin, 'curl'),
    '#!/bin/bash\n'
      + 'response_file=""\n'
      + 'url=""\n'
      + 'while [[ "$#" -gt 0 ]]; do\n'
      + '  if [[ "$1" == "-o" ]]; then shift; response_file="$1"; else url="$1"; fi\n'
      + '  shift || true\n'
      + 'done\n'
      + 'printf "%s\\n" "$url" >>"$TEST_CURL_URLS_FILE"\n'
      + 'if [[ "$url" == http://primary.invalid/* ]]; then printf "000"; exit 7; fi\n'
      + 'cat >"$response_file" <<JSON\n'
      + '{"access_token":"ghs_STANDBY","provider":"github-app-claude-reviewer","metadata":{"app_id":"3994110","installation_id":"138772505"}}\n'
      + 'JSON\n'
      + 'printf "200"\n',
  );
  writeExecutable(
    join(bin, 'jq'),
    '#!/bin/bash\n'
      + 'expr="$2"\n'
      + 'case "$expr" in\n'
      + '  *access_token*) echo ghs_STANDBY ;;\n'
      + '  *provider*) echo github-app-claude-reviewer ;;\n'
      + '  *app_id*) echo 3994110 ;;\n'
      + '  *installation_id*) echo 138772505 ;;\n'
      + '  *) exit 1 ;;\n'
      + 'esac\n',
  );
  const out = execFileSync(
    '/bin/bash',
    [
      '-c',
      `source "${HELPER}"; resolve_reviewer_token_via_broker GH_FAKE_REVIEWER_TOKEN claude-reviewer 2>&1; echo "rc=$? token=$GH_FAKE_REVIEWER_TOKEN class=$REVIEWER_BROKER_FAILURE_CLASS"`,
    ],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        OAUTH_BROKER_URL: 'http://primary.invalid',
        OAUTH_BROKER_URL_FALLBACK: 'http://standby.invalid',
        OAUTH_BROKER_SHARED_SECRET_FILE: secretFile,
        OAUTH_BROKER_CLAUDE_REVIEWER_EXPECTED_APP_ID: '3994110',
        OAUTH_BROKER_CLAUDE_REVIEWER_EXPECTED_INSTALLATION_ID: '138772505',
        TEST_CURL_URLS_FILE: urlsFile,
      },
      encoding: 'utf8',
    },
  );
  assert.match(out, /trying fallback broker http:\/\/standby\.invalid/);
  assert.match(out, /resolved GH_FAKE_REVIEWER_TOKEN via OAuth broker fallback/);
  assert.match(out, /rc=0 token=ghs_STANDBY class=\n?$/);
  assert.deepEqual(
    readFileSync(urlsFile, 'utf8').trim().split('\n'),
    [
      'http://primary.invalid/token?provider=github-app-claude-reviewer',
      'http://standby.invalid/token?provider=github-app-claude-reviewer',
    ],
  );
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
    /_tick_op_read_reviewer_pat 'op:\/\/Cliovault\/GEMINI_REVIEWER_GH_TOKEN\/token'/,
    'follow-up-tick must preserve the gemini-reviewer op-read fallback (field: token, GMW-06)',
  );
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

test('all launcher Grok seed paths obey CFG and continue on broker failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'grok-seed-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const config = join(root, 'config.yaml');
    const secret = join(root, 'secret');
    const calls = join(root, 'calls');
    writeFileSync(secret, 'synthetic-secret');
    writeExecutable(join(bin, 'curl'), `#!/bin/bash
response_file=""
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then shift; response_file="$1"; fi
  shift
done
printf 'called\\n' >>"$TEST_CALLS"
if [[ "$TEST_FAIL" == true ]]; then printf '403'; exit 22; fi
printf '%s' '{"access_token":"synthetic-grok-token","provider":"github-app-grok-reviewer","metadata":{}}' >"$response_file"
printf '200'
`);
    writeExecutable(join(bin, 'jq'), `#!/usr/bin/env node
const fs = require('node:fs');
const doc = JSON.parse(fs.readFileSync(0, 'utf8'));
const key = process.argv[3].split(' // ')[0].slice(1);
console.log(key.split('.').reduce((value, part) => value?.[part], doc) ?? '');
`);
    for (const name of ['adversarial-watcher-start.sh', 'adversarial-watcher-start-placey.sh', 'adversarial-follow-up-tick.sh']) {
      const script = readFileSync(join(SCRIPTS_DIR, name), 'utf8');
      // Execute the exact startup statements, with the real shared shell helper
      // and Node CFG reader; only the broker transport is replaced.
      const defaults = script.split('\n').filter((line) => line.startsWith(': "${GROK_REVIEWER_AUTH_VIA_BROKER:=')).join('\n');
      const exports = script.split('\n').filter((line) => line.startsWith('export ') && line.includes('GROK_REVIEWER_AUTH_VIA_BROKER')).join('\n');
      const seed = script.split('\n').map((line) => line.trim())
        .filter((line) => line === 'seed_grok_reviewer_token "$WATCHER_DIR"').join('\n');
      assert.ok(defaults && exports && seed, name);
      for (const [master, reviewer, fail] of [[false, true, false], [true, false, false], [true, true, false], [true, true, true]]) {
        writeFileSync(config, JSON.stringify({ version: 1, grok: { enabled: master, reviewer: { enabled: reviewer } } }));
        rmSync(calls, { force: true });
        for (const shell of ['/bin/bash', ...(ZSH_AVAILABLE ? [ZSH_PATH] : [])]) {
          const out = execFileSync(shell, ['-c', `set -eu
exec 2>&1
source "$TEST_HELPER"
${defaults}
${exports}
${seed}
node -e 'console.log(JSON.stringify({continued:true,token:process.env.GH_GROK_REVIEWER_TOKEN,flag:process.env.GROK_REVIEWER_AUTH_VIA_BROKER}))'
`], {
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              AGENT_OS_CONFIG_PATH: config, AGENT_OS_CFG_MODULES: '',
              AGENT_OS_GROK_ENABLED: String(master), AGENT_OS_GROK_REVIEWER_ENABLED: String(reviewer),
              GROK_REVIEWER_AUTH_VIA_BROKER: '',
              GH_GROK_REVIEWER_TOKEN: 'synthetic-inherited-token',
              WATCHER_DIR: join(SCRIPTS_DIR, '..'), TEST_HELPER: HELPER,
              TEST_CALLS: calls, TEST_FAIL: String(fail),
              OAUTH_BROKER_SHARED_SECRET_FILE: secret,
              OAUTH_BROKER_GROK_REVIEWER_PROVIDER: 'github-app-grok-reviewer',
              OAUTH_BROKER_GROK_REVIEWER_EXPECTED_APP_ID: '',
              OAUTH_BROKER_GROK_REVIEWER_EXPECTED_INSTALLATION_ID: '',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          const result = JSON.parse(out.trim().split('\n').at(-1));
          assert.equal(result.continued, true);
          assert.equal(result.flag, 'true');
          if (!master || !reviewer) {
            assert.equal(existsSync(calls), false);
            assert.equal(out.split('grok-reviewer-lane-disabled').length - 1, 1);
            assert.equal(result.token, undefined);
          } else {
            assert.equal(existsSync(calls), true);
            if (fail) assert.match(out, /WARN: GH_GROK_REVIEWER_TOKEN not resolved/);
            assert.equal(result.token, fail ? undefined : 'synthetic-grok-token');
          }
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Grok startup seed defaults missing or empty watcher directory to the current checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'grok-seed-directory-'));
  try {
    const config = join(root, 'config.yaml');
    writeFileSync(config, JSON.stringify({ version: 1, grok: { enabled: true, reviewer: { enabled: true } } }));
    for (const shell of ['/bin/bash', ...(ZSH_AVAILABLE ? [ZSH_PATH] : [])]) {
      for (const invocation of ['seed_grok_reviewer_token', 'seed_grok_reviewer_token ""']) {
        const out = execFileSync(shell, ['-c', `set -eu
source "$TEST_HELPER"
resolve_reviewer_token_via_broker() {
  export GH_GROK_REVIEWER_TOKEN=synthetic-seeded-token
}
${invocation}
node -e 'console.log(process.env.GH_GROK_REVIEWER_TOKEN)'
`], {
          cwd: join(SCRIPTS_DIR, '..'),
          encoding: 'utf8',
          env: {
            ...process.env,
            TEST_HELPER: HELPER,
            AGENT_OS_CONFIG_PATH: config, AGENT_OS_CFG_MODULES: '',
            AGENT_OS_GROK_ENABLED: 'true', AGENT_OS_GROK_REVIEWER_ENABLED: 'true',
            GROK_REVIEWER_AUTH_VIA_BROKER: 'true',
            GH_GROK_REVIEWER_TOKEN: 'synthetic-inherited-token',
          },
        });
        assert.equal(out.trim(), 'synthetic-seeded-token', `${shell}: ${invocation}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('follow-up startup continues without the optional Grok broker helper', () => {
  const script = readFileSync(join(SCRIPTS_DIR, 'adversarial-follow-up-tick.sh'), 'utf8');
  const block = script.match(/if declare -f seed_grok_reviewer_token[\s\S]*?\nfi/)[0];
  const out = runHelperShell(`set -eu
exec 2>&1
unset -f seed_grok_reviewer_token
${block}
echo "continued token=\${GH_GROK_REVIEWER_TOKEN-unset}"`, {
    GH_GROK_REVIEWER_TOKEN: 'synthetic-inherited-token',
  });
  assert.match(out, /WARN: Grok reviewer broker helper unavailable/);
  assert.match(out, /continued token=unset/);
});
