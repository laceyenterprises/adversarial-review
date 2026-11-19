import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('V1RATCHET-01: counts net non-test hunk lines per first matching subsystem', () => {
  assert.deepEqual(measureV1Growth(DIFF, REPO, RATCHET), [
    { id: 'owned-v1', pack: 'PAK', added: 7, removed: 2, net: 5 },
    { id: 'unowned-v1', pack: null, added: 1, removed: 5, net: -4 },
  ]);
  assert.deepEqual(measureV1Growth(DIFF, 'synthetic/other', RATCHET), []);
  assert.deepEqual(measureV1Growth(DIFF, REPO, undefined), []);
});

test('V1RATCHET-01: only a fix that grows a pack-owned subsystem is asked for the matching deletion', () => {
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
  const fix = formatV1GrowthContext({ diff: DIFF, repo: REPO, title: '[codex] (fix) X-01: y', ratchet: RATCHET });
  assert.match(fix, /## V1 growth \(audited, not gated\)/);
  assert.match(fix, /`owned-v1` \(owned by pack PAK\): \+7\/-2, net \+5/);
  assert.match(fix, /`unowned-v1` \(no owning pack\): \+1\/-5, net -4/);
  assert.match(fix, /owned-v1 \+5 for PAK.*matching deletion.*PAK ticket.*never a finding and never a verdict change/s);
  const taggedFix = formatV1GrowthContext({ diff: DIFF, repo: REPO, title: '[claude-code] fix(ama): close lease on error', ratchet: RATCHET });
  assert.match(taggedFix, /matching deletion/);
  const feat = formatV1GrowthContext({ diff: DIFF, repo: REPO, title: '(feat) y', ratchet: RATCHET });
  assert.match(feat, /net \+5/);
  assert.doesNotMatch(feat, /matching deletion/);
  const shrink = formatV1GrowthContext({ diff: file('src/owned/a.mjs', 1, 3), repo: REPO, title: '(fix) y', ratchet: RATCHET });
  assert.doesNotMatch(shrink, /matching deletion/);
  assert.equal(formatV1GrowthContext({ diff: file('docs/x.md', 3, 0), repo: REPO, title: '(fix) y', ratchet: RATCHET }), '');
});

test('V1RATCHET-01: the reviewer extra context carries the report; shipped config and guidance name it', async () => {
  const context = await buildReviewerExtraContext({ repo: REPO, prNumber: 1, diff: DIFF,
    prContext: { title: '(fix) y', body: '' }, v1GrowthRatchet: RATCHET, log: null,
    readFindingDisputeReservationsImpl: () => [], readTenureReviewRangeImpl: () => null,
    fetchLinkedSpecContentsImpl: async () => '', buildHardeningReviewContextImpl: async () => '',
    getConfigImpl: (_key, fallback) => fallback });
  assert.match(context, /## V1 growth \(audited, not gated\)[\s\S]*matching deletion/);
  const shipped = JSON.parse(readFileSync(join(ROOT, 'domains/code-pr.json'), 'utf8')).v1GrowthRatchet;
  const ama = measureV1Growth(file('src/ama/closer.mjs', 3, 0), 'laceyenterprises/adversarial-review', shipped);
  assert.deepEqual(ama.map(({ id, pack, net }) => ({ id, pack, net })), [{ id: 'merge-authority-v1', pack: 'MLR', net: 3 }]);
  const guidance = readFileSync(join(ROOT, 'prompts/shared/simplicity-and-cost.md'), 'utf8');
  assert.match(guidance, /`## V1 growth \(audited, not gated\)` section above asks for a matching deletion/);
});
