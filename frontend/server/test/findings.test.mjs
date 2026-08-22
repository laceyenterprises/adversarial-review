import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extractSection, parseFindings } from '../src/store/findings.mjs';

describe('parseFindings', () => {
  it('reports unknown, not zero, when the sections are absent', () => {
    const parsed = parseFindings('Looks good.');
    assert.equal(parsed.blockingSectionMissing, true);
    assert.equal(parsed.nonBlockingSectionMissing, true);
    assert.deepEqual(parsed.findings, []);
  });

  it('treats a null or empty body as an off-template body', () => {
    for (const body of [null, undefined, '']) {
      const parsed = parseFindings(body);
      assert.equal(parsed.blockingSectionMissing, true);
      assert.deepEqual(parsed.findings, []);
    }
  });

  it('reads "- None." as an explicit zero', () => {
    const parsed = parseFindings('## Blocking issues\n\n- None.\n\n## Non-blocking issues\n\n- None.\n');
    assert.equal(parsed.blockingSectionMissing, false);
    assert.equal(parsed.blockingCount, 0);
    assert.equal(parsed.nonBlockingCount, 0);
  });

  it('does not let a heading inside a fenced block open a section', () => {
    const body = [
      '## Summary',
      '',
      '```md',
      '## Blocking issues',
      '- **Not a real finding**',
      '```',
      '',
      '## Blocking issues',
      '',
      '- **A real finding**',
      '  - **Category:** correctness',
      '',
    ].join('\n');
    const parsed = parseFindings(body);
    assert.equal(parsed.blockingCount, 1);
    assert.equal(parsed.findings[0].title, 'A real finding');
  });

  it('stops a section at the next heading', () => {
    const body = [
      '## Blocking issues',
      '',
      '- **Only this one**',
      '',
      '## Notes',
      '',
      '- **Not a finding**',
      '',
    ].join('\n');
    assert.equal(parseFindings(body).blockingCount, 1);
  });

  it('keeps blocking findings ahead of non-blocking ones and tags each kind', () => {
    const body = [
      '## Blocking issues',
      '',
      '- **B1**',
      '- **B2**',
      '',
      '## Non-blocking issues',
      '',
      '- **N1**',
      '',
    ].join('\n');
    const parsed = parseFindings(body);
    assert.deepEqual(parsed.findings.map((finding) => [finding.title, finding.kind]), [
      ['B1', 'blocking'],
      ['B2', 'blocking'],
      ['N1', 'non-blocking'],
    ]);
  });

  it('counts unstructured prose as one finding rather than silently zero', () => {
    const parsed = parseFindings('## Blocking issues\n\nThe auth check is missing.\n');
    assert.equal(parsed.blockingCount, 1);
    assert.equal(parsed.findings[0].title, null);
  });

  it('lowercases the category and leaves absent fields null', () => {
    const body = '## Blocking issues\n\n- **T**\n  - **Category:** Correctness\n';
    const [finding] = parseFindings(body).findings;
    assert.equal(finding.category, 'correctness');
    assert.equal(finding.file, null);
    assert.equal(finding.recommendedFix, null);
  });
});

describe('extractSection', () => {
  it('returns null for a heading that is not present', () => {
    assert.equal(extractSection('## Other\n\ntext\n', 'Blocking issues'), null);
  });

  it('matches the heading case-insensitively', () => {
    assert.notEqual(extractSection('## BLOCKING ISSUES\n\n- None.\n', 'Blocking issues'), null);
  });
});
