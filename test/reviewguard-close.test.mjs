import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveGuardForbiddenNonBlocking, filterGuardForbiddenFindings } from '../src/guard-forbidden-paths.mjs';
import { parseNonBlockingFindingsSection } from '../src/kernel/review-findings.mjs';
import { isEligibleForAmaClosure } from '../src/ama/eligibility.mjs';
import { buildHamTerminalRemediationEvidenceFromGroundTruth } from '../src/ama/dispatch-closer.mjs';

const HEAD = 'a'.repeat(40);
const GATE = 'fixture/adversarial-gate';
const guards = [{ check: 'Reject generated catalog edits', path: 'docs/CATALOG.md' }];
const card = '- **Missing generated catalog**\n  - **File:** `docs/CATALOG.md`\n  - **Problem:** The new incident report is missing from the generated catalog.\n  - **Recommended fix:** Commit the regenerated `docs/CATALOG.md`.';
const review = `## Summary\nOne incident report added.\n## Blocking issues\n- None.\n## Non-blocking issues\n${card}\n## Verdict\nComment only\n`;

function runPolicyCli(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'reviewguard-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reviewFile = join(dir, 'review.md');
  const callsFile = join(dir, 'calls.jsonl');
  writeFileSync(reviewFile, body);
  writeFileSync(join(dir, 'gh'), `#!${process.execPath}\n`
    + `import { appendFileSync } from 'node:fs';\n`
    + `const args = process.argv.slice(2); appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');\n`
    + `const endpoint = args.find(arg => arg.startsWith('repos/'));\n`
    + `if (endpoint === 'repos/example/manual/pulls/1' || endpoint === 'repos/example/manual/commits/docs-base') process.stdout.write('${'b'.repeat(40)}\\n');\n`
    + `else if (endpoint === 'repos/example/manual/contents/.github/workflows/repo-guards.yml?ref=${'b'.repeat(40)}') process.stdout.write(${JSON.stringify('jobs:\n  guards:\n    steps:\n      - name: Reject generated catalog edits\n        run: python3 scripts/check-generated-index-pr-diff.py --base BASE --head HEAD\n')});\n`
    + `else if (endpoint === 'repos/example/manual/contents/scripts/check-generated-index-pr-diff.py?ref=${'b'.repeat(40)}') process.stdout.write('GENERATED_PATHS = ("docs/CATALOG.md",)\\n');\n`
    + `else { process.stderr.write('unexpected fixture API call'); process.exitCode = 1; }\n`, { mode: 0o755 });
  const stdout = execFileSync(process.execPath, [resolve('bin/guard-forbidden-paths.mjs'), 'example/manual', '1', reviewFile, 'true'], {
    timeout: 10_000, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  const calls = readFileSync(callsFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 3);
  assert.ok(calls.every(args => !args.includes('POST') && !args.includes('PATCH')));
  return JSON.parse(stdout);
}

function close(body, policy) {
  const findings = parseNonBlockingFindingsSection(body);
  const file = { filename: 'docs/reports/new-report.md', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+Incident report' };
  const commit = { sha: HEAD, parentSha: 'b'.repeat(40), changedFiles: [file.filename],
    primaryChange: { headSha: HEAD, ciCost: { headSha: HEAD, ok: true }, hasHammerCommits: false,
      primaryHead: HEAD, mergeBase: 'b'.repeat(40), primaryFiles: [file], finalFiles: [file] } };
  const auditComment = { author: 'hammer-worker', body: [
    '<!-- hq:ham-terminal-remediation:audit -->', '**Findings addressed**', policy.auditDetails,
    'Doc-currency: updated docs/reports/new-report.md.',
    `HAM-Base-Head: ${HEAD}`, `HAM-Validated-Head: ${HEAD}`,
  ].join('\n') };
  const evidence = buildHamTerminalRemediationEvidenceFromGroundTruth({ reviewedHead: HEAD, verifiedCommit: commit, verifiedAuditComment: auditComment });
  const result = isEligibleForAmaClosure({ verdict: 'comment-only', headSha: HEAD, riskClass: 'low',
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
  return { result, auditComment, commit };
}

test('REVIEWGUARD-01: documentation-only PR closes in strict mode with policy audit and no operator decision', t => {
  const policy = runPolicyCli(t, review);
  assert.equal(policy.resolved.length, 1);
  assert.match(policy.instructions, /do not raise an operator decision/);
  assert.deepEqual(policy.remaining, []);
  assert.deepEqual(policy.blocking, []);
  const { result, auditComment, commit } = close(review, policy);
  assert.equal(result.eligible, true, JSON.stringify(result.reasons));
  assert.deepEqual(result.reasons, []);
  assert.ok(auditComment.body.split('\n').includes('Resolved-By-Policy: guard:Reject generated catalog edits forbids docs/CATALOG.md'));
  assert.deepEqual(commit.changedFiles, ['docs/reports/new-report.md']);
  const filtered = filterGuardForbiddenFindings(review, guards, { log: {} });
  assert.deepEqual(parseNonBlockingFindingsSection(filtered), []);
});

test('REVIEWGUARD-01: a non-forbidden change still requires remediation alongside the policy resolution', t => {
  const normal = card.replaceAll('Missing generated catalog', 'Broken document link').replaceAll('docs/CATALOG.md', 'docs/guide.md');
  const body = review.replace(card, card + '\n' + normal);
  const policy = runPolicyCli(t, body);
  assert.equal(policy.resolved.length, 1);
  assert.deepEqual(policy.remaining.map(finding => finding.title), ['Broken document link']);
  const { result } = close(body, policy);
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('non-blocking-findings-present'));
  assert.equal(result.trace.hamTerminalRemediation.nonBlockingCoverage.ok, false);
});

test('blocking, unknown and mixed remedies cannot be resolved by this policy', () => {
  const blocking = review.replace('## Blocking issues\n- None.', `## Blocking issues\n${card}`).replace(`## Non-blocking issues\n${card}`, '## Non-blocking issues\n- None.');
  const policy = resolveGuardForbiddenNonBlocking(blocking, guards);
  assert.equal(policy.resolved.length, 0);
  assert.equal(policy.blocking.length, 1);
  assert.equal(resolveGuardForbiddenNonBlocking('unparseable', guards).remaining, null);
  assert.equal(resolveGuardForbiddenNonBlocking(review, guards, { strictNonBlockingRemediation: false }).resolved.length, 0);
  assert.equal(resolveGuardForbiddenNonBlocking(review.replace('Commit the regenerated', 'Commit and fix the generator for'), guards).resolved.length, 0);
  assert.equal(resolveGuardForbiddenNonBlocking(review.replace(card, card + '\n  - Also fix the guide link.'), guards).resolved.length, 0);
  const differentSource = resolveGuardForbiddenNonBlocking(review.replace('**File:** `docs/CATALOG.md`', '**File:** `docs/reports/new-report.md`'), guards);
  assert.match(differentSource.auditDetails, /docs\/CATALOG\.md is regenerated by automation/);
  assert.doesNotMatch(differentSource.auditDetails, /new-report\.md.*regenerated/);
});
