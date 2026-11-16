import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommitTrailers, parseCommitTrailerValues, hamCommitIdentityMatches } from '../src/ama/ham-provenance.mjs';
import { fetchPrimaryChange, checkPrimaryChange } from '../src/ama/primary-change.mjs';

const commits = JSON.parse(readFileSync(new URL('./fixtures/lac-2202/rebased-commits.json', import.meta.url)));
const message = commits[1].commit.message;

for (const marker of [';', '#']) {
  test(`LAC-2202 recovers Git ${marker} conflict suffix without dropping duplicate claims or citations`, () => {
    const original = message.slice(0, message.indexOf('; Conflicts:')).trimEnd();
    const footer = `\n${marker} Conflicts:\n${marker}\n${marker}\tdocs/guide.md\n`;
    assert.deepEqual(parseCommitTrailerValues(original + footer), parseCommitTrailerValues(original));
    assert.equal(parseCommitTrailerValues(original + footer)['reversal-authorized-by'].length, 3);
    for (const extra of ['Worker-Class: codex', 'Worker-Ticket: OTHER', 'Reviewed-Head: unrelated']) {
      assert.equal(hamCommitIdentityMatches({ ...commits[1],
        commit: { message: original + '\n' + extra + footer } }), false);
    }
  });
  test(`LAC-2202 ignores an earlier ${marker} conflict heading in commit body`, () => {
    const original = message.slice(0, message.indexOf('; Conflicts:')).trimEnd();
    const described = `Repair\n\nEarlier notes quoted this header:\n${marker} Conflicts:\nThe old conflict was resolved.\n\n${original}`;
    const footer = `\n${marker} Conflicts:\n${marker}\tresolved/file.mjs\n`;
    assert.deepEqual(parseCommitTrailerValues(described + footer), parseCommitTrailerValues(original));
  });
}

for (const suffix of ['\nordinary prose', '\n; Conflicts:\n;\n',
  '\n; Conflicts:\n;\tdocs/guide.md\nuntrusted prose',
  '\n; Conflicts:\n#\tdocs/guide.md', '\n; Other:\n;\tdocs/guide.md']) {
  test(`LAC-2202 arbitrary trailing text does not recover provenance: ${JSON.stringify(suffix)}`, () => {
    assert.deepEqual(parseCommitTrailers('Repair\n\nWorker-Class: hammer' + suffix), {});
  });
}

for (const variant of ['preserved', 'reverted', 'untagged', 'malformed-footer']) {
  test(`LAC-2202 real PR 10916 metadata with isolated launch and patches: ${variant}`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'lac-2202-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const repo = 'fixture/repo', prNumber = 10916;
    const builderHead = 'a30457bdc18d16eb2824bda8561f9cc7718fe058';
    const base = commits[0].parents[0].sha, headSha = commits[1].sha;
    const directory = join(rootDir, 'data/follow-up-jobs/ama-closer-dispatches');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'fixture__repo-pr-10916-launch.json'), JSON.stringify({
      repo, prNumber, workerClass: 'hammer', dispatchedAt: '2026-11-16T11:48:24Z',
      targetRemediationSha: builderHead,
    }));
    const current = structuredClone(commits);
    if (variant === 'untagged') current[1].commit.message = 'Unidentified repair';
    if (variant === 'malformed-footer') current[1].commit.message += '\nunknown prose';
    const files = [{ filename: 'docs/guide.md', status: 'added', additions: 1, deletions: 0,
      patch: '@@ -0,0 +1 @@\n+Primary intent' }];
    const get = async path => {
      if (path.endsWith('/reviews?per_page=100')) return [];
      if (path.endsWith(`/pulls/${prNumber}`)) return { head: { sha: headSha }, base: { sha: base } };
      if (path.endsWith(`${base}...${headSha}`)) return { commits: current, total_commits: 2,
        merge_base_commit: { sha: base }, files: variant === 'reverted' ? [] : files };
      if (path.endsWith(`${base}...${commits[0].sha}`)) return { merge_base_commit: { sha: base }, files };
      if (path.endsWith(`/commits/${headSha}`)) return { ...current[1], files: [] };
      throw new Error(`Unexpected fixture read: ${path}`);
    };
    const result = await fetchPrimaryChange({ repo, prNumber, headSha, rootDir, builderHead, get }, {
      fetchCiCostImpl: async () => ({ headSha, ok: true }),
    });
    if (['untagged', 'malformed-footer'].includes(variant)) {
      assert.equal(result.hasHammerCommits, null);
      assert.equal(result.reason, 'untagged hammer launch is outside builder history');
      return;
    }
    assert.equal(result.primaryHead, commits[0].sha);
    assert.equal(result.hasHammerCommits, true);
    assert.equal(result.reversalAuthorizations?.length || 0, 0, 'trailers alone grant no reversal waiver');
    const verdict = checkPrimaryChange(result, headSha);
    assert.equal(verdict.ok, variant === 'preserved');
    if (variant === 'reverted') assert.equal(verdict.reason, 'primary-change-reverted');
  });
}
