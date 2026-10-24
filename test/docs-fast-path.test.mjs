import test from 'node:test';
import assert from 'node:assert/strict';
import { isDocsOnlyFiles, readDocsFastPath } from '../src/docs-only.mjs';

test('DOCSFASTPATH-01 classify every old and new path, cache revisions, reclassify moved heads', async () => {
  assert.equal(isDocsOnlyFiles([{ filename: 'docs/guide.md' }, { filename: 'docs/images/flow.svg' }]), true);
  for (const filename of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'SKILL.md', 'prompts/review.md',
    'personas/reader.md', 'identities/reader.md', 'projects/example/prompts/review.md',
    'src/main.mjs', 'config.yaml', 'docs/config.yaml', 'docs/../src/code.md', 'docs/AGENTS.md']) {
    assert.equal(isDocsOnlyFiles([{ filename: 'docs/guide.md' }, { filename }]), false, filename);
    assert.equal(isDocsOnlyFiles([{ filename: 'docs/guide.md', previous_filename: filename }]), false, filename);
  }
  for (const files of [null, [], [{}], Array(300).fill({ filename: 'docs/guide.md' })]) {
    assert.equal(isDocsOnlyFiles(files), false);
  }
  let headSha = 'a'.repeat(40), calls = 0;
  const read = () => readDocsFastPath({ repoPath: 'example/manual', prNumber: 1,
    subject: { headSha, updatedAt: headSha }, execGhWithRetryImpl: async ({ args }) => {
      calls++;
      return { stdout: JSON.stringify(args[1].includes('/compare/')
        ? { files: [{ filename: headSha.startsWith('a') ? 'docs/guide.md' : 'src/main.mjs' }] }
        : { state: 'open', labels: [], head: { sha: headSha }, base: { sha: 'b'.repeat(40), ref: 'main' } }) };
    } });
  assert.equal((await read()).headSha, headSha);
  await read();
  assert.equal(calls, 2);
  headSha = 'c'.repeat(40);
  assert.equal(await read(), null);
  assert.equal(calls, 4);
});
