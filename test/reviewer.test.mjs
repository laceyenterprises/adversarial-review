import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObviousDocsGuidance, extractLinkedRepoDocs, fetchLinkedSpecContents, parseGitHubBlobPath } from '../src/prompt-context.mjs';
import { resolveBuilderTag } from '../src/reviewer.mjs';

test('parseGitHubBlobPath only accepts blob URLs for the expected repo', () => {
  assert.equal(
    parseGitHubBlobPath('https://github.com/laceyenterprises/adversarial-review/blob/main/SPEC.md', 'laceyenterprises/adversarial-review'),
    'SPEC.md'
  );
  assert.equal(
    parseGitHubBlobPath('https://github.com/other/repo/blob/main/SPEC.md', 'laceyenterprises/adversarial-review'),
    null
  );
  assert.equal(
    parseGitHubBlobPath('https://github.com/laceyenterprises/adversarial-review/pull/6', 'laceyenterprises/adversarial-review'),
    null
  );
});

test('extractLinkedRepoDocs handles local paths and GitHub blob URLs without repo regex interpolation', () => {
  const text = [
    'See docs/ARCHITECTURE.md for context.',
    '(./projects/ROLLUP.md)',
    'Blob: https://github.com/laceyenterprises/adversarial-review/blob/main/tools/PLAYBOOK.md',
    'PR link should be ignored: https://github.com/laceyenterprises/adversarial-review/pull/6',
  ].join('\n');

  assert.deepEqual(extractLinkedRepoDocs(text, 'laceyenterprises/adversarial-review'), [
    'docs/ARCHITECTURE.md',
    'projects/ROLLUP.md',
    'tools/PLAYBOOK.md',
  ]);
});

test('fetchLinkedSpecContents fetches linked specs concurrently and preserves linked order', async () => {
  const starts = [];
  let inflight = 0;
  let maxInflight = 0;

  const result = await fetchLinkedSpecContents('laceyenterprises/adversarial-review', 6, {
    fetchPRContextImpl: async () => ({
      body: [
        'docs/ARCHITECTURE.md',
        'https://github.com/laceyenterprises/adversarial-review/blob/main/tools/PLAYBOOK.md',
      ].join('\n'),
      comments: [],
      headRefOid: 'abc123',
    }),
    execFileImpl: async (_command, args) => {
      const relPath = args[1].match(/contents\/(.+)\?ref=/)[1];
      starts.push(relPath);
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, relPath.includes('ARCHITECTURE') ? 20 : 5));
      inflight -= 1;
      return { stdout: Buffer.from(`# ${relPath}\n`).toString('base64'), stderr: '' };
    },
  });

  assert.equal(maxInflight, 2);
  assert.deepEqual(starts, ['docs/ARCHITECTURE.md', 'tools/PLAYBOOK.md']);
  assert.match(result, /### docs\/ARCHITECTURE.md/);
  assert.match(result, /### tools\/PLAYBOOK.md/);
});

test('buildObviousDocsGuidance tells workers to inspect obvious repo docs before guessing', () => {
  const guidance = buildObviousDocsGuidance();
  assert.match(guidance, /README\.md/);
  assert.match(guidance, /SPEC\.md/);
  assert.match(guidance, /go read it directly rather than guessing from the diff alone/i);
});

test('resolveBuilderTag prefers an explicitly provided builderTag', async () => {
  const builderTag = await resolveBuilderTag({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    builderTag: 'claude-code',
    fetchPRContextImpl: async () => {
      throw new Error('should not fetch when builderTag already exists');
    },
  });

  assert.equal(builderTag, 'claude-code');
});

test('resolveBuilderTag derives the builderTag from the live PR title when omitted', async () => {
  const builderTag = await resolveBuilderTag({
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 17,
    fetchPRContextImpl: async () => ({
      title: '[codex] tighten remediation routing',
    }),
  });

  assert.equal(builderTag, 'codex');
});

test('resolveBuilderTag fails when the live PR title is not canonically tagged', async () => {
  await assert.rejects(
    () => resolveBuilderTag({
      repo: 'laceyenterprises/adversarial-review',
      prNumber: 17,
      fetchPRContextImpl: async () => ({
        title: 'tighten remediation routing',
      }),
    }),
    /Cannot derive builderTag/
  );
});
