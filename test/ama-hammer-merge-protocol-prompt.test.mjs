import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const HAMMER_PROMPT = readFileSync(join(REPO_ROOT, 'templates', 'hammer-prompt.md'), 'utf8');

test('hammer prompt enforces the lease guarded GitHub-required-gate merge protocol (no local battery)', () => {
  assert.match(HAMMER_PROMPT, /do not\s+restart remediation/i);
  assert.match(HAMMER_PROMPT, /complete the merge\/closing-comment sequence idempotently/);
  assert.match(HAMMER_PROMPT, /final rebase→remote-CI→merge window/);
  assert.match(HAMMER_PROMPT, /HAM_MERGE_LEASE_WAIT_SECONDS="\$\{HAM_MERGE_LEASE_WAIT_SECONDS:-900\}"/);
  assert.match(HAMMER_PROMPT, /trap ham_release_merge_lease EXIT/);
  // SEV1: the hammer no longer runs a local test battery or the PPH pre-push CI
  // mirror as a merge gate; GitHub required checks are the sole CI authority.
  assert.doesNotMatch(HAMMER_PROMPT, /ham_run_pph_ci_mirror_with_timeout/);
  assert.doesNotMatch(HAMMER_PROMPT, /ham_run_local_battery_with_timeout/);
  assert.doesNotMatch(HAMMER_PROMPT, /HAM_LOCAL_BATTERY_COMMAND/);
  assert.match(HAMMER_PROMPT, /GitHub required checks are the SOLE CI authority/);
  assert.match(
    HAMMER_PROMPT,
    /HAM_LOCAL_CI_STATUS=local-battery-skipped-github-required-gate-authoritative/,
  );
  assert.match(HAMMER_PROMPT, /HAM_REMOTE_CI_WAIT_SECONDS="\$\{HAM_REMOTE_CI_WAIT_SECONDS:-900\}"/);
  assert.match(HAMMER_PROMPT, /HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT="\$\{HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT:-3\}"/);
  assert.match(HAMMER_PROMPT, /HAM_REMOTE_CI_GATE_READ_FAILURES=\$\(\(HAM_REMOTE_CI_GATE_READ_FAILURES \+ 1\)\)/);
  assert.match(HAMMER_PROMPT, /transient GitHub gate read failure/);
  assert.match(HAMMER_PROMPT, /github-gate-red/);
  assert.match(HAMMER_PROMPT, /github-gate-timeout/);
  assert.match(HAMMER_PROMPT, /protection_plan_unavailable_re=/);
  assert.match(HAMMER_PROMPT, /branchProtectionUnavailable: true, reason: "github_plan"/);
  assert.match(HAMMER_PROMPT, /2> "\$protection_err"/);
  assert.match(HAMMER_PROMPT, /trap 'rm -f "\$protection_err"' EXIT/);
  assert.doesNotMatch(HAMMER_PROMPT, /\|\s*IN\(/);
  assert.match(HAMMER_PROMPT, /index\(\$conclusion\)/);
  assert.doesNotMatch(HAMMER_PROMPT, /HAM_PPH_REMOTE_SHA=\$\(printf '%040d' 0\)/);
  assert.doesNotMatch(HAMMER_PROMPT, /HAM_PPH_REMOTE_SHA="\$HAM_REBASED_ONTO_BASE_SHA"/);
  assert.doesNotMatch(HAMMER_PROMPT, /--stdin < "\$HAM_PPH_STDIN"/);
  assert.doesNotMatch(HAMMER_PROMPT, /HAM_PPH_FILES=\(\)/);
  assert.doesNotMatch(HAMMER_PROMPT, /ham_changed_files_for_local_ci/);
  assert.doesNotMatch(HAMMER_PROMPT, /HAM_PPH_CI_ARGS\+=\(--files/);
  assert.doesNotMatch(HAMMER_PROMPT, /tr '\\n' ' '/);
  assert.doesNotMatch(HAMMER_PROMPT, /--files \$HAM_PPH_FILES/);
  assert.match(HAMMER_PROMPT, /--match-head-commit "\$POST_REMEDIATION_SHA"/);
  assert.match(HAMMER_PROMPT, /rebasedOntoBase: \$rebasedOntoBase/);
  assert.match(HAMMER_PROMPT, /localCiStatus: \$localCiStatus/);
  assert.match(HAMMER_PROMPT, /remoteCiStatus: \$remoteCiStatus/);
  assert.match(HAMMER_PROMPT, /Closed-By: hammer \(adversarial-pipe-mode\)/);
});

test('hammer audit comment payload excludes prompt-only authoring instructions', () => {
  const commentDetails = HAMMER_PROMPT.match(
    /HAM_AUDIT_COMMENT_DETAILS="\$\(cat <<'EOF'\n(?<body>[\s\S]*?)\nEOF\n\)"/,
  )?.groups?.body;

  assert.ok(commentDetails, 'expected to find the quoted hammer audit comment heredoc');
  assert.doesNotMatch(commentDetails, /optionally add/i);
  assert.match(HAMMER_PROMPT, /When filling in the comment body below, optionally add/i);
});

test('hammer audit comment keeps model-authored markdown out of shell expansion', () => {
  assert.match(HAMMER_PROMPT, /HAM_AUDIT_COMMENT_DETAILS="\$\(cat <<'EOF'/);
  assert.match(
    HAMMER_PROMPT,
    /HAM_AUDIT_COMMENT_BODY=\$\(printf[\s\S]*"\$HAM_AUDIT_COMMENT_DETAILS"[\s\S]*"\$POST_REMEDIATION_SHA"[\s\S]*"\$HAM_AUDIT_REMEDIATED_TOTAL"[\s\S]*"\$HAM_AUDIT_REMEDIATED_BLOCKING"[\s\S]*"\$HAM_AUDIT_REMEDIATED_NON_BLOCKING"\)/,
  );
});

test('hammer audit comment keeps parseable footer fields out of the editable heredoc', () => {
  const bodyComposer = HAMMER_PROMPT.match(
    /HAM_AUDIT_COMMENT_BODY=\$\(printf[\s\S]*?"\$HAM_AUDIT_REMEDIATED_NON_BLOCKING"\)/,
  )?.[0];

  assert.ok(bodyComposer, 'expected to find the hammer audit comment composer');
  assert.doesNotMatch(bodyComposer, /<n>|<b>|<nb>/);
  assert.match(
    bodyComposer,
    /<sub>\\nHAM-Terminal-Remediation-Head: %s\\nRemediated-Findings: %s addressed \(%s blocking, %s non-blocking\)\\nClosed-By: hammer \(adversarial-pipe-mode\)\\n<\/sub>/,
  );
  assert.match(HAMMER_PROMPT, /HAM_AUDIT_REMEDIATED_TOTAL='<n>'/);
  assert.match(HAMMER_PROMPT, /HAM_AUDIT_REMEDIATED_BLOCKING='<b>'/);
  assert.match(HAMMER_PROMPT, /HAM_AUDIT_REMEDIATED_NON_BLOCKING='<nb>'/);
  assert.match(HAMMER_PROMPT, /ham_audit_is_nonnegative_int "\$HAM_AUDIT_REMEDIATED_TOTAL"/);
});

test('hammer audit is deduped by marker and refreshed in place across rebases (agent-os#4090)', () => {
  // A single hammer that rebases the same terminal remediation onto an advancing
  // main must refresh ONE audit comment, not post a look-alike per rebase — which
  // read as several separate hammers. The dedup lookup keys on the STABLE marker
  // alone, never the per-rebase head sha.
  const lookup = HAMMER_PROMPT.match(
    /ham_existing_terminal_audit_comment_id\(\)\s*\{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(lookup, 'expected the audit-comment lookup function');
  assert.match(lookup, /contains\(\$marker\)/);
  // No longer keyed on the per-rebase head sha (that caused the duplicate posts):
  assert.doesNotMatch(lookup, /\$head/);
  assert.doesNotMatch(HAMMER_PROMPT, /HAM_AUDIT_COMMENT_HEAD=/);
  // An existing audit is refreshed IN PLACE (PATCH edit), not skipped or duplicated:
  assert.match(HAMMER_PROMPT, /gh api --method PATCH/);
  assert.match(HAMMER_PROMPT, /issues\/comments\/\$HAM_EXISTING_AUDIT_COMMENT_ID/);
  assert.match(HAMMER_PROMPT, /hammer audit comment refreshed in place/);
});

test('terminal-remediation audit is written under the merge lease at the settled head (agent-os#4090)', () => {
  // The audit must be written AFTER the rebase window settles (lease held, head
  // settled) and BEFORE the ama-check predicate + merge — not before the rebase,
  // where each re-entry re-posted it at a new head.
  const auditIdx = HAMMER_PROMPT.indexOf('Post the PR audit comment');
  const rebaseLoopIdx = HAMMER_PROMPT.indexOf('= "BEHIND"');
  const leaseAcquireIdx = HAMMER_PROMPT.indexOf('ham_acquire_merge_lease');
  const predicateIdx = HAMMER_PROMPT.indexOf('ama-check.mjs');
  const mergeIdx = HAMMER_PROMPT.indexOf('gh pr merge <<PR_URL>>');
  assert.ok(auditIdx > 0, 'audit block present');
  assert.ok(rebaseLoopIdx > 0 && leaseAcquireIdx > 0, 'rebase window + lease acquire present');
  assert.ok(predicateIdx > 0 && mergeIdx > 0, 'predicate + merge present');
  // Rebase window and lease acquisition come BEFORE the audit:
  assert.ok(rebaseLoopIdx < auditIdx, 'audit must follow the rebase window');
  assert.ok(leaseAcquireIdx < auditIdx, 'audit must follow lease acquisition');
  // Audit comes BEFORE the predicate and the merge:
  assert.ok(auditIdx < predicateIdx, 'audit must precede the ama-check predicate');
  assert.ok(auditIdx < mergeIdx, 'audit must precede the merge');
  // And it fails closed unless the merge lease is currently held:
  assert.match(
    HAMMER_PROMPT,
    /terminal-remediation audit must be written while holding the merge lease/,
  );
});
