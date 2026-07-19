// merge-agent-prompt.mjs — merge-agent dispatch prompt builder (ARC-19 wave 2).
//
// Extracted verbatim from follow-up-merge-agent.mjs: `shellSingleQuote`
// (private, used only by the prompt builder) and `buildMergeAgentPrompt`. Pure
// string/template building — no I/O, no monolith imports. This is a leaf; the
// orchestration monolith imports FROM it, never the reverse.
//
// The three dispatch-trigger name constants live here as the single source of
// truth: buildMergeAgentPrompt branches on them, and follow-up-merge-agent.mjs
// imports (and re-exports) them for its dispatch-decision logic.

const FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER = 'final-pass-on-budget-exhausted';
const FINAL_PASS_BLOCKER_REMEDIATION_TRIGGER = 'final-pass-blocker-remediation';
const REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER = 'reviewer-timeout-exhausted';

function shellSingleQuote(value) {
  return `'${String(value ?? '').replaceAll("'", "'\\''")}'`;
}

function buildMergeAgentPrompt(job, { trigger = null } = {}) {
  const mergeRepoLiteral = shellSingleQuote(job.repo);
  const mergeBaseLiteral = shellSingleQuote(job.baseBranch);
  const mergePrLiteral = shellSingleQuote(job.prNumber);
  const lines = [
    '# Merge-Agent Dispatch',
    '',
    '## Preamble: abort if PR is no longer open',
    '',
    `Before doing ANY other work, run \`gh pr view ${mergePrLiteral} --repo ${mergeRepoLiteral} --json state,mergedAt,closedAt\` and inspect the result.`,
    '',
    '- If `state` is `"MERGED"` (operator-merged ahead of you) OR `state` is `"CLOSED"` (operator abandoned the PR): **abort this session immediately**. Do not check out the branch, do not run remediation, do not push commits, do not call `hq` adjudicate. Exit cleanly with a short stdout note like `merge-agent abort: PR state=<X> at session start; no work performed`.',
    '- If `state` is `"OPEN"`: proceed normally with the dispatch below.',
    '',
    'Rationale: the watcher applies the `merge-agent-dispatched` label when it dispatches you and removes it on cancel-on-merge. If you started before the watcher could cancel you (the cancel path is best-effort), this preamble is the second line of defense against wasting budget on a closed PR.',
    '',
    `- Repo: ${job.repo}`,
    `- PR: #${job.prNumber}`,
    `- Branch: ${job.branch}`,
    `- Base: ${job.baseBranch}`,
  ];
  if (job.headSha) {
    lines.push(`- Head SHA: ${job.headSha}`);
  }
  if (trigger) {
    lines.push(`- Dispatch trigger: ${trigger}`);
  }
  // Both automated-convergence triggers get the same triage-and-merge
  // contract: the budget-exhausted final pass (`Request changes` with the
  // round budget consumed) AND a clean verdict (`null` trigger = `Comment
  // only`/approved). They differ only in the final-pass safety-floor framing.
  // Before 2026-05-25 only the final pass carried this block, so a clean
  // verdict reached the merge-agent with NO instructions and the worker
  // defaulted to requesting another review (PR #898). operator-approved and
  // merge-agent-requested are operator-driven and keep their own label-scoped
  // semantics — they do NOT get this block.
  const isBlockerRemediationFinalPass = trigger === FINAL_PASS_BLOCKER_REMEDIATION_TRIGGER;
  const isZeroBlockerFinalPass = trigger === FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER;
  const isAutomatedConvergence = trigger === null
    || isBlockerRemediationFinalPass
    || isZeroBlockerFinalPass;
  if (isAutomatedConvergence) {
    const finalPassHasStandingBlockingFindings = isBlockerRemediationFinalPass;
    lines.push('');
    if (isBlockerRemediationFinalPass) {
      lines.push('## Mode: final-pass-blocker-remediation');
      lines.push('');
      lines.push(
        'The adversarial-review round budget for this PR is consumed and the'
        + ' latest reviewer verdict is still `Request changes` with standing'
        + ' blocking findings. This is the terminal AUTONOMOUS close: remediate'
        + ' ALL findings (blocking and non-blocking) under strict mode, get the'
        + ' rebased head green, and push. Your validated strict-mode remediation'
        + ' IS the merge authority — do NOT request a fresh adversarial review and'
        + ' do NOT wait for operator approval. NO fresh reviewer pass runs; the AMA'
        + ' daemon validates your HAM remediation evidence and MERGES on it after'
        + ' you exit. Only a genuinely unfixable structural blocker prevents the'
        + ' autonomous close.'
      );
    } else if (isZeroBlockerFinalPass) {
      lines.push('## Mode: final-pass-on-budget-exhausted');
      lines.push('');
      lines.push(
        'The adversarial-review round budget for this PR is consumed and the'
        + ' latest reviewer verdict is still `Request changes`. You are the'
        + ' final automated close; remediate final findings and merge once'
        + ' structural gates are green.'
      );
    } else {
      lines.push('## Mode: converge-and-merge');
      lines.push('');
      lines.push(
        'The latest reviewer verdict is non-blocking (`Comment only`/'
        + 'approved). The review pipeline has reached its natural end and this'
        + ' PR is ready to land. Converge it NOW — do not wait for any'
        + ' remaining review or remediation rounds.'
      );
    }
    lines.push('');
    if (finalPassHasStandingBlockingFindings) {
      lines.push(
        'Default action: REMEDIATE ALL FINDINGS, PUSH, AND HAND OFF FOR AUTONOMOUS'
        + ' MERGE. The latest review has standing blocking findings, so apply the'
        + ' blocking and non-blocking findings inline under strict mode, get the'
        + ' rebased head green, push the remediated head, and exit with'
        + ' `reReview.requested = true` / `awaiting-rereview` PURELY as the technical'
        + ' daemon-handoff signal — it does NOT request a fresh adversarial reviewer'
        + ' pass, and none runs. Do NOT merge this invocation yourself; the AMA'
        + ' daemon validates your HAM remediation evidence and MERGES the remediated'
        + ' head after you exit. Do NOT tell operators a review is pending — this is'
        + ' an autonomous terminal close.'
      );
    } else {
      lines.push(
        'Default action: MERGE. Another review round is a rare exception'
        + ' reserved for major in-PR refactors (see step 2) — it is NOT the'
        + ' cautious default. When in doubt, MERGE.'
      );
    }
    lines.push('');
    lines.push('## Full rescue mandate (hammer parity)');
    lines.push('');
    if (finalPassHasStandingBlockingFindings) {
      lines.push(
        'This is the end-of-budget blocker-remediation rescue — handle EVERYTHING'
        + ' an interactive codex rescue session would before the daemon merges,'
        + ' not just the review findings:'
      );
    } else {
      lines.push(
        'This is the end-of-budget rescue — handle EVERYTHING an interactive codex'
        + ' rescue session would before merging, not just the review findings:'
      );
    }
    lines.push(
      '- Green `main` is the bar: run the full test suite and fix EVERY failing'
      + ' test AND every red required check / CI job (lint, build, type-check),'
      + ' INCLUDING failures unrelated to this PR or pre-existing on `main`.'
      + ' Never merge past red. Fixing tests/CI (and the minimal production change'
      + ' a legitimately failing check proves is needed) is in scope; net-new'
      + ' FEATURE scope is not.'
    );
    lines.push(
      '- Rebase onto the latest `main` and confirm it holds (re-validate the full'
      + ' suite + required checks on the rebased head). If the rebase hits a merge'
      + ' conflict, RESOLVE it locally (fix the conflict markers preserving both'
      + ' sides, continue the rebase, force-push with lease) — do not abandon a'
      + ' conflict to the operator. Hard-block only a genuinely unsafe semantic'
      + ' conflict you cannot correctly settle.'
    );
    lines.push('- Leave the working tree clean; never merge a dirty head.');
    lines.push(
      '- Keep the canonical documentation surfaces current — this is in-scope'
      + ' doc-currency for the change you are landing, NOT net-new feature scope.'
      + ' If the diff changes any persistent store shape (a session-ledger'
      + ' `migrations/*.sql`, an `_ensure_*` schema backstop, a `CREATE TABLE` /'
      + ' `ALTER TABLE`, or any other store schema) and `docs/data-model/` exists'
      + ' in this repo, update the matching `docs/data-model/NN-*.md` domain doc'
      + ' (found via its `Source of truth:` header line) and the'
      + ' `docs/data-model/catalog.json` mirror to match, then run'
      + ' `node scripts/validate-data-model-catalog.mjs` (a red validator is a'
      + ' failing check). If the diff changes a module surface or behaviour and'
      + ' that module has a `modules/<name>/<name>-walkthrough.md`, update it too.'
      + ' Touch only the docs the change actually affects; never leave an in-repo'
      + ' data-model doc or module walkthrough stale. If this PR is a submodule'
      + ' change and the owed canonical doc lives only in a superproject, record'
      + ' the skipped superproject-doc obligation in the audit or closing comment'
      + ' with the changed files that created the obligation.'
    );
    if (finalPassHasStandingBlockingFindings) {
      lines.push(
        '- On a successful blocker-remediation pass, post a closing comment'
        + ' summarizing what was done (findings remediated, failing tests / CI'
        + ' fixed, rebase / conflict handling, and doc-currency work or skipped'
        + ' superproject-doc obligations). This is the human-visible audit trail'
        + ' of an autonomous close.'
      );
    } else {
      lines.push(
        '- On a successful merge, post a closing comment summarizing what was done'
        + ' (findings remediated, failing tests / CI fixed, rebase / conflict'
        + ' handling, and doc-currency work or skipped superproject-doc obligations).'
        + ' This is the human-visible audit trail of an autonomous close.'
      );
    }
    lines.push('');
    lines.push('Required behavior:');
    lines.push(
      '1. Run `comment_only_followups.py` (your existing sub-worker triage'
      + ' step) against the latest review body. Apply every actionable'
      + ' in-scope finding inline — including non-blocking and suggested-fix'
      + ' comments. Use `suggestions_unable_to_apply` only'
      + ' for findings that genuinely should not be completed inside this'
      + ' PR (multi-PR scope, cross-module refactors, or conflicts with PR'
      + ' intent). For each such follow-up, file a Linear ticket before'
      + ' proceeding; do not leave the work only as prose in a PR comment'
      + ' and do not stop the PR merely because follow-up work exists.'
      + ' Refuse to merge if any blocker-class finding remains (data'
      + ' corruption, secret leakage, security regression, broken external'
      + ' contract). For non-empty'
      + ' `blockers_observed`, the refusal receipt/log summary must include'
      + ' only the blocker count plus normalized blocker kinds. Keep detailed'
      + ' blocker payloads exclusively in the workspace-local'
      + ' `.adversarial-follow-up/followups-reply.json` artifact; never copy'
      + ' blocker summaries, reasoning, quoted secrets, or sample payloads'
      + ' into PR comments, stdout/stderr summaries, or merge receipts.'
    );
    if (finalPassHasStandingBlockingFindings) {
      lines.push(
        '2. Apply the blocking and non-blocking findings inline under strict mode,'
        + ' then rebase, force-push the updated head, and exit with'
        + ' `reReview.requested = true` / `awaiting-rereview` PURELY as the technical'
        + ' daemon-handoff signal. This does NOT request a fresh adversarial reviewer'
        + ' pass and none runs: your validated strict-mode HAM remediation IS the'
        + ' merge authority. Do NOT merge this invocation yourself and do NOT call'
        + ' `gh pr merge` — the agent-os/adversarial-gate status can only turn green'
        + ' after this worker exits and the AMA daemon validates your HAM audit'
        + ' trail, and the daemon then MERGES the remediated head on that evidence.'
        + ' (This supersedes the old PR #901 rule that kept blocker remediation'
        + ' gated on a fresh external adversarial verdict.) The only non-merge exit'
        + ' on this terminal pass is a hard-stop with handoff_required=true when a'
        + ' genuinely unfixable structural blocker remains after remediation (data'
        + ' corruption, secret leakage, security regression, or broken external'
        + ' contract, plus unresolvable conflict or red required checks that cannot'
        + ' be made green). A non-empty `blockers_observed` result in this invocation'
        + ' must hard-refuse immediately.'
      );
    } else {
      lines.push(
        '2. Default to MERGE. When triage returns `no-followups-needed`, or'
        + ' returns `addressed` after you make the fixes, rebase, force-push the'
        + ' updated head, let `gh pr merge --auto` wait for required GitHub checks'
        + ' and branch protection on that pushed head, then MERGE (`gh pr merge'
        + ' --squash --auto`). Do NOT use'
        + ' `--admin` for this standard merge path; GitHub must still enforce'
        + ' required checks at merge time. Do NOT request'
        + ' another'
        + ' review for light, medium, or even substantial-but-bounded fixes —'
        + ' force-push and merge those directly. Set `reReview.requested = true`'
        + ' (exit `awaiting-rereview`) only for major in-PR refactors whose'
        + ' review risk genuinely demands a fresh adversarial pass. That is'
        + ' rare. The following are NEVER major in-PR refactors and MUST merge without'
        + ' re-review — a single- or few-file change; any test or test-fixture'
        + ' edit; a config, doc, or comment tweak; applying reviewer'
        + ' suggestions; renames; small bugfixes; or any change confined to the'
        + ' area the review already covered. When you are weighing whether a'
        + ' change is "major enough" to re-review, it probably is not — MERGE it. If'
        + ' remaining refactor work belongs across modules or future PRs, file'
        + ' the Linear tickets described above and MERGE this PR instead of'
        + ' using `awaiting-rereview` or stopping the PR. A non-empty'
        + ' `blockers_observed` result must hard-refuse the merge.'
      );
      if (isZeroBlockerFinalPass) {
        lines.push(
          'Merge gate for the rebase-to-merge step only: after remediation is'
          + ' complete and you are ready to rebase for merge, acquire the'
          + ' blocking merge lease before rebasing. Run the entire'
          + ' rebase/validation/merge sequence from this single shell script;'
          + ' it passes that shell pid as `--owner-pid "$$"` and releases the'
          + ' lease through the EXIT trap on every path after acquisition:'
        );
        lines.push('');
        lines.push('```bash');
        lines.push('set -euo pipefail');
        lines.push(`MERGE_REPO=${mergeRepoLiteral}`);
        lines.push(`MERGE_BASE=${mergeBaseLiteral}`);
        lines.push(`MERGE_PR=${mergePrLiteral}`);
        lines.push('MERGE_HEAD_REF=$(gh pr view "$MERGE_PR" --repo "$MERGE_REPO" --json headRefName --jq \'.headRefName\')');
        lines.push('POST_REMEDIATION_SHA=$(git rev-parse HEAD)');
        lines.push('MERGE_GATE_ATTEMPT_HEAD="$POST_REMEDIATION_SHA"');
        lines.push('MERGE_LEASE_JSON=$(mktemp)');
        lines.push('MERGE_REVALIDATION_JSON=$(mktemp)');
        lines.push('MERGE_LEASE_ID=""');
        lines.push('cleanup_merge_lease() {');
        lines.push('  status=$?');
        lines.push('  if [ -n "${MERGE_LEASE_ID:-}" ]; then');
        lines.push('    node bin/merge-lease.mjs release --repo "$MERGE_REPO" --base "$MERGE_BASE" --pr "$MERGE_PR" --lease-id "$MERGE_LEASE_ID" || true');
        lines.push('  fi');
        lines.push('  rm -f "$MERGE_LEASE_JSON" "$MERGE_REVALIDATION_JSON"');
        lines.push('  exit "$status"');
        lines.push('}');
        lines.push('trap cleanup_merge_lease EXIT');
        lines.push('');
        lines.push('set +e');
        lines.push('node bin/merge-lease.mjs acquire --repo "$MERGE_REPO" --base "$MERGE_BASE" --pr "$MERGE_PR" --head "$MERGE_GATE_ATTEMPT_HEAD" --owner-pid "$$" --wait 300 > "$MERGE_LEASE_JSON"');
        lines.push('MERGE_LEASE_EXIT=$?');
        lines.push('set -e');
        lines.push('if [ "$MERGE_LEASE_EXIT" -eq 70 ] && jq -e \'.parked == true\' "$MERGE_LEASE_JSON" >/dev/null; then');
        lines.push('  PARK_REASON=$(jq -r \'.reason // "merge-gate-parked"\' "$MERGE_LEASE_JSON")');
        lines.push('  echo "merge gate parked PR: $PARK_REASON" >&2');
        lines.push('  # Stop merge attempts and park/escalate with the emitted reason.');
        lines.push('  exit 70');
        lines.push('fi');
        lines.push('if [ "$MERGE_LEASE_EXIT" -ne 0 ]; then');
        lines.push('  exit "$MERGE_LEASE_EXIT"');
        lines.push('fi');
        lines.push('MERGE_LEASE_ID=$(jq -r \'.leaseId\' "$MERGE_LEASE_JSON")');
        lines.push('');
        lines.push('# While holding the lease, rebase onto the latest base and validate the exact rebased head.');
        lines.push('# If rebase or validation fails, exit non-zero here; the EXIT trap releases the lease.');
        lines.push('git fetch --prune origin "$MERGE_BASE" "$MERGE_HEAD_REF"');
        lines.push('VALIDATION_BASE=$(git rev-parse --verify "origin/$MERGE_BASE^{commit}")');
        lines.push('git rebase "$VALIDATION_BASE"');
        lines.push('# Run the project validation required for this PR here, against the rebased head.');
        lines.push('git fetch --prune origin "$MERGE_BASE"');
        lines.push('CURRENT_BASE=$(git rev-parse --verify "origin/$MERGE_BASE^{commit}")');
        lines.push('POST_REMEDIATION_SHA=$(git rev-parse HEAD)');
        lines.push('git push --force-with-lease origin "HEAD:$MERGE_HEAD_REF"');
        lines.push('');
        lines.push('set +e');
        lines.push('node bin/merge-lease.mjs needs-revalidation --repo-path "$PWD" --base "$MERGE_BASE" --validation-base "$VALIDATION_BASE" --current-base "$CURRENT_BASE" --changed-files-from "$POST_REMEDIATION_SHA" > "$MERGE_REVALIDATION_JSON"');
        lines.push('MERGE_REVALIDATION_EXIT=$?');
        lines.push('set -e');
        lines.push('if [ "$MERGE_REVALIDATION_EXIT" -ne 0 ]; then');
        lines.push('  echo "merge revalidation failed; escalate instead of retrying the same invocation" >&2');
        lines.push('  exit "$MERGE_REVALIDATION_EXIT"');
        lines.push('fi');
        lines.push('if ! jq -e \'.needsRevalidation == false\' "$MERGE_REVALIDATION_JSON" >/dev/null; then');
        lines.push('  if ! jq -e \'.needsRevalidation == true\' "$MERGE_REVALIDATION_JSON" >/dev/null; then');
        lines.push('    echo "merge revalidation returned an unrecognized decision; escalate" >&2');
        lines.push('    exit 64');
        lines.push('  fi');
        lines.push('  # Base moved with overlapping risk; restart rebase/validation under a fresh lease.');
        lines.push('  exit 75');
        lines.push('fi');
        lines.push('');
        lines.push('gh pr merge "$MERGE_PR" --repo "$MERGE_REPO" --squash --auto --match-head-commit "$POST_REMEDIATION_SHA"');
        lines.push('```');
      }
    }
    if (isBlockerRemediationFinalPass || isZeroBlockerFinalPass) {
      if (finalPassHasStandingBlockingFindings) {
        lines.push(
          '3. This is the single terminal automatic close for this PR. Do not'
          + ' request another blocker-remediation loop and do not request a fresh'
          + ' adversarial review. The successful terminal action is: remediate all'
          + ' findings under strict mode, push, and hand off (via'
          + ' `reReview.requested = true` / `awaiting-rereview` as the daemon signal)'
          + ' for the AMA daemon to validate the HAM evidence and MERGE. The only'
          + ' hard-stop is the unfixable-blocker handoff above (an UNremediated'
          + ' blocker-class finding, or CI that cannot be made green); a remediated'
          + ' blocking finding is not a hard-stop.'
        );
      } else {
        lines.push(
          '3. Treat this dispatch the same way you would treat an'
          + ' `operator-approved` dispatch for review/remediation state, EXCEPT'
          + ' that the safety floor (no blocker-class merges) is stricter:'
          + ' the operator did not personally vouch for this head.'
        );
      }
    }
    if (trigger === REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER) {
      lines.push(
        '3. This dispatch is a reviewer-timeout exhaustion recovery. A'
        + ' remediation round completed and requested re-review, but the'
        + ' reviewer timed out before posting after the retry budget. Do not'
        + ' treat the missing fresh review as approval. Rebase/resolve the'
        + ' branch, run the relevant validation, address any still-actionable'
        + ' findings from the last posted review if they remain true, and'
        + ' merge only when the PR is clean. If the branch cannot be made'
        + ' mergeable inside this pass, stop with a clear blocker instead of'
        + ' leaving the PR behind a green-ish timeout gate.'
      );
    }
  }
  if (job.operatorNotes) {
    lines.push('- Operator notes from PR body:');
    lines.push(job.operatorNotes);
  } else {
    lines.push('- Operator notes from PR body: none');
  }
  return `${lines.join('\n')}\n`;
}

export {
  FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER,
  FINAL_PASS_BLOCKER_REMEDIATION_TRIGGER,
  REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER,
  buildMergeAgentPrompt,
};
