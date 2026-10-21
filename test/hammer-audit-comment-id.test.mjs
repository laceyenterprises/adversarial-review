import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selector = join(root, 'bin/hammer-audit-comment-id.mjs');
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const marker = '<!-- hq:ham-terminal-remediation:audit -->';
const audit = {
  id: 42,
  user: { login: 'the-hammer-lacey[bot]' },
  body: `${marker}\nHAM-Base-Head: ${base}\nHAM-Validated-Head: ${head}\nHAM-Terminal-Remediation-Head: ${head}`,
};
function select(pages) {
  return spawnSync(process.execPath, [selector, base, head, marker], {
    input: JSON.stringify(pages, null, 2), encoding: 'utf8', timeout: 5000,
  });
}

test('audit selector parses pretty-printed pages and selects only the exact App-authored edge', () => {
  const wrongEdges = [
    { ...audit, id: 1, user: { login: 'builder' } },
    { ...audit, id: 2, body: audit.body.replace(base, 'c'.repeat(40)) },
    { ...audit, id: 3, body: audit.body.replaceAll(head, 'c'.repeat(40)) },
    { ...audit, id: 4, body: audit.body.replace(marker, 'ordinary comment') },
    { ...audit, id: '5' },
  ];
  const result = select([wrongEdges, [], [audit, { ...audit, id: 43 }]]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '42\n');
});

test('audit selector returns no id for empty pages or a missing edge', () => {
  for (const pages of [[], [[]], [[{ id: 7, body: 'ordinary comment' }]]]) {
    const result = select(pages);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
});

test('audit selector refuses malformed JSON rather than reporting an absent edge', () => {
  const result = spawnSync(process.execPath, [selector, base, head, marker], {
    input: '[{', encoding: 'utf8', timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});

test('publish lookup passes one complete paginated JSON payload to the real selector', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hammer-audit-lookup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pagesPath = join(dir, 'pages.json');
  const argsPath = join(dir, 'args.json');
  writeFileSync(pagesPath, JSON.stringify([[{ id: 1, body: 'ordinary comment' }], [audit]], null, 2));
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.ARGS_PATH, JSON.stringify(process.argv.slice(2)));
process.stdout.write(fs.readFileSync(process.env.PAGES_PATH));
`, { mode: 0o755 });
  const source = readFileSync(join(root, 'bin/hammer-publish.sh'), 'utf8');
  const lookup = source.match(/ham_existing_terminal_audit_comment_id\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(lookup);
  const script = (source.match(/ham_gh\(\) \{[^\n]+/)[0] + '\n' + lookup).replaceAll('<<ROOT_DIR>>', root)
    .replaceAll('<<REPO>>', 'fixture/repo').replaceAll('<<PR_NUMBER>>', '123');
  const result = spawnSync('/bin/bash', ['-c', `${script}\nham_existing_terminal_audit_comment_id`], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ARGS_PATH: argsPath, PAGES_PATH: pagesPath,
      HAM_NODE_BIN: process.execPath, HAM_GH_TOKEN: 'fixture', HAM_AUDIT_BASE_HEAD: base,
      POST_REMEDIATION_SHA: head, HAM_AUDIT_COMMENT_MARKER: marker,
      HAM_AUDIT_COMMENT_LOOKUP_STDERR: join(dir, 'lookup-stderr') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '42\n');
  assert.deepEqual(JSON.parse(readFileSync(argsPath, 'utf8')),
    ['api', '--paginate', '--slurp', 'repos/fixture/repo/issues/123/comments']);
});
