import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createSlackThreadCommsAdapter, stableStringify } from '../src/adapters/comms/slack-thread/index.mjs';
import { createLinearTriageAdapter } from '../src/adapters/operator/linear-triage/index.mjs';
import { createMarkdownFileSubjectAdapter } from '../src/adapters/subject/markdown-file/index.mjs';
import {
  loadStagePrompt,
  pickReviewerStage,
  pickRemediatorStage,
} from '../src/kernel/prompt-stage.mjs';
import {
  extractReviewVerdict,
  normalizeReviewVerdict,
  sanitizeCodexReviewPayload,
} from '../src/kernel/verdict.mjs';
import { validateRemediationReply } from '../src/kernel/remediation-reply.mjs';
import { ROUND_BUDGET_BY_RISK_CLASS } from '../src/follow-up-jobs.mjs';
import { createReviewerRuntimeAdapterForDomain } from '../src/adapters/reviewer-runtime/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function makeFixtureRoot() {
  const rootDir = mkdtempSync(join(tmpdir(), 'research-finding-e2e-'));
  mkdirSync(join(rootDir, 'domains'), { recursive: true });
  mkdirSync(join(rootDir, 'prompts', 'research-finding'), { recursive: true });
  writeFileSync(
    join(rootDir, 'domains', 'research-finding.json'),
    readFileSync(join(ROOT, 'domains', 'research-finding.json'), 'utf8'),
    'utf8',
  );
  for (const actor of ['reviewer', 'remediator']) {
    for (const stage of ['first', 'middle', 'last']) {
      writeFileSync(
        join(rootDir, 'prompts', 'research-finding', `${actor}.${stage}.md`),
        readFileSync(join(ROOT, 'prompts', 'research-finding', `${actor}.${stage}.md`), 'utf8'),
        'utf8',
      );
    }
  }
  writeFileSync(join(rootDir, 'subject.md'), [
    '# Trial retention finding',
    '',
    'Claim: The onboarding experiment improved day-7 retention by 12 percent.',
    '',
    'Evidence: A small cohort comparison from two adjacent weeks.',
  ].join('\n'), 'utf8');
  return rootDir;
}

function loadDomainConfig(rootDir) {
  return JSON.parse(readFileSync(join(rootDir, 'domains', 'research-finding.json'), 'utf8'));
}

function makeReviewerStub() {
  const bodies = [
    [
      '## Summary',
      'The finding overstates a small cohort comparison.',
      '',
      '## Blocking issues',
      '- Title: Unsupported retention claim',
      '  File: subject.md',
      '  Lines: 3-5',
      '  Problem: The finding claims a 12 percent improvement without enough evidence.',
      '  Why it matters: The downstream decision could treat noise as causal signal.',
      '  Recommended fix: Qualify the claim and add evidence limitations.',
      '',
      '## Non-blocking issues',
      '- None.',
      '',
      '## Suggested fixes',
      '- Qualify the retention language.',
      '',
      '## Verdict',
      'Request changes',
    ].join('\n'),
    [
      '## Summary',
      'The finding now states the evidence limits clearly.',
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
  return async () => bodies.shift();
}

function deliveryExternalIdForKey(key) {
  return `comms-slack-thread:${createHash('sha256').update(stableStringify(key)).digest('hex')}`;
}

async function runResearchFindingFixtureKernel({ rootDir }) {
  const domain = loadDomainConfig(rootDir);
  const maxRemediationRounds = domain.riskClasses.medium.maxRemediationRounds;
  const subject = createMarkdownFileSubjectAdapter({
    rootDir,
    now: () => new Date('2026-05-11T19:00:00.000Z'),
  });
  const comms = createSlackThreadCommsAdapter({
    rootDir,
    now: () => new Date('2026-05-11T19:00:00.000Z'),
  });
  const operator = createLinearTriageAdapter({
    linearClientProvider: async () => null,
    logger: { log() {}, warn() {}, error() {} },
  });
  const reviewerBodies = [];
  const reviewer = makeReviewerStub();
  reviewerBodies.push(await reviewer(), await reviewer());
  const reviewerRuntime = createReviewerRuntimeAdapterForDomain({
    rootDir,
    domainId: domain.id,
    domainConfig: domain,
    reviewerBodies,
  });

  const [initialRef] = await subject.discoverSubjects();
  const initialState = await subject.fetchState(initialRef);
  const content = await subject.fetchContent(initialRef);
  assert.equal(initialState.ref.domainId, domain.id);
  assert.match(content.representation, /Trial retention finding/);

  const firstReviewerStage = pickReviewerStage({
    reviewAttemptNumber: 1,
    completedRemediationRounds: 0,
    maxRemediationRounds,
  });
  const firstReviewerPrompt = loadStagePrompt({
    rootDir,
    promptSet: domain.promptSet,
    actor: 'reviewer',
    stage: firstReviewerStage,
  });
  assert.match(firstReviewerPrompt, /research finding markdown file/);

  const firstReview = await reviewerRuntime.spawnReviewer({
    model: 'codex',
    prompt: firstReviewerPrompt,
    subjectContext: initialRef,
    timeoutMs: 1_000,
    sessionUuid: 'fixture-review-1',
    forbiddenFallbacks: ['api-key'],
  });
  assert.equal(firstReview.ok, true);
  const firstReviewBody = sanitizeCodexReviewPayload(firstReview.reviewBody);
  const firstVerdict = {
    kind: normalizeReviewVerdict(extractReviewVerdict(firstReviewBody)),
    body: firstReviewBody,
    observedAt: '2026-05-11T19:00:00.000Z',
  };
  assert.equal(firstVerdict.kind, 'request-changes');
  await comms.postReview(firstVerdict, {
    domainId: initialRef.domainId,
    subjectExternalId: initialRef.subjectExternalId,
    revisionRef: initialRef.revisionRef,
    round: 1,
    kind: 'review',
  });
  await operator.syncTriageStatus(initialRef, 'changes-requested');

  const workspace = await subject.prepareRemediationWorkspace(initialRef, 'job-research-1');
  assert.match(workspace.workspacePath, /job-research-1/);
  const remediatorStage = pickRemediatorStage({
    remediationRound: 1,
    maxRemediationRounds,
  });
  const remediatorPrompt = loadStagePrompt({
    rootDir,
    promptSet: domain.promptSet,
    actor: 'remediator',
    stage: remediatorStage,
  });
  assert.match(remediatorPrompt, /remediation worker/);

  const remediationReply = validateRemediationReply({
    kind: 'adversarial-review-remediation-reply',
    schemaVersion: 1,
    jobId: 'job-research-1',
    outcome: 'completed',
    summary: 'Qualified the retention claim and documented the evidence limit.',
    validation: ['Loaded subject.md and checked the revised claim language.'],
    addressed: [{
      title: 'Unsupported retention claim',
      finding: 'The finding claims a 12 percent improvement without enough evidence.',
      action: 'Qualified the claim as a small cohort comparison and called out the limitation.',
      files: ['subject.md'],
    }],
    pushback: [],
    blockers: [],
    reReview: {
      requested: true,
      reason: 'The blocking evidence issue has been addressed.',
    },
  }, {
    expectedJob: {
      jobId: 'job-research-1',
      reviewBody: firstReviewBody,
    },
  });
  await comms.postRemediationReply(remediationReply, {
    domainId: initialRef.domainId,
    subjectExternalId: initialRef.subjectExternalId,
    revisionRef: initialRef.revisionRef,
      round: 1,
      kind: 'remediation-reply',
  });
  const remediatedMarkdown = [
    '# Trial retention finding',
    '',
    'Claim: The onboarding experiment may have improved day-7 retention in a small cohort comparison.',
    '',
    'Evidence: A small cohort comparison from two adjacent weeks, with causal limits called out explicitly.',
  ].join('\n');
  writeFileSync(join(rootDir, 'subject.md'), remediatedMarkdown, 'utf8');
  const remediatedRevisionRef = createHash('sha256').update(remediatedMarkdown).digest('hex');
  const remediatedState = await subject.recordRemediationCommit(initialRef, {
    ref: initialRef,
    commitExternalId: 'fixture-edit-1',
    revisionRef: `sha256:${remediatedRevisionRef}`,
    summary: remediationReply.summary,
    committedAt: '2026-05-11T19:00:00.000Z',
    changedPaths: ['subject.md'],
    validation: remediationReply.validation,
  });
  await operator.syncTriageStatus(remediatedState.ref, 'awaiting-rereview');

  const rereviewStage = pickReviewerStage({
    reviewAttemptNumber: 2,
    completedRemediationRounds: remediatedState.completedRemediationRounds,
    maxRemediationRounds,
  });
  assert.equal(rereviewStage, 'middle');
  loadStagePrompt({
    rootDir,
    promptSet: domain.promptSet,
    actor: 'reviewer',
    stage: rereviewStage,
  });
  const rereview = await reviewerRuntime.spawnReviewer({
    model: 'codex',
    prompt: loadStagePrompt({
      rootDir,
      promptSet: domain.promptSet,
      actor: 'reviewer',
      stage: rereviewStage,
    }),
    subjectContext: remediatedState.ref,
    timeoutMs: 1_000,
    sessionUuid: 'fixture-review-2',
    forbiddenFallbacks: ['api-key'],
  });
  assert.equal(rereview.ok, true);
  const rereviewBody = sanitizeCodexReviewPayload(rereview.reviewBody);
  const rereviewVerdict = {
    kind: normalizeReviewVerdict(extractReviewVerdict(rereviewBody)),
    body: rereviewBody,
    observedAt: '2026-05-11T19:00:00.000Z',
  };
  assert.equal(rereviewVerdict.kind, 'comment-only');
  await comms.postReview(rereviewVerdict, {
    domainId: remediatedState.ref.domainId,
    subjectExternalId: remediatedState.ref.subjectExternalId,
    revisionRef: remediatedState.ref.revisionRef,
    round: 2,
    kind: 'review',
  });

  const finalState = await subject.finalizeSubject(remediatedState.ref);
  await operator.syncTriageStatus(finalState.ref, 'finalized');

  return {
    initialRef,
    firstVerdict,
    remediationReply,
    remediatedRef: remediatedState.ref,
    rereviewVerdict,
    finalState,
  };
}

test('research-finding fixture runs review remediation rereview terminal without kernel edits', async () => {
  const rootDir = makeFixtureRoot();
  const result = await runResearchFindingFixtureKernel({ rootDir });
  const firstReviewKey = {
    domainId: 'research-finding',
    subjectExternalId: 'subject.md',
    revisionRef: result.initialRef.revisionRef,
    round: 1,
    kind: 'review',
  };
  const remediationReplyKey = {
    domainId: 'research-finding',
    subjectExternalId: 'subject.md',
    revisionRef: result.initialRef.revisionRef,
    round: 1,
    kind: 'remediation-reply',
  };
  const rereviewKey = {
    domainId: 'research-finding',
    subjectExternalId: 'subject.md',
    revisionRef: result.remediatedRef.revisionRef,
    round: 2,
    kind: 'review',
  };

  assert.equal(result.finalState.terminal, true);
  assert.equal(result.finalState.lifecycle, 'terminal');

  const lines = readFileSync(join(rootDir, '.slack-thread-transcripts', 'subject.md', 'slack-thread.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(lines, [
    stableStringify({
      adapter: 'comms-slack-thread',
      attemptedAt: '2026-05-11T19:00:00.000Z',
      delivered: true,
      deliveredAt: '2026-05-11T19:00:00.000Z',
      deliveryExternalId: deliveryExternalIdForKey(firstReviewKey),
      key: firstReviewKey,
      payload: {
        type: 'reviewer-verdict',
        verdict: result.firstVerdict,
      },
    }),
    stableStringify({
      adapter: 'comms-slack-thread',
      attemptedAt: '2026-05-11T19:00:00.000Z',
      delivered: true,
      deliveredAt: '2026-05-11T19:00:00.000Z',
      deliveryExternalId: deliveryExternalIdForKey(remediationReplyKey),
      key: remediationReplyKey,
      payload: {
        type: 'remediation-reply',
        reply: result.remediationReply,
      },
    }),
    stableStringify({
      adapter: 'comms-slack-thread',
      attemptedAt: '2026-05-11T19:00:00.000Z',
      delivered: true,
      deliveredAt: '2026-05-11T19:00:00.000Z',
      deliveryExternalId: deliveryExternalIdForKey(rereviewKey),
      key: rereviewKey,
      payload: {
        type: 'reviewer-verdict',
        verdict: result.rereviewVerdict,
      },
    }),
  ]);
});

test('research-finding domain config mirrors code-pr domain shape', () => {
  const codePr = JSON.parse(readFileSync(join(ROOT, 'domains', 'code-pr.json'), 'utf8'));
  const researchFinding = JSON.parse(readFileSync(join(ROOT, 'domains', 'research-finding.json'), 'utf8'));

  assert.deepEqual(Object.keys(researchFinding).sort(), Object.keys(codePr).sort());
  assert.equal(researchFinding.id, 'research-finding');
  assert.equal(researchFinding.subjectChannel, 'markdown-file');
  assert.equal(researchFinding.commsChannel, 'slack-thread');
  assert.equal(researchFinding.operatorSurface.triageSync, 'linear');
  assert.deepEqual(researchFinding.riskClasses, codePr.riskClasses);
});

test('research-finding domain config round budget matches runtime round budget table', () => {
  const researchFinding = JSON.parse(readFileSync(join(ROOT, 'domains', 'research-finding.json'), 'utf8'));
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(researchFinding.riskClasses).map(([riskClass, config]) => [riskClass, config.maxRemediationRounds]),
    ),
    ROUND_BUDGET_BY_RISK_CLASS,
  );
});

test('research-finding final reviewer prompt carries the final-round threshold guidance', () => {
  const prompt = readFileSync(join(ROOT, 'prompts', 'research-finding', 'reviewer.last.md'), 'utf8');
  assert.match(prompt, /Final-round verdict threshold/);
  assert.match(prompt, /Comment only.*Non-blocking issues.*- None\./s);
});

test('research-finding prompt set loads all six staged prompts', () => {
  for (const actor of ['reviewer', 'remediator']) {
    for (const stage of ['first', 'middle', 'last']) {
      const prompt = loadStagePrompt({
        rootDir: ROOT,
        promptSet: 'research-finding',
        actor,
        stage,
      });
      assert.match(prompt, /research finding|Research finding|remediation worker/);
    }
  }
});

test('research-finding missing staged prompt fails with the prompt-stage filename', () => {
  const rootDir = makeFixtureRoot();
  rmSync(join(rootDir, 'prompts', 'research-finding', 'reviewer.middle.md'));

  assert.throws(
    () => loadStagePrompt({
      rootDir,
      promptSet: 'research-finding',
      actor: 'reviewer',
      stage: 'middle',
    }),
    /ENOENT.*reviewer\.middle\.md/,
  );
});
