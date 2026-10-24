// Synthetic open-PR evidence for physical proof/lease regression fixtures.
// Policy assertions use the shared action matrix; this helper supplies facts.
import { deriveNextActionSnapshot, nextAction } from '../../src/pr-next-action.mjs';
import { closureOwnerShadowEvidence } from '../../src/pr-next-action-consumer.mjs';
import { closureOwnerFromDecision } from '../../src/ama/closure-owner.mjs';
import { checkPrimaryChange } from '../../src/ama/primary-change.mjs';

export function decideClosureOwner(input = {}) {
  const evidence = closureOwnerShadowEvidence({ ...input, lease: input.lease || null,
    roundsLeft: input.roundsLeft ?? true }, {
    subjectKey: 'subject-fixture', observedAt: typeof input.now === 'number' ? new Date(input.now).toISOString()
      : input.now || '2026-01-01T00:00:00.000Z', autonomousMergeExecutionEnabled: true,
    candidate: { headSha: input.currentHead, prState: 'OPEN', mergeable: input.mergeable || 'MERGEABLE' },
  });
  const probe = input.launchStatusProbe || input.readLaunchRequestStatusImpl?.({
    launchRequestId: input.lease?.lrqId, includeRetryChain: true, rootDir: input.rootDir });
  const observations = { ...evidence.observations,
    checks: { conclusion: input.checks === undefined ? 'SUCCESS' : input.checks },
    ...(input.primaryChange ? { progress: { ...evidence.observations.progress,
      primaryChange: checkPrimaryChange(input.primaryChange, input.currentHead,
        { strictNonBlockingRemediation: input.strictNonBlockingRemediation !== false }) } } : {}),
    ...(probe ? { launches: { closer: { headSha: input.currentHead,
      launchRequestId: input.lease?.lrqId, probe } } } : {}),
  };
  return closureOwnerFromDecision(nextAction(deriveNextActionSnapshot({ ...evidence, observations })));
}
