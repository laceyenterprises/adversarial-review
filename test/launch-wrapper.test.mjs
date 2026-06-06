import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const execFileAsync = promisify(execFile);

// The watcher LaunchAgent wrappers are zsh scripts (production is macOS,
// where zsh is the operator's login shell). On CI runners that lack zsh
// (Ubuntu defaults to bash), the launcher-execution tests cannot run and
// would fail with ENOENT. Detect zsh once at module load and skip those
// tests when it's missing — the script-parsing tests above the skip
// barrier still run on every platform.
const ZSH_PATH = '/bin/zsh';
const ZSH_AVAILABLE = existsSync(ZSH_PATH);
const SKIP_REASON_NO_ZSH =
  `zsh not available at ${ZSH_PATH}; LaunchAgent wrappers are zsh-only ` +
  `(production is macOS). Test skipped on this platform.`;

function readScript(name) {
  return readFileSync(join(REPO_ROOT, 'scripts', name), 'utf8');
}

function readLauncherScript(name) {
  const scriptPath = join(REPO_ROOT, 'scripts', name);
  const script = readFileSync(scriptPath, 'utf8');
  assert.ok(script.startsWith('#!'), `${name} appears empty or missing`);
  assert.notEqual(statSync(scriptPath).mode & 0o111, 0, `${name} must be executable`);
  assert.match(script, /set -euo pipefail/, `${name} must fail closed under shell errors`);
  return script;
}

function writeExecutable(filePath, body) {
  writeFileSync(filePath, body, 'utf8');
  chmodSync(filePath, 0o755);
}

async function runMaintainerWatcherLauncher(scriptName, {
  alertToOpRef = 'op://test-vault/adversarial-watcher-alert-to/credential',
  opCliPath = '/missing/op',
  opMode = 'ok',
  helperMode = 'healthy',
  extraEnv = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'watcher-launch-wrapper-'));
  const fakeBin = join(root, 'bin');
  const fakeRepo = join(root, 'agent-os', 'tools', 'adversarial-review');
  const fakeSharedHelper = join(fakeRepo, 'scripts', 'lib', 'op-resolve-with-rate-limit-backoff.sh');
  const fakeTmp = join(root, 'tmp');
  const sleepLog = join(fakeTmp, 'sleep.log');
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(fakeRepo, 'src', 'secret-source'), { recursive: true });
  mkdirSync(fakeTmp, { recursive: true });
  writeFileSync(join(fakeRepo, 'src', 'watcher.mjs'), 'process.exit(0);\n', 'utf8');

  const fakeNode = join(fakeBin, 'node');
  const fakeGh = join(fakeBin, 'gh');
  writeExecutable(
    fakeNode,
    '#!/bin/bash\n'
      + 'if [[ "$1" == "-e" ]]; then exit 0; fi\n'
      + 'if [[ "$1" == *"resolve-op-token-cli.mjs" ]]; then printf "op-token"; exit 0; fi\n'
      + 'exit 0\n',
  );
  writeExecutable(
    fakeGh,
    '#!/bin/bash\n'
      + 'if [[ "$1" == "auth" && "$2" == "token" ]]; then echo "gh-token"; exit 0; fi\n'
      + 'exit 1\n',
  );
  writeExecutable(join(fakeBin, 'sleep'), `#!/bin/bash\nprintf '%s\\n' "$1" >>"${sleepLog}"\nexit 0\n`);
  writeExecutable(
    join(fakeBin, 'op'),
    '#!/bin/bash\n'
      + 'ref="${2:-}"\n'
      + 'if [[ "$ref" == "${ADVERSARIAL_REVIEW_ALERT_TO_OP_REF:-}" ]]; then\n'
      + '  case "${TEST_OP_MODE:-ok}" in\n'
      + '    transient-then-ok)\n'
      + '      count_file="${TMPDIR:-/tmp}/op-alert-count"\n'
      + '      count=0\n'
      + '      [[ -f "$count_file" ]] && count="$(cat "$count_file")"\n'
      + '      count=$((count + 1))\n'
      + '      printf "%s" "$count" >"$count_file"\n'
      + '      if (( count < 3 )); then echo "temporary op outage" >&2; exit 1; fi\n'
      + '      printf "alert@example.com"; exit 0\n'
      + '      ;;\n'
      + '    ok)\n'
      + '      printf "alert@example.com"; exit 0\n'
      + '      ;;\n'
      + '    missing-alert)\n'
      + '      echo "not found" >&2; exit 1\n'
      + '      ;;\n'
      + '    rate-limit-alert)\n'
      + '      echo "HTTP 429: too many requests for this account" >&2; exit 1\n'
      + '      ;;\n'
      + '    canonical-rate-limit-alert)\n'
      + '      echo "Too many requests. Your client has been rate-limited" >&2; exit 1\n'
      + '      ;;\n'
      + '  esac\n'
      + 'fi\n'
      + 'printf "secret-value"; exit 0\n',
  );
  if (helperMode === 'broken') {
    mkdirSync(dirname(fakeSharedHelper), { recursive: true });
    writeExecutable(
      fakeSharedHelper,
      '#!/bin/bash\n'
        + 'echo "broken helper" >&2\n'
        + 'return 7\n',
    );
  } else if (helperMode === 'healthy') {
    mkdirSync(dirname(fakeSharedHelper), { recursive: true });
    writeExecutable(
      fakeSharedHelper,
      '#!/bin/bash\n'
        + 'op_rate_limit_stderr_indicates_rate_limit() {\n'
        + '  local stderr_file="$1"\n'
        + "  grep -Eiq 'too[[:space:]-]+many[[:space:]-]+requests|rate[[:space:]_-]*limit(ed)?|http[^[:alnum:]]*429|status[^[:alnum:]]*429|quota' \"$stderr_file\" 2>/dev/null\n"
        + '}\n'
        + 'op_resolve_with_rate_limit_backoff() {\n'
        + '  local stderr_file\n'
        + '  stderr_file="$(mktemp)" || return 1\n'
        + '  "$@" 2>"$stderr_file"\n'
        + '  rc=$?\n'
        + '  cat "$stderr_file" >&2\n'
        + '  if [[ "$rc" -ne 0 ]] && op_rate_limit_stderr_indicates_rate_limit "$stderr_file"; then\n'
        + '    sleep "${OP_RATE_LIMIT_BACKOFF_S:-900}"\n'
        + '  fi\n'
        + '  rm -f "$stderr_file"\n'
        + '  return "$rc"\n'
        + '}\n',
    );
  }

  const script = readScript(scriptName)
    .replaceAll('/Users/airlock/agent-os', join(root, 'agent-os'))
    .replaceAll('/Users/airlock/agent-os/tools/adversarial-review', fakeRepo)
    .replaceAll('/opt/homebrew/bin/node', fakeNode)
    .replaceAll('/opt/homebrew/bin/gh', fakeGh)
    .replace('export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"', `export PATH="${fakeBin}:/usr/bin:/bin"`);
  const wrapperPath = join(root, scriptName);
  writeExecutable(wrapperPath, script);

  const env = {
    ...process.env,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    TMPDIR: fakeTmp,
    ADVERSARIAL_REVIEW_ALERT_TO_OP_REF: alertToOpRef,
    ADVERSARIAL_REVIEW_OP_CLI: opCliPath,
    TEST_OP_MODE: opMode,
    ...extraEnv,
  };
  try {
    const result = await execFileAsync('/bin/zsh', [wrapperPath], { env, cwd: root });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      sleepLog: existsSync(sleepLog) ? readFileSync(sleepLog, 'utf8') : '',
    };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      sleepLog: existsSync(sleepLog) ? readFileSync(sleepLog, 'utf8') : '',
    };
  }
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
    const script = readLauncherScript(scriptName);
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      script,
      new RegExp(`OP_SERVICE_ACCOUNT_TOKEN=\\$\\(env ADV_OP_TOKEN_TAG="${escapedTag}" /opt/homebrew/bin/node `),
      `${scriptName} must inject ${tag} into the resolver subprocess`,
    );
  }
});

test('launcher scripts do not hardcode operator identity defaults', () => {
  // Reverse-DNS launchd labels such as `ai.laceyenterprises.*` are service
  // identifiers, not operator identity defaults. This guard catches human/org
  // display names and email literals while leaving service-label syntax alone.
  const standaloneOrgName = /(^|[^.\w-])lacey(?:\s+|-|_)?enterprises($|[^.\w-])/i;
  const operatorEmailDomain = /@\s*lacey[-_]?enterprises\.com/i;
  for (const scriptName of [
    'adversarial-watcher-start.sh',
    'adversarial-watcher-start-placey.sh',
    'adversarial-follow-up-tick.sh',
  ]) {
    const script = readLauncherScript(scriptName);
    assert.doesNotMatch(script, /\b(?:virtualpaul|paul[._-]?lacey)\s*@/i);
    assert.doesNotMatch(script, operatorEmailDomain);
    assert.doesNotMatch(script, /paul\s+lacey/i);
    assert.doesNotMatch(script, standaloneOrgName);
  }
});

test('watcher launchers require explicit opt-in before running without ALERT_TO', () => {
  for (const scriptName of [
    'adversarial-watcher-start.sh',
    'adversarial-watcher-start-placey.sh',
  ]) {
    const script = readScript(scriptName);
    assert.match(script, /ADVERSARIAL_REVIEW_ALLOW_MISSING_ALERT_TO=1/);
    assert.match(script, /AGENT_OS_CFG_FEATURE_FLAGS_ALLOW_MISSING_ALERT_TO/);
    assert.match(script, /resolve_alert_to_optional/);
    assert.match(script, /unset ALERT_TO/);
    assert.match(script, /status -eq 4/);
    assert.match(script, /ADVERSARIAL_REVIEW_OP_CLI/);
    assert.match(script, /command -v op/);
    assert.match(script, /OP_BIN="\$\(resolve_op_bin\)"/);
    assert.match(script, /op_resolve_with_rate_limit_backoff "\$OP_BIN" read/);
    assert.doesNotMatch(script, /\/opt\/homebrew\/bin\/op read/);
    assert.doesNotMatch(script, /Cliovault/);
  }
});

test('watcher launchers do not silently bypass OPH-01 backoff when the shared helper is absent', () => {
  for (const scriptName of [
    'adversarial-watcher-start.sh',
    'adversarial-watcher-start-placey.sh',
  ]) {
    const script = readScript(scriptName);
    assert.match(script, /\(\s*source "\$_OP_RATE_LIMIT_HELPER"\s*\)/);
    assert.match(script, /refusing to start without the shared cooldown primitive/);
    assert.match(script, /scripts\/lib\/op-resolve-with-rate-limit-backoff\.sh/);
    assert.doesNotMatch(script, /using vendored fallback/);
    assert.doesNotMatch(script, /op_resolve_with_rate_limit_backoff\(\)/);
    assert.doesNotMatch(script, /op_rate_limit_stderr_indicates_rate_limit\(\)/);
  }
});

test('watcher launchers append module config instead of overwriting AGENT_OS_CFG_MODULES', () => {
  for (const scriptName of [
    'adversarial-watcher-start.sh',
    'adversarial-watcher-start-placey.sh',
  ]) {
    const script = readScript(scriptName);
    assert.match(script, /AGENT_OS_CFG_MODULES="\$REPO_ROOT\/tools\/adversarial-review\/config\.yaml\$\{AGENT_OS_CFG_MODULES:\+:\$AGENT_OS_CFG_MODULES\}"/);
  }
});

test('maintainer watcher launchers resolve ALERT_TO through configured op ref', {
  skip: ZSH_AVAILABLE ? false : SKIP_REASON_NO_ZSH,
}, async () => {
  for (const scriptName of [
    'adversarial-watcher-start.sh',
    'adversarial-watcher-start-placey.sh',
  ]) {
    const result = await runMaintainerWatcherLauncher(scriptName);
    assert.equal(result.code, 0, `${scriptName} stderr:\n${result.stderr}`);
    assert.match(result.stderr, /WARN: configured 1Password CLI '\/missing\/op' is not executable/);
    assert.doesNotMatch(result.stderr, /Cliovault/);
  }
});

test('maintainer watcher launchers retry transient ALERT_TO op failures', {
  skip: ZSH_AVAILABLE ? false : SKIP_REASON_NO_ZSH,
}, async () => {
  for (const scriptName of [
    'adversarial-watcher-start.sh',
    'adversarial-watcher-start-placey.sh',
  ]) {
    const result = await runMaintainerWatcherLauncher(scriptName, { opMode: 'transient-then-ok' });
    assert.equal(result.code, 0, `${scriptName} stderr:\n${result.stderr}`);
    assert.match(result.stderr, /failed to resolve ALERT_TO from 1Password \(attempt 1\/3\)/);
    assert.match(result.stderr, /failed to resolve ALERT_TO from 1Password \(attempt 2\/3\)/);
  }
});

test('maintainer watcher launchers honor config-derived allow-missing-alert flag semantics', {
  skip: ZSH_AVAILABLE ? false : SKIP_REASON_NO_ZSH,
}, async () => {
  for (const scriptName of [
    'adversarial-watcher-start.sh',
    'adversarial-watcher-start-placey.sh',
  ]) {
    const result = await runMaintainerWatcherLauncher(scriptName, {
      opMode: 'missing-alert',
      extraEnv: {
        AGENT_OS_CFG_FEATURE_FLAGS_ALLOW_MISSING_ALERT_TO: 'true',
      },
    });
    assert.equal(result.code, 0, `${scriptName} stderr:\n${result.stderr}`);
    assert.match(result.stderr, /WARN: ALERT_TO is unset by explicit operator override/);
    assert.doesNotMatch(result.stderr, /ERROR: ALERT_TO is not provisioned/);
  }
});

test('maintainer watcher launchers fail closed when the shared OPH-01 helper is broken', {
  skip: ZSH_AVAILABLE ? false : SKIP_REASON_NO_ZSH,
}, async () => {
  for (const scriptName of [
    'adversarial-watcher-start.sh',
    'adversarial-watcher-start-placey.sh',
  ]) {
    const result = await runMaintainerWatcherLauncher(scriptName, { helperMode: 'broken' });
    assert.equal(result.code, 78, `${scriptName} stderr:\n${result.stderr}`);
    assert.match(result.stderr, /broken helper/);
    assert.match(result.stderr, /refusing to start without the shared cooldown primitive/);
  }
});

test('maintainer watcher launchers fail closed when the shared OPH-01 helper is missing', {
  skip: ZSH_AVAILABLE ? false : SKIP_REASON_NO_ZSH,
}, async () => {
  for (const scriptName of [
    'adversarial-watcher-start.sh',
    'adversarial-watcher-start-placey.sh',
  ]) {
    const result = await runMaintainerWatcherLauncher(scriptName, { helperMode: 'missing' });
    assert.equal(result.code, 78, `${scriptName} stderr:\n${result.stderr}`);
    assert.match(result.stderr, /helper missing/);
    assert.match(result.stderr, /refusing to start without the shared cooldown primitive/);
  }
});

for (const opMode of ['rate-limit-alert', 'canonical-rate-limit-alert']) {
  test(`maintainer watcher launchers route ${opMode} through the shared helper cooldown and avoid stacked ALERT_TO retries`, {
  skip: ZSH_AVAILABLE ? false : SKIP_REASON_NO_ZSH,
}, async () => {
    for (const scriptName of [
      'adversarial-watcher-start.sh',
      'adversarial-watcher-start-placey.sh',
    ]) {
      const result = await runMaintainerWatcherLauncher(scriptName, {
        opMode,
        extraEnv: {
          OP_RATE_LIMIT_BACKOFF_S: '1',
        },
      });
      assert.equal(result.code, 1, `${scriptName} stderr:\n${result.stderr}`);
      assert.match(result.stderr, /without extra ALERT_TO retries or an additional launcher sleep/);
      assert.doesNotMatch(result.stderr, /retrying in 5s/);
      assert.equal(result.sleepLog.trim(), '1', `${scriptName} sleep log:\n${result.sleepLog}`);
    }
  });
}
