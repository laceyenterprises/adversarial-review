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
]) {
  test(`HAMLINES-01: cited range covers the reversed span: ${lines}`, async () => {
    for (const rebased of [false, true]) {
      const result = checkPrimaryChange(await reversal(lines, { rebased }), head);
      assert.equal(result.ok, true, JSON.stringify({ rebased, result }));
    }
  });
}

for (const lines of ['10', '`10`', '~10', 'handler_v2 (~10)', '10 (RIGHT side, diff line 90)']) {
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
