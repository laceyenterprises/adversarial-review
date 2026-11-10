// Compose the existing observation/event/store contracts. No execution port,
// live reader, route selector, pager or session-ledger writer is available here.
import { openFinalizationLedgerStore } from './ledger-store.mjs';
import { openFinalizationShadowStore } from './shadow-store.mjs';
import { shadowObserveFromStore } from './shadow-recorder.mjs';
import { makeFinalizationEvent } from './ledger-events.mjs';
import { handoffDigest } from './queue-handoff.mjs';
import { classifyCheckRollup } from '../checks-summary.mjs';
import { QUEUE_RUNNING_BUILD } from './queue-build.mjs';
import { isOperatorHeld } from '../operator-hold-labels.mjs';
import { isDaemonMergeReviewAllowed } from '../ama/daemon-merge.mjs';
import { normalizeV1Action } from './shadow-actions.mjs';

const consumer = { id: 'next-action-finalization-shadow', build: QUEUE_RUNNING_BUILD,
  loadedAt: new Date().toISOString(), pid: process.pid };
const complete = (snapshot, name) => snapshot.observations?.[name]?.state === 'complete'
  ? snapshot.observations[name].value : null;

function checkEvidence(snapshot) {
  const checks = complete(snapshot, 'checks');
  if (!checks) return null;
  const candidate = complete(snapshot, 'candidate');
  const sameSource = snapshot.observations?.checks?.provenance?.sourceRef
    && snapshot.observations.checks.provenance.sourceRef === snapshot.observations?.candidate?.provenance?.sourceRef;
  return { ...checks, headSha: checks.headSha ?? (sameSource ? candidate?.headSha : null),
    requiredContexts: checks.requiredContexts ?? checks.finalizationRequiredContexts
      ?? (checks.branchProtection?.ok === true ? checks.branchProtection.requiredContexts : null) };
}

export function liveV1Action(legacy, sourceRef) {
  const kind = legacy?.action === 'daemon-merge' && legacy.reason === 'merged-this-pass' ? 'merged'
    : legacy?.action === 'hammer' && ['dispatched', 'ama-dispatched'].includes(legacy.legacyReason) ? 'hammer-dispatch'
      : legacy?.action === 'remediate' ? 'remediate'
        : legacy?.action === 'operator-hold' ? 'halt' : 'wait';
  return { kind, sourceRef, detail: `${legacy?.action ?? 'observe'}:${legacy?.reason ?? 'unknown'}` };
}

/** Translate only complete, sourced observations. Missing evidence stays absent.
 * Keys identify the original snapshot, so a retry cannot refresh an event time. */
export function snapshotFinalizationEvents(snapshot, subject, previous = []) {
  const at = snapshot.observedAt;
  if (!Number.isFinite(Date.parse(at)) || !snapshot.head) throw new Error('snapshot identity/time unavailable');
  const tick = handoffDigest(snapshot);
  const events = [];
  const add = (type, fields, sourceRef) => events.push(makeFinalizationEvent(type, subject, {
    at, ...fields, sourceRef: sourceRef || `snapshot:${tick}:${type}`, idempotencyKey: `snapshot:${tick}:${type}`,
  }));
  const head = snapshot.head;
  if (previous.filter(e => e.type === 'revision_advanced').at(-1)?.revisionRef !== head) {
    add('revision_advanced', { revisionRef: head });
  }
  const reviews = complete(snapshot, 'reviews');
  const reviewSource = snapshot.observations?.reviews?.provenance?.sourceRef;
  if (reviews?.verdict && reviews.headSha && reviewSource) {
    const findings = reviews.blockingFindingCount > 0 || reviews.nonBlockingFindingCount > 0;
    add('verdict_recorded', { revisionRef: reviews.headSha, stageId: 'review', role: 'reviewer',
      verdictKind: findings ? 'request-changes' : isDaemonMergeReviewAllowed(reviews)
        ? reviews.verdict : 'unknown' }, reviewSource);
  }
  const checks = checkEvidence(snapshot);
  const checkSource = snapshot.observations?.checks?.provenance?.sourceRef;
  const rollup = checks?.rollup ?? checks?.statusCheckRollup;
  // Reuse the one CI classifier. A summary SUCCESS cannot prove required-set
  // completeness; require the actual set and exact-head rollup.
  if (Array.isArray(rollup) && Array.isArray(checks.requiredContexts)
    && checks.headSha === head && checkSource) {
    const conclusion = classifyCheckRollup(rollup, { requiredContexts: checks.requiredContexts });
    const names = new Set(rollup.map(item => String(item.name || item.context || '').trim().toLowerCase()));
    add('checks_settled', { revisionRef: head, conclusion: (conclusion || 'PENDING').toLowerCase(),
      requiredChecksPresent: rollup.length > 0
        && checks.requiredContexts.every(name => names.has(String(name).trim().toLowerCase())) }, checkSource);
  }
  const pr = complete(snapshot, 'pr');
  if (pr?.headSha === head && ['DIRTY', 'CONFLICTING', 'MERGEABLE', 'UNKNOWN'].includes(pr.mergeable)) {
    add('mergeability_observed', { revisionRef: head, mergeability: pr.mergeable });
  }
  const policy = complete(snapshot, 'policy');
  if (policy?.reviewCeilingReached === true) add('budget_exhausted', { stageId: 'review' });
  return events;
}

/** Atomic ingestion and pair recording in the existing app-owned SQLite DB.
 * Fold/translation/read errors persist an escalate pair; store failures are
 * returned explicitly to the observer and never change legacy execution. */
export function recordLiveShadow({ rootDir, snapshot, legacy, source, repo, prNumber,
  shadowStore, policy, v1Action: recordedV1Action = null } = {}) {
  const subject = { domainId: 'code-pr', subjectExternalId: `${repo}#${prNumber}` };
  if (snapshot?.subjectKey !== subject.subjectExternalId) throw new Error('foreign shadow subject');
  const store = shadowStore ?? openFinalizationShadowStore({ rootDir });
  try {
    const ledger = openFinalizationLedgerStore({ db: store.db });
    return store.db.transaction(() => {
      const sourceRef = `legacy:${source}:${handoffDigest({ snapshot, legacy, recordedV1Action })}`;
      const v1Action = recordedV1Action ? normalizeV1Action({ ...recordedV1Action, sourceRef })
        : liveV1Action(legacy, sourceRef);
      if (!recordedV1Action) {
        const receipt = complete(snapshot, 'progress')?.mergeReceipt;
        // A terminal launch status alone is not GitHub landing evidence.
        if (receipt?.merged === true && receipt.path === 'daemon-merge'
          && receipt.headSha === snapshot.head) v1Action.kind = 'merged';
        if (String(complete(snapshot, 'pr')?.state).toLowerCase() === 'merged') v1Action.kind = 'merged';
        if (legacy?.action === 'done' && legacy.reason === 'merged') v1Action.kind = 'merged';
        if (legacy?.action === 'done' && legacy.reason === 'closed') v1Action.kind = 'close';
      }
      let error = false;
      try {
        const previous = ledger.read(subject);
        const latestRevision = previous.filter(e => e.type === 'revision_advanced').at(-1);
        if (latestRevision && Date.parse(snapshot.observedAt) < Date.parse(latestRevision.at)) {
          throw new Error('out-of-order snapshot');
        }
        for (const event of snapshotFinalizationEvents(snapshot, subject, previous)) ledger.append(event);
        error = Object.values(snapshot.observations ?? {}).some(o => o?.state === 'error');
        // A failed refresh must not borrow an earlier green/clean snapshot.
        const checks = checkEvidence(snapshot);
        if (previous.some(e => e.type === 'checks_settled' && e.revisionRef === snapshot.head)
          && (!checks || checks.headSha !== snapshot.head || !Array.isArray(checks.requiredContexts)
            || !Array.isArray(checks.rollup ?? checks.statusCheckRollup))) error = true;
        if (previous.some(e => e.type === 'verdict_recorded' && e.revisionRef === snapshot.head)
          && !complete(snapshot, 'reviews')?.verdict) error = true;
      } catch { error = true; }
      const observedPolicy = complete(snapshot, 'policy');
      const observation = shadowObserveFromStore({ subject, observedAt: snapshot.observedAt, v1Action,
        policy: { ...policy, autonomousExecutionDisabled: policy?.autonomousExecutionDisabled === true
          || observedPolicy?.autonomousMergeExecutionEnabled === false
          || isOperatorHeld(complete(snapshot, 'pr')?.labels) },
        ledgerStore: error ? { read() { throw new Error('live evidence unavailable'); } } : ledger });
      const pr = complete(snapshot, 'pr');
      const base = pr?.baseBranch ?? complete(snapshot, 'candidate')?.baseBranch ?? null;
      observation.live = { source: 'organic', lane: { repository: repo, base },
        sourceRef, consumer, terminalOutcome: v1Action.kind === 'merged' ? 'merged'
          : legacy?.action === 'done' && legacy.reason === 'closed' ? 'closed' : null };
      // The snapshot adapter can be incomplete in either direction. Preserve the
      // MGQ-07 discipline: a live disagreement is open until human disposition.
      if (observation.classification.relation === 'diverge' && !observation.foldError) {
        observation.live.proposedClassification = observation.classification;
        observation.classification = { ...observation.classification, direction: 'open', disposition: 'open',
          reason: 'live snapshot comparison requires bidirectional evidence triage' };
      }
      // Terminal metrics require an observed landing, never a requested hammer.
      observation.dedupeKey = sourceRef;
      return store.append(observation);
    })();
  } finally { if (!shadowStore) store.close(); }
}
