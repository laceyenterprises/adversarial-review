import './helpers/review-cli-resolver-fixture.mjs';
import './helpers/registry-session-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReviewBaseSha, loadReviewGeneratedPaths, summariseReviewDiff, reviewManifestText,
  discloseReviewManifest, retryLargeReview } from '../src/reviewer-large-diff.mjs';
import { ReviewerPromptTooLargeError, ReviewerSizeRecoveryExhaustedError, reviewerExecutionFailureExitCode } from '../src/reviewer-outcomes.mjs';
import { validateReviewerReply } from '../src/kernel/review-reply.mjs';
import { extractReviewVerdict } from '../src/kernel/verdict.mjs';
import { reviewAgyOversizedInChunks, resolveAgyOversizedReviewRoute } from '../src/reviewer-harness.mjs';

const baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40);
const clean = '## Summary\nReviewed the supplied changes.\n\n## Blocking issues\n- None.\n\n## Non-blocking issues\n- None.\n\n## Suggested fixes\n- None.\n\n## Verdict\nComment only';
function wholeFile(path, content, side = '+') {
  const count = content.split('\n').length - 1;
  return `diff --git a/${path} b/${path}\n${side === '+' ? 'new' : 'deleted'} file mode 100644\n`
    + `--- ${side === '+' ? '/dev/null' : `a/${path}`}\n+++ ${side === '+' ? `b/${path}` : '/dev/null'}\n`
    + `@@ -${side === '+' ? '0,0' : `1,${count}`} +${side === '+' ? `1,${count}` : '0,0'} @@\n`
    + content.trimEnd().split('\n').map(line => side + line).join('\n') + '\n';
}

test('base resolution binds the declaration read to the reviewed head, never a moving branch', async () => {
  let args;
  const execGhImpl = async options => { args = options.args; return { stdout: JSON.stringify({ baseSha, headSha }) }; };
  assert.equal(await resolveReviewBaseSha({ repo: 'example/project', prNumber: 7, headSha, execGhImpl }), baseSha);
  assert.deepEqual(args.slice(0, 2), ['api', 'repos/example/project/pulls/7']);
  assert.equal(await resolveReviewBaseSha({ repo: 'example/project', prNumber: 7,
    headSha: 'c'.repeat(40), execGhImpl }), null);
  assert.equal(await resolveReviewBaseSha({ execGhImpl: async () => { throw new Error('unavailable'); } }), null);
});

test('generated declaration is exact, base-pinned and fails closed', async () => {
  const calls = [];
  const fetchFileImpl = async (...args) => { calls.push(args); return '{"generatedPaths":["fixtures/data.json"]}'; };
  assert.deepEqual(await loadReviewGeneratedPaths({ repo: 'example/project', baseSha, fetchFileImpl }), ['fixtures/data.json']);
  assert.deepEqual(calls, [['example/project', '.github/review-generated-paths.json', baseSha]]);
  assert.deepEqual(await loadReviewGeneratedPaths({ baseSha: 'main', fetchFileImpl }), []);
  for (const value of ['{}', '{"generatedPaths":["src/**"]}', '{"generatedPaths":["../code"]}', '{']) {
    assert.deepEqual(await loadReviewGeneratedPaths({ baseSha, fetchFileImpl: async () => value }), []);
  }
});

test('large generated diff becomes a hashed manifest while code stays inline and fits', async () => {
  const content = 'synthetic generated record\n'.repeat(18000);
  const code = wholeFile('src/logic.mjs', 'export const answer = 42;\n');
  const diff = wholeFile('fixtures/generated.json', content) + code;
  const prepared = await summariseReviewDiff({ diff, baseSha, headSha,
    generatedPaths: ['fixtures/generated.json'], fetchFileImpl: async () => content });
  assert.equal(prepared.diff, code);
  assert.equal(prepared.manifest[0].added, 18000);
  assert.equal(prepared.manifest[0].sha256, createHash('sha256').update(content).digest('hex'));
  const budget = input => resolveAgyOversizedReviewRoute({ reviewerModel: 'codex', diff: input, extraContext: '' }).oversized;
  assert.equal(budget(diff), true);
  assert.equal(budget(prepared.diff + reviewManifestText(prepared.manifest)), false);
  const retained = await summariseReviewDiff({ diff, generatedPaths: ['fixtures/generated.json'],
    fetchFileImpl: async () => { throw new Error('unreadable'); } });
  assert.equal(retained.diff, diff);
});

test('one-to-many split requires exact, complete, non-overlapping content coverage', async () => {
  const left = 'alpha\nbeta\n', right = 'gamma\ndelta\n';
  const diff = wholeFile('fixtures/all.txt', left + right, '-')
    + wholeFile('fixtures/left.txt', left) + wholeFile('fixtures/right.txt', right);
  const prepared = await summariseReviewDiff({ diff, minDiffBytes: 0 });
  assert.equal(prepared.diff, '');
  assert.equal(prepared.manifest.length, 3);
  assert.ok(prepared.manifest.every(entry => entry.movedFrom === 'fixtures/all.txt'));
  assert.match(reviewManifestText(prepared.manifest), /moved from fixtures\/all.txt/);
  for (const changed of [
    diff.replace('+delta', '+changed'),
    diff + wholeFile('fixtures/duplicate.txt', left),
    diff.replace('new file mode 100644', 'new file mode 100755'),
    diff.replaceAll('\n', '\r\n'),
    diff.replace('+delta', '+\ufffd'),
  ]) {
    const retained = await summariseReviewDiff({ diff: changed, minDiffBytes: 0 });
    assert.equal(retained.diff, changed);
    assert.deepEqual(retained.manifest, []);
  }
});

test('git rename and copy detection independently verifies identical blob hashes', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'review-moves-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Synthetic Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(cwd, 'old.txt'), 'unchanged content\n');
  git('add', 'old.txt'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  renameSync(join(cwd, 'old.txt'), join(cwd, 'new.txt'));
  writeFileSync(join(cwd, 'copy.txt'), 'unchanged content\n');
  git('add', '-A'); git('commit', '-qm', 'move and copy');
  const head = git('rev-parse', 'HEAD');
  const diff = execFileSync('git', ['diff', '--no-renames', base, head], { cwd, encoding: 'utf8' });
  const prepared = await summariseReviewDiff({ diff, minDiffBytes: 0, cwd, baseSha: base, headSha: head });
  assert.equal(prepared.diff, '');
  assert.equal(prepared.manifest.length, 3);
  assert.ok(prepared.manifest.every(entry => entry.movedFrom === 'old.txt'));
});

test('rename metadata with different content hashes never exempts code', async () => {
  const diff = wholeFile('old.mjs', 'old code\n', '-') + wholeFile('new.mjs', 'new code\n');
  const prepared = await summariseReviewDiff({ diff, minDiffBytes: 0, cwd: '.', baseSha, headSha,
    execFileImpl: async (_cmd, args) => ({ stdout: args[0] === 'diff'
      ? 'diff --git a/old.mjs b/new.mjs\nsimilarity index 100%\nrename from old.mjs\nrename to new.mjs\n'
      : args[1].startsWith(baseSha) ? 'old code\n' : 'new code\n' }) });
  assert.equal(prepared.diff, diff);
  assert.deepEqual(prepared.manifest, []);
});

test('API rename metadata is verified at both pinned revisions without a local checkout', async () => {
  const diff = 'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n';
  const reads = [];
  const prepared = await summariseReviewDiff({ diff, minDiffBytes: 0, baseSha, headSha, repo: 'example/project',
    fetchFileImpl: async (_repo, path, ref) => { reads.push([path, ref]); return 'identical\n'; } });
  assert.equal(prepared.diff, '');
  assert.equal(prepared.manifest[0].movedFrom, 'old.txt');
  assert.deepEqual(reads, [['old.txt', baseSha], ['new.txt', headSha]]);
  const retained = await summariseReviewDiff({ diff, minDiffBytes: 0, baseSha, headSha,
    fetchFileImpl: async () => '\ufffd' });
  assert.equal(retained.diff, diff, 'lossy binary decoding cannot prove identical bytes');
});

test('a reused move source retains its new code diff', async () => {
  const modifiedSource = 'diff --git a/old.mjs b/old.mjs\n--- a/old.mjs\n+++ b/old.mjs\n@@ -1 +1 @@\n-old code\n+new code\n';
  const diff = modifiedSource + wholeFile('new.mjs', 'old code\n');
  const prepared = await summariseReviewDiff({ diff, minDiffBytes: 0, cwd: '.', baseSha, headSha,
    execFileImpl: async (_cmd, args) => ({ stdout: args[0] === 'diff'
      ? 'diff --git a/old.mjs b/new.mjs\nsimilarity index 100%\nrename from old.mjs\nrename to new.mjs\n'
      : 'old code\n' }) });
  assert.equal(prepared.diff, modifiedSource);
  assert.equal(prepared.manifest.length, 1);
  assert.equal(prepared.manifest[0].path, 'new.mjs');
});

test('small diffs retain inline review without copy search or blob reads', async () => {
  const diff = wholeFile('fixtures/generated.json', 'small generated content\n');
  const prepared = await summariseReviewDiff({ diff, cwd: '.', baseSha, headSha,
    generatedPaths: ['fixtures/generated.json'],
    execFileImpl: () => assert.fail('small review must not search copies'),
    fetchFileImpl: () => assert.fail('small review must not inspect blobs'),
  });
  assert.deepEqual(prepared, { diff, manifest: [] });
});

test('fitting raw reviews never summarise or chunk', async () => {
  assert.equal(await retryLargeReview({ run: async () => clean,
    summarise: () => assert.fail('raw prompt fits'), chunk: () => assert.fail('raw prompt fits'),
  }), clean);
});

test('only a typed size failure after chunk recovery becomes terminal', async () => {
  const initial = new ReviewerPromptTooLargeError('initial preflight');
  const prepared = { diff: '+small', manifest: [] };
  assert.equal(reviewerExecutionFailureExitCode(initial), 76);
  await assert.rejects(retryLargeReview({ run: () => { throw initial; },
    summarise: () => { throw initial; }, chunk: () => assert.fail('no summary available'),
  }), error => error === initial && reviewerExecutionFailureExitCode(error) === 76);
  await assert.rejects(retryLargeReview({ run: () => { throw initial; },
    summarise: () => prepared, chunk: () => { throw new ReviewerPromptTooLargeError('chunk cap exhausted'); },
  }), error => error instanceof ReviewerSizeRecoveryExhaustedError
    && reviewerExecutionFailureExitCode(error) === 77 && /chunk cap exhausted/.test(error.message));
  const transient = new Error('transient chunk failure');
  await assert.rejects(retryLargeReview({ run: () => { throw initial; },
    summarise: () => prepared, chunk: () => { throw transient; },
  }), error => error === transient && reviewerExecutionFailureExitCode(error) === 1);
});

test('size failure retries summarisation, then chunking; ordinary failures never do', async () => {
  const prepared = { diff: '+small', manifest: [] }, calls = [];
  const result = await retryLargeReview({
    run: async input => { calls.push(input ? 'summarised' : 'initial'); if (!input) throw new ReviewerPromptTooLargeError('synthetic'); return clean; },
    summarise: async () => prepared,
    chunk: () => assert.fail('summary fits'),
  });
  assert.equal(result, clean);
  assert.deepEqual(calls, ['initial', 'summarised']);
  assert.equal(await retryLargeReview({
    run: async () => { throw new ReviewerPromptTooLargeError('still too large'); },
    summarise: async () => prepared, chunk: input => { assert.equal(input, prepared); return 'chunked'; },
  }), 'chunked');
  await assert.rejects(retryLargeReview({ run: async () => { throw new Error('[reviewer-prompt-too-large] quoted'); },
    summarise: () => assert.fail(), chunk: () => assert.fail() }), /quoted/);
});

test('deterministic code chunks preserve a blocking finding and posted scope disclosure', async () => {
  const diff = Array.from({ length: 3 }, (_, i) => wholeFile(`src/file${i}.mjs`,
    `export const value${i} = 1;\n`.repeat(2500))).join('');
  const seen = [];
  const options = {
    reviewerModel: 'codex', maxBytes: 120000, maxChunks: 20,
    dispatchReviewerModelImpl: async (_model, chunk) => {
      seen.push(chunk);
      return { reviewText: chunk.includes('src/file1.mjs')
        ? clean.replace('- None.', '- **Synthetic defect**\n  - **File:** src/file1.mjs\n  - **Lines:** 4\n  - **Problem:** A synthetic blocking defect.\n  - **Why it matters:** Incorrect output.\n  - **Recommended fix:** Correct the output.').replace('Comment only', 'Request changes')
        : clean };
    },
  };
  const result = await reviewAgyOversizedInChunks(diff, '', options);
  assert.equal(result.chunked, true);
  assert.ok(seen.length > 1);
  assert.match(result.reviewText, /## Verdict\nRequest changes/);
  assert.match(result.reviewText, /File:\*\* src\/file1.mjs/);
  assert.match(result.reviewText, /Lines:\*\* 4/);
  const manifest = [{ path: 'fixtures/generated.json', added: 20000, removed: 0, sha256: '0'.repeat(64), reason: 'declared generated path' }];
  const posted = discloseReviewManifest(result.reviewText, manifest);
  assert.match(posted, /bounded reviewer chunks/);
  assert.match(posted, /summarisation of declared generated paths/);
  assert.equal(discloseReviewManifest(posted, manifest), posted);
  assert.equal(validateReviewerReply(posted).ok, true);
  assert.equal(extractReviewVerdict(posted), 'Request changes');
  const first = [...seen]; seen.length = 0;
  await reviewAgyOversizedInChunks(diff, '', options);
  assert.deepEqual(seen, first);
  await assert.rejects(reviewAgyOversizedInChunks(diff, '', { ...options, maxChunks: 1 }),
    error => error instanceof ReviewerPromptTooLargeError && /chunking unavailable/.test(error.message));
});

test('manifest remains inside Summary and preserves canonical verdicts and advisory', () => {
  const manifest = [{ path: 'fixtures/generated.json', sha256: '0'.repeat(64) }];
  for (const advisory of ['', '\n\n## Simplicity and cost (advisory)\nKeep the existing approach.']) {
    const posted = discloseReviewManifest(clean + advisory, manifest);
    assert.equal(validateReviewerReply(posted).ok, true);
    assert.equal(extractReviewVerdict(posted), 'Comment only');
    assert.ok(posted.indexOf('```json') > posted.indexOf('## Summary'));
    assert.ok(posted.indexOf('```json') < posted.indexOf('## Blocking issues'));
    assert.equal(discloseReviewManifest(posted, manifest), posted);
  }
});
