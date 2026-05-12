import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_CLI, __test__ } from '../src/reviewer.mjs';
import { buildObviousDocsGuidance, extractLinkedRepoDocs, fetchLinkedSpecContents, parseGitHubBlobPath } from '../src/prompt-context.mjs';

const {
  CLAUDE_STRIPPED_ENV_VARS,
  ENV_BIN,
  LAUNCHCTL,
  buildClaudeReviewArgs,
  buildCodexReviewArgs,
  queueFollowUpForPostedReview,
  resolveReviewerTimeoutMs,
  spawnCodexReview,
  spawnClaude,
} = __test__;

function queueWithFakes(reviewText) {
  const created = [];
  const result = queueFollowUpForPostedReview({
    rootDir: '/tmp/adversarial-review-test',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 57,
    reviewerModel: 'claude',
    builderTag: '[codex]',
    linearTicketId: null,
    reviewText,
    reviewPostedAt: '2026-05-08T14:00:00.000Z',
    critical: false,
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 1,
      latestMaxRounds: 2,
    }),
    createFollowUpJobImpl: (jobInput) => {
      created.push(jobInput);
      return { jobPath: '/tmp/adversarial-review-test/data/follow-up-jobs/pending/job.json' };
    },
  });
  return { result, created };
}

test('clean comment-only reviews still queue a durable follow-up verdict carrier through the production queue helper', () => {
  const { result, created } = queueWithFakes([
    '## Summary',
    'Everything is settled.',
    '',
    '## Blocking issues',
    '- None.',
    '',
    '## Non-blocking issues',
    '- None.',
    '',
    '## Verdict',
    'Comment only',
  ].join('\n'));

  assert.equal(result.queued, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].reviewBody.includes('Comment only'), true);
  assert.equal(Object.hasOwn(created[0], 'maxRemediationRounds'), false);
  assert.equal(created[0].priorCompletedRounds, 1);
});

test('request-changes and malformed verdicts still queue durable follow-up handoffs', () => {
  const dirty = queueWithFakes('## Summary\nFix it.\n\n## Verdict\nRequest changes');
  const malformed = queueWithFakes('## Summary\nVerdict missing.');

  assert.equal(dirty.result.queued, true);
  assert.equal(dirty.created.length, 1);
  assert.equal(malformed.result.queued, true);
  assert.equal(malformed.created.length, 1);
});

test('new follow-up jobs preserve an elevated prior cap to avoid truncating an active PR cycle', () => {
  const created = [];
  queueFollowUpForPostedReview({
    rootDir: '/tmp/adversarial-review-test',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 58,
    reviewerModel: 'claude',
    builderTag: '[codex]',
    linearTicketId: 'LAC-466',
    reviewText: '## Summary\nNeeds fixes.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-05-08T14:00:00.000Z',
    critical: false,
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 7,
      latestMaxRounds: 7,
    }),
    createFollowUpJobImpl: (jobInput) => {
      created.push(jobInput);
      return { jobPath: '/tmp/adversarial-review-test/data/follow-up-jobs/pending/job.json' };
    },
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].priorCompletedRounds, 7);
  assert.equal(created[0].maxRemediationRounds, 7);
});

test('new follow-up jobs re-derive cap when the prior cap is not above the current risk tier', () => {
  const created = [];
  queueFollowUpForPostedReview({
    rootDir: '/tmp/adversarial-review-test',
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 58,
    reviewerModel: 'claude',
    builderTag: '[codex]',
    linearTicketId: 'LAC-466',
    reviewText: '## Summary\nNeeds fixes.\n\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-05-08T14:00:00.000Z',
    critical: false,
    summarizePRRemediationLedgerImpl: () => ({
      completedRoundsForPR: 1,
      latestMaxRounds: 2,
    }),
    createFollowUpJobImpl: (jobInput) => {
      created.push(jobInput);
      return { jobPath: '/tmp/adversarial-review-test/data/follow-up-jobs/pending/job.json' };
    },
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].priorCompletedRounds, 1);
  assert.equal(
    Object.hasOwn(created[0], 'maxRemediationRounds'),
    false,
    'fresh dispatch should let createFollowUpJob derive the current tier cap',
  );
});

test('parseGitHubBlobPath only accepts blob URLs for the expected repo', () => {
  assert.equal(
    parseGitHubBlobPath('https://github.com/laceyenterprises/adversarial-review/blob/main/SPEC.md', 'laceyenterprises/adversarial-review'),
    'SPEC.md'
  );
  assert.equal(
    parseGitHubBlobPath('https://github.com/other/repo/blob/main/SPEC.md', 'laceyenterprises/adversarial-review'),
    null
  );
  assert.equal(
    parseGitHubBlobPath('https://github.com/laceyenterprises/adversarial-review/pull/6', 'laceyenterprises/adversarial-review'),
    null
  );
});

test('extractLinkedRepoDocs handles local paths and GitHub blob URLs without repo regex interpolation', () => {
  const text = [
    'See docs/ARCHITECTURE.md for context.',
    '(./projects/ROLLUP.md)',
    'Blob: https://github.com/laceyenterprises/adversarial-review/blob/main/tools/PLAYBOOK.md',
    'PR link should be ignored: https://github.com/laceyenterprises/adversarial-review/pull/6',
  ].join('\n');

  assert.deepEqual(extractLinkedRepoDocs(text, 'laceyenterprises/adversarial-review'), [
    'docs/ARCHITECTURE.md',
    'projects/ROLLUP.md',
    'tools/PLAYBOOK.md',
  ]);
});

test('fetchLinkedSpecContents fetches linked specs concurrently and preserves linked order', async () => {
  const starts = [];
  let inflight = 0;
  let maxInflight = 0;

  const result = await fetchLinkedSpecContents('laceyenterprises/adversarial-review', 6, {
    fetchPRContextImpl: async () => ({
      body: [
        'docs/ARCHITECTURE.md',
        'https://github.com/laceyenterprises/adversarial-review/blob/main/tools/PLAYBOOK.md',
      ].join('\n'),
      comments: [],
      headRefOid: 'abc123',
    }),
    execFileImpl: async (_command, args) => {
      const relPath = args[1].match(/contents\/(.+)\?ref=/)[1];
      starts.push(relPath);
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, relPath.includes('ARCHITECTURE') ? 20 : 5));
      inflight -= 1;
      return { stdout: Buffer.from(`# ${relPath}\n`).toString('base64'), stderr: '' };
    },
  });

  assert.equal(maxInflight, 2);
  assert.deepEqual(starts, ['docs/ARCHITECTURE.md', 'tools/PLAYBOOK.md']);
  assert.match(result, /### docs\/ARCHITECTURE.md/);
  assert.match(result, /### tools\/PLAYBOOK.md/);
});

test('buildObviousDocsGuidance tells workers to inspect obvious repo docs before guessing', () => {
  const guidance = buildObviousDocsGuidance();
  assert.match(guidance, /README\.md/);
  assert.match(guidance, /SPEC\.md/);
  assert.match(guidance, /go read it directly rather than guessing from the diff alone/i);
});

test('reviewer timeout defaults to 20m and honors explicit positive env override', () => {
  assert.equal(resolveReviewerTimeoutMs({}), 20 * 60 * 1000);
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '12345' }), 12345);
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: '0' }), 20 * 60 * 1000);
  assert.equal(resolveReviewerTimeoutMs({ ADVERSARIAL_REVIEWER_TIMEOUT_MS: 'not-a-number' }), 20 * 60 * 1000);
});

test('spawnClaude wraps claude in launchctl asuser on darwin', async () => {
  const calls = [];
  const result = { stdout: '{"loggedIn":true}', stderr: '' };

  const actual = await spawnClaude(['auth', 'status'], {
    platform: 'darwin',
    uid: 501,
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return result;
    },
    env: { PATH: process.env.PATH },
    timeout: 10_000,
  });

  assert.equal(actual, result);
  assert.deepEqual(calls, [
    {
      command: LAUNCHCTL,
      args: ['asuser', '501', ENV_BIN, ...CLAUDE_STRIPPED_ENV_VARS.flatMap((name) => ['-u', name]), CLAUDE_CLI, 'auth', 'status'],
      options: {
        env: { PATH: process.env.PATH },
        timeout: 10_000,
      },
    },
  ]);
});

test('spawnClaude invokes claude directly on non-darwin platforms', async () => {
  const calls = [];

  await spawnClaude(['auth', 'status'], {
    platform: 'linux',
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: 'ok', stderr: '' };
    },
    env: { PATH: process.env.PATH },
  });

  assert.deepEqual(calls, [
    {
      command: CLAUDE_CLI,
      args: ['auth', 'status'],
      options: {
        env: { PATH: process.env.PATH },
      },
    },
  ]);
});

test('Claude review invocation passes prompt as argv in cli-direct shape', async () => {
  const prompt = 'review this diff';
  const calls = [];

  await spawnClaude(buildClaudeReviewArgs(prompt), {
    platform: 'linux',
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: 'ok', stderr: '' };
    },
    env: { HOME: '/tmp/home', PATH: process.env.PATH },
  });

  assert.deepEqual(calls, [
    {
      command: CLAUDE_CLI,
      args: ['--print', '--permission-mode', 'bypassPermissions', prompt],
      options: {
        env: { HOME: '/tmp/home', PATH: process.env.PATH },
      },
    },
  ]);
});

test('Codex review invocation passes prompt as argv in cli-direct shape', async () => {
  const calls = [];
  const prompt = 'review this codex diff';
  const outputPath = '/tmp/codex-last-message.md';

  await spawnCodexReview({
    codexCli: '/usr/local/bin/codex',
    outputPath,
    prompt,
    env: { HOME: '/tmp/home', PATH: process.env.PATH },
    cwd: '/tmp/repo',
    timeout: 12_345,
    maxBuffer: 999,
    spawnCapturedImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: '', stderr: '' };
    },
  });

  assert.deepEqual(calls, [
    {
      command: '/usr/local/bin/codex',
      args: buildCodexReviewArgs({ outputPath, prompt }),
      options: {
        env: { HOME: '/tmp/home', PATH: process.env.PATH },
        cwd: '/tmp/repo',
        timeout: 12_345,
        maxBuffer: 999,
      },
    },
  ]);
  assert.deepEqual(calls[0].args, [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--ephemeral',
    '--output-last-message',
    outputPath,
    '--',
    prompt,
  ]);
});

test('spawnClaude rejects invalid darwin uids', async () => {
  await assert.rejects(
    () => spawnClaude(['auth', 'status'], { platform: 'darwin', uid: 0 }),
    /Cannot resolve a non-root user uid/
  );
  await assert.rejects(
    () => spawnClaude(['auth', 'status'], { platform: 'darwin', uid: null }),
    /Cannot resolve a non-root user uid/
  );
});

test('spawnClaude classifies launchctl session failures separately from oauth failures', async () => {
  await assert.rejects(
    () => spawnClaude(['auth', 'status'], {
      platform: 'darwin',
      uid: 501,
      execFileImpl: async () => {
        const err = new Error('Command failed');
        err.stderr = 'Could not find domain for user 501';
        throw err;
      },
    }),
    (err) => err?.isLaunchctlSessionError === true && /bootstrap failed/i.test(err.message)
  );
});
