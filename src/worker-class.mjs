// Canonical worker-class resolution.
//
// Shared by the consume path (`follow-up-remediation.mjs`), the
// reconcile path (`follow-up-remediation.mjs`), and the comment-delivery
// recovery path (`comment-delivery.mjs`) so a single rule decides which
// remediation-worker / bot-token identity owns a given job. Lives in its
// own module to avoid an import cycle between comment-delivery (which
// needs the resolver to reconstruct lost deliveries) and
// follow-up-remediation (which already imports from comment-delivery).
//
// Why this matters: PR #18 R7 #2 caught the comment-delivery recovery
// path silently re-introducing the `clio-agent → no-token-mapping` bug
// the reconcile path had just been fixed for, because each call site
// open-coded its own mapping. Shipping the resolver as a shared symbol
// means new call sites cannot drift.

import { WORKER_CLASS_TO_BOT_TOKEN_ENV } from './pr-comments.mjs';

// Map a job to the remediation worker class that should handle it. The
// cross-model rule is: the BUILDER fixes their own code.
//
// Routing is keyed off the durable builder tag persisted on the job at
// creation time:
//   builderTag='codex'       → codex remediator
//   builderTag='claude-code' → claude-code remediator
//   builderTag='clio-agent'  → codex remediator (Clio sub-agent PRs are
//                              not the same operational entity as the
//                              local Claude Code CLI, so they fall back
//                              to codex remediation; aligns with the
//                              SPEC fallback rule.)
//
// Reverse-mapping from `reviewerModel` is unsafe: both [claude-code] and
// [clio-agent] PRs are reviewed by codex, so reviewerModel='codex' alone
// cannot distinguish them. We only consult `reviewerModel` for legacy
// job records (created before builderTag was persisted), and even then
// only `reviewerModel='claude'` reliably implies a [codex] builder.
function pickRemediationWorkerClass(job) {
  const builderTag = job?.builderTag;
  if (builderTag) {
    switch (builderTag) {
      case 'codex':
        return 'codex';
      case 'claude-code':
        return 'claude-code';
      case 'clio-agent':
        // No dedicated clio-agent worker class today — fall back to the
        // SPEC's documented default reviewer/remediator: codex.
        return 'codex';
      default:
        return 'codex';
    }
  }

  // Legacy fallback for jobs created before builderTag was persisted.
  // claude reviewer unambiguously implies a codex builder. codex reviewer
  // is ambiguous between [claude-code] and [clio-agent], so fall back to
  // codex (the SPEC-documented default) rather than guessing claude-code.
  if (job?.reviewerModel === 'claude') {
    return 'codex';
  }
  return 'codex';
}

// Resolve the worker class (codex / claude-code) for a reconcile-time
// or recovery-time comment. Must reuse the same canonical mapping
// consume uses (`pickRemediationWorkerClass`), because the bot-token map
// only covers worker classes that actually have dedicated PATs:
//
//   WORKER_CLASS_TO_BOT_TOKEN_ENV = { codex, 'claude-code' }
//
// A previous implementation in comment-delivery returned
// `record.remediationWorker.model || record.builderTag || 'codex'`. For
// `[clio-agent]` PRs that produced `workerClass='clio-agent'`, which has
// no token mapping → the comment poster returned `no-token-mapping`,
// which the retry path treats as non-retryable → permanent silent loss
// of the terminal PR comment. (PR #18 R7 #2 / R8 blocking #2.)
//
// Strategy:
//   1. If the spawned worker recorded a `.model` AND that model has a
//      bot-token mapping, trust it (most authoritative for THIS
//      worker's actual session — claude-code-spawned workers should
//      post under the claude-code bot regardless of the PR's tag).
//   2. Otherwise, fall through to `pickRemediationWorkerClass(job)`
//      which canonically maps `clio-agent → codex` (since clio-agent
//      has no dedicated worker class today; consume already does this
//      at spawn time).
function resolveReconcileWorkerClass(job, worker) {
  const recordedModel = worker?.model;
  if (recordedModel && WORKER_CLASS_TO_BOT_TOKEN_ENV[recordedModel]) {
    return recordedModel;
  }
  return pickRemediationWorkerClass(job);
}

export {
  pickRemediationWorkerClass,
  resolveReconcileWorkerClass,
};
