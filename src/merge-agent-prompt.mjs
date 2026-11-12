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

import { fileURLToPath } from 'node:url';
import { formatSimplicityNoteContext } from './prompt-context.mjs';

const FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER = 'final-pass-on-budget-exhausted';
const FINAL_PASS_BLOCKER_REMEDIATION_TRIGGER = 'final-pass-blocker-remediation';
const REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER = 'reviewer-timeout-exhausted';
// The hammer's terminal remediation is its own authorization: the closer commit
// carries `Closed-By` + `Reviewed-Head` (parented on the exact reviewed head) and
// its audit comment enumerates every reviewed finding as addressed, with the
// blocking count matching the review's. When AMA validates that ground truth but
// cannot dispatch its own closer, the merge-agent runs on this trigger instead of
// stalling on a verdict that suppression guarantees will never be posted.
const HAM_TERMINAL_REMEDIATION_CERTIFIED_TRIGGER = 'ham-terminal-remediation-certified';

function shellSingleQuote(value) {
  return `'${String(value ?? '').replaceAll("'", "'\\''")}'`;
}

function buildMergeAgentPrompt(job, { trigger = null } = {}) {
  const controllerHelper = shellSingleQuote(fileURLToPath(new URL('../bin/hammer-controller.mjs', import.meta.url)));
  const closeControllerScript = shellSingleQuote(fileURLToPath(new URL('../bin/merge-agent-close-controller.sh', import.meta.url)));
  const stackedBaseChecker = shellSingleQuote(fileURLToPath(new URL('../bin/stacked-base-check.mjs', import.meta.url)));
  const stackedBaseRoot = shellSingleQuote(fileURLToPath(new URL('..', import.meta.url)));
  const ciCostChecker = shellSingleQuote(fileURLToPath(new URL('../bin/ci-cost-check.mjs', import.meta.url)));
  const mergeRepoLiteral = shellSingleQuote(job.repo);
  const mergeBaseLiteral = shellSingleQuote(job.baseBranch);
  const mergePrLiteral = shellSingleQuote(job.prNumber);
  const terminalAuditHelper = shellSingleQuote(fileURLToPath(new URL('../bin/ama-audit.mjs', import.meta.url)));
  const lines = [
    '# Merge-Agent Dispatch',
    '',
    'This launch requires a terminal AMA audit tied to HQ_LAUNCH_REQUEST_ID. Before exit, record the actual result (succeeded only after confirmed merge, otherwise failed-without-merge or deferred) using the deployed helper:',
    `node ${terminalAuditHelper} append --hq-root "$HQ_ROOT" --repo ${mergeRepoLiteral} --pr ${mergePrLiteral} --head ${shellSingleQuote(job.headSha)} --outcome OUTCOME`,
    'Include a fixed reason code in --attempt-json for a no-merge result; never include credentials or raw transport output.',
    '',
    '## Preamble: abort if PR is no longer open',
    '',
    `Before doing ANY other work, run \`gh pr view ${mergePrLiteral} --repo ${mergeRepoLiteral} --json state,mergedAt,closedAt\` and inspect the result.`,
    '',
    '- If `state` is `"MERGED"` (operator-merged ahead of you) OR `state` is `"CLOSED"` (operator abandoned the PR): **abort this session immediately**. Do not check out the branch, do not run remediation, do not push commits, do not call `hq` adjudicate. Exit cleanly with a short stdout note like `merge-agent abort: PR state=<X> at session start; no work performed`.',
    '- If `state` is `"OPEN"`: proceed normally with the dispatch below.',
    `Before remediation and immediately before every merge, run \`node ${stackedBaseChecker} ${stackedBaseRoot} ${mergeRepoLiteral} ${mergePrLiteral}\`. On refusal stop: stacked-base-merged requires a rebase onto the default branch and a retarget; stacked-base-read-failed requires a later retry. Never retarget or force-push automatically.`,
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
  const simplicityContext = formatSimplicityNoteContext(job.simplicityNote, 'existing closing audit text');
  if (simplicityContext) lines.push(simplicityContext);
  lines.push('', '## CI-cost hard gate (CIGUARD-01)',
    `Before every merge, resolve the live head and run \`node ${ciCostChecker} ${mergeRepoLiteral} ${mergePrLiteral} HEAD_SHA\`. Refuse a failed check or unauthorized workflow cost growth. Only a live ci-cost-approved label applied by a configured human operator authorizes cost growth; operator-approved never waives this gate. On refusal, leave the PR open for authorization and a CI rerun.`, '');
  if (job.ciBootstrap?.mode === 'no-ci-bootstrap') {
    const checker = shellSingleQuote(fileURLToPath(new URL('../bin/ci-bootstrap.mjs', import.meta.url)));
    lines.push('', '## Explicit no-CI bootstrap',
      'CI mode: no-ci-bootstrap. This head has API-confirmed absence of workflows and required-check rules, plus a green managed pre-push attestation verified under the deployment hosting mode.',
      `Immediately before merge, run \`node ${checker} --repo ${mergeRepoLiteral} --pr ${mergePrLiteral} --head ${shellSingleQuote(job.headSha)}\`. Abort if this fails.`,
      'For this exact verified head only, the bootstrap evidence satisfies the CI check. Preserve every other merge gate, including settled clean review or HAM certification, merge lease, safety-core, and autonomous execution kill switch.',
      `Merge with \`--match-head-commit ${shellSingleQuote(job.headSha)}\`. Record \`ciMode: no-ci-bootstrap\` in the merge audit and closure comment. If you push another head, bootstrap authorization expires; revalidate the review and CI evidence before merging.`, '');
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
      + ' that module has a `modules/<name>/<name>-walkthrough.md`, a'
      + ' `<module dir>/changes/<TICKET-ID>.md` fragment plus any needed in-place'
      + ' walkthrough/README section edits satisfies walkthrough currency.'
      + ' Create the fragment when the author omitted it, or update the existing fragment.'
      + ' Resolve `<TICKET-ID>` from the PR body’s `## Ticket` section, falling back to an'
      + ' unambiguous ticket identifier in the PR title or head branch. Never use the'
      + ' closer’s own `Worker-Ticket: HAM` as the fragment ticket. If no ticket can be'
      + ' identified, record the missing identifier in the audit rather than inventing one.'
      + ' Reviewers accept the fragment; the walkthrough need not change when its'
      + ' existing text needs no correction. Follow `docs/walkthroughs/README.md` when available.'
      + ' If that guide is absent, include Summary, Interface changes (or none), and'
      + ' Verification with commands and observed results; explain the operational change rather than leave an empty fragment.'
      + ' Do not append ticket sections to walkthroughs or READMEs or shared README change-note entries.'
      + ' An end-of-file ticket section is at most a non-blocking style note, never a blocking finding.'
      + ' This adds no blocking condition.'
      + " Follow the target repository's AGENTS.md change-note convention for"
      + ' repository-level notes; accept its per-ticket records without requesting a'
      + ' shared root README entry. This does not replace required in-place canonical'
      + ' contract corrections.'
      + " If the diff changes an owner's lifecycle states, transitions, durable status values,"
      + ' smoke-verified promises or post-deploy verification steps, and that owner'
      + ' declares `state-machines.json` and/or `post-merge-verify.json` beside its README,'
      + " update the affected declarations and the README's state/smoke section, plus the"
      + ' smoke harness when a verified promise changed. Regenerate any committed generated state index'
      + ' if the repository has one (for example `docs/architecture/STATE-MACHINES.md`);'
      + ' regenerate from merged declarations after conflicts. Missing updates are blocking contract drift,'
      + ' like stale data-model docs. Only update owners the change actually affects.'
      + ' Owners with no declarations yet need not add them in an unrelated PR; at most a non-blocking note.'
      + ' Touch only the docs the change actually affects; never leave an in-repo'
      + ' data-model doc, module walkthrough or state/smoke declaration stale. If this PR is a submodule'
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
        lines.push('First create a private run directory in the calling shell. Preserve the inherited HQ launch/spawn markers.');
        lines.push('```bash');
        lines.push(`export HAM_REPO=${mergeRepoLiteral} HAM_PR_NUMBER=${mergePrLiteral} HAM_ROOT_DIR=${stackedBaseRoot}`);
        lines.push('export HAM_RUN_DIR=$(mktemp -d)');
        lines.push('```');
        // HAMCONTROLLERSCRIPT-01: the rebase/validation/merge controller is
        // shipped code. The model writes only data and runs one command.
        lines.push(
          'Merge gate for the rebase-to-merge step only: after remediation is'
          + ' complete and you are ready to rebase for merge, run the shipped close'
          + ' controller below. Never write controller shell, read `/dev/tty` or'
          + ' stdin, or run a detached ad hoc shell. Under the launch-bound'
          + ' controller it acquires the blocking merge lease for its own shell pid'
          + ' before rebasing, rebases onto the latest base, runs your validation'
          + ' commands against the rebased head, pushes with --force-with-lease,'
          + ' checks revalidation, protective predecessors and CI cost, then merges'
          + ' with `--match-head-commit` on the validated head (never `--admin`).'
          + ' Its EXIT trap releases the lease on every path after acquisition.'
        );
        lines.push(
          'First write the validation commands as data to "$HAM_RUN_DIR/close-commands.json".'
          + ' Each entry runs as `hammer-validate.mjs [--pytest] -- <args>`'
          + ' (pytest: test paths; otherwise the command argv), with its unscaled'
          + ' 120s no-output bound and load-scaled ceiling:'
        );
        lines.push('```json');
        lines.push('{"validations": [{"pytest": true, "args": ["tests/test_example.py"]}]}');
        lines.push('```');
        lines.push('Then run this ONE command in the foreground from the same calling shell. The controller records group drain independently of HQ terminal status and only releases a matching owned lease. Exit 65 means the commands file is invalid: correct it once and rerun; 70 parked, 75 retry later, other nonzero escalate.');
        lines.push('```bash');
        lines.push(`node ${controllerHelper} run ${closeControllerScript} --repo ${mergeRepoLiteral} --base ${mergeBaseLiteral} --pr ${mergePrLiteral} --commands "$HAM_RUN_DIR/close-commands.json"`);
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
  HAM_TERMINAL_REMEDIATION_CERTIFIED_TRIGGER,
  buildMergeAgentPrompt,
};
