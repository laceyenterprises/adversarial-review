import test from 'node:test';
import assert from 'node:assert/strict';
import { isDocsOnlyFiles, readDocsFastPath } from '../src/docs-only.mjs';

const report = { filename: 'docs/postmortems/report.md' };
const evidenceFiles = ['json', 'txt', 'diff', 'yaml'].map(extension => ({
  filename: `docs/postmortems/evidence/x/capture.${extension}`,
}));

test('report and inert evidence captures qualify for the docs fast path', async () => {
  const files = [report, ...evidenceFiles];
  assert.equal(isDocsOnlyFiles(files), true);
  const subject = { headSha: '1'.repeat(40), baseSha: '2'.repeat(40), baseRefName: 'main' };
  assert.deepEqual(await readDocsFastPath({ repoPath: 'example/evidence', prNumber: 1, subject,
    execGhWithRetryImpl: async () => ({ stdout: JSON.stringify({ files }) }),
  }), { headSha: subject.headSha, baseSha: subject.baseSha, baseBranch: 'main' });
});

test('all inert evidence extensions qualify at any depth only under the evidence directory', () => {
  for (const extension of ['json', 'txt', 'yaml', 'yml', 'diff', 'patch', 'log', 'csv']) {
    for (const directory of ['docs/postmortems/evidence', 'docs/postmortems/evidence/x/nested']) {
      for (const suffix of [extension, extension.toUpperCase()]) {
        const filename = `${directory}/capture.${suffix}`;
        assert.equal(isDocsOnlyFiles([report, { filename }]), true, filename);
      }
    }
    for (const directory of ['docs/other', 'docs/postmortems', 'docs/postmortems/evidence-other',
      'other/docs/postmortems/evidence']) {
      const filename = `${directory}/capture.${extension}`;
      assert.equal(isDocsOnlyFiles([report, { filename }]), false, filename);
    }
  }
});

test('evidence does not authorize executable files, other paths or excluded segments', () => {
  for (const filename of [
    'docs/postmortems/evidence/x/capture.sh',
    'docs/postmortems/evidence/x/capture.mjs',
    'docs/postmortems/evidence/x/capture.py',
    'docs/postmortems/evidence/x/capture.json.sh',
    'docs/postmortems/evidence/x/capture',
    'docs/postmortems/evidence/x/AGENTS.md',
    'docs/postmortems/evidence/x/CLAUDE.md',
    'docs/postmortems/evidence/x/SKILL.md',
    'docs/postmortems/evidence/./capture.json',
    'docs/postmortems/evidence/x/../capture.json',
    'docs/postmortems/evidence/Prompts/capture.json',
    'docs/postmortems/evidence/x/PERSONAS/capture.txt',
    'docs/postmortems/evidence/x/Identities/capture.yaml',
    'src/main.mjs',
  ]) assert.equal(isDocsOnlyFiles([report, ...evidenceFiles, { filename }]), false, filename);
});

test('evidence renames require eligible old and new paths', () => {
  const filename = 'docs/postmortems/evidence/x/capture.json';
  for (const previous_filename of ['src/capture.json', 'docs/other/capture.json',
    'docs/postmortems/evidence/x/capture.sh', undefined]) {
    assert.equal(isDocsOnlyFiles([report, { filename, previous_filename, status: 'renamed' }]), false);
  }
  const previous_filename = 'docs/postmortems/evidence/x/old.json';
  assert.equal(isDocsOnlyFiles([report, { filename, previous_filename, status: 'renamed' }]), true);
  assert.equal(isDocsOnlyFiles([report, { filename: 'docs/other/capture.json',
    previous_filename, status: 'renamed' }]), false);
  assert.equal(isDocsOnlyFiles([report, { filename, previous_filename: 'src/capture.json' }]), false);
});

test('evidence inventories retain the existing file-count cap', () => {
  assert.equal(isDocsOnlyFiles(Array(299).fill(evidenceFiles[0])), true);
  assert.equal(isDocsOnlyFiles(Array(300).fill(evidenceFiles[0])), false);
});
