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
  assert.equal(findings[1].title, 'Unsandboxed Claude worker escalation');
  assert.equal(findings[1].file, '`modules/worker-pool/lib/adapters/claude-code.sh`');
  assert.equal(findings[1].lines, '`645-664`');
  assert.equal(findings[1].problem, 'The adapter now runs Claude with bypassPermissions.');
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
