import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collect, review } from './helpers/hamclose-history.mjs';
import { checkPrimaryChange, fetchDeadCodeSources } from '../src/ama/primary-change.mjs';
import { parseDeadCodeDeclaration } from '../src/ama/dead-code-symbols.mjs';

const head = 'c'.repeat(40);
const author = '2'.repeat(40);

// Real `git diff` patches for base..primary, primary..closer and base..final.
function patches(t, path, { base, primary, final }) {
  const root = mkdtempSync(join(tmpdir(), 'dead-code-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stage = (name, text) => { writeFileSync(join(root, name), text); return name; };
  const diff = (from, to) => {
    let output;
    // `git diff --no-index` exits 1 when the inputs differ.
    try { output = execFileSync('git', ['diff', '--no-index', '--no-ext-diff', '--unified=3', from, to],
      { cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }); }
    catch (error) { if (error.status !== 1) throw error; output = error.stdout; }
    const lines = output.split('\n');
    const first = lines.findIndex(line => line.startsWith('@@ '));
    if (first < 0) return [];
    const body = lines.slice(first, lines.at(-1) === '' ? -1 : undefined);
    return [{ filename: path, status: 'modified', additions: body.filter(line => line.startsWith('+')).length,
      deletions: body.filter(line => line.startsWith('-')).length, patch: body.join('\n') }];
  };
  const [b, p, f] = [stage('base.txt', base), stage('primary.txt', primary), stage('final.txt', final)];
  return { primaryFiles: diff(b, p), commitFiles: diff(p, f), finalFiles: diff(b, f) };
}

const card = (file, lines, title = 'Helper is never called') =>
  `- **${title}**\n  - **File:** \`${file}\`\n  - **Lines:** \`${lines}\`\n  - **Problem:** Dead helper.\n  - **Recommended fix:** Delete it.`;

// A non-rebased closer commit removing the cited helper and, optionally, its
// now-dead declarations. Sources default to the real pre-change/head files.
async function scenario(t, { path, base, primary, final, cited, sources }) {
  const { primaryFiles, commitFiles, finalFiles } = patches(t, path, { base, primary, final });
  const body = `## Blocking issues\n${card(path, cited)}\n## Non-blocking issues\n- None.\n## Verdict\nRequest changes`;
  const { evidence } = await collect({ shift: 0, reviews: [review({ body })] });
  const authorization = evidence.reversalAuthorizations[0];
  authorization.rebased = false;
  evidence.primaryFiles = primaryFiles;
  authorization.reviewedFiles = structuredClone(primaryFiles);
  authorization.parentFiles = structuredClone(primaryFiles);
  authorization.commit.files = commitFiles;
  evidence.finalFiles = finalFiles;
  evidence.deadCodeSources = sources ?? [{ path, ref: author, text: primary }, { path, ref: head, text: final }];
  return evidence;
}

const rejected = result => result.missingEvidence?.rejected.map(entry => entry.reason) || [];

const pyBase = `"""Lookup."""
import os


def resolve(name):
    return os.path.join("/srv", name)
`;
const pyHelper = `

def _mark_seen():
    global _seen_once
    if _seen_once is None:
        _seen_once = True
        logging.info("seen")
`;
const pyPrimary = ({ resolveBody = '    return os.path.join("/srv", name)', header = '' } = {}) => `"""Lookup."""
${header}import os
import logging

_seen_once = None


def resolve(name):
${resolveBody}
${pyHelper}`;
const pyFinal = ({ resolveBody = '    return os.path.join("/srv", name)', header = '' } = {}) => `"""Lookup."""
${header}import os


def resolve(name):
${resolveBody}
`;
// The helper insertion in reviewed-head coordinates, from its blank lines.
const pyHelperLines = header => `${10 + header.split('\n').length - 1}-${16 + header.split('\n').length - 1}`;

test('PRIMARYDEADCODE-01: a cited helper deletion carries its sole-use import and module global', async (t) => {
  for (const kept of [false, true]) {
    // kept: an unrelated author change survives, so the path still has a final diff.
    const keep = text => kept ? text.replace('"""Lookup."""', '"""Look up names."""') : text;
    const evidence = await scenario(t, { path: 'src/lookup.py', base: pyBase,
      primary: keep(pyPrimary()), final: keep(pyFinal()), cited: pyHelperLines('') });
    if (!kept) assert.deepEqual(evidence.finalFiles, []);
    const result = checkPrimaryChange(evidence, head);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.derivedDeadCode.map(({ line, symbol, referencesCovered }) => ({ line, symbol, referencesCovered })), [
      { line: 3, symbol: 'logging', referencesCovered: [16] },
      { line: 5, symbol: '_seen_once', referencesCovered: [13, 14, 15] },
    ]);
    assert.ok(result.derivedDeadCode.every(proof => proof.path === 'src/lookup.py' && proof.commit === head));
    // Without the content proof the same history keeps today's refusal.
    const unproven = checkPrimaryChange({ ...evidence, deadCodeSources: [] }, head);
    assert.equal(unproven.reason, 'primary-change-reverted');
    assert.ok(rejected(unproven).includes('dead-code-proof-failed:source-unavailable'), JSON.stringify(unproven));
  }
});

test('PRIMARYDEADCODE-01: an import still used outside the cited removal is refused', async (t) => {
  const resolveBody = '    logging.debug(name)\n    return os.path.join("/srv", name)';
  const primary = pyPrimary({ resolveBody });
  // The closer also drops the surviving use, outside every cited range.
  const evidence = await scenario(t, { path: 'src/lookup.py', base: pyBase, primary,
    final: pyFinal(), cited: '11-17' });
  const result = checkPrimaryChange(evidence, head);
  assert.equal(result.reason, 'primary-change-reverted');
  assert.ok(rejected(result).some(reason => ['not-covered-by-cited-finding', 'dead-code-proof-failed:reference-outside']
    .includes(reason)), JSON.stringify(result));
  // Keeping the use while dropping the import still refuses at the head.
  const keepsUse = await scenario(t, { path: 'src/lookup.py', base: pyBase, primary,
    final: pyFinal({ resolveBody }), cited: '11-17' });
  const refused = checkPrimaryChange(keepsUse, head);
  assert.equal(refused.reason, 'primary-change-reverted');
  assert.ok(rejected(refused).includes('dead-code-proof-failed:reference-outside'), JSON.stringify(refused));
});

for (const [name, header, reason] of [
  ['__all__ export', '__all__ = ["resolve", "logging"]\n', 'dead-code-proof-failed:all-export'],
  ['string reference', 'PLUGIN = "logging"\n', 'dead-code-proof-failed:string-reference'],
  ['getattr reference', 'import sys\nLOGGER = getattr(sys.modules[__name__], "log" + "ging")\n', 'dead-code-proof-failed:dynamic-reference'],
]) {
  test(`PRIMARYDEADCODE-01: an import reachable by name is refused: ${name}`, async (t) => {
    const evidence = await scenario(t, { path: 'src/lookup.py', base: pyBase.replace('import os\n', `${header}import os\n`),
      primary: pyPrimary({ header }), final: pyFinal({ header }), cited: pyHelperLines(header) });
    const result = checkPrimaryChange(evidence, head);
    assert.equal(result.reason, 'primary-change-reverted', JSON.stringify(result));
    assert.ok(rejected(result).includes(reason), JSON.stringify(result));
  });
}

test('PRIMARYDEADCODE-01: getattr through a string literal names the import', async (t) => {
  const resolveBody = '    getattr(__builtins__, "logging", None)\n    return os.path.join("/srv", name)';
  const evidence = await scenario(t, { path: 'src/lookup.py', base: pyBase.replace(
    '    return os.path.join("/srv", name)', resolveBody), primary: pyPrimary({ resolveBody }),
  final: pyFinal({ resolveBody }), cited: '11-17' });
  const result = checkPrimaryChange(evidence, head);
  assert.equal(result.reason, 'primary-change-reverted');
  assert.ok(rejected(result).includes('dead-code-proof-failed:string-reference'), JSON.stringify(result));
});

test('PRIMARYDEADCODE-01: undeclared, public, unreferenced and mismatched removals fail closed', async (t) => {
  // An import the removed helper never used is not part of that deletion.
  const unused = await scenario(t, { path: 'src/lookup.py', base: pyBase,
    primary: pyPrimary().replace('import logging\n', 'import logging\nimport json\n'),
    final: pyFinal(), cited: '11-17' });
  assert.ok(rejected(checkPrimaryChange(unused, head)).includes('dead-code-proof-failed:no-authorized-reference'));
  // Public module attributes are importable API.
  const publicName = await scenario(t, { path: 'src/lookup.py', base: pyBase,
    primary: pyPrimary().replaceAll('_seen_once', 'SEEN_ONCE'), final: pyFinal(), cited: pyHelperLines('') });
  assert.ok(rejected(checkPrimaryChange(publicName, head)).includes('dead-code-proof-failed:public-binding'));
  // Package modules re-export what they import.
  const pkg = await scenario(t, { path: 'src/lookup/__init__.py', base: pyBase,
    primary: pyPrimary(), final: pyFinal(), cited: pyHelperLines('') });
  assert.ok(rejected(checkPrimaryChange(pkg, head)).includes('dead-code-proof-failed:re-export'));
  // Content that disagrees with the commit patch proves nothing.
  const mismatch = await scenario(t, { path: 'src/lookup.py', base: pyBase, primary: pyPrimary(), final: pyFinal(),
    cited: pyHelperLines(''), sources: [{ path: 'src/lookup.py', ref: author, text: pyBase },
      { path: 'src/lookup.py', ref: head, text: pyFinal() }] });
  assert.ok(rejected(checkPrimaryChange(mismatch, head)).includes('dead-code-proof-failed:source-mismatch'));
  // A surviving dynamic namespace read can reach any module global.
  const dynamic = await scenario(t, { path: 'src/lookup.py', base: pyBase, primary: pyPrimary(), final: pyFinal(),
    cited: pyHelperLines(''), sources: [{ path: 'src/lookup.py', ref: author, text: pyPrimary() },
      { path: 'src/lookup.py', ref: head, text: `${pyFinal()}\nREGISTRY = globals()\n` }] });
  assert.ok(rejected(checkPrimaryChange(dynamic, head)).includes('dead-code-proof-failed:dynamic-reference'));
  // An unreadable head file proves nothing.
  const unreadable = await scenario(t, { path: 'src/lookup.py', base: pyBase, primary: pyPrimary(), final: pyFinal(),
    cited: pyHelperLines(''), sources: [{ path: 'src/lookup.py', ref: author, text: pyPrimary() },
      { path: 'src/lookup.py', ref: head, error: 'unparseable' }] });
  assert.ok(rejected(checkPrimaryChange(unreadable, head)).includes('dead-code-proof-failed:unparseable'));
  // Without any finding covering the helper, nothing is authorized.
  const uncited = await scenario(t, { path: 'src/lookup.py', base: pyBase, primary: pyPrimary(), final: pyFinal(), cited: '1-2' });
  assert.equal(checkPrimaryChange(uncited, head).reason, 'primary-change-reverted');
});

const jsBase = `import { readFileSync } from 'node:fs';

export function load(path) {
  return readFileSync(path, 'utf8');
}
`;
const jsPrimary = ({ exported = false } = {}) => `import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

${exported ? 'export ' : ''}const RETRY_LIMIT = 3;

export function load(path) {
  return readFileSync(path, 'utf8');
}

async function retryLoad(path) {
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
    try { return load(path); } catch { await sleep(10); }
  }
}
`;

test('PRIMARYDEADCODE-01: a JS top-level const and import used only by a removed function', async (t) => {
  const evidence = await scenario(t, { path: 'src/loader.mjs', base: jsBase, primary: jsPrimary(), final: jsBase, cited: '9-14' });
  const result = checkPrimaryChange(evidence, head);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.derivedDeadCode.map(({ line, symbol, referencesCovered }) => ({ line, symbol, referencesCovered })), [
    { line: 2, symbol: 'sleep', referencesCovered: [12] },
    { line: 4, symbol: 'RETRY_LIMIT', referencesCovered: [11] },
  ]);
  // An exported binding is outside the declaration grammar: today's refusal.
  const exported = await scenario(t, { path: 'src/loader.mjs', base: jsBase, primary: jsPrimary({ exported: true }),
    final: jsBase, cited: '9-14' });
  const refused = checkPrimaryChange(exported, head);
  assert.equal(refused.reason, 'primary-change-reverted');
  assert.ok(rejected(refused).includes('not-covered-by-cited-finding'), JSON.stringify(refused));
  assert.ok(!rejected(refused).some(reason => reason.startsWith('dead-code-proof-failed')), JSON.stringify(refused));
});

test('PRIMARYDEADCODE-01: the declaration grammar is closed', () => {
  for (const [language, line, symbols] of [
    ['python', 'import logging', ['logging']],
    ['python', 'import os.path as osp, sys  # stdlib', ['osp', 'sys']],
    ['python', 'from .util import helper as h, other', ['h', 'other']],
    ['python', '_cache = None', ['_cache']],
    ['python', "_label = 'x'", ['_label']],
    ['js', "import fs, { readFile as rf } from 'node:fs';", ['fs', 'rf']],
    ['js', "import * as path from 'node:path'", ['path']],
    ['js', "import type { Thing } from './types';", ['Thing']],
    ['js', 'const LIMIT = 3;', ['LIMIT']],
    ['js', 'let cache = new Map();', ['cache']],
  ]) assert.deepEqual(parseDeadCodeDeclaration(language, line)?.symbols, symbols, line);
  for (const [language, line] of [
    ['python', 'from m import *'], ['python', 'from m import (a,'], ['python', '    import logging'],
    ['python', '_value = compute()'], ['python', '_value: int = 3'], ['python', 'if x: import y'],
    ['js', "import './side-effect.mjs';"], ['js', 'export const LIMIT = 3;'], ['js', 'const LIMIT = compute();'],
    ['js', 'const { a } = b;'], ['js', 'var LIMIT = 3;'], ['js', "import { a } from 'm'; run();"],
  ]) assert.equal(parseDeadCodeDeclaration(language, line), null, line);
  assert.deepEqual(parseDeadCodeDeclaration('python', 'LIMIT = 3'), { error: 'public-binding' });
  assert.deepEqual(parseDeadCodeDeclaration('python', 'from __future__ import annotations'), { error: 'unsupported-declaration' });
});

test('PRIMARYDEADCODE-01: content reads cover the commit parent and head, once, only for candidates', async (t) => {
  const evidence = await scenario(t, { path: 'src/lookup.py', base: pyBase, primary: pyPrimary(), final: pyFinal(),
    cited: pyHelperLines(''), sources: [] });
  const reads = [];
  const encoded = text => ({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') });
  const get = async (path) => {
    reads.push(path);
    if (path === `repos/fixture/repo/contents/src/lookup.py?ref=${author}`) return encoded(pyPrimary());
    if (path === `repos/fixture/repo/contents/src/lookup.py?ref=${head}`) return encoded(pyFinal());
    throw new Error(`unexpected ${path}`);
  };
  const refusal = checkPrimaryChange(evidence, head);
  assert.equal(refusal.reason, 'primary-change-reverted');
  const sources = await fetchDeadCodeSources({ repo: 'fixture/repo', get }, evidence, refusal.path, refusal.missingEvidence.regions);
  assert.deepEqual(reads.sort(), [`repos/fixture/repo/contents/src/lookup.py?ref=${author}`,
    `repos/fixture/repo/contents/src/lookup.py?ref=${head}`].sort());
  evidence.deadCodeSources = sources;
  assert.equal(checkPrimaryChange(evidence, head).ok, true);
  assert.deepEqual(await fetchDeadCodeSources({ repo: 'fixture/repo', get }, evidence, refusal.path, refusal.missingEvidence.regions), []);
  // A refused region that is not a declaration insertion reads nothing.
  assert.deepEqual(await fetchDeadCodeSources({ repo: 'fixture/repo', get }, { ...evidence, deadCodeSources: [] },
    refusal.path, [{ start: 999, end: 999 }]), []);
  // Read failures are recorded, never thrown.
  const failed = await fetchDeadCodeSources({ repo: 'fixture/repo', get: async () => { throw new Error('boom'); } },
    { ...evidence, deadCodeSources: [] }, refusal.path, refusal.missingEvidence.regions);
  assert.ok(failed.length === 2 && failed.every(source => source.error === 'source-unavailable'));
  assert.equal(reads.length, 2);
});
