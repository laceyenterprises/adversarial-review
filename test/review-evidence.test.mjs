import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadStagePrompt, REVIEW_EVIDENCE_GUIDANCE } from '../src/kernel/prompt-stage.mjs';
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
  for (const stage of ['first', 'middle', 'last']) {
    for (const promptSet of ['code-pr', 'code-pr-security', 'research-finding']) {
      assert.ok(!loadStagePrompt({ rootDir: ROOT, promptSet, actor: 'remediator', stage }).includes(REVIEW_EVIDENCE_GUIDANCE));
    }
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
import { openReviewStateDb, ensureReviewStateSchema, getReviewRow, requestReviewRereview } from '../src/review-state.mjs';

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

test('REVIEWEVIDENCE-01: absent or malformed head metadata preserves blockers in both grounding paths', async () => {
  const body = review(card('Empty input throws'));
  for (const requireEvidence of [false, true]) {
    for (const metadata of [
      {}, { repo: 'synthetic/project' }, { headSha: 'a'.repeat(40) },
      { repo: '', headSha: 'a'.repeat(40) }, { repo: ' ', headSha: 'a'.repeat(40) },
      ...['', ' ', 'abc123', 'g'.repeat(40), 'a'.repeat(41)].map(headSha => ({ repo: 'synthetic/project', headSha })),
    ]) {
      const options = { ...metadata, requireEvidence,
        fetchFileAtRefImpl: () => assert.fail('invalid metadata must not fetch') };
      const result = await groundBlockingFindingsAtHead(body, options);
      assert.equal(result.reviewText, body);
      assert.equal(result.grounding.skipped, 'missing-input');
      assert.deepEqual(result.grounding.demoted, []);
      const argus = { verdict: 'block', findings: [{ severity: 'high', path: 'input.mjs:1', detail: 'A concern.' }] };
      const expected = structuredClone(argus);
      await argusReview.groundArgusReviewEvidence(argus, options);
      assert.deepEqual(argus, expected);
    }
  }
});

test('REVIEWEVIDENCE-01: grounding retains raw Markdown for kept and demoted cards', async () => {
  for (const style of ['bullet', 'h3', 'mixed']) {
    const header = title => style === 'h3' || (style === 'mixed' && title === 'No behaviour') ? `### ${title}` : `- **${title}**`;
    const kept = [header('Valid'), '  - **File:** input.mjs', '  - **Lines:** 1',
      '  - **Problem:** Input or state: input is empty; Wrong outcome: the call throws.',
      '    A wrapped explanation with **formatting**.',
      '### Reproduction',
      '    ````js', '## Blocking issues', '### Synthetic heading', '- **Synthetic card**',
      '```', '    console.log(count(null));', '    ````',
      '  - **Why it matters:** Callers lose their result.',
      '    Preserve this continuation too.'].join('\n');
    const demoted = [header('No behaviour'), '  - **File:** input.mjs', '  - **Lines:** 1',
      '  - **Problem:** A concern.', '    ~~~js', '- A reproduction bullet', '    ~~~'].join('\n');
    const body = review(`${kept}\n\n${demoted}`);
    const options = { repo: 'synthetic/project', headSha: 'a'.repeat(40), requireEvidence: true,
      fetchFileAtRefImpl: async () => 'export const count = input => input?.length ?? 0;\n' };
    assert.equal((await groundBlockingFindingsAtHead(review(kept), options)).reviewText, review(kept));
    const result = await groundBlockingFindingsAtHead(body, options);
    assert.ok(result.reviewText.includes(kept), result.reviewText);
    assert.ok(result.reviewText.includes('    ~~~js\n- A reproduction bullet\n    ~~~'));
    assert.deepEqual(result.grounding.demoted.map(f => f.title), ['No behaviour']);
    assert.equal(parseReviewFindings(result.reviewText).blocking.count, 1);
    assert.match(result.reviewText, /## Verdict\nRequest changes/);
  }
});

test('REVIEWEVIDENCE-01: unstructured unsupported text is retained when demoted', async () => {
  const text = 'This change might fail.\n\nA second paragraph with reproduction context.';
  const result = await groundBlockingFindingsAtHead(review(text), { repo: 'synthetic/project',
    headSha: 'a'.repeat(40), requireEvidence: true });
  assert.equal(result.grounding.demoted.length, 1);
  assert.match(result.reviewText, /A second paragraph with reproduction context/);
  assert.match(result.reviewText, /## Verdict\nComment only/);
});

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
  assert.equal(argus.verdict, 'approve');
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
import { readReviewFindings, linkFindingRemediation } from '../src/review-finding-records.mjs';
import { resolveClosureNextAction } from '../src/ama/closure-next-action.mjs';
import { pickAdversarialGateStatus } from '../src/adversarial-gate-status.mjs';
import { recoverOrphan } from '../src/ama/orphan-watchdog.mjs';
import { pendingExplicitReviewIntent } from '../src/explicit-review-intent.mjs';
import { resolveAlreadyReviewedHeadDedup } from '../src/reviewed-head-dispatch-gate.mjs';

test('REVIEWEVIDENCE-01: factual disputes require matching complete multi-range citations', () => {
  const head = 'a'.repeat(40);
  const body = review(card('Multi-range failure', 'input.mjs', '10-15; 20-25, 30'));
  const finding = parseReviewFindings(body).blocking.findings[0];
  const evidence = { headSha: head, test: 'node --test input.test.mjs', output: 'pass' };
  for (const citation of ['input.mjs:10-15; 20-25, 30', 'input.mjs:10-15, 20-25; 30', 'input.mjs:10–15;20–25;30']) {
    const entry = { title: 'Multi-range failure', evidence: { ...evidence, citation } };
    assert.deepEqual(remediationKernel.disputeEvidenceForFinding(entry, finding, head), entry.evidence);
    assert.equal(remediationKernel.allBlockingDisputed({ revisionRef: head, reviewBody: body },
      { outcome: 'completed', pushback: [entry] }, head), true);
  }
  for (const citation of ['other.mjs:10-15;20-25;30', 'input.mjs:10-15', 'input.mjs:10-15;20-26;30',
    'input.mjs:10-15;20-25;30;', 'input.mjs:10-15;bogus;30', 'input.mjs:10-15;25-20;30',
    'input.mjs:0;20-25;30', 'input.mjs:10-15;20-25;30 trailing prose']) {
    assert.equal(remediationKernel.disputeEvidenceForFinding({ evidence: { ...evidence, citation } }, finding, head), null);
  }
});

test('REVIEWEVIDENCE-01: Argus retains real blockers and verification holds after demotion', async () => {
  const valid = { severity: 'high', path: 'input.mjs:1', detail: 'Input or state: empty input; Wrong outcome: a throw.' };
  const unsupported = { severity: 'high', path: 'input.mjs:1', detail: 'A concern.' };
  const options = { repo: 'synthetic/project', headSha: 'a'.repeat(40), fetchFileAtRefImpl: async () => 'code\n' };
  const mixed = { verdict: 'block', findings: [structuredClone(valid), structuredClone(unsupported)] };
  await argusReview.groundArgusReviewEvidence(mixed, options);
  assert.equal(mixed.verdict, 'block');
  assert.deepEqual(mixed.findings.map(f => f.severity), ['high', 'medium']);
  const hold = { verdict: 'needs_verification', findings: [structuredClone(unsupported)] };
  await argusReview.groundArgusReviewEvidence(hold, options);
  assert.equal(hold.verdict, 'needs_verification');
  const advisory = { verdict: 'block', findings: [structuredClone(unsupported)] };
  await argusReview.groundArgusReviewEvidence(advisory, options);
  assert.equal(advisory.verdict, 'approve');
  assert.equal(argusReview.composeArgusVerdict({ modelReview: advisory, rubricFindings: [valid] }).verdict, 'block');
  assert.equal(argusReview.composeArgusVerdict({ modelReview: advisory, verification: { required: true, satisfied: false } }).verdict, 'needs_verification');
});

test('grounding preserves blockers when exact-head reads fail or exceed the budget', async () => {
  for (const options of [
    { fetchFileAtRefImpl: async () => { throw new Error('rate limited'); } },
    { maxFiles: 0, fetchFileAtRefImpl: async () => assert.fail('budget exhausted') },
    { maxFiles: 1, fetchFileAtRefImpl: async () => 'code\n' },
  ]) {
    const config = { repo: 'synthetic/project', headSha: 'a'.repeat(40), requireEvidence: true, ...options };
    const body = review([card('First', 'first.mjs'), card('Second', 'second.mjs')].join('\n'));
    const result = await groundBlockingFindingsAtHead(body, config);
    assert.equal(result.reviewText, body);
    assert.deepEqual(result.grounding.demoted, []);
    const argus = { verdict: 'block', findings: ['first.mjs', 'second.mjs'].map(path => ({
      severity: 'high', path: `${path}:1`, detail: 'Input or state: empty input; Wrong outcome: a throw.',
    })) };
    await argusReview.groundArgusReviewEvidence(argus, config);
    assert.equal(argus.verdict, 'block');
    assert.deepEqual(argus.findings.map(f => f.severity), ['high', 'high']);
  }
});

test('Argus grounding preserves malformed review payloads for caller error handling', async () => {
  const options = { repo: 'synthetic/project', headSha: 'a'.repeat(40) };
  for (const review of [null, undefined, {}, { findings: null }, { findings: {} }]) {
    assert.equal(await argusReview.groundArgusReviewEvidence(review, options), review);
  }
});

test('evidence-only completion allows acknowledged advice and disambiguates duplicate titles by citation', t => {
  const head = 'a'.repeat(40);
  const body = review([card('Same title', 'first.mjs'), card('Same title', 'second.mjs')].join('\n'))
    .replace('## Non-blocking issues\n- None.', '## Non-blocking issues\n' + card('Advice', 'advice.mjs'));
  const job = { revisionRef: head, reviewBody: body };
  const pushback = ['first.mjs', 'second.mjs'].map(path => ({ title: 'Same title', finding: 'Same title',
    reasoning: 'The exact-head reproduction passes.',
    evidence: { headSha: head, citation: `${path}:1`, test: 'node --test input.test.mjs', output: 'pass' } }));
  const reply = { outcome: 'completed', addressed: [{ title: 'Advice', finding: 'Advice',
    action: 'Acknowledged the existing behaviour.', files: ['advice.mjs'] }], pushback };
  assert.equal(remediationKernel.allBlockingDisputed(job, reply, head), true);
  for (const addressed of [[{ title: 'Same title' }], [{ title: 'Unknown' }]]) {
    assert.equal(remediationKernel.allBlockingDisputed(job, { ...reply, addressed }, head), false);
  }
  for (const entries of [pushback.slice(0, 1), [pushback[0], pushback[0]], [...pushback, pushback[0]],
    pushback.map(e => ({ ...e, evidence: { ...e.evidence, citation: 'first.mjs:2' } }))]) {
    assert.equal(remediationKernel.allBlockingDisputed(job, { ...reply, pushback: entries }, head), false);
  }
  const { root } = gitFixture(t);
  const key = { repo: 'synthetic/project', prNumber: 7, attemptNumber: 1, passKind: 'first-pass' };
  beginReviewerPass(root, { ...key, reviewerClass: 'codex', headSha: head });
  updateReviewerPassBodyCapture(root, { ...key, bodyMd: body, verdict: 'request-changes' });
  const fullJob = { ...job, ...key, jobId: 'duplicate-citations', status: 'completed', completedAt: new Date().toISOString() };
  const payload = buildRemediationReply({ job: fullJob, summary: 'Both cited reproductions pass.',
    validation: ['Both exact-head checks pass.'], addressed: reply.addressed, pushback });
  assert.doesNotThrow(() => remediationKernel.validateRemediationReply(payload, { expectedJob: fullJob }));
  fullJob.remediationPlan = { currentRound: 1, rounds: [{ round: 1, state: 'completed',
    startHeadSha: head, publishedHeadSha: head, remediationReply: { payload } }] };
  const db = openReviewStateDb(root); ensureReviewStateSchema(db); t.after(() => db.close());
  linkFindingRemediation(db, { job: fullJob, attribute: () => new Map() });
  assert.deepEqual(db.prepare('SELECT reason FROM review_finding_remediations ORDER BY rowid').all().map(r => r.reason),
    ['disputed-with-evidence', 'disputed-with-evidence', 'missing-history']);
  assert.equal(readHammerWithdrawals({ rootDir: root, ...key }).length, 0);
});

test('DISPUTEDHANDOFF-01: a completed worker dispute needs independent adjudication', async t => {
  const { root, head } = gitFixture(t);
  const previousDeployCheckout = process.env.AGENT_OS_DEPLOY_CHECKOUT;
  process.env.AGENT_OS_DEPLOY_CHECKOUT = join(root, 'deploy-checkout');
  t.after(() => {
    if (previousDeployCheckout === undefined) delete process.env.AGENT_OS_DEPLOY_CHECKOUT;
    else process.env.AGENT_OS_DEPLOY_CHECKOUT = previousDeployCheckout;
  });
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
    reReviewRequested: false });
  writeFileSync(replyPath, JSON.stringify(reply));
  const spawned = markFollowUpJobSpawned({ jobPath: claimed.jobPath, worker: { model: 'codex', processId: 9001,
    state: 'spawned', workspaceDir: relative(root, workspace), outputPath: relative(root, outputPath), logPath: relative(root, join(workspace, '.adversarial-follow-up/worker.log')), replyPath } });
  let rereviews = 0;
  let completionComment;
  const result = await reconcileFollowUpJob({ rootDir: root, job: spawned.job, jobPath: spawned.jobPath,
    isWorkerRunning: () => false,
    resolvePRLifecycleImpl: async () => ({ prState: 'open', source: 'live', headSha: head }),
    requestReviewRereviewImpl: () => { rereviews++; return { triggered: true, status: 'pending' }; },
    auditWorkspaceForContaminationImpl: async () => ({ suspect: [], error: null }),
    inspectRemediationCiRegressionImpl: async () => ({ state: 'green', headSha: head }),
    postCommentImpl: async args => { completionComment = args; return { posted: true }; },
    requestWatcherWakeImpl: () => ({}), log: { warn() {}, error() {} } });
  assert.equal(result.action, 'completed', JSON.stringify({ reason: result.reason, failure: result.job?.failure }));
  assert.equal(rereviews, 0);
  assert.equal(result.job.reReview.requested, false);
  assert.deepEqual(result.job.remediationReply.payload.pushback[0].evidence, evidence);
  assert.match(completionComment.body, /disputes for independent adjudication/);
  assert.doesNotMatch(completionComment.body, /re-review queued/);
  const postedAt = new Date(Date.parse(result.job.completedAt) - 60_000).toISOString();
  const reviewState = { verdict: 'request-changes', headSha: head, blockingFindingCount: 1,
    blockingFindingState: 'known', nonBlockingFindingCount: 0, nonBlockingFindingState: 'known',
    reviewBodySha256: evidenceDigest(body), postedAt, remediationPending: false };
  const reviewRow = { review_status: 'posted', reviewer_head_sha: head, revision_ref: head,
    posted_at: postedAt, review_body: body };
  const closure = {
    input: { currentHead: head, reviewState, followUpJob: result.job, roundsLeft: true, lease: null,
      checks: 'SUCCESS' },
    subjectKey: `${key.repo}#${key.prNumber}`, observedAt: result.job.completedAt,
    candidate: { headSha: head, prState: 'OPEN', mergeable: 'MERGEABLE' },
    autonomousMergeExecutionEnabled: true,
  };
  const shared = await resolveClosureNextAction(closure);
  const identity = blockingFindingIdentitiesFromBody(body)[0];
  const legacy = { resolution: 'withdrawn-by-remediator', replyId: 'c'.repeat(64),
    identity, headSha: head, findingReviewedHead: head, reviewBodySha256: evidenceDigest(body),
    evidenceSha256: evidenceDigest(JSON.stringify(evidence)) };
  const gate = pickAdversarialGateStatus({ reviewRow, headSha: head, latestJob: result.job, hammerWithdrawals: [legacy] });
  assert.deepEqual([shared.decision.action, shared.decision.actor, gate.reason],
    ['review', 'reviewer', 'blocking-review'], JSON.stringify(shared.decision));
  assert.equal(shared.decision.deadline.anchoredAt, result.job.completedAt);
  assert.equal(shared.decision.deadline.class, 'admission');
  assert.equal(readHammerWithdrawals({ rootDir: root, ...key }).length, 0);
  assert.deepEqual(hammerWithdrawalsFromComments([], [legacy]), []);
  const state = { blockingFindingState: 'known', blockingFindingCount: 1,
    blockingFindingIdentities: [identity], reviewedHead: head, currentHead: head, reviewBodySha256: evidenceDigest(body) };
  assert.equal(resolveHammerAdjudication(state, [legacy]).allBlockingWithdrawn, false);
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
  assert.equal(dismissed.length, 0);
  const db = openReviewStateDb(root); t.after(() => db.close());
  db.prepare(`INSERT INTO ham_finding_disputes
    (repo, pr_number, identity, head_sha, finding_reviewed_head, resolution, reply_id, review_body_sha256, evidence_sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(key.repo, key.prNumber, identity, head, head,
    legacy.resolution, legacy.replyId, legacy.reviewBodySha256, legacy.evidenceSha256);
  assert.deepEqual(readHammerWithdrawals({ rootDir: root, ...key }), []);

  for (const mutate of [
    job => { job.remediationPlan.rounds[0].remediationReply.payload.pushback[0].evidence.citation = 'other.mjs:1'; },
    job => { job.remediationPlan.rounds[0].remediationReply.payload.jobId = 'different-job'; },
    job => { job.remediationPlan.rounds[0].remediationReply.payload.pushback[0].evidence = undefined; },
    job => { job.reReview.reason = 'worker-narrative'; },
    job => { job.remediationPlan.rounds[0].resultingHeadSha = 'b'.repeat(40); },
  ]) {
    const job = structuredClone(result.job);
    mutate(job);
    assert.equal((await resolveClosureNextAction({ ...closure,
      input: { ...closure.input, followUpJob: job } })).decision.action, 'remediate');
  }
  const movedHead = 'b'.repeat(40);
  const moved = await resolveClosureNextAction({ ...closure, candidate: { ...closure.candidate, headSha: movedHead },
    input: { ...closure.input, currentHead: movedHead } });
  assert.equal(moved.decision.reason, 'stale-verdict');
  assert.equal(moved.decision.head, movedHead);
  const newer = await resolveClosureNextAction({ ...closure,
    input: { ...closure.input, reviewState: { ...reviewState,
      postedAt: new Date(Date.parse(result.job.completedAt) + 1000).toISOString() } } });
  assert.equal(newer.decision.action, 'remediate');
  const capped = await resolveClosureNextAction({ ...closure, input: { ...closure.input, reviewCeilingReached: true } });
  assert.equal(capped.decision.reason, 'review-ceiling');
  assert.equal(capped.decision.actor, 'hammer');

  db.prepare(`INSERT INTO reviewed_prs
    (repo, pr_number, reviewed_at, reviewer, pr_state, review_status, reviewer_head_sha, revision_ref,
    posted_at, review_attempts, infra_auto_recover_attempts)
    VALUES (?, ?, ?, 'claude', 'open', 'posted', ?, ?, ?, 2, 1)`).run(key.repo, key.prNumber, postedAt, head, head, postedAt);
  const pages = [];
  const recovery = { rootDir: root, ...key, headSha: head, reviewStateRow: reviewRow,
    candidate: closure.candidate, result: { amaEnabled: true, recoveryWait: true, nextAction: shared.decision },
    pageImpl: async text => { pages.push(text); return { queued: true }; },
    logger: { log() {}, warn() {} }, env: { OWNERPROOF_IDLE_MINUTES: '1' } };
  const pendingWorker = createFollowUpJob({ rootDir: root, ...key, reviewerModel: 'claude',
    branch: 'synthetic-fix', revisionRef: movedHead, reviewBody: body });
  const held = await recoverOrphan({ ...recovery, now: pendingWorker.job.createdAt });
  assert.equal(held, null);
  assert.equal(getReviewRow(db, key).review_status, 'posted');
  rmSync(pendingWorker.jobPath);
  const queued = await recoverOrphan({ ...recovery, now: new Date(Date.parse(result.job.completedAt) + 60 * 60_000).toISOString() });
  assert.equal(queued?.amaClosureResult.reviewRequest?.triggered, true);
  const queuedRow = getReviewRow(db, key);
  assert.equal(queuedRow.review_status, 'pending');
  assert.equal(queuedRow.revision_ref, head);
  assert.equal(queuedRow.reviewer, 'claude');
  assert.equal(queuedRow.review_attempts, 2);
  assert.equal(queuedRow.infra_auto_recover_attempts, 1);
  const explicitReviewIntent = pendingExplicitReviewIntent(db, { ...key, headSha: head });
  assert.equal(explicitReviewIntent?.actor, 'closure-watchdog');
  const dedupInput = { repoPath: key.repo, prNumber: key.prNumber, headSha: head,
    fetchReviewsForHeadImpl: async () => [authoritative] };
  assert.equal((await resolveAlreadyReviewedHeadDedup(dedupInput)).alreadyReviewed, true);
  assert.equal((await resolveAlreadyReviewedHeadDedup({ ...dedupInput, explicitReviewIntent })).reason, 'explicit-review-intent');
  assert.equal(await recoverOrphan({ ...recovery, now: queuedRow.rereview_requested_at, reviewStateRow: queuedRow }), null);
  assert.equal(getReviewRow(db, key).rereview_requested_at, queuedRow.rereview_requested_at);
  assert.deepEqual(pages, []);
  const staleReceipt = requestReviewRereview({ rootDir: root, ...key, targetRevisionRef: head,
    expectedPostedAt: postedAt, preserveBudgets: true });
  assert.equal(staleReceipt.triggered, false);
  assert.equal(staleReceipt.reason, 'posted-review-changed');
  const expired = { ...recovery, now: new Date(Date.parse(result.job.completedAt) + 60 * 60_000).toISOString() };
  for (let tick = 0; tick < 2; tick++) {
    assert.equal((await recoverOrphan(expired)).outcome, 'recovery-exhausted');
  }
  assert.equal(pages.length, 1);
  assert.match(pages[0], /arrange independent review or adjudicate/);
  const findings = readReviewFindings(db);
  assert.equal(findings[0].status, 'unaddressed');
  assert.equal(findings[0].disputed, 1);
  assert.deepEqual(JSON.parse(findings[0].remediations[0].dispute_evidence_json), evidence);
});
