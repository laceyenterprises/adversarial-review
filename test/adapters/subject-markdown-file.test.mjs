import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createMarkdownFileSubjectAdapter,
  hashMarkdownContent,
  makeSubjectExternalId,
} from '../../src/adapters/subject/markdown-file/index.mjs';

function makeRootDir() {
  return mkdtempSync(path.join(tmpdir(), 'subject-markdown-file-'));
}

test('markdown-file subject adapter discovers and fetches markdown subject content', async () => {
  const rootDir = makeRootDir();
  const subjectPath = path.join(rootDir, 'subject.md');
  const markdown = [
    '# Trial retention finding',
    '',
    'The trial retention cohort improved by 12 percent.',
  ].join('\n');
  writeFileSync(subjectPath, markdown, 'utf8');

  const adapter = createMarkdownFileSubjectAdapter({
    rootDir,
    now: () => new Date('2026-05-11T18:00:00.000Z'),
  });
  assert.deepEqual(Object.keys(adapter).sort(), [
    'discoverSubjects',
    'fetchContent',
    'fetchState',
    'finalizeSubject',
    'isTerminal',
    'prepareRemediationWorkspace',
    'recordRemediationCommit',
  ].sort());

  const refs = await adapter.discoverSubjects();

  assert.deepEqual(refs, [{
    domainId: 'research-finding',
    subjectExternalId: 'subject.md',
    revisionRef: hashMarkdownContent(markdown),
  }]);

  const state = await adapter.fetchState(refs[0]);
  assert.equal(state.ref.domainId, 'research-finding');
  assert.equal(state.title, 'Trial retention finding');
  assert.equal(state.builderClass, 'researcher');
  assert.equal(state.riskClass, 'medium');
  assert.equal(state.terminal, false);
  assert.equal(state.observedAt, '2026-05-11T18:00:00.000Z');

  const content = await adapter.fetchContent(refs[0]);
  assert.equal(content.representation, markdown);
  assert.deepEqual(content.contextFiles, [subjectPath]);
});

test('markdown-file subject adapter prepares workspace and records remediation revision', async () => {
  const rootDir = makeRootDir();
  writeFileSync(path.join(rootDir, 'subject.md'), '# Finding\n\nOriginal.', 'utf8');
  const adapter = createMarkdownFileSubjectAdapter({
    rootDir,
    now: () => new Date('2026-05-11T18:05:00.000Z'),
  });
  const [ref] = await adapter.discoverSubjects();

  const workspace = await adapter.prepareRemediationWorkspace(ref, 'job-1');
  assert.equal(workspace.workspacePath, path.join(rootDir, 'workspaces', 'job-1'));
  assert.ok(workspace.instructions.some((line) => line.includes('subject.md')));

  const recorded = await adapter.recordRemediationCommit(ref, {
    ref,
    commitExternalId: 'commit-1',
    revisionRef: 'sha256:remediated',
    committedAt: '2026-05-11T18:04:00.000Z',
  });

  assert.equal(recorded.ref.revisionRef, 'sha256:remediated');
  assert.equal(recorded.lifecycle, 'awaiting-rereview');
  assert.equal(recorded.completedRemediationRounds, 1);
});

test('markdown-file subject identity stays relative to the fixture root', () => {
  const rootDir = makeRootDir();
  writeFileSync(path.join(rootDir, 'nested.md'), '# Nested\n', 'utf8');

  assert.equal(makeSubjectExternalId(rootDir, 'nested.md'), 'nested.md');
  assert.throws(
    () => makeSubjectExternalId(rootDir, '../escape.md'),
    /escapes rootDir/,
  );
});
