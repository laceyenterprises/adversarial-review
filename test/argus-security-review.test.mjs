// ARGUSDRAIN-01 — reviewing one Argus job: liveness first, the verdict composed
// from evidence under the reserved-high taxonomy, and a blocking finding posted
// before it is recorded. All I/O is injected; nothing reaches GitHub or a model.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARGUS_REVIEW_OUTCOME,
  buildArgusFindingsComment,
  composeArgusVerdict,
  normalizeArgusFinding,
  parseArgusReviewOutput,
  reviewArgusJob,
  shouldPostArgusComment,
  trimDiffForArgusPrompt,
} from '../src/argus-security-review.mjs';
import { resolveArgusCommentIdentity, resolveConfiguredArgusReviewerModels } from '../src/argus-security-review-deps.mjs';

const HEAD = 'c'.repeat(40);
const NOW = Date.parse('2026-09-29T12:00:00.000Z');
const quiet = { log() {}, warn() {}, error() {} };

function job(overrides = {}) {
  return {
    jobId: `laceyenterprises__adversarial-review-pr-1172-${HEAD}`,
    repo: 'laceyenterprises/adversarial-review',
    prNumber: 1172,
    headSha: HEAD,
    status: 'in_progress',
    reasons: [{ trigger: 'manifest-change', ecosystems: ['npm'] }],
    enqueuedAt: '2026-09-29T11:00:00.000Z',
    claimedAt: '2026-09-29T11:59:00.000Z',
    ...overrides,
  };
}

function reviewText(doc) {
  return [
    '## Argus Security Review',
    'Summary paragraph.',
    '',
    '## Findings JSON',
    '<argus-review-json>',
    JSON.stringify(doc),
    '</argus-review-json>',
    '',
    '## Verdict',
    doc.verdict === 'block' ? 'Request changes' : 'Approve',
  ].join('\n');
}

function deps(overrides = {}) {
  const calls = { models: [], posts: [] };
  const base = {
    fetchPullRequest: async () => ({ state: 'OPEN', headSha: HEAD, baseSha: 'b'.repeat(40), title: 'chore(deps): bump x', author: 'app/dependabot' }),
    fetchDiff: async () => 'diff --git a/package.json b/package.json\n+  "x": "2.0.0"\n',
    resolveReviewerModels: async () => ['claude', 'gemini'],
    runReviewerModel: async ({ model }) => {
      calls.models.push(model);
      return { text: reviewText({ verdict: 'approve', summary: 'fine', findings: [] }), execution: { harness: model } };
    },
    postComment: async ({ body }) => {
      calls.posts.push(body);
      return { ok: true, url: 'https://github.com/o/r/pull/1#issuecomment-1', identity: 'GH_ARGUS_REVIEWER_TOKEN' };
    },
    ...overrides,
  };
  return { deps: base, calls };
}

test('the taxonomy demotes a high outside the reserved categories and caps version distance', () => {
  const reserved = normalizeArgusFinding({ category: 'install-time execution', severity: 'HIGH', title: 't' });
  assert.equal(reserved.category, 'install_time_execution');
  assert.equal(reserved.severity, 'high');

  const demoted = normalizeArgusFinding({ category: 'breaking_change', severity: 'high', title: 't' });
  assert.equal(demoted.severity, 'medium');
  assert.equal(demoted.demotedFrom, 'high');

  const capped = normalizeArgusFinding({ category: 'version_distance', severity: 'medium', title: 't' });
  assert.equal(capped.severity, 'low');
  assert.equal(capped.demotedFrom, 'medium');
});

test('the parser requires the JSON contract and one of the three verdicts', () => {
  const parsed = parseArgusReviewOutput(reviewText({
    verdict: 'approve',
    summary: 's',
    riskDirection: 'reduced',
    findings: [{ category: 'blast_radius', severity: 'low', title: 'runtime dep' }],
  }));
  assert.equal(parsed.verdict, 'approve');
  assert.equal(parsed.riskDirection, 'reduced');
  assert.equal(parsed.findings[0].source, 'model');

  assert.throws(() => parseArgusReviewOutput('## Verdict\nApprove'), /no <argus-review-json> block/u);
  assert.throws(() => parseArgusReviewOutput('<argus-review-json>{nope</argus-review-json>'), /not JSON/u);
  assert.throws(
    () => parseArgusReviewOutput(reviewText({ verdict: 'superseded', findings: [] })),
    /not approve\/block\/needs_verification/u,
  );
});

test('the verdict is composed from findings, not taken from the model', () => {
  const high = normalizeArgusFinding({ category: 'missing_integrity', severity: 'high', title: 'no integrity' });
  const medium = normalizeArgusFinding({ category: 'breaking_change', severity: 'high', title: 'api removed' });

  // A model that says approve over a reserved high still blocks.
  assert.equal(composeArgusVerdict({ modelReview: { verdict: 'approve', findings: [high] } }).verdict, 'block');
  // A model that says block without a reserved high does not block.
  assert.equal(composeArgusVerdict({ modelReview: { verdict: 'block', findings: [medium] } }).verdict, 'approve');
  // Unsatisfied required verification holds, but never outranks a block.
  const holding = composeArgusVerdict({
    modelReview: { verdict: 'approve', findings: [] },
    verification: { required: true, satisfied: false, detail: 'CI red' },
  });
  assert.equal(holding.verdict, 'needs_verification');
  assert.match(holding.summary, /CI red/u);
  assert.equal(composeArgusVerdict({
    modelReview: { verdict: 'approve', findings: [high] },
    verification: { required: true, satisfied: false },
  }).verdict, 'block');
});

test('a merged PR is closed superseded without a model call or a post', async () => {
  const { deps: d, calls } = deps({
    fetchPullRequest: async () => ({ state: 'MERGED', headSha: HEAD }),
  });
  const outcome = await reviewArgusJob({ job: job(), deps: d, workDir: '/nonexistent', nowMs: NOW, logger: quiet, promptTemplate: 'T' });
  assert.equal(outcome.kind, ARGUS_REVIEW_OUTCOME.COMPLETE);
  assert.equal(outcome.result.verdict, 'superseded');
  assert.equal(outcome.result.supersededReason, 'pr-merged');
  assert.deepEqual(calls.models, []);
  assert.deepEqual(calls.posts, []);
});

test('a moved head is closed superseded: a review is bound to the tree it read', async () => {
  const { deps: d, calls } = deps({
    fetchPullRequest: async () => ({ state: 'OPEN', headSha: 'd'.repeat(40) }),
  });
  const outcome = await reviewArgusJob({ job: job(), deps: d, workDir: '/x', nowMs: NOW, logger: quiet, promptTemplate: 'T' });
  assert.equal(outcome.result.verdict, 'superseded');
  assert.equal(outcome.result.supersededReason, 'head-superseded');
  assert.equal(outcome.result.observedHeadSha, 'd'.repeat(40));
  assert.deepEqual(calls.models, []);
});

test('an unparseable first model falls through to the next available model', async () => {
  const { deps: d, calls } = deps({
    runReviewerModel: async ({ model }) => {
      calls.models.push(model);
      if (model === 'claude') return { text: 'I think it is fine.' };
      return { text: reviewText({ verdict: 'approve', summary: 'gemini says fine', findings: [] }) };
    },
  });
  const outcome = await reviewArgusJob({ job: job(), deps: d, workDir: '/x', nowMs: NOW, logger: quiet, promptTemplate: 'T' });
  assert.equal(outcome.kind, ARGUS_REVIEW_OUTCOME.COMPLETE);
  assert.equal(outcome.result.verdict, 'approve');
  assert.equal(outcome.result.reviewer.model, 'gemini');
  assert.deepEqual(calls.models, ['claude', 'gemini']);
  assert.match(outcome.result.reviewer.attempts[0].error, /no <argus-review-json>/u);
});

test('when every model fails the job is retried with each failure named', async () => {
  const { deps: d } = deps({
    runReviewerModel: async ({ model }) => {
      throw new Error(`${model} execution failed`);
    },
  });
  const outcome = await reviewArgusJob({ job: job(), deps: d, workDir: '/x', nowMs: NOW, logger: quiet, promptTemplate: 'T' });
  assert.equal(outcome.kind, ARGUS_REVIEW_OUTCOME.RETRY);
  assert.match(outcome.error, /claude: claude execution failed \| gemini: gemini execution failed/u);
});

test('no available reviewer model defers instead of failing', async () => {
  const { deps: d } = deps({ resolveReviewerModels: async () => [] });
  const outcome = await reviewArgusJob({ job: job(), deps: d, workDir: '/x', nowMs: NOW, logger: quiet, promptTemplate: 'T' });
  assert.equal(outcome.kind, ARGUS_REVIEW_OUTCOME.DEFER);
  assert.equal(outcome.reason, 'no-reviewer-model-available');
});

test('a block is recorded only after its finding posts; a failed post retries without a second model call', async () => {
  const finding = { category: 'install_time_execution', severity: 'high', title: 'new postinstall in synthetic-pkg', detail: 'scripts.postinstall executes a remote installer' };
  const blockReview = reviewText({
    verdict: 'block',
    summary: 'adds a postinstall',
    findings: [finding],
  });
  let posts = 0;
  const { deps: d, calls } = deps({
    // Exercise the posting contract with deterministic blocking evidence;
    // the model's unsupported claim is advisory under REVIEWEVIDENCE-01.
    gatherEvidence: async () => ({ sections: [], rubricFindings: [{ ...finding, source: 'rubric' }] }),
    runReviewerModel: async ({ model }) => {
      calls.models.push(model);
      return { text: blockReview };
    },
    postComment: async () => {
      posts += 1;
      if (posts === 1) return { ok: false, error: 'HTTP 502' };
      return { ok: true, url: 'https://github.com/o/r/pull/1#issuecomment-9' };
    },
  });

  const first = await reviewArgusJob({ job: job(), deps: d, workDir: '/x', nowMs: NOW, logger: quiet, promptTemplate: 'T' });
  assert.equal(first.kind, ARGUS_REVIEW_OUTCOME.RETRY);
  assert.match(first.error, /blocking finding could not be posted: HTTP 502/u);
  assert.ok(first.cachedReview);

  const second = await reviewArgusJob({
    job: job({ drain: { attempts: 1, cachedReview: first.cachedReview } }),
    deps: d,
    workDir: '/x',
    nowMs: NOW + 5 * 60 * 1000,
    logger: quiet,
    promptTemplate: 'T',
  });
  assert.equal(second.kind, ARGUS_REVIEW_OUTCOME.COMPLETE);
  assert.equal(second.result.verdict, 'block');
  assert.equal(second.result.posted.ok, true);
  assert.deepEqual(calls.models, ['claude'], 'the retry reused the cached review');
});

test('a clean additive approval on a routable PR posts nothing; a bot PR always gets its comment', async () => {
  const clean = { verdict: 'approve', findings: [] };
  assert.equal(shouldPostArgusComment({ job: job(), result: clean }), false);
  assert.equal(shouldPostArgusComment({
    job: job({ reasons: [{ trigger: 'bot-author' }] }),
    result: clean,
  }), true);
  assert.equal(shouldPostArgusComment({
    job: job(),
    result: { verdict: 'approve', findings: [{ severity: 'low' }] },
  }), true);
  assert.equal(shouldPostArgusComment({ job: job(), result: { verdict: 'superseded', findings: [] } }), false);
});

test('the comment defangs model-written text and marks the job and head', () => {
  const body = buildArgusFindingsComment({
    job: job(),
    result: {
      verdict: 'block',
      summary: 'ping @operator and see http://evil.example',
      findings: [normalizeArgusFinding({ category: 'credential_surface', severity: 'high', title: 'token in log @someone', detail: '`GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789` echoed' })],
      reviewer: { model: 'claude' },
    },
  });
  assert.match(body, new RegExp(`<!-- argus-security-review job=\\S+ head=${HEAD} verdict=block -->`, 'u'));
  assert.match(body, /\*\*Verdict: blocked\*\*/u);
  assert.doesNotMatch(body, /@operator/u, 'mentions are broken');
  assert.doesNotMatch(body, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/u, 'secrets are redacted');
  assert.match(body, /### Blocking \(high\)/u);
});

test('lockfile hunks are trimmed and announced before the diff reaches the prompt', () => {
  const lock = ['diff --git a/package-lock.json b/package-lock.json', ...Array.from({ length: 1000 }, (_, i) => `+ line ${i}`)].join('\n');
  const src = 'diff --git a/src/a.mjs b/src/a.mjs\n+const x = 1;\n';
  const trimmed = trimDiffForArgusPrompt(`${lock}\n${src}`);
  assert.match(trimmed, /more lockfile diff lines omitted/u);
  assert.match(trimmed, /const x = 1/u);
  assert.ok(trimmed.split('\n').length < 400);
});

test('the Argus identity is preferred; the reviewing model identity is the fallback', () => {
  assert.equal(resolveArgusCommentIdentity({ model: 'claude', env: { GH_ARGUS_REVIEWER_TOKEN: 'a', GH_CLAUDE_REVIEWER_TOKEN: 'c' } }).tokenEnv, 'GH_ARGUS_REVIEWER_TOKEN');
  assert.equal(resolveArgusCommentIdentity({ model: 'claude', env: { GH_CLAUDE_REVIEWER_TOKEN: 'c' } }).tokenEnv, 'GH_CLAUDE_REVIEWER_TOKEN');
  assert.equal(resolveArgusCommentIdentity({ model: 'gemini', env: {} }), null);
  assert.deepEqual(resolveConfiguredArgusReviewerModels({}), ['claude', 'gemini', 'codex']);
  assert.deepEqual(resolveConfiguredArgusReviewerModels({ ADVERSARIAL_ARGUS_REVIEWER_MODELS: 'gemini, bogus ,claude' }), ['gemini', 'claude']);
});

test('LAC-2117: protocol-only finding reconciles only against exact deterministic proof', () => {
  const protocol = normalizeArgusFinding({ category: 'non-registry source', severity: 'high',
    title: 'file source', path: 'package-lock.json', packagePath: 'node_modules/@example/sdk', provenanceClaim: 'source_protocol' });
  const proof = [{ lockfilePath: protocol.path, packagePath: protocol.packagePath, headSha256: '1'.repeat(64) }];
  const modelReview = { verdict: 'block', summary: 'Blocked because file is untrusted.', findings: [protocol] };
  const after = composeArgusVerdict({ modelReview, verifiedArtifactSources: proof });
  assert.equal(after.verdict, 'approve');
  assert.match(after.summary, /^Argus found no high-severity finding/u);
  assert.equal(after.findings[0].category, 'non_registry_source');
  assert.equal(after.findings[0].severity, 'low');
  assert.equal(after.findings[0].originalFinding, protocol);
  assert.equal(composeArgusVerdict({ modelReview }).verdict, 'block');
  assert.equal(composeArgusVerdict({ modelReview, verifiedArtifactSources: [{ ...proof[0], packagePath: 'other' }] }).verdict, 'block');
  for (const category of ['credential_surface', 'install_time_execution', 'missing_integrity', 'unpinned_source']) {
    const unsafe = normalizeArgusFinding({ ...protocol, category });
    assert.equal(composeArgusVerdict({ modelReview: { ...modelReview, findings: [protocol, unsafe] }, verifiedArtifactSources: proof }).verdict, 'block');
  }
  const ambiguous = { ...protocol };
  delete ambiguous.provenanceClaim;
  assert.equal(composeArgusVerdict({ modelReview: { findings: [ambiguous] }, verifiedArtifactSources: proof }).verdict, 'block');
  const body = buildArgusFindingsComment({ job: job(), result: { ...after, reviewer: {} } });
  assert.match(body, /Verdict: approved/u);
  assert.match(body, /protocol-only claim disproved/u);
  assert.doesNotMatch(body, /Blocked because|not a reserved-high category/u);
});

test('LAC-2117: content-bound evidence invalidates model work; base SHA, CI and best-effort context do not', async () => {
  let artifact = 'a';
  let baseSha = 'b'.repeat(40);
  let headSha = HEAD;
  let ci = 'PENDING';
  let notes = 'release notes', usage = 'import x', lockFacts = 'old lock';
  let producer = 'main', rubricVerdict = 'approve';
  const { deps: d, calls } = deps({
    fetchPullRequest: async () => ({ state: 'OPEN', headSha, baseSha }),
    gatherEvidence: async () => ({ sections: [{ title: 'CI on this head', body: ci },
      { title: 'Upstream release notes (1 → 2)', body: notes },
      { title: "This repository's usage of the package", body: usage },
      { title: 'Lockfile facts (repository root)', body: lockFacts }],
      rubricFindings: [], rubric: { results: [{ verdict: rubricVerdict }] },
      artifactBindings: [{ consumerSha256: artifact, producer }] }),
    assessVerification: () => ci === 'PENDING' ? { defer: true } : { required: true, satisfied: true },
  });
  let previous;
  async function run() {
    const outcome = await reviewArgusJob({ job: job({ headSha, drain: { cachedReview: previous } }), deps: d, workDir: '/unused', nowMs: NOW, logger: quiet, promptTemplate: 'p' });
    previous = outcome.cachedReview;
    return outcome;
  }
  await run();
  assert.equal(calls.models.length, 1);
  await run();
  assert.equal(calls.models.length, 1);
  artifact = 'changed';
  await run();
  assert.equal(calls.models.length, 2);
  baseSha = 'a'.repeat(40);
  notes = 'Not obtained';
  usage = 'checkout moved';
  await run();
  assert.equal(calls.models.length, 2, 'base movement and best-effort reads preserve model work');
  lockFacts = 'changed base lock facts';
  await run();
  assert.equal(calls.models.length, 3);
  producer = 'changed authority';
  await run();
  assert.equal(calls.models.length, 4);
  rubricVerdict = 'needs_verification';
  await run();
  assert.equal(calls.models.length, 5);
  headSha = 'e'.repeat(40);
  await run();
  assert.equal(calls.models.length, 6);
  ci = 'SUCCESS';
  const completed = await run();
  assert.equal(completed.result.verdict, 'approve');
  assert.equal(calls.models.length, 6);
  assert.equal(completed.result.headSha, headSha);
  assert.equal(completed.result.baseSha, baseSha);
  assert.equal(completed.result.artifactBindings[0].consumerSha256, 'changed');
  assert.match(completed.result.evidenceFingerprint, /^[a-f0-9]{64}$/u);
});
