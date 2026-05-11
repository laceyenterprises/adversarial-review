import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

const ROOT = process.cwd();
const NOW = '2026-05-11T19:00:00.000Z';

function marker(label) {
  console.log(`[research-finding demo] ${label}`);
}

function deliveryExternalIdForKey(key) {
  return `comms-slack-thread:${createHash('sha256').update(stableStringify(key)).digest('hex')}`;
}

function copyPromptSet(rootDir) {
  mkdirSync(join(rootDir, 'prompts', 'research-finding'), { recursive: true });
  for (const actor of ['reviewer', 'remediator']) {
    for (const stage of ['first', 'middle', 'last']) {
      const file = `${actor}.${stage}.md`;
      writeFileSync(
        join(rootDir, 'prompts', 'research-finding', file),
        readFileSync(join(ROOT, 'prompts', 'research-finding', file), 'utf8'),
        'utf8',
      );
    }
  }
}

function makeFixtureRoot() {
  const rootDir = mkdtempSync(join(tmpdir(), 'research-finding-demo-'));
  mkdirSync(join(rootDir, 'domains'), { recursive: true });
  writeFileSync(
    join(rootDir, 'domains', 'research-finding.json'),
    readFileSync(join(ROOT, 'domains', 'research-finding.json'), 'utf8'),
    'utf8',
  );
  copyPromptSet(rootDir);
  writeFileSync(join(rootDir, 'subject.md'), [
    '# Trial retention finding',
    '',
    'Claim: The onboarding experiment improved day-7 retention by 12 percent.',
    '',
    'Evidence: A small cohort comparison from two adjacent weeks.',
  ].join('\n'), 'utf8');
  return rootDir;
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

const rootDir = makeFixtureRoot();
const domain = JSON.parse(readFileSync(join(rootDir, 'domains', 'research-finding.json'), 'utf8'));
const maxRemediationRounds = domain.riskClasses.medium.maxRemediationRounds;
const subject = createMarkdownFileSubjectAdapter({
  rootDir,
  now: () => new Date(NOW),
});
const comms = createSlackThreadCommsAdapter({
  rootDir,
  now: () => new Date(NOW),
});
const operator = createLinearTriageAdapter({
  linearClientProvider: async () => null,
  logger: { log() {}, warn() {}, error() {} },
});
const reviewer = makeReviewerStub();

marker(`fixture -> created temporary domain fixture at ${rootDir}`);

const [initialRef] = await subject.discoverSubjects();
assert.ok(initialRef, 'expected markdown-file subject discovery to find subject.md');
const initialState = await subject.fetchState(initialRef);
const content = await subject.fetchContent(initialRef);
assert.equal(initialState.ref.domainId, 'research-finding');
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
marker(`reviewer -> loaded reviewer.${firstReviewerStage}.md and ran reviewer stub`);

const firstReviewBody = sanitizeCodexReviewPayload(await reviewer());
const firstVerdict = {
  kind: normalizeReviewVerdict(extractReviewVerdict(firstReviewBody)),
  body: firstReviewBody,
  observedAt: NOW,
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
marker('verdict -> parsed Request changes and delivered round 1 review to slack-thread fixture');

const workspace = await subject.prepareRemediationWorkspace(initialRef, 'job-research-demo-1');
assert.match(workspace.workspacePath, /job-research-demo-1/);
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
marker(`remediation worker -> prepared workspace and loaded remediator.${remediatorStage}.md`);

const remediationReply = validateRemediationReply({
  kind: 'adversarial-review-remediation-reply',
  schemaVersion: 1,
  jobId: 'job-research-demo-1',
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
    jobId: 'job-research-demo-1',
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
marker('reply -> validated remediation-reply JSON and delivered it to slack-thread fixture');

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
  commitExternalId: 'fixture-edit-demo-1',
  revisionRef: `sha256:${remediatedRevisionRef}`,
  summary: remediationReply.summary,
  committedAt: NOW,
  changedPaths: ['subject.md'],
  validation: remediationReply.validation,
});
await operator.syncTriageStatus(remediatedState.ref, 'awaiting-rereview');

const rereviewStage = pickReviewerStage({
  reviewAttemptNumber: 2,
  completedRemediationRounds: remediatedState.completedRemediationRounds,
  maxRemediationRounds,
});
loadStagePrompt({
  rootDir,
  promptSet: domain.promptSet,
  actor: 'reviewer',
  stage: rereviewStage,
});
const rereviewBody = sanitizeCodexReviewPayload(await reviewer());
const rereviewVerdict = {
  kind: normalizeReviewVerdict(extractReviewVerdict(rereviewBody)),
  body: rereviewBody,
  observedAt: NOW,
};
assert.equal(rereviewVerdict.kind, 'comment-only');
await comms.postReview(rereviewVerdict, {
  domainId: remediatedState.ref.domainId,
  subjectExternalId: remediatedState.ref.subjectExternalId,
  revisionRef: remediatedState.ref.revisionRef,
  round: 2,
  kind: 'review',
});
marker(`re-review -> loaded reviewer.${rereviewStage}.md, parsed Comment only, and delivered round 2 review`);

const finalState = await subject.finalizeSubject(remediatedState.ref);
await operator.syncTriageStatus(finalState.ref, 'finalized');
assert.equal(finalState.terminal, true);
assert.equal(finalState.lifecycle, 'terminal');

const transcriptPath = join(rootDir, '.slack-thread-transcripts', 'subject.md', 'slack-thread.jsonl');
const transcriptLines = readFileSync(transcriptPath, 'utf8').trim().split('\n');
const firstReviewKey = {
  domainId: initialRef.domainId,
  subjectExternalId: initialRef.subjectExternalId,
  revisionRef: initialRef.revisionRef,
  round: 1,
  kind: 'review',
};
const remediationReplyKey = {
  domainId: initialRef.domainId,
  subjectExternalId: initialRef.subjectExternalId,
  revisionRef: initialRef.revisionRef,
  round: 1,
  kind: 'remediation-reply',
};
const rereviewKey = {
  domainId: remediatedState.ref.domainId,
  subjectExternalId: remediatedState.ref.subjectExternalId,
  revisionRef: remediatedState.ref.revisionRef,
  round: 2,
  kind: 'review',
};
assert.deepEqual(transcriptLines, [
  stableStringify({
    adapter: 'comms-slack-thread',
    attemptedAt: NOW,
    delivered: true,
    deliveredAt: NOW,
    deliveryExternalId: deliveryExternalIdForKey(firstReviewKey),
    key: firstReviewKey,
    payload: {
      type: 'reviewer-verdict',
      verdict: firstVerdict,
    },
  }),
  stableStringify({
    adapter: 'comms-slack-thread',
    attemptedAt: NOW,
    delivered: true,
    deliveredAt: NOW,
    deliveryExternalId: deliveryExternalIdForKey(remediationReplyKey),
    key: remediationReplyKey,
    payload: {
      type: 'remediation-reply',
      reply: remediationReply,
    },
  }),
  stableStringify({
    adapter: 'comms-slack-thread',
    attemptedAt: NOW,
    delivered: true,
    deliveredAt: NOW,
    deliveryExternalId: deliveryExternalIdForKey(rereviewKey),
    key: rereviewKey,
    payload: {
      type: 'reviewer-verdict',
      verdict: rereviewVerdict,
    },
  }),
]);
marker(`converge -> terminal state reached with ${transcriptLines.length} byte-stable transcript deliveries`);
marker(`done -> transcript fixture: ${transcriptPath}`);
