import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIVE_PACK_CROSS_EDIT_KIND,
  LIVE_PACK_EDIT_WAIVER_LABEL,
  applyLivePackCrossEditFindings,
  applyLivePackCrossEditReview,
  evaluateLivePackCrossEdits,
  extractPrTicketIds,
  inconclusiveFindingsForDiff,
  resolveLivePackContextForJob,
  resolveLivePackRemediationContext,
  reviewBodyHasLivePackCrossEditFinding,
  touchedPacksFromPaths,
} from '../src/live-pack-cross-edit.mjs';
import { classifyFollowUpCriticality } from '../src/follow-up-jobs.mjs';
import { normalizeEffectiveReviewVerdict } from '../src/kernel/verdict.mjs';
import { buildRemediationPrompt } from '../src/remediation-prompt-builder.mjs';
import { exactHeadReviewEventForBody } from '../src/reviewer-exact-head-post.mjs';

const REPO = 'laceyenterprises/agent-os';
const MEG_RUN = 'dagrun_01M3QXE49Z7RNR5K11ABGVD6ZG';
const TOC_RUN = 'dagrun_01M3KCA6AX5VRG1DDRZC2NH6N6';

const PLANS = {
  'projects/model-efficiency-gym/plan.json': {
    planId: 'model-efficiency-gym-v1',
    tickets: ['MEG-01', 'MEG-02', 'MEG-09'].map((id) => ({ id })),
  },
  'projects/tool-output-compression/plan.json': {
    planId: 'tool-output-compression-v1',
    tickets: ['TOC-01', 'TOC-06'].map((id) => ({ id })),
  },
  'projects/finished-pack/plan.json': {
    planId: 'finished-pack-v1',
    tickets: [{ id: 'FIN-01' }],
  },
};

function fetchPlan(repo, path, ref) {
  assert.equal(repo, REPO);
  assert.equal(ref, 'main', 'plan.json must be read at the base ref when it exists there');
  if (!PLANS[path]) {
    const err = new Error('gh: Not Found (HTTP 404)');
    err.stderr = 'HTTP 404';
    throw err;
  }
  return JSON.stringify(PLANS[path]);
}

// Stubbed ledger: only the MEG and TOC plans have non-terminal runs.
function makeLedger(runsByPlan = {
  'model-efficiency-gym-v1': [{ run_id: MEG_RUN, state: 'running' }],
  'tool-output-compression-v1': [{ run_id: TOC_RUN, state: 'running' }],
}) {
  const calls = [];
  const impl = ({ planId, states }) => {
    calls.push({ planId, states });
    return { ok: true, runs: runsByPlan[planId] || [] };
  };
  return { impl, calls };
}

function diffFor(paths) {
  return paths.map((path) => [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n')).join('\n') + '\n';
}

const CROSS_EDIT_PATHS = [
  'projects/model-efficiency-gym/SPEC.md',
  'projects/model-efficiency-gym/plan.json',
  'projects/model-efficiency-gym/prompts/meg-01.md',
  'modules/tool-output-compression/lib/compress.py',
];

const REVIEW_TEXT = [
  '## Summary',
  'Looks fine.',
  '',
  '## Blocking issues',
  '- None.',
  '',
  '## Non-blocking issues',
  '- Nit: rename a helper.',
  '',
  '## Verdict',
  'Comment only',
  '',
].join('\n');

test('touchedPacksFromPaths guards only spec, spec meta, plan and prompts', () => {
  const touched = touchedPacksFromPaths([
    'projects/a/SPEC.md',
    'projects/a/SPEC.meta.json',
    'projects/a/plan.json',
    'projects/a/prompts/x/y.md',
    'projects/a/README.md',
    'projects/b/notes.md',
    'modules/x/plan.json',
  ]);
  assert.deepEqual([...touched.keys()], ['a']);
  assert.deepEqual(touched.get('a'), [
    'projects/a/SPEC.md',
    'projects/a/SPEC.meta.json',
    'projects/a/plan.json',
    'projects/a/prompts/x/y.md',
  ]);
  assert.deepEqual([...touchedPacksFromPaths(['projects/b/notes.md'], { guardedOnly: false }).keys()], ['b']);
});

test('extractPrTicketIds reads the branch tail and the leading title ticket only', () => {
  assert.deepEqual(extractPrTicketIds({ branch: 'codex-toc-06/TOC-06', title: '[codex] TOC-06: compress tool output' }), ['TOC-06']);
  assert.deepEqual(extractPrTicketIds({ branch: 'feature/x', title: '[claude-code] (docs) SEV3 PACKCLASS-01: fix' }), ['PACKCLASS-01']);
  // A ticket merely mentioned later in the title is not the PR's own ticket.
  assert.deepEqual(extractPrTicketIds({ branch: 'feature/x', title: '[codex] cleanup after MEG-03' }), []);
});

test('own-pack edit of a live pack yields no finding', async () => {
  const ledger = makeLedger();
  const result = await evaluateLivePackCrossEdits({
    repo: REPO,
    diffText: diffFor(['projects/model-efficiency-gym/SPEC.md', 'projects/model-efficiency-gym/prompts/meg-02.md']),
    branch: 'codex-meg-02/MEG-02',
    title: '[codex] MEG-02: gym runner',
    baseRef: 'main',
    headRef: 'abc123',
    fetchFileAtRefImpl: fetchPlan,
    readActiveDagRunsImpl: ledger.impl,
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.packs[0].ownPack, true);
  assert.equal(result.packs[0].live, true);
});

test('cross-pack edit of a live pack yields a blocking live_pack_cross_edit finding', async () => {
  const ledger = makeLedger();
  const result = await evaluateLivePackCrossEdits({
    repo: REPO,
    diffText: diffFor(CROSS_EDIT_PATHS),
    branch: 'codex-toc-06/TOC-06',
    title: '[codex] TOC-06: compression evals',
    baseRef: 'main',
    headRef: 'abc123',
    labels: [{ name: 'some-other-label' }],
    fetchFileAtRefImpl: fetchPlan,
    readActiveDagRunsImpl: ledger.impl,
  });
  assert.equal(result.findings.length, 1);
  const [finding] = result.findings;
  assert.equal(finding.kind, LIVE_PACK_CROSS_EDIT_KIND);
  assert.equal(finding.blocking, true);
  assert.equal(finding.pack, 'model-efficiency-gym');
  assert.equal(finding.plan_id, 'model-efficiency-gym-v1');
  assert.deepEqual(finding.run_ids, [MEG_RUN]);
  assert.deepEqual(finding.touched_files, CROSS_EDIT_PATHS.slice(0, 3).sort());
  assert.equal(finding.inconclusive, false);
  // One bounded ledger read per touched pack, for the live states only.
  assert.deepEqual(ledger.calls.map((call) => call.planId), ['model-efficiency-gym-v1']);
  assert.ok(ledger.calls[0].states.includes('running'));
  assert.ok(ledger.calls[0].states.includes('pending'));
  assert.ok(!ledger.calls[0].states.includes('succeeded'));

  // The injected body gates: the verdict and blocking parsers see it.
  const body = applyLivePackCrossEditFindings(REVIEW_TEXT, result.findings);
  assert.equal(normalizeEffectiveReviewVerdict(body, { log: null }), 'request-changes');
  assert.equal(exactHeadReviewEventForBody(body), 'REQUEST_CHANGES');
  const classification = classifyFollowUpCriticality(body);
  assert.equal(classification.critical, true);
  assert.match(body, new RegExp(`\\[${LIVE_PACK_CROSS_EDIT_KIND}\\]`));
  assert.match(body, new RegExp(MEG_RUN));
  assert.match(body, /projects\/model-efficiency-gym\/plan\.json/);
  assert.doesNotMatch(body, /^- None\.$/m);
  assert.match(body, /- Nit: rename a helper\./);
  assert.ok(reviewBodyHasLivePackCrossEditFinding(body));
});

test('cross-pack edit of a finished pack yields no finding', async () => {
  const ledger = makeLedger();
  const result = await evaluateLivePackCrossEdits({
    repo: REPO,
    diffText: diffFor(['projects/finished-pack/SPEC.md', 'projects/finished-pack/plan.json']),
    branch: 'codex-toc-06/TOC-06',
    title: '[codex] TOC-06: compression evals',
    baseRef: 'main',
    fetchFileAtRefImpl: fetchPlan,
    readActiveDagRunsImpl: ledger.impl,
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.packs[0].live, false);
  assert.equal(result.packs[0].inconclusive, false);
});

test('a projects dir without a plan.json at either ref is not a live pack', async () => {
  const ledger = makeLedger();
  const fetchImpl = (repo, path) => {
    const err = new Error(`HTTP 404: ${path}`);
    throw err;
  };
  const result = await evaluateLivePackCrossEdits({
    repo: REPO,
    diffText: diffFor(['projects/archive-notes/SPEC.md']),
    branch: 'x/Y-1',
    baseRef: 'main',
    headRef: 'abc123',
    fetchFileAtRefImpl: fetchImpl,
    readActiveDagRunsImpl: ledger.impl,
  });
  assert.deepEqual(result.findings, []);
  assert.equal(ledger.calls.length, 0);
});

test('unreadable ledger fails closed with the inconclusive reason', async () => {
  const result = await evaluateLivePackCrossEdits({
    repo: REPO,
    diffText: diffFor(CROSS_EDIT_PATHS),
    branch: 'codex-toc-06/TOC-06',
    title: '[codex] TOC-06: compression evals',
    baseRef: 'main',
    fetchFileAtRefImpl: fetchPlan,
    readActiveDagRunsImpl: () => ({ ok: false, reason: 'ledger-read-failed', detail: 'connection refused' }),
  });
  assert.equal(result.findings.length, 1);
  const [finding] = result.findings;
  assert.equal(finding.blocking, true);
  assert.equal(finding.inconclusive, true);
  assert.match(finding.reason, /inconclusive/);
  assert.match(finding.reason, /ledger unreadable \(ledger-read-failed: connection refused\)/);
  assert.match(finding.reason, /failing closed/);
  const body = applyLivePackCrossEditFindings(REVIEW_TEXT, result.findings);
  assert.equal(normalizeEffectiveReviewVerdict(body, { log: null }), 'request-changes');
  assert.match(body, /inconclusive, so this fails closed/);

  // A throwing reader and an unreadable plan.json are inconclusive too.
  const threw = await evaluateLivePackCrossEdits({
    repo: REPO,
    diffText: diffFor(CROSS_EDIT_PATHS),
    branch: 'codex-toc-06/TOC-06',
    baseRef: 'main',
    fetchFileAtRefImpl: fetchPlan,
    readActiveDagRunsImpl: () => { throw new Error('psql timed out'); },
  });
  assert.equal(threw.findings[0].inconclusive, true);
  const badPlan = await evaluateLivePackCrossEdits({
    repo: REPO,
    diffText: diffFor(CROSS_EDIT_PATHS),
    branch: 'codex-toc-06/TOC-06',
    baseRef: 'main',
    fetchFileAtRefImpl: () => { throw new Error('HTTP 502 Bad Gateway'); },
    readActiveDagRunsImpl: makeLedger().impl,
  });
  assert.equal(badPlan.findings[0].inconclusive, true);
  assert.match(badPlan.findings[0].reason, /plan-read-failed/);
});

test('evaluation failure falls back to inconclusive findings for every guarded pack', () => {
  const findings = inconclusiveFindingsForDiff({ diffText: diffFor(CROSS_EDIT_PATHS), error: new Error('boom') });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pack, 'model-efficiency-gym');
  assert.equal(findings[0].inconclusive, true);
  assert.deepEqual(
    inconclusiveFindingsForDiff({ diffText: diffFor(CROSS_EDIT_PATHS), labels: [LIVE_PACK_EDIT_WAIVER_LABEL], error: 'boom' }),
    [],
  );
});

test('waiver label passes a live cross-pack edit and records it as waived', async () => {
  for (const labels of [[LIVE_PACK_EDIT_WAIVER_LABEL], [{ name: 'Live-Pack-Edit-Approved' }]]) {
    const result = await evaluateLivePackCrossEdits({
      repo: REPO,
      diffText: diffFor(CROSS_EDIT_PATHS),
      branch: 'codex-toc-06/TOC-06',
      baseRef: 'main',
      labels,
      fetchFileAtRefImpl: fetchPlan,
      readActiveDagRunsImpl: makeLedger().impl,
    });
    assert.deepEqual(result.findings, []);
    assert.equal(result.waived, true);
    assert.equal(result.waivedFindings[0].pack, 'model-efficiency-gym');
    assert.equal(applyLivePackCrossEditFindings(REVIEW_TEXT, result.findings), REVIEW_TEXT);
  }
});

test('applyLivePackCrossEditFindings creates missing sections and ignores fenced headings', () => {
  const finding = {
    kind: LIVE_PACK_CROSS_EDIT_KIND,
    pack: 'p',
    runs: [{ run_id: 'dagrun_x', state: 'pending' }],
    run_ids: ['dagrun_x'],
    touched_files: ['projects/p/SPEC.md'],
    inconclusive: false,
    reason: 'r',
    detail: 'd',
  };
  const body = applyLivePackCrossEditFindings('## Summary\n```md\n## Verdict\nApproved\n```\n', [finding]);
  assert.match(body, /```md\n## Verdict\nApproved\n```/);
  assert.equal(normalizeEffectiveReviewVerdict(body, { log: null }), 'request-changes');
  assert.match(body, /## Blocking issues\n\n- \*\*\[live_pack_cross_edit\]/);
});

test('remediation prompt includes the live-run facts and the stop-and-report rule', async () => {
  const fetched = [];
  const livePackContext = await resolveLivePackRemediationContext({
    repo: REPO,
    prNumber: 7392,
    baseBranch: 'main',
    branch: 'codex-toc-06/TOC-06',
    listPrFilesImpl: async () => [
      ...CROSS_EDIT_PATHS,
      'projects/tool-output-compression/SPEC.md',
      'projects/finished-pack/README.md',
    ],
    fetchFileAtRefImpl: (repo, path, ref) => {
      fetched.push(path);
      return fetchPlan(repo, path, ref);
    },
    readActiveDagRunsImpl: makeLedger().impl,
  });
  const prompt = buildRemediationPrompt({
    jobId: 'laceyenterprises__agent-os-pr-7392-2026-09-30T00-00-00-000Z',
    repo: REPO,
    prNumber: 7392,
    baseBranch: 'main',
    reviewerModel: 'claude',
    linearTicketId: null,
    reviewSummary: 'Revert the cross-pack edit.',
    reviewBody: '## Verdict\nRequest changes',
    createdAt: '2026-09-30T00:00:00.000Z',
    critical: true,
    remediationPlan: { mode: 'bounded-manual-rounds', maxRounds: 3, currentRound: 0, rounds: [] },
  }, {
    remediationReplyPath: '/tmp/hq/dispatch/remediation-replies/lrq_7392/remediation-reply.json',
    hqRoot: '/tmp/hq',
    launchRequestId: 'lrq_7392',
    livePackContext,
  });
  assert.match(prompt, /## Trusted Live Build Pack Facts/);
  assert.match(prompt, /"slug": "model-efficiency-gym"/);
  assert.match(prompt, new RegExp(`"runId": "${MEG_RUN}"`));
  assert.match(prompt, /"state": "running"/);
  assert.match(prompt, /"slug": "tool-output-compression"/);
  assert.match(prompt, new RegExp(`"runId": "${TOC_RUN}"`));
  assert.match(prompt, /"ownPack": true/);
  assert.match(prompt, /"slug": "finished-pack"[\s\S]*?"live": false/);
  assert.match(prompt, /do not edit another live pack's spec, plan or prompts; if the fix seems to need it, stop and report/i);
  assert.match(prompt, new RegExp(`Never apply the \`${LIVE_PACK_EDIT_WAIVER_LABEL}\` label yourself`));
  // The block sits in the trusted part of the prompt, before the operating rules.
  assert.ok(prompt.indexOf('## Trusted Live Build Pack Facts') < prompt.indexOf('## Required Operating Rules'));
  assert.equal(new Set(fetched).size, fetched.length, 'one plan read per pack');
});

test('remediation context is empty when no pack dir is touched and fails closed when detection fails', async () => {
  const none = await resolveLivePackRemediationContext({
    repo: REPO,
    prNumber: 1,
    baseBranch: 'main',
    listPrFilesImpl: async () => ['modules/x/y.py'],
    fetchFileAtRefImpl: () => { throw new Error('should not fetch'); },
    readActiveDagRunsImpl: () => { throw new Error('should not read'); },
  });
  assert.equal(none, '');
  const failed = await resolveLivePackRemediationContext({
    repo: REPO,
    prNumber: 1,
    baseBranch: 'main',
    listPrFilesImpl: async () => { throw new Error('gh api 502'); },
  });
  assert.match(failed, /could not determine which build packs/);
  assert.match(failed, /Treat every build pack under `projects\/` as live/);
  assert.match(failed, /stop and report/);
  const unreadable = await resolveLivePackRemediationContext({
    repo: REPO,
    prNumber: 1,
    baseBranch: 'main',
    listPrFilesImpl: async () => ['projects/model-efficiency-gym/SPEC.md'],
    fetchFileAtRefImpl: fetchPlan,
    readActiveDagRunsImpl: () => ({ ok: false, reason: 'ledger-read-failed' }),
  });
  assert.match(unreadable, /"liveCheckInconclusive": true/);
  assert.match(unreadable, /"live": true/);
});

test('applyLivePackCrossEditReview reads PR context, merges label sets, and fails closed when evaluation throws', async () => {
  const logs = [];
  const log = { error: (line) => logs.push(line) };
  const prContext = {
    title: '[codex] TOC-06: compression evals',
    headRefName: 'codex-toc-06/TOC-06',
    baseRefName: 'main',
    headRefOid: 'def456',
    labels: [{ name: 'from-pr-context' }],
  };
  let seen = null;
  const passed = await applyLivePackCrossEditReview(REVIEW_TEXT, {
    repo: REPO,
    prNumber: 7392,
    diff: diffFor(CROSS_EDIT_PATHS),
    prContext,
    labels: ['from-watcher'],
    reviewerHeadSha: 'abc123',
    log,
    evaluateImpl: async (args) => {
      seen = args;
      return { findings: [], waived: false, waivedFindings: [] };
    },
  });
  assert.equal(passed, REVIEW_TEXT);
  assert.equal(seen.branch, 'codex-toc-06/TOC-06');
  assert.equal(seen.baseRef, 'main');
  assert.equal(seen.headRef, 'abc123');
  assert.deepEqual(seen.labels.map((label) => label.name || label), ['from-watcher', 'from-pr-context']);

  const failedClosed = await applyLivePackCrossEditReview(REVIEW_TEXT, {
    repo: REPO,
    prNumber: 7392,
    diff: diffFor(CROSS_EDIT_PATHS),
    prContext,
    log,
    evaluateImpl: async () => { throw new Error('gh exploded'); },
  });
  assert.equal(normalizeEffectiveReviewVerdict(failedClosed, { log: null }), 'request-changes');
  assert.match(failedClosed, /live-pack evaluation failed: gh exploded/);
  assert.ok(logs.some((line) => /failing closed/.test(line)));
});

test('resolveLivePackContextForJob routes every gh read through the injected execFileImpl', async () => {
  const ghCalls = [];
  const execFileImpl = async (command, args) => {
    assert.equal(command, 'gh');
    ghCalls.push(args);
    const target = args.find((arg) => String(arg).startsWith('repos/'));
    if (/\/pulls\/7392\/files$/.test(target)) {
      return { stdout: JSON.stringify([{ filename: 'modules/x/y.py' }]), stderr: '' };
    }
    throw new Error(`unexpected gh call ${target}`);
  };
  const context = await resolveLivePackContextForJob({
    job: { repo: REPO, prNumber: 7392, baseBranch: 'main', branch: 'codex-toc-06/TOC-06' },
    execFileImpl,
  });
  assert.equal(context, '');
  assert.equal(ghCalls.length, 1);
  assert.ok(ghCalls[0].includes('--paginate'));
});
