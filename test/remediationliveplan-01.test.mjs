// REMEDIATIONLIVEPLAN-01: remediators resolve findings that would edit a live
// build pack's plan, spec or prompts by policy, the PR's own pack included,
// instead of editing them. Liveness comes from the live-pack review gate's
// evaluation (base plan + dispatch read surface); a failed read protects every
// guarded pack path. Synthetic repository, packs and runs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  livePackOnlyRemedy,
  LIVE_PACK_POLICY_INSTRUCTIONS,
  resolveGuardForbiddenNonBlocking,
} from '../src/guard-forbidden-paths.mjs';
import {
  guardedPackPathsInText,
  livePackPolicyProtects,
  loadLivePackPolicy,
  resolveLivePackRemediationContext,
} from '../src/live-pack-cross-edit.mjs';
import { buildRemediationPrompt } from '../src/remediation-prompt-builder.mjs';
import { composeCloserPrompt } from '../src/ama/dispatch-closer.mjs';
import { parseNonBlockingFindingsSection } from '../src/kernel/review-findings.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { buildHamTerminalRemediationEvidenceFromGroundTruth } from '../src/ama/dispatch-closer.mjs';

const REPO = 'example/manual';
const BASE = 'b'.repeat(40);
const HEAD = 'a'.repeat(40);
const GATE = 'fixture/adversarial-gate';
const LIVE_RUN = 'dagrun_fixture_live_0001';
const PLANS = {
  'projects/demo-live-pack/plan.json': { planId: 'demo-live-pack-v1', tickets: [{ id: 'DEMO-15' }, { id: 'DEMO-16' }] },
  'projects/demo-idle-pack/plan.json': { planId: 'demo-idle-pack-v1', tickets: [{ id: 'IDLE-01' }] },
};

function fetchPlan(repo, path, ref) {
  assert.equal(repo, REPO);
  if (ref !== BASE || !PLANS[path]) {
    const err = new Error('gh: Not Found (HTTP 404)');
    err.stderr = 'HTTP 404';
    throw err;
  }
  return JSON.stringify(PLANS[path]);
}

function ledger({ planId }) {
  return { ok: true, runs: planId === 'demo-live-pack-v1' ? [{ run_id: LIVE_RUN, state: 'running' }] : [] };
}

const policyImpls = { fetchFileAtRefImpl: fetchPlan, readActiveDagRunsImpl: ledger, sleepImpl: async () => {} };

function card(title, file, fix) {
  return `- **${title}**\n  - **File:** \`${file}\`\n  - **Lines:** 10-14\n  - **Problem:** The activation assertion no longer matches the shipped surface.\n  - **Recommended fix:** ${fix}`;
}

const liveCard = card('Activation assertion drifted', 'projects/demo-live-pack/plan.json',
  'Update `expected_jq` and `surface` of the activation assertion in `projects/demo-live-pack/plan.json`.');
const idleCard = card('Idle pack assertion drifted', 'projects/demo-idle-pack/plan.json',
  'Update `expected_jq` in `projects/demo-idle-pack/plan.json`.');

function review({ blocking = ['- None.'], nonBlocking = ['- None.'], verdict = 'Comment only' } = {}) {
  return `## Summary\nFeature change for a live pack ticket.\n## Blocking issues\n${blocking.join('\n')}\n## Non-blocking issues\n${nonBlocking.join('\n')}\n## Verdict\n${verdict}\n`;
}

async function policyFor(reviewText, overrides = {}) {
  const livePack = await loadLivePackPolicy({ repo: REPO, baseRef: BASE, headRef: HEAD,
    paths: guardedPackPathsInText(reviewText), ...policyImpls, ...overrides });
  return { livePack, protects: path => livePackPolicyProtects(livePack, path) };
}

function close(body, policy) {
  const findings = parseNonBlockingFindingsSection(body);
  const file = { filename: 'src/feature.mjs', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+feature' };
  const commit = { sha: HEAD, parentSha: BASE, changedFiles: [file.filename],
    primaryChange: { headSha: HEAD, ciCost: { headSha: HEAD, ok: true }, hasHammerCommits: false,
      primaryHead: HEAD, mergeBase: BASE, primaryFiles: [file], finalFiles: [file] } };
  const auditComment = { author: 'hammer-worker', body: [
    '<!-- hq:ham-terminal-remediation:audit -->', '**Findings addressed**', policy.auditDetails,
    'Doc-currency: not applicable.', `HAM-Base-Head: ${HEAD}`, `HAM-Validated-Head: ${HEAD}`,
  ].join('\n') };
  const evidence = buildHamTerminalRemediationEvidenceFromGroundTruth({ reviewedHead: HEAD, verifiedCommit: commit, verifiedAuditComment: auditComment });
  return isEligibleForAmaClosure({ verdict: 'comment-only', headSha: HEAD, riskClass: 'low',
    remediationPending: false, blockingFindingState: 'known', blockingFindingCount: 0,
    nonBlockingFindingState: 'known', nonBlockingFindingCount: findings.length,
    nonBlockingFindingIdentities: findings.map(finding => finding.title) },
  { prNumber: 1, headSha: HEAD, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE', labels: [],
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'required-guards', conclusion: 'SUCCESS' }],
    branchProtection: { requiredContexts: [GATE] } },
  { enabled: true, strictNonBlockingRemediation: true, eligibility: { riskClasses: ['low'] } },
  { env: { ADV_GATE_STATUS_CONTEXT: GATE }, hamTerminalRemediation: evidence,
    hamTerminalRemediationGroundTruth: { commit, auditComment,
      range: { verified: true, reviewedHead: HEAD, currentHead: HEAD, baseSha: HEAD, commits: [] } } });
}

test('a finding touching a live plan assertion is resolved by policy with no edit, own pack included', async () => {
  const body = review({ nonBlocking: [liveCard] });
  const { livePack, protects } = await policyFor(body);
  assert.deepEqual(livePack, { failClosed: false, packs: [{ slug: 'demo-live-pack', planId: 'demo-live-pack-v1',
    live: true, inconclusive: false, runIds: [LIVE_RUN] }] });
  // DEMO-15 is one of the live pack's own tickets: own-pack status grants no edit right.
  const policy = resolveGuardForbiddenNonBlocking(body, [], { livePackProtects: protects });
  assert.equal(policy.resolved.length, 1);
  assert.deepEqual(policy.resolved[0].livePackPaths, ['projects/demo-live-pack/plan.json']);
  assert.deepEqual(policy.remaining, []);
  assert.ok(policy.auditDetails.split('\n').includes(
    'Resolved-By-Policy: live-pack-plan projects/demo-live-pack/plan.json requires an operator live edit'));
  assert.match(policy.instructions, /do not edit the file, do not raise an operator decision/);
  assert.match(policy.instructions, /including this PR's own pack and a PR that is itself an approved live edit/);
  // Strict accounting: the policy audit covers the finding, and the HAM commit edits no pack file.
  const result = close(body, policy);
  assert.equal(result.eligible, true, JSON.stringify(result.reasons));
});

test('a blocking live-plan finding is resolved by policy and leaves no remaining blocker', async () => {
  const body = review({ blocking: [liveCard], verdict: 'Request changes' });
  const policy = resolveGuardForbiddenNonBlocking(body, [], { livePackProtects: (await policyFor(body)).protects });
  assert.equal(policy.resolved.length, 1);
  assert.equal(policy.resolved[0].blocking, true);
  assert.equal(policy.blocking.length, 1, 'the raw blocking list is unchanged');
  assert.deepEqual(policy.remainingBlocking, []);
  assert.match(policy.auditDetails, /\*\*Activation assertion drifted\*\* \(blocking\) — resolved by policy/);
});

test('a finding in a non-live pack plan is remediated normally', async () => {
  const body = review({ nonBlocking: [liveCard, idleCard] });
  const { livePack, protects } = await policyFor(body);
  assert.equal(livePack.packs.find(pack => pack.slug === 'demo-idle-pack').live, false);
  assert.equal(protects('projects/demo-idle-pack/plan.json'), false);
  const policy = resolveGuardForbiddenNonBlocking(body, [], { livePackProtects: protects });
  assert.deepEqual(policy.resolved.map(finding => finding.title), ['Activation assertion drifted']);
  assert.deepEqual(policy.remaining.map(finding => finding.title), ['Idle pack assertion drifted']);
  assert.equal(close(body, policy).eligible, false, 'the idle-pack finding still needs remediation');
});

test('a live-pack lookup failure protects every plan, spec, spec-meta and prompt path', async () => {
  const paths = ['projects/demo-idle-pack/plan.json', 'projects/any-pack/SPEC.md',
    'projects/any-pack/SPEC.meta.json', 'projects/any-pack/prompts/step-01.md'];
  const failures = [
    await loadLivePackPolicy({ repo: REPO, baseRef: '', paths, ...policyImpls }),
    await loadLivePackPolicy({ repo: REPO, baseRef: BASE, paths, ...policyImpls,
      resolvePackLivenessImpl: async () => { throw new Error('dispatch read unavailable'); } }),
    null,
  ];
  assert.equal(failures[0].failClosed, true);
  assert.equal(failures[1].failClosed, true);
  for (const policy of failures) {
    for (const path of paths) assert.equal(livePackPolicyProtects(policy, path), true, `${path} must be protected`);
    assert.equal(livePackPolicyProtects(policy, 'projects/any-pack/README.md'), false);
    assert.equal(livePackPolicyProtects(policy, 'src/feature.mjs'), false);
  }
  // An unreadable ledger is inconclusive and therefore live, even for a pack with no runs.
  const inconclusive = await loadLivePackPolicy({ repo: REPO, baseRef: BASE, paths, ...policyImpls,
    readActiveDagRunsImpl: () => ({ ok: false, reason: 'ledger-read-failed' }) });
  assert.equal(livePackPolicyProtects(inconclusive, 'projects/demo-idle-pack/plan.json'), true);
  // A pack the policy did not read is protected.
  assert.equal(livePackPolicyProtects({ failClosed: false, packs: [] }, 'projects/unread/plan.json'), true);
  const body = review({ nonBlocking: [idleCard] });
  const policy = resolveGuardForbiddenNonBlocking(body, [], { livePackProtects: path => livePackPolicyProtects(failures[0], path) });
  assert.deepEqual(policy.resolved.map(finding => finding.title), ['Idle pack assertion drifted']);
});

test('mixed remedies, the operator-gated cross-edit finding and missing policy grant no resolution', async () => {
  const { protects } = await policyFor(review({ nonBlocking: [liveCard] }));
  const mixed = card('Assertion and code drifted', 'projects/demo-live-pack/plan.json',
    'Update `projects/demo-live-pack/plan.json` and fix `src/feature.mjs`.');
  assert.equal(livePackOnlyRemedy(parseNonBlockingFindingsSection(review({ nonBlocking: [mixed] }))[0], protects), null);
  const bareOther = card('Assertion drifted', 'projects/demo-live-pack/plan.json', 'Update the assertion and README.md.');
  assert.equal(livePackOnlyRemedy(parseNonBlockingFindingsSection(review({ nonBlocking: [bareOther] }))[0], protects), null);
  const crossEdit = '- **[live_pack_cross_edit] Cross-pack edit of live build pack `demo-live-pack`** — touched: `projects/demo-live-pack/plan.json`. Leave the change in place.';
  const gated = resolveGuardForbiddenNonBlocking(review({ blocking: [crossEdit], verdict: 'Request changes' }), [], { livePackProtects: protects });
  assert.equal(gated.resolved.length, 0);
  assert.equal(gated.remainingBlocking.length, 1);
  assert.equal(resolveGuardForbiddenNonBlocking(review({ nonBlocking: [liveCard] }), []).resolved.length, 0);
});

test('live-pack policy requires a complete recognized edit-only remedy', () => {
  const path = 'projects/demo-live-pack/plan.json';
  const spec = 'projects/demo-live-pack/SPEC.md';
  const protects = candidate => [path, spec].includes(candidate);
  const finding = recommendedFix => ({ file: path, recommendedFix });
  for (const fix of [
    `Update \`${path}\`.`,
    `Edit \`${path}\` and \`${spec}\`.`,
    `Update \`expected_jq\` and \`surface\` of the activation assertion in \`${path}\`.`,
    `Update \`expected_jq\` in \`${path}\`.`,
    `Edit \`${path}\`; update \`${spec}\`.`,
  ]) {
    assert.ok(livePackOnlyRemedy(finding(fix), protects), fix);
  }
  for (const fix of [
    '',
    'Revoke the exposed token in GitHub.',
    'Update the assertion.',
    `Investigate \`${path}\`.`,
    `Update \`${path}\` as needed.`,
    `Remove the embedded credential from \`${path}\` and revoke the exposed token in GitHub.`,
    `Update \`${path}\`; revoke the exposed token in GitHub.`,
    `Revoke the exposed token in GitHub, then update \`${path}\`.`,
    `Update \`expected_jq\` in \`${path}\` and rotate credentials.`,
    `Update \`${path}\` and update the GitHub settings.`,
    `Update \`${path}\`.\nNotify the operator.`,
  ]) {
    assert.equal(livePackOnlyRemedy(finding(fix), protects), null, fix);
  }
});

test('mixed remedies without additional filenames retain findings and grant no audit or closure credit', () => {
  const mixed = card('Exposed credential', 'projects/demo-live-pack/plan.json',
    'Remove the embedded credential from `projects/demo-live-pack/plan.json` and revoke the exposed token in GitHub.');
  for (const blocking of [false, true]) {
    const body = review(blocking ? { blocking: [mixed], verdict: 'Request changes' } : { nonBlocking: [mixed] });
    const policy = resolveGuardForbiddenNonBlocking(body, [], { livePackProtects: () => true });
    assert.deepEqual(policy.resolved, []);
    assert.equal(policy.auditDetails, '');
    assert.deepEqual((blocking ? policy.remainingBlocking : policy.remaining).map(finding => finding.title),
      ['Exposed credential']);
    if (!blocking) assert.equal(close(body, policy).eligible, false);
  }
});

test('workflow-path behaviour from HAMMERNOCI-01 is unchanged and live-pack policy never covers it', async () => {
  const workflow = card('Wire the check into CI', '.github/workflows/ci.yml', 'Add a step to `.github/workflows/ci.yml`.');
  const policy = resolveGuardForbiddenNonBlocking(review({ nonBlocking: [workflow] }), [], { livePackProtects: () => true });
  assert.equal(policy.resolved.length, 0);
  assert.equal(policy.remaining.length, 1);
  const remediation = buildRemediationPrompt({ jobId: 'fixture-job', repo: REPO, prNumber: 1, baseBranch: 'main',
    branch: 'topic', revisionRef: HEAD, reviewBody: review(), remediationPlan: { currentRound: 1, maxRounds: 3 } },
  { remediationReplyPath: '/fixture/reply.json' });
  const hammer = composeCloserPrompt({ templateBody: readFileSync(new URL('../templates/hammer-prompt.md', import.meta.url), 'utf8'),
    repo: 'fixture/repo', prNumber: 42, reviewedSha: HEAD, strictNonBlockingRemediation: false });
  for (const prompt of [remediation, hammer]) {
    assert.match(prompt, /Never edit `\.github\/workflows\/` or add CI checks, CI suites, ci-mirror manifest entries, required checks, gates, ratchets, guards or override labels/);
    assert.match(prompt, /Never edit a live build pack's `projects\/<slug>\/plan\.json`, `SPEC\.md`, `SPEC\.meta\.json` or `prompts\/\*\*`, even this PR's own/);
  }
  assert.match(remediation, /"declined: CI changes are operator-only"/);
  assert.match(remediation, /Resolved-By-Policy: live-pack-plan <path> requires an operator live edit/);
  // The hammer runs the helper in both modes and passes the effective strict policy.
  assert.match(hammer, /Before remediation, run bounded `node \S+\/bin\/guard-forbidden-paths\.mjs fixture\/repo 42 <complete-final-review-file> false`/);
  assert.match(LIVE_PACK_POLICY_INSTRUCTIONS, /When livePack\.failClosed is true or this helper fails, every such path is protected/);
});

test('follow-up remediation context reads packs the findings cite and marks the own live pack protected', async () => {
  const context = await resolveLivePackRemediationContext({
    repo: REPO, prNumber: 1, baseBranch: BASE, headRef: HEAD, branch: 'worker/DEMO-15',
    reviewBody: review({ nonBlocking: [liveCard, idleCard] }),
    listPrFilesImpl: async () => ['src/feature.mjs'],
    fetchFileAtRefImpl: fetchPlan, readActiveDagRunsImpl: ledger, sleepImpl: async () => {},
  });
  const facts = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(context)[1]);
  assert.deepEqual(facts.map(pack => [pack.slug, pack.ownPack, pack.live]),
    [['demo-idle-pack', false, false], ['demo-live-pack', true, true]]);
  assert.deepEqual(facts[1].touchedFiles, []);
  assert.deepEqual(facts[1].citedFiles, ['projects/demo-live-pack/plan.json']);
  assert.match(context, /this PR's own pack included/);
  assert.match(context, /A pack listed with `live: false` is remediated normally; a pack not listed here is treated as live/);
});

test('the hammer guard helper resolves a cited live-pack finding offline and fails closed without a dispatch read', t => {
  const dir = mkdtempSync(join(tmpdir(), 'remediationliveplan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reviewFile = join(dir, 'review.md');
  writeFileSync(reviewFile, review({ nonBlocking: [idleCard] }));
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}\n`
    + 'const args = process.argv.slice(2); const endpoint = args.find(arg => arg.startsWith("repos/")) || "";\n'
    + 'const jq = args[args.indexOf("--jq") + 1];\n'
    + `if (endpoint === "repos/${REPO}/pulls/1" && jq === ".base.sha") process.stdout.write("${BASE}\\n");\n`
    + `else if (endpoint === "repos/${REPO}/pulls/1" && jq === ".head.sha") process.stdout.write("${HEAD}\\n");\n`
    + `else if (endpoint === "repos/${REPO}/contents/projects/demo-idle-pack/plan.json?ref=${BASE}") process.stdout.write(${JSON.stringify(JSON.stringify(PLANS['projects/demo-idle-pack/plan.json']))});\n`
    + 'else { process.stderr.write("gh: Not Found (HTTP 404)"); process.exitCode = 1; }\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, HQ_ROOT: join(dir, 'hq') };
  delete env.ADVERSARIAL_DISPATCH_READS_ENABLED;
  const output = JSON.parse(execFileSync(process.execPath, [resolve('bin/guard-forbidden-paths.mjs'), REPO, '1', reviewFile, 'true'],
    { timeout: 60_000, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }));
  // No dispatch read here: the idle pack's liveness is inconclusive, so it is protected.
  assert.deepEqual(output.livePack.packs.map(pack => [pack.slug, pack.live, pack.inconclusive]), [['demo-idle-pack', true, true]]);
  assert.deepEqual(output.resolved.map(finding => finding.livePackPaths), [['projects/demo-idle-pack/plan.json']]);
  assert.match(output.auditDetails, /^Resolved-By-Policy: live-pack-plan projects\/demo-idle-pack\/plan\.json requires an operator live edit$/m);
});
