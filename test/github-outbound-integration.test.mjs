import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postExactHeadReview } from '../src/reviewer-exact-head-post.mjs';
import { postGitHubReviewWithCapture } from '../src/reviewer.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { findCapturedReviewerBody } from '../src/review-body-capture.mjs';
import { reviewBodyDigest } from '../src/follow-up-review-claim.mjs';
import { postRemediationCommentWithCapture } from '../src/follow-up-remediation.mjs';
import { writeAdapterIssueComment, writeAdapterPullRequestReview } from '../src/github-adapter-client.mjs';
import { filterCreateBodyArgs } from '../src/adapters/subject/github-pr/pr-create-tagged.mjs';

const snapshotRoot = '/Users/example/state/reviewer-snapshots';
const local = `file://${snapshotRoot}/acme_widgets-0123456789ab/local-sha/src/example.mjs#L2`;
const head = 'a'.repeat(40);
const repo = 'acme/widgets';
const expectedLink = `https://github.com/${repo}/blob/${head}/src/example.mjs#L2`;
async function withWorkspaceEnv(fn) {
  const keys = ['ADVERSARIAL_REVIEW_WORKSPACE_STATE_DIR', 'GH_CODEX_REVIEWER_TOKEN', 'GHA_ADAPTER_BIN'];
  const old = keys.map((key) => process.env[key]);
  process.env.ADVERSARIAL_REVIEW_WORKSPACE_STATE_DIR = '/Users/example/state';
  process.env.GH_CODEX_REVIEWER_TOKEN = 'synthetic-token';
  process.env.GHA_ADAPTER_BIN = '/synthetic/github-adapter';
  try { return await fn(); } finally {
    keys.forEach((key, index) => { if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index]; });
  }
}
test('review body, inline body and reviewed SHA are filtered at the exact-head write', async () => {
  await withWorkspaceEnv(async () => {
    let payload;
    await postExactHeadReview({
      repo, prNumber: 1, reviewerHeadSha: head, reviewBody: `[example](${local})`,
      comments: [{ path: 'src/example.mjs', line: 2, body: `[inline](${local})` }],
      execFileImpl: async (_command, _args, options) => { payload = JSON.parse(options.input); return { stdout: '{}' }; },
    });
    assert.equal(payload.body, `[example](${expectedLink})`);
    assert.deepEqual(payload.comments, [{ path: 'src/example.mjs', line: 2, body: `[inline](${expectedLink})` }]);
    assert.equal(payload.commit_id, head);
  });
});
test('posted, SQLite captured, attested and digested review text is identical', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'outbound-review-'));
  try {
    await withWorkspaceEnv(async () => {
      beginReviewerPass(rootDir, { repo, prNumber: 1, attemptNumber: 1, passKind: 'first-pass', reviewerModel: 'codex', headSha: head });
      const body = `## Blocking issues\n- File [example](${local})\n\n## Verdict\nRequest changes`;
      const expected = body.replace(local, expectedLink);
      let posted, attested;
      await postGitHubReviewWithCapture({
        rootDir, repo, prNumber: 1, attemptNumber: 1, passKind: 'first-pass',
        reviewerModel: 'codex', reviewerHeadSha: head, reviewBody: body,
        botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN', prepareReviewWrite: async () => {},
        findCapturedReviewerBodyImpl: () => null, findPendingReviewerBodyCaptureImpl: () => null,
        execFileImpl: async (command, args, options) => {
          assert.equal(command, 'gh');
          assert.equal(args[0], 'api');
          posted = JSON.parse(options.input).body;
          assert.equal(JSON.parse(options.input).commit_id, head);
          return { stdout: JSON.stringify({ id: 1, commit_id: head }) };
        },
        emitReviewedAttestationImpl: async (args) => { attested = args.reviewBody; },
      });
      const stored = findCapturedReviewerBody(rootDir, { repo, prNumber: 1, attemptNumber: 1, passKind: 'first-pass', reviewerModel: 'codex', headSha: head });
      assert.equal(posted, expected);
      assert.equal(stored, expected);
      assert.equal(attested, expected);
      assert.equal(reviewBodyDigest(stored), createHash('sha256').update(expected).digest('hex'));
      assert.equal(reviewBodyDigest(body, { repo, reviewerHeadSha: head }), reviewBodyDigest(stored));
    });
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
test('adapter review writes preserve either head SHA option and produce GitHub blob links', async () => {
  await withWorkspaceEnv(async () => {
    for (const shaOptions of [{ headSha: head }, { reviewerHeadSha: head }]) {
      let args;
      const result = await writeAdapterPullRequestReview(repo, 1, { body: `[example](${local})` }, {
        ...shaOptions,
        execFileImpl: async (_command, value) => { args = value; return { stdout: '{"ok":true}' }; },
      });
      assert.equal(result.ran, true);
      assert.equal(args[args.indexOf('--body') + 1], `[example](${expectedLink})`);
      assert.equal(args[args.indexOf('--head-sha') + 1], head);
    }
  });
});
test('remediation post and capture receive the same filtered body', async () => {
  await withWorkspaceEnv(async () => {
    let posted, stored;
    await postRemediationCommentWithCapture({
      rootDir: '/home/example/state/service', repo, prNumber: 1, attemptNumber: 1,
      workerClass: 'codex', body: `${local} /home/example/state/service/work.txt`,
      postCommentImpl: async (args) => { posted = args.body; return { posted: true }; },
      captureImpl: async (_root, args) => { stored = args.body; },
    });
    assert.equal(posted, 'src/example.mjs#L2 <local>/work.txt');
    assert.equal(stored, posted);
  });
});
test('adapter PR comment and create helper text/file bodies use the filter', async () => {
  await withWorkspaceEnv(async () => {
    let args;
    await writeAdapterIssueComment(repo, 1, { body: `[example](${local})` }, {
      rootDir: '/home/example/state/service',
      execFileImpl: async (_command, value) => { args = value; return { stdout: '{"ok":true}' }; },
    });
    assert.equal(args[args.indexOf('--body') + 1], '[example](src/example.mjs#L2)');
    for (const input of [['--body', local], ['--body-file', 'synthetic.md'], ['--body-file=-']]) {
      assert.deepEqual(filterCreateBodyArgs(input, () => local), ['--body', 'src/example.mjs#L2']);
    }
  });
});
