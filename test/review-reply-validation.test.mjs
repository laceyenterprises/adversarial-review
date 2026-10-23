// REVIEWVALID-01: a reviewer reply that echoes the output template is not a
// review. It is rejected before posting, retried on the bounded
// reviewer-output path, and never parsed into addressable findings.
// Fixtures are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ReviewerReplyRejectedError,
  assertReviewerReply,
  extractTemplatePlaceholders,
  reviewTemplatePlaceholders,
  validateReviewerReply,
} from '../src/kernel/review-reply.mjs';
import { parseReviewFindings } from '../src/kernel/review-findings.mjs';
import { dispatchReviewerModel, reviewAgyOversizedInChunks } from '../src/reviewer-harness.mjs';
import { sanitizeCodexReviewPayload } from '../src/kernel/verdict.mjs';
import { reviewerExecutionFailureExitCode } from '../src/reviewer-outcomes.mjs';
import { classifyReviewerFailure } from '../src/adapters/reviewer-runtime/cli-direct/classification.mjs';
import { settleReviewerAttempt } from '../src/reviewer-spawn-settle.mjs';
import classifyMergeAgentRescue from '../src/merge-agent-rescue-classifier.mjs';
import { classifyBlockingFindings, classifyNonBlockingFindings } from '../src/merge-agent-review-classification.mjs';

const ECHO_CARD = [
  '- **<Title>**',
  '  - **File:** `<path>`',
  '  - **Lines:** `<range>`',
  '  - **Problem:** <one paragraph>',
  '  - **Why it matters:** <one paragraph>',
  '  - **Recommended fix:** <one paragraph>',
];

// The 2026-10-23 incident shape, restated synthetically.
const TEMPLATE_ECHO_REPLY = [
  '## Adversarial Review — Gemini (synthetic-reviewer)',
  '',
  '## Summary',
  '<text>',
  '',
  '## Blocking issues',
  ...ECHO_CARD,
  ...ECHO_CARD,
  '',
  '## Non-blocking issues',
  ...ECHO_CARD,
  ...ECHO_CARD,
  '',
  '## Suggested fixes',
  '<text>',
  '',
  '## Verdict',
  'Request changes',
  '```',
  '',
  'Check rules:',
  '- Use exactly these top-level section headings.',
  '- If a section has no items, write exactly: - None.',
  'I looked over the diff for the synthetic module and it reads fine.',
].join('\n');

const VALID_REPLY = [
  '## Summary',
  'The change adds a synthetic retry helper; one blocking defect remains.',
  '',
  '## Blocking issues',
  '- **Retry loop never terminates**',
  '  - **File:** `src/synthetic-retry.mjs`',
  '  - **Lines:** `10-14`',
  '  - **Problem:** The loop retries forever when the stub keeps failing.',
  '  - **Why it matters:** A hung worker never releases its lease.',
  '  - **Recommended fix:** Bound the loop with a maximum attempt count.',
  '',
  '## Non-blocking issues',
  '- None.',
  '',
  '## Suggested fixes',
  '- Add a test for the exhausted-retry path; the parser emits `<path>` tokens in its usage text.',
  '',
  '## Verdict',
  'Request changes',
].join('\n');

function withoutLeadingHeader(text) {
  return text.split('\n').slice(2).join('\n');
}

test('REVIEWVALID-01: placeholders are derived from the reviewer template', () => {
  const placeholders = reviewTemplatePlaceholders();
  for (const token of ['<Title>', '<path>', '<range>', '<one paragraph>', '<text>']) {
    assert.ok(placeholders.includes(token), `${token} must be a known placeholder`);
  }
  const template = readFileSync(new URL('../prompts/code-pr/reviewer.first.md', import.meta.url), 'utf8');
  assert.deepEqual(extractTemplatePlaceholders(template).sort(), ['<Title>', '<path>', '<range>', '<one paragraph>'].sort());
  // Tokens outside the Output requirements block (`<name>`, `<root>`) are not output placeholders.
  assert.ok(!placeholders.includes('<name>'));
});

test('REVIEWVALID-01: the template-echo reply is rejected with every broken rule named', () => {
  const { ok, reasons } = validateReviewerReply(TEMPLATE_ECHO_REPLY);
  assert.equal(ok, false);
  assert.match(reasons.join('; '), /template placeholders .*<Title>.*<path>.*<range>.*<one paragraph>/);
  assert.match(reasons.join('; '), /<text>/);
  assert.ok(reasons.includes('text after the Verdict'));
});

test('REVIEWVALID-01: a normal valid reply is accepted, with or without the review header', () => {
  assert.deepEqual(validateReviewerReply(VALID_REPLY), { ok: true, reasons: [] });
  assert.deepEqual(
    validateReviewerReply(`## Adversarial Review — Gemini (synthetic-reviewer)\n\n${VALID_REPLY}`),
    { ok: true, reasons: [] },
  );
  // Prose before the final verdict line inside the Verdict section is allowed.
  assert.equal(validateReviewerReply(VALID_REPLY.replace(
    '## Verdict\nRequest changes', '## Verdict\nOne blocking defect remains.\n\nRequest changes')).ok, true);
  // Off-level canonical headings are promoted exactly as the sanitizer does.
  assert.equal(validateReviewerReply(VALID_REPLY.replace('## Summary', '### Summary:')).ok, true);
});

test('REVIEWVALID-01: text before the first required heading is rejected', () => {
  const { ok, reasons } = validateReviewerReply(`Here is my review of the synthetic change.\n\n${VALID_REPLY}`);
  assert.equal(ok, false);
  assert.deepEqual(reasons, ['text before the first required heading']);
  assert.equal(validateReviewerReply(`\`\`\`markdown\n${VALID_REPLY}\n\`\`\``).ok, false);
});

test('REVIEWVALID-01: a duplicated Verdict, or a section after it, is rejected', () => {
  const duplicated = validateReviewerReply(`${VALID_REPLY}\n\n## Verdict\nComment only`);
  assert.equal(duplicated.ok, false);
  assert.ok(duplicated.reasons.includes('repeated required sections Verdict'));

  const repeatedSummary = validateReviewerReply(`${VALID_REPLY.replace('## Verdict', '## Summary\nAgain.\n\n## Verdict')}`);
  assert.ok(repeatedSummary.reasons.includes('repeated required sections Summary'));

  const notLast = validateReviewerReply(`${VALID_REPLY}\n\n## Notes\nSynthetic epilogue.`);
  assert.deepEqual(notLast.reasons, ['Verdict is not the last section']);

  const trailing = validateReviewerReply(`${VALID_REPLY}\n\nLet me know if you want more detail.`);
  assert.deepEqual(trailing.reasons, ['text after the Verdict']);

  assert.deepEqual(validateReviewerReply(VALID_REPLY.replace(/\n## Verdict\nRequest changes$/, '')).reasons, ['no Verdict section']);
  assert.deepEqual(validateReviewerReply('').reasons, ['empty reply']);
});

test('REVIEWVALID-01: required headings inside fenced examples are not sections', () => {
  for (const [opening, nested, closing] of [
    ['```markdown', '## Summary\n## Verdict', '```'],
    ['~~~markdown', '## Summary\n## Verdict', '~~~'],
    ['````markdown', '```\n~~~\n## Verdict\n## Summary', '`````'],
    ['~~~~markdown', '~~~\n```\n## Verdict\n## Summary', '~~~~~'],
    ['```markdown', '```not-a-close\n## Verdict', '```'],
  ]) {
    const reply = VALID_REPLY.replace('## Suggested fixes\n',
      `## Suggested fixes\n${opening}\n${nested}\n${closing}\n`);
    assert.deepEqual(validateReviewerReply(reply), { ok: true, reasons: [] }, opening);
    assert.ok(validateReviewerReply(`${reply}\n## Summary\nReal duplicate.`)
      .reasons.includes('repeated required sections Summary'));
  }
  const unclosed = VALID_REPLY.replace('## Suggested fixes\n', '## Suggested fixes\n```markdown\n');
  assert.ok(validateReviewerReply(unclosed).reasons.includes('no Verdict section'));
});

test('REVIEWVALID-01: every unchunked model supplies raw validation evidence', async () => {
  for (const model of ['claude', 'gemini', 'codex']) {
    for (const reply of [VALID_REPLY, `${VALID_REPLY}\n## Verdict\nComment only`]) {
      const dispatch = await dispatchReviewerModel(model, '+synthetic diff', '', {
        reviewWithClaudeImpl: async () => ({ reviewText: reply }),
        reviewWithGeminiImpl: async () => ({ reviewText: reply }),
        reviewWithCodexImpl: async () => ({ reviewText: reply }),
      });
      assert.equal(dispatch.rawReviewText, reply, model);
      const sanitized = dispatch.needsSanitize
        ? sanitizeCodexReviewPayload(dispatch.rawReviewText) : dispatch.reviewText;
      assert.equal(validateReviewerReply(sanitized).ok, true);
      if (reply === VALID_REPLY) {
        assert.doesNotThrow(() => assertReviewerReply(dispatch.rawReviewText), model);
      } else {
        assert.throws(() => assertReviewerReply(dispatch.rawReviewText), ReviewerReplyRejectedError,
          `${model}: sanitization must not hide duplicate sections from validation`);
      }
    }
  }
  const legacyClaude = await dispatchReviewerModel('claude', '+synthetic diff', '', {
    reviewWithClaudeImpl: async () => VALID_REPLY,
  });
  assert.equal(legacyClaude.rawReviewText, VALID_REPLY);
  assert.doesNotThrow(() => assertReviewerReply(legacyClaude.rawReviewText));
});

test('REVIEWVALID-01: a placeholder only counts as a whole value, not when quoted in prose', () => {
  const quoting = VALID_REPLY.replace(
    'The loop retries forever when the stub keeps failing.',
    'The usage text prints `--root <path>` and the template token `<Title>` inline.',
  );
  assert.equal(validateReviewerReply(quoting).ok, true);
  const echoedTitle = VALID_REPLY.replace('- **Retry loop never terminates**', '- **<Title>**');
  assert.deepEqual(validateReviewerReply(echoedTitle).reasons, ['template placeholders <Title>']);
});

test('REVIEWVALID-01: a rejection carries the reviewer-output tag and evidence for forensics', () => {
  const captured = [];
  assert.throws(
    () => assertReviewerReply(TEMPLATE_ECHO_REPLY, { onRejected: (rejected) => captured.push(rejected) }),
    (error) => error instanceof ReviewerReplyRejectedError
      && error.failureClass === 'reviewer-output'
      && /^\[reviewer-output\] reviewer reply rejected: template placeholders/.test(error.message),
  );
  assert.equal(captured.length, 1);
  assert.equal(captured[0].rawReviewText, TEMPLATE_ECHO_REPLY);
  assert.match(captured[0].rejectionReason, /reviewer reply rejected/);
  // A failing forensic hook never masks the rejection.
  assert.throws(() => assertReviewerReply(TEMPLATE_ECHO_REPLY, { onRejected: () => { throw new Error('disk full'); } }),
    ReviewerReplyRejectedError);
  assert.doesNotThrow(() => assertReviewerReply(VALID_REPLY, { onRejected: () => assert.fail('valid reply') }));
});

test('REVIEWVALID-01: a template-echo chunk is rejected, retried as reviewer-output, and never posted', async () => {
  const diff = 'diff --git a/sample.mjs b/sample.mjs\n--- a/sample.mjs\n+++ b/sample.mjs\n@@ -0,0 +1,9000 @@\n'
    + '+synthetic content\n'.repeat(9000);
  const rejected = [];
  let calls = 0;
  let error = null;
  try {
    await reviewAgyOversizedInChunks(diff, '', {
      // Keep this rejection fixture independent of host-load-scaled defaults.
      env: {
        AGENT_OS_REVIEWER_TIMEOUT_MS: '1000',
        AGENT_OS_REVIEWER_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS: '1000',
      },
      maxBytes: 60000,
      onRejectedCodexOutput: (value) => rejected.push(value),
      reviewWithGeminiImpl: async () => {
        calls += 1;
        return { reviewText: calls === 1 ? VALID_REPLY : TEMPLATE_ECHO_REPLY };
      },
    });
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof ReviewerReplyRejectedError, `expected a rejection, got ${error?.message}`);
  assert.equal(calls, 2, 'the merge stops at the first rejected chunk');
  assert.deepEqual(rejected.map((value) => value.chunkIndex), [2]);

  // The reviewer process prints the message and exits; the watcher classifies
  // that stderr onto the bounded reviewer-output retry.
  const stderr = `[reviewer] AI review failed for example/project#7: ${error.message}`;
  const failureClass = classifyReviewerFailure(stderr, reviewerExecutionFailureExitCode(error));
  assert.equal(failureClass, 'reviewer-output');

  const rootDir = mkdtempSync(join(tmpdir(), 'reviewvalid-'));
  const writes = [];
  try {
    settleReviewerAttempt({
      rootDir, repoPath: 'example/project', prNumber: 7,
      result: { ok: false, failureClass, error: error.message },
      failureAt: '2026-10-23T00:00:00.000Z', maxRemediationRounds: 1,
      statements: {
        markPosted: { run: () => assert.fail('a rejected reply is never posted') },
        markFailed: { run: () => assert.fail('a rejected reply is retried, not charged as terminal') },
        markCascadeFailed: { run: () => assert.fail('first rejection is within the infra cap') },
        markPendingUpstream: { run: (...args) => writes.push(args) },
        getReviewRow: { get: () => ({ infra_auto_recover_attempts: 0, review_attempts: 0 }) },
      },
      log: { warn() {}, error() {}, info() {} },
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
  assert.equal(writes.length, 1);
  assert.match(writes[0][1], /^\[reviewer-output\] .*reviewer reply rejected: template placeholders/);
});

test('REVIEWVALID-01: the finding parser refuses placeholder findings', () => {
  const body = withoutLeadingHeader(TEMPLATE_ECHO_REPLY);
  const parsed = parseReviewFindings(body);
  assert.equal(parsed.blocking.state, 'unknown');
  assert.equal(parsed.blocking.malformed, 'template-placeholder');
  assert.equal(parsed.blocking.count, 0);
  assert.deepEqual(parsed.blocking.findings, []);
  assert.equal(parsed.nonBlocking.state, 'unknown');
  assert.equal(parsed.findingsCount, null);

  // A real card whose File field alone is a placeholder is malformed too.
  const fileOnly = VALID_REPLY.replace('`src/synthetic-retry.mjs`', '`<path>`');
  assert.equal(parseReviewFindings(fileOnly).blocking.state, 'unknown');

  // A real finding that merely mentions a token inline is still a finding.
  const inline = VALID_REPLY.replace('Retry loop never terminates', 'Retry loop ignores `<T>` bound');
  assert.deepEqual(
    { state: parseReviewFindings(inline).blocking.state, count: parseReviewFindings(inline).blocking.count },
    { state: 'known', count: 1 },
  );
  assert.equal(parseReviewFindings(VALID_REPLY).findingsCount, 1);
});

test('REVIEWVALID-01: rescue classifier and closer do not treat placeholders as addressable', () => {
  const body = withoutLeadingHeader(TEMPLATE_ECHO_REPLY);
  const rescue = classifyMergeAgentRescue({
    reviewBody: body,
    labels: [],
    mergeable: 'MERGEABLE',
    statusCheckRollup: [],
    headSha: 'a'.repeat(40),
    reviewHeadSha: 'a'.repeat(40),
  });
  assert.equal(rescue.decision, 'inconclusive');
  assert.equal(rescue.reason, 'malformed-review');
  assert.deepEqual(rescue.parsedFindings, []);

  assert.deepEqual(classifyBlockingFindings(body), { count: 0, state: 'unknown' });
  assert.equal(classifyNonBlockingFindings(body).state, 'unknown');

  const real = classifyMergeAgentRescue({
    reviewBody: VALID_REPLY, labels: [], mergeable: 'MERGEABLE', statusCheckRollup: [],
    headSha: 'a'.repeat(40), reviewHeadSha: 'a'.repeat(40),
  });
  assert.equal(real.decision, 'remediation-eligible');
  assert.equal(real.reason, 'addressable-findings');
});

test('REVIEWVALID-01: known placeholder title and file values remain malformed', () => {
  for (const token of ['<Title>', '<PATH>', '<range>', '<one paragraph>', '<text>']) {
    for (const reply of [
      VALID_REPLY.replace('Retry loop never terminates', token),
      VALID_REPLY.replace('src/synthetic-retry.mjs', token),
    ]) {
      assert.equal(parseReviewFindings(reply).blocking.malformed, 'template-placeholder', token);
    }
  }
});

test('REVIEWVALID-01: component titles and virtual files retain all addressable findings', () => {
  for (const title of ['<AuthProvider>', '<Modal>', '<Select>']) {
    const reply = VALID_REPLY.replace('## Non-blocking issues', [
      `- **${title}**`,
      '  - **File:** `<stdin>`',
      '  - **Lines:** 2-4',
      '  - **Problem:** The component drops required context.',
      '',
      '## Non-blocking issues',
    ].join('\n'));
    const parsed = parseReviewFindings(reply);
    assert.equal(validateReviewerReply(reply).ok, true);
    assert.equal(parsed.blocking.state, 'known');
    assert.equal(parsed.findingsCount, 2);
    assert.deepEqual(parsed.blocking.findings.map((finding) => finding.title),
      ['Retry loop never terminates', title]);
    assert.equal(parsed.blocking.findings[1].file, '`<stdin>`');
    assert.deepEqual(classifyBlockingFindings(reply), { count: 2, state: 'known' });
    assert.equal(classifyMergeAgentRescue({
      reviewBody: reply, labels: [], mergeable: 'MERGEABLE', statusCheckRollup: [],
      headSha: 'a'.repeat(40), reviewHeadSha: 'a'.repeat(40),
    }).decision, 'remediation-eligible');
    const nonBlocking = reply.replace('## Blocking issues', '## Non-blocking issues')
      .replace('## Non-blocking issues\n- None.', '## Blocking issues\n- None.');
    assert.equal(parseReviewFindings(nonBlocking).nonBlocking.count, 2);
    assert.equal(classifyNonBlockingFindings(nonBlocking).state, 'known');
  }
});
