// PR comment poster for the remediation pipeline.
//
// Every terminal reconcile transition (completed / stopped / failed) emits a
// public PR comment so the conversation stays in GitHub instead of in
// `data/follow-up-jobs/*` JSON. Without this, an automated remediation cycle
// is invisible to anyone reading the PR — they see the original "Request
// changes" review and no evidence the system tried to address it.
//
// Identity: the comment posts under the worker's matching reviewer-bot PAT
// (claude-code worker → `GH_CLAUDE_REVIEWER_TOKEN`,
//  codex worker → `GH_CODEX_REVIEWER_TOKEN`). The body header always names
// "Remediation Worker (<class>)" so the actual role is unambiguous even
// though the GitHub identity says "...-reviewer-lacey".
//
// Failure mode: posting is best-effort. If `gh pr comment` fails, we log
// and return — the reconcile state transition still completes. A missed
// comment is recoverable; blocking the transition on a network blip would
// leave the queue stuck.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Worker class → bot-token env var. Add an entry here when a new
// remediation worker class lands; the absence of an entry causes
// `postRemediationOutcomeComment` to skip posting (with a clear log
// message) rather than crash the reconcile path.
const WORKER_CLASS_TO_BOT_TOKEN_ENV = {
  codex: 'GH_CODEX_REVIEWER_TOKEN',
  'claude-code': 'GH_CLAUDE_REVIEWER_TOKEN',
};

function resolveCommentBotTokenEnv(workerClass) {
  return WORKER_CLASS_TO_BOT_TOKEN_ENV[workerClass] || null;
}

function formatBulletList(items, emptyText = '_(none reported)_') {
  const list = Array.isArray(items) ? items.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (!list.length) return emptyText;
  return list.map((s) => `- ${s.trim()}`).join('\n');
}

function buildRemediationOutcomeCommentBody({
  workerClass,
  action,
  job,
  reply = null,
  reReview = null,
  failure = null,
}) {
  const round = Number(job?.remediationPlan?.currentRound || 0) || 1;
  const maxRounds = Number(job?.remediationPlan?.maxRounds || 0) || null;
  const roundLabel = maxRounds ? `${round} of ${maxRounds}` : String(round);
  const headerClass = workerClass || 'unknown';
  const lines = [];

  lines.push(`### Remediation Worker (${headerClass}) — round ${roundLabel}`);
  lines.push('');

  if (action === 'completed') {
    // The completed action is gated on rereview acceptance in
    // reconcileFollowUpJob, so by the time we render here we know the
    // rereview either was accepted (status='pending', triggered=true)
    // or was already pending (status='already-pending'). Both mean a
    // fresh adversarial pass is queued; word the comment to match.
    const rrStatus = reReview?.status;
    const queuedNote = rrStatus === 'already-pending'
      ? 're-review already pending — no reset needed'
      : 're-review queued';
    lines.push(`**Outcome:** \`${reply?.outcome || 'completed'}\` — ${queuedNote}.`);
  } else if (action === 'stopped') {
    const stopCode = job?.remediationPlan?.stop?.code || 'no-progress';
    lines.push(`**Outcome:** stopped (\`${stopCode}\`).`);
    if (stopCode === 'rereview-blocked') {
      const blockedReason = reReview?.outcomeReason || reReview?.status || 'unknown';
      lines.push('');
      lines.push(
        `> **Human intervention required.** The worker requested a re-review pass, but the watcher refused the reset (\`${blockedReason}\`). The PR's existing adversarial-review verdict will not be replaced. Inspect the review ledger and either re-open the PR / restore the review row / clear the malformed-title state, then re-arm with \`npm run retrigger-review\`.`
      );
    } else if (stopCode === 'max-rounds-reached') {
      lines.push('');
      lines.push(
        '> **Human intervention required.** The remediation loop exhausted its bounded round cap without converging. Review the changes by hand, decide whether to re-arm or close.'
      );
    } else if (reply && reply.outcome === 'blocked') {
      lines.push('');
      lines.push(
        '> **Human intervention required.** The worker reported blockers it could not resolve in this round. See the blockers list below.'
      );
    } else {
      lines.push('');
      lines.push(
        '> The worker did not request a re-review pass; this PR will retain its current adversarial-review verdict until a human re-arms or closes the job.'
      );
    }
  } else if (action === 'failed') {
    lines.push(`**Outcome:** failed.`);
    lines.push('');
    if (failure?.message) {
      lines.push(`Reason: \`${failure.message}\``);
    } else if (failure?.code) {
      lines.push(`Reason: \`${failure.code}\``);
    } else {
      lines.push('Reason: unknown — check the daemon logs.');
    }
    lines.push('');
    lines.push(
      '> **Human intervention required.** The worker did not produce a usable remediation reply. Inspect `data/follow-up-jobs/failed/` for the job record and the worker logs.'
    );
  }

  if (reply?.summary) {
    lines.push('');
    lines.push('**Summary**');
    lines.push('');
    lines.push(String(reply.summary).trim());
  }

  if (reply?.validation?.length) {
    lines.push('');
    lines.push('**Validation run**');
    lines.push('');
    lines.push(formatBulletList(reply.validation));
  }

  if (reply?.blockers?.length) {
    lines.push('');
    lines.push('**Blockers**');
    lines.push('');
    lines.push(formatBulletList(reply.blockers));
  }

  // Surface the actual rereview outcome (not just the worker's request bit)
  // so the comment never claims "queued" when the watcher refused the reset.
  // Possible reReview shapes (see buildRereviewResult in
  // follow-up-remediation.mjs):
  //   - requested=false                                    → no rereview
  //   - requested=true, triggered=true                     → accepted
  //   - requested=true, status='already-pending'           → benign no-op (review already coming)
  //   - requested=true, triggered=false, status='blocked'  → refused
  lines.push('');
  if (!reReview?.requested) {
    if (action === 'completed' || action === 'stopped') {
      lines.push('**Re-review requested:** no');
    }
  } else if (reReview.triggered) {
    lines.push(`**Re-review status:** queued${reReview.reason ? ` — ${reReview.reason}` : ''}`);
  } else if (reReview.status === 'already-pending') {
    lines.push(`**Re-review status:** already pending${reReview.reason ? ` — ${reReview.reason}` : ''}`);
  } else {
    const blockedReason = reReview.outcomeReason || reReview.status || 'unknown';
    lines.push(`**Re-review status:** **BLOCKED** (\`${blockedReason}\`)${reReview.reason ? ` — worker reason: ${reReview.reason}` : ''}`);
  }

  lines.push('');
  lines.push(
    `_Posted automatically by the adversarial-review remediation pipeline. Job: \`${job?.jobId || 'unknown'}\`._`
  );

  return lines.join('\n');
}

async function postRemediationOutcomeComment({
  repo,
  prNumber,
  workerClass,
  body,
  execFileImpl = execFileAsync,
  env = process.env,
  log = console,
}) {
  if (!repo || !prNumber) {
    log.error?.('[pr-comments] skipping comment: missing repo or prNumber');
    return { posted: false, reason: 'missing-pr-coordinates' };
  }

  const tokenEnvName = resolveCommentBotTokenEnv(workerClass);
  if (!tokenEnvName) {
    log.error?.(
      `[pr-comments] skipping comment: no bot-token env mapping for worker class "${workerClass}"`
    );
    return { posted: false, reason: 'no-token-mapping', workerClass };
  }

  const token = env[tokenEnvName];
  if (!token) {
    log.error?.(
      `[pr-comments] skipping comment: ${tokenEnvName} not set in env (worker class "${workerClass}")`
    );
    return { posted: false, reason: 'token-env-missing', tokenEnvName, workerClass };
  }

  try {
    await execFileImpl(
      'gh',
      ['pr', 'comment', String(prNumber), '--repo', repo, '--body', body],
      {
        env: { ...env, GH_TOKEN: token },
        maxBuffer: 5 * 1024 * 1024,
      }
    );
    return { posted: true, repo, prNumber, workerClass, tokenEnvName };
  } catch (err) {
    log.error?.(
      `[pr-comments] failed to post comment on ${repo}#${prNumber} (worker class "${workerClass}"): ${err.message}`
    );
    return { posted: false, reason: 'gh-cli-failure', error: err.message, repo, prNumber };
  }
}

export {
  WORKER_CLASS_TO_BOT_TOKEN_ENV,
  buildRemediationOutcomeCommentBody,
  postRemediationOutcomeComment,
  resolveCommentBotTokenEnv,
};
