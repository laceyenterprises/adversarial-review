import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { extractReviewVerdict, normalizeReviewVerdict } from '../src/kernel/verdict.mjs';
import { postRemediationCommentWithCapture } from '../src/follow-up-remediation.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { __test__ as reviewerTest } from '../src/reviewer.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { captureRemediationBodyAfterPost } from '../src/review-body-capture.mjs';

const { postGitHubReviewWithCapture } = reviewerTest;

function makeRootDir() {
  return mkdtempSync(path.join(tmpdir(), 'adversarial-review-body-capture-'));
}

function seedPass(rootDir, {
  repo = 'laceyenterprises/adversarial-review',
  prNumber = 42,
  attemptNumber = 1,
  reviewerClass = 'codex',
  reviewerModel = reviewerClass,
  passKind = 'first-pass',
  startedAt = '2026-05-29T12:00:00.000Z',
} = {}) {
  beginReviewerPass(rootDir, {
    repo,
    prNumber,
    attemptNumber,
    reviewerClass,
    reviewerModel,
    passKind,
    startedAt,
  });
  return { repo, prNumber, attemptNumber, passKind };
}

function readPass(rootDir, { repo, prNumber, attemptNumber, passKind }) {
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    return db.prepare(
      `SELECT verdict, body_md, gh_comment_id, body_captured_at
         FROM reviewer_passes
        WHERE repo = ? AND pr_number = ? AND attempt_number = ? AND pass_kind = ?`
    ).get(repo, prNumber, attemptNumber, passKind);
  } finally {
    db.close();
  }
}

async function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeLog() {
  const warnings = [];
  const errors = [];
  return {
    warnings,
    errors,
    warn(message) { warnings.push(String(message)); },
    error(message) { errors.push(String(message)); },
  };
}

test('normalizeReviewVerdict handles comment-only and request-changes fixtures', () => {
  assert.equal(normalizeReviewVerdict(extractReviewVerdict('## Verdict\n\nComment only')), 'comment-only');
  assert.equal(normalizeReviewVerdict(extractReviewVerdict('## Verdict\n\nRequest changes')), 'request-changes');
});

test('reviewer happy path captures verdict, body, gh_comment_id, and timestamp', async () => {
  const rootDir = makeRootDir();
  const pass = seedPass(rootDir, { passKind: 'first-pass', reviewerClass: 'codex' });
  const reviewBody = '## Verdict\n\nComment only\n\nBody text';
  const calls = [];

  await withEnv({ GH_CODEX_REVIEWER_TOKEN: 'token' }, () => postGitHubReviewWithCapture({
    rootDir,
    repo: pass.repo,
    prNumber: pass.prNumber,
    attemptNumber: pass.attemptNumber,
    reviewerModel: 'codex',
    reviewBody,
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    passKind: 'first-pass',
    postedAt: '2026-05-29T12:01:00.000Z',
    execFileImpl: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === 'pr' && args[1] === 'review') return { stdout: '', stderr: '' };
      return {
        stdout: `${JSON.stringify({ id: 501, login: 'codex-reviewer-lacey', created_at: '2026-05-29T12:00:30.000Z', body: reviewBody })}\n`,
        stderr: '',
      };
    },
  }));

  const row = readPass(rootDir, pass);
  assert.equal(row.verdict, 'comment-only');
  assert.equal(row.body_md, reviewBody);
  assert.equal(row.gh_comment_id, '501');
  assert.ok(row.body_captured_at);
  assert.equal(calls[0][1], 'pr');
  assert.equal(calls[1][1], 'api');
});

test('shared pre-write helper runs before the GitHub review mutation', async () => {
  const rootDir = makeRootDir();
  const pass = seedPass(rootDir, { reviewerClass: 'claude' });
  const events = [];

  await withEnv({ GH_CLAUDE_REVIEWER_TOKEN: 'token' }, () => postGitHubReviewWithCapture({
    rootDir,
    repo: pass.repo,
    prNumber: pass.prNumber,
    attemptNumber: pass.attemptNumber,
    reviewerModel: 'claude',
    reviewBody: '## Verdict\n\nComment only\n\nOrdered write',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    passKind: 'first-pass',
    postedAt: '2026-05-29T12:01:00.000Z',
    prepareReviewWrite: async (payload) => {
      events.push({ kind: 'prepare', payload });
      return { cleared: 0, listed: 0 };
    },
    execFileImpl: async (_command, args) => {
      events.push({ kind: 'exec', args });
      if (args[0] === 'pr' && args[1] === 'review') return { stdout: '', stderr: '' };
      return {
        stdout: `${JSON.stringify({ id: 911, login: 'claude-reviewer-lacey', created_at: '2026-05-29T12:00:30.000Z', body: '## Verdict\n\nComment only\n\nOrdered write' })}\n`,
        stderr: '',
      };
    },
  }));

  assert.equal(events[0].kind, 'prepare');
  assert.deepEqual(events[1], {
    kind: 'exec',
    args: ['pr', 'review', String(pass.prNumber), '--repo', pass.repo, '--comment', '--body', '## Verdict\n\nComment only\n\nOrdered write'],
  });
});

test('reviewer recapture is idempotent and preserves the first stored body', async () => {
  const rootDir = makeRootDir();
  const pass = seedPass(rootDir, { passKind: 'rereview', reviewerClass: 'codex' });
  const firstBody = '## Verdict\n\nRequest changes\n\nFirst body';
  const secondBody = '## Verdict\n\nComment only\n\nSecond body';

  await withEnv({ GH_CODEX_REVIEWER_TOKEN: 'token' }, async () => {
    await postGitHubReviewWithCapture({
      rootDir,
      repo: pass.repo,
      prNumber: pass.prNumber,
      attemptNumber: pass.attemptNumber,
      reviewerModel: 'codex',
      reviewBody: firstBody,
      botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
      passKind: 'rereview',
      postedAt: '2026-05-29T12:01:00.000Z',
      execFileImpl: async (_command, args) => (
        args[0] === 'pr'
          ? { stdout: '', stderr: '' }
          : { stdout: `${JSON.stringify({ id: 700, login: 'codex-reviewer-lacey', created_at: '2026-05-29T12:00:30.000Z', body: firstBody })}\n` }
      ),
    });

    await postGitHubReviewWithCapture({
      rootDir,
      repo: pass.repo,
      prNumber: pass.prNumber,
      attemptNumber: pass.attemptNumber,
      reviewerModel: 'codex',
      reviewBody: secondBody,
      botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
      passKind: 'rereview',
      postedAt: '2026-05-29T12:01:30.000Z',
      execFileImpl: async (_command, args) => (
        args[0] === 'pr'
          ? { stdout: '', stderr: '' }
          : { stdout: `${JSON.stringify({ id: 701, login: 'codex-reviewer-lacey', created_at: '2026-05-29T12:01:00.000Z', body: secondBody })}\n` }
      ),
    });
  });

  const row = readPass(rootDir, pass);
  assert.equal(row.verdict, 'request-changes');
  assert.equal(row.body_md, firstBody);
  assert.equal(row.gh_comment_id, '700');
});

test('reviewer capture still stores body when gh review-id lookup fails', async () => {
  const rootDir = makeRootDir();
  const pass = seedPass(rootDir, { reviewerClass: 'claude' });
  const reviewBody = '## Verdict\n\nRequest changes\n\nNeeds work';
  const log = makeLog();

  await withEnv({ GH_CLAUDE_REVIEWER_TOKEN: 'token' }, () => postGitHubReviewWithCapture({
    rootDir,
    repo: pass.repo,
    prNumber: pass.prNumber,
    attemptNumber: pass.attemptNumber,
    reviewerModel: 'claude',
    reviewBody,
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    passKind: 'first-pass',
    postedAt: '2026-05-29T12:01:00.000Z',
    log,
    execFileImpl: async (_command, args) => {
      if (args[0] === 'pr') return { stdout: '', stderr: '' };
      throw new Error('lookup exploded');
    },
  }));

  const row = readPass(rootDir, pass);
  assert.equal(row.body_md, reviewBody);
  assert.equal(row.verdict, 'request-changes');
  assert.equal(row.gh_comment_id, null);
  assert.match(log.warnings.join('\n'), /review-id lookup failed/);
});

test('reviewer lookup paginates through busy PR history and still finds the matching review', async () => {
  const rootDir = makeRootDir();
  const pass = seedPass(rootDir, { reviewerClass: 'codex' });
  const reviewBody = '## Verdict\n\nComment only\n\nBuried review';
  const noise = Array.from({ length: 105 }, (_, index) => JSON.stringify({
    id: index + 1,
    login: index < 5 ? 'codex-reviewer-lacey' : 'human-reviewer',
    created_at: `2026-05-29T11:${String(index % 60).padStart(2, '0')}:00.000Z`,
    body: `noise-${index}`,
  })).join('\n');

  await withEnv({ GH_CODEX_REVIEWER_TOKEN: 'token' }, () => postGitHubReviewWithCapture({
    rootDir,
    repo: pass.repo,
    prNumber: pass.prNumber,
    attemptNumber: pass.attemptNumber,
    reviewerModel: 'codex',
    reviewBody,
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    passKind: 'first-pass',
    postedAt: '2026-05-29T12:01:00.000Z',
    execFileImpl: async (_command, args) => (
      args[0] === 'pr'
        ? { stdout: '', stderr: '' }
        : { stdout: `${noise}\n${JSON.stringify({ id: 999, login: 'codex-reviewer-lacey', created_at: '2026-05-29T12:00:45.000Z', body: reviewBody })}\n` }
    ),
  }));

  const row = readPass(rootDir, pass);
  assert.equal(row.gh_comment_id, '999');
});

test('sqlite write failure does not block gh review posting', async () => {
  const tempDir = makeRootDir();
  const bogusRoot = path.join(tempDir, 'not-a-dir');
  writeFileSync(bogusRoot, 'x', 'utf8');
  const log = makeLog();
  const calls = [];

  await withEnv({ GH_CODEX_REVIEWER_TOKEN: 'token' }, () => postGitHubReviewWithCapture({
    rootDir: bogusRoot,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 42,
    attemptNumber: 1,
    reviewerModel: 'codex',
    reviewBody: '## Verdict\n\nComment only',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    postedAt: '2026-05-29T12:01:00.000Z',
    log,
    execFileImpl: async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: '', stderr: '' };
    },
  }));

  assert.equal(calls.length >= 1, true);
  assert.equal(calls[0][1], 'pr');
  assert.match(log.warnings.join('\n'), /review body capture failed/);
});

test('reviewer capture absorbs slow GH propagation past the legacy 15s forward bound', async () => {
  // Pre-RBP-02 fix, the candidate window allowed at most +15s past
  // postedAt. On slow runners / GH side delay, the artifact lands well
  // past that, so the match was dropped and gh_comment_id stayed NULL.
  // After the fix, the forward window is 5min so the artifact still
  // matches even when GitHub stamps it ~90s after our post call returns.
  const rootDir = makeRootDir();
  const pass = seedPass(rootDir, { passKind: 'first-pass', reviewerClass: 'codex' });
  const reviewBody = '## Verdict\n\nComment only\n\nSlow propagation body';

  await withEnv({ GH_CODEX_REVIEWER_TOKEN: 'token' }, () => postGitHubReviewWithCapture({
    rootDir,
    repo: pass.repo,
    prNumber: pass.prNumber,
    attemptNumber: pass.attemptNumber,
    reviewerModel: 'codex',
    reviewBody,
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    passKind: 'first-pass',
    postedAt: '2026-05-29T12:01:00.000Z',
    execFileImpl: async (_command, args) => (
      args[0] === 'pr'
        ? { stdout: '', stderr: '' }
        : { stdout: `${JSON.stringify({ id: 5150, login: 'codex-reviewer-lacey', created_at: '2026-05-29T12:02:30.000Z', body: reviewBody })}\n` }
    ),
  }));

  const row = readPass(rootDir, pass);
  assert.equal(row.gh_comment_id, '5150');
  assert.equal(row.body_md, reviewBody);
});

test('reviewer capture does NOT fall back to non-exact body matches', async () => {
  // Pre-RBP-02 fix, when no exact body match was in the window the
  // helper picked the newest comment from the same bot. That silently
  // attached the wrong gh_comment_id to the locally-known body. After
  // the fix, no exact match means gh_comment_id stays NULL — better to
  // miss the link than to attach a wrong one.
  const rootDir = makeRootDir();
  const pass = seedPass(rootDir, { passKind: 'first-pass', reviewerClass: 'codex' });
  const reviewBody = '## Verdict\n\nComment only\n\nExact body the reviewer posted';
  const unrelatedBody = '## Verdict\n\nRequest changes\n\nAn unrelated earlier comment from the same bot';
  const log = makeLog();

  await withEnv({ GH_CODEX_REVIEWER_TOKEN: 'token' }, () => postGitHubReviewWithCapture({
    rootDir,
    repo: pass.repo,
    prNumber: pass.prNumber,
    attemptNumber: pass.attemptNumber,
    reviewerModel: 'codex',
    reviewBody,
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    passKind: 'first-pass',
    postedAt: '2026-05-29T12:01:00.000Z',
    log,
    execFileImpl: async (_command, args) => (
      args[0] === 'pr'
        ? { stdout: '', stderr: '' }
        : { stdout: `${JSON.stringify({ id: 7777, login: 'codex-reviewer-lacey', created_at: '2026-05-29T12:00:30.000Z', body: unrelatedBody })}\n` }
    ),
  }));

  const row = readPass(rootDir, pass);
  assert.equal(row.body_md, reviewBody);
  assert.equal(row.gh_comment_id, null);
  assert.match(log.warnings.join('\n'), /could not find recent GitHub review id/);
});

test('reviewer capture matches bodies after CRLF→LF normalization', async () => {
  // GitHub may rewrite line endings on stored review bodies. The exact
  // match should still succeed after normalizing CRLF to LF on both
  // sides, instead of silently storing NULL.
  const rootDir = makeRootDir();
  const pass = seedPass(rootDir, { passKind: 'first-pass', reviewerClass: 'codex' });
  const localBody = '## Verdict\n\nComment only\n\nLine endings differ';
  const ghBody = localBody.replace(/\n/g, '\r\n');

  await withEnv({ GH_CODEX_REVIEWER_TOKEN: 'token' }, () => postGitHubReviewWithCapture({
    rootDir,
    repo: pass.repo,
    prNumber: pass.prNumber,
    attemptNumber: pass.attemptNumber,
    reviewerModel: 'codex',
    reviewBody: localBody,
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    passKind: 'first-pass',
    postedAt: '2026-05-29T12:01:00.000Z',
    execFileImpl: async (_command, args) => (
      args[0] === 'pr'
        ? { stdout: '', stderr: '' }
        : { stdout: `${JSON.stringify({ id: 4242, login: 'codex-reviewer-lacey', created_at: '2026-05-29T12:00:30.000Z', body: ghBody })}\n` }
    ),
  }));

  const row = readPass(rootDir, pass);
  assert.equal(row.gh_comment_id, '4242');
});

test('reviewer capture routes UPDATE to the actual rereview row (not first-pass)', async () => {
  // Pre-RBP-02 fix, the UPDATE matched pass_kind IN ('first-pass',
  // 'rereview'), so both rows on the same attemptNumber could absorb a
  // capture. After the fix, the caller must pass a single passKind and
  // only that row is updated.
  const rootDir = makeRootDir();
  const pass = seedPass(rootDir, { passKind: 'rereview', reviewerClass: 'codex' });
  // Also seed a same-attempt first-pass row that must NOT be updated.
  seedPass(rootDir, {
    repo: pass.repo,
    prNumber: pass.prNumber,
    attemptNumber: pass.attemptNumber,
    passKind: 'first-pass',
    reviewerClass: 'codex',
    startedAt: '2026-05-29T11:59:00.000Z',
  });
  const reviewBody = '## Verdict\n\nComment only\n\nRereview body';

  await withEnv({ GH_CODEX_REVIEWER_TOKEN: 'token' }, () => postGitHubReviewWithCapture({
    rootDir,
    repo: pass.repo,
    prNumber: pass.prNumber,
    attemptNumber: pass.attemptNumber,
    reviewerModel: 'codex',
    reviewBody,
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    passKind: 'rereview',
    postedAt: '2026-05-29T12:01:00.000Z',
    execFileImpl: async (_command, args) => (
      args[0] === 'pr'
        ? { stdout: '', stderr: '' }
        : { stdout: `${JSON.stringify({ id: 9090, login: 'codex-reviewer-lacey', created_at: '2026-05-29T12:00:30.000Z', body: reviewBody })}\n` }
    ),
  }));

  const rereviewRow = readPass(rootDir, pass);
  assert.equal(rereviewRow.body_md, reviewBody);
  assert.equal(rereviewRow.gh_comment_id, '9090');

  const firstPassRow = readPass(rootDir, {
    repo: pass.repo,
    prNumber: pass.prNumber,
    attemptNumber: pass.attemptNumber,
    passKind: 'first-pass',
  });
  assert.equal(firstPassRow.body_md, null);
  assert.equal(firstPassRow.gh_comment_id, null);
  assert.equal(firstPassRow.body_captured_at, null);
});

test('remediation lookup omits GH_TOKEN when env has no token (no literal-null)', async () => {
  // child_process coerces non-string env values to strings, so passing
  // `GH_TOKEN: null` makes the subprocess inherit the literal string
  // "null" and `gh` treats that as a token. The fix omits the key when
  // there is no token available.
  const rootDir = makeRootDir();
  const pass = seedPass(rootDir, {
    attemptNumber: 2,
    reviewerClass: 'codex',
    reviewerModel: 'codex',
    passKind: 'remediation',
  });
  const body = '## Remediation Worker (codex)\n\nApplied the fix.';
  let observedEnv = null;

  await postRemediationCommentWithCapture({
    rootDir,
    repo: pass.repo,
    prNumber: pass.prNumber,
    attemptNumber: pass.attemptNumber,
    workerClass: 'codex',
    body,
    postedAt: '2026-05-29T12:01:00.000Z',
    postCommentImpl: async () => ({ posted: true }),
    captureImpl: async (captureRootDir, args) => captureRemediationBodyAfterPost(captureRootDir, {
      ...args,
      execFileImpl: async (_command, _args, options = {}) => {
        observedEnv = options.env || null;
        return {
          stdout: `${JSON.stringify({ id: 909, login: 'codex-reviewer-lacey', created_at: '2026-05-29T12:00:40.000Z', body })}\n`,
          stderr: '',
        };
      },
      env: {},
    }),
  });

  assert.ok(observedEnv, 'lookup env must be observed');
  assert.equal(Object.prototype.hasOwnProperty.call(observedEnv, 'GH_TOKEN'), false);
});

test('remediation reply capture stores body and leaves verdict NULL', async () => {
  const rootDir = makeRootDir();
  const pass = seedPass(rootDir, {
    attemptNumber: 2,
    reviewerClass: 'codex',
    reviewerModel: 'codex',
    passKind: 'remediation',
  });
  const body = '## Remediation Worker (codex)\n\nApplied the fix.';

  await postRemediationCommentWithCapture({
    rootDir,
    repo: pass.repo,
    prNumber: pass.prNumber,
    attemptNumber: pass.attemptNumber,
    workerClass: 'codex',
    body,
    postedAt: '2026-05-29T12:01:00.000Z',
    postCommentImpl: async () => ({ posted: true }),
    captureImpl: async (captureRootDir, args) => captureRemediationBodyAfterPost(captureRootDir, {
      ...args,
      execFileImpl: async () => ({
        stdout: `${JSON.stringify({ id: 808, login: 'codex-reviewer-lacey', created_at: '2026-05-29T12:00:40.000Z', body })}\n`,
        stderr: '',
      }),
      env: { GH_TOKEN: 'token' },
    }),
  });

  const row = readPass(rootDir, pass);
  assert.equal(row.verdict, null);
  assert.equal(row.body_md, body);
  assert.equal(row.gh_comment_id, '808');
  assert.ok(row.body_captured_at);
});

test('lookup forces gh api -X GET so per_page does not flip method to POST', async () => {
  // Regression for 2026-05-30: `gh api -f per_page=100` (no -X GET) treats
  // per_page as a JSON body field, switches to method=POST, and the comments
  // endpoint returns HTTP 422 ("body wasn't supplied"). Every gh_comment_id
  // was NULL across the entire reviewer_passes table until this fix landed.
  // Lock in the -X GET arg so it cannot regress silently.
  const rootDir = makeRootDir();
  const pass = seedPass(rootDir, {
    attemptNumber: 2,
    reviewerClass: 'codex',
    reviewerModel: 'codex',
    passKind: 'remediation',
  });
  const body = '## Remediation Worker (codex)\n\nApplied the fix.';
  let capturedArgs = null;

  await captureRemediationBodyAfterPost(rootDir, {
    repo: pass.repo,
    prNumber: pass.prNumber,
    attemptNumber: pass.attemptNumber,
    workerClass: 'codex',
    body,
    postedAt: '2026-05-29T12:01:00.000Z',
    execFileImpl: async (_command, args) => {
      capturedArgs = args;
      return {
        stdout: `${JSON.stringify({ id: 909, login: 'codex-reviewer-lacey', created_at: '2026-05-29T12:00:40.000Z', body })}\n`,
        stderr: '',
      };
    },
    env: { GH_TOKEN: 'token' },
  });

  assert.ok(capturedArgs, 'execFileImpl must be invoked');
  const xFlagIndex = capturedArgs.indexOf('-X');
  assert.ok(xFlagIndex >= 0, `expected -X flag in gh api args, got ${JSON.stringify(capturedArgs)}`);
  assert.equal(capturedArgs[xFlagIndex + 1], 'GET', '-X must be immediately followed by GET');
});

test('reviewer capture with attempt=M leaves a same-passKind row at attempt=N untouched', async () => {
  // Regression guard for RBP-02 blocking issue: when the row was created
  // at one attempt number (reviewDbAttemptNumber) but the capture call
  // arrives with a different attempt number (reviewAttemptNumber), the
  // UPDATE must NOT silently stamp the wrong row. With the fix, the seeded
  // row at attempt=N must stay untouched and a 0-row warn must surface.
  const rootDir = makeRootDir();
  const seeded = seedPass(rootDir, {
    attemptNumber: 1,
    passKind: 'first-pass',
    reviewerClass: 'codex',
  });
  const reviewBody = '## Verdict\n\nComment only\n\nWrong attempt body';
  const log = makeLog();

  await withEnv({ GH_CODEX_REVIEWER_TOKEN: 'token' }, () => postGitHubReviewWithCapture({
    rootDir,
    repo: seeded.repo,
    prNumber: seeded.prNumber,
    attemptNumber: 2,
    reviewerModel: 'codex',
    reviewBody,
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    passKind: 'first-pass',
    postedAt: '2026-05-29T12:01:00.000Z',
    log,
    execFileImpl: async (_command, args) => (
      args[0] === 'pr'
        ? { stdout: '', stderr: '' }
        : { stdout: `${JSON.stringify({ id: 6001, login: 'codex-reviewer-lacey', created_at: '2026-05-29T12:00:30.000Z', body: reviewBody })}\n` }
    ),
  }));

  const seededRow = readPass(rootDir, seeded);
  assert.equal(seededRow.body_md, null);
  assert.equal(seededRow.gh_comment_id, null);
  assert.equal(seededRow.body_captured_at, null);
  assert.match(log.warnings.join('\n'), /capture matched 0 rows/);
});

test('reviewer capture with wrong passKind does not touch a same-attempt row', async () => {
  // Regression guard: when the capture passes pass_kind='rereview' but the
  // only existing row at that attempt number is pass_kind='first-pass',
  // the UPDATE must match zero rows — not silently absorb the first-pass row.
  const rootDir = makeRootDir();
  const seeded = seedPass(rootDir, {
    attemptNumber: 1,
    passKind: 'first-pass',
    reviewerClass: 'codex',
  });
  const reviewBody = '## Verdict\n\nComment only\n\nWrong passKind body';
  const log = makeLog();

  await withEnv({ GH_CODEX_REVIEWER_TOKEN: 'token' }, () => postGitHubReviewWithCapture({
    rootDir,
    repo: seeded.repo,
    prNumber: seeded.prNumber,
    attemptNumber: seeded.attemptNumber,
    reviewerModel: 'codex',
    reviewBody,
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    passKind: 'rereview',
    postedAt: '2026-05-29T12:01:00.000Z',
    log,
    execFileImpl: async (_command, args) => (
      args[0] === 'pr'
        ? { stdout: '', stderr: '' }
        : { stdout: `${JSON.stringify({ id: 6002, login: 'codex-reviewer-lacey', created_at: '2026-05-29T12:00:30.000Z', body: reviewBody })}\n` }
    ),
  }));

  const seededRow = readPass(rootDir, seeded);
  assert.equal(seededRow.body_md, null);
  assert.equal(seededRow.gh_comment_id, null);
  assert.match(log.warnings.join('\n'), /capture matched 0 rows/);
});

test('reviewer capture coerces unknown verdict to NULL so the CHECK does not abort', async () => {
  // normalizeReviewVerdict returns 'unknown' for off-script verdicts; the
  // reviewer_passes.verdict CHECK only allows {approved, comment-only,
  // request-changes, dismissed, NULL}. Pre-fix, 'unknown' aborted the
  // UPDATE and the body was lost. Post-fix, the call site coerces
  // 'unknown' → NULL so the body still lands.
  const rootDir = makeRootDir();
  const pass = seedPass(rootDir, { passKind: 'first-pass', reviewerClass: 'codex' });
  // "Deferred" doesn't start with any canonical prefix, so
  // normalizeReviewVerdict returns 'unknown'.
  const reviewBody = '## Verdict\n\nDeferred\n\nBody text';

  await withEnv({ GH_CODEX_REVIEWER_TOKEN: 'token' }, () => postGitHubReviewWithCapture({
    rootDir,
    repo: pass.repo,
    prNumber: pass.prNumber,
    attemptNumber: pass.attemptNumber,
    reviewerModel: 'codex',
    reviewBody,
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
    passKind: 'first-pass',
    postedAt: '2026-05-29T12:01:00.000Z',
    execFileImpl: async (_command, args) => (
      args[0] === 'pr'
        ? { stdout: '', stderr: '' }
        : { stdout: `${JSON.stringify({ id: 6003, login: 'codex-reviewer-lacey', created_at: '2026-05-29T12:00:30.000Z', body: reviewBody })}\n` }
    ),
  }));

  const row = readPass(rootDir, pass);
  assert.equal(row.verdict, null);
  assert.equal(row.body_md, reviewBody);
  assert.equal(row.gh_comment_id, '6003');
  assert.ok(row.body_captured_at);
});
