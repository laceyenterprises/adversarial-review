import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, review } from './helpers/hamclose-history.mjs';
import { checkPrimaryChange } from '../src/ama/primary-change.mjs';
import { __test__ as harness } from '../src/reviewer-harness.mjs';

const head = 'c'.repeat(40);

async function reversal(lines, { single = false, file = 'src/a.mjs', rebased = true } = {}) {
  const body = review().body.replace('`10-11`', lines).replace('`src/a.mjs`', `\`${file}\``);
  const { evidence } = await collect({ reviews: [review({ body })],
    ...(rebased ? {} : { shift: 0 }) });
  if (!rebased) evidence.reversalAuthorizations[0].rebased = false;
  if (single) {
    // Equal-length replacement: one reviewed file line is sufficient coverage.
    const authorization = evidence.reversalAuthorizations[0];
    for (const files of new Set([evidence.primaryFiles, authorization.reviewedFiles,
      authorization.parentFiles, authorization.commit.files])) {
      for (const entry of files) {
        entry.patch = entry.patch.replace(/^[+-]log_startup\(\)\n?/m, '')
          .replace(/(@@ -\d+),2/g, '$1').replace(/( \+\d+),2 @@/g, '$1 @@');
        if (files === authorization.commit.files) entry.deletions--;
        else entry.additions--;
      }
    }
  }
  return evidence;
}

function refused(evidence, reason) {
  const result = checkPrimaryChange(evidence, head);
  assert.equal(result.reason, 'primary-change-reverted');
  assert.ok(result.missingEvidence.rejected.some(entry => entry.reason === reason), JSON.stringify(result));
}

for (const lines of [
  '10-11', '`10-11`', '10–11', '`~10-11`', '~10–11',
  '2-4; 10-11; 30-40', '2-4, 10-11, 30-40',
  '`_budget_step` (post-diff ~30-40); `run_budget` re-raise (~10-11); `run_phase` (~50-60)',
  '`_handoff` `walk` injection (~30-40); `classify_results` (~10-11)',
  'handler_v2 (10-11)',
  'handler_v2 (2-4; 10-11; 30-40)', 'handler_v2 (2-4, 10-11, 30-40)',
  '10-11 (tested with exit code 0)', '10-11 (step-0)',
  '10-11 (regression from 2026-10-18)', '10-11; tested with exit code 0',
  '10-11; step-0; regression from 2026-10-18',
  '10-11 (caused by step-1, task-2 or LAC-1559)',
  '10-11 notes: exit code 0, attempt 3',
  '10-11: description',
  'foo(2-4), bar(10-11), baz(30-40)',
]) {
  test(`HAMLINES-01: cited range covers the reversed span: ${lines}`, async () => {
    for (const rebased of [false, true]) {
      const result = checkPrimaryChange(await reversal(lines, { rebased }), head);
      assert.equal(result.ok, true, JSON.stringify({ rebased, result }));
    }
  });
}

for (const lines of ['10', '`10`', '~10', '10: bug', 'handler_v2 (~10)', '10 (RIGHT side, diff line 90)',
  '10 (diff line 90)', '10 (RIGHT, diff line 90)', '10 (diff lines 90-100)']) {
  test(`HAMLINES-01: single file-line citation authorizes a single-line reversal: ${lines}`, async () => {
    assert.equal(checkPrimaryChange(await reversal(lines, { single: true }), head).ok, true);
  });
}

test('HAMLINES-01: uncovered ranges, gaps and approximate endpoints confer no extra coverage', async () => {
  for (const lines of ['2-4; 30-40', '2-4, 30-40', '9; 12', '~9', '~11-12',
    '`handler` (~30-40)', '10 (RIGHT side, diff line 11)', '90 (RIGHT side, diff line 10)']) {
    refused(await reversal(lines), 'not-covered-by-cited-finding');
  }
});

test('HAMLINES-01: colon notes and comma-separated symbols retain line-level coverage', async () => {
  for (const rebased of [false, true]) {
    for (const lines of ['30-40: description mentions 10-11', '42: bug',
      'foo(2-4), bar(30-40)', 'foo(2-4), bar(30-40); baz(50-60)',
      'foo(10), bar(11)']) {
      refused(await reversal(lines, { rebased }), 'not-covered-by-cited-finding');
    }
    refused(await reversal('0: invalid', { rebased }), 'finding-lines-invalid');
  }
});

test('HAMLINES-01: explanatory numbers and symbol suffixes confer no coverage', async () => {
  for (const rebased of [false, true]) {
    for (const note of ['step-10', 'task-10', 'LAC-10', 'exit code 10', 'attempt 10',
      'diff line 10', 'RIGHT, diff line 10', 'RIGHT side, diff line 10', 'diff lines 10-11',
      'handler (~10)', 'range 10-11']) {
      refused(await reversal(`30-40 (${note})`, { single: true, rebased }), 'not-covered-by-cited-finding');
      refused(await reversal(`30-40; ${note}`, { single: true, rebased }), 'not-covered-by-cited-finding');
    }
    // Legacy qualifiers may contain digits; only their parenthesized list cites lines.
    refused(await reversal('handler_v2 step-10 (30-40)', { single: true, rebased }),
      'not-covered-by-cited-finding');
  }
});

test('HAMLINES-01: a matching range cannot authorize another file', async () => {
  refused(await reversal('~10-11', { file: 'src/other.mjs' }), 'not-covered-by-cited-finding');
});

test('HAMLINES-01: invalid ranges remain rejected', async () => {
  for (const lines of ['0', '-1', '11-10', '10--11', '9007199254740992', '10-11; 0-4']) {
    refused(await reversal(lines), 'finding-lines-invalid');
  }
});

test('HAMLINES-01: unreadable lines allow only the matching reviewed changed code', async () => {
  for (const rebased of [false, true]) {
    const result = checkPrimaryChange(await reversal('unknown', { rebased }), head);
    assert.equal(result.ok, true, JSON.stringify({ rebased, result }));
    refused(await reversal('unknown', { file: 'src/other.mjs', rebased }),
      'finding-lines-unreadable: "unknown"');
  }
  const evidence = await reversal('unknown', { rebased: false });
  evidence.reversalAuthorizations[0].reviewedFiles = [];
  refused(evidence, 'finding-lines-unreadable: "unknown"');
});

test('HAMLINES-01: unreadable fallback uses base spans and original paths across head shifts and renames', async () => {
  const prefix = '@@ -0,0 +1,5 @@\n+one()\n+two()\n+three()\n+four()\n+five()';
  for (const rebased of [false, true]) {
    for (const renamed of [false, true]) {
      const evidence = await reversal('unknown', { rebased });
      const authorization = evidence.reversalAuthorizations[0];
      const filename = renamed ? 'src/renamed.mjs' : 'src/a.mjs';
      const metadata = { filename, status: renamed ? 'renamed' : 'modified',
        ...(renamed ? { previous_filename: 'src/a.mjs' } : {}) };
      for (const files of new Set([evidence.primaryFiles, authorization.parentFiles, authorization.reviewedFiles])) {
        const file = files[0];
        Object.assign(file, metadata, { additions: file.additions + 5,
          patch: `${prefix}\n${file.patch.replace(/(\+)(\d+)(,2 @@)/, (_, plus, line, suffix) =>
            `${plus}${Number(line) + 5}${suffix}`)}` });
      }
      evidence.finalFiles = [{ ...metadata, additions: 5, deletions: 0, patch: prefix }];
      const file = authorization.commit.files[0];
      file.filename = filename;
      file.patch = file.patch.replace(/@@ -(\d+),2 \+(\d+) @@/, (_, old, next) =>
        `@@ -${Number(old) + 5},2 +${Number(next) + 5} @@`);
      authorization.review.body = authorization.review.body.replace('`src/a.mjs`', `\`${filename}\``);
      // The changed base unit is half-open (10..11, or 15..16 after a
      // rebase). Its inclusive reviewed head span is 15..16. Segment lookup
      // must use the base unit and the pre-rename path, not that head span.
      assert.equal(checkPrimaryChange(evidence, head).ok, true, JSON.stringify({ rebased, renamed }));
      authorization.review.body = authorization.review.body.replace(`\`${filename}\``, '`src/other.mjs`');
      refused(evidence, 'finding-lines-unreadable: "unknown"');
    }
  }
});

test('HAMLINES-01: file-level fallback retains the HAM content coverage proof', async () => {
  const evidence = await reversal('unknown');
  evidence.reversalAuthorizations[0].commit.files[0].patch = '@@ -15,2 +15 @@\n-start_unsafe()\n+start()\n log_startup()';
  evidence.reversalAuthorizations[0].commit.files[0].deletions = 1;
  refused(evidence, 'hammer-patch-does-not-touch-region');
});

test('HAMLINES-01: actual harness rendering cites file lines and excludes diff indices', async () => {
  for (const kind of ['+', '-']) {
    const evidence = await reversal('10', { single: true });
    const authorization = evidence.reversalAuthorizations[0];
    authorization.review.body = harness.mergeChunkedAgyReviews([], { elisions: [{
      path: 'src/a.mjs', line: 10, side: 'RIGHT', diffLine: 90,
      kind, byteLength: 100, sha256: 'a'.repeat(64),
    }] });
    if (kind === '-') {
      authorization.commit.commit.message = authorization.commit.commit.message.replace('kind=blocking', 'kind=non-blocking');
    }
    assert.equal(checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: true }).ok, true);
    authorization.review.body = authorization.review.body.replace('**Lines:** 10 (', '**Lines:** 90 (')
      .replace('diff line 90)', 'diff line 10)');
    const result = checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: true });
    assert.equal(result.reason, 'primary-change-reverted');
    assert.ok(result.missingEvidence.rejected.some(entry => entry.reason === 'not-covered-by-cited-finding'));
  }
});
