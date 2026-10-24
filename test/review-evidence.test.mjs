import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadStagePrompt } from '../src/kernel/prompt-stage.mjs';
import { buildPromptForReviewerModel } from '../src/reviewer-prompt.mjs';
import * as argusReview from '../src/argus-security-review.mjs';
const { loadArgusReviewPromptTemplate, parseArgusReviewOutput } = argusReview;

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('REVIEWEVIDENCE-01: every reviewer family and stage requires exact-head failing behaviour evidence', () => {
  const prompts = [loadArgusReviewPromptTemplate()];
  for (const stage of ['first', 'middle', 'last']) {
    for (const promptSet of ['code-pr', 'code-pr-security', 'research-finding']) {
      prompts.push(loadStagePrompt({ rootDir: ROOT, promptSet, actor: 'reviewer', stage }));
    }
    for (const [model, runtime] of [['codex', null], ['claude', null], ['gemini', 'antigravity']]) {
      prompts.push(buildPromptForReviewerModel(model, '', '', { promptStage: stage, runtime }));
    }
  }
  for (const prompt of prompts) {
    assert.match(prompt, /blocking only when.*`path:line`/);
    assert.match(prompt, /Input or state:[\s\S]*Wrong outcome:/);
    assert.match(prompt, /PR head/);
    assert.match(prompt, /record it as non-blocking/);
  }
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groundBlockingFindingsAtHead } from '../src/review-head-grounding.mjs';
import { parseReviewFindings } from '../src/kernel/review-findings.mjs';
import { beginReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { updateReviewerPassBodyCapture } from '../src/review-body-capture.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';

const card = (title, file = 'input.mjs', lines = '1', problem = 'Input or state: input is empty; Wrong outcome: the call throws instead of returning zero.') =>
  `- **${title}**\n  - **File:** \`${file}\`\n  - **Lines:** ${lines}\n  - **Problem:** ${problem}`;
const review = cards => `## Blocking issues\n${cards}\n\n## Non-blocking issues\n- None.\n\n## Verdict\nRequest changes`;
function gitFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(root, 'input.mjs'), 'export const count = input => input?.length ?? 0;\n');
  git('add', 'input.mjs');
  git('-c', 'user.name=Synthetic Builder', '-c', 'user.email=builder@example.invalid', 'commit', '-qm', 'Synthetic input');
  return { root, git, head: git('rev-parse', 'HEAD') };
}

test('REVIEWEVIDENCE-01: unresolvable citations and absent behaviour are persisted as non-blocking with reasons', async t => {
  const { root, head } = gitFixture(t);
  const body = review([card('Valid'), card('Missing file', 'absent.mjs'), card('Past head', 'input.mjs', '1-9'),
    card('No lines', 'input.mjs', ''), card('No behaviour', 'input.mjs', '1', 'This could be simpler.'), card('No file', '', '1'),
    '- **Compact unsupported claim**',
    card('Template behaviour', 'input.mjs', '1', 'Input or state: <concrete trigger>; Wrong outcome: <observed or directly demonstrated failure>')].join('\n'));
  const result = await groundBlockingFindingsAtHead(body, { repo: 'synthetic/project', headSha: head,
    checkoutDir: root, requireEvidence: true, log: { warn() {} } });
  assert.equal(parseReviewFindings(result.reviewText).blocking.count, 1);
  assert.deepEqual(result.grounding.demoted.map(f => f.reason),
    ['missing-at-head', 'lines-beyond-head', 'missing-location', 'missing-behaviour', 'missing-location', 'missing-location', 'missing-behaviour']);
  const argus = parseArgusReviewOutput('<argus-review-json>'+JSON.stringify({ verdict: 'block', findings: [
    { category: 'install_time_execution', severity: 'high', title: 'No evidence', path: 'input.mjs:1', detail: 'A concern.' },
  ] })+'</argus-review-json>');
  await argusReview.groundArgusReviewEvidence(argus, { repo: 'synthetic/project', headSha: head, checkoutDir: root });
  assert.equal(argus.findings[0].severity, 'medium');
  assert.equal(argus.findings[0].evidenceDowngradeReason, 'missing-behaviour');
  const key = { repo: 'synthetic/project', prNumber: 7, attemptNumber: 1, passKind: 'first-pass' };
  beginReviewerPass(root, { ...key, reviewerClass: 'codex', headSha: head });
  updateReviewerPassBodyCapture(root, { ...key, bodyMd: result.reviewText, verdict: 'request-changes' });
  const db = openReviewStateDb(root); ensureReviewStateSchema(db); t.after(() => db.close());
  const rows = db.prepare('SELECT blocking, finding_json FROM review_findings ORDER BY ordinal').all();
  assert.deepEqual(rows.map(r => r.blocking), [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.ok(rows.slice(1).every(r => /Evidence downgrade:/.test(JSON.parse(r.finding_json).problem)));
});

import { mkdirSync } from 'node:fs';
import { relative } from 'node:path';
import { createFollowUpJob, claimNextFollowUpJob, markFollowUpJobSpawned, buildRemediationReply } from '../src/follow-up-jobs.mjs';
import { reconcileFollowUpJob, resolveHqReplyPath } from '../src/follow-up-remediation.mjs';
import { readHammerWithdrawals, resolveHammerAdjudication, blockingFindingIdentitiesFromBody, evidenceDigest, hammerWithdrawalsFromComments } from '../src/ama/hammer-adjudication.mjs';
import * as remediationKernel from '../src/kernel/remediation-reply.mjs';
import { dismissWithdrawnReviews } from '../src/ama/withdrawn-review-dismissal.mjs';
import { amaAllAuthoritativeReviewerLogins } from '../src/ama/reviewer-authority.mjs';
import { readReviewFindings } from '../src/review-finding-records.mjs';

test('REVIEWEVIDENCE-01: an evidenced fixer dispute closes on the observed head without re-review', async t => {
  const { root, head } = gitFixture(t);
  const body = review(card('Empty input throws'));
  const key = { repo: 'synthetic/project', prNumber: 7, attemptNumber: 1, passKind: 'first-pass' };
  beginReviewerPass(root, { ...key, reviewerClass: 'codex', headSha: head });
  updateReviewerPassBodyCapture(root, { ...key, bodyMd: body, verdict: 'request-changes' });
  createFollowUpJob({ rootDir: root, ...key, reviewerModel: 'claude', branch: 'synthetic-fix', baseBranch: 'main',
    revisionRef: head, reviewBody: body });
  const claimed = claimNextFollowUpJob({ rootDir: root });
  const { replyPath, replyDir } = resolveHqReplyPath({ hqRoot: process.env.HQ_ROOT, launchRequestId: claimed.job.jobId });
  mkdirSync(replyDir, { recursive: true });
  const workspace = join(root, 'data/follow-up-jobs/workspaces', claimed.job.jobId);
  mkdirSync(join(workspace, '.adversarial-follow-up'), { recursive: true });
  const outputPath = join(workspace, '.adversarial-follow-up/worker-output.md');
  writeFileSync(outputPath, 'The empty input returns zero.');
  const code = 'export const count = input => input?.length ?? 0;';
  const evidence = { headSha: head, citation: 'input.mjs:1', code,
    reproduction: 'node --input-type=module -e "import {count} from \'./input.mjs\'; console.log(count(null))"', output: '0' };
  // Exercise the actual production interpreter, not a simulated test result.
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e',
    "import {count} from './input.mjs'; console.log(count(null))"], { cwd: root, encoding: 'utf8' }).trim(), evidence.output);
  const reply = buildRemediationReply({ job: claimed.job, summary: 'Empty input returns zero; the cited throw does not occur.',
    validation: ['The cited null-input reproduction prints zero.'],
    pushback: [{ title: 'Empty input throws', finding: 'Empty input throws', reasoning: 'The optional chain returns zero for null.', evidence }],
    reReviewRequested: true, reReviewReason: 'Ready for closure.' });
  writeFileSync(replyPath, JSON.stringify(reply));
  const spawned = markFollowUpJobSpawned({ jobPath: claimed.jobPath, worker: { model: 'codex', processId: 9001,
    state: 'spawned', workspaceDir: relative(root, workspace), outputPath: relative(root, outputPath), logPath: relative(root, join(workspace, '.adversarial-follow-up/worker.log')), replyPath } });
  let rereviews = 0;
  const result = await reconcileFollowUpJob({ rootDir: root, job: spawned.job, jobPath: spawned.jobPath,
    isWorkerRunning: () => false,
    resolvePRLifecycleImpl: async () => ({ prState: 'open', source: 'live', headSha: head }),
    requestReviewRereviewImpl: () => { rereviews++; return { triggered: true, status: 'pending' }; },
    auditWorkspaceForContaminationImpl: async () => ({ suspect: [], error: null }),
    inspectRemediationCiRegressionImpl: async () => ({ state: 'green', headSha: head }),
    postCommentImpl: async () => ({ posted: true }), requestWatcherWakeImpl: () => ({}), log: { warn() {}, error() {} } });
  assert.equal(result.action, 'completed', JSON.stringify({ reason: result.reason, failure: result.job?.failure }));
  assert.equal(rereviews, 0);
  assert.equal(result.job.reReview.requested, false);
  assert.deepEqual(result.job.remediationReply.payload.pushback[0].evidence, evidence);
  const records = readHammerWithdrawals({ rootDir: root, ...key });
  assert.equal(records.length, 1);
  assert.equal(hammerWithdrawalsFromComments([], records).length, 1);
  const state = { blockingFindingState: 'known', blockingFindingCount: 1,
    blockingFindingIdentities: blockingFindingIdentitiesFromBody(body), reviewedHead: head, currentHead: head, reviewBodySha256: evidenceDigest(body) };
  assert.equal(resolveHammerAdjudication(state, records).allBlockingWithdrawn, true);
  assert.equal(resolveHammerAdjudication({ ...state, currentHead: 'b'.repeat(40) }, records).allBlockingWithdrawn, false);
  assert.equal(resolveHammerAdjudication({ ...state, reviewBodySha256: evidenceDigest(body + ' changed') }, records).allBlockingWithdrawn, false);
  assert.equal(remediationKernel.allBlockingDisputed(claimed.job, { ...reply, pushback: reply.pushback.map(e => ({ ...e, evidence: undefined })) }, head), false);
  assert.equal(remediationKernel.allBlockingDisputed(claimed.job, reply, 'b'.repeat(40)), false);
  for (const bad of [{ ...evidence, output: '' }, { ...evidence, citation: 'other.mjs:1' }, { ...evidence, headSha: 'b'.repeat(40) }]) {
    assert.equal(remediationKernel.disputeEvidenceForFinding({ evidence: bad }, parseReviewFindings(body).blocking.findings[0], head), null);
  }
  const authoritative = { id: 7, state: 'CHANGES_REQUESTED', commit_id: head, body,
    user: { login: amaAllAuthoritativeReviewerLogins()[0] } };
  const dismissed = [];
  await dismissWithdrawnReviews({ rootDir: root, ...key, headSha: head }, {
    get: async path => path.includes('/reviews?') ? [authoritative]
      : path.endsWith('/reviews/7') ? authoritative : path.includes('/comments?') ? [] : { state: 'open', head: { sha: head } },
    dismiss: async path => dismissed.push(path),
  });
  assert.equal(dismissed.length, 1);
  const db = openReviewStateDb(root); t.after(() => db.close());
  const findings = readReviewFindings(db);
  assert.equal(findings[0].status, 'withdrawn');
  assert.deepEqual(JSON.parse(findings[0].remediations[0].dispute_evidence_json), evidence);
});
