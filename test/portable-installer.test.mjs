import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, statSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  PLACEHOLDERS,
  renderTemplate,
  unresolvedPlaceholders,
  buildHeaderComment,
  withHeader,
} from '../tools/adversarial-review/lib/render-template.mjs';
import {
  missingRequiredReviewerBotTokens,
  resolveRenderedCodexAuthPath,
} from '../tools/adversarial-review/lib/install-postflight.mjs';

const execFileAsync = promisify(execFile);
const thisFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFile), '..');
const templateDir = path.join(repoRoot, 'tools/adversarial-review/deploy/launchd');
const installScript = path.join(repoRoot, 'tools/adversarial-review/install.sh');
const postflightHelper = path.join(repoRoot, 'tools/adversarial-review/lib/install-postflight.mjs');

function makeBindings(overrides = {}) {
  return {
    REPO_ROOT: '/Users/operator/adversarial-review',
    OPERATOR_HOME: '/Users/operator',
    SECRETS_ROOT: '/Users/operator/.config/adversarial-review/secrets',
    LOG_ROOT: '/Users/operator/Library/Logs/adversarial-review',
    REVIEWER_AUTH_ROOT: '',
    WATCHER_USER_LABEL: 'local',
    ...overrides,
  };
}

function writeExecutable(filePath, body) {
  writeFileSync(filePath, body, 'utf8');
  chmodSync(filePath, 0o755);
}

async function runRenderedWatcherWrapper({
  alertTo = '',
  alertToOpRef = 'op://test-vault/adversarial-watcher-alert-to/credential',
  allowMissing = false,
  githubToken = '',
  opServiceAccountToken = '',
  tokenResolverMode = 'missing',
  tokenResolverValue = 'resolved-token',
  opCliPath,
  opMode = 'ok',
  opValue = 'alerts@example.com',
  ghMode = 'ok',
  helperMode = 'healthy',
  watcherBrokerMode = 'fail',
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'portable-installer-wrapper-'));
  const fakeBin = path.join(root, 'bin');
  const fakeRepo = path.join(root, 'repo');
  const fakeSecrets = path.join(root, 'secrets');
  const fakeLogs = path.join(root, 'logs');
  const fakeTmp = path.join(root, 'tmp');
  const fakeSharedHelper = path.join(fakeRepo, 'scripts', 'lib', 'op-resolve-with-rate-limit-backoff.sh');
  const fakeReviewerBrokerHelper = path.join(fakeRepo, 'scripts', 'lib', 'reviewer-broker.sh');
  const sleepLog = path.join(fakeTmp, 'sleep.log');
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(path.join(fakeRepo, 'src'), { recursive: true });
  mkdirSync(fakeSecrets, { recursive: true });
  mkdirSync(fakeLogs, { recursive: true });
  mkdirSync(fakeTmp, { recursive: true });
  writeFileSync(path.join(fakeRepo, 'src', 'watcher.mjs'), 'process.exit(0);\n', 'utf8');

  const wrapper = withHeader(
    renderTemplate(
      readFileSync(path.join(templateDir, 'adversarial-watcher-start.sh.template'), 'utf8'),
      makeBindings({
        REPO_ROOT: fakeRepo,
        SECRETS_ROOT: fakeSecrets,
        LOG_ROOT: fakeLogs,
      }),
      { format: 'shell' },
    ),
    '# test wrapper\n',
  );
  const wrapperPath = path.join(root, 'adversarial-watcher-start.sh');
  writeExecutable(wrapperPath, wrapper);

  writeExecutable(
    path.join(fakeBin, 'node'),
    '#!/bin/bash\n'
      + 'if [[ "$1" == "-e" ]]; then\n'
      + '  exit 0\n'
      + 'fi\n'
      + 'if [[ "$1" == *"resolve-op-token-cli.mjs" ]]; then\n'
      + '  if [[ "${TEST_OP_TOKEN_RESOLVER_MODE:-missing}" == "ok" ]]; then\n'
      + '    printf "%s" "${TEST_OP_TOKEN_RESOLVER_VALUE:-resolved-token}"\n'
      + '    exit 0\n'
      + '  fi\n'
      + '  echo "token missing" >&2\n'
      + '  exit 1\n'
      + 'fi\n'
      + 'if [[ "$1" == *"watcher.mjs" ]]; then\n'
      + '  printf "{\\"githubToken\\":\\"%s\\",\\"ghToken\\":\\"%s\\"}\\n" "${GITHUB_TOKEN:-}" "${GH_TOKEN:-}"\n'
      + '  exit 0\n'
      + 'fi\n'
      + 'exit 0\n',
  );
  writeExecutable(
    path.join(fakeBin, 'gh'),
    '#!/bin/bash\n'
      + 'if [[ "$1" == "auth" && "$2" == "token" ]]; then\n'
      + '  if [[ "${TEST_GH_MODE:-ok}" != "ok" ]]; then exit 1; fi\n'
      + '  echo "gh-token"\n'
      + '  exit 0\n'
      + 'fi\n'
      + 'exit 1\n',
  );
  writeExecutable(path.join(fakeBin, 'sleep'), `#!/bin/bash\nprintf '%s\\n' "$1" >>"${sleepLog}"\nexit 0\n`);
  writeExecutable(
    path.join(fakeBin, 'op'),
    '#!/bin/bash\n'
      + 'case "${TEST_OP_MODE:-ok}" in\n'
      + '  ok)\n'
      + '    printf "%s" "${TEST_OP_VALUE:-alerts@example.com}"\n'
      + '    exit 0\n'
      + '    ;;\n'
      + '  blank)\n'
      + '    printf "   \\n"\n'
      + '    exit 0\n'
      + '    ;;\n'
      + '  missing)\n'
      + '    echo "not found" >&2\n'
      + '    exit 1\n'
      + '    ;;\n'
      + '  fail)\n'
      + '    echo "op failure" >&2\n'
      + '    exit 1\n'
      + '    ;;\n'
      + '  rate-limit)\n'
      + '    echo "Error: HTTP 429 too many requests from 1Password" >&2\n'
      + '    exit 1\n'
      + '    ;;\n'
      + '  canonical-rate-limit)\n'
      + '    echo "Too many requests. Your client has been rate-limited" >&2\n'
      + '    exit 1\n'
      + '    ;;\n'
      + 'esac\n'
      + 'echo "unexpected mode" >&2\n'
      + 'exit 1\n',
  );
  if (helperMode === 'broken') {
    mkdirSync(path.dirname(fakeSharedHelper), { recursive: true });
    writeExecutable(
      fakeSharedHelper,
      '#!/bin/bash\n'
        + 'echo "broken helper" >&2\n'
        + 'return 9\n',
    );
  } else if (helperMode === 'healthy') {
    mkdirSync(path.dirname(fakeSharedHelper), { recursive: true });
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
  mkdirSync(path.dirname(fakeReviewerBrokerHelper), { recursive: true });
  writeExecutable(
    fakeReviewerBrokerHelper,
    '#!/bin/bash\n'
      + 'resolve_reviewer_token_via_broker() {\n'
      + '  if [[ "${TEST_WATCHER_BROKER_MODE:-fail}" != "healthy" ]]; then\n'
      + '    echo "[reviewer-broker] broker fetch failed" >&2\n'
      + '    return 1\n'
      + '  fi\n'
      + '  export "$1=broker-token"\n'
      + '  return 0\n'
      + '}\n',
  );

  const env = {
    ...process.env,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    TMPDIR: fakeTmp,
    ALERT_TO: alertTo,
    GITHUB_TOKEN: githubToken,
    GH_TOKEN: githubToken,
    ADVERSARIAL_REVIEW_ALERT_TO_OP_REF: alertToOpRef,
    OP_SERVICE_ACCOUNT_TOKEN: opServiceAccountToken,
    ADVERSARIAL_REVIEW_OP_CLI: opCliPath ?? path.join(fakeBin, 'op'),
    ADVERSARIAL_REVIEW_ALLOW_MISSING_ALERT_TO: allowMissing ? '1' : '',
    TEST_OP_TOKEN_RESOLVER_MODE: tokenResolverMode,
    TEST_OP_TOKEN_RESOLVER_VALUE: tokenResolverValue,
    TEST_OP_MODE: opMode,
    TEST_OP_VALUE: opValue,
    TEST_GH_MODE: ghMode,
    TEST_WATCHER_BROKER_MODE: watcherBrokerMode,
  };

  try {
    const result = await execFileAsync('/bin/bash', [wrapperPath], { env, cwd: root });
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      sleepLog: readdirSync(fakeTmp).includes('sleep.log') ? readFileSync(sleepLog, 'utf8') : '',
    };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      sleepLog: readdirSync(fakeTmp).includes('sleep.log') ? readFileSync(sleepLog, 'utf8') : '',
    };
  }
}

test('renderTemplate substitutes only the well-known placeholder set, leaving shell expansions intact', () => {
  const text = [
    'REPO=${REPO_ROOT}',
    'HOME=${OPERATOR_HOME}',
    'LABEL=ai.${WATCHER_USER_LABEL}.adversarial-watcher',
    'TOKEN_FALLBACK=${GITHUB_TOKEN:-}',
    'OTHER=${SOMETHING_ELSE}',
    '',
  ].join('\n');

  const out = renderTemplate(text, makeBindings({ REPO_ROOT: '/r', OPERATOR_HOME: '/o', WATCHER_USER_LABEL: 'alice' }));

  assert.match(out, /^REPO=\/r$/m);
  assert.match(out, /^HOME=\/o$/m);
  assert.match(out, /^LABEL=ai\.alice\.adversarial-watcher$/m);
  assert.match(out, /TOKEN_FALLBACK=\$\{GITHUB_TOKEN:-\}/);
  assert.match(out, /OTHER=\$\{SOMETHING_ELSE\}/);
});

test('renderTemplate XML-escapes substituted values for plist string nodes', () => {
  const out = renderTemplate(
    '<string>${REPO_ROOT}</string>',
    makeBindings({ REPO_ROOT: '/tmp/with&and<xml>"quotes"\'' }),
    { format: 'xml' },
  );

  assert.equal(
    out,
    '<string>/tmp/with&amp;and&lt;xml&gt;&quot;quotes&quot;&apos;</string>',
  );
});

test('renderTemplate shell-escapes values used inside double-quoted assignments', () => {
  const out = renderTemplate(
    'REPO_RENDER_REPO_ROOT="${REPO_ROOT}"\n'
      + 'REPO_RENDER_LOG_ROOT="${LOG_ROOT}"\n',
    makeBindings({
      REPO_ROOT: '/tmp/with space/"quote"/`tick`/$(touch pwn)/$HOME/\\slash',
      LOG_ROOT: '/tmp/logs\nnext',
    }),
    { format: 'shell' },
  );

  assert.equal(
    out,
    'REPO_RENDER_REPO_ROOT="/tmp/with space/\\"quote\\"/\\`tick\\`/\\$(touch pwn)/\\$HOME/\\\\slash"\n'
      + 'REPO_RENDER_LOG_ROOT="/tmp/logs\\nnext"\n',
  );
});

test('renderTemplate throws on missing binding', () => {
  assert.throws(() => renderTemplate('${REPO_ROOT}', {}), /missing binding for \$\{REPO_ROOT\}/);
});

test('unresolvedPlaceholders flags only the well-known leftover names', () => {
  const text = '${REPO_ROOT} stays, ${GITHUB_TOKEN:-} does not count';
  assert.deepEqual(unresolvedPlaceholders(text), ['REPO_ROOT']);
});

test('buildHeaderComment includes source template, time, and every binding', () => {
  const header = buildHeaderComment({
    format: 'shell',
    sourceTemplate: 'tools/adversarial-review/deploy/launchd/adversarial-watcher.plist.template',
    renderedAt: '2026-05-14T00:00:00.000Z',
    bindings: makeBindings({ WATCHER_USER_LABEL: 'alice' }),
  });
  assert.match(header, /Rendered by tools\/adversarial-review\/install\.sh/);
  assert.match(header, /Source template: tools\/adversarial-review\/deploy\/launchd\/adversarial-watcher\.plist\.template/);
  assert.match(header, /Rendered at:\s+2026-05-14T00:00:00\.000Z/);
  for (const name of PLACEHOLDERS) {
    assert.match(header, new RegExp(`${name} = `));
  }
  assert.match(header, /Edit the template and re-run install\.sh/);
});

test('buildHeaderComment omits raw binding values for XML output', () => {
  const header = buildHeaderComment({
    format: 'xml',
    sourceTemplate: 'tools/adversarial-review/deploy/launchd/adversarial-watcher.plist.template',
    renderedAt: '2026-05-14T00:00:00.000Z',
    bindings: makeBindings({
      REPO_ROOT: '/tmp/with&and<xml>',
      WATCHER_USER_LABEL: 'foo--bar',
    }),
  });
  assert.doesNotMatch(header, /foo--bar/);
  assert.doesNotMatch(header, /with&and<xml>/);
  assert.match(header, /Bindings omitted here so XML comments stay valid/);
});

test('withHeader inserts the header just after a shebang or XML declaration', () => {
  const header = '# rendered\n';
  assert.equal(
    withHeader('#!/usr/bin/env bash\necho hi\n', header),
    '#!/usr/bin/env bash\n# rendered\necho hi\n',
  );
  assert.equal(
    withHeader('<?xml version="1.0"?>\n<plist/>\n', header),
    '<?xml version="1.0"?>\n# rendered\n<plist/>\n',
  );
  assert.equal(withHeader('no shebang\nrest\n', header), '# rendered\nno shebang\nrest\n');
});

test('the four shipped templates render with sample bindings and leave no placeholder unresolved', () => {
  const bindings = makeBindings();
  const templates = [
    'adversarial-watcher.plist.template',
    'adversarial-follow-up.plist.template',
    'adversarial-watcher-start.sh.template',
    'adversarial-follow-up-tick.sh.template',
  ];
  for (const name of templates) {
    const text = readFileSync(path.join(templateDir, name), 'utf8');
    const rendered = renderTemplate(
      text,
      bindings,
      { format: name.endsWith('.plist.template') ? 'xml' : 'shell' },
    );
    assert.deepEqual(
      unresolvedPlaceholders(rendered),
      [],
      `unresolved placeholders in ${name} after render: ${unresolvedPlaceholders(rendered).join(', ')}`,
    );
    // Sanity: substituted values do appear in the rendered output.
    assert.ok(rendered.includes(bindings.REPO_ROOT), `${name} did not bake REPO_ROOT`);
    if (name === 'adversarial-watcher-start.sh.template') {
      assert.match(rendered, /export CODEX_AUTH_PATH="\$HOME\/\.codex\/auth\.json"/);
      assert.match(rendered, /resolve_op_bin/);
      assert.match(rendered, /op_resolve_with_rate_limit_backoff/);
      assert.match(rendered, /if ! \. "\$OP_RATE_LIMIT_HELPER"; then/);
      assert.match(rendered, /REVIEWER_BROKER_HELPER="\$REPO_RENDER_REPO_ROOT\/scripts\/lib\/reviewer-broker\.sh"/);
      assert.match(rendered, /resolve_reviewer_token_via_broker GITHUB_TOKEN "\$\{WATCHER_GH_BROKER_ROLE\}"/);
      assert.match(rendered, /WATCHER_GH_AUTH_VIA_BROKER:=true/);
      assert.match(rendered, /\[ -n "\$\{GITHUB_TOKEN:-\}" \]/);
      assert.match(rendered, /GH_TOKEN="\$\{GH_TOKEN:-\$GITHUB_TOKEN\}"/);
      assert.doesNotMatch(rendered, /\(\s*\. "\$OP_RATE_LIMIT_HELPER"\s*\)/);
      assert.match(rendered, /refusing to start without the shared cooldown primitive/);
      assert.match(rendered, /\/usr\/local\/bin\/op/);
      assert.doesNotMatch(rendered, /using vendored fallback/);
    }
  }
});

test('rendered watcher wrapper starts successfully when ALERT_TO is set directly', async () => {
  const result = await runRenderedWatcherWrapper({ alertTo: 'direct-alert@example.com' });
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stderr, /ERROR:/);
});

test('rendered watcher wrapper treats whitespace-only direct ALERT_TO as unset', async () => {
  const result = await runRenderedWatcherWrapper({
    alertTo: '   \t ',
    opServiceAccountToken: 'token',
    opMode: 'missing',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ALERT_TO is not provisioned/);
});

test('rendered watcher wrapper allows whitespace-only direct ALERT_TO only with degraded override', async () => {
  const result = await runRenderedWatcherWrapper({
    alertTo: '   \t ',
    opServiceAccountToken: 'token',
    opMode: 'missing',
    allowMissing: true,
  });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /WARN: ALERT_TO is unset by explicit operator override/);
});

test('rendered watcher wrapper resolves ALERT_TO through explicit op override', async () => {
  const result = await runRenderedWatcherWrapper({
    opServiceAccountToken: 'token',
    opMode: 'ok',
    opValue: 'path-alert@example.com',
  });
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stderr, /1Password CLI 'op' not found/);
});

test('rendered watcher wrapper requires configured ALERT_TO op ref for 1Password lookup', async () => {
  const result = await runRenderedWatcherWrapper({
    alertToOpRef: '',
    opServiceAccountToken: 'token',
    opMode: 'ok',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ALERT_TO 1Password ref is not configured/);
  assert.doesNotMatch(result.stderr, /Cliovault/);
});

test('rendered watcher wrapper falls back to PATH when op override is stale', async () => {
  const result = await runRenderedWatcherWrapper({
    opServiceAccountToken: 'token',
    opCliPath: '/missing/op',
    opMode: 'ok',
    opValue: 'path-alert@example.com',
  });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /WARN: configured 1Password CLI '\/missing\/op' is not executable/);
  assert.doesNotMatch(result.stderr, /1Password CLI 'op' not found/);
});

test('rendered watcher wrapper resolves OP token through canonical resolver before ALERT_TO', async () => {
  const result = await runRenderedWatcherWrapper({
    tokenResolverMode: 'ok',
    tokenResolverValue: 'token-from-file',
    opMode: 'ok',
    opValue: 'resolved-alert@example.com',
  });
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stderr, /OP_SERVICE_ACCOUNT_TOKEN could not be resolved/);
});

test('rendered watcher wrapper fails startup when ALERT_TO is absent and override is unset', async () => {
  const result = await runRenderedWatcherWrapper({
    opServiceAccountToken: 'token',
    opMode: 'missing',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ALERT_TO is not provisioned/);
});

test('rendered watcher wrapper warns but starts when missing ALERT_TO is explicitly allowed', async () => {
  const result = await runRenderedWatcherWrapper({
    opServiceAccountToken: 'token',
    opMode: 'missing',
    allowMissing: true,
  });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /WARN: ALERT_TO is unset by explicit operator override/);
});

test('rendered watcher wrapper rejects blank ALERT_TO values from 1Password', async () => {
  const result = await runRenderedWatcherWrapper({
    opServiceAccountToken: 'token',
    opMode: 'blank',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /resolved to an empty value/);
});

test('rendered watcher wrapper allows blank ALERT_TO values from 1Password with degraded override', async () => {
  const result = await runRenderedWatcherWrapper({
    opServiceAccountToken: 'token',
    opMode: 'blank',
    allowMissing: true,
  });
  assert.equal(result.code, 0);
  assert.match(result.stderr, /WARN: ALERT_TO is unset by explicit operator override/);
});

test('rendered watcher wrapper defaults watcher GitHub auth to the broker token', async () => {
  const result = await runRenderedWatcherWrapper({
    alertTo: 'direct-alert@example.com',
    ghMode: 'fail',
    watcherBrokerMode: 'healthy',
  });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  assert.match(result.stderr, /GITHUB_TOKEN resolved via OAuth broker \(role=merge-agent/);
  assert.doesNotMatch(result.stderr, /GITHUB_TOKEN not set and gh auth token returned nothing/);
});

test('rendered watcher wrapper preserves operator GITHUB_TOKEN when broker and gh fallback fail', async () => {
  const result = await runRenderedWatcherWrapper({
    alertTo: 'direct-alert@example.com',
    githubToken: 'env-token',
    ghMode: 'fail',
    watcherBrokerMode: 'fail',
  });
  assert.equal(result.code, 0, `stderr:\n${result.stderr}`);
  const payload = JSON.parse(result.stdout.trim().split(/\n/).at(-1));
  assert.equal(payload.githubToken, 'env-token');
  assert.equal(payload.ghToken, 'env-token');
  assert.match(result.stderr, /GITHUB_TOKEN from operator env\/dotenv/);
  assert.doesNotMatch(result.stderr, /GITHUB_TOKEN not set and gh auth token returned nothing/);
});

test('rendered watcher wrapper fails closed when the shared helper fails to load', async () => {
  const result = await runRenderedWatcherWrapper({
    alertTo: 'direct-alert@example.com',
    helperMode: 'broken',
  });
  assert.equal(result.code, 78);
  assert.match(result.stderr, /broken helper/);
  assert.match(result.stderr, /refusing to start without the shared cooldown primitive/);
  assert.equal(result.sleepLog.trim(), '3600');
});

test('rendered watcher wrapper fails closed when the shared helper is missing', async () => {
  const result = await runRenderedWatcherWrapper({
    alertTo: 'direct-alert@example.com',
    helperMode: 'missing',
  });
  assert.equal(result.code, 78);
  assert.match(result.stderr, /helper missing/);
  assert.match(result.stderr, /refusing to start without the shared cooldown primitive/);
  assert.equal(result.sleepLog.trim(), '3600');
});

test('rendered watcher wrapper sleeps when gh token fallback is unavailable', async () => {
  const result = await runRenderedWatcherWrapper({
    alertTo: 'direct-alert@example.com',
    ghMode: 'fail',
    helperMode: 'healthy',
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /GITHUB_TOKEN not set and gh auth token returned nothing/);
  assert.equal(result.sleepLog.trim(), '3600');
});

for (const opMode of ['rate-limit', 'canonical-rate-limit']) {
  test(`rendered watcher wrapper routes ${opMode} through the shared helper cooldown`, async () => {
    const result = await runRenderedWatcherWrapper({
      opServiceAccountToken: 'token',
      opMode,
      opCliPath: path.join('/missing', 'op'),
      allowMissing: false,
      helperMode: 'healthy',
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /configured 1Password CLI '\/missing\/op' is not executable/);
    assert.match(result.stderr, /without extra ALERT_TO retries or an additional launcher sleep/);
    assert.doesNotMatch(result.stderr, /retrying in 5s/);
    assert.equal(result.sleepLog.trim(), '900');
  });
}

test('resolveRenderedCodexAuthPath matches the installer contract for default and override layouts', () => {
  assert.equal(
    resolveRenderedCodexAuthPath({ operatorHome: '/Users/operator', reviewerAuthRoot: '' }),
    '/Users/operator/.codex/auth.json',
  );
  assert.equal(
    resolveRenderedCodexAuthPath({ operatorHome: '/Users/operator', reviewerAuthRoot: '/srv/reviewer-auth' }),
    '/srv/reviewer-auth/codex/auth.json',
  );
});

test('missingRequiredReviewerBotTokens reports exactly the missing reviewer PAT env vars', () => {
  assert.deepEqual(
    missingRequiredReviewerBotTokens({ GH_CLAUDE_REVIEWER_TOKEN: 'claude-pat' }),
    ['GH_CODEX_REVIEWER_TOKEN'],
  );
  assert.deepEqual(
    missingRequiredReviewerBotTokens({
      GH_CLAUDE_REVIEWER_TOKEN: 'claude-pat',
      GH_CODEX_REVIEWER_TOKEN: 'codex-pat',
    }),
    [],
  );
});

test('install postflight helper probes Claude and Codex using the rendered single-user auth path', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'portable-installer-postflight-'));
  const fakeBin = path.join(root, 'bin');
  const fakeHome = path.join(root, 'home');
  const codexDir = path.join(fakeHome, '.codex');
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(
    path.join(codexDir, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'access', refresh_token: 'refresh' },
    }),
    'utf8',
  );
  writeFileSync(
    path.join(fakeBin, 'claude'),
    '#!/bin/bash\nif [[ \"$1\" == \"auth\" && \"$2\" == \"status\" ]]; then\n  echo \"loggedIn: true\"\n  exit 0\nfi\nexit 0\n',
    'utf8',
  );
  writeFileSync(path.join(fakeBin, 'codex'), '#!/bin/bash\nexit 0\n', 'utf8');
  for (const file of ['claude', 'codex']) {
    statSync(path.join(fakeBin, file));
  }
  await execFileAsync('/bin/chmod', ['+x', path.join(fakeBin, 'claude'), path.join(fakeBin, 'codex')]);

  const env = {
    ...process.env,
    HOME: fakeHome,
    PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
  };

  const { stdout: codexStdout } = await execFileAsync(
    process.execPath,
    [postflightHelper, 'probe-codex', fakeHome, ''],
    { cwd: repoRoot, env },
  );
  assert.equal(codexStdout.trim(), path.join(fakeHome, '.codex', 'auth.json'));

  await execFileAsync(
    process.execPath,
    [postflightHelper, 'probe-claude'],
    { cwd: repoRoot, env },
  );
});

test('rendered plists parse as XML and survive plutil -lint when plutil is available', async () => {
  const bindings = makeBindings({
    REPO_ROOT: '/Users/operator/repo&support<team>',
    OPERATOR_HOME: '/Users/operator&co',
    LOG_ROOT: '/Users/operator/Library/Logs/adversarial-review<&>',
    WATCHER_USER_LABEL: 'foo--bar',
  });
  const outDir = mkdtempSync(path.join(tmpdir(), 'portable-installer-plist-'));

  for (const file of ['adversarial-watcher.plist.template', 'adversarial-follow-up.plist.template']) {
    const text = readFileSync(path.join(templateDir, file), 'utf8');
    const rendered = renderTemplate(text, bindings, { format: 'xml' });
    // Substituted strings show up where the placeholders were.
    assert.match(rendered, new RegExp(`<string>ai\\.${bindings.WATCHER_USER_LABEL}\\.adversarial-`));
    assert.match(rendered, /&amp;/);
    assert.match(rendered, /&lt;/);
    const outPath = path.join(outDir, file.replace('.template', ''));
    writeFileSync(outPath, rendered);
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('/usr/bin/plutil', ['-lint', outPath]);
      assert.match(stdout, /OK/);
    }
  }
});

test('install.sh --dry-run renders all four files into a temp output dir without touching $HOME', async () => {
  const outRoot = mkdtempSync(path.join(tmpdir(), 'portable-installer-dryrun-'));
  const launchAgentsDir = path.join(outRoot, 'LaunchAgents');
  const fakeOperatorHome = path.join(outRoot, 'home');
  mkdirSync(fakeOperatorHome, { recursive: true });

  const env = {
    ...process.env,
    REPO_ROOT: repoRoot,
    OPERATOR_HOME: fakeOperatorHome,
    SECRETS_ROOT: path.join(fakeOperatorHome, '.config/adversarial-review/secrets'),
    LOG_ROOT: path.join(fakeOperatorHome, 'Library/Logs/adversarial-review'),
    REVIEWER_AUTH_ROOT: '',
    WATCHER_USER_LABEL: 'testlabel',
  };

  const { stdout, stderr } = await execFileAsync(
    '/bin/bash',
    [installScript, '--dry-run', '--output-dir', launchAgentsDir],
    { env, cwd: repoRoot },
  );

  // Both plists rendered into the chosen output dir.
  const plistFiles = readdirSync(launchAgentsDir).sort();
  assert.deepEqual(plistFiles, [
    'ai.testlabel.adversarial-follow-up.plist',
    'ai.testlabel.adversarial-watcher.plist',
  ]);

  // Wrapper scripts rendered under a sibling scripts-render dir.
  const sidecarDir = path.join(path.dirname(launchAgentsDir), 'scripts-render');
  const sidecarFiles = readdirSync(sidecarDir).sort();
  assert.deepEqual(sidecarFiles, [
    'adversarial-follow-up-tick.sh',
    'adversarial-watcher-start.sh',
  ]);

  // Rendered shell scripts are marked executable.
  for (const name of sidecarFiles) {
    const mode = statSync(path.join(sidecarDir, name)).mode & 0o111;
    assert.notEqual(mode, 0, `${name} should be executable`);
  }

  // Header comment is present in each rendered file and records the binding.
  for (const plist of plistFiles) {
    const body = readFileSync(path.join(launchAgentsDir, plist), 'utf8');
    assert.match(body, /Rendered by tools\/adversarial-review\/install\.sh/);
    assert.match(body, /ai\.testlabel\.adversarial-/);
    assert.equal(unresolvedPlaceholders(body).length, 0);
  }

  // Dry-run output makes the no-write contract explicit.
  assert.match(stdout, /Mode: --dry-run/);
  assert.match(stdout, /Dry-run complete/);
  // It also reports the bindings we passed.
  assert.match(stdout, new RegExp(`REPO_ROOT\\s+${repoRoot.replace(/\//g, '\\/')}`));
  // Postflight is skipped under --dry-run, so we should not see its block.
  assert.doesNotMatch(stdout, /^Postflight:/m);
  // Nothing was written to the fake $HOME's LaunchAgents location.
  assert.equal(
    readdirSync(fakeOperatorHome).includes('Library'),
    false,
    `dry-run must not create Library/LaunchAgents in $HOME, but $HOME contains: ${readdirSync(fakeOperatorHome).join(', ')}`,
  );

  // Sanity: stderr is empty or warning-only, never an unhandled error.
  assert.doesNotMatch(stderr, /Error:/);
});
