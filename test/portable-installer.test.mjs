import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
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
    }
  }
});

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
