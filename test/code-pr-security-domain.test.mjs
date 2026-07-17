import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createGitHubPRSubjectAdapter } from '../src/adapters/subject/github-pr/index.mjs';
import { createGitHubPRCommentsAdapter } from '../src/adapters/comms/github-pr-comments/index.mjs';
import { createFixtureStubReviewerRuntimeAdapter } from '../src/adapters/reviewer-runtime/fixture-stub/index.mjs';
import {
  loadStagePrompt,
  pickReviewerStage,
  pickRemediatorStage,
  resolvePromptSet,
} from '../src/kernel/prompt-stage.mjs';
import {
  extractReviewVerdict,
  normalizeReviewVerdict,
  sanitizeCodexReviewPayload,
} from '../src/kernel/verdict.mjs';
import { validateRemediationReply } from '../src/kernel/remediation-reply.mjs';
import { loadDomainConfig } from '../src/domain-config.mjs';
import { loadDomainRegistry, resolveEnabledDomainIds } from '../src/domain-registry.mjs';
import { ROUND_BUDGET_BY_RISK_CLASS } from '../src/follow-up-jobs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOMAIN_ID = 'code-pr-security';
const REPO = 'laceyenterprises/demo';
const PR_NUMBER = 42;
const HEAD_SHA_INITIAL = 'sha-initial';
const HEAD_SHA_REMEDIATED = 'sha-remediated';
const SUBJECT_EXTERNAL_ID = `${REPO}#${PR_NUMBER}`;

function readPrompt(...parts) {
  return readFileSync(join(ROOT, 'prompts', ...parts), 'utf8').trim();
}

// ── Config shape / gate ──────────────────────────────────────────────────────

test('code-pr-security domain config mirrors the code-pr shape and reuses github-pr adapters', () => {
  const codePr = JSON.parse(readFileSync(join(ROOT, 'domains', 'code-pr.json'), 'utf8'));
  const security = JSON.parse(readFileSync(join(ROOT, 'domains', 'code-pr-security.json'), 'utf8'));

  assert.deepEqual(Object.keys(security).sort(), Object.keys(codePr).sort());
  assert.equal(security.id, DOMAIN_ID);
  // Reuses the github-pr subject/comms adapters and the github-pr operator surface.
  assert.equal(security.subjectChannel, 'github-pr');
  assert.equal(security.commsChannel, 'github-pr-comments');
  assert.equal(security.reviewerRuntime, 'cli-direct');
  assert.equal(security.operatorSurface.controls, 'github-pr-label-controls');
  assert.equal(security.operatorSurface.triageSync, 'linear');
  // Carries its own security prompt set, not code-pr's.
  assert.equal(security.promptSet, DOMAIN_ID);
  assert.notEqual(security.promptSet, codePr.promptSet);
  assert.deepEqual(security.riskClasses, codePr.riskClasses);
});

test('code-pr-security round budget matches the runtime round-budget table', () => {
  const security = JSON.parse(readFileSync(join(ROOT, 'domains', 'code-pr-security.json'), 'utf8'));
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(security.riskClasses).map(([riskClass, config]) => [riskClass, config.maxRemediationRounds]),
    ),
    ROUND_BUDGET_BY_RISK_CLASS,
  );
});

test('gate-off: code-pr-security is registered but never enabled (not polled)', () => {
  const registry = loadDomainRegistry(ROOT);
  const registered = registry.domains.map((d) => d.id);
  const security = registry.domains.find((d) => d.id === DOMAIN_ID);

  // Registered (present + valid) so the config is validated at load time...
  assert.ok(registered.includes(DOMAIN_ID), 'code-pr-security must be a registered domain');
  assert.equal(security.enabled, false);
  assert.equal(security.config.enabled, false);
  // ...but excluded from the enabled set the watcher actually pumps.
  assert.ok(
    !resolveEnabledDomainIds(registry).includes(DOMAIN_ID),
    'code-pr-security must NOT appear in the enabled (polled) domain set',
  );
});

// ── Prompt-set selection ─────────────────────────────────────────────────────

test('code-pr-security resolves to its own prompt set (never falls back to code-pr)', () => {
  const domainConfig = loadDomainConfig(ROOT, DOMAIN_ID);
  const promptSet = resolvePromptSet({ rootDir: ROOT, domainConfig, domainId: DOMAIN_ID });
  assert.equal(promptSet, DOMAIN_ID);

  for (const actor of ['reviewer', 'remediator']) {
    for (const stage of ['first', 'middle', 'last']) {
      const selected = loadStagePrompt({ rootDir: ROOT, promptSet, actor, stage });
      assert.equal(
        selected,
        readPrompt(DOMAIN_ID, `${actor}.${stage}.md`),
        `${actor}.${stage} must come from the code-pr-security prompt set`,
      );
      assert.notEqual(
        selected,
        readPrompt('code-pr', `${actor}.${stage}.md`),
        `${actor}.${stage} must not fall back to the code-pr prompt set`,
      );
    }
  }
});

test('code-pr-security prompt set carries the security rubric on every stage', () => {
  const rubricTerms = /injection|authoriz|IDOR|secret|supply chain|deserializ|SSRF/i;
  for (const actor of ['reviewer', 'remediator']) {
    for (const stage of ['first', 'middle', 'last']) {
      const prompt = readPrompt(DOMAIN_ID, `${actor}.${stage}.md`);
      assert.match(prompt, rubricTerms, `${actor}.${stage} must carry the security rubric`);
    }
  }
  // The reviewer prompts keep the kernel's five-section verdict contract.
  for (const stage of ['first', 'middle', 'last']) {
    const reviewer = readPrompt(DOMAIN_ID, `reviewer.${stage}.md`);
    assert.match(reviewer, /## Blocking issues/);
    assert.match(reviewer, /Request changes/);
    assert.match(reviewer, /Comment only/);
  }
  assert.match(readPrompt(DOMAIN_ID, 'reviewer.last.md'), /Final-round verdict threshold/);
});

// ── Fixture e2e: review -> remediation -> re-review -> converge ──────────────

function makeSubjectOctokit(prByHead) {
  let head = prByHead;
  return {
    setHead(next) { head = next; },
    rest: {
      pulls: {
        async list() {
          return { data: [head()] };
        },
        async get() {
          return { data: head() };
        },
      },
    },
  };
}

function makeCommentsOctokit(calls) {
  return {
    rest: {
      issues: {
        async createComment(payload) {
          calls.push(payload);
          return { data: { id: calls.length, html_url: `https://github.test/c/${calls.length}` } };
        },
      },
    },
  };
}

function reviewBodies() {
  return [
    [
      '## Summary',
      'The new endpoint concatenates a request parameter straight into a shell command.',
      '',
      '## Blocking issues',
      '- **OS command injection in export handler**',
      '  - **File:** `src/export.js`',
      '  - **Lines:** `10-14`',
      "  - **Problem:** `exec('tar czf ' + req.query.name)` passes the untrusted `name` query parameter into a shell with no escaping; `name=x;rm -rf /` runs arbitrary commands.",
      '  - **Why it matters:** Remote code execution on the server from an unauthenticated request.',
      '  - **Recommended fix:** Use execFile with an argv array and validate `name` against an allowlist.',
      '',
      '## Non-blocking issues',
      '- None.',
      '',
      '## Suggested fixes',
      '- Switch to execFile and drop the shell.',
      '',
      '## Verdict',
      'Request changes',
    ].join('\n'),
    [
      '## Summary',
      'The export handler now shells out via execFile with an argv array and an allowlisted name.',
      '',
      '## Blocking issues',
      '- None.',
      '',
      '## Non-blocking issues',
      '- None.',
      '',
      '## Suggested fixes',
      '- None.',
      '',
      '## Verdict',
      'Comment only',
    ].join('\n'),
  ];
}

async function runCodePrSecurityFixture({ rootDir }) {
  // Domain config + staged prompts resolve from the real repo root; the temp
  // rootDir only backs adapter side effects (delivery sqlite, reviewer run-state).
  const domain = loadDomainConfig(ROOT, DOMAIN_ID);
  const promptSet = resolvePromptSet({ rootDir: ROOT, domainConfig: domain, domainId: DOMAIN_ID });
  const maxRemediationRounds = domain.riskClasses.medium.maxRemediationRounds;

  let currentHead = HEAD_SHA_INITIAL;
  let currentState = 'open';
  const prSnapshot = () => ({
    number: PR_NUMBER,
    title: '[claude-code] add PR export endpoint',
    state: currentState,
    head: { sha: currentHead },
    labels: [],
  });

  const subjectOctokit = makeSubjectOctokit(prSnapshot);
  const subject = createGitHubPRSubjectAdapter({
    octokit: subjectOctokit,
    repos: [REPO],
    rootDir,
    env: {},
    // Disable the per-snapshot cache so the fixture's head/state transitions
    // (initial -> remediated -> merged) are observed on every adapter call.
    cacheTtlMs: 0,
    // No github-adapter bin and no `gh` on PATH in the fixture: serve the diff
    // through an injected execFile so fetchContent stays fully offline.
    execFileImpl: async () => ({ stdout: 'diff --git a/src/export.js b/src/export.js\n+exec("tar czf " + req.query.name)\n' }),
    now: () => new Date('2026-07-17T00:00:00.000Z'),
  });

  const commentCalls = [];
  const comms = createGitHubPRCommentsAdapter({
    rootDir,
    octokit: makeCommentsOctokit(commentCalls),
    now: () => new Date('2026-07-17T00:00:00.000Z'),
  });

  const [reviewBody1, reviewBody2] = reviewBodies();
  const reviewer = createFixtureStubReviewerRuntimeAdapter({
    rootDir,
    reviewerBodies: [reviewBody1, reviewBody2],
  });

  // The github-pr subject adapter is reused for discovery + diff fetch. It stamps
  // its own `code-pr` domainId on the ref it returns; the code-pr-security domain
  // owns the review lifecycle, so subject identity + revision come from the reused
  // adapter while the delivery/prompt keys are stamped with THIS domain's id.
  const [discovered] = await subject.discoverSubjects();
  assert.equal(discovered.subjectExternalId, SUBJECT_EXTERNAL_ID);
  const content = await subject.fetchContent(discovered);
  assert.match(content.representation, /req\.query\.name/);

  function refForRevision(revisionRef) {
    return {
      domainId: DOMAIN_ID,
      subjectExternalId: SUBJECT_EXTERNAL_ID,
      revisionRef,
    };
  }

  // Round 1: first review -> Request changes.
  const firstStage = pickReviewerStage({
    reviewAttemptNumber: 1,
    completedRemediationRounds: 0,
    maxRemediationRounds,
  });
  assert.equal(firstStage, 'first');
  const firstPrompt = loadStagePrompt({ rootDir: ROOT, promptSet, actor: 'reviewer', stage: firstStage });
  assert.match(firstPrompt, /SECURITY review/);

  const firstReview = await reviewer.spawnReviewer({
    model: 'codex',
    prompt: firstPrompt,
    subjectContext: refForRevision(HEAD_SHA_INITIAL),
    timeoutMs: 1_000,
    sessionUuid: 'sec-fixture-review-1',
    forbiddenFallbacks: ['api-key'],
  });
  assert.equal(firstReview.ok, true);
  const firstBody = sanitizeCodexReviewPayload(firstReview.reviewBody);
  const firstVerdict = {
    kind: normalizeReviewVerdict(extractReviewVerdict(firstBody)),
    body: firstBody,
    observedAt: '2026-07-17T00:00:00.000Z',
  };
  assert.equal(firstVerdict.kind, 'request-changes');
  await comms.postReview(firstVerdict, {
    domainId: DOMAIN_ID,
    subjectExternalId: SUBJECT_EXTERNAL_ID,
    revisionRef: HEAD_SHA_INITIAL,
    round: 1,
    kind: 'review',
  });

  // Remediation round 1.
  const remediatorStage = pickRemediatorStage({ remediationRound: 1, maxRemediationRounds });
  assert.equal(remediatorStage, 'first');
  const remediatorPrompt = loadStagePrompt({ rootDir: ROOT, promptSet, actor: 'remediator', stage: remediatorStage });
  assert.match(remediatorPrompt, /remediation worker/);

  const remediationReply = validateRemediationReply({
    kind: 'adversarial-review-remediation-reply',
    schemaVersion: 1,
    jobId: 'sec-job-1',
    outcome: 'completed',
    summary: 'Replaced the shell exec with execFile and allowlisted the export name.',
    validation: ['Ran the export handler unit tests; injection payload now rejected.'],
    addressed: [{
      title: 'OS command injection in export handler',
      finding: 'Untrusted req.query.name was concatenated into a shell command.',
      action: 'Switched to execFile with an argv array and an allowlist check on name.',
      files: ['src/export.js'],
    }],
    pushback: [],
    blockers: [],
    reReview: { requested: true, reason: 'The command-injection sink has been closed.' },
  }, {
    expectedJob: { jobId: 'sec-job-1', reviewBody: firstBody },
  });
  assert.equal(remediationReply.outcome, 'completed');

  // The remediation pushes a new head; re-fetch identity from the reused adapter.
  currentHead = HEAD_SHA_REMEDIATED;
  subjectOctokit.setHead(prSnapshot);
  const remediatedState = await subject.recordRemediationCommit(discovered, {
    ref: discovered,
    commitExternalId: 'sec-edit-1',
    revisionRef: HEAD_SHA_REMEDIATED,
    summary: remediationReply.summary,
    committedAt: '2026-07-17T00:00:00.000Z',
    changedPaths: ['src/export.js'],
    validation: remediationReply.validation,
  });
  assert.equal(remediatedState.ref.revisionRef, HEAD_SHA_REMEDIATED);

  // Round 2: re-review -> Comment only (converge).
  const rereviewStage = pickReviewerStage({
    reviewAttemptNumber: 2,
    completedRemediationRounds: 1,
    maxRemediationRounds,
  });
  assert.equal(rereviewStage, 'middle');
  const rereviewPrompt = loadStagePrompt({ rootDir: ROOT, promptSet, actor: 'reviewer', stage: rereviewStage });
  assert.match(rereviewPrompt, /re-review/);

  const rereview = await reviewer.spawnReviewer({
    model: 'codex',
    prompt: rereviewPrompt,
    subjectContext: refForRevision(HEAD_SHA_REMEDIATED),
    timeoutMs: 1_000,
    sessionUuid: 'sec-fixture-review-2',
    forbiddenFallbacks: ['api-key'],
  });
  assert.equal(rereview.ok, true);
  const rereviewBody = sanitizeCodexReviewPayload(rereview.reviewBody);
  const rereviewVerdict = {
    kind: normalizeReviewVerdict(extractReviewVerdict(rereviewBody)),
    body: rereviewBody,
    observedAt: '2026-07-17T00:00:00.000Z',
  };
  assert.equal(rereviewVerdict.kind, 'comment-only');
  await comms.postReview(rereviewVerdict, {
    domainId: DOMAIN_ID,
    subjectExternalId: SUBJECT_EXTERNAL_ID,
    revisionRef: HEAD_SHA_REMEDIATED,
    round: 2,
    kind: 'review',
  });

  // The clean re-review lets the PR merge; its terminal state closes the subject.
  currentState = 'closed';
  const finalState = await subject.finalizeSubject(remediatedState.ref);

  return {
    commentCalls,
    firstVerdict,
    rereviewVerdict,
    remediatedState,
    finalState,
    comms,
  };
}

test('code-pr-security fixture converges: review (request-changes) -> remediation -> re-review (comment-only)', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'code-pr-security-e2e-'));
  const result = await runCodePrSecurityFixture({ rootDir });

  assert.equal(result.firstVerdict.kind, 'request-changes');
  assert.equal(result.rereviewVerdict.kind, 'comment-only');

  // Both verdicts were delivered through the reused github-pr-comments adapter.
  assert.equal(result.commentCalls.length, 2);
  assert.match(result.commentCalls[0].body, /Request changes/);
  assert.match(result.commentCalls[1].body, /Comment only/);
  assert.equal(result.commentCalls[0].issue_number, PR_NUMBER);

  // Deliveries are keyed under the code-pr-security domain, per revision.
  const round1 = await result.comms.loadPriorDeliveriesForSubject({
    domainId: DOMAIN_ID,
    subjectExternalId: SUBJECT_EXTERNAL_ID,
    revisionRef: HEAD_SHA_INITIAL,
    round: 1,
    kind: 'review',
  });
  assert.equal(round1.length, 1);
  assert.equal(round1[0].delivered, true);
  assert.equal(round1[0].key.domainId, DOMAIN_ID);

  const round2 = await result.comms.loadPriorDeliveriesForSubject({
    domainId: DOMAIN_ID,
    subjectExternalId: SUBJECT_EXTERNAL_ID,
    revisionRef: HEAD_SHA_REMEDIATED,
    round: 2,
    kind: 'review',
  });
  assert.equal(round2.length, 1);
  assert.equal(round2[0].delivered, true);

  // Terminal convergence on the remediated revision.
  assert.equal(result.finalState.terminal, true);
  assert.equal(result.finalState.lifecycle, 'terminal');
});
