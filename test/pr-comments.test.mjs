import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REMEDIATION_COMMENT_MARKER_PREFIX,
  WORKER_CLASS_TO_BOT_TOKEN_ENV,
  buildRemediationOutcomeCommentBody,
  buildRemediationOutcomeCommentMarker,
  defangUntrustedMarkdown,
  extractRemediationCommentMarker,
  findExistingRemediationComment,
  postRemediationOutcomeComment,
  resolveCommentBotTokenEnv,
} from '../src/adapters/comms/github-pr-comments/pr-comments.mjs';

function makeJob(overrides = {}) {
  return {
    jobId: 'lac__demo-pr-7-2026-05-01T20-00-00-000Z',
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    builderTag: 'claude-code',
    reviewerModel: 'codex',
    remediationPlan: {
      currentRound: 2,
      maxRounds: 6,
    },
    ...overrides,
  };
}

// ── defangUntrustedMarkdown unit tests ───────────────────────────────────
// Direct coverage of the markdown-defang helper. The rendered-output
// integration tests above exercise it through buildRemediationOutcomeCommentBody;
// these tests pin the exact transform so the rules stay deterministic.

test('defangUntrustedMarkdown returns empty string for nullish input', () => {
  assert.equal(defangUntrustedMarkdown(null), '');
  assert.equal(defangUntrustedMarkdown(undefined), '');
  assert.equal(defangUntrustedMarkdown(''), '');
});

test('defangUntrustedMarkdown escapes markdown syntax chars including backticks', () => {
  // Backticks are delimiter syntax too. Even single/double runs must be
  // escaped because an unmatched worker-controlled run can consume later
  // trusted template sections into inline code.
  assert.equal(
    defangUntrustedMarkdown('*bold* _ital_ `code` ~strike~ # h1 > q | t [a](b) <c> !d'),
    '\\*bold\\* \\_ital\\_ \\`code\\` \\~strike\\~ \\# h1 \\> q \\| t \\[a\\]\\(b\\) \\<c\\> \\!d'
  );
});

test('defangUntrustedMarkdown breaks @mention autolinking with ZWSP', () => {
  // ZWSP between @ and the next char prevents GitHub's mention autolinker
  // from matching while staying visually invisible.
  const out = defangUntrustedMarkdown('cc @paul-lacey and @laceyenterprises/security');
  assert.match(out, /@​paul-lacey/);
  assert.match(out, /@​laceyenterprises\/security/);
  // No raw @user (with no ZWSP) anywhere — otherwise the autolinker fires.
  assert.doesNotMatch(out, /(?<!@​)@paul-lacey/);
});

test('defangUntrustedMarkdown does not escape ordinary alphanumerics or whitespace', () => {
  assert.equal(
    defangUntrustedMarkdown('Read prompt at path/to/file.md and patched it.'),
    'Read prompt at path/to/file.md and patched it.'
  );
});

test('defangUntrustedMarkdown escapes backslashes first so nothing double-escapes', () => {
  // Input `\*` should not become `\\\*` (over-escaped) or `\*` (under-).
  // Correct: the backslash is escaped (`\\`), the asterisk is escaped (`\*`),
  // producing `\\\*` in source — which renders as `\*` in GFM (literal).
  assert.equal(defangUntrustedMarkdown('\\*not-bold\\*'), '\\\\\\*not-bold\\\\\\*');
});

test('defangUntrustedMarkdown breaks bare URL autolinks', () => {
  const out = defangUntrustedMarkdown('see https://example.com/a and http://x.test or www.example.org');
  assert.match(out, /https:​\/\/example\.com\/a/);
  assert.match(out, /http:​\/\/x\.test/);
  assert.match(out, /www\.​example\.org/);
  assert.doesNotMatch(out, /https:\/\//);
  assert.doesNotMatch(out, /http:\/\//);
  assert.doesNotMatch(out, /www\.example/);
});

test('defangUntrustedMarkdown neutralizes block-level markdown starts', () => {
  const out = defangUntrustedMarkdown([
    '- item',
    '+ item',
    '1. forged',
    '2) forged',
    '---',
    '===',
    '    indented code',
  ].join('\n'));
  assert.match(out, /^\\- item$/m);
  assert.match(out, /^\\\+ item$/m);
  assert.match(out, /^1\\. forged$/m);
  assert.match(out, /^2\\\) forged$/m);
  assert.match(out, /^\\---$/m);
  assert.match(out, /^\\===$/m);
  assert.match(out, /^​    indented code$/m);
});

test('resolveCommentBotTokenEnv maps known worker classes to their bot env vars', () => {
  assert.equal(resolveCommentBotTokenEnv('codex'), 'GH_CODEX_REVIEWER_TOKEN');
  assert.equal(resolveCommentBotTokenEnv('claude-code'), 'GH_CLAUDE_REVIEWER_TOKEN');
});

test('resolveCommentBotTokenEnv returns null for unknown worker classes', () => {
  assert.equal(resolveCommentBotTokenEnv('not-a-class'), null);
  assert.equal(resolveCommentBotTokenEnv(undefined), null);
});

test('WORKER_CLASS_TO_BOT_TOKEN_ENV covers every known remediation worker class', () => {
  // Tripwire: keep this in lockstep with REMEDIATION_WORKER_IDENTITY_DEFAULTS
  // in src/follow-up-remediation.mjs. If a new class lands there but no
  // bot-token mapping exists here, comment posting will silently skip for
  // that class — which the test surfaces immediately.
  const knownClasses = new Set(['codex', 'claude-code']);
  for (const cls of knownClasses) {
    assert.ok(
      WORKER_CLASS_TO_BOT_TOKEN_ENV[cls],
      `worker class "${cls}" must have a bot-token env mapping`
    );
  }
});

test('buildRemediationOutcomeCommentBody produces clean prose (no fenced code blocks around descriptive fields)', () => {
  // Snapshot of the operator-facing output shape. This is the canonical
  // demonstration that prose fields render as readable prose, not as
  // walls of ```text fences. If this snapshot is intentionally updated,
  // confirm the change in a rendered preview of a real PR comment
  // (paste into https://github.com/ and view) before landing.
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex', reviewerModel: 'claude' }),
    reply: {
      outcome: 'completed',
      summary: 'Restored alert-token compatibility for legacy deployments and documented the fallback contract.',
      validation: [
        'git fetch origin && git rebase origin/main completed cleanly before remediation.',
        'npm test passed: 882 passed, 1 skipped.',
      ],
      addressed: [
        {
          title: 'Legacy alert token fallback removed',
          finding: 'resolveDefaultHooksTokenFile stopped probing the historical secrets path.',
          action: 'Restored the legacy token-file probe when the new default token file is absent.',
          files: ['src/alert-delivery.mjs'],
        },
      ],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending', reason: 'fix verified locally' },
  });

  // No ```text fences anywhere in the rendered body — the defang
  // approach replaced them with backslash-escaped prose.
  assert.doesNotMatch(body, /```text/);
  // Summary section is an H2 with a plain paragraph beneath.
  assert.match(
    body,
    /## Summary\n\nRestored alert-token compatibility for legacy deployments and documented the fallback contract\./
  );
  // Validation list is one defanged bullet per item under its H2.
  assert.match(body, /## Validation run\n\n- git fetch origin && git rebase origin\/main completed cleanly/);
  assert.match(body, /^- npm test passed: 882 passed, 1 skipped\.$/m);
  // Each addressed entry renders as a bold-title top-level bullet
  // with nested `**Finding:** / **Action:** / **Files:**` sub-bullets.
  assert.match(body, /^- \*\*Legacy alert token fallback removed\*\*$/m);
  assert.match(
    body,
    /^ {2}- \*\*Finding:\*\* resolveDefaultHooksTokenFile stopped probing the historical secrets path\.$/m,
  );
  assert.match(
    body,
    /^ {2}- \*\*Action:\*\* Restored the legacy token-file probe when the new default token file is absent\.$/m,
  );
  assert.match(body, /^ {2}- \*\*Files:\*\* `src\/alert-delivery\.mjs`$/m);
});

test('buildRemediationOutcomeCommentBody on completed includes summary, validation, and re-review queued', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'claude-code',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Tightened null handling in the API layer.',
      validation: ['npm test', 'manual smoke of /v1/users'],
      blockers: [],
    },
    // Watcher accepted the rereview reset (status reset to pending).
    reReview: { requested: true, triggered: true, status: 'pending', reason: 'Want adversarial confirmation.' },
  });
  assert.match(body, /Remediation Worker \(claude-code\) — round 2 of 6/);
  assert.match(body, /Outcome:.*completed.*re-review queued/);
  // Worker-supplied summary/validation/blockers are defanged (markdown
  // meta chars backslash-escaped, @mentions ZWSP-broken) so injected
  // markdown / mentions / autolinks render as literal text — no fenced
  // code blocks, just clean prose.
  assert.match(body, /Tightened null handling in the API layer/);
  assert.match(body, /^- npm test$/m);
  assert.match(body, /^- manual smoke of \/v1\/users$/m);
  // rereview.reason is rendered inline-safe (backtick-wrapped) so a
  // worker can't smuggle a mention or autolink into the status line.
  assert.match(body, /Re-review status:\*\*\s*queued — `Want adversarial confirmation\.`/);
  assert.match(body, /Job: `lac__demo-pr-7-2026-05-01T20-00-00-000Z`/);
});

test('buildRemediationOutcomeCommentBody on completed reports already-pending when no reset was needed', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      summary: 'Fixed.',
      validation: ['npm test'],
      blockers: [],
    },
    reReview: { requested: true, triggered: false, status: 'already-pending', reason: 'Worker wants confirmation.' },
  });
  assert.match(body, /re-review already pending — no reset needed/);
  assert.match(body, /Re-review status:\*\*\s*already pending/);
});

test('buildRemediationOutcomeCommentBody on stopped (rereview-blocked) flags the watcher refusal', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'claude-code',
    action: 'stopped',
    job: {
      ...makeJob(),
      remediationPlan: { currentRound: 1, maxRounds: 6, stop: { code: 'rereview-blocked' } },
    },
    reply: {
      outcome: 'completed',
      summary: 'Worker thought it was done.',
      validation: ['npm test'],
      blockers: [],
    },
    reReview: {
      requested: true,
      triggered: false,
      status: 'blocked',
      outcomeReason: 'review-row-missing',
      reason: 'Worker wants confirmation.',
    },
  });
  assert.match(body, /Outcome:.*stopped.*rereview-blocked/);
  assert.match(body, /Human intervention required/);
  assert.match(body, /watcher refused the reset.*review-row-missing/);
  assert.match(body, /Re-review status:\*\*\s*\*\*BLOCKED\*\*\s*\(`review-row-missing`\)/);
});

test('buildRemediationOutcomeCommentBody on stopped (max-rounds-reached) flags human intervention', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'stopped',
    job: {
      ...makeJob({ builderTag: 'codex', reviewerModel: 'claude' }),
      remediationPlan: {
        currentRound: 6,
        maxRounds: 6,
        stop: { code: 'max-rounds-reached' },
      },
    },
    reply: {
      outcome: 'partial',
      summary: 'Addressed two of three findings; the third needs schema migration.',
      validation: [],
      blockers: [
        {
          finding: 'Reviewer asks for a destructive schema migration.',
          reasoning: 'Schema migration requires DBA review.',
        },
      ],
    },
  });
  assert.match(body, /round 6 of 6/);
  assert.match(body, /Outcome:.*stopped.*max-rounds-reached/);
  assert.match(body, /Human intervention required/);
  assert.match(body, /exhausted its bounded round cap/);
  assert.match(body, /Blockers/);
  // Structured blockers render with both Finding and Reasoning lines
  // so the next human can map the hard-exit back to the originating
  // review finding. New format: bold labels outside fenced blocks,
  // untrusted content inside.
  assert.match(body, /\*\*Finding:\*\*/);
  assert.match(body, /Reviewer asks for a destructive schema migration\./);
  assert.match(body, /\*\*Reasoning:\*\*/);
  assert.match(body, /Schema migration requires DBA review\./);
  // No re-review requested in this state.
  assert.match(body, /Re-review requested:\*\*\s*no/);
});

test('buildRemediationOutcomeCommentBody on stopped (worker chose blocked) flags human intervention', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'stopped',
    job: {
      ...makeJob(),
      remediationPlan: { currentRound: 1, maxRounds: 6, stop: { code: 'no-progress' } },
    },
    reply: {
      outcome: 'blocked',
      summary: 'Cannot proceed without secrets the worker does not have.',
      validation: [],
      blockers: [
        {
          finding: 'Reviewer asks for a fix that needs the deploy bot token.',
          reasoning: 'Missing OP_SERVICE_ACCOUNT_TOKEN',
        },
      ],
    },
  });
  assert.match(body, /Human intervention required/);
  assert.match(body, /worker reported blockers it could not resolve/);
});

test('buildRemediationOutcomeCommentBody on failed with a short reason uses inline-code (single tight line)', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'failed',
    job: makeJob(),
    failure: { code: 'invalid-remediation-reply', message: 'Remediation reply summary is required' },
  });
  assert.match(body, /Outcome:.*failed/);
  // Short reasons stay on one line in inline-code — exactly how the
  // legacy format rendered them.
  assert.match(body, /Reason: `Remediation reply summary is required`/);
  assert.match(body, /Human intervention required/);
});

test('buildRemediationOutcomeCommentBody on failed with a long reason switches to a blockquoted multi-line paragraph', () => {
  // The legacy single-`<inline-code>` rendering produced a ~400-char
  // monospace line that overflowed the right edge of every GitHub PR
  // view. Long reasons now render as a blockquote so they wrap inside
  // the PR-comment column.
  const longMessage = 'Failed to read remediation reply artifact at /Users/airlock/agent-os/.../followups-reply.json for job laceyenterprises__agent-os-pr-400 (laceyenterprises/agent-os#400): Remediation reply does not account for every blocking finding: review has 1 blocking issue(s), reply records 3.';
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'failed',
    job: makeJob(),
    failure: { code: 'invalid-remediation-reply', message: longMessage },
  });
  // Header line is present but the message is NOT wrapped in inline-code.
  assert.match(body, /^Reason:\s*$/m);
  // The reason body appears as a blockquote (`> `-prefixed line).
  assert.match(body, /^> Failed to read remediation reply artifact/m);
  // Host-local paths still get masked by sanitizeFailureText before render.
  assert.match(body, /\\<path-redacted\\>\/followups-reply\.json/);
  // No long backtick-wrapped Reason line remains anywhere in the body.
  assert.doesNotMatch(body, /Reason: `Failed to read remediation/);
});

test('long failure.message markdown is defanged inside the blockquote', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'failed',
    job: makeJob(),
    failure: {
      code: 'runtime-error',
      message: [
        'Runtime parser exploded after receiving adversarial text from an exception:',
        '@laceyenterprises/security should not notify, #123 should not autolink,',
        'https://example.com should not link, <tag> should not render, and `unterminated ``` fence text follows.',
      ].join(' '),
    },
  });

  assert.match(body, /^Reason:\s*$/m);
  assert.match(body, /^> Runtime parser exploded/m);
  assert.match(body, /@​laceyenterprises\/security/);
  assert.match(body, /\\#​123/);
  assert.match(body, /https:​\/\/example\.com/);
  assert.match(body, /\\<tag\\>/);
  assert.match(body, /\\`unterminated \\`\\`\\` fence text follows/);
  assert.doesNotMatch(body, /@laceyenterprises\/security/);
  assert.doesNotMatch(body, /#123/);
  assert.doesNotMatch(body, /https:\/\//);
  assert.doesNotMatch(body, /<tag>/);
  assert.doesNotMatch(body, /```/);
});

test('buildRemediationOutcomeCommentBody suppresses the Validation run section when all entries are empty', () => {
  // Workers occasionally submit `validation: ['', '\t', '   ']` (log
  // harness lost stdout, redaction stripped to nothing, etc.). The
  // section header alone with an `_(none reported)_` placeholder reads
  // as garbage in the rendered PR comment; the renderer should drop the
  // whole section instead.
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      summary: 'Fixed it.',
      validation: ['', '   ', '\t'],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  assert.doesNotMatch(body, /Validation run/);
  assert.doesNotMatch(body, /none reported/);
});

test('buildRemediationOutcomeCommentBody summary with single backticks escapes delimiter syntax', () => {
  // Workers routinely write `git fetch` or `pytest` in summary prose, but the
  // source is still untrusted. Escape the delimiter so an unmatched backtick
  // cannot swallow later trusted sections such as Validation run.
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      summary: 'Ran `pytest tests/migrations/` after `alembic upgrade head` and confirmed.',
      validation: [],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  assert.match(body, /Ran \\`pytest tests\/migrations\/\\` after \\`alembic upgrade head\\`/);
  assert.doesNotMatch(body, /Ran `pytest/);
});

test('summary with unmatched single backtick cannot consume trusted sections', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      summary: 'opens here `',
      validation: ['npm test still renders under the trusted header'],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  assert.match(body, /## Summary\n\nopens here \\`/);
  assert.match(body, /## Validation run\n\n- npm test still renders under the trusted header/);
});

test('validation with unmatched double backticks cannot consume trusted footer', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      summary: 'ok',
      validation: ['bad ``'],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  assert.match(body, /^- bad \\`\\`$/m);
  assert.match(body, /\*\*Re-review status:\*\* queued/);
  assert.match(body, /_Posted automatically by the adversarial-review remediation pipeline/);
});

test('postRemediationOutcomeComment posts via gh pr comment with the bot token in env', async () => {
  const calls = [];
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'claude-code',
    body: '### Remediation Worker (claude-code) — round 1\n\nSummary',
    env: { GH_CLAUDE_REVIEWER_TOKEN: 'test-pat-claude', PATH: '/usr/bin' },
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: '', stderr: '' };
    },
  });

  assert.equal(result.posted, true);
  assert.equal(result.workerClass, 'claude-code');
  assert.equal(result.tokenEnvName, 'GH_CLAUDE_REVIEWER_TOKEN');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].args, [
    'pr', 'comment', '7', '--repo', 'laceyenterprises/demo', '--body',
    '### Remediation Worker (claude-code) — round 1\n\nSummary',
  ]);
  // The bot PAT is exposed to the gh CLI via GH_TOKEN, scoped to this exec.
  assert.equal(calls[0].options.env.GH_TOKEN, 'test-pat-claude');
});

test('postRemediationOutcomeComment passes only an allowlisted env to gh', async () => {
  // The daemon's parent env carries unrelated high-value secrets. The gh
  // subprocess must NOT see them. Only PATH, HOME, and the selected
  // GH_TOKEN should reach the child.
  const calls = [];
  await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'claude-code',
    body: 'x',
    env: {
      GH_CLAUDE_REVIEWER_TOKEN: 'test-pat-claude',
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/Users/test',
      // High-value secrets that must NOT leak into the child:
      OP_SERVICE_ACCOUNT_TOKEN: 'op-secret-XXXXX',
      GITHUB_TOKEN: 'operator-pat-YYYYY',
      GH_CODEX_REVIEWER_TOKEN: 'codex-bot-pat-ZZZZZ',
      ANTHROPIC_AUTH_TOKEN: 'oauth-bearer-WWWWW',
      // Other unrelated env that's also unnecessary:
      LINEAR_API_KEY: 'linear-pat-AAAAA',
      LANG: 'en_US.UTF-8',
    },
    execFileImpl: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { stdout: '', stderr: '' };
    },
  });

  const childEnv = calls[0].options.env;
  assert.deepEqual(
    Object.keys(childEnv).sort(),
    ['GH_TOKEN', 'HOME', 'PATH'],
    `child env must be exactly the allowlist; got: ${Object.keys(childEnv).join(', ')}`
  );
  assert.equal(childEnv.GH_TOKEN, 'test-pat-claude');
  assert.equal(childEnv.PATH, '/opt/homebrew/bin:/usr/bin');
  assert.equal(childEnv.HOME, '/Users/test');
  assert.equal(childEnv.OP_SERVICE_ACCOUNT_TOKEN, undefined);
  assert.equal(childEnv.GITHUB_TOKEN, undefined);
  assert.equal(childEnv.GH_CODEX_REVIEWER_TOKEN, undefined);
  assert.equal(childEnv.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(childEnv.LINEAR_API_KEY, undefined);
});

test('postRemediationOutcomeComment skips with token-env-missing when the env var is absent', async () => {
  // Capture the log call so we know we surfaced it instead of silently swallowing.
  const errors = [];
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'claude-code',
    body: 'whatever',
    env: { PATH: '/usr/bin' }, // no GH_CLAUDE_REVIEWER_TOKEN
    execFileImpl: async () => {
      throw new Error('execFile must not be called when token env is missing');
    },
    log: { error: (msg) => errors.push(msg) },
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'token-env-missing');
  assert.equal(result.tokenEnvName, 'GH_CLAUDE_REVIEWER_TOKEN');
  assert.ok(errors.length > 0, 'missing token env should be logged');
});

test('postRemediationOutcomeComment skips with no-token-mapping for unknown worker class', async () => {
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'gemini', // not in WORKER_CLASS_TO_BOT_TOKEN_ENV today
    body: 'whatever',
    env: {},
    execFileImpl: async () => {
      throw new Error('execFile must not be called when no token mapping exists');
    },
    log: { error: () => {} },
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'no-token-mapping');
  assert.equal(result.workerClass, 'gemini');
});

test('postRemediationOutcomeComment swallows gh-cli failures and reports them in the result', async () => {
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'codex',
    body: 'whatever',
    env: { GH_CODEX_REVIEWER_TOKEN: 'test-pat-codex' },
    execFileImpl: async () => {
      const err = new Error('HTTP 502: bad gateway');
      throw err;
    },
    log: { error: () => {} },
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'gh-cli-failure');
  assert.match(result.error, /HTTP 502/);
});

test('postRemediationOutcomeComment skips when repo or prNumber is missing', async () => {
  const result = await postRemediationOutcomeComment({
    repo: null,
    prNumber: 7,
    workerClass: 'codex',
    body: 'x',
    log: { error: () => {} },
  });
  assert.equal(result.posted, false);
  assert.equal(result.reason, 'missing-pr-coordinates');
});

// ── Worker-supplied content is redacted before posting ───────────────────────

// ── R6 #1: path redaction in worker-supplied PR comment fields ────────────
//
// redactPathlikeText was previously applied only to internal failure
// messages. Worker-authored summary/validation/blockers/reReview.reason
// can ALSO contain absolute paths from log echoes (e.g. the worker
// running tests and pasting a `at /Users/airlock/.../foo.js:42` stack).
// Path redaction must run on every worker field before fencing/posting.

test('worker summary masks absolute /Users/<user>/ paths', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      summary: 'Test failed at /Users/airlock/agent-os/modules/foo/bar.js:42',
      validation: [],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  assert.doesNotMatch(body, /\/Users\/airlock/);
  // Defanging escapes the `<>` in the redactor's placeholder so it renders
  // as literal `<path-redacted>` regardless of how GFM treats raw `<word>`
  // patterns. Source-form is `\<path-redacted\>`, rendered output is
  // `<path-redacted>`.
  assert.match(body, /\\<path-redacted\\>\/bar\.js:42/);
});

test('worker validation entries mask absolute paths', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      summary: 'ok',
      validation: ['ran tests in /Users/airlock/agent-os/tools/adversarial-review'],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  assert.doesNotMatch(body, /\/Users\/airlock\/agent-os/);
  assert.match(body, /\\<path-redacted\\>\/adversarial-review/);
});

test('worker blockers mask /private/var/folders/ temp paths', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'claude-code',
    action: 'stopped',
    job: { ...makeJob(), remediationPlan: { currentRound: 1, maxRounds: 6, stop: { code: 'no-progress' } } },
    reply: {
      outcome: 'blocked',
      summary: 'cannot proceed',
      validation: [],
      blockers: [
        {
          finding: 'Need to inspect the temp artifact noted in the review.',
          reasoning: 'Cannot read /private/var/folders/k7/abc123/T/tmp.XXX/data.json',
        },
      ],
    },
    reReview: { requested: false },
  });
  assert.doesNotMatch(body, /\/private\/var\/folders/);
  assert.match(body, /\\<path-redacted\\>\/data\.json/);
});

test('reReview.reason masks absolute paths in the inline status line', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: [], blockers: [] },
    reReview: {
      requested: true,
      triggered: true,
      status: 'pending',
      reason: 'Need rerun after touching /Users/airlock/agent-os/spec.md',
    },
  });
  assert.doesNotMatch(body, /\/Users\/airlock/);
  assert.match(body, /<path-redacted>\/spec\.md/);
});

test('buildRemediationOutcomeCommentBody redacts tokens in the worker summary', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      // Worker echoed an OpenAI-shaped key, a GitHub PAT, and a labelled
      // secret from a log line into its summary. None of these may
      // appear verbatim in the public PR comment.
      summary: 'Fixed the env loader. Logs showed sk-test_abcdef1234567 and ghp_aaaabbbbccccdddd1234 — also api_key=ZZZZZZZZZ.',
      validation: ['npm test'],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  assert.doesNotMatch(body, /sk-test_abcdef1234567/);
  assert.doesNotMatch(body, /ghp_aaaabbbbccccdddd1234/);
  assert.doesNotMatch(body, /api_key=ZZZZZZZZZ/i);
  // Block-context defang escapes the placeholder's `[`, `]`, and `_`
  // so the source markdown has `\[REDACTED\_OPENAI\_TOKEN\]`. GFM
  // renders that as literal `[REDACTED_OPENAI_TOKEN]` to the reader.
  assert.match(body, /\\\[REDACTED\\_OPENAI\\_TOKEN\\\]/);
  assert.match(body, /\\\[REDACTED\\_GITHUB\\_TOKEN\\\]/);
  assert.match(body, /api\\_key=\\\[REDACTED\\\]/);
});

test('buildRemediationOutcomeCommentBody redacts tokens in validation and blockers entries', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'claude-code',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Done.',
      validation: ['curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" https://example.com/api'],
      blockers: [
        {
          finding: 'Reviewer asked us to confirm the bot credential.',
          reasoning: 'Could not verify token sk-ant-test_xxxxxxxxxxxxxxxxxxxx — please rotate',
        },
      ],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  assert.doesNotMatch(body, /eyJhbGciOiJIUzI1NiJ9\.payload\.sig/);
  assert.doesNotMatch(body, /sk-ant-test_xxxxxxxxxxxxxxxxxxxx/);
  assert.match(body, /Bearer \\\[REDACTED\\\]/);
  assert.match(body, /\\\[REDACTED\\_ANTHROPIC\\_TOKEN\\\]/);
});

test('buildRemediationOutcomeCommentBody caps a runaway summary at the configured length', () => {
  const huge = 'A'.repeat(50_000);
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: huge, validation: [], blockers: [] },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  // The summary section must not contain the entire 50K-char run; the
  // truncation marker (…) must appear instead.
  assert.ok(body.length < 10_000, `body should be capped well below the runaway summary; got ${body.length} chars`);
  assert.match(body, /…/);
});

test('buildRemediationOutcomeCommentBody caps the validation/blockers list size', () => {
  const items = Array.from({ length: 200 }, (_, i) => `step-${i}`);
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: items, blockers: [] },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  // Cap is 25 entries; step-25 onwards must be truncated. Each entry
  // is rendered as a defanged plain bullet (one line per item).
  assert.match(body, /^- step-0$/m);
  assert.match(body, /^- step-24$/m);
  assert.doesNotMatch(body, /^- step-25$/m);
  assert.doesNotMatch(body, /^- step-100$/m);
});

test('buildRemediationOutcomeCommentBody redacts tokens in the rereview reason', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: [], blockers: [] },
    reReview: {
      requested: true,
      triggered: true,
      status: 'pending',
      reason: 'Need to verify ghp_aaaaaaaaaaaaaaaaaaaa works after rotation',
    },
  });
  assert.doesNotMatch(body, /ghp_aaaaaaaaaaaaaaaaaaaa/);
  // Inline-safe rendering: backtick-wrapped so any markdown the worker
  // tries to smuggle stays inert. Token still got redacted before the
  // backtick wrap.
  assert.match(body, /Re-review status:.*queued — `Need to verify \[REDACTED_GITHUB_TOKEN\] works after rotation`/);
});

// ── Markdown injection mitigations ────────────────────────────────────────

test('worker @mentions inside summary do not render as live mentions (defanged with ZWSP)', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      summary: 'Pinging @paul-lacey and @laceyenterprises/security to follow up.',
      validation: ['ran @ci/tests'],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  // Every `@` followed by [A-Za-z0-9_-] must have a U+200B (ZWSP)
  // inserted after it so GitHub's mention autolinker stops matching.
  // The literal text is preserved so the operator can still read what
  // the worker tried to say.
  assert.match(body, /Pinging @​paul-lacey and @​laceyenterprises\/security to follow up\./);
  assert.match(body, /^- ran @​ci\/tests$/m);
  // No raw `@user` (without ZWSP) anywhere in the rendered body —
  // otherwise the autolinker would fire.
  assert.doesNotMatch(body, /(?<![@​])@paul-lacey/);
  assert.doesNotMatch(body, /(?<![@​])@laceyenterprises/);
});

test('worker injection of headings or task lists is inert (defanged with backslash-escape)', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      summary: '# Hijacked H1 heading\n- [x] Forged task item\n<img src=x onerror=alert(1)>',
      validation: ['## not actually a heading'],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  // Heading `#`, task-list `[ ]`, raw HTML `<` `>`, and the leading
  // bullet `-` are all backslash-escaped so GFM renders them as literal
  // characters. ZWSP after `\#` ensures GitHub's issue/PR autolinker
  // does not fire on `#123`-shaped content (defense-in-depth even
  // though "Hijacked" isn't a digit).
  assert.match(body, /\\# Hijacked H1 heading/);
  assert.match(body, /\\- \\\[x\\\] Forged task item/);
  assert.match(body, /\\\[x\\\] Forged task item/);
  assert.match(body, /\\<img src=x onerror=alert\\\(1\\\)\\>/);
  assert.match(body, /^- \\#\\# not actually a heading$/m);
  // No raw heading markers at start of line.
  assert.doesNotMatch(body, /^# Hijacked H1 heading$/m);
  assert.doesNotMatch(body, /^## not actually a heading$/m);
});

test('worker text containing triple-backticks cannot open a fenced code block', () => {
  // A worker that drops a "```" run inside its summary used to be
  // protected by wrapping everything in a `text fence; that produced
  // ugly walls of monospace prose. The current defang policy escapes every
  // backtick delimiter, so neither inline code nor fenced code can open.
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      summary: 'Run ```bash\necho hi\n``` to see output',
      validation: [],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  // No run of three consecutive backticks remains anywhere in the body
  // because each delimiter is backslash-escaped.
  assert.doesNotMatch(body, /```/);
  assert.match(body, /Run \\`\\`\\`bash\necho hi\n\\`\\`\\` to see output/);
});

test('rereview.reason with worker-injected mention is wrapped inline-safe (no live mention)', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: [], blockers: [] },
    reReview: {
      requested: true,
      triggered: true,
      status: 'pending',
      reason: 'cc @paul-lacey for visibility',
    },
  });
  // Inline backtick wrap renders the @mention as plain text, not a
  // GitHub notification. The `@` is still visible to humans reading
  // the rendered comment.
  assert.match(body, /Re-review status:.*queued — `cc @paul-lacey for visibility`/);
});

// ── Failure message path redaction (R3 review #3) ─────────────────────────

test('failure.message has absolute /Users/<user>/ paths masked before posting', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'failed',
    job: makeJob({ builderTag: 'codex' }),
    failure: {
      code: 'invalid-remediation-reply',
      message: 'Failed to read remediation reply artifact at /Users/airlock/agent-os/tools/adversarial-review/data/follow-up-jobs/workspaces/laceyenterprises__demo-pr-7-2026-05-01T20-00-00-000Z/.adversarial-follow-up/remediation-reply.json',
    },
  });
  // Host filesystem layout must not appear verbatim.
  assert.doesNotMatch(body, /\/Users\/airlock/);
  assert.doesNotMatch(body, /agent-os\/tools\/adversarial-review/);
  // The basename survives so an operator can recognize the artifact.
  assert.match(body, /<path-redacted>\/remediation-reply\.json/);
});

test('failure.message has /private/var/folders/... temp paths masked', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'failed',
    job: makeJob({ builderTag: 'codex' }),
    failure: {
      code: 'invalid-output-path',
      message: 'Path escapes follow-up job root: /private/var/folders/k7/xyz123/T/adversarial-review-abc/data/oops.txt',
    },
  });
  assert.doesNotMatch(body, /\/private\/var\/folders/);
  assert.match(body, /<path-redacted>\/oops\.txt/);
});

test('failure.message has tokens redacted (defense in depth — internal exceptions can echo log lines)', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'failed',
    job: makeJob({ builderTag: 'codex' }),
    failure: {
      code: 'gh-cli-failure',
      message: 'Command failed: GH_TOKEN=ghp_deadbeefcafebabe1234 gh pr comment...',
    },
  });
  assert.doesNotMatch(body, /ghp_deadbeefcafebabe1234/);
  assert.match(body, /\[REDACTED_GITHUB_TOKEN\]/);
});

test('failure.message preserves non-path identifiers (code names like manual-inspection-required)', () => {
  // Non-path failure codes stay intact — they're our own structured
  // identifiers and operators rely on them in runbooks.
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'failed',
    job: makeJob({ builderTag: 'codex' }),
    failure: { code: 'manual-inspection-required', message: 'Worker PID 8123 still running past runtime cap' },
  });
  assert.match(body, /Reason: `Worker PID 8123 still running past runtime cap`/);
});

// ── Worker-supplied PUBLIC field path redaction (review #1 of PR #18) ──────
// Worker output crosses the trust boundary into a public PR comment. Beyond
// tokens, it can echo absolute filesystem paths from logs / stack traces —
// /Users/<operator>/..., /private/var/folders/... — which leak operator
// usernames, repo layout, and machine-local filesystem details. The
// public-safe path masking must run on every worker-supplied field that
// reaches the comment body.

test('summary redacts /Users/<user>/... paths echoed by the worker', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: {
      outcome: 'completed',
      summary: 'Read prompt at /Users/airlock/agent-os/tools/adversarial-review/.adversarial-follow-up/prompt.md and patched it.',
      validation: ['npm test'],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  assert.doesNotMatch(body, /\/Users\/airlock/);
  assert.doesNotMatch(body, /agent-os\/tools\/adversarial-review/);
  // Basename survives so an operator can still recognize what was referenced.
  assert.match(body, /\\<path-redacted\\>\/prompt\.md/);
});

test('validation entries redact /private/var/folders/... temp paths', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'claude-code',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'ok',
      validation: [
        'wrote scratch artifact at /private/var/folders/k7/abc123/T/foo/artifact.json then removed it',
      ],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  assert.doesNotMatch(body, /\/private\/var\/folders/);
  assert.match(body, /\\<path-redacted\\>\/artifact\.json/);
});

test('blockers entries redact /home/<user>/... paths (Linux operator path)', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'stopped',
    job: {
      ...makeJob({ builderTag: 'codex' }),
      remediationPlan: { currentRound: 1, maxRounds: 6, stop: { code: 'no-progress' } },
    },
    reply: {
      outcome: 'blocked',
      summary: 'cannot proceed',
      validation: [],
      blockers: [
        {
          finding: 'Reviewer wants logs from the runner host.',
          reasoning: 'Cannot read /home/runner/work/adversarial-review/data/reviews.db — permission denied',
        },
      ],
    },
  });
  assert.doesNotMatch(body, /\/home\/runner/);
  assert.match(body, /\\<path-redacted\\>\/reviews\.db/);
});

test('reReview.reason redacts host-local paths inline (in the status line)', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: [], blockers: [] },
    reReview: {
      requested: true,
      triggered: true,
      status: 'pending',
      reason: 'Confirm fix at /Users/placey/agent-os/tools/adversarial-review/src/adapters/comms/github-pr-comments/pr-comments.mjs',
    },
  });
  assert.doesNotMatch(body, /\/Users\/placey/);
  // Basename survives in the inline-wrapped status line.
  assert.match(body, /Re-review status:.*queued — `Confirm fix at <path-redacted>\/pr-comments\.mjs`/);
});

// ── Idempotency marker (review #4 of PR #18) ───────────────────────────────

test('buildRemediationOutcomeCommentMarker derives a stable id from jobId+round+action', () => {
  const a = buildRemediationOutcomeCommentMarker({
    jobId: 'lac__demo-pr-7-2026-05-01T20-00-00-000Z',
    round: 2,
    action: 'completed',
  });
  const b = buildRemediationOutcomeCommentMarker({
    jobId: 'lac__demo-pr-7-2026-05-01T20-00-00-000Z',
    round: 2,
    action: 'completed',
  });
  assert.equal(a, b, 'same inputs must produce the same marker');
  assert.ok(a.startsWith(REMEDIATION_COMMENT_MARKER_PREFIX + ':'), 'marker carries the well-known prefix');

  const different = buildRemediationOutcomeCommentMarker({
    jobId: 'lac__demo-pr-7-2026-05-01T20-00-00-000Z',
    round: 3,
    action: 'completed',
  });
  assert.notEqual(a, different, 'different round must produce a different marker');
});

test('comment body includes the dedupe marker as an HTML comment', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: [], blockers: [] },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  const expectedMarker = buildRemediationOutcomeCommentMarker({
    jobId: 'lac__demo-pr-7-2026-05-01T20-00-00-000Z',
    round: 2,
    action: 'completed',
  });
  assert.ok(
    body.includes(`<!-- ${expectedMarker} -->`),
    `body must embed the marker as an HTML comment; got:\n${body}`
  );
  assert.equal(extractRemediationCommentMarker(body), expectedMarker);
});

test('postRemediationOutcomeComment skips the create when an existing comment carries the marker', async () => {
  const calls = [];
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: [], blockers: [] },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  const marker = extractRemediationCommentMarker(body);
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'codex',
    body,
    env: { GH_CODEX_REVIEWER_TOKEN: 'pat', PATH: '/usr/bin', HOME: '/tmp' },
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    findExistingImpl: async ({ marker: lookupMarker }) => {
      assert.equal(lookupMarker, marker, 'dedup lookup must search by the body marker');
      return { found: true, marker: lookupMarker, commentId: 12345 };
    },
    log: { error: () => {} },
  });
  assert.equal(result.posted, true);
  assert.equal(result.deduped, true);
  assert.equal(result.commentId, 12345);
  assert.equal(calls.length, 0, 'must not invoke gh pr comment when a duplicate already exists');
});

test('postRemediationOutcomeComment posts when the dedup lookup finds nothing', async () => {
  const calls = [];
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: [], blockers: [] },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'codex',
    body,
    env: { GH_CODEX_REVIEWER_TOKEN: 'pat', PATH: '/usr/bin', HOME: '/tmp' },
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    findExistingImpl: async () => ({ found: false }),
    log: { error: () => {} },
  });
  assert.equal(result.posted, true);
  assert.equal(result.deduped, undefined);
  assert.equal(calls.length, 1, 'must invoke gh pr comment exactly once when no duplicate is found');
  assert.equal(calls[0].args[0], 'pr');
  assert.equal(calls[0].args[1], 'comment');
});

test('postRemediationOutcomeComment falls through to post when the dedup lookup itself fails', async () => {
  // A flake in the lookup path must NOT silently suppress the post —
  // we'd rather risk a duplicate than leave the PR with no comment.
  const calls = [];
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob({ builderTag: 'codex' }),
    reply: { outcome: 'completed', summary: 'ok', validation: [], blockers: [] },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  const result = await postRemediationOutcomeComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    workerClass: 'codex',
    body,
    env: { GH_CODEX_REVIEWER_TOKEN: 'pat', PATH: '/usr/bin', HOME: '/tmp' },
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    findExistingImpl: async () => ({ found: false, lookupFailed: true, reason: 'lookup-timeout' }),
    log: { error: () => {} },
  });
  assert.equal(result.posted, true);
  assert.equal(calls.length, 1, 'lookup failure must not block the post');
});

test('findExistingRemediationComment finds the marker in a previously-posted comment', async () => {
  const calls = [];
  const result = await findExistingRemediationComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    marker: 'adversarial-review-remediation-marker:job-x:r2:completed',
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return {
        stdout:
          '{"id":1,"body":"unrelated comment"}\n' +
          '{"id":2,"body":"<!-- adversarial-review-remediation-marker:job-x:r2:completed -->\\nSome body"}\n',
        stderr: '',
      };
    },
    env: {},
    log: { error: () => {} },
  });
  assert.equal(result.found, true);
  assert.equal(result.commentId, 2);
  assert.equal(calls[0].args[0], 'api');
});

test('findExistingRemediationComment returns lookupFailed=lookup-timeout when gh times out', async () => {
  const result = await findExistingRemediationComment({
    repo: 'laceyenterprises/demo',
    prNumber: 7,
    marker: 'adversarial-review-remediation-marker:job-x:r2:completed',
    execFileImpl: async () => {
      const err = new Error('SIGTERM');
      err.killed = true;
      err.signal = 'SIGTERM';
      throw err;
    },
    env: {},
    log: { error: () => {} },
  });
  assert.equal(result.found, false);
  assert.equal(result.lookupFailed, true);
  assert.equal(result.reason, 'lookup-timeout');
});

// ── Per-finding accountability rendering (addressed[] / pushback[]) ─────────

test('buildRemediationOutcomeCommentBody renders addressed[] entries with finding/action/files', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Fixed two findings.',
      validation: ['npm test'],
      addressed: [
        {
          title: 'Retry double-submit race',
          finding: 'Race in retry path can double-submit.',
          action: 'Added an idempotency token + dedupe check.',
          files: ['src/worker.mjs', 'test/worker.test.mjs'],
        },
        {
          title: 'Auth header null guard',
          finding: 'Missing null check on auth header.',
          action: 'Added explicit guard + regression test.',
        },
      ],
      pushback: [],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending', reason: 'two fixed; ready' },
  });

  assert.match(body, /## Addressed findings/);
  // New format: bold-title top bullet with nested
  // **Finding:** / **Action:** / **Files:** sub-bullets. Files paths
  // render as inline-coded so a worker-supplied path can't break out
  // of the inline-code wrapper.
  assert.match(body, /^- \*\*Retry double-submit race\*\*$/m);
  assert.match(body, /^ {2}- \*\*Finding:\*\* Race in retry path can double-submit\.$/m);
  assert.match(body, /^ {2}- \*\*Action:\*\* Added an idempotency token \+ dedupe check\.$/m);
  assert.match(body, /^ {2}- \*\*Files:\*\* `src\/worker\.mjs`, `test\/worker\.test\.mjs`$/m);
  // Second entry has no Files: line — verify it doesn't appear
  // for that block. The full body may have `- **Files:**` from entry 1
  // already, so check that the nested files sub-bullet appears exactly once.
  const filesLines = body.match(/^ {2}- \*\*Files:\*\*/gm) || [];
  assert.equal(filesLines.length, 1, 'Files: sub-bullet only on entries that supply it');
  // Both entries should have bold-title top bullets.
  assert.match(body, /^- \*\*Auth header null guard\*\*$/m);
});

test('buildRemediationOutcomeCommentBody keeps per-finding titles inline-safe', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Fixed one finding.',
      validation: ['npm test'],
      addressed: [
        {
          title: 'Foo\n\n## Injected heading\n\nbody',
          finding: 'Title rendering can break out of its list item.',
          action: 'Collapsed title whitespace before rendering.',
        },
      ],
      pushback: [],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending', reason: 'title sanitized' },
  });

  assert.match(body, /^- \*\*Foo Injected heading body\*\*$/m);
  // A worker-injected `## Injected heading` should be collapsed into the
  // bullet title text (above) rather than escaping as a real H2 between
  // entries, and the title bullet should not split on the embedded `Foo`
  // prefix alone.
  assert.doesNotMatch(body, /\n## Injected heading\n/);
  assert.doesNotMatch(body, /^- \*\*Foo\*\*$/m);
});

test('buildRemediationOutcomeCommentBody strips unsafe title controls and falls back for empty titles', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Fixed two findings.',
      validation: ['npm test'],
      addressed: [
        {
          title: '\u202ERetry \u001B[31mdouble-submit\u001B[0m',
          finding: 'Bidi and ANSI controls should not render in headings.',
          action: 'Stripped unsafe title characters.',
        },
        {
          title: '\u202E\u200D\u2028\u2029',
          finding: 'Invisible-only titles should use the fallback heading.',
          action: 'Fell back to Finding after sanitization.',
        },
      ],
      pushback: [],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending', reason: 'title controls sanitized' },
  });

  assert.match(body, /^- \*\*Retry double-submit\*\*$/m);
  assert.match(body, /^- \*\*Finding\*\*$/m);
  assert.match(body, /Invisible-only titles should use the fallback heading\./);
  assert.doesNotMatch(body, /[\u001B\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u);
});

test('buildRemediationOutcomeCommentBody renders validator-accepted untitled per-finding entries', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Handled an untitled review.',
      validation: ['npm test'],
      addressed: [{ finding: 'Untitled addressed finding.', action: 'Applied the fix.' }],
      pushback: [{ finding: 'Untitled pushback finding.', reasoning: 'Outside this PR.' }],
      blockers: [{ finding: 'Untitled blocker finding.', reasoning: 'Needs operator input.' }],
    },
    reReview: { requested: true, triggered: true, status: 'pending', reason: 'untitled entries render' },
  });

  assert.match(body, /## Addressed findings/);
  assert.match(body, /## Pushback \(deliberately not changed\)/);
  assert.match(body, /## Blockers/);
  // Three untitled entries all fall back to the bold-title `**Finding**`
  // top bullet.
  const findingTitleBullets = body.match(/^- \*\*Finding\*\*$/gm) || [];
  assert.equal(findingTitleBullets.length, 3);
  assert.match(body, /Untitled addressed finding\./);
  assert.match(body, /Untitled pushback finding\./);
  assert.match(body, /Untitled blocker finding\./);
});

test('buildRemediationOutcomeCommentBody renders the full validator-accepted per-entry text cap', () => {
  const longAction = `Expanded reasoning ${'x'.repeat(850)} still visible at the end.`;
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Fixed one verbose finding.',
      validation: ['npm test'],
      addressed: [
        {
          finding: 'The renderer used a smaller cap than validation.',
          action: longAction,
        },
      ],
      pushback: [],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending', reason: 'caps aligned' },
  });

  assert.ok(body.includes(longAction), 'renderer should not truncate text that validation accepts');
});

test('buildRemediationOutcomeCommentBody leaves redaction expansion room for per-entry text', () => {
  const validatorSizedAction = `${'x'.repeat(1183)} sk-12345678 tail`;
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Fixed one edge case.',
      validation: ['npm test'],
      addressed: [
        {
          finding: 'The renderer truncated redaction placeholders.',
          action: validatorSizedAction,
        },
      ],
      pushback: [],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending', reason: 'redaction margin' },
  });

  // Block-context defang escapes the placeholder's `[`, `]`, and `_`.
  assert.match(body, /\\\[REDACTED\\_OPENAI\\_TOKEN\\\] tail/);
});

test('buildRemediationOutcomeCommentBody omits malformed per-finding sections instead of posting empty buckets', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Malformed reply fields should not leak into the comment.',
      validation: ['npm test'],
      addressed: [
        {
          title: '',
          finding: '{"stdout":"raw worker dump","stderr":"noise"}',
          action: '```diff\n- old\n+ new\n```',
        },
      ],
      pushback: [
        {
          title: 'Noisy pushback',
          finding: '<tool_call name="exec">...</tool_call>',
          reasoning: 'Traceback (most recent call last): boom',
        },
      ],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending', reason: 'ready' },
  });

  assert.doesNotMatch(body, /\*\*Addressed findings\*\*/);
  assert.doesNotMatch(body, /\*\*Pushback \(deliberately not changed\)\*\*/);
  assert.doesNotMatch(body, /raw worker dump/);
  assert.doesNotMatch(body, /tool_call/);
});

test('buildRemediationOutcomeCommentBody renders pushback[] entries with finding/reasoning', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Two fixed, one pushed back.',
      validation: ['npm test'],
      addressed: [],
      pushback: [
        {
          title: 'Over-broad dispatch refactor',
          finding: 'Reviewer asked to refactor the entire dispatch module.',
          reasoning: 'Out of scope for this PR; tracked as separate ticket LAC-99.',
        },
      ],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending', reason: 'pushback recorded' },
  });

  assert.match(body, /## Pushback \(deliberately not changed\)/);
  assert.match(body, /^- \*\*Over-broad dispatch refactor\*\*$/m);
  assert.match(body, /^ {2}- \*\*Finding:\*\* Reviewer asked to refactor the entire dispatch module\.$/m);
  assert.match(body, /^ {2}- \*\*Reasoning:\*\* Out of scope for this PR; tracked as separate ticket LAC-99\.$/m);
});

test('buildRemediationOutcomeCommentBody omits addressed/pushback sections when empty or absent', () => {
  // Empty arrays.
  const bodyEmpty = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Fixed.',
      validation: ['npm test'],
      addressed: [],
      pushback: [],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  assert.doesNotMatch(bodyEmpty, /Addressed findings/);
  assert.doesNotMatch(bodyEmpty, /Pushback/);

  // Field absent (legacy reply, e.g. an older job's stored reply).
  const bodyLegacy = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Fixed.',
      validation: ['npm test'],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });
  assert.doesNotMatch(bodyLegacy, /Addressed findings/);
  assert.doesNotMatch(bodyLegacy, /Pushback/);
});

test('buildRemediationOutcomeCommentBody redacts host-local paths smuggled into addressed/pushback', () => {
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Fixed.',
      validation: ['npm test'],
      addressed: [
        {
          title: 'Host-local addressed path',
          finding: 'Bug at /Users/airlock/secret-project/src/worker.mjs',
          action: 'Patched the function in /Users/airlock/secret-project/src/worker.mjs',
        },
      ],
      pushback: [
        {
          title: 'Host-local pushback path',
          finding: 'Reviewer at /Users/airlock/private/notes.md asked for X',
          reasoning: 'Discussed in /private/var/folders/zz/T/scratchpad.md',
        },
      ],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });

  // The redaction pipeline replaces host-local paths with a
  // <path-redacted> placeholder. We don't pin the exact text — that
  // belongs to the redaction tests — but assert the operator's home
  // directory does not appear in the rendered body.
  assert.doesNotMatch(body, /\/Users\/airlock\/secret-project/);
  assert.doesNotMatch(body, /\/Users\/airlock\/private/);
  assert.doesNotMatch(body, /\/private\/var\/folders\/zz/);
  // Sanity: section headers still render so the operator can tell the
  // sections existed even after redaction.
  assert.match(body, /## Addressed findings/);
  assert.match(body, /## Pushback \(deliberately not changed\)/);
});

test('buildRemediationOutcomeCommentBody renders all four sections (summary, addressed, pushback, blockers) when populated', () => {
  // Stopped + worker-blocked: addressed[] documents partial work,
  // pushback[] documents deliberate disagreement on a separate finding,
  // blockers[] documents the hard exit. All three coexist.
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'stopped',
    job: {
      ...makeJob(),
      remediationPlan: { currentRound: 2, maxRounds: 3, stop: { code: 'no-progress' } },
    },
    reply: {
      outcome: 'blocked',
      summary: 'Hit a hard exit on the schema migration.',
      validation: ['npm test'],
      addressed: [
        { title: 'Null-handling bug', finding: 'Null-handling bug', action: 'Added a guard.' },
      ],
      pushback: [
        { title: 'Full refactor request', finding: 'Reviewer wants a full refactor', reasoning: 'Out of scope.' },
      ],
      blockers: [
        {
          title: 'Schema migration',
          finding: 'Reviewer asks for the schema migration.',
          reasoning: 'Schema migration requires DBA review.',
          needsHumanInput: 'DBA approval + maintenance window',
        },
      ],
    },
    reReview: { requested: false },
  });

  assert.match(body, /## Summary/);
  assert.match(body, /## Addressed findings/);
  assert.match(body, /## Pushback \(deliberately not changed\)/);
  assert.match(body, /## Blockers/);
  // Structured blocker carries the originating review finding and a
  // needsHumanInput line so the human reviewer can see exactly which
  // finding was deferred and what input is needed.
  assert.match(body, /Reviewer asks for the schema migration\./);
  assert.match(body, /Schema migration requires DBA review\./);
  assert.match(body, /\*\*Needs human input:\*\*/);
  assert.match(body, /DBA approval \+ maintenance window/);
  // Order matters for readability — the reader should see what was
  // done before what wasn't.
  const idxAddressed = body.indexOf('Addressed findings');
  const idxPushback = body.indexOf('Pushback');
  const idxBlockers = body.indexOf('Blockers');
  assert.ok(idxAddressed < idxPushback, 'addressed renders before pushback');
  assert.ok(idxPushback < idxBlockers, 'pushback renders before blockers');
});

test('buildRemediationOutcomeCommentBody truncates an absurdly long Files: line on an addressed entry', () => {
  // A worker that decides to dump every file in the repo into one
  // entry's `files` array would otherwise produce a 50KB Files: line
  // on the public PR comment. The renderer caps it.
  const manyFiles = Array.from({ length: 200 }, (_v, i) => `src/file-${i}.mjs`);
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'completed',
    job: makeJob(),
    reply: {
      outcome: 'completed',
      summary: 'Lots of files.',
      validation: [],
      addressed: [
        {
          title: 'Sweeping refactor',
          finding: 'Sweeping refactor.',
          action: 'Touched many files.',
          files: manyFiles,
        },
      ],
      pushback: [],
      blockers: [],
    },
    reReview: { requested: true, triggered: true, status: 'pending' },
  });

  // The cap is generous (~600 chars) so we don't pin an exact length;
  // we assert the truncation marker is present and the comment is not
  // the unbounded ~5KB it would be without truncation. (Each file
  // wrapped in inline backticks is ~17 chars + ", " → 200 × 19 = ~3800
  // chars without the cap.)
  assert.match(body, /\*\*Files:\*\*.*…/);
  // The full unbounded join would include "src/file-199.mjs" — the
  // cap cuts off well before then. Per-bullet redaction may further
  // cap the entry; either way the highest-numbered file we see should
  // be far below 199.
  const fileMatches = body.match(/src\/file-(\d+)\.mjs/g) || [];
  const numbers = fileMatches.map((m) => Number(m.match(/(\d+)/)[1]));
  const maxFileNum = numbers.length ? Math.max(...numbers) : 0;
  assert.ok(maxFileNum < 100, `expected truncation well below 200 files, got max=${maxFileNum}`);
});

test('buildRemediationOutcomeCommentBody renders round-budget-exhausted with risk class and operator next step', () => {
  // Track A surfaces a new stop code from the daemon. The renderer
  // must produce a comment that names the riskClass tier, the budget,
  // and the operator-next-step (review prior rounds, decide whether
  // to reopen the spec at a higher tier or accept as-is). Mirrors the
  // existing `max-rounds-reached` branch shape.
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'stopped',
    job: {
      jobId: 'lac__demo-pr-7-2026-05-01T20-00-00-000Z',
      repo: 'laceyenterprises/demo',
      prNumber: 7,
      riskClass: 'medium',
      remediationPlan: {
        currentRound: 1,
        maxRounds: 1,
        stop: { code: 'round-budget-exhausted' },
      },
    },
  });

  assert.match(body, /Outcome:.*stopped.*round-budget-exhausted/);
  assert.match(body, /medium.*risk-class remediation budget \(1 round/);
  assert.match(body, /completed: 1/);
  assert.match(body, /reopen the linked spec to justify a higher.*riskClass/);
  assert.match(body, /Human intervention required/);
});

test('buildRemediationOutcomeCommentBody salvages worker response on invalid-remediation-reply failure', () => {
  // Strict validator rejected the reply (e.g. reReview.reason was null
  // while requested was true), but the rest of the worker's output —
  // summary, addressed[], pushback[], blockers[] — parsed cleanly. The
  // failure comment must surface the recovered worker response so the
  // operator can see the point-by-point work the worker did, instead
  // of the generic "did not produce a usable remediation reply"
  // message that would otherwise drop everything on the floor.
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'failed',
    job: makeJob(),
    reply: {
      summary: 'Preserved opened_at, made events idempotent, verified cascades.',
      validation: ['python3 platform/session-ledger/tests/test_turn_observability.py'],
      addressed: [
        {
          title: 'Turn attempts opened_at preservation',
          finding: 'turn_attempts upsert overwrites opened_at on partial updates.',
          action: 'Changed conflict update to preserve opened_at and other nullable fields.',
          files: ['platform/session-ledger/src/session_ledger/db.py'],
        },
      ],
      pushback: [],
      blockers: [],
    },
    failure: {
      code: 'invalid-remediation-reply',
      message: 'Remediation reply reReview.reason is required when reReview.requested is true',
    },
  });

  assert.match(body, /Outcome:.*failed/);
  assert.match(body, /Reason: `Remediation reply reReview\.reason is required/);
  // Soft human-intervention message — not the "did not produce a
  // usable remediation reply" line, since we DID recover content.
  assert.match(body, /failed strict schema validation.*recovered below/);
  // Salvaged sections render below the failure header. Block-context
  // defang escapes `_within_word` so `opened_at` appears in source as
  // `opened\_at` and renders to the operator as `opened_at`.
  assert.match(body, /## Summary/);
  assert.match(body, /Preserved opened\\_at, made events idempotent/);
  assert.match(body, /## Addressed findings/);
  assert.match(body, /^- \*\*Turn attempts openedat preservation\*\*$/m);
  assert.match(body, /turn\\_attempts upsert overwrites opened\\_at on partial updates\./);
  assert.match(body, /^ {2}- \*\*Files:\*\* `platform\/session-ledger\/src\/session_ledger\/db\.py`$/m);
});

test('buildRemediationOutcomeCommentBody on invalid-remediation-reply with no salvageable content keeps the original failure message', () => {
  // When the reply file was unparseable / empty, the salvage path
  // returns nothing renderable. The failure comment falls back to the
  // original "did not produce a usable remediation reply" line so the
  // operator knows there was no worker response to inspect.
  const body = buildRemediationOutcomeCommentBody({
    workerClass: 'codex',
    action: 'failed',
    job: makeJob(),
    reply: null,
    failure: {
      code: 'invalid-remediation-reply',
      message: 'Failed to read remediation reply artifact',
    },
  });

  assert.match(body, /Outcome:.*failed/);
  assert.match(body, /did not produce a usable remediation reply/);
  assert.doesNotMatch(body, /failed strict schema validation/);
});
