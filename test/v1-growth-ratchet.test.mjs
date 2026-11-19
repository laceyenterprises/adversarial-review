import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { formatV1GrowthContext, isFixTitle, measureV1Growth } from '../src/v1-growth-ratchet.mjs';
import { buildReviewerExtraContext } from '../src/reviewer-prompt.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO = 'synthetic/v1';
const RATCHET = { subsystems: [
  { id: 'owned-v1', repo: REPO, pack: 'PAK', paths: ['src/owned/', 'src/owned-'] },
  { id: 'unowned-v1', repo: REPO, pack: null, paths: ['src/'] },
] };

function file(path, added, removed) {
  const body = [...Array(added).fill('+x'), ...Array(removed).fill('-y'), ' context'].join('\n');
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${removed} +1,${added} @@\n${body}\n`;
}

const DIFF = file('src/owned/a.mjs', 5, 1) + file('src/owned-b.mjs', 2, 1) + file('src/other.mjs', 1, 5)
  + file('test/owned.test.mjs', 50, 0) + file('src/owned/fixtures/x.json', 9, 0) + file('docs/x.md', 7, 0);

test('V1RATCHET-01: counts net non-test hunk lines per first matching subsystem', async () => {
  assert.deepEqual(await measureV1Growth(DIFF, REPO, RATCHET), [
    { id: 'owned-v1', pack: 'PAK', added: 7, removed: 2, net: 5 },
    { id: 'unowned-v1', pack: null, added: 1, removed: 5, net: -4 },
  ]);
  assert.deepEqual(await measureV1Growth(DIFF, 'synthetic/other', RATCHET), []);
  assert.deepEqual(await measureV1Growth(DIFF, REPO, undefined), []);
});

test('V1RATCHET-01: excludes recognized test paths inside a frozen subsystem', async () => {
  const testPaths = ['closer.spec.mjs', 'closer.test.mjs', 'closer_test.go', 'test_closer.py',
    ...['test', 'tests', 'spec', 'specs', '__tests__', 'testdata', '__fixtures__', 'fixtures'].map(dir => `${dir}/closer.mjs`)];
  const shipped = JSON.parse(readFileSync(join(ROOT, 'domains/code-pr.json'), 'utf8')).v1GrowthRatchet;
  const diff = testPaths.map(path => file(`src/ama/${path}`, 20, 0)).join('');
  assert.deepEqual(await measureV1Growth(diff, 'laceyenterprises/adversarial-review', shipped), []);
  assert.equal(await formatV1GrowthContext({ diff, repo: 'laceyenterprises/adversarial-review',
    title: 'fix: add tests', ratchet: shipped }), '');
});

test('V1RATCHET-01: counts full contents across subsystem boundaries in real Git renames', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'v1-growth-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 });
  const commit = () => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  git('init', '-q');
  mkdirSync(join(cwd, 'src/other'), { recursive: true });
  mkdirSync(join(cwd, 'src/owned'), { recursive: true });
  const source = Array.from({ length: 200 }, (_, i) => `line ${i}\n`).join('');
  writeFileSync(join(cwd, 'src/other/closer.mjs'), source);
  git('add', '.');
  commit();
  renameSync(join(cwd, 'src/other/closer.mjs'), join(cwd, 'src/owned/closer.mjs'));
  git('add', '.');
  const headSha = 'a'.repeat(40);
  const reads = [];
  const options = { headSha, fetchFileAtRefImpl: async (...args) => { reads.push(args); return source; } };
  const into = git('diff', '--cached', '--find-renames', '--no-ext-diff', '--no-textconv');
  assert.match(into, /similarity index 100%/);
  assert.doesNotMatch(into, /^@@/m);
  assert.deepEqual(await measureV1Growth(into, REPO, RATCHET, options), [
    { id: 'unowned-v1', pack: null, added: 0, removed: 200, net: -200 },
    { id: 'owned-v1', pack: 'PAK', added: 200, removed: 0, net: 200 },
  ]);
  assert.deepEqual(reads, [[REPO, 'src/owned/closer.mjs', headSha]]);
  assert.match(await formatV1GrowthContext({ diff: into, repo: REPO, title: 'fix: move closer',
    ratchet: RATCHET, ...options }), /owned-v1 \+200 for PAK.*matching deletion/s);
  commit();
  renameSync(join(cwd, 'src/owned/closer.mjs'), join(cwd, 'src/other/closer.mjs'));
  git('add', '.');
  const out = git('diff', '--cached', '--find-renames', '--no-ext-diff', '--no-textconv');
  assert.match(out, /similarity index 100%/);
  assert.deepEqual(await measureV1Growth(out, REPO, RATCHET, options), [
    { id: 'owned-v1', pack: 'PAK', added: 0, removed: 200, net: -200 },
    { id: 'unowned-v1', pack: null, added: 200, removed: 0, net: 200 },
  ]);
  assert.doesNotMatch(await formatV1GrowthContext({ diff: out, repo: REPO, title: 'fix: move closer',
    ratchet: RATCHET, ...options }), /matching deletion/);
  // Renames with edits must count unchanged lines as well as the hunk delta.
  git('reset', '--soft', 'HEAD^');
  renameSync(join(cwd, 'src/other/closer.mjs'), join(cwd, 'src/owned/closer.mjs'));
  writeFileSync(join(cwd, 'src/owned/closer.mjs'), source + 'new line\n');
  git('add', '.');
  const edited = git('diff', '--cached', '--find-renames', '--no-ext-diff', '--no-textconv');
  assert.match(edited, /^rename from /m);
  assert.deepEqual(await measureV1Growth(edited, REPO, RATCHET, {
    headSha, fetchFileAtRefImpl: async () => source + 'new line\n',
  }), [
    { id: 'unowned-v1', pack: null, added: 0, removed: 200, net: -200 },
    { id: 'owned-v1', pack: 'PAK', added: 201, removed: 0, net: 201 },
  ]);
});

test('V1RATCHET-01: copies count destination contents without subtracting the retained source', async () => {
  const diff = 'diff --git a/src/owned/a.mjs b/src/owned/b.mjs\nsimilarity index 100%\ncopy from src/owned/a.mjs\ncopy to src/owned/b.mjs\n';
  assert.deepEqual(await measureV1Growth(diff, REPO, RATCHET, {
    headSha: 'a'.repeat(40), fetchFileAtRefImpl: async () => 'one\ntwo\n',
  }), [{ id: 'owned-v1', pack: 'PAK', added: 2, removed: 0, net: 2 }]);
});

test('V1RATCHET-01: same-subsystem renames need no reads; test/production moves cross the boundary', async () => {
  const move = (oldPath, newPath) => `diff --git a/${oldPath} b/${newPath}\nsimilarity index 100%\nrename from ${oldPath}\nrename to ${newPath}\n`;
  const options = { headSha: 'a'.repeat(40), fetchFileAtRefImpl: async () => { throw new Error('unexpected read'); } };
  assert.deepEqual(await measureV1Growth(move('src/owned/a.mjs', 'src/owned/b.mjs'), REPO, RATCHET, options),
    [{ id: 'owned-v1', pack: 'PAK', added: 0, removed: 0, net: 0 }]);
  options.fetchFileAtRefImpl = async () => 'one\ntwo'; // No final newline.
  assert.deepEqual(await measureV1Growth(move('src/owned/a.spec.mjs', 'src/owned/a.mjs'), REPO, RATCHET, options),
    [{ id: 'owned-v1', pack: 'PAK', added: 2, removed: 0, net: 2 }]);
  assert.deepEqual(await measureV1Growth(move('src/owned/a.mjs', 'src/owned/a.spec.mjs'), REPO, RATCHET, options),
    [{ id: 'owned-v1', pack: 'PAK', added: 0, removed: 2, net: -2 }]);
  options.fetchFileAtRefImpl = async () => '';
  assert.deepEqual(await measureV1Growth(move('src/other/a.mjs', 'src/owned/a.mjs'), REPO, RATCHET, options),
    [{ id: 'unowned-v1', pack: null, added: 0, removed: 0, net: 0 },
      { id: 'owned-v1', pack: 'PAK', added: 0, removed: 0, net: 0 }]);
});

test('V1RATCHET-01: missing head or unavailable content reports unknown growth without hiding the advisory', async () => {
  const diff = 'diff --git a/src/other/a.mjs b/src/owned/a.mjs\nsimilarity index 100%\nrename from src/other/a.mjs\nrename to src/owned/a.mjs\n';
  for (const options of [
    { fetchFileAtRefImpl: async () => { throw new Error('must not read without a head'); } },
    { headSha: 'a'.repeat(40), fetchFileAtRefImpl: async () => { throw new Error('unavailable'); } },
    { headSha: 'a'.repeat(40), fetchFileAtRefImpl: async () => '\0binary' },
  ]) {
    const context = await formatV1GrowthContext({ diff, repo: REPO, title: 'fix: move closer', ratchet: RATCHET, ...options });
    assert.match(context, /net unknown \(cross-boundary content unavailable\)/);
    assert.match(context, /may grow.*matching deletion/s);
    assert.doesNotMatch(context, /net 0/);
  }
});

test('V1RATCHET-01: prompt move accounting uses the reviewed head in full and slim modes', async () => {
  const diff = 'diff --git a/src/other/a.mjs b/src/owned/a.mjs\nsimilarity index 100%\nrename from src/other/a.mjs\nrename to src/owned/a.mjs\n';
  const headSha = 'a'.repeat(40);
  for (const reviewModeDecision of [null, { slim: true, lowRiskClasses: [], stats: { files: 1, added: 0, removed: 0 } }]) {
    const reads = [];
    const context = await buildReviewerExtraContext({
      repo: REPO, prNumber: 1, diff, reviewedHeadSha: headSha,
      prContext: { title: 'fix: move closer', headRefOid: 'b'.repeat(40), body: '' },
      v1GrowthRatchet: RATCHET, reviewModeDecision, log: null,
      fetchV1GrowthFileAtRefImpl: async (...args) => { reads.push(args); return 'one\ntwo\n'; },
      readFindingDisputeReservationsImpl: () => [], readTenureReviewRangeImpl: () => null,
      fetchLinkedSpecContentsImpl: async () => '', buildHardeningReviewContextImpl: async () => '',
      getConfigImpl: (_key, fallback) => fallback,
    });
    assert.deepEqual(reads, [[REPO, 'src/owned/a.mjs', headSha]]);
    assert.match(context, /owned-v1 \+2 for PAK.*matching deletion/s);
  }
});

test('V1RATCHET-01: only a fix that grows a pack-owned subsystem is asked for the matching deletion', async () => {
  for (const title of [
    '[codex] (fix) X-01: thing',
    'fix: thing',
    '[codex] fix: resolve null pointer in auth middleware (LAC-17)',
    '[claude-code] fix(ama): close lease on error',
    '[clio-agent] hotfix: repair merge',
    '[codex] bugfix(api): repair request',
  ]) assert.equal(isFixTitle(title), true, title);
  for (const title of ['[codex] (feat) X-01: fixture', '[codex] feat: fix auth', '[codex] fixture: update']) {
    assert.equal(isFixTitle(title), false, title);
  }
  const fix = await formatV1GrowthContext({ diff: DIFF, repo: REPO, title: '[codex] (fix) X-01: y', ratchet: RATCHET });
  assert.match(fix, /## V1 growth \(audited, not gated\)/);
  assert.match(fix, /`owned-v1` \(owned by pack PAK\): \+7\/-2, net \+5/);
  assert.match(fix, /`unowned-v1` \(no owning pack\): \+1\/-5, net -4/);
  assert.match(fix, /owned-v1 \+5 for PAK.*matching deletion.*PAK ticket.*never a finding and never a verdict change/s);
  const taggedFix = await formatV1GrowthContext({ diff: DIFF, repo: REPO, title: '[claude-code] fix(ama): close lease on error', ratchet: RATCHET });
  assert.match(taggedFix, /matching deletion/);
  const feat = await formatV1GrowthContext({ diff: DIFF, repo: REPO, title: '(feat) y', ratchet: RATCHET });
  assert.match(feat, /net \+5/);
  assert.doesNotMatch(feat, /matching deletion/);
  const shrink = await formatV1GrowthContext({ diff: file('src/owned/a.mjs', 1, 3), repo: REPO, title: '(fix) y', ratchet: RATCHET });
  assert.doesNotMatch(shrink, /matching deletion/);
  assert.equal(await formatV1GrowthContext({ diff: file('docs/x.md', 3, 0), repo: REPO, title: '(fix) y', ratchet: RATCHET }), '');
});

test('V1RATCHET-01: the reviewer extra context carries the report; shipped config and guidance name it', async () => {
  const context = await buildReviewerExtraContext({ repo: REPO, prNumber: 1, diff: DIFF,
    prContext: { title: '(fix) y', body: '' }, v1GrowthRatchet: RATCHET, log: null,
    readFindingDisputeReservationsImpl: () => [], readTenureReviewRangeImpl: () => null,
    fetchLinkedSpecContentsImpl: async () => '', buildHardeningReviewContextImpl: async () => '',
    getConfigImpl: (_key, fallback) => fallback });
  assert.match(context, /## V1 growth \(audited, not gated\)[\s\S]*matching deletion/);
  const shipped = JSON.parse(readFileSync(join(ROOT, 'domains/code-pr.json'), 'utf8')).v1GrowthRatchet;
  const ama = await measureV1Growth(file('src/ama/closer.mjs', 3, 0), 'laceyenterprises/adversarial-review', shipped);
  assert.deepEqual(ama.map(({ id, pack, net }) => ({ id, pack, net })), [{ id: 'merge-authority-v1', pack: 'MLR', net: 3 }]);
  const guidance = readFileSync(join(ROOT, 'prompts/shared/simplicity-and-cost.md'), 'utf8');
  assert.match(guidance, /`## V1 growth \(audited, not gated\)` section above asks for a matching deletion/);
});
