import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkPrimaryChange, describePrimaryChangeRepair, fetchPrimaryChange } from '../src/ama/primary-change.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';

// Patches projected from the three native capture files. The history reader
// below models their read boundary and adds no reversal authority.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/lac-2424-reopened.json', import.meta.url), 'utf8'));
const expectedSpans = {
  11621: [[498, 505]],
  11645: [[32, 48], [1491, 1493]],
  11647: [[127, 167]],
};

function collect(prNumber, evidence, liveHead = evidence.headSha) {
  const repo = 'fixture/repo';
  const { headSha, primaryHead, mergeBase, baseSha, comparisonMergeBase, primaryFiles, finalFiles } = evidence;
  const compare = (from, to) => `repos/${repo}/compare/${from}...${to}`;
  const snapshot = (sha, files) => ({ merge_base_commit: { sha }, files, filesComplete: true, status: 'ahead' });
  const responses = new Map([
    [`repos/${repo}/pulls/${prNumber}`, { head: { sha: liveHead }, base: { sha: baseSha, ref: 'main' } }],
    [compare(baseSha, headSha), { merge_base_commit: { sha: comparisonMergeBase }, total_commits: 1,
      commits: [{ sha: headSha, parents: [{ sha: primaryHead }], commit: { message: 'Close fixture\n\nWorker-Class: hammer' } }] }],
    [compare(baseSha, primaryHead), snapshot(mergeBase, primaryFiles)],
    [compare(mergeBase, comparisonMergeBase), snapshot(mergeBase)],
    [compare(primaryHead, headSha), snapshot(primaryHead)],
    [compare(mergeBase, headSha), snapshot(mergeBase, finalFiles)],
  ]);
  const read = async path => {
    assert.ok(responses.has(path), `unexpected fixture read ${path}`);
    return responses.get(path);
  };
  const get = Object.assign(read, {
    commitHistory: read,
    metadata: read,
    async compareFiles(path, scope) {
      const result = await read(path);
      if (!scope) return result;
      return { ...result, files: result.files.map(file => scope(file.filename) ? file
        : { filename: file.filename, sha: file.sha, status: file.status }) };
    },
  });
  const noProofs = async () => [];
  return fetchPrimaryChange({ repo, prNumber, headSha, get }, {
    fetchCiCostImpl: async () => ({ ok: true, headSha }),
    proveDerivedArtifactsImpl: noProofs,
    proveGeneratedBlocksImpl: noProofs,
    proveLegacyGeneratedPreservationImpl: async () => null,
    proveMigrationRenumbersImpl: noProofs,
    fetchDeadCodeSourcesImpl: noProofs,
  });
}

for (const [pr, { evidence, refusalPath, baseAnchor }] of Object.entries(fixtures)) {
  test(`Agent OS #${pr}: refuse the changed insertion and show its protected head span`, async () => {
    const collected = await collect(pr, evidence);
    assert.equal(collected.mergeBase, evidence.mergeBase, collected.reason);
    assert.equal(collected.comparisonMergeBase, evidence.comparisonMergeBase);
    assert.deepEqual(collected.finalFiles, evidence.finalFiles);
    const result = checkPrimaryChange(collected, evidence.headSha);
    assert.equal(result.reason, 'primary-change-reverted');
    assert.equal(result.path, refusalPath);
    assert.deepEqual(result.missingEvidence.regions, [{ start: baseAnchor, end: baseAnchor }]);
    const paths = describePrimaryChangeRepair(collected, evidence.headSha).paths;
    const expectedPaths = pr === '11645' ? [refusalPath, 'platform/app-contract-endpoint/state-machines.json'] : [refusalPath];
    assert.deepEqual(paths.map(({ path }) => path), expectedPaths);
    for (const [i, [start, end]] of expectedSpans[pr].entries()) {
      assert.equal(paths[i].accepted, 0);
      assert.deepEqual(paths[i].primaryHeadInsertions, {
        headSha: evidence.primaryHead, spans: [{ filename: paths[i].path, start, end }],
      });
      assert.ok(paths[i].summary.includes(`${paths[i].path}:${start}-${end}`));
    }
  });
}

test('missing or truncated patches and a moved live head cannot supply a protected insertion span', async () => {
  const original = fixtures[11645].evidence;
  const moved = await collect(11645, original, original.primaryHead);
  assert.equal(checkPrimaryChange(moved, original.headSha).reason, 'primary-change-read-failed');
  const [file] = original.primaryFiles;
  const truncated = file.patch.replace(/^\+missing_ok = true$/m, '');
  for (const patch of [undefined, truncated]) {
    const evidence = structuredClone(original);
    evidence.primaryFiles[0].patch = patch;
    if (patch === undefined) delete evidence.primaryFiles[0].sha;
    const result = checkPrimaryChange(evidence, evidence.headSha);
    assert.equal(result.reason, 'primary-change-unknown');
    assert.equal(result.missingEvidence, undefined);
  }
});

for (const [filename, lines] of [
  ['src/example.py', ['value = """start', '', 'end"""']],
  ['src/example.mjs', ['const value = `start', '', 'end`;']],
  ['config/example.toml', ['value = """start', '', 'end"""']],
  ['db/example.sql', ['SELECT $body$start', '', 'end$body$;']],
]) {
  test(`${filename}: moving a blank out of a multiline literal still refuses`, () => {
    const head = 'c'.repeat(40);
    const evidence = primaryChangeFixture(head);
    const file = { filename, status: 'modified', deletions: 0 };
    const insertion = lines.map(line => `+${line}`).join('\n');
    evidence.primaryFiles = [{ ...file, additions: 3, patch: `@@ -1 +1,4 @@\n${insertion}\n ` }];
    evidence.finalFiles = [{ ...file, additions: 4, patch: `@@ -1 +1,5 @@\n \n${insertion}\n+` }];
    assert.equal(checkPrimaryChange(evidence, head).ok, true);
    evidence.finalFiles = [{ ...file, additions: 4, patch: `@@ -1 +1,5 @@\n \n+${lines[0]}\n+${lines[2]}\n+\n+` }];
    assert.equal(checkPrimaryChange(evidence, head).reason, 'primary-change-reverted');
  });
}
