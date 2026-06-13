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
const BROKER_MODE_TEST_ENV = {
  CLAUDE_REVIEWER_AUTH_VIA_BROKER: 'true',
  CODEX_REVIEWER_AUTH_VIA_BROKER: 'true',
  GEMINI_REVIEWER_AUTH_VIA_BROKER: 'true',
};

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
  brokerMode = 'healthy',
  localAlertTo = null,
  localLinearEnv = null,
  opCliPath = null,
  opMode = 'ok',
  requiredOpMode = 'ok',
  helperMode = 'healthy',
  extraEnv = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'watcher-launch-wrapper-'));
  const fakeBin = join(root, 'bin');
  const fakeRepo = join(root, 'agent-os', 'tools', 'adversarial-review');
  const fakeSharedHelper = join(fakeRepo, 'scripts', 'lib', 'op-resolve-with-rate-limit-backoff.sh');
  const fakeReviewerBrokerHelper = join(fakeRepo, 'scripts', 'lib', 'reviewer-broker.sh');
  const fakeTmp = join(root, 'tmp');
  const fakeHome = join(root, 'home');
  const fakeZdotdir = join(root, 'zdotdir');
  const sleepLog = join(fakeTmp, 'sleep.log');
  const opReadLog = join(fakeTmp, 'op-read.log');
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(fakeRepo, 'src', 'secret-source'), { recursive: true });
  mkdirSync(fakeTmp, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(fakeZdotdir, { recursive: true });
  writeFileSync(
    join(fakeRepo, 'src', 'watcher.mjs'),
    'console.log(JSON.stringify({linearApiKey: process.env.LINEAR_API_KEY || "", alertTo: process.env.ALERT_TO || ""}));\n'
      + 'process.exit(0);\n',
    'utf8',
  );
  if (localLinearEnv !== null) {
    const localSecretsDir = join(root, 'agent-os', '.secrets', 'local');
    mkdirSync(localSecretsDir, { recursive: true });
    writeFileSync(join(localSecretsDir, 'linear.env'), localLinearEnv, 'utf8');
  }
  if (localAlertTo !== null) {
    const localSecretsDir = join(root, 'agent-os', '.secrets', 'local');
    mkdirSync(localSecretsDir, { recursive: true });
    writeFileSync(join(localSecretsDir, 'adversarial-watcher-alert-to'), localAlertTo, 'utf8');
  }

  const fakeNode = join(fakeBin, 'node');
  const fakeGh = join(fakeBin, 'gh');
	  writeExecutable(
	    fakeNode,
	    '#!/bin/bash\n'
	      + 'if [[ "$1" == "-e" ]]; then exit 0; fi\n'
	      + 'if [[ "$1" == *"resolve-op-token-cli.mjs" ]]; then printf "op-token"; exit 0; fi\n'
	      + 'if [[ "$1" == *"watcher.mjs" ]]; then printf "{\\"linearApiKey\\":\\"%s\\",\\"alertTo\\":\\"%s\\"}\\n" "${LINEAR_API_KEY:-}" "${ALERT_TO:-}"; exit 0; fi\n'
	      + 'if [[ "$1" == *"adversarial-follow-up-daemon.mjs" ]]; then exit 0; fi\n'
	      + 'exit 0\n',
	  );
  writeExecutable(
    fakeGh,
    '#!/bin/bash\n'
      + 'if [[ "$1" == "auth" && "$2" == "token" ]]; then echo "gh-token"; exit 0; fi\n'
      + 'exit 1\n',
  );
  writeExecutable(join(fakeBin, 'sleep'), `#!/bin/bash\nprintf '%s\\n' "$1" >>"${sleepLog}"\nexit 0\n`);
  const fakeOp = join(fakeBin, 'op');
  writeExecutable(
    fakeOp,
    '#!/bin/bash\n'
      + 'ref="${2:-}"\n'
      + 'if [[ -n "${TEST_OP_READ_LOG:-}" ]]; then printf "%s\\n" "$ref" >>"$TEST_OP_READ_LOG"; fi\n'
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
      + 'case "${TEST_REQUIRED_OP_MODE:-ok}" in\n'
      + '  ok)\n'
      + '    printf "secret-value"; exit 0\n'
      + '    ;;\n'
      + '  fail)\n'
      + '    echo "op failed while checking quota metadata" >&2; exit 1\n'
      + '    ;;\n'
      + '  rate-limit)\n'
      + '    echo "HTTP 429: too many requests for this account" >&2; exit 1\n'
      + '    ;;\n'
      + 'esac\n'
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
        + "  grep -Eiq 'too[[:space:]-]+many[[:space:]-]+requests|rate[[:space:]_-]*limit(ed)?|http[^[:alnum:]]*429|status[^[:alnum:]]*429' \"$stderr_file\" 2>/dev/null\n"
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
	  const reviewerBrokerHelperBody = '#!/bin/zsh\n'
	      + 'reviewer_broker_mode_enabled() {\n'
	      + '  local role_upper flag_name flag_value\n'
	      + '  role_upper="$(printf "%s" "$1" | tr "[:lower:]-" "[:upper:]_")"\n'
	      + '  flag_name="${role_upper}_AUTH_VIA_BROKER"\n'
      + '  eval "flag_value=\\"\\${${flag_name}:-}\\""\n'
	      + '  [[ "$flag_value" == "true" ]]\n'
	      + '}\n'
	      + 'resolve_reviewer_token_via_broker() {\n'
	      + '  if [[ "${TEST_REVIEWER_BROKER_MODE:-healthy}" == "fail" ]]; then\n'
	      + '    echo "[reviewer-broker] simulated broker failure for $2" >&2\n'
	      + '    return 1\n'
	      + '  fi\n'
	      + '  export "$1=broker-token"\n'
	      + '  echo "[reviewer-broker] resolved $1 via OAuth broker" >&2\n'
	      + '  return 0\n'
	      + '}\n';
	  mkdirSync(dirname(fakeReviewerBrokerHelper), { recursive: true });
	  writeExecutable(fakeReviewerBrokerHelper, reviewerBrokerHelperBody);
	  mkdirSync(join(root, 'lib'), { recursive: true });
	  writeExecutable(join(root, 'lib', 'reviewer-broker.sh'), reviewerBrokerHelperBody);

  const script = readScript(scriptName)
    .replace('set -euo pipefail', `set -euo pipefail\nexport PATH="${fakeBin}:/usr/bin:/bin"`)
    .replaceAll('/Users/airlock/agent-os', join(root, 'agent-os'))
    .replaceAll('/Users/airlock/agent-os/tools/adversarial-review', fakeRepo)
    .replaceAll('/opt/homebrew/bin/node', fakeNode)
    .replaceAll('/opt/homebrew/bin/gh', fakeGh)
    .replaceAll('/opt/homebrew/bin/op', fakeOp)
    .replaceAll('/usr/local/bin/op', fakeOp)
    .replace('export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"', `export PATH="${fakeBin}:/usr/bin:/bin"`);
  const wrapperPath = join(root, scriptName);
  writeExecutable(wrapperPath, script);

  const env = {
    PATH: `${fakeBin}:/usr/bin:/bin`,
    HOME: fakeHome,
    USER: 'launch-wrapper-test',
    LOGNAME: 'launch-wrapper-test',
    SHELL: ZSH_PATH,
    ZDOTDIR: fakeZdotdir,
    TMPDIR: fakeTmp,
    ADVERSARIAL_REVIEW_ALERT_TO_OP_REF: alertToOpRef,
    ADVERSARIAL_REVIEW_OP_CLI: opCliPath ?? fakeOp,
    TEST_OP_READ_LOG: opReadLog,
    AGENT_OS_CONFIG_PATH: '/dev/null',
    TEST_OP_MODE: opMode,
    TEST_REQUIRED_OP_MODE: requiredOpMode,
    TEST_REVIEWER_BROKER_MODE: brokerMode,
    ...extraEnv,
  };
  try {
    const result = await execFileAsync('/bin/zsh', [wrapperPath], { env, cwd: root });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      opReadLog: existsSync(opReadLog) ? readFileSync(opReadLog, 'utf8') : '',
      sleepLog: existsSync(sleepLog) ? readFileSync(sleepLog, 'utf8') : '',
    };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      opReadLog: existsSync(opReadLog) ? readFileSync(opReadLog, 'utf8') : '',
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
    assert.match(script, /resolve_and_export_required_op_secret LINEAR_API_KEY/);
    assert.match(script, /op_resolve_with_rate_limit_backoff "\$OP_BIN" read/);
    assert.doesNotMatch(script, /\/opt\/homebrew\/bin\/op read/);
  }
});

test('watcher launchers do not silently bypass OPH-01 backoff when the shared helper is absent', () => {
  for (const scriptName of [
    'adversarial-watcher-start.sh',
    'adversarial-watcher-start-placey.sh',
  ]) {
    const script = readScript(scriptName);
    assert.match(script, /if ! source "\$_OP_RATE_LIMIT_HELPER"; then/);
    assert.doesNotMatch(script, /\(\s*source "\$_OP_RATE_LIMIT_HELPER"\s*\)/);
    assert.match(script, /sleeping 3600s to suppress launchd respawn storm; restore the OPH-01 helper/);
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

test('airlock watcher launcher prefers local runtime secrets before 1Password reads', () => {
  const script = readScript('adversarial-watcher-start.sh');
  assert.match(script, /load_local_linear_api_key/);
  assert.match(script, /\$REPO_ROOT\/\.secrets\/local\/linear\.env/);
  assert.match(script, /load_local_linear_api_key \|\| true/);
  assert.match(script, /load_local_alert_to/);
  assert.match(script, /\$REPO_ROOT\/\.secrets\/local\/adversarial-watcher-alert-to/);
  assert.match(script, /load_local_alert_to \|\| true/);
});

test('airlock reviewer daemon plists route GitHub tokens through the OAuth broker', () => {
  for (const plistName of [
    'ai.laceyenterprises.adversarial-watcher.airlock.plist',
    'ai.laceyenterprises.adversarial-follow-up.airlock.plist',
  ]) {
    const plist = readFileSync(join(REPO_ROOT, 'launchd', plistName), 'utf8');
    for (const key of [
      'CLAUDE_REVIEWER_AUTH_VIA_BROKER',
      'CODEX_REVIEWER_AUTH_VIA_BROKER',
      'GEMINI_REVIEWER_AUTH_VIA_BROKER',
      'OAUTH_BROKER_SHARED_SECRET_FILE',
      'OAUTH_BROKER_CLAUDE_REVIEWER_EXPECTED_APP_ID',
      'OAUTH_BROKER_CODEX_REVIEWER_EXPECTED_APP_ID',
      'OAUTH_BROKER_GEMINI_REVIEWER_EXPECTED_APP_ID',
    ]) {
      assert.match(plist, new RegExp(`<key>${key}</key>`), `${plistName} missing ${key}`);
    }
  }
});

test('maintainer watcher launchers resolve ALERT_TO through configured op ref', {
  skip: ZSH_AVAILABLE ? false : SKIP_REASON_NO_ZSH,
}, async () => {
  for (const scriptName of [
    'adversarial-watcher-start.sh',
    'adversarial-watcher-start-placey.sh',
  ]) {
    const result = await runMaintainerWatcherLauncher(scriptName, {
      extraEnv: { LINEAR_API_KEY: 'linear-test-token', ...BROKER_MODE_TEST_ENV },
    });
    assert.equal(result.code, 0, `${scriptName} stderr:\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /Cliovault/);
  }
});

test('maintainer watcher launcher ignores whitespace local LINEAR_API_KEY and falls back to 1Password', {
  skip: ZSH_AVAILABLE ? false : SKIP_REASON_NO_ZSH,
}, async () => {
  const result = await runMaintainerWatcherLauncher('adversarial-watcher-start.sh', {
    localLinearEnv: 'export LINEAR_API_KEY="  "\n',
    extraEnv: BROKER_MODE_TEST_ENV,
  });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  assert.match(result.opReadLog, /op:\/\/mem423y7ewrymvxv4ibh34zdk4\/zcblkukakjcadmws2vnjeqlswa\/credential/);
});

test('maintainer watcher launcher uses local LINEAR_API_KEY without inline comments or 1Password read', {
  skip: ZSH_AVAILABLE ? false : SKIP_REASON_NO_ZSH,
}, async () => {
  const result = await runMaintainerWatcherLauncher('adversarial-watcher-start.sh', {
    localLinearEnv: 'export LINEAR_API_KEY=linear-local-token # rotated by local runtime\n',
    extraEnv: BROKER_MODE_TEST_ENV,
  });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  assert.doesNotMatch(
    result.opReadLog,
    /op:\/\/mem423y7ewrymvxv4ibh34zdk4\/zcblkukakjcadmws2vnjeqlswa\/credential/,
  );
  const payload = JSON.parse(result.stdout.trim().split(/\n/).at(-1));
  assert.equal(payload.linearApiKey, 'linear-local-token');
});

test('maintainer watcher launcher reads first non-empty local ALERT_TO line', {
  skip: ZSH_AVAILABLE ? false : SKIP_REASON_NO_ZSH,
}, async () => {
  const result = await runMaintainerWatcherLauncher('adversarial-watcher-start.sh', {
    localAlertTo: '  alert@example.com  \nignored@example.com\n',
    extraEnv: { LINEAR_API_KEY: 'linear-test-token', ...BROKER_MODE_TEST_ENV },
  });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  assert.doesNotMatch(result.opReadLog, /op:\/\/test-vault\/adversarial-watcher-alert-to\/credential/);
  const payload = JSON.parse(result.stdout.trim().split(/\n/).at(-1));
  assert.equal(payload.alertTo, 'alert@example.com');
});

test('broker-mode launchers sleep before fail-closed exit when broker is unavailable', {
  skip: ZSH_AVAILABLE ? false : SKIP_REASON_NO_ZSH,
}, async () => {
  for (const scriptName of [
    'adversarial-watcher-start.sh',
    'adversarial-follow-up-tick.sh',
  ]) {
    const result = await runMaintainerWatcherLauncher(scriptName, {
      brokerMode: 'fail',
      extraEnv: { LINEAR_API_KEY: 'linear-test-token', ...BROKER_MODE_TEST_ENV },
    });
    assert.equal(result.code, 1, `${scriptName} stderr:\n${result.stderr}`);
    assert.match(result.stderr, /broker fetch failed/);
    assert.equal(result.sleepLog.trim(), '3600', `${scriptName} sleep log:\n${result.sleepLog}`);
  }
});

test('maintainer watcher launcher warns when configured op CLI is not executable', {
  skip: ZSH_AVAILABLE ? false : SKIP_REASON_NO_ZSH,
}, async () => {
  const result = await runMaintainerWatcherLauncher('adversarial-watcher-start.sh', {
    opCliPath: '/missing/op',
    extraEnv: { LINEAR_API_KEY: 'linear-test-token', ...BROKER_MODE_TEST_ENV },
  });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  assert.match(result.stderr, /WARN: configured 1Password CLI '\/missing\/op' is not executable/);
});

test('maintainer watcher launchers retry transient ALERT_TO op failures', {
  skip: ZSH_AVAILABLE ? false : SKIP_REASON_NO_ZSH,
}, async () => {
  for (const scriptName of [
    'adversarial-watcher-start.sh',
    'adversarial-watcher-start-placey.sh',
  ]) {
    const result = await runMaintainerWatcherLauncher(scriptName, {
      opMode: 'transient-then-ok',
      extraEnv: { LINEAR_API_KEY: 'linear-test-token', ...BROKER_MODE_TEST_ENV },
    });
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
        LINEAR_API_KEY: 'linear-test-token',
        ...BROKER_MODE_TEST_ENV,
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
    assert.equal(result.sleepLog.trim(), '3600', `${scriptName} sleep log:\n${result.sleepLog}`);
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
    assert.equal(result.sleepLog.trim(), '3600', `${scriptName} sleep log:\n${result.sleepLog}`);
  }
});

test('maintainer watcher launchers sleep on non-rate-limit required 1Password failures', {
  skip: ZSH_AVAILABLE ? false : SKIP_REASON_NO_ZSH,
}, async () => {
  for (const scriptName of [
    'adversarial-watcher-start.sh',
    'adversarial-watcher-start-placey.sh',
  ]) {
    const result = await runMaintainerWatcherLauncher(scriptName, { requiredOpMode: 'fail' });
    assert.equal(result.code, 1, `${scriptName} stderr:\n${result.stderr}`);
    assert.match(result.stderr, /failed to resolve LINEAR_API_KEY from 1Password/);
    assert.doesNotMatch(result.stderr, /rate-limit path/);
    assert.equal(result.sleepLog.trim(), '3600', `${scriptName} sleep log:\n${result.sleepLog}`);
  }
});

test('maintainer watcher launchers avoid stacked sleeps for rate-limited required 1Password failures', {
  skip: ZSH_AVAILABLE ? false : SKIP_REASON_NO_ZSH,
}, async () => {
  for (const scriptName of [
    'adversarial-watcher-start.sh',
    'adversarial-watcher-start-placey.sh',
  ]) {
    const result = await runMaintainerWatcherLauncher(scriptName, {
      requiredOpMode: 'rate-limit',
      extraEnv: {
        OP_RATE_LIMIT_BACKOFF_S: '1',
      },
    });
    assert.equal(result.code, 1, `${scriptName} stderr:\n${result.stderr}`);
    assert.match(result.stderr, /LINEAR_API_KEY resolution hit the 1Password rate-limit path/);
    assert.equal(result.sleepLog.trim(), '1', `${scriptName} sleep log:\n${result.sleepLog}`);
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
          LINEAR_API_KEY: 'linear-test-token',
          ...BROKER_MODE_TEST_ENV,
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
