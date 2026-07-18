// Reviewer prompt assembly.
//
// ARC-10: extracted from `reviewer.mjs` so prompt construction is a cohesive,
// harness-agnostic unit. The model-execution harness (`reviewer-harness.mjs`)
// imports these builders; `reviewer.mjs` re-exports them so its public surface
// is unchanged. This module carries no model-spawn or credential knowledge —
// only how the adversarial prompt, stage selection, and diff framing are built.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStagePrompt, pickReviewerStage, resolvePromptSet } from './kernel/prompt-stage.mjs';
import { loadDomainConfig } from './domain-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

// The reviewer's prompt set is sourced from the domain config
// (`domains/<id>.json` → `promptSet`), never a hardcoded literal. Resolution
// fails loud with a classified `PromptSetResolutionError` — there is no silent
// fallback to code-pr. The active domain id remains fixed to `code-pr` here
// (the sole registered reviewer domain); threading the domain id itself is a
// separate work item.
const REVIEWER_DOMAIN_ID = 'code-pr';
const REVIEWER_PROMPT_SET = resolvePromptSet({
  rootDir: ROOT,
  domainConfig: loadDomainConfig(ROOT, REVIEWER_DOMAIN_ID),
  domainId: REVIEWER_DOMAIN_ID,
});
const ADVERSARIAL_PROMPT = loadStagePrompt({
  rootDir: ROOT,
  promptSet: REVIEWER_PROMPT_SET,
  actor: 'reviewer',
  stage: 'first',
});

const ADVERSARIAL_PROMPT_FINAL_ROUND = loadStagePrompt({
  rootDir: ROOT,
  promptSet: REVIEWER_PROMPT_SET,
  actor: 'reviewer',
  stage: 'last',
});
const ADVERSARIAL_PROMPT_FINAL_ROUND_ADDENDUM = readFileSync(
  join(ROOT, 'prompts', REVIEWER_PROMPT_SET, 'reviewer.last.addendum.md'),
  'utf8',
).trim();

function buildReviewerPromptPrefix({
  isFinalRound = false,
  stage,
  reviewAttemptNumber,
  completedRemediationRounds,
  maxRemediationRounds,
} = {}) {
  const inferredCompletedRemediationRounds = completedRemediationRounds ?? (
    Number.isFinite(Number(reviewAttemptNumber)) ? Number(reviewAttemptNumber) - 1 : undefined
  );
  const selectedStage = stage || (
    isFinalRound
      ? 'last'
      : (reviewAttemptNumber !== undefined || completedRemediationRounds !== undefined || maxRemediationRounds !== undefined)
        ? pickReviewerStage({
            reviewAttemptNumber,
            completedRemediationRounds: inferredCompletedRemediationRounds,
            maxRemediationRounds,
          })
        : 'first'
  );

  return loadStagePrompt({
    rootDir: ROOT,
    promptSet: REVIEWER_PROMPT_SET,
    actor: 'reviewer',
    stage: selectedStage,
  });
}

function buildReviewerPrompt({ promptPrefix, extraContext = '', diff = '' } = {}) {
  return `${promptPrefix || ''}${extraContext}\n\n---\n\nHere is the PR diff to review:\n\n\`\`\`diff\n${diff}\`\`\``;
}

function buildPromptForReviewerModel(reviewerModel, diff, extraContext = '', { promptStage = 'first', runtime = null } = {}) {
  const model = String(reviewerModel || '').trim().toLowerCase();
  const promptPrefix = model === 'gemini' && runtime === 'antigravity'
    ? buildAgyReviewerPromptPrefix({ stage: promptStage })
    : buildReviewerPromptPrefix({ stage: promptStage });
  return buildReviewerPrompt({ promptPrefix, extraContext, diff });
}

// Compute whether the current review attempt is the final one allowed
// under the bounded remediation cap. Convention:
//   reviewAttemptNumber=1 = initial review, no remediation done yet
//   reviewAttemptNumber=N = N-1 remediation rounds completed
// So when reviewAttemptNumber > maxRemediationRounds, the reviewer is
// looking at the work after the last remediation cycle and there are
// no more rounds left to fix anything blocked here. That is the
// "lenient threshold" round.
function isFinalReviewRound({ reviewAttemptNumber, maxRemediationRounds }) {
  const attempt = Number(reviewAttemptNumber);
  const cap = Number(maxRemediationRounds);
  if (!Number.isFinite(attempt) || attempt <= 0) return false;
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return attempt > cap;
}

function buildAgyReviewerPromptPrefix({ stage }) {
  return `${buildReviewerPromptPrefix({ stage })}

Antigravity runtime instructions:
- This is a single-shot GitHub review. The PR diff and all needed context are already provided below.
- Review the PROVIDED diff. Do not re-list the repository, re-derive the diff with git, inspect unrelated files, or run exploratory filesystem/git commands.
- Use at most one narrowly targeted lookup only if the provided diff is insufficient to verify a concrete suspected bug. Otherwise use no tools.
- Emit ONLY the final Markdown review block for GitHub. Do not narrate your plan, tool calls, exploration steps, uncertainty, or internal reasoning.
- Start with "## Adversarial Review — Gemini (gemini-reviewer-lacey)" unless an outer caller already supplied that header.
- Include "## Verdict" with the first non-empty verdict line exactly one of: "Comment only", "Request changes", or "Approve".
- Verdict is a pure function of the structured Blocking issues list: if "## Blocking issues" is empty / "- None.", the Verdict MUST be "Comment only"; emit "Request changes" only when at least one blocking issue is listed. Non-blocking issues never escalate the verdict.`;
}

export {
  REVIEWER_DOMAIN_ID,
  REVIEWER_PROMPT_SET,
  ADVERSARIAL_PROMPT,
  ADVERSARIAL_PROMPT_FINAL_ROUND,
  ADVERSARIAL_PROMPT_FINAL_ROUND_ADDENDUM,
  buildReviewerPromptPrefix,
  buildReviewerPrompt,
  buildPromptForReviewerModel,
  isFinalReviewRound,
  buildAgyReviewerPromptPrefix,
};
