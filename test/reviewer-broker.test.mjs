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
printf '%s\n' '{"ok":true,"provider":"github-app-codex-reviewer","access_token":"synthetic-reviewer"}'
`);
  const env = { GHA_ADAPTER_BIN: adapter, GH_CODEX_REVIEWER_TOKEN: 'stale-token' };
  assert.equal(runHelperShell('resolve_reviewer_token_via_broker GH_CODEX_REVIEWER_TOKEN codex-reviewer rundix/fixture && printf %s "$GH_CODEX_REVIEWER_TOKEN"', env), 'synthetic-reviewer');
  assert.equal(runHelperShell('resolve_reviewer_token_via_broker GH_CODEX_REVIEWER_TOKEN codex-reviewer fixture/other 2>/dev/null || printf %s "${GH_CODEX_REVIEWER_TOKEN:-cleared}"', env), 'cleared');
});

test('shell helper forwards the cache directory and uses Perl from PATH', t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-ghx-shell-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter = join(root, 'github-adapter');
  const perl = execFileSync('/bin/sh', ['-c', 'command -v perl'], { encoding: 'utf8' }).trim();
  writeExecutable(join(root, 'perl'), `#!/bin/sh
printf used > "$PERL_RECEIPT"
exec "${perl}" "$@"
`);
  writeExecutable(adapter, `#!/bin/sh
[ "$AGENT_OS_GITHUB_ADAPTER_TOKEN_CACHE_DIR" = "$HOME/cache fixture" ] || exit 1
[ -z "\${GH_TOKEN:-}\${GITHUB_TOKEN:-}" ] || exit 2
printf '%s\\n' '{"ok":true,"provider":"github-app-codex-reviewer","access_token":"cached-fixture"}'
`);
  const receipt = join(root, 'perl-receipt');
  assert.equal(runHelperShell(
    'resolve_reviewer_token_via_broker GH_CODEX_REVIEWER_TOKEN codex-reviewer fixture/repo && printf %s "$GH_CODEX_REVIEWER_TOKEN"',
    { PATH: `${root}:${process.env.PATH}`, HOME: root, GHA_ADAPTER_BIN: adapter,
      AGENT_OS_GITHUB_ADAPTER_TOKEN_CACHE_DIR: `${root}/cache fixture`, PERL_RECEIPT: receipt,
      GH_TOKEN: 'ambient', GITHUB_TOKEN: 'ambient' },
  ), 'cached-fixture');
  assert.equal(readFileSync(receipt, 'utf8'), 'used');
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

for (const shell of ['/bin/bash', ZSH_PATH]) {
  for (const failure of ['exit 1', 'exit 75', 'exit 142', 'exec sleep 3']) {
    test(`${shell} caller survives adapter ${failure} under errexit`, { skip: !existsSync(shell) }, t => {
      const root = mkdtempSync(join(tmpdir(), 'broker-refusal-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const adapter = join(root, 'adapter');
      writeExecutable(adapter, `#!/bin/sh\n${failure}\n`);
      const output = execFileSync(shell, ['-c', `set -euo pipefail; source "${HELPER}";
        resolve_reviewer_token_via_broker GH_CODEX_REVIEWER_TOKEN codex-reviewer fixture/repo 2>/dev/null || {
          adapter_rc=$?; test "$adapter_rc" = 1;
        }
        printf 'continued:%s' "\${GH_CODEX_REVIEWER_TOKEN:-cleared}"`], {
        timeout: 5000, encoding: 'utf8',
        env: { ...process.env, GHA_ADAPTER_BIN: adapter, REVIEWER_TOKEN_FETCH_TIMEOUT_MS: '100',
          GH_CODEX_REVIEWER_TOKEN: 'stale' },
      });
      assert.equal(output, 'continued:cleared');
    });
  }

  test(`${shell} Grok seed defaults to cwd and survives a broker outage`, { skip: !existsSync(shell) }, t => {
    const root = mkdtempSync(join(tmpdir(), 'grok-seed-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/grok-reviewer-lane-enabled.mjs'), 'process.exit(0)');
    const adapter = join(root, 'adapter');
    writeExecutable(adapter, '#!/bin/sh\nexit 75\n');
    const output = execFileSync(shell, ['-c', `set -euo pipefail; source "${HELPER}";
      seed_grok_reviewer_token "" fixture/repo 2>/dev/null;
      printf 'continued:%s' "\${GH_GROK_REVIEWER_TOKEN:-cleared}"`], {
      cwd: root, timeout: 5000, encoding: 'utf8',
      env: { ...process.env, GHA_ADAPTER_BIN: adapter, GROK_REVIEWER_AUTH_VIA_BROKER: 'true',
        GH_GROK_REVIEWER_TOKEN: 'stale' },
    });
    assert.equal(output, 'continued:cleared');
  });

  for (const result of ['printf partial; return 1', "printf 'fixture/repo'"]) {
    test(`${shell} service-repo fallback handles ${result}`, { skip: !existsSync(shell) }, () => {
      const output = execFileSync(shell, ['-c', `set -euo pipefail; source "${HELPER}";
        reviewer_broker_service_repo() { ${result}; }
        reviewer_repo="$(reviewer_broker_service_repo_or_empty /fixture)";
        printf 'continued:%s' "$reviewer_repo"`], { encoding: 'utf8', timeout: 5000 });
      assert.equal(output, result.includes('return 1') ? 'continued:' : 'continued:fixture/repo');
    });
  }
}

for (const response of [
  { ok: true, access_token: 'wrong-fixture', provider: 'github-app-claude-reviewer' },
  { ok: true, access_token: 'wrong-fixture', provider: 'github-app-codex-reviewer', metadata: { credential_source: 'github_pat_fallback' } },
  { ok: true, access_token: 'wrong-fixture' },
]) {
  test(`shell seed refuses ${response.provider ?? 'missing provider'} source ${response.metadata?.credential_source ?? 'unspecified'}`, t => {
    const root = mkdtempSync(join(tmpdir(), 'ar-shell-provider-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const adapter = join(root, 'adapter');
    writeExecutable(adapter, `#!/bin/sh\nprintf '%s' '${JSON.stringify(response)}'\n`);
    assert.equal(runHelperShell('resolve_reviewer_token_via_broker GH_CODEX_REVIEWER_TOKEN codex-reviewer fixture/repo 2>/dev/null || printf %s "${GH_CODEX_REVIEWER_TOKEN:-cleared}"',
      { GHA_ADAPTER_BIN: adapter, GH_CODEX_REVIEWER_TOKEN: 'stale' }), 'cleared');
  });
}

test('shell seed reserves primary and standby budgets with a single attempt per URL', t => {
  const root = mkdtempSync(join(tmpdir(), 'ar-shell-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const perl = execFileSync('/bin/sh', ['-c', 'command -v perl'], { encoding: 'utf8' }).trim();
  writeExecutable(join(root, 'perl'), `#!/bin/sh
[ "$4" = "$EXPECTED_BUDGET" ] || exit 1
exec '${perl}' "$@"
`);
  const adapter = join(root, 'adapter');
  writeExecutable(adapter, `#!/bin/sh
[ "$AGENT_OS_GITHUB_ADAPTER_RETRY_MAX_ATTEMPTS" = 1 ] || exit 1
printf '%s' '{"ok":true,"provider":"github-app-codex-reviewer","access_token":"budget-fixture"}'
`);
  for (const [fallback, budget] of [['http://standby.fixture', '21000'], ['http://primary.fixture', '11000']]) {
    assert.equal(runHelperShell('resolve_reviewer_token_via_broker GH_CODEX_REVIEWER_TOKEN codex-reviewer fixture/repo && printf %s "$GH_CODEX_REVIEWER_TOKEN"', {
      PATH: `${root}:${process.env.PATH}`, GHA_ADAPTER_BIN: adapter, EXPECTED_BUDGET: budget,
      AGENT_OS_GITHUB_ADAPTER_BROKER_URL: 'http://primary.fixture', AGENT_OS_GITHUB_ADAPTER_BROKER_URL_FALLBACK: fallback,
    }), 'budget-fixture');
  }
});

test('shared launcher helper configures a per-account adapter cache and preserves overrides', () => {
  assert.equal(runHelperShell('printf %s "$AGENT_OS_GITHUB_ADAPTER_TOKEN_CACHE_DIR"', {
    HOME: '/fixture/account', AGENT_OS_GITHUB_ADAPTER_TOKEN_CACHE_DIR: '',
  }), '/fixture/account/.cache/github-adapter');
  assert.equal(runHelperShell('printf %s "$AGENT_OS_GITHUB_ADAPTER_TOKEN_CACHE_DIR"', {
    HOME: '/fixture/account', AGENT_OS_GITHUB_ADAPTER_TOKEN_CACHE_DIR: '/fixture/operator-cache',
  }), '/fixture/operator-cache');
});
