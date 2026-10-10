import test from 'node:test';
import assert from 'node:assert/strict';

import { HEAD_GROUNDING_TAG, groundBlockingFindingsAtHead, persistReviewGroundingMetadata } from '../src/review-head-grounding.mjs';
import { fetchCompareOwnDiff, resolvePrOwnReviewDiff } from '../src/reviewer-own-diff.mjs';
import { annotateRemovedDiffLines, CHUNK_HEAD_LEGEND } from '../src/reviewer-chunk-context.mjs';
import { __test__ as harness, reviewAgyOversizedInChunks } from '../src/reviewer-harness.mjs';
import { buildPromptForReviewerModel } from '../src/reviewer-prompt.mjs';
import { extractReviewVerdict } from '../src/kernel/verdict.mjs';
import { parseBlockingFindingsSection, parseNonBlockingFindingsSection } from '../src/kernel/review-findings.mjs';
import { parseDiffFiles } from '../src/reviewer-util.mjs';

const { agyPromptBytes } = harness;
const HEAD_SHA = 'f079a3b'.padEnd(40, '0');
const PARSER_PATH = 'tools/heading_parser.py';

// The agent-os PR 7981 shape: the head already uses a prefix-aware heading
// match and a level-aware section end; the removed side had the strict
// equality check and the next-heading-regardless-of-level end.
const PARSER_HEAD = [
  'import re',
  '',
  'HEADING_RE = re.compile(r"^(?P<hashes>#+)\\s+(?P<title>.+)$", re.MULTILINE)',
  '',
  'def _section_text(markdown, targets):',
  '    normalized_targets = [normalize(t) for t in targets]',
  '    matches = list(HEADING_RE.finditer(markdown))',
  '    for index, match in enumerate(matches):',
  '        normalized_heading = normalize(match.group("title"))',
  '        if any(normalized_heading == target or normalized_heading.startswith(f"{target} ") for target in normalized_targets):',
  '            level = len(match.group("hashes"))',
  '            end = _next_heading_at_or_above(matches, index, level, len(markdown))',
  '            return markdown[match.end():end]',
  '    return ""',
  '',
].join('\n');

const PARSER_DIFF = [
  `diff --git a/${PARSER_PATH} b/${PARSER_PATH}`,
  `--- a/${PARSER_PATH}`,
  `+++ b/${PARSER_PATH}`,
  '@@ -5,9 +5,10 @@ HEADING_RE = re.compile(r"^(?P<hashes>#+)\\s+(?P<title>.+)$", re.MULTILINE)',
  ' def _section_text(markdown, targets):',
  '     normalized_targets = [normalize(t) for t in targets]',
  '     matches = list(HEADING_RE.finditer(markdown))',
  '     for index, match in enumerate(matches):',
  '         normalized_heading = normalize(match.group("title"))',
  '-        if normalized_heading in normalized_targets:',
  '-            end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)',
  '+        if any(normalized_heading == target or normalized_heading.startswith(f"{target} ") for target in normalized_targets):',
  '+            level = len(match.group("hashes"))',
  '+            end = _next_heading_at_or_above(matches, index, level, len(markdown))',
  '             return markdown[match.end():end]',
  '     return ""',
  '',
].join('\n');

const REMOVED_SIDE_CARDS = [
  '- **Strict heading equality rejects suffixed headings**',
  `  - **File:** \`${PARSER_PATH}\``,
  '  - **Lines:** `851-852`',
  '  - **Problem:** `_section_text` matches with `normalized_heading in normalized_targets`, so a heading such as "Acceptance criteria (draft)" never matches.',
  '  - **Why it matters:** Suffixed headings are silently dropped.',
  '  - **Recommended fix:** Match on `normalized_heading.startswith(f"{target} ")` as well.',
  '- **Section truncates at the next heading of any level**',
  `  - **File:** \`${PARSER_PATH}\``,
  '  - **Lines:** `853`',
  '  - **Problem:** `end = matches[index + 1].start()` cuts the section at the next heading regardless of its level.',
  '  - **Why it matters:** Nested subsections are lost.',
  '  - **Recommended fix:** End the section at the next heading at or above its level.',
].join('\n');

const HEAD_CARD = [
  '- **Return value drops the trailing section newline**',
  `  - **File:** \`${PARSER_PATH}\``,
  '  - **Lines:** `13`',
  '  - **Problem:** `return markdown[match.end():end]` keeps the heading line terminator but strips nothing else.',
  '  - **Why it matters:** Downstream comparison is whitespace-sensitive.',
  '  - **Recommended fix:** Strip the returned slice.',
].join('\n');

function review(blocking, verdict = 'Request changes') {
  return [
    '## Summary',
    'Reviewed the parser change.',
    '',
    '## Blocking issues',
    blocking,
    '',
    '## Non-blocking issues',
    '- None.',
    '',
    '## Suggested fixes',
    '- None.',
    '',
    '## Verdict',
    verdict,
  ].join('\n');
}

const headFiles = { [PARSER_PATH]: PARSER_HEAD };
const fetchHead = async (repo, path, ref) => {
  assert.equal(repo, 'laceyenterprises/agent-os');
  assert.equal(ref, HEAD_SHA);
  if (Object.hasOwn(headFiles, path)) return headFiles[path];
  const error = new Error(`gh: Not Found (HTTP 404) ${path}`);
  error.stderr = 'HTTP 404';
  throw error;
};
const quietLog = { warn() {}, error() {} };

function blockingTitles(text) {
  return parseBlockingFindingsSection(text).map((finding) => finding.title);
}

test('REVIEWCHUNK-01: a chunked review that blocks on removed lines is demoted and does not request changes', async () => {
  // A second file large enough that the review must chunk.
  const fillerLines = Array.from({ length: 120 }, (_, index) => `+Release note line ${index}: ${'detail '.repeat(6)}`);
  const fillerDiff = [
    'diff --git a/docs/NOTES.md b/docs/NOTES.md',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/docs/NOTES.md',
    `@@ -0,0 +1,${fillerLines.length} @@`,
    ...fillerLines,
    '',
  ].join('\n');
  const diff = `${PARSER_DIFF}${fillerDiff}`;
  const overhead = agyPromptBytes(buildPromptForReviewerModel('gemini', '', '', { runtime: 'antigravity' }));
  const maxBytes = overhead + 6500;
  assert.ok(agyPromptBytes(buildPromptForReviewerModel('gemini', diff, '', { runtime: 'antigravity' })) > maxBytes);

  const prompts = [];
  const chunked = await reviewAgyOversizedInChunks(diff, '', {
    env: {},
    maxBytes,
    reviewWithGeminiImpl: async (chunkDiff, chunkContext) => {
      prompts.push({ chunkDiff, chunkContext });
      assert.ok(agyPromptBytes(buildPromptForReviewerModel('gemini', chunkDiff, chunkContext, { runtime: 'antigravity' })) <= maxBytes);
      return {
        reviewText: chunkDiff.includes(PARSER_PATH)
          ? review(REMOVED_SIDE_CARDS)
          : review('- None.', 'Comment only'),
      };
    },
  });
  assert.ok(prompts.length >= 2, 'the diff must review in more than one chunk');
  const parserPrompt = prompts.find((entry) => entry.chunkDiff.includes(PARSER_PATH));
  assert.match(parserPrompt.chunkDiff, /^-\[REMOVED\] {9}if normalized_heading in normalized_targets:$/m);
  assert.match(parserPrompt.chunkDiff, /^\+ {8}if any\(normalized_heading == target/m);
  for (const entry of prompts) assert.ok(entry.chunkContext.includes(CHUNK_HEAD_LEGEND));
  assert.match(CHUNK_HEAD_LEGEND, /must be about code present at the PR head/);
  // Without grounding the merged chunk review blocks on both removed-side findings.
  assert.equal(extractReviewVerdict(chunked.reviewText), 'Request changes');
  assert.equal(parseBlockingFindingsSection(chunked.reviewText).length, 2);

  const grounded = await groundBlockingFindingsAtHead(chunked.reviewText, {
    repo: 'laceyenterprises/agent-os', headSha: HEAD_SHA, diff, fetchFileAtRefImpl: fetchHead, log: quietLog,
  });
  assert.deepEqual(blockingTitles(grounded.reviewText), []);
  assert.equal(extractReviewVerdict(grounded.reviewText), 'Comment only');
  const nonBlocking = parseNonBlockingFindingsSection(grounded.reviewText).map((finding) => finding.title);
  assert.deepEqual(nonBlocking, [
    `Strict heading equality rejects suffixed headings — ${HEAD_GROUNDING_TAG}`,
    `Section truncates at the next heading of any level — ${HEAD_GROUNDING_TAG}`,
  ]);
  assert.deepEqual(grounded.grounding.demoted.map((entry) => entry.reason), ['removed-side', 'removed-side']);
  assert.equal(grounded.grounding.checked, 2);
  assert.equal(grounded.grounding.verdictRewritten, true);
  assert.match(grounded.reviewText, /Head grounding:\*\* unverified at head \(quoted code absent\)/);
});

test('REVIEWCHUNK-01: a finding that quotes head code stays blocking alongside a demoted one', async () => {
  const text = review(`${REMOVED_SIDE_CARDS}\n${HEAD_CARD}`);
  const grounded = await groundBlockingFindingsAtHead(text, {
    repo: 'laceyenterprises/agent-os', headSha: HEAD_SHA, diff: PARSER_DIFF, fetchFileAtRefImpl: fetchHead, log: quietLog,
  });
  assert.deepEqual(blockingTitles(grounded.reviewText), ['Return value drops the trailing section newline']);
  assert.equal(extractReviewVerdict(grounded.reviewText), 'Request changes');
  assert.equal(parseNonBlockingFindingsSection(grounded.reviewText).length, 2);
  assert.equal(grounded.grounding.kept, 1);
});

test('REVIEWCHUNK-01: head grounding never suppresses a finding whose quote is present or unverifiable', async () => {
  const base = { repo: 'laceyenterprises/agent-os', headSha: HEAD_SHA, diff: PARSER_DIFF, log: quietLog };
  const onlyHead = review(HEAD_CARD);
  const kept = await groundBlockingFindingsAtHead(onlyHead, { ...base, fetchFileAtRefImpl: fetchHead });
  assert.equal(kept.reviewText, onlyHead);

  // A card mixing a removed-side quote with a head quote stays blocking.
  const mixed = review(HEAD_CARD.replace('`return markdown[match.end():end]`',
    '`return markdown[match.end():end]` after `normalized_heading in normalized_targets`'));
  assert.equal((await groundBlockingFindingsAtHead(mixed, { ...base, fetchFileAtRefImpl: fetchHead })).reviewText, mixed);

  // Whitespace and line-wrapping differences still count as present.
  const rewrapped = review(HEAD_CARD.replace('`return markdown[match.end():end]`', '`return   markdown[match.end():end]`'));
  assert.equal((await groundBlockingFindingsAtHead(rewrapped, { ...base, fetchFileAtRefImpl: fetchHead })).reviewText, rewrapped);

  // Fetch failures, a 404 for a file the diff does not delete, and missing
  // input all keep the review byte-identical.
  const removedOnly = review(REMOVED_SIDE_CARDS);
  for (const fetchFileAtRefImpl of [
    async () => { throw new Error('HTTP 502 Bad Gateway'); },
    async () => { const error = new Error('Not Found'); error.stderr = 'HTTP 404'; throw error; },
  ]) {
    const result = await groundBlockingFindingsAtHead(removedOnly, { ...base, fetchFileAtRefImpl });
    assert.equal(result.reviewText, removedOnly);
    assert.equal(result.grounding.demoted.length, 0);
  }
  assert.equal((await groundBlockingFindingsAtHead(removedOnly, { ...base, headSha: null, fetchFileAtRefImpl: fetchHead })).reviewText, removedOnly);

  // Identifier-only mentions are not quotes and never trigger a demotion.
  const mentionOnly = review([
    '- **Parser lacks a level guard**',
    `  - **File:** \`${PARSER_PATH}\``,
    '  - **Problem:** `_section_text` has no guard for `targets` being empty.',
    '  - **Why it matters:** Empty input.',
    '  - **Recommended fix:** Guard it.',
  ].join('\n'));
  assert.equal((await groundBlockingFindingsAtHead(mentionOnly, { ...base, fetchFileAtRefImpl: fetchHead })).reviewText, mentionOnly);

  // An unexpected internal failure fails open to the original text.
  const throwing = await groundBlockingFindingsAtHead(removedOnly, { ...base, fetchFileAtRefImpl: fetchHead, diff: { toString() { throw new Error('boom'); } } });
  assert.equal(throwing.reviewText, removedOnly);
});

test('REVIEWCHUNK-01: quotes absent at head and line citations past the head file are demoted', async () => {
  const base = { repo: 'laceyenterprises/agent-os', headSha: HEAD_SHA, diff: PARSER_DIFF, log: quietLog, fetchFileAtRefImpl: fetchHead };
  const absent = review([
    '- **Retry loop never backs off**',
    `  - **File:** \`${PARSER_PATH}\``,
    '  - **Problem:** `while attempts < max_attempts: retry()` spins without sleeping.',
    '  - **Why it matters:** Busy loop.',
    '  - **Recommended fix:** Back off.',
  ].join('\n'));
  const absentResult = await groundBlockingFindingsAtHead(absent, base);
  assert.deepEqual(absentResult.grounding.demoted.map((entry) => entry.reason), ['absent']);
  assert.equal(extractReviewVerdict(absentResult.reviewText), 'Comment only');

  const linesOnly = review([
    '- **Off-by-one in the section end**',
    `  - **File:** \`${PARSER_PATH}\``,
    '  - **Lines:** `851-853`',
    '  - **Problem:** The section end is computed one heading too early.',
    '  - **Why it matters:** Lost content.',
    '  - **Recommended fix:** Use the level-aware end.',
  ].join('\n'));
  const linesResult = await groundBlockingFindingsAtHead(linesOnly, base);
  assert.deepEqual(linesResult.grounding.demoted.map((entry) => entry.reason), ['lines-beyond-head']);
  const inRange = linesOnly.replace('`851-853`', '`10-12`');
  assert.equal((await groundBlockingFindingsAtHead(inRange, base)).reviewText, inRange);
});

test('REVIEWCHUNK-01: H3-shaped cards are grounded without splitting on their field bullets', async () => {
  const text = [
    '## Blocking issues',
    '### Strict heading equality rejects suffixed headings',
    `- **File:** \`${PARSER_PATH}\``,
    '- **Problem:** `normalized_heading in normalized_targets` is a strict check.',
    '- **Why it matters:** Suffixed headings fail.',
    '',
    '## Verdict',
    'Request changes',
  ].join('\n');
  const grounded = await groundBlockingFindingsAtHead(text, {
    repo: 'laceyenterprises/agent-os', headSha: HEAD_SHA, diff: PARSER_DIFF, fetchFileAtRefImpl: fetchHead, log: quietLog,
  });
  assert.deepEqual(blockingTitles(grounded.reviewText), []);
  assert.match(grounded.reviewText, /## Non-blocking issues\n\n### Strict heading equality rejects suffixed headings — unverified at head/);
  assert.equal(extractReviewVerdict(grounded.reviewText), 'Comment only');
});

function fileDiff(path, body = '+x') {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}\n`;
}

test('REVIEWCHUNK-01: a stale stored base no longer inflates the review diff past the PR\'s own files', async () => {
  const ownFiles = ['tools/heading_parser.py', 'tools/test_heading_parser.py'];
  const mainFiles = ['src/unrelated-main-change.mjs', 'docs/main-only.md', '.github/workflows/main.yml'];
  const prDiff = [...ownFiles, ...mainFiles].map((path) => fileDiff(path)).join('');
  const compareDiff = ownFiles.map((path) => fileDiff(path)).join('');
  const calls = [];
  const execGhWithRetryImpl = async ({ args }) => {
    calls.push(args);
    if (args.includes('--jq')) return { stdout: `${'9a96e5a'.padEnd(40, '1')}\n` };
    return { stdout: Buffer.from(compareDiff) };
  };
  const result = await resolvePrOwnReviewDiff({
    repo: 'laceyenterprises/agent-os', prNumber: 7981, headSha: HEAD_SHA, baseRef: 'main', prDiff,
    fetchCompareOwnDiffImpl: (repo, baseRef, headSha) => fetchCompareOwnDiff(repo, baseRef, headSha, { execGhWithRetryImpl }),
    log: quietLog,
  });
  assert.deepEqual(parseDiffFiles(result.diff).map((file) => file.path), ownFiles);
  assert.equal(result.diff, compareDiff);
  assert.deepEqual(result.scope, {
    source: 'merge-base-compare', baseRef: 'main', mergeBaseSha: '9a96e5a'.padEnd(40, '1'),
    prDiffFileCount: 5, ownDiffFileCount: 2,
  });
  assert.deepEqual(calls[0], ['api', '-H', 'Accept: application/vnd.github.diff', `repos/laceyenterprises/agent-os/compare/main...${HEAD_SHA}`]);
});

test('REVIEWCHUNK-01: the own-diff resolution fails open to the PR diff', async () => {
  const prDiff = fileDiff('a.mjs') + fileDiff('b.mjs');
  const base = { repo: 'o/r', prNumber: 1, headSha: HEAD_SHA, baseRef: 'main', prDiff, log: quietLog };
  const cases = [
    [{ baseRef: '' }, 'missing-base-ref-or-head', () => assert.fail('must not fetch')],
    [{}, 'compare-failed', async () => { throw new Error('HTTP 406 diff too large'); }],
    [{}, 'own-diff-empty', async () => ({ diff: '', mergeBaseSha: null })],
    [{}, 'file-sets-agree', async () => ({ diff: fileDiff('b.mjs') + fileDiff('a.mjs'), mergeBaseSha: null })],
    [{}, 'own-diff-not-subset', async () => ({ diff: fileDiff('a.mjs') + fileDiff('c.mjs'), mergeBaseSha: null })],
  ];
  for (const [overrides, reason, fetchCompareOwnDiffImpl] of cases) {
    const result = await resolvePrOwnReviewDiff({ ...base, ...overrides, fetchCompareOwnDiffImpl });
    assert.equal(result.diff, prDiff, reason);
    assert.equal(result.scope.source, 'pr-diff');
    assert.equal(result.scope.reason, reason);
  }
});

test('REVIEWCHUNK-01: review metadata records the grounding outcome and both diff file counts', () => {
  const writes = [];
  const args = { rootDir: '/nonexistent', repo: 'o/r', prNumber: 7, reviewDbAttemptNumber: 3, reviewAttemptNumber: 9,
    reviewerClass: 'gemini', passKind: 'review', headSha: HEAD_SHA, execution: { model: 'gemini-3-pro', effort: 'high' },
    beginReviewerPassImpl: (rootDir, row) => writes.push(row), log: quietLog };
  const scope = { source: 'merge-base-compare', baseRef: 'main', mergeBaseSha: null, prDiffFileCount: 68, ownDiffFileCount: 33 };
  const headGrounding = { headSha: HEAD_SHA, checked: 2, kept: 0, demoted: [{ title: 't', reason: 'removed-side' }] };
  assert.equal(persistReviewGroundingMetadata({ ...args, headGrounding, reviewDiffScope: scope }), true);
  assert.equal(writes[0].attemptNumber, 3);
  assert.equal(writes[0].reviewerModel, 'gemini-3-pro');
  assert.deepEqual(writes[0].metadata, { headGrounding, reviewDiffScope: scope });
  // Agreeing counts and an unchecked review write nothing.
  assert.equal(persistReviewGroundingMetadata({ ...args, headGrounding: { checked: 0, demoted: [] },
    reviewDiffScope: { source: 'pr-diff', reason: 'file-sets-agree', prDiffFileCount: 4, ownDiffFileCount: 4 } }), false);
  assert.equal(writes.length, 1);
  // A failed write is warn-only.
  assert.equal(persistReviewGroundingMetadata({ ...args, headGrounding, beginReviewerPassImpl: () => { throw new Error('locked'); } }), false);
});

test('REVIEWCHUNK-01: removed-line annotation keeps headers, line count and long lines intact', () => {
  const longRemoved = `-${'y'.repeat(200)}`;
  const diff = [
    'diff --git a/x.mjs b/x.mjs',
    '--- a/x.mjs',
    '+++ b/x.mjs',
    '@@ -1,3 +1,2 @@',
    '-const a = 1;',
    longRemoved,
    '--- not a header, a removed line',
    '+const a = 2;',
    ' keep();',
  ].join('\n');
  const annotated = annotateRemovedDiffLines(diff, { maxLineBytes: 100 });
  assert.equal(annotated.split('\n').length, diff.split('\n').length);
  assert.deepEqual(annotated.split('\n'), [
    'diff --git a/x.mjs b/x.mjs',
    '--- a/x.mjs',
    '+++ b/x.mjs',
    '@@ -1,3 +1,2 @@',
    '-[REMOVED] const a = 1;',
    longRemoved,
    '-[REMOVED] -- not a header, a removed line',
    '+const a = 2;',
    ' keep();',
  ]);
  assert.equal(annotateRemovedDiffLines(annotated, { maxLineBytes: 100 }), annotated);
});

test('REVIEWCHUNK-01: a chunk that splits a hunk carries the head post-image within budget', async () => {
  const body = [];
  for (let index = 0; index < 90; index += 1) {
    if (index % 3 === 0) body.push(`-  legacyStep${index}(state);`);
    else body.push(`+  headStep${index}(state, options);`);
  }
  const diff = [
    'diff --git a/src/pipeline.mjs b/src/pipeline.mjs',
    '--- a/src/pipeline.mjs',
    '+++ b/src/pipeline.mjs',
    '@@ -100,30 +200,60 @@ function runPipeline(state, options) {',
    ...body,
    '',
  ].join('\n');
  const overhead = agyPromptBytes(buildPromptForReviewerModel('gemini', '', '', { runtime: 'antigravity' }));
  const maxBytes = overhead + 2600;
  const contexts = [];
  await reviewAgyOversizedInChunks(diff, '', {
    env: {},
    maxBytes,
    reviewWithGeminiImpl: async (chunkDiff, chunkContext) => {
      contexts.push({ chunkDiff, chunkContext });
      assert.ok(agyPromptBytes(buildPromptForReviewerModel('gemini', chunkDiff, chunkContext, { runtime: 'antigravity' })) <= maxBytes);
      return { reviewText: review('- None.', 'Comment only') };
    },
  });
  assert.ok(contexts.length >= 2, 'the single hunk must split across chunks');
  const later = contexts[1];
  assert.match(later.chunkContext, /Head post-image of the hunk this chunk splits in src\/pipeline\.mjs/);
  assert.match(later.chunkContext, /Head lines just before this chunk:\n2\d\d\| {3}headStep\d+\(state, options\);/);
  assert.doesNotMatch(later.chunkContext, /legacyStep/, 'the post-image carries head lines only');
  assert.match(contexts[0].chunkContext, /Head lines just after this chunk:/);
});
