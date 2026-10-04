// PARSEBOLD-01: a review card whose field text sits in nested bullets under an
// empty `- **Problem:**` label must still parse as its own card. agent-os#7334's
// final review wrote one card that way; the identity parser folded it into the
// previous card, named 4 of the 5 findings the counter saw, and the AMA
// predicate failed closed on a fully remediated PR.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  extractNonBlockingFindingIdentities,
  parseBlockingFindingsSection,
  parseNonBlockingFindingsSection,
} from '../src/kernel/remediation-reply.mjs';
import { classifyNonBlockingFindings } from '../src/merge-agent-review-classification.mjs';

const PR_7334_REVIEW = readFileSync(
  new URL('./fixtures/review-bodies/pr-7334-nested-problem-bullets.md', import.meta.url),
  'utf8',
);

test('agent-os#7334 final review parses to 5 named non-blocking findings', () => {
  assert.deepEqual(extractNonBlockingFindingIdentities(PR_7334_REVIEW), [
    'fail-open when session_ledger is not importable',
    'private cross-package import fails silent in production',
    'node op shim still writes the live ledger from tests',
    'scratch dir leaks and shared-tmp predictability',
    'subprocess cleanup test hides child diagnostics',
  ]);
});

test('agent-os#7334: the identity parser names as many findings as the counter counts', () => {
  const counted = classifyNonBlockingFindings(PR_7334_REVIEW, { lastVerdict: 'Comment only' });
  assert.deepEqual(counted, { count: 5, state: 'known' });
  assert.equal(extractNonBlockingFindingIdentities(PR_7334_REVIEW).length, counted.count);
});

test('agent-os#7334: the nested-bullet card keeps its own fields and the previous card keeps its own', () => {
  const findings = parseNonBlockingFindingsSection(PR_7334_REVIEW);
  const scratch = findings.find((finding) => finding.title === 'Scratch dir leaks and shared-tmp predictability');
  assert.ok(scratch, 'the nested-bullet card must be its own finding');
  assert.equal(scratch.file, '`modules/worker-pool/lib/python/cwp_dispatch/op_adapter.py`');
  assert.equal(scratch.lines, '`656-669`');
  assert.match(scratch.problem, /^- Cleanup runs only through `atexit`\./);
  assert.match(scratch.problem, /The path is predictable and keyed on pid\./);
  assert.match(scratch.problem, /can depend on test order when a test doesn't set `OP_SHIM_DB_PATH`\.$/);
  assert.match(scratch.whyItMatters, /^This is low-severity accumulation/);

  const nodeShim = findings.find((finding) => finding.title === 'Node op shim still writes the live ledger from tests');
  assert.equal(nodeShim.file, '`scripts/lib/op-rate-limit-shim.mjs`');
  assert.equal(nodeShim.lines, '`340-378, 470`');
});

function reviewWithBlocking(blockingLines) {
  return [
    '## Summary',
    'Review.',
    '',
    '## Blocking issues',
    ...blockingLines,
    '',
    '## Non-blocking issues',
    '- None.',
    '',
    '## Verdict',
    'Request changes',
  ].join('\n');
}

test('an empty label takes the more-indented bullets under it, in blocking sections too', () => {
  const findings = parseBlockingFindingsSection(reviewWithBlocking([
    '- **First finding**',
    '  - **File:** `a.mjs`',
    '  - **Lines:** `1-2`',
    '  - **Problem:** First problem.',
    '- **Second finding**',
    '  - **File:** `b.mjs`',
    '  - **Lines:** `3-4`',
    '  - **Problem:**',
    '    - Part one.',
    '',
    '    1. Part two.',
    '  - **Why it matters:** It matters.',
  ]));
  assert.deepEqual(findings.map((finding) => finding.title), ['First finding', 'Second finding']);
  assert.equal(findings[1].problem, '- Part one.\n\n1. Part two.');
  assert.equal(findings[1].whyItMatters, 'It matters.');
});

test('nested value lines are consumed, so a nested `File:` bullet cannot split the card', () => {
  const findings = parseBlockingFindingsSection(reviewWithBlocking([
    '- **Only finding**',
    '  - **File:** `a.mjs`',
    '  - **Lines:** `1`',
    '  - **Problem:**',
    '    - File: handles leak when the child exits early.',
  ]));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, '`a.mjs`');
  assert.equal(findings[0].problem, '- File: handles leak when the child exits early.');
});

test('an empty label with nothing nested under it still fails closed', () => {
  const findings = parseBlockingFindingsSection(reviewWithBlocking([
    '- **First finding**',
    '  - **File:** `a.mjs`',
    '  - **Lines:** `1-2`',
    '  - **Problem:** First problem.',
    '- **Second finding**',
    '  - **File:** `b.mjs`',
    '  - **Lines:** `3-4`',
    '  - **Problem:**',
    '  - **Why it matters:** Same-depth text is not nested text.',
  ]));
  // Unchanged behavior: the card without a Problem is not a card boundary.
  assert.deepEqual(findings.map((finding) => finding.title), ['First finding']);
});

test('next-line markdown keeps code fences and paragraph breaks', () => {
  const [finding] = parseBlockingFindingsSection(reviewWithBlocking([
    '- **Markdown finding**', '  - **File:** a.mjs', '  - **Lines:** 1',
    '  - **Problem:**', '    First paragraph.', '', '    ```js',
    '    run();', '    ```', '', '    Last paragraph.',
  ]));
  assert.equal(finding.problem, 'First paragraph.\n\n```js\nrun();\n```\n\nLast paragraph.');
});
