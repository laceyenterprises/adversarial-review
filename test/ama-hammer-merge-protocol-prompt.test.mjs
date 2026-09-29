import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BRANCH_NOT_PROTECTED_STDERR,
  BRANCH_NOT_PROTECTED_STDOUT,
  GITHUB_PLAN_UNAVAILABLE_STDERR,
  runHammerProtectionFetch,
} from './helpers/hammer-protection-fetch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const HAMMER_TEMPLATE = readFileSync(join(REPO_ROOT, 'templates', 'hammer-prompt.md'), 'utf8');
// Structural merge-protocol assertions inspect the extracted versioned procedures
// at their call sites, while the dispatched prompt remains small.
const HAMMER_PROMPT = HAMMER_TEMPLATE.replace(
  /In the persistent merge-lease shell, render and source `node <<ROOT_DIR>>\/bin\/hammer-procedure\.mjs (hammer-[a-z-]+) --render`[^\n]*\n/g,
  (_, phase) => `\`\`\`bash\n${readFileSync(join(REPO_ROOT, 'bin', `${phase}.sh`), 'utf8')}\`\`\`\n`,
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...(options.env ?? {}),
    },
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function git(cwd, args) {
  return run('git', args, { cwd });
}

function configureGitIdentity(cwd) {
  git(cwd, ['config', 'user.name', 'Hammer Prompt Test']);
  git(cwd, ['config', 'user.email', 'hammer-prompt-test@example.invalid']);
}

function createSuperprojectWithSpaceSubmodule(t) {
  const root = mkdtempSync(join(tmpdir(), 'hammer-gitlink-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const upstream = join(root, 'upstream module');
  mkdirSync(upstream, { recursive: true });
  git(upstream, ['init', '-q']);
  configureGitIdentity(upstream);
  writeFileSync(join(upstream, 'README.md'), 'one\n');
  git(upstream, ['add', 'README.md']);
  git(upstream, ['commit', '-q', '-m', 'initial upstream']);

  const superproject = join(root, 'super project');
  mkdirSync(superproject, { recursive: true });
  git(superproject, ['init', '-q']);
  configureGitIdentity(superproject);
  git(superproject, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '-q',
    upstream,
    'modules/review module',
  ]);
  git(superproject, ['commit', '-q', '-m', 'add submodule']);

  return {
    upstream,
    superproject,
    submodulePath: join(superproject, 'modules', 'review module'),
  };
}

function hammerStagedGitlinkGuardScript() {
  const commitBlockStart = HAMMER_PROMPT.indexOf('Commit the remediation:');
  assert.notEqual(commitBlockStart, -1, 'expected commit block in hammer prompt');
  const guardStart = HAMMER_PROMPT.indexOf('ham_staged_gitlinks()', commitBlockStart);
  assert.notEqual(guardStart, -1, 'expected staged gitlink guard in hammer prompt');
  const guardEnd = HAMMER_PROMPT.indexOf('# HSC-01:', guardStart);
  assert.notEqual(guardEnd, -1, 'expected HSC-01 marker after staged gitlink guard');
  return HAMMER_PROMPT.slice(guardStart, guardEnd).trim();
}

function runHammerStagedGitlinkGuard(cwd) {
  return run('bash', ['-lc', hammerStagedGitlinkGuardScript()], { cwd });
}

function stagedGitlinkPaths(cwd) {
  const raw = git(cwd, ['diff', '--cached', '--raw', '-z', '--ignore-submodules=none']).stdout;
  const fields = raw.split('\0');
  const paths = [];
  for (let index = 0; index < fields.length;) {
    const meta = fields[index++];
    if (!meta) {
      continue;
    }
    const match = meta.match(/^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/);
    const path = fields[index++] ?? '';
    let newPath = path;
    if (match?.[3] === 'R' || match?.[3] === 'C') {
      newPath = fields[index++] ?? '';
    }
    if (!match || (match[1] !== '160000' && match[2] !== '160000')) {
      continue;
    }
    paths.push(path);
    if (newPath && newPath !== path) {
      paths.push(newPath);
    }
  }
  return paths;
}

test('hammer prompt enforces the lease guarded GitHub-required-gate merge protocol (no local battery)', () => {
  assert.match(HAMMER_PROMPT, /do not\s+restart remediation/i);
  assert.match(HAMMER_PROMPT, /complete the merge\/closing-comment sequence idempotently/);
  assert.match(HAMMER_PROMPT, /final rebase→remote-CI→merge window/);
  assert.match(HAMMER_PROMPT, /HAM_MERGE_LEASE_WAIT_SECONDS="\$\{HAM_MERGE_LEASE_WAIT_SECONDS:-900\}"/);
  assert.match(HAMMER_PROMPT, /HAM_NODE_BIN="\$\{HAM_NODE_BIN:-\$\(command -v node 2>\/dev\/null \|\| true\)\}"/);
  assert.match(HAMMER_PROMPT, /perl -e '\$t = shift \|\| 360; alarm \$t; exec @ARGV'/);
  assert.match(HAMMER_PROMPT, /ham_mark_merge_lease_retryable_abort\(\)/);
  assert.match(HAMMER_PROMPT, /--retryable-abort "\$\{HAM_MERGE_LEASE_RETRYABLE_ABORT_REASON:-retryable-abort\}"/);
  assert.match(HAMMER_PROMPT, /local ham_release_retryable_args=\(\)/);
  assert.ok(HAMMER_PROMPT.includes('"${ham_release_retryable_args[@]+"${ham_release_retryable_args[@]}"}"'));
  assert.match(HAMMER_PROMPT, /ham_mark_merge_lease_retryable_abort merge-retry-budget-exhausted/);
  assert.match(HAMMER_PROMPT, /ham_mark_merge_lease_retryable_abort github-gate-read-failed/);
  assert.match(HAMMER_PROMPT, /ham_mark_merge_lease_retryable_abort required-checks-pending/);
  assert.match(HAMMER_PROMPT, /--stage required-checks --state "\$HAM_PENDING_CHECK_STATES"/);
  assert.match(HAMMER_PROMPT, /HAM_PENDING_CHECK_STATES=.*\.checksConclusion/);
  assert.match(HAMMER_PROMPT, /const checksConclusion = classifyCheckRollup\(checks\)/);
  assert.match(HAMMER_PROMPT, /classifyCheckRollup\(\[check\]\) !== 'SUCCESS'/);
  assert.match(HAMMER_PROMPT, /\.checksConclusion != "PENDING"/);
  assert.doesNotMatch(HAMMER_PROMPT, /const badChecks = latestCheckRollupItems\(checks\)\.filter\(\(check\) => \{/);
  assert.match(HAMMER_PROMPT, /--required-checks-green/);
  assert.match(HAMMER_PROMPT, /\.closingStatus \/\/ empty/);
  assert.match(HAMMER_PROMPT, /merge lease head is not a full SHA/);
  assert.match(HAMMER_PROMPT, /--arg closingStatus "\$HAM_GATE_CAP_CLOSING_STATUS"/);
  assert.match(HAMMER_PROMPT, /HAM_GATE_CAP_COMMENT=[\s\S]*?\$HAM_GATE_CAP_CLOSING_STATUS/);
  assert.match(HAMMER_PROMPT, /ham_gate_cap_gh_transient\(\)/);
  assert.match(HAMMER_PROMPT, /ham_gate_cap_gh "\$HAM_GATE_CAP_OUT" "\$HAM_GATE_CAP_ERR" api --paginate/);
  assert.match(HAMMER_PROMPT, /ham_gate_cap_gh "\$HAM_GATE_CAP_OUT" "\$HAM_GATE_CAP_ERR" api --method PATCH/);
  assert.match(HAMMER_PROMPT, /ham_gate_cap_gh "\$HAM_GATE_CAP_OUT" "\$HAM_GATE_CAP_ERR" pr comment/);
  assert.match(HAMMER_PROMPT, /HAM_GATE_CAP_AUDIT_EXIT" -eq 65/);
  assert.match(HAMMER_PROMPT, /contains\("HAM-Terminal-Remediation-Head: " \+ \$head\)/);
  assert.match(HAMMER_PROMPT, /pre-acquire-checks\.json/);
  assert.doesNotMatch(HAMMER_PROMPT, /ham_mark_merge_lease_retryable_abort merge-confirmation-read-failed/);
  assert.match(HAMMER_PROMPT, /ham_fire_watcher_merge_wake\(\)/);
  assert.match(HAMMER_PROMPT, /bin\/watcher-wake\.mjs/);
  assert.match(HAMMER_PROMPT, /--reason hammer-pr-eligible/);
  assert.match(HAMMER_PROMPT, /HAM_CAPTURED_BASE_SHA=\$\(git rev-parse FETCH_HEAD/);
  assert.match(HAMMER_PROMPT, /current_base_sha=\$\(git rev-parse FETCH_HEAD/);
  assert.match(HAMMER_PROMPT, /base_files=\$\(git diff --name-only "\$HAM_VALIDATION_BASE_SHA\.\.\$current_base_sha"/);
  assert.match(HAMMER_PROMPT, /Never use retryable-abort for red/);
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
  assert.match(HAMMER_PROMPT, /const checks = Array\.isArray\(rollup\.checks\)/);
  assert.match(HAMMER_PROMPT, /Array\.isArray\(rollup\.statusCheckRollup\)[\s\S]*rollup\.statusCheckRollup/);
  assert.doesNotMatch(
    HAMMER_PROMPT,
    /const checks = Array\.isArray\(rollup\.statusCheckRollup\) \? rollup\.statusCheckRollup : \[\];/,
  );
  assert.match(HAMMER_PROMPT, /transient GitHub gate read failure/);
  assert.match(HAMMER_PROMPT, /github-gate-red/);
  assert.match(HAMMER_PROMPT, /github-gate-timeout/);
  assert.match(
    HAMMER_PROMPT,
    /Do not parse this boolean with a jq fallback such as[\s\S]*\.needsRevalidation \/\/ true/,
  );
  assert.match(
    HAMMER_PROMPT,
    /jq -er 'if \(\.needsRevalidation \| type\) == "boolean" then \.needsRevalidation else true end'/,
  );
  assert.doesNotMatch(HAMMER_PROMPT, /jq[^\n]*\.needsRevalidation\s*\/\/\s*true/);
  assert.match(HAMMER_PROMPT, /protection_plan_unavailable_re=/);
  assert.match(HAMMER_PROMPT, /branchProtectionUnavailable: true, reason: "github_plan"/);
  assert.match(HAMMER_PROMPT, /protection_not_protected_re='branch not protected'/);
  assert.match(HAMMER_PROMPT, /jq -n '\{ status: "404", message: "Branch not protected" \}'/);
  assert.match(HAMMER_PROMPT, /2> "\$protection_err"/);
  assert.match(HAMMER_PROMPT, /trap 'rm -f "\$protection_err"; ham_release_merge_lease' EXIT/);
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
  assert.match(HAMMER_PROMPT, /HAM_PROTECTIVE_PREDECESSORS=/);
  assert.match(HAMMER_PROMPT, /\/\^\[\[:space:\]\]\*Protects-Against-Unsafe-Merge-Until-PR/);
  assert.match(HAMMER_PROMPT, /ham_read_protective_predecessor_value\(\)/);
  assert.match(HAMMER_PROMPT, /ham_mark_merge_lease_retryable_abort protective-predecessor-read-failed/);
  assert.doesNotMatch(
    HAMMER_PROMPT,
    /HAM_PROTECTIVE_PREDECESSORS=\$\(gh pr view <<PR_URL>> --json body --jq '\.body \/\/ ""' \| awk/,
  );
  assert.match(HAMMER_PROMPT, /protective-predecessor-open/);
  assert.match(HAMMER_PROMPT, /--match-head-commit "\$POST_REMEDIATION_SHA"/);
  assert.match(HAMMER_PROMPT, /rebasedOntoBase: \$rebasedOntoBase/);
  assert.match(HAMMER_PROMPT, /localCiStatus: \$localCiStatus/);
  assert.match(HAMMER_PROMPT, /remoteCiStatus: \$remoteCiStatus/);
  assert.match(HAMMER_PROMPT, /Closed-By: hammer \(adversarial-pipe-mode\)/);
});

test('the no-merge closing status carries the line the closer reads (HAMBG-02)', () => {
  const mandate = HAMMER_TEMPLATE.slice(
    HAMMER_TEMPLATE.indexOf('0b. **A run that does not merge'),
    HAMMER_TEMPLATE.indexOf('\n1. Read the FINAL'),
  );
  assert.match(mandate, /the comment must contain the line `HAM closing status — no merge\.`/);
  // The gate-cap park writes the same line.
  assert.match(HAMMER_PROMPT, /HAM closing status — no merge\. The gate-attempt cap stopped this head/);
});

test('hammer protection fetch writes the github_plan sentinel for the free-plan 403 (HAMBG-02, agent-os)', () => {
  const result = runHammerProtectionFetch({ stderr: GITHUB_PLAN_UNAVAILABLE_STDERR });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.protectionBody), {
    branchProtectionUnavailable: true,
    reason: 'github_plan',
  });
});

test('hammer protection fetch writes a 404 status for an unprotected branch (HAMBG-02, adversarial-review)', () => {
  // `gh api` prints GitHub's JSON body on stdout as well; the loop replaces it.
  const result = runHammerProtectionFetch({
    stdout: BRANCH_NOT_PROTECTED_STDOUT,
    stderr: BRANCH_NOT_PROTECTED_STDERR,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.protectionBody), {
    status: '404',
    message: 'Branch not protected',
  });
});

test('hammer protection fetch still fails closed on any other error', () => {
  for (const stderr of [
    'gh: Branch not found (HTTP 404)',
    'gh: Resource not accessible by integration (HTTP 403)',
    'gh: Bad credentials (HTTP 401)',
  ]) {
    const result = runHammerProtectionFetch({ stderr });
    assert.equal(result.status, 1, stderr);
    assert.match(result.stderr, new RegExp(stderr.replace(/[()]/g, '\\$&')));
  }
});

test('hammer protection fetch keeps a readable protection object as-is', () => {
  const body = '{"required_status_checks":{"contexts":["agent-os/adversarial-gate"]}}';
  const result = runHammerProtectionFetch({ stdout: body, exitCode: 0 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.protectionBody, body);
});

test('hammer prompt requires bounded post-rebase sync and one truthful no-merge comment', () => {
  assert.match(HAMMER_PROMPT, /ham_bounded_git_sync\(\)/);
  assert.match(
    HAMMER_PROMPT,
    /load-aware-timeout\.mjs "\$HAM_GIT_SYNC_NOMINAL_SECONDS"/,
  );
  assert.match(HAMMER_PROMPT, /while \[ "\$ham_git_sync_attempt" -le 2 \]/);
  assert.match(HAMMER_PROMPT, /ham_bounded_git_sync "\$BASE_BRANCH" "\$HEAD_BRANCH"/);
  assert.match(HAMMER_PROMPT, /Do not wrap `git fetch`[\s\S]*in your own fixed alarm/);
  assert.match(HAMMER_PROMPT, /A run that does not merge must say so exactly once on the PR/);
  assert.match(
    HAMMER_PROMPT,
    /what the run completed[\s\S]*exact[\s\S]*where it stopped[\s\S]*whether the merge lease was released[\s\S]*what happens next/,
  );
  assert.match(HAMMER_PROMPT, /single in-lease audit comment[\s\S]*successful merge path/);
  assert.match(HAMMER_PROMPT, /edit it in place[\s\S]*do not leave the audit and add a second comment/);
});

test('hammer fires watcher wake only after durable eligible audit append', () => {
  const wakeFunctionIdx = HAMMER_PROMPT.indexOf('ham_fire_watcher_merge_wake()');
  const remoteGreenIdx = HAMMER_PROMPT.indexOf('HAM_REMOTE_CI_STATUS=remote-ci-green');
  const eligibleIdx = HAMMER_PROMPT.indexOf('HAM_PRE_MERGE_ELIGIBLE=1', remoteGreenIdx);
  const preMergeAuditIdx = HAMMER_PROMPT.indexOf('--outcome in_progress', eligibleIdx);
  const wakeCallIdx = HAMMER_PROMPT.indexOf('ham_fire_watcher_merge_wake', preMergeAuditIdx);
  const mergeLoopIdx = HAMMER_PROMPT.indexOf(
    'while [ "$HAM_ALREADY_MERGED_VALIDATED_HEAD" -ne 1 ]',
  );
  const mergeIdx = HAMMER_PROMPT.indexOf('gh pr merge <<PR_URL>>');

  assert.ok(wakeFunctionIdx > 0, 'watcher wake helper must exist');
  assert.ok(remoteGreenIdx > 0, 'remote CI green gate must exist');
  assert.ok(eligibleIdx > remoteGreenIdx, 'pre-merge eligibility is set after remote CI green');
  assert.ok(preMergeAuditIdx > eligibleIdx, 'eligible audit append must follow eligibility');
  assert.ok(wakeCallIdx > preMergeAuditIdx, 'wake fires after durable eligible audit append');
  assert.ok(wakeCallIdx < mergeLoopIdx, 'wake fires before the merge retry loop');
  assert.ok(mergeLoopIdx < mergeIdx, 'merge command remains inside the retry loop');
});

test('hammer refunds a pending-only remote CI timeout before releasing its lease', () => {
  const start = HAMMER_PROMPT.indexOf('HAM_REMOTE_CI_STATUS=remote-ci-timeout');
  const end = HAMMER_PROMPT.indexOf('echo "HAM remote CI: waiting', start);
  assert.ok(start > 0 && end > start);
  const timeoutBranch = HAMMER_PROMPT.slice(start, end);
  assert.match(timeoutBranch, /ham_required_gate_red/);
  assert.match(timeoutBranch, /merge-lease\.mjs classify[\s\S]*--stage required-checks/);
  assert.match(timeoutBranch, /ham_mark_merge_lease_retryable_abort required-checks-pending[\s\S]*ham_release_merge_lease/);
});

test('hammer merge capability shell fallback mirrors JS token-class discovery', () => {
  for (const name of [
    'AGENT_OS_GITHUB_TOKEN_CLASS',
    'AGENT_OS_MERGE_TOKEN_CLASS',
    'GITHUB_TOKEN_CLASS',
    'GH_TOKEN_CLASS',
    'HQ_GITHUB_TOKEN_CLASS',
    'OAUTH_BROKER_TOKEN_CLASS',
    'OAUTH_BROKER_PROVIDER',
    'OAUTH_BROKER_GITHUB_APP_PROVIDER',
    'OAUTH_BROKER_MERGE_AGENT_PROVIDER',
    'OAUTH_BROKER_HAMMER_PROVIDER',
    'OAUTH_BROKER_CODEX_PROVIDER',
    'OAUTH_BROKER_CLAUDE_PROVIDER',
    'OAUTH_BROKER_GEMINI_PROVIDER',
    'OAUTH_BROKER_CODEX_REVIEWER_PROVIDER',
    'OAUTH_BROKER_CLAUDE_REVIEWER_PROVIDER',
    'OAUTH_BROKER_GEMINI_REVIEWER_PROVIDER',
  ]) {
    assert.match(HAMMER_PROMPT, new RegExp(`\\$\\{${name}:-\\}`), `missing ${name}`);
  }

  assert.ok(
    HAMMER_PROMPT.includes(
      "printf '%s' \"$1\" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | tr '[:upper:]_' '[:lower:]-'",
    ),
  );
  assert.match(HAMMER_PROMPT, /ham_first_nonempty_merge_token_class/);
  assert.match(HAMMER_PROMPT, /ham_first_known_merge_provider_class/);
  assert.match(
    HAMMER_PROMPT,
    /builder\|builder-class\|codex\|claude-code\|gemini\|clio-agent[\s\S]*merge-agent\|hammer\|hammer-claude\|the-hammer/,
  );
  assert.match(HAMMER_PROMPT, /case "\$HAM_MERGE_TOKEN_CLASS" in/);
  assert.doesNotMatch(HAMMER_PROMPT, /case "\$\(printf '%s' "\$HAM_MERGE_TOKEN_CLASS" \| tr/);
});

test('hammer audit comment payload reads caller-supplied findings without prompt instructions', () => {
  assert.match(HAMMER_TEMPLATE, /write the complete audit markdown to/);
  assert.match(HAMMER_PROMPT, /HAM_AUDIT_COMMENT_DETAILS="\$\(cat "\$HAM_AUDIT_DETAILS_FILE"\)"/);
  assert.doesNotMatch(HAMMER_PROMPT, /HAM_AUDIT_COMMENT_DETAILS="\$\(cat <<'EOF'/);
});

test('hammer audit comment keeps model-authored markdown out of shell expansion', () => {
  assert.match(HAMMER_PROMPT, /HAM_AUDIT_COMMENT_DETAILS="\$\(cat "\$HAM_AUDIT_DETAILS_FILE"\)"/);
  assert.match(
    HAMMER_PROMPT,
    /HAM_AUDIT_COMMENT_BODY=\$\(printf[\s\S]*"\$HAM_AUDIT_COMMENT_DETAILS"[\s\S]*"\$POST_REMEDIATION_SHA"[\s\S]*"\$HAM_AUDIT_REMEDIATED_TOTAL"[\s\S]*"\$HAM_AUDIT_REMEDIATED_BLOCKING"[\s\S]*"\$HAM_AUDIT_REMEDIATED_NON_BLOCKING"\)/,
  );
});

test('hammer audit comment composes footer from validated inputs', () => {
  const bodyComposer = HAMMER_PROMPT.match(
    /HAM_AUDIT_COMMENT_BODY=\$\(printf[\s\S]*?"\$HAM_AUDIT_REMEDIATED_NON_BLOCKING"\)/,
  )?.[0];

  assert.ok(bodyComposer, 'expected to find the hammer audit comment composer');
  assert.doesNotMatch(bodyComposer, /<n>|<b>|<nb>/);
  assert.match(
    bodyComposer,
    /<sub>\\nHAM-Terminal-Remediation-Head: %s\\nRemediated-Findings: %s addressed \(%s blocking, %s non-blocking\)\\nClosed-By: hammer \(adversarial-pipe-mode\)\\n<\/sub>/,
  );
  assert.doesNotMatch(HAMMER_PROMPT, /HAM_AUDIT_REMEDIATED_TOTAL='<n>'/);
  assert.match(HAMMER_PROMPT, /ham_audit_is_nonnegative_int "\$\{HAM_AUDIT_REMEDIATED_TOTAL:-\}"/);
  assert.match(HAMMER_PROMPT, /HAM_AUDIT_REMEDIATED_BLOCKING \+ HAM_AUDIT_REMEDIATED_NON_BLOCKING/);
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
  const capabilityIdx = HAMMER_PROMPT.indexOf('merge_capability_enforcement');
  const mergeIdx = HAMMER_PROMPT.indexOf('gh pr merge <<PR_URL>>');
  assert.ok(auditIdx > 0, 'audit block present');
  assert.ok(rebaseLoopIdx > 0 && leaseAcquireIdx > 0, 'rebase window + lease acquire present');
  assert.ok(predicateIdx > 0 && capabilityIdx > 0 && mergeIdx > 0, 'predicate + capability guard + merge present');
  // Rebase window and lease acquisition come BEFORE the audit:
  assert.ok(rebaseLoopIdx < auditIdx, 'audit must follow the rebase window');
  assert.ok(leaseAcquireIdx < auditIdx, 'audit must follow lease acquisition');
  // Audit comes BEFORE the predicate and the merge:
  assert.ok(auditIdx < predicateIdx, 'audit must precede the ama-check predicate');
  assert.ok(predicateIdx < capabilityIdx, 'capability guard must follow the ama-check predicate');
  assert.ok(capabilityIdx < mergeIdx, 'capability guard must precede the merge');
  assert.ok(auditIdx < mergeIdx, 'audit must precede the merge');
  // And it fails closed unless the merge lease is currently held:
  assert.match(
    HAMMER_PROMPT,
    /terminal-remediation audit must be written while holding the merge lease/,
  );
});

test('hammer prompt reads the entitled hammer token from HAMMER_LACEY_GH_TOKEN (agent-os#4762 rename)', () => {
  // agent-os#4762 gave the-hammer-lacey entitlement a DISTINCT gh_token_var
  // (HAMMER_LACEY_GH_TOKEN) to stop the hammer inheriting the merge-agent's
  // MERGE_AGENT_GH_TOKEN identity. The worker-pool (acpx-codex.sh) exports the
  // entitled token under that var + ambient GH_TOKEN, and NOT under
  // MERGE_AGENT_GH_TOKEN. This prompt must resolve the audit-comment identity
  // token from the dedicated var (legacy fallback only), or the terminal audit
  // hard-blocks on every close (2026-08-04 merge-pipeline stall on #4874).
  assert.match(
    HAMMER_PROMPT,
    /HAM_GH_TOKEN="\$\{HAMMER_LACEY_GH_TOKEN:-\$\{MERGE_AGENT_GH_TOKEN:-\}\}"/,
  );
  // The audit-comment gh calls + presence guard use the resolved HAM_GH_TOKEN,
  // never a bare MERGE_AGENT_GH_TOKEN (which is absent in the hammer env).
  assert.doesNotMatch(HAMMER_PROMPT, /GH_TOKEN="\$MERGE_AGENT_GH_TOKEN"/);
  assert.doesNotMatch(HAMMER_PROMPT, /\[ -z "\$\{MERGE_AGENT_GH_TOKEN:-\}" \]/);
  assert.match(HAMMER_PROMPT, /if \[ -z "\$\{HAM_GH_TOKEN:-\}" \]; then/);
  assert.ok(
    (HAMMER_PROMPT.match(/GH_TOKEN="\$HAM_GH_TOKEN" gh /g) || []).length >= 3,
    'all three audit-comment gh calls (lookup, PATCH, comment) must use HAM_GH_TOKEN',
  );
});

test('hammer never moves a submodule pointer: re-syncs checkouts and unstages gitlinks (SUBSYNC-01, agent-os#7092)', () => {
  // A rebase/update-branch moves the gitlink but not the submodule checkout, and
  // `.gitmodules` `ignore = all` hides the stale checkout; agent-os#7092 carried
  // two HAM commits that rewound tools/adversarial-review that way.
  const commitBlock = HAMMER_PROMPT.slice(
    HAMMER_PROMPT.indexOf('Commit the remediation:'),
    HAMMER_PROMPT.indexOf('git commit -m "HAM remediate final adversarial findings"'),
  );
  assert.match(commitBlock, /alarm shift; exec @ARGV' 120 git submodule update --recursive/);
  assert.match(commitBlock, /git status --short --ignore-submodules=none/);
  assert.match(commitBlock, /git diff --cached --raw -z --ignore-submodules=none/);
  assert.match(commitBlock, /\$old_mode eq "160000" \|\| \$new_mode eq "160000"/);
  assert.match(
    commitBlock,
    /git restore --staged --pathspec-from-file="\$HAM_STAGED_GITLINKS_FILE" --pathspec-file-nul/,
  );
  assert.match(commitBlock, /staged submodule gitlink change\(s\) remain after unstage attempt/);
  assert.doesNotMatch(commitBlock, /awk '\$2 == "160000"/);
  assert.doesNotMatch(commitBlock, /print \$NF/);
  assert.ok(
    commitBlock.indexOf('git submodule update --recursive') < commitBlock.indexOf('git add <changed files>'),
    'submodules must be re-synced before staging',
  );

  const conflictBlock = HAMMER_PROMPT.slice(HAMMER_PROMPT.indexOf('## Resolving merge conflicts'));
  const rebaseAt = conflictBlock.indexOf('if ! git rebase "origin/$BASE_BRANCH"; then');
  const pushAt = conflictBlock.indexOf('git push --force-with-lease');
  const syncAt = conflictBlock.indexOf('git submodule update --recursive');
  assert.ok(rebaseAt >= 0 && syncAt > rebaseAt && syncAt < pushAt, 'conflict rebase must re-sync submodules before pushing');
  assert.match(conflictBlock, /HAM_CONFLICT_SUBMODULE_SYNC_ATTEMPT=1/);
  // The conflict block may run in a fresh shell: the retry cap must default locally.
  assert.match(conflictBlock, /HAM_CONFLICT_SUBMODULE_SYNC_CAP="\$\{HAM_UPDATE_BRANCH_RETRY_CAP:-3\}"/);
  assert.match(conflictBlock, /-ge "\$HAM_CONFLICT_SUBMODULE_SYNC_CAP"/);
  assert.match(conflictBlock, /submodule update failed after conflict rebase; refusing force-push/);

  assert.match(HAMMER_PROMPT, /No submodule gitlink changes in HAM commits \(SUBSYNC-01, agent-os#7092\)/);
});

test('hammer staged gitlink guard unstages a staged submodule deletion with real git', (t) => {
  const { superproject } = createSuperprojectWithSpaceSubmodule(t);

  git(superproject, ['update-index', '--force-remove', '--', 'modules/review module']);

  assert.deepEqual(stagedGitlinkPaths(superproject), ['modules/review module']);

  runHammerStagedGitlinkGuard(superproject);

  assert.deepEqual(stagedGitlinkPaths(superproject), []);
  assert.equal(
    git(superproject, ['diff', '--cached', '--name-only', '--', 'modules/review module']).stdout,
    '',
  );
});

test('hammer staged gitlink guard preserves a staged submodule path containing spaces', (t) => {
  const { upstream, superproject, submodulePath } = createSuperprojectWithSpaceSubmodule(t);

  writeFileSync(join(upstream, 'README.md'), 'two\n');
  git(upstream, ['commit', '-q', '-am', 'second upstream']);
  const nextSha = git(upstream, ['rev-parse', 'HEAD']).stdout.trim();
  git(submodulePath, ['fetch', '-q', 'origin']);
  git(submodulePath, ['checkout', '-q', nextSha]);
  git(superproject, ['add', '--', 'modules/review module']);

  assert.deepEqual(stagedGitlinkPaths(superproject), ['modules/review module']);

  runHammerStagedGitlinkGuard(superproject);

  assert.deepEqual(stagedGitlinkPaths(superproject), []);
  assert.equal(
    git(superproject, ['diff', '--cached', '--name-only', '--', 'modules/review module']).stdout,
    '',
  );
});
