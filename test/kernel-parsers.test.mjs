import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  extractReviewVerdict,
  normalizeReviewVerdict,
  sanitizeCodexReviewPayload,
} from '../src/kernel/verdict.mjs';
import {
  parseBlockingFindingsSection,
  parseRemediationReply,
  validateRemediationReply,
} from '../src/kernel/remediation-reply.mjs';

// Fixtures are committed under test/fixtures/kernel/ so the suite runs the
// same on every host (CI, fresh clones, agent worktrees). Snapshots of real
// production review/remediation artifacts; do not edit by hand — regenerate
// by copying a fresh production blob and trimming if needed.
const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kernel');

function readFixture(name) {
  return JSON.parse(readFileSync(join(fixtureRoot, name), 'utf8'));
}

const passingVerdictJob = readFixture('passing-verdict-job.json');
const failingVerdictJob = readFixture('failing-verdict-job.json');
const remediationJob = failingVerdictJob;
const remediationReply = readFixture('remediation-reply.json');

test('kernel verdict parser accepts a production passing verdict and renders it stably', () => {
  // The passing fixture was pre-normalized to sanitizer-canonical form
  // when committed (see test/fixtures/kernel/passing-verdict-job.json),
  // so byte-equality must hold against the input as well as on re-run.
  // A regression that quietly re-cases headings or collapses whitespace
  // would break the first assert and not silently slip past idempotency.
  const sanitized = sanitizeCodexReviewPayload(passingVerdictJob.reviewBody);

  assert.equal(sanitized, passingVerdictJob.reviewBody);
  assert.equal(sanitizeCodexReviewPayload(sanitized), sanitized);
  assert.equal(extractReviewVerdict(sanitized), 'Comment only');
  assert.equal(normalizeReviewVerdict(extractReviewVerdict(sanitized)), 'comment-only');
});

test('kernel verdict parser preserves a production failing verdict byte-for-byte', () => {
  const sanitized = sanitizeCodexReviewPayload(failingVerdictJob.reviewBody);

  assert.equal(sanitized, failingVerdictJob.reviewBody);
  assert.equal(extractReviewVerdict(sanitized), 'Request changes');
  assert.equal(normalizeReviewVerdict(extractReviewVerdict(sanitized)), 'request-changes');
});

test('kernel remediation-reply parser accepts a production reply without changing bytes', () => {
  const raw = JSON.stringify(remediationReply, null, 2);
  const parsed = parseRemediationReply(raw, { expectedJob: remediationJob });
  const validated = validateRemediationReply(remediationReply, { expectedJob: remediationJob });

  assert.deepEqual(parsed, remediationReply);
  assert.deepEqual(validated, remediationReply);
  assert.equal(JSON.stringify(validated, null, 2), raw);
});

test('kernel remediation-reply validator rejects blocked outcome with empty blockers', () => {
  const invalid = {
    ...remediationReply,
    outcome: 'blocked',
    blockers: [],
    reReview: { requested: false, reason: null },
  };

  assert.throws(
    () => validateRemediationReply(invalid, { expectedJob: remediationJob }),
    /outcome is "blocked" but blockers is empty/
  );
});

// Sanitizer "actual cleaning paths" coverage. The pre-normalized fixture
// tests above only prove idempotency on already-clean input. This test
// drives messy input through the transforms the sanitizer actually
// performs (heading-level collapse, recognized-section title-casing,
// trailing-colon strip) and pins the canonical output, so a regression
// in any of those transforms fails loudly here even when the production
// fixture happens not to exercise the broken path.
test('kernel sanitizer collapses heading levels and title-cases recognized sections', () => {
  const messy = [
    '# summary',
    'Real summary body.',
    '',
    '### blocking issues:',
    '- None.',
    '',
    '#### NON-BLOCKING ISSUES',
    '- Lint smell.',
    '',
    '## Verdict',
    'Comment only',
  ].join('\n');

  // Per the sanitizer:
  //   - `# `, `### `, `#### ` all collapse to `## `
  //   - recognized headings (`summary`/`blocking issues`/`non-blocking
  //     issues`/`suggested fixes`/`verdict`) get title-cased per word
  //     (so "non-blocking" stays as one hyphenated token; only the first
  //     letter uppercases)
  //   - trailing colons on the heading line are stripped
  //   - extractReviewVerdict reads the line after `## Verdict`
  const expected = [
    '## Summary',
    'Real summary body.',
    '',
    '## Blocking Issues',
    '- None.',
    '',
    '## Non-blocking Issues',
    '- Lint smell.',
    '',
    '## Verdict',
    'Comment only',
  ].join('\n');

  const sanitized = sanitizeCodexReviewPayload(messy);

  assert.equal(sanitized, expected);
  assert.equal(extractReviewVerdict(sanitized), 'Comment only');
  assert.equal(normalizeReviewVerdict('Comment only'), 'comment-only');
  // Idempotency on already-clean output must still hold.
  assert.equal(sanitizeCodexReviewPayload(sanitized), sanitized);
});

test('kernel sanitizer stops processing further sections after a duplicate is seen', () => {
  // The sanitizer's `firstSeen` dedup BREAKS the section walk on the
  // first duplicate heading. Sections AFTER the duplicate are not
  // processed (so a malicious second `## Verdict` cannot override the
  // first one's text via further section trims). Content of the first
  // Verdict section's slice still extends to end-of-file — the dedup is
  // a "stop processing more headings" signal, not a content-trimmer.
  const dupVerdict = [
    '## Summary',
    'First.',
    '',
    '## Blocking Issues',
    '- F1',
    '',
    '## Verdict',
    'Comment only',
    '',
    '## Verdict',
    'Request changes',
  ].join('\n');

  const sanitized = sanitizeCodexReviewPayload(dupVerdict);

  // First Verdict must be the one extractReviewVerdict returns, even
  // though the duplicate's "Request changes" text is still present in
  // the trailing slice.
  assert.equal(extractReviewVerdict(sanitized), 'Comment only');
});

test('kernel sanitizer rejects payloads missing required Summary/Verdict sections', () => {
  // Verdict present, Summary missing.
  assert.throws(
    () => sanitizeCodexReviewPayload([
      '## Blocking Issues',
      '- Real finding.',
      '',
      '## Verdict',
      'Request changes',
    ].join('\n')),
    /missing required Summary\/Verdict sections/
  );

  // Summary present, Verdict missing.
  assert.throws(
    () => sanitizeCodexReviewPayload([
      '## Summary',
      'Some review body.',
      '',
      '## Blocking Issues',
      '- One finding.',
    ].join('\n')),
    /missing required Summary\/Verdict sections/
  );

  // No recognizable sections at all (empty markdown body) — distinct error path.
  assert.throws(
    () => sanitizeCodexReviewPayload('not a review at all'),
    /did not contain recognizable review sections/
  );
});

test('kernel sanitizer preserves H3 finding cards under canonical section headings', () => {
  // The reviewer prompt now mandates `### <Title>` finding cards with
  // bold-labeled `**File:**` / `**Lines:**` / `**Problem:**` fields,
  // mirroring the remediator's accountability comments. Older sanitizer
  // builds blanket-collapsed every `### ` to `## `, which would shatter
  // each finding into a phantom top-level section and break verdict
  // extraction. The current sanitizer must promote H1/H3/H4 to H2 only
  // when the heading text matches a canonical section name, leaving
  // non-canonical H3 cards intact.
  const cardReview = [
    '## Summary',
    'One blocker.',
    '',
    '## Blocking Issues',
    '',
    '### Lead-position title regression',
    '',
    '**File:** `modules/worker-pool/lib/python/cwp_dispatch/plan_walk.py`',
    '',
    '**Lines:** `79-102`',
    '',
    '**Problem:** The new rule rejects legitimately merged PR titles.',
    '',
    '**Why it matters:** Downstream tickets stay blocked when evidence is missed.',
    '',
    '**Recommended fix:** Restore boundary-based matching for Linear ids.',
    '',
    '## Non-blocking Issues',
    '- None.',
    '',
    '## Verdict',
    'Request changes',
  ].join('\n');

  const sanitized = sanitizeCodexReviewPayload(cardReview);

  // The H3 finding heading must survive — it is not a canonical section
  // name and the section walker must not see it as a phantom section.
  assert.match(sanitized, /^### Lead-position title regression$/m);
  // The canonical sections still resolve to H2.
  assert.match(sanitized, /^## Summary$/m);
  assert.match(sanitized, /^## Blocking Issues$/m);
  assert.match(sanitized, /^## Non-blocking Issues$/m);
  assert.match(sanitized, /^## Verdict$/m);
  assert.equal(extractReviewVerdict(sanitized), 'Request changes');
  // Idempotency must still hold on already-clean H3-card output.
  assert.equal(sanitizeCodexReviewPayload(sanitized), sanitized);
});

test('parseBlockingFindingsSection extracts findings from H3 + bold-label cards', () => {
  // The current reviewer prompt emits one `### <Title>` heading per
  // blocking finding, followed by bold-labeled `**File:**` /
  // `**Lines:**` / `**Problem:**` paragraphs. The coverage parser must
  // recognize this shape so per-finding accountability stays enforced.
  const reviewBody = [
    '## Summary',
    'Two blockers.',
    '',
    '## Blocking Issues',
    '',
    '### Lead-position title regression',
    '',
    '**File:** `modules/worker-pool/lib/python/cwp_dispatch/plan_walk.py`',
    '',
    '**Lines:** `79-102`',
    '',
    '**Problem:** The new rule rejects valid prefixed PR titles.',
    '',
    '**Why it matters:** Downstream tickets stay blocked.',
    '',
    '**Recommended fix:** Restore boundary-based matching for Linear ids.',
    '',
    '### Unsandboxed Claude worker escalation',
    '',
    '**File:** `modules/worker-pool/lib/adapters/claude-code.sh`',
    '',
    '**Lines:** `645-664`',
    '',
    '**Problem:** The adapter now runs Claude with bypassPermissions.',
    '',
    '**Why it matters:** Removes the only remaining in-tool gate.',
    '',
    '**Recommended fix:** Do not ship bypassPermissions as the default.',
    '',
    '## Verdict',
    'Request changes',
  ].join('\n');

  const findings = parseBlockingFindingsSection(reviewBody);

  assert.ok(Array.isArray(findings));
  assert.equal(findings.length, 2);
  assert.equal(findings[0].title, 'Lead-position title regression');
  assert.equal(findings[0].file, '`modules/worker-pool/lib/python/cwp_dispatch/plan_walk.py`');
  assert.equal(findings[0].lines, '`79-102`');
  assert.equal(findings[0].problem, 'The new rule rejects valid prefixed PR titles.');
  assert.equal(findings[0].whyItMatters, 'Downstream tickets stay blocked.');
  assert.equal(findings[0].recommendedFix, 'Restore boundary-based matching for Linear ids.');
  assert.equal(findings[1].title, 'Unsandboxed Claude worker escalation');
  assert.equal(findings[1].file, '`modules/worker-pool/lib/adapters/claude-code.sh`');
  assert.equal(findings[1].lines, '`645-664`');
  assert.equal(findings[1].problem, 'The adapter now runs Claude with bypassPermissions.');
  assert.equal(findings[1].whyItMatters, 'Removes the only remaining in-tool gate.');
  assert.equal(findings[1].recommendedFix, 'Do not ship bypassPermissions as the default.');
});

test('parseBlockingFindingsSection ignores incidental H3 subheadings inside H3 cards', () => {
  const reviewBody = [
    '## Summary',
    'One blocker with supporting detail.',
    '',
    '## Blocking Issues',
    '',
    '### Reviewer/remediator contract split',
    '',
    '**File:** `prompts/code-pr/remediator.first.md`',
    '',
    '**Lines:** `98-176`',
    '',
    '**Problem:** The reviewer emits H3 card titles but the remediator still looks for Title fields.',
    '',
    '### Reproduction',
    '',
    'A prompt-following remediator can omit the title because no literal Title field exists.',
    '',
    '**Why it matters:** Valid remediation replies can be rejected.',
    '',
    '**Recommended fix:** Treat the H3 heading as the title source, with legacy Title fallback.',
    '',
    '## Verdict',
    'Request changes',
  ].join('\n');

  const findings = parseBlockingFindingsSection(reviewBody);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].title, 'Reviewer/remediator contract split');
  assert.equal(findings[0].recommendedFix, 'Treat the H3 heading as the title source, with legacy Title fallback.');
});

test('validateRemediationReply accepts matching H3-card review titles', () => {
  const reviewBody = [
    '## Summary',
    'Two blockers.',
    '',
    '## Blocking Issues',
    '',
    '### Reviewer/remediator contract split',
    '',
    '**File:** `prompts/code-pr/remediator.first.md`',
    '',
    '**Lines:** `98-176`',
    '',
    '**Problem:** The reviewer emits H3 card titles but the remediator still looks for Title fields.',
    '',
    '**Why it matters:** Valid remediation replies can be rejected.',
    '',
    '**Recommended fix:** Treat the H3 heading as the title source.',
    '',
    '### Phantom H3 finding boundaries',
    '',
    '**File:** `src/kernel/remediation-reply.mjs`',
    '',
    '**Lines:** `297-325`',
    '',
    '**Problem:** Incidental H3 headings inside a card can be counted as findings.',
    '',
    '**Why it matters:** Coverage validation can force fake accountability entries.',
    '',
    '**Recommended fix:** Only split on H3 headings that introduce real cards.',
    '',
    '## Verdict',
    'Request changes',
  ].join('\n');
  const expectedJob = {
    jobId: 'laceyenterprises__adversarial-review-pr-110-2026-05-15T03-19-26Z',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 110,
    reviewBody,
  };
  const reply = {
    kind: 'adversarial-review-remediation-reply',
    schemaVersion: 1,
    jobId: 'laceyenterprises__adversarial-review-pr-110-2026-05-15T03-19-26Z',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 110,
    outcome: 'completed',
    summary: 'Aligned the H3 card review/remediation contract.',
    validation: ['node --test test/kernel-parsers.test.mjs'],
    addressed: [
      {
        title: 'Reviewer/remediator contract split',
        finding: 'Remediator prompts and validation still pointed at legacy Title fields.',
        action: 'Updated the title source contract to H3 headings with legacy Title fallback.',
      },
      {
        title: 'Phantom H3 finding boundaries',
        finding: 'Incidental H3 headings inside cards could inflate the finding count.',
        action: 'Made H3 parsing require a real card body before starting a new finding.',
      },
    ],
    pushback: [],
    blockers: [],
    reReview: { requested: true, reason: 'ready' },
  };

  assert.deepEqual(validateRemediationReply(reply, { expectedJob }), reply);
});

test('parseBlockingFindingsSection honors `- None.` sentinel in the H3-card era', () => {
  const reviewBody = [
    '## Summary',
    'Clean.',
    '',
    '## Blocking Issues',
    '- None.',
    '',
    '## Verdict',
    'Comment only',
  ].join('\n');

  assert.deepEqual(parseBlockingFindingsSection(reviewBody), []);
});

test('parseBlockingFindingsSection still handles legacy `- Title:` bullet findings', () => {
  // Back-compat: older review bodies (still present in stored job
  // artifacts) used the bullet shape. The parser must continue to
  // extract them so coverage checks against historical fixtures keep
  // passing after the H3 card migration.
  const reviewBody = [
    '## Summary',
    'Two blockers.',
    '',
    '## Blocking Issues',
    '- Title: Retry path can double-submit',
    '  File: src/a.mjs',
    '  Lines: 1-5',
    '  Problem: First problem.',
    '- Title: Missing auth guard',
    '  File: src/b.mjs',
    '  Lines: 10-20',
    '  Problem: Second problem.',
    '',
    '## Verdict',
    'Request changes',
  ].join('\n');

  const findings = parseBlockingFindingsSection(reviewBody);

  assert.equal(findings.length, 2);
  assert.equal(findings[0].title, 'Retry path can double-submit');
  assert.equal(findings[0].file, 'src/a.mjs');
  assert.equal(findings[1].title, 'Missing auth guard');
  assert.equal(findings[1].file, 'src/b.mjs');
});

test('parseBlockingFindingsSection extracts findings from nested-bullet `- **Title**` cards', () => {
  // The current reviewer prompt emits each blocking finding as a
  // bold-title top-level bullet with `**File:** / **Lines:** /
  // **Problem:**` rendered as nested sub-bullets. The coverage parser
  // must recognize this shape so per-finding accountability stays
  // enforced alongside the legacy bullet and H3-card shapes.
  const reviewBody = [
    '## Summary',
    'Two blockers.',
    '',
    '## Blocking Issues',
    '- **Drain-status JSON contract changed without spec update**',
    '  - **File:** `modules/worker-pool/lib/python/cwp_dispatch/drain_state.py`',
    '  - **Lines:** 59-96',
    '  - **Problem:** SPEC.md §6.3 documents the exact JSON shape.',
    '  - **Why it matters:** Silent contract drift is the dominant maintenance risk.',
    '  - **Recommended fix:** Update SPEC.md §6.3 in the same PR.',
    '- **lastDrain semantics overlap with activeDrain**',
    '  - **File:** `modules/worker-pool/lib/python/cwp_dispatch/drain_state.py`',
    '  - **Lines:** 65-84',
    '  - **Problem:** has_drain_history is true whenever any field is non-null.',
    '  - **Why it matters:** A consumer that wants the previous drain may get the active drain.',
    '  - **Recommended fix:** Pick one semantic and document it.',
    '',
    '## Verdict',
    'Request changes',
  ].join('\n');

  const findings = parseBlockingFindingsSection(reviewBody);

  assert.ok(Array.isArray(findings));
  assert.equal(findings.length, 2);
  assert.equal(findings[0].title, 'Drain-status JSON contract changed without spec update');
  assert.equal(findings[0].file, '`modules/worker-pool/lib/python/cwp_dispatch/drain_state.py`');
  assert.equal(findings[0].lines, '59-96');
  assert.equal(findings[0].problem, 'SPEC.md §6.3 documents the exact JSON shape.');
  assert.equal(findings[1].title, 'lastDrain semantics overlap with activeDrain');
  assert.equal(findings[1].file, '`modules/worker-pool/lib/python/cwp_dispatch/drain_state.py`');
  assert.equal(findings[1].lines, '65-84');
  assert.equal(findings[1].problem, 'has_drain_history is true whenever any field is non-null.');
});

test('parseBlockingFindingsSection keeps nested-bullet titles when harmless trailing text is present', () => {
  const reviewBody = [
    '## Summary',
    'Two blockers.',
    '',
    '## Blocking Issues',
    '- **Reviewer-remediator contract split**.',
    '  - **File:** `prompts/code-pr/remediator.first.md`',
    '  - **Lines:** 98-176',
    '  - **Problem:** Prompt contract still points workers at the wrong title source.',
    '  - **Why it matters:** Workers can submit replies that fail validation.',
    '  - **Recommended fix:** Update the remediator prompts to mirror the reviewer format.',
    '- **Fragile bullet-title boundary regex** - parser only matched exact-line titles',
    '  - **File:** `src/kernel/remediation-reply.mjs`',
    '  - **Lines:** 318-355',
    '  - **Problem:** Minor punctuation drift drops the parsed title.',
    '  - **Why it matters:** Coverage checks weaken silently.',
    '  - **Recommended fix:** Parse the leading bold span and tolerate trailing text.',
    '',
    '## Verdict',
    'Request changes',
  ].join('\n');

  const findings = parseBlockingFindingsSection(reviewBody);

  assert.equal(findings.length, 2);
  assert.equal(findings[0].title, 'Reviewer-remediator contract split');
  assert.equal(findings[1].title, 'Fragile bullet-title boundary regex');
});

test('parseBlockingFindingsSection ignores incidental `- **note**` bullets without required fields', () => {
  // An incidental bold-bullet that isn't a real finding card (no File /
  // Lines / Problem fields beneath it) must not inflate the count.
  const reviewBody = [
    '## Summary',
    'One real blocker plus an aside.',
    '',
    '## Blocking Issues',
    '- **Real finding with full fields**',
    '  - **File:** `src/a.mjs`',
    '  - **Lines:** 10-20',
    '  - **Problem:** The real issue.',
    '  - **Why it matters:** Production risk.',
    '  - **Recommended fix:** Patch it.',
    '',
    '  Note: also see `- **Related context**` below for background, but it has no fields of its own.',
    '',
    '## Verdict',
    'Request changes',
  ].join('\n');

  const findings = parseBlockingFindingsSection(reviewBody);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].title, 'Real finding with full fields');
});

test('parseBlockingFindingsSection treats nested bold bullets as finding body content', () => {
  const reviewBody = [
    '## Summary',
    'One blocker with extra context before its required fields.',
    '',
    '## Blocking Issues',
    '- **Nested bullet boundary collision**',
    '  - **Context** A nested bold body bullet appears before the field bullets.',
    '  - **Reproduction** Run the parser against this review body.',
    '  - **File:** `src/kernel/remediation-reply.mjs`',
    '  - **Lines:** 318-370',
    '  - **Problem:** Nested bold body bullets were treated as finding boundaries.',
    '  - **Why it matters:** The real finding could disappear before validation.',
    '  - **Recommended fix:** Only top-level bold bullets can start finding cards.',
    '',
    '## Verdict',
    'Request changes',
  ].join('\n');

  const findings = parseBlockingFindingsSection(reviewBody);

  assert.equal(findings.length, 1);
  assert.equal(findings[0].title, 'Nested bullet boundary collision');
  assert.equal(findings[0].file, '`src/kernel/remediation-reply.mjs`');
  assert.equal(findings[0].lines, '318-370');
  assert.equal(findings[0].problem, 'Nested bold body bullets were treated as finding boundaries.');
});

test('validateRemediationReply enforces exact nested-bullet review titles', () => {
  const reviewBody = [
    '## Summary',
    'Two blockers.',
    '',
    '## Blocking Issues',
    '- **Reviewer-remediator contract split**',
    '  - **File:** `prompts/code-pr/remediator.first.md`',
    '  - **Lines:** 98-176',
    '  - **Problem:** Remediator prompts still point at the old title source.',
    '  - **Why it matters:** The producer and consumer disagree on the wire format.',
    '  - **Recommended fix:** Update the remediator prompts in the same PR.',
    '- **Fragile bullet-title boundary regex**.',
    '  - **File:** `src/kernel/remediation-reply.mjs`',
    '  - **Lines:** 318-355',
    '  - **Problem:** Exact-line matching drops titles on punctuation drift.',
    '  - **Why it matters:** Missing titles weaken accountability enforcement.',
    '  - **Recommended fix:** Parse the leading bold title span instead.',
    '',
    '## Verdict',
    'Request changes',
  ].join('\n');
  const expectedJob = {
    jobId: 'laceyenterprises__adversarial-review-pr-112-2026-05-15T15-50-58-107Z',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 112,
    reviewBody,
  };

  const mismatched = {
    kind: 'adversarial-review-remediation-reply',
    schemaVersion: 1,
    jobId: 'laceyenterprises__adversarial-review-pr-112-2026-05-15T15-50-58-107Z',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 112,
    outcome: 'completed',
    summary: 'Patched the prompt contract and parser.',
    validation: ['node --test test/kernel-parsers.test.mjs'],
    addressed: [
      {
        title: 'Reviewer/remediator contract split',
        finding: 'Remediator prompts still described the old title source.',
        action: 'Updated the worker prompts to mirror the nested-bullet reviewer output.',
      },
      {
        title: 'Fragile bullet-title boundary regex',
        finding: 'Exact-line matching dropped titles on punctuation drift.',
        action: 'Parsed the leading bold title span and ignored harmless trailing punctuation.',
      },
    ],
    pushback: [],
    blockers: [],
    reReview: { requested: true, reason: 'ready' },
  };

  assert.throws(
    () => validateRemediationReply(mismatched, { expectedJob }),
    /Remediation reply titles must match the blocking review bold bullet titles, H3 headings, or legacy Title fields exactly/
  );

  const exact = {
    ...mismatched,
    addressed: [
      {
        title: 'Reviewer-remediator contract split',
        finding: 'Remediator prompts still described the old title source.',
        action: 'Updated the worker prompts to mirror the nested-bullet reviewer output.',
      },
      {
        title: 'Fragile bullet-title boundary regex',
        finding: 'Exact-line matching dropped titles on punctuation drift.',
        action: 'Parsed the leading bold title span and ignored harmless trailing punctuation.',
      },
    ],
  };

  assert.deepEqual(validateRemediationReply(exact, { expectedJob }), exact);
});

test('validateRemediationReply accepts an exact nested-bullet title that ends with a colon', () => {
  const reviewBody = [
    '## Summary',
    'One blocker.',
    '',
    '## Blocking Issues',
    '- **Trailing-colon title corruption:**',
    '  - **File:** `src/kernel/remediation-reply.mjs`',
    '  - **Lines:** 321-327',
    '  - **Problem:** The parser strips a trailing colon from the bold title before validation.',
    '  - **Why it matters:** A worker can copy the visible title exactly and still fail validation.',
    '  - **Recommended fix:** Preserve the title bytes exactly and rely on field-name exclusion for `**File:**` bullets.',
    '',
    '## Verdict',
    'Request changes',
  ].join('\n');
  const expectedJob = {
    jobId: 'laceyenterprises__adversarial-review-pr-112-2026-05-15T16-11-08-731Z',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 112,
    reviewBody,
  };
  const reply = {
    kind: 'adversarial-review-remediation-reply',
    schemaVersion: 1,
    jobId: 'laceyenterprises__adversarial-review-pr-112-2026-05-15T16-11-08-731Z',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 112,
    outcome: 'completed',
    summary: 'Preserved exact nested-bullet titles with trailing colons.',
    validation: ['node --test test/kernel-parsers.test.mjs'],
    addressed: [
      {
        title: 'Trailing-colon title corruption:',
        finding: 'The parser dropped a trailing colon from the nested-bullet finding title.',
        action: 'Preserved the bold title exactly as written so validation accepts the copied title bytes.',
        files: ['src/kernel/remediation-reply.mjs', 'test/kernel-parsers.test.mjs'],
      },
    ],
    pushback: [],
    blockers: [],
    reReview: {
      requested: true,
      reason: 'The trailing-colon nested-bullet title is now preserved and validates exactly.',
    },
  };

  assert.deepEqual(validateRemediationReply(reply, { expectedJob }), reply);
});
