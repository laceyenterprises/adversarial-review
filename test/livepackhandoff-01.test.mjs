// LIVEPACKHANDOFF-01 (LAC-2307): a valid finding whose fix needs a live build
// pack edit is never resolved by a worker's policy text. The native remediator
// hands it to the operator as a blocker; the closer gives it no credit unless an
// operator's published edit is proven at the exact live head. Fixtures restate
// the shape of two retained witnesses: a final blocking round that filed a
// valid SPEC finding as "Resolved-By-Policy" pushback, and a comment-only round
// that called two valid prompt findings "a policy deferral, not a request for
// human input". Synthetic repository, packs and identities only.
import test from 'node:test';
import assert from 'node:assert/strict';

import { allBlockingDisputed, validateRemediationReply } from '../src/kernel/remediation-reply.mjs';
import { classifyRemediationBlockers, reportsCompletedPipelineWait } from '../src/remediation-blocker-ownership.mjs';
import { normalizeCiPendingOnlyReply } from '../src/kernel/remediation-reply.mjs';
import { buildRemediationOutcomeCommentBody } from '../src/adapters/comms/github-pr-comments/pr-comments.mjs';
import { buildRemediationPrompt } from '../src/remediation-prompt-builder.mjs';
import { resolveGuardForbiddenNonBlocking } from '../src/guard-forbidden-paths.mjs';
import { applyOperatorLivePackEdits, readOperatorLivePackEditEvidence } from '../src/live-pack-operator-edit.mjs';
import { buildHamTerminalRemediationEvidenceFromGroundTruth } from '../src/ama/dispatch-closer.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { parseNonBlockingFindingsSection } from '../src/kernel/review-findings.mjs';
import { readFileSync } from 'node:fs';

const REPO = 'example/manual';
const PR = 7;
const BASE = 'b'.repeat(40);
const REVIEWED = 'c'.repeat(40);
const HEAD = 'a'.repeat(40);
const GATE = 'fixture/adversarial-gate';
const SPEC = 'projects/demo-live-pack/SPEC.md';
const PROMPT = 'projects/demo-live-pack/prompts/demo-07-prompt.md';
const POLICY = path => `Resolved-By-Policy: live-pack-plan ${path} requires an operator live edit.`;

function card(title, file, fix, problem = 'The governing pack file no longer describes the shipped behavior.') {
  return `- **${title}**\n  - **File:** \`${file}\`\n  - **Lines:** 10-14\n  - **Problem:** ${problem}\n  - **Recommended fix:** ${fix}`;
}

function review({ blocking = ['- None.'], nonBlocking = ['- None.'], verdict = 'Comment only' } = {}) {
  return `## Summary\nReview of a live pack ticket.\n## Blocking issues\n${blocking.join('\n')}\n## Non-blocking issues\n${nonBlocking.join('\n')}\n## Verdict\n${verdict}\n`;
}

const specCard = card('Timeout reports a partially changed slot as untouched', SPEC, `Update \`${SPEC}\`.`);
const codeCard = card('Targeted wait can terminate a live holder', 'src/teardown.mjs', 'Preserve live holders in `src/teardown.mjs`.');
const closeoutCard = card('Premature two-PR closeout', PROMPT, `Update \`${PROMPT}\`.`);
const readerCard = card('Missing reader publication prerequisite', PROMPT, `Edit \`${PROMPT}\`.`);
const docCard = card('Replay command missing run ID', 'projects/demo-live-pack/changes/DEMO-07.md',
  'Update `projects/demo-live-pack/changes/DEMO-07.md`.');

function reply(fields) {
  return { kind: 'adversarial-review-remediation-reply', schemaVersion: 1, jobId: 'job-1',
    summary: 'Remediated the code findings.', validation: ['node --test passed'], blockers: [],
    reReview: { requested: false, reason: null }, outcome: 'completed', ...fields };
}

const job = reviewBody => ({ jobId: 'job-1', reviewBody, revisionRef: REVIEWED });

test('final blocking round: a protected-pack pushback becomes an operator-owned blocker, not a completed round', () => {
  const body = review({ blocking: [codeCard, specCard], verdict: 'Request changes' });
  const raw = reply({
    addressed: [{ title: 'Targeted wait can terminate a live holder', finding: 'Live holder could be signalled.',
      action: 'Preserved live holders.', files: ['src/teardown.mjs'] }],
    pushback: [{ title: 'Timeout reports a partially changed slot as untouched', finding: 'Timeout message claims nothing changed.',
      reasoning: `The code defect is fixed. ${POLICY(SPEC)} The worker may not edit that live pack.` }],
  });
  const validated = validateRemediationReply(raw, { expectedJob: job(body) });
  assert.deepEqual(validated.pushback, []);
  assert.equal(validated.outcome, 'partial', 'misleading complete text cannot finish the round');
  assert.equal(validated.reReview.requested, false);
  assert.equal(validated.blockers.length, 1);
  assert.equal(validated.blockers[0].kind, 'live-pack-operator-edit');
  assert.equal(validated.blockers[0].title, 'Timeout reports a partially changed slot as untouched');
  assert.match(validated.blockers[0].needsHumanInput, /^Operator-Live-Edit-Required: live-pack-plan projects\/demo-live-pack\/SPEC\.md\. /);
  assert.match(validated.blockers[0].reasoning, /Resolved-By-Policy/, 'the worker disposition is preserved for the operator');
  // Every consumer routes it to a person, and it cannot read as a pipeline wait.
  assert.equal(classifyRemediationBlockers(validated).humanRequired, true);
  assert.equal(reportsCompletedPipelineWait({ ...validated, operationalBlockers: [{ finding: 'CI pending', kind: 'pending-ci' }] }), false);
  assert.equal(normalizeCiPendingOnlyReply({ ...validated, operationalBlockers: [{ finding: 'CI is pending', kind: 'pending-ci' }],
    summary: 'pushed commit 1234567' }, { expectedJob: job(body) }).outcome, 'partial');
  // The public comment names the operator edit instead of "won't fix".
  const comment = buildRemediationOutcomeCommentBody({ workerClass: 'codex', action: 'completed', reply: validated,
    job: { jobId: 'job-1', repo: REPO, prNumber: PR, remediationPlan: { currentRound: 2, maxRounds: 2 } } });
  assert.doesNotMatch(comment, /Pushback \(won't fix\)/);
  assert.match(comment, /## Blockers[\s\S]*Operator-Live-Edit-Required: live-pack-plan projects\/demo-live-pack\/SPEC\.md/);
});

test('comment-only round: non-blocking protected-pack deferrals keep operator ownership, other work survives', () => {
  const body = review({ nonBlocking: [docCard, closeoutCard, readerCard] });
  const raw = reply({
    nonBlocking: [{ title: 'Replay command missing run ID', finding: 'Replay command omitted the run ID.',
      action: 'Added the run-specific replay command.', files: ['projects/demo-live-pack/changes/DEMO-07.md'] }],
    pushback: [
      { title: 'Premature two-PR closeout', finding: 'The prompt stops after one PR.',
        reasoning: `${POLICY(PROMPT)} The conflict is valid, but this is a policy deferral, not a request for human input.` },
      { title: 'Missing reader publication prerequisite', finding: 'The prompt omits the installed-reader prerequisite.',
        reasoning: `${POLICY(PROMPT)} No override label, operator decision or blocker was raised.` },
    ],
  });
  const validated = validateRemediationReply(raw, { expectedJob: job(body) });
  assert.deepEqual(validated.pushback, []);
  assert.deepEqual(validated.nonBlocking.map(entry => entry.title), ['Replay command missing run ID']);
  assert.deepEqual(validated.blockers.map(entry => [entry.title, entry.kind]), [
    ['Premature two-PR closeout', 'live-pack-operator-edit'],
    ['Missing reader publication prerequisite', 'live-pack-operator-edit'],
  ]);
  assert.equal(validated.outcome, 'partial');
  assert.equal(classifyRemediationBlockers(validated).humanRequired, true);
});

test('a non-blocking deferral beside blocking findings is accounted for without breaking blocking coverage', () => {
  const body = review({ blocking: [codeCard], nonBlocking: [closeoutCard], verdict: 'Request changes' });
  const raw = reply({
    addressed: [{ title: 'Targeted wait can terminate a live holder', finding: 'Live holder could be signalled.', action: 'Fixed.' }],
    nonBlocking: [{ title: 'Premature two-PR closeout', finding: 'Stops after one PR.', action: POLICY(PROMPT) }],
    reReview: { requested: true, reason: 'Fixed the blocker.' },
  });
  const validated = validateRemediationReply(raw, { expectedJob: job(body) });
  assert.deepEqual(validated.nonBlocking, []);
  assert.deepEqual(validated.blockers.map(entry => entry.title), ['Premature two-PR closeout']);
  assert.equal(validated.reReview.requested, false, 'a human-owned blocker never re-arms review');
  // An untagged blocker with a non-blocking title is still rejected as misplaced.
  assert.throws(() => validateRemediationReply(reply({
    addressed: [{ title: 'Targeted wait can terminate a live holder', finding: 'x', action: 'Fixed.' }],
    blockers: [{ title: 'Premature two-PR closeout', finding: 'x', needsHumanInput: 'Decide later.' }],
    outcome: 'partial',
  }), { expectedJob: job(body) }), /review has 1 blocking issue\(s\), reply records 2/);
});

test('an addressed claim and an existing blocker carrying the deferral are both operator-owned', () => {
  const body = review({ blocking: [specCard, codeCard], verdict: 'Request changes' });
  const validated = validateRemediationReply(reply({
    addressed: [{ title: 'Timeout reports a partially changed slot as untouched', finding: 'x',
      action: `Left ${SPEC} unchanged because it requires an operator live edit.` }],
    blockers: [{ title: 'Targeted wait can terminate a live holder', finding: 'y',
      needsHumanInput: `Operator-Live-Edit-Required: live-pack-plan ${SPEC}` }],
    outcome: 'partial',
  }), { expectedJob: job(body) });
  assert.deepEqual(validated.addressed, []);
  assert.deepEqual(validated.blockers.map(entry => entry.kind), ['live-pack-operator-edit', 'live-pack-operator-edit']);
});

test('legitimate pushback, evidence-backed disputes and generated-path policy are unchanged', () => {
  const body = review({ blocking: [codeCard, specCard], verdict: 'Request changes' });
  const citation = 'src/teardown.mjs:10-14';
  const disputeReply = reply({ pushback: [
    { title: 'Targeted wait can terminate a live holder', finding: 'Alleged live-holder signal.',
      reasoning: 'The reproduction shows the holder survives.',
      evidence: { headSha: REVIEWED, citation, output: 'holder alive', code: 'preserveLive()', reproduction: 'run fixture' } },
    { title: 'Timeout reports a partially changed slot as untouched', finding: 'Alleged message.',
      reasoning: `${SPEC} already documents the partial detach at line 12, so the finding is factually wrong.`,
      evidence: { headSha: REVIEWED, citation: `${SPEC}:10-14`, output: 'partial detach documented', test: 'grep -n partial SPEC.md' } },
  ] });
  const validated = validateRemediationReply(disputeReply, { expectedJob: job(body) });
  assert.equal(validated.pushback.length, 2, 'a dispute that merely cites a pack path stays pushback');
  assert.equal(validated.outcome, 'completed');
  assert.equal(allBlockingDisputed(job(body), validated, REVIEWED), true);
  const scope = validateRemediationReply(reply({
    addressed: [{ title: 'Targeted wait can terminate a live holder', finding: 'x', action: 'Fixed.' }],
    pushback: [{ title: 'Timeout reports a partially changed slot as untouched', finding: 'y',
      reasoning: 'declined: CI changes are operator-only' }],
    reReview: { requested: true, reason: 'Fixed the blocker.' },
  }), { expectedJob: job(body) });
  assert.equal(scope.pushback.length, 1);
  assert.equal(scope.reReview.requested, true);
  assert.equal(scope.outcome, 'completed');
  // A negated claim disputes the finding; it is not a live-pack deferral.
  const negated = validateRemediationReply(reply({
    addressed: [{ title: 'Targeted wait can terminate a live holder', finding: 'x', action: 'Fixed.' }],
    pushback: [{ title: 'Timeout reports a partially changed slot as untouched', finding: 'y',
      reasoning: 'The message lives in src/teardown.mjs, so this does not require an operator live edit; the reviewer misread the call site.' }],
  }), { expectedJob: job(body) });
  assert.equal(negated.pushback.length, 1);
  assert.deepEqual(negated.blockers, []);
});

test('first, middle and last native rounds all carry the operator handoff rule', () => {
  for (const [currentRound, stage] of [[0, 'first'], [1, 'middle'], [2, 'last']]) {
    const prompt = buildRemediationPrompt({ jobId: 'job-1', repo: REPO, prNumber: PR, baseBranch: 'main', branch: 'topic',
      revisionRef: REVIEWED, reviewBody: review(), remediationPlan: { currentRound, maxRounds: 2 } },
    { remediationReplyPath: '/fixture/reply.json' });
    assert.match(prompt, /record it once in `blockers\[\]` with `kind: "live-pack-operator-edit"`/, stage);
    assert.match(prompt, /not a worker write grant/, stage);
    assert.match(prompt, /\*\*Live build pack exception \(LIVEPACKHANDOFF-01\)\.\*\*/, stage);
    assert.doesNotMatch(prompt, /in the corresponding `pushback\[\]\.reasoning` field; do not raise a blocker/, stage);
  }
  for (const stage of ['first', 'middle', 'last']) {
    const body = readFileSync(new URL(`../prompts/code-pr/remediator.${stage}.md`, import.meta.url), 'utf8');
    assert.match(body, /Operator-Live-Edit-Required: live-pack-plan <path>/, stage);
  }
});

// ---- Closer: coverage credit and exact-head operator evidence ----

function auditClose(body, auditDetails, { blocking = 0 } = {}) {
  const findings = parseNonBlockingFindingsSection(body);
  const file = { filename: 'src/feature.mjs', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+feature' };
  const commit = { sha: HEAD, parentSha: BASE, changedFiles: [file.filename],
    primaryChange: { headSha: HEAD, ciCost: { headSha: HEAD, ok: true }, hasHammerCommits: false,
      primaryHead: HEAD, mergeBase: BASE, primaryFiles: [file], finalFiles: [file] } };
  const auditComment = { author: 'hammer-worker', body: ['<!-- hq:ham-terminal-remediation:audit -->', '**Findings addressed**',
    auditDetails, 'Doc-currency: not applicable.', `HAM-Base-Head: ${HEAD}`, `HAM-Validated-Head: ${HEAD}`].join('\n') };
  const evidence = buildHamTerminalRemediationEvidenceFromGroundTruth({ reviewedHead: HEAD, verifiedCommit: commit, verifiedAuditComment: auditComment });
  const result = isEligibleForAmaClosure({ verdict: 'comment-only', headSha: HEAD, riskClass: 'low', remediationPending: false,
    blockingFindingState: 'known', blockingFindingCount: blocking, nonBlockingFindingState: 'known',
    nonBlockingFindingCount: findings.length, nonBlockingFindingIdentities: findings.map(finding => finding.title) },
  { prNumber: 1, headSha: HEAD, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE', labels: [],
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'required-guards', conclusion: 'SUCCESS' }],
    branchProtection: { requiredContexts: [GATE] } },
  { enabled: true, strictNonBlockingRemediation: true, eligibility: { riskClasses: ['low'] } },
  { env: { ADV_GATE_STATUS_CONTEXT: GATE }, hamTerminalRemediation: evidence,
    hamTerminalRemediationGroundTruth: { commit, auditComment,
      range: { verified: true, reviewedHead: HEAD, currentHead: HEAD, baseSha: HEAD, commits: [] } } });
  return { evidence, result };
}

const protects = path => path.startsWith('projects/demo-live-pack/') && !path.includes('/changes/');

test('closer prose that calls a live-pack finding resolved by policy earns no closure credit', () => {
  const body = review({ nonBlocking: [closeoutCard] });
  const policy = resolveGuardForbiddenNonBlocking(body, [], { livePackProtects: protects });
  assert.deepEqual(policy.resolved, []);
  assert.equal(policy.operatorOwned.length, 1);
  // A hammer that copies the legacy policy bullet anyway cannot satisfy the predicate.
  const legacy = [`- **Premature two-PR closeout** (non-blocking) — resolved by policy; ${PROMPT} belongs to a live build pack and requires an operator live edit.`,
    `Resolved-By-Policy: live-pack-plan ${PROMPT} requires an operator live edit`].join('\n');
  const { evidence, result } = auditClose(body, legacy);
  assert.equal(evidence.auditComment.findings, null, 'the deferral bullet is not an addressed finding');
  assert.equal(result.eligible, false);
  // A generated-path policy bullet keeps its REVIEWGUARD-01 credit.
  const generated = card('Catalog row is stale', 'docs/CATALOG.md', 'Commit the regenerated `docs/CATALOG.md`.');
  const kept = auditClose(review({ nonBlocking: [generated] }),
    '- **Catalog row is stale** (non-blocking) — resolved by policy; docs/CATALOG.md is regenerated by automation.');
  assert.deepEqual(kept.evidence.auditComment.findings.map(finding => finding.title), ['Catalog row is stale']);
});

function fakeGitHub({ labels = ['live-pack-edit-approved'], timeline, compare, history, headAfter = HEAD, labelsAfter = labels } = {}) {
  const calls = [];
  let prReads = 0;
  const get = async path => {
    calls.push(path);
    if (path === `repos/${REPO}/pulls/${PR}`) {
      prReads += 1;
      const after = prReads > 1;
      return { state: 'open', head: { sha: after ? headAfter : HEAD }, labels: (after ? labelsAfter : labels).map(name => ({ name })) };
    }
    if (path.startsWith(`repos/${REPO}/issues/${PR}/timeline?`)) return timeline ?? [
      { event: 'labeled', label: { name: 'live-pack-edit-approved' }, actor: { login: 'Operator-One', type: 'User' } }];
    if (path === `repos/${REPO}/compare/${REVIEWED}...${HEAD}`) return compare ?? {
      status: 'ahead', total_commits: 2, commits: [{ sha: 'd'.repeat(40) }, { sha: 'e'.repeat(40) }],
      files: [{ filename: PROMPT }, { filename: 'src/feature.mjs' }] };
    if (path === `repos/${REPO}/commits?sha=${HEAD}&path=${encodeURIComponent(PROMPT)}&per_page=100`) return history ?? [
      { sha: 'e'.repeat(40), commit: { message: 'Finish the approved prompt amendment' } },
      // The author's pre-review builder commit carries worker provenance but is outside the range.
      { sha: 'f'.repeat(40), commit: { message: 'DEMO-07: amend prompt\n\nWorker-Class: claude-code' } }];
    throw new Error(`unexpected fixture call ${path}`);
  };
  return { get, calls };
}

const read = (gh, overrides = {}) => readOperatorLivePackEditEvidence({ repo: REPO, prNumber: PR, reviewedSha: REVIEWED,
  paths: [PROMPT], operatorLogins: ['operator-one'], get: gh.get, ...overrides });

test('an authorized operator edit published at the exact live head closes the finding', async () => {
  const body = review({ nonBlocking: [closeoutCard] });
  const gh = fakeGitHub();
  const evidence = await read(gh);
  assert.equal(evidence.ok, true, JSON.stringify(evidence));
  assert.deepEqual(evidence.paths, { [PROMPT]: { commits: ['e'.repeat(40)] } });
  assert.equal(evidence.approval.actor, 'operator-one');
  assert.ok(gh.calls.filter(call => call === `repos/${REPO}/pulls/${PR}`).length === 2, 'head and labels re-read after the evidence');
  const policy = applyOperatorLivePackEdits(resolveGuardForbiddenNonBlocking(body, [], { livePackProtects: protects }), evidence);
  assert.deepEqual(policy.operatorOwned, []);
  assert.equal(policy.operatorHandoff, '');
  assert.deepEqual(policy.resolved.map(finding => [finding.title, finding.operatorEdit.headSha, finding.operatorEdit.reviewedSha]),
    [['Premature two-PR closeout', HEAD, REVIEWED]]);
  assert.match(policy.auditDetails, new RegExp(`^- \\*\\*Premature two-PR closeout\\*\\* \\(non-blocking\\) — verified operator edit of ${PROMPT.replaceAll('.', '\\.')} at exact head ${HEAD}`, 'm'));
  assert.match(policy.auditDetails, new RegExp(`^Operator-Edit-Verified: live-pack-plan ${PROMPT.replaceAll('.', '\\.')} at ${HEAD}$`, 'm'));
  const { result } = auditClose(body, policy.auditDetails);
  assert.equal(result.eligible, true, JSON.stringify(result.reasons));
});

test('label, authorship, ancestry, change and head evidence each fail closed', async () => {
  const worker = [{ sha: 'e'.repeat(40), commit: { message: 'docs: update prompt\n\nWorker-Class: codex-remediation\nWorker-Job-Id: job-1' } }];
  const cases = [
    ['no operator approval label', { labels: [] }, 'operator-approval-label-absent'],
    ['label applied by a non-operator', { timeline: [{ event: 'labeled', label: { name: 'live-pack-edit-approved' }, actor: { login: 'lacey-merge-agent[bot]', type: 'Bot' } }] }, 'operator-approval-label-unproven'],
    ['label removed after approval', { timeline: [
      { event: 'labeled', label: { name: 'live-pack-edit-approved' }, actor: { login: 'operator-one', type: 'User' } },
      { event: 'unlabeled', label: { name: 'live-pack-edit-approved' }, actor: { login: 'operator-one', type: 'User' } }] }, 'operator-approval-label-unproven'],
    ['reviewed head is not an ancestor', { compare: { status: 'diverged', total_commits: 1, commits: [{ sha: 'e'.repeat(40) }], files: [{ filename: PROMPT }] } }, 'head-not-descendant-of-reviewed-head'],
    ['truncated compare', { compare: { status: 'ahead', total_commits: 400, commits: [{ sha: 'e'.repeat(40) }], files: [{ filename: PROMPT }] } }, 'compare-truncated'],
    ['head moved during the read', { headAfter: 'd'.repeat(40) }, 'pr-changed-during-read'],
    ['labels changed during the read', { labelsAfter: [] }, 'pr-changed-during-read'],
  ];
  for (const [name, options, reason] of cases) {
    assert.deepEqual(await read(fakeGitHub(options)), { ok: false, reason }, name);
  }
  // Path-level refusals: a worker-authored edit under the label is the
  // label-to-write shortcut, and an unchanged path proves nothing.
  const laundered = await read(fakeGitHub({ history: worker }));
  assert.equal(laundered.ok, true);
  assert.deepEqual(laundered.paths, {});
  assert.deepEqual(laundered.refused, { [PROMPT]: 'worker-authored-protected-edit' });
  const unchanged = await read(fakeGitHub({ compare: { status: 'ahead', total_commits: 1, commits: [{ sha: 'e'.repeat(40) }], files: [{ filename: 'src/feature.mjs' }] } }));
  assert.deepEqual(unchanged.refused, { [PROMPT]: 'protected-path-unchanged' });
  const body = review({ nonBlocking: [closeoutCard] });
  for (const evidence of [laundered, unchanged]) {
    const policy = applyOperatorLivePackEdits(resolveGuardForbiddenNonBlocking(body, [], { livePackProtects: protects }), evidence);
    assert.deepEqual(policy.resolved, []);
    assert.equal(policy.operatorOwned.length, 1);
  }
  // Input-level refusals need no GitHub read at all.
  const untouched = fakeGitHub();
  assert.deepEqual(await read(untouched, { reviewedSha: '' }), { ok: false, reason: 'reviewed-head-unknown' });
  assert.deepEqual(await read(untouched, { operatorLogins: [] }), { ok: false, reason: 'operator-logins-unconfigured' });
  assert.deepEqual(untouched.calls, []);
  assert.deepEqual(await read(fakeGitHub(), { reviewedSha: HEAD }), { ok: false, reason: 'head-not-moved-since-review' });
  const broken = await read({ get: async () => { throw new Error('HTTP 502'); } });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /^evidence-read-failed: HTTP 502/);
});

test('a blocking operator-owned finding stays required even in non-strict mode; a non-blocking one is advisory', () => {
  const body = review({ blocking: [specCard], nonBlocking: [closeoutCard], verdict: 'Request changes' });
  const policy = resolveGuardForbiddenNonBlocking(body, [], { livePackProtects: protects, strictNonBlockingRemediation: false });
  assert.deepEqual(policy.operatorOwned.map(finding => [finding.title, finding.blocking, finding.required]), [
    ['Premature two-PR closeout', false, false],
    ['Timeout reports a partially changed slot as untouched', true, true],
  ]);
  assert.deepEqual(policy.operatorHandoff.split('\n'), [
    `Operator-Live-Edit-Required: live-pack-plan ${PROMPT}`, `Operator-Live-Edit-Required: live-pack-plan ${SPEC}`]);
});
