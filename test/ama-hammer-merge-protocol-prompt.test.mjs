import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const HAMMER_PROMPT = readFileSync(join(REPO_ROOT, 'templates', 'hammer-prompt.md'), 'utf8');

test('hammer prompt enforces the PSH-05 lease guarded local and remote CI merge protocol', () => {
  assert.match(HAMMER_PROMPT, /do not\s+restart remediation/i);
  assert.match(HAMMER_PROMPT, /complete the merge\/closing-comment sequence idempotently/);
  assert.match(HAMMER_PROMPT, /final rebase→local-CI→remote-CI→merge window/);
  assert.match(HAMMER_PROMPT, /HAM_MERGE_LEASE_WAIT_SECONDS="\$\{HAM_MERGE_LEASE_WAIT_SECONDS:-900\}"/);
  assert.match(HAMMER_PROMPT, /trap ham_release_merge_lease EXIT/);
  assert.match(HAMMER_PROMPT, /ham_run_pph_ci_mirror_with_timeout\(\)/);
  assert.match(HAMMER_PROMPT, /PPH pre-push CI mirror/);
  assert.match(HAMMER_PROMPT, /HAM_REMOTE_CI_WAIT_SECONDS="\$\{HAM_REMOTE_CI_WAIT_SECONDS:-900\}"/);
  assert.match(HAMMER_PROMPT, /HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT="\$\{HAM_REMOTE_CI_GATE_READ_FAILURE_LIMIT:-3\}"/);
  assert.match(HAMMER_PROMPT, /HAM_REMOTE_CI_GATE_READ_FAILURES=\$\(\(HAM_REMOTE_CI_GATE_READ_FAILURES \+ 1\)\)/);
  assert.match(HAMMER_PROMPT, /transient GitHub gate read failure/);
  assert.match(HAMMER_PROMPT, /github-gate-red/);
  assert.match(HAMMER_PROMPT, /github-gate-timeout/);
  assert.doesNotMatch(HAMMER_PROMPT, /\|\s*IN\(/);
  assert.match(HAMMER_PROMPT, /index\(\$conclusion\)/);
  assert.match(HAMMER_PROMPT, /HAM_PPH_REMOTE_SHA=\$\(printf '%040d' 0\)/);
  assert.match(HAMMER_PROMPT, /HAM_PPH_REMOTE_SHA="\$HAM_REBASED_ONTO_BASE_SHA"/);
  assert.match(HAMMER_PROMPT, /--match-head-commit "\$POST_REMEDIATION_SHA" --stdin < "\$HAM_PPH_STDIN"/);
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
