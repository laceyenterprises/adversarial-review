import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { collect, review } from './helpers/hamclose-history.mjs';
import { checkPrimaryChange } from '../src/ama/primary-change.mjs';
import { __test__ as harness } from '../src/reviewer-harness.mjs';

const head = 'c'.repeat(40);

async function reversal(lines, { single = false, file = 'src/a.mjs', rebased = true } = {}) {
  let body = review().body.replace('`10-11`', lines ?? '').replace('`src/a.mjs`', `\`${file}\``);
  if (lines === undefined) body = body.replace(/  - \*\*Lines:\*\*.*\n/, '');
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
  'L10-L11', 'lines 10-11', 'line 10-11', 'src/a.mjs:10-11', '10..11',
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

for (const lines of ['L10', '#L10', 'line 10', 'src/a.mjs:10', '10', '`10`', '~10', '10: bug', 'handler_v2 (~10)', '10 (RIGHT side, diff line 90)',
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

test('HAMLINES-01: unreadable and oversized coordinates refuse reversal authority', async () => {
  for (const rebased of [false, true]) {
    for (const lines of ['unknown', 'N/A', 'entire function', '', undefined,
      'unknown (RIGHT side, diff line 10)', 'src/other.mjs:10-11',
      'a'.repeat(50000), ' '.repeat(50000), `10-11; ${'x'.repeat(512)}; 0`]) {
      refused(await reversal(lines, { rebased }),
        `finding-lines-unreadable: ${JSON.stringify(String(lines || '').trim().slice(0, 200))}`);
    }
  }
});

test('HAMLINES-01: a citation never authorizes a second uncited segment in the same file', async () => {
  const retained = '@@ -10 +10 @@\n-safe()\n+fixed()';
  for (const lines of ['10', 'L10', '#L10', 'lines 10-11', 'src/a.mjs:10-11',
    '10..11', 'unknown', '', undefined]) {
    for (const rebased of [false, true]) {
      const evidence = await reversal(lines, { rebased });
      const authorization = evidence.reversalAuthorizations[0];
      // Two changed segments: HAM keeps line 10 and reverts line 300.
      for (const files of new Set([evidence.primaryFiles, authorization.reviewedFiles,
        authorization.parentFiles, authorization.commit.files])) {
        const file = files[0];
        file.patch = file.patch.replace(/@@ -(\d+)(,?\d*) \+(\d+)(,?\d*) @@/g,
          (_, old, oldCount, next, nextCount) =>
            `@@ -${Number(old) + 290}${oldCount} +${Number(next) + 290}${nextCount} @@`);
        if (files !== authorization.commit.files) {
          file.patch = `${retained}\n${file.patch}`;
          file.additions++;
          file.deletions++;
        }
      }
      evidence.finalFiles = [{ filename: 'src/a.mjs', status: 'modified',
        additions: 1, deletions: 1, patch: retained }];
      // A correct citation must succeed, so refusal cannot be a broken fixture.
      const originalBody = authorization.review.body;
      authorization.review = { ...authorization.review,
        body: review().body.replace('`10-11`', '`300-301`') };
      assert.equal(checkPrimaryChange(evidence, head).ok, true);
      authorization.review = { ...authorization.review, body: originalBody };
      refused(evidence, ['unknown', '', undefined].includes(lines)
        ? `finding-lines-unreadable: ${JSON.stringify(lines || '')}`
        : 'not-covered-by-cited-finding');
    }
  }
});

test('HAMLINES-01: precise citations retain the HAM content coverage proof', async () => {
  const evidence = await reversal('10-11');
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

test('LAC-2101 #9097: exact secondary Lines path and literal File brace list authorize only their own ranges', async () => {
  const { readFileSync } = await import('node:fs');
  const saved = JSON.parse(readFileSync(new URL('./fixtures/lac-2101-preservation.json', import.meta.url)));
  const card = saved['9097'].finding;
  for (const braces of [false, true]) {
    const body = `## Blocking issues\n- None.\n## Non-blocking issues\n${braces
      ? card.replace('`modules/worker-pool/post-merge-verify.json`', '`modules/worker-pool/{post-merge-verify,state-machines}.json`')
        .replace('3-3; modules/worker-pool/state-machines.json:3-3', '3-3') : card}\n## Verdict\nComment only`;
    const { evidence } = await collect({ shift: 0, reviews: [review({ body })],
      cites: ['PRR_cited finding=1 kind=non-blocking'] });
    const authorization = evidence.reversalAuthorizations[0];
    authorization.rebased = false;
    const primary = path => ({ filename: path, status: 'modified', additions: 1, deletions: 0,
      patch: '@@ -2,0 +3 @@\n+  "docsFastPath": "unchanged",' });
    const paths = ['modules/worker-pool/post-merge-verify.json', 'modules/worker-pool/state-machines.json'];
    evidence.primaryFiles = paths.map(primary);
    authorization.reviewedFiles = paths.map(primary);
    authorization.parentFiles = paths.map(primary);
    authorization.commit.files = paths.map(filename => ({ filename, status: 'modified', additions: 0, deletions: 1,
      patch: '@@ -3 +2,0 @@\n-  "docsFastPath": "unchanged",' }));
    assert.equal(checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: true }).ok, true);
    assert.equal(checkPrimaryChange(evidence, head, { strictNonBlockingRemediation: false }).reason, 'primary-change-reverted');
    for (const mutate of [
      e => { e.reversalAuthorizations[0].review.body = body.replaceAll('state-machines', 'unrelated'); },
      e => { e.reversalAuthorizations[0].review.body = body.replaceAll('3-3', '4-4'); },
      e => { e.reversalAuthorizations[0].commit.author.login = 'foreign-author'; },
      e => { e.reversalAuthorizations[0].commit.files.pop(); },
      e => { e.primaryFiles.push(primary('modules/worker-pool/unrelated.json')); },
    ]) {
      const bad = structuredClone(evidence); mutate(bad);
      assert.equal(checkPrimaryChange(bad, head, { strictNonBlockingRemediation: true }).reason, 'primary-change-reverted');
    }
  }
});

test('LAC-2101: secondary path grammar never resumes inside notes or borrows another path range', async () => {
  for (const lines of [
    '30-40; src/other.mjs:10-11', '30-40; note: src/a.mjs:10-11',
    '30-40 (src/a.mjs:10-11)', '30-40; step-1; src/a.mjs:10-11',
    '30-40; src/{a,../other}.mjs:10-11', '30-40; src/*.mjs:10-11',
  ]) assert.equal(checkPrimaryChange(await reversal(lines), head).reason, 'primary-change-reverted', lines);
});
