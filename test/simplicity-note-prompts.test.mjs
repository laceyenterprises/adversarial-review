import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStagePrompt } from '../src/kernel/prompt-stage.mjs';
import { buildPromptForReviewerModel } from '../src/reviewer-prompt.mjs';
import { buildRemediationPrompt } from '../src/remediation-prompt-builder.mjs';
import { buildMergeAgentPrompt } from '../src/merge-agent-prompt.mjs';
import { buildFollowUpJob, buildRemediationReply, createFollowUpJob, validateRemediationReply } from '../src/follow-up-jobs.mjs';
import { buildMergeAgentDispatchJob } from '../src/follow-up-merge-agent.mjs';
import { buildArgusFindingsComment, loadArgusReviewPromptTemplate, parseArgusReviewOutput, shouldPostArgusComment } from '../src/argus-security-review.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NOTE = 'Reuse `src/synthetic-cache.mjs:readCached`; delete the wrapper (~45 lines saved and one subprocess avoided per item).';
const SECTION = `\n\n## Simplicity and cost (advisory)\n${NOTE}`;
const REVIEW = '## Summary\nSynthetic wrapper change.\n\n## Blocking issues\n- None.\n\n## Non-blocking issues\n- None.\n\n## Suggested fixes\n- None.\n\n## Verdict\nComment only';

function job(reviewBody) {
  return buildFollowUpJob({ repo: 'synthetic/project', prNumber: 7, branch: 'synthetic-fix',
    revisionRef: 'a'.repeat(40), reviewerModel: 'claude', reviewBody });
}

test('REVIEWSIMPLE-01: all reviewer domains, models and stages reuse one shared fragment', () => {
  const fragment = readFileSync(join(ROOT, 'prompts/shared/simplicity-and-cost.md'), 'utf8').trim();
  const prompts = [];
  for (const promptSet of ['code-pr', 'code-pr-security', 'research-finding']) {
    for (const stage of ['first', 'middle', 'last']) {
      prompts.push(loadStagePrompt({ rootDir: ROOT, promptSet, actor: 'reviewer', stage }));
      for (const [model, runtime] of [['codex', null], ['claude', null], ['gemini', 'antigravity']]) {
        prompts.push(buildPromptForReviewerModel(model, 'synthetic diff', '', { promptStage: stage, runtime }));
      }
    }
  }
  prompts.push(loadArgusReviewPromptTemplate());
  for (const prompt of prompts) {
    assert.equal(prompt.split(fragment).length - 1, 1);
    assert.match(prompt, /Runtime-cost findings/);
    assert.match(prompt, /FINDING, not simplicity advice/);
    assert.match(prompt, /subprocess or interpreter inside a\nloop or on a timer/);
    assert.match(prompt, /polling at sub-second intervals/);
    assert.match(prompt, /ledger or database write\nper poll iteration/);
    assert.match(prompt, /unbounded filesystem or process-table scan per event/);
    assert.match(prompt, /per worker, per review, per request or per\ntick/);
    assert.match(prompt, /no bound or justification; otherwise it is non-blocking/);
    assert.match(prompt, /cite file and line at the PR head/);
    assert.match(prompt, /Runtime-cost defects do not belong here/);
    assert.doesNotMatch(prompt, /Do not include any epilogue or trailing notes after the Verdict|End with "## Verdict" as the last section/);
  }
});

test('REVIEWSIMPLE-01: remediation includes optional advice only within the existing round', () => {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-simplicity-'));
  try {
    const context = { template: 'Synthetic remediation', remediationReplyPath: join(root, 'reply.json') };
    const present = buildRemediationPrompt(job(REVIEW + SECTION), context);
    const absent = buildRemediationPrompt(job(REVIEW), context);
    assert.match(present, /simplicityNoteApplied/);
    assert.match(present, /only within this round already running for other reasons/);
    assert.match(present, /without changing behavior/);
    assert.ok(present.includes(NOTE));
    assert.doesNotMatch(absent, /Simplicity and cost|simplicityNoteApplied/);
    // Historical jobs without the derived field still forward the original note.
    const legacy = job(REVIEW + SECTION);
    delete legacy.simplicityNote;
    assert.match(buildRemediationPrompt(legacy, context), /simplicityNoteApplied/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('REVIEWSIMPLE-01: applied observation survives reply parsing and cannot impose a new completion gate', () => {
  const withNote = job(REVIEW + SECTION);
  const reply = buildRemediationReply({ job: withNote, summary: 'Synthetic repair validated.' });
  assert.equal(reply.simplicityNoteApplied, false);
  for (const applied of [true, false, undefined]) {
    const parsed = validateRemediationReply({ ...reply, simplicityNoteApplied: applied }, { expectedJob: withNote });
    assert.equal(parsed.simplicityNoteApplied, applied);
    assert.equal(parsed.outcome, 'completed');
    assert.deepEqual(parsed.reReview, reply.reReview);
    assert.deepEqual(parsed.addressed, []);
  }
  assert.ok(!Object.hasOwn(buildRemediationReply({ job: job(REVIEW), summary: 'Synthetic repair validated.' }), 'simplicityNoteApplied'));
});

test('REVIEWSIMPLE-01: existing merge-agent and Hammer prompts account for advice separately', () => {
  const present = buildMergeAgentPrompt(job(REVIEW + SECTION));
  const absent = buildMergeAgentPrompt(job(REVIEW));
  assert.ok(present.includes(NOTE));
  assert.match(present, /existing closing audit text/);
  assert.match(present, /simplicityNoteApplied/);
  assert.doesNotMatch(absent, /Simplicity and cost|simplicityNoteApplied/);
  const hammer = readFileSync(join(ROOT, 'templates/hammer-prompt.md'), 'utf8');
  assert.match(hammer, /review.simplicityNote/);
  assert.match(hammer, /fetch the full review if `review.findingsTruncated` or `review.simplicityNoteTruncated`/);
  assert.match(hammer, /already-running round.*without changing behavior/);
  assert.match(hammer, /simplicityNoteApplied: true\|false.*existing `HAM_AUDIT_DETAILS_FILE`/);
});

test('REVIEWSIMPLE-01: dispatch reads the stored note only from the current reviewed head', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'synthetic-advice-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const input = job(REVIEW + SECTION);
  createFollowUpJob({ ...input, rootDir });
  const candidate = { repo: input.repo, prNumber: input.prNumber, branch: input.branch,
    baseBranch: input.baseBranch, headSha: input.revisionRef, labels: [] };
  const current = buildMergeAgentDispatchJob(rootDir, candidate);
  assert.equal(current.simplicityNote, NOTE);
  assert.ok(buildMergeAgentPrompt(current).includes(NOTE));
  const moved = buildMergeAgentDispatchJob(rootDir, { ...candidate, headSha: 'b'.repeat(40) });
  assert.equal(moved.simplicityNote, null);
  assert.ok(!buildMergeAgentPrompt(moved).includes(NOTE));
});

test('REVIEWSIMPLE-01: Argus persists and displays advice outside findings and verdict composition', () => {
  const base = '<argus-review-json>{"verdict":"approve","summary":"Synthetic dependency change.","findings":[]}</argus-review-json>\n\n## Verdict\nApprove';
  const without = parseArgusReviewOutput(base);
  const withNote = parseArgusReviewOutput(base + SECTION);
  assert.equal(withNote.simplicityNote, NOTE);
  assert.equal(without.simplicityNote, null);
  assert.deepEqual({ ...withNote, simplicityNote: null }, without);
  assert.equal(shouldPostArgusComment({ job: {}, result: withNote }), true);
  assert.equal(shouldPostArgusComment({ job: {}, result: without }), false);
  const comment = buildArgusFindingsComment({ job: { jobId: 'synthetic', headSha: 'a'.repeat(40) }, result: withNote });
  assert.match(comment, /## Simplicity and cost \(advisory\)/);
  assert.ok(comment.includes('readCached'));
});
