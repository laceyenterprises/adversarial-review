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
import { resolve } from 'node:path';
import { finalizationOwner } from './live-owner.mjs';
import { readFinalRemediatorHead } from './exact-head-review.mjs';
import { LIVE_EVIDENCE_UNKNOWN_REASONS } from './live-evidence-reasons.mjs';
import { launchRequestOwned, withLiveLaunchRetry } from '../ama/launch-request-status.mjs';
import { isRemediationRoundBudgetSpent, remediationBudgetHandoffAllowed } from '../remediation-round-recovery.mjs';

// One canonical app root per daemon. Bound the cache to one handle and converge
// each schema once per connection, including caller-owned test/store handles.
let cachedStore = null;
let cachedRoot = null;
const ledgers = new WeakMap();
function liveStore(rootDir) {
  const root = resolve(rootDir);
  if (cachedRoot !== root || !cachedStore?.db.open) {
    cachedStore?.close();
    cachedStore = null;
    cachedRoot = null;
    cachedStore = openFinalizationShadowStore({ rootDir: root });
    cachedRoot = root;
  }
  return cachedStore;
}
process.once('exit', () => cachedStore?.close());

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

const plainObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const text = value => (typeof value === 'string' ? value.trim() : '');
const finiteNumber = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// MRQ-11 D1: launch custody states the workflow custody gate treats as a
// progressing holder. Any other owned status (parked, quota-resume) is held,
// not terminal, so it maps to `suspended`.
const ACTIVE_CUSTODY_STATES = new Set(['requested', 'admitted', 'leased', 'starting', 'running',
  'waiting_approval', 'waiting_input', 'suspended']);
// The event contract's maximum. Every snapshot re-observes an active launch.
const CUSTODY_FRESHNESS_SECONDS = 180;

// MRQ-11 D8: typed unknown observations. Missing or regressed evidence is a
// refresh on an explicit cause, never a fold error. Order is precedence.
export const LIVE_EVIDENCE_UNKNOWN_CAUSES = Object.freeze(Object.keys(LIVE_EVIDENCE_UNKNOWN_REASONS));

/** MRQ-11 D1: the snapshot closer launch through the same tri-state ownership
 * helpers v1 reads. `null` means no complete launch evidence (nothing to say). */
export function snapshotCloserCustody(snapshot, head) {
  const launches = snapshot?.observations?.launches;
  if (launches?.state !== 'complete') return null;
  const closer = plainObject(launches.value?.closer);
  const sourceRef = text(launches.provenance?.sourceRef) || null;
  if (!closer) return { kind: 'absent', sourceRef };
  const probe = plainObject(closer.probe) || { ok: true, row: plainObject(closer.row) || { status: closer.status },
    retryChain: Array.isArray(closer.retryChain) ? closer.retryChain : undefined,
    retryChainUnreadable: closer.retryChainUnreadable === true };
  const revisionRef = text(closer.headSha) || head;
  const effective = withLiveLaunchRetry(probe);
  const launchRequestId = text(effective?.liveRetryLaunchRequestId) || text(closer.launchRequestId) || null;
  const owned = launchRequestOwned(probe);
  // Unknown ownership (or an owned launch that cannot be identified) is not
  // absence. Only this head's launch is v1's ownership question (R04).
  if (owned === null || (owned === true && !launchRequestId)) {
    return { kind: revisionRef === head ? 'unreadable' : 'foreign-unreadable', revisionRef, sourceRef };
  }
  if (owned === false) return { kind: 'terminal', launchRequestId, revisionRef, sourceRef };
  const status = text(effective?.row?.status).toLowerCase();
  return { kind: 'active', launchRequestId, revisionRef, sourceRef,
    state: ACTIVE_CUSTODY_STATES.has(status) ? status : 'suspended' };
}

function custodyEvents(snapshot, subject, previous, head) {
  const custody = snapshotCloserCustody(snapshot, head);
  if (!custody || !['active', 'terminal', 'absent'].includes(custody.kind)) return [];
  const match = /^(.+)#([1-9][0-9]*)$/.exec(subject.subjectExternalId);
  if (!match) return [];
  const at = snapshot.observedAt;
  const latest = new Map();
  for (const event of previous) {
    if (event.type === 'launch_custody_observed') latest.set(event.custody.launchRequestId, event);
  }
  const event = (launchRequestId, state, revisionRef) => {
    const sourceRef = custody.sourceRef || `snapshot:launches:${launchRequestId}`;
    return makeFinalizationEvent('launch_custody_observed', subject, { at, revisionRef, sourceRef,
      idempotencyKey: `snapshot-custody:${handoffDigest({ launchRequestId, state, revisionRef, at, sourceRef })}`,
      custody: { repository: match[1], prNumber: Number(match[2]), launchRequestId, state, at,
        freshnessSeconds: CUSTODY_FRESHNESS_SECONDS } });
  };
  const events = [];
  const current = custody.kind === 'active' ? custody.launchRequestId : null;
  // A complete read that no longer names a held launch releases the holder
  // this adapter observed. Other producers' custody (for example a dirty
  // terminal workspace) is never released from snapshot absence.
  for (const [launchRequestId, last] of latest) {
    if (launchRequestId === current || !ACTIVE_CUSTODY_STATES.has(last.custody.state)
      || !String(last.idempotencyKey).startsWith('snapshot-custody:')) continue;
    events.push(event(launchRequestId, 'terminal', last.revisionRef));
  }
  if (current) events.push(event(current, custody.state, custody.revisionRef));
  return events;
}

// MRQ-11 D4: v1's spent-round reading (pr-next-action remediationFacts
// `roundsLeft === false`), using the same budget helpers.
export function remediationRoundsSpent(value) {
  if (!plainObject(value)) return false;
  const job = plainObject(value.job) || (Object.hasOwn(value, 'status') ? value : null);
  const plan = plainObject(job?.remediationPlan);
  const completed = finiteNumber(value.completedRounds) ?? finiteNumber(plan?.currentRound);
  const max = finiteNumber(value.maxRounds) ?? finiteNumber(plan?.maxRounds);
  const spent = job ? remediationBudgetHandoffAllowed({ ...job,
    remediationPlan: plan || { currentRound: completed, maxRounds: max } })
    : completed !== null && max !== null && isRemediationRoundBudgetSpent({ currentRound: completed, maxRounds: max });
  if (spent) return true;
  if (typeof value.roundsLeft === 'boolean') return value.roundsLeft === false;
  return completed !== null && max !== null && max > 0 && completed >= max;
}

export function liveV1Action(legacy, sourceRef) {
  const kind = legacy?.action === 'daemon-merge' && legacy.reason === 'merged-this-pass' ? 'merged'
    : legacy?.action === 'hammer' && ['dispatched', 'ama-dispatched'].includes(legacy.legacyReason) ? 'hammer-dispatch'
      : legacy?.action === 'remediate' ? 'remediate'
        : legacy?.action === 'operator-hold' ? 'halt' : 'wait';
  return { kind, sourceRef, detail: `${legacy?.action ?? 'observe'}:${legacy?.reason ?? 'unknown'}` };
}

/** Translate only complete, sourced observations. Missing evidence stays absent.
 * Unchanged facts retain their original event time; changed facts append a
 * transition, including a return to a previously observed value. */
export function snapshotFinalizationEvents(snapshot, subject, previous = []) {
  const at = snapshot.observedAt;
  if (!Number.isFinite(Date.parse(at)) || !snapshot.head) throw new Error('snapshot identity/time unavailable');
  const events = [];
  const add = (type, fields, sourceRef) => {
    const ref = sourceRef || `snapshot:${type}:${handoffDigest(fields)}`;
    const last = previous.filter(e => e.type === type
      && (type === 'revision_advanced' || e.revisionRef === fields.revisionRef) && e.stageId === fields.stageId
      && e.role === fields.role).at(-1);
    if (last?.sourceRef === ref && Object.entries(fields).every(([key, value]) => last[key] === value)) return;
    const key = handoffDigest({ type, fields, sourceRef: ref, predecessor: last?.idempotencyKey ?? last?.seq ?? null });
    events.push(makeFinalizationEvent(type, subject, {
      at, ...fields, sourceRef: ref, idempotencyKey: `snapshot:${key}:${type}`,
    }));
  };
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
  if (snapshotPrMerged(snapshot)) {
    // MRQ-11 D5: GitHub's landing is the terminal fact. A merged PR's
    // recomputed `mergeable: UNKNOWN` is not a blocker, so it is not recorded.
    if (!previous.some(e => e.type === 'merge_observed')) {
      const mergedBy = plainObject(pr.mergedBy) ? text(pr.mergedBy.login) : text(pr.mergedBy);
      // Post-merge activation stays unproven here: never claim it not required.
      add('merge_observed', { mergedRevision: text(pr.headSha) || head, principal: mergedBy || 'unattributed',
        planRequired: true }, snapshot.observations.pr.provenance?.sourceRef);
    }
  } else if (pr?.headSha === head && ['DIRTY', 'CONFLICTING', 'MERGEABLE', 'UNKNOWN'].includes(pr.mergeable)) {
    add('mergeability_observed', { revisionRef: head, mergeability: pr.mergeable });
  }
  const policy = complete(snapshot, 'policy');
  // MRQ-11 D4: spent remediation rounds exhaust the review stage exactly as
  // the review ceiling does (same fields, so the two never double-append).
  if (policy?.reviewCeilingReached === true || remediationRoundsSpent(complete(snapshot, 'remediation'))) {
    add('budget_exhausted', { stageId: 'review' });
  }
  events.push(...custodyEvents(snapshot, subject, previous, head));
  return events;
}

const snapshotPrMerged = snapshot => String(complete(snapshot, 'pr')?.state).toLowerCase() === 'merged';

/** Atomic ingestion and pair recording in the existing app-owned SQLite DB.
 * Fold/translation/read errors persist an escalate pair; store failures are
 * returned explicitly to the observer and never change legacy execution. */
export function recordLiveShadow({ rootDir, snapshot, legacy, source, repo, prNumber,
  shadowStore, policy, v1Action: recordedV1Action = null } = {}) {
  const subject = { domainId: 'code-pr', subjectExternalId: `${repo}#${prNumber}` };
  if (snapshot?.subjectKey !== subject.subjectExternalId) throw new Error('foreign shadow subject');
  const store = shadowStore ?? liveStore(rootDir);
  let ledger = ledgers.get(store.db);
  if (!ledger) {
    ledger = openFinalizationLedgerStore({ db: store.db });
    ledgers.set(store.db, ledger);
  }
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
    // MRQ-11 D8: each evidence problem is a typed unknown observation. The fold
    // still runs over the real ledger; only a genuinely unreadable ledger or a
    // fold exception remains a fold error.
    const unknown = new Set();
    let finalRemediatorHead = null;
    try {
      const reviews = complete(snapshot, 'reviews');
      if (rootDir && !(reviews?.headSha === snapshot.head && reviews.verdict)) finalRemediatorHead = readFinalRemediatorHead({
        rootDir, repo, prNumber, headSha: snapshot.head,
      });
      const previous = ledger.read(subject);
      const latestRevision = previous.filter(e => e.type === 'revision_advanced').at(-1);
      if (latestRevision && Date.parse(snapshot.observedAt) < Date.parse(latestRevision.at)) {
        // A late snapshot appends nothing; the ledger's newer evidence stands.
        unknown.add('out-of-order-snapshot');
      } else {
        for (const event of snapshotFinalizationEvents(snapshot, subject, previous)) ledger.append(event);
      }
      if (Object.values(snapshot.observations ?? {}).some(o => o?.state === 'error')) unknown.add('snapshot-observation-error');
      if (snapshotCloserCustody(snapshot, snapshot.head)?.kind === 'unreadable') unknown.add('launch-ownership-unreadable');
      // A failed refresh must not borrow an earlier green/clean snapshot. A
      // landed PR's refresh is irrelevant: its merge is already recorded.
      const checks = checkEvidence(snapshot);
      if (!snapshotPrMerged(snapshot) && snapshot.observations?.checks
        && previous.some(e => e.type === 'checks_settled' && e.revisionRef === snapshot.head)
        && (!checks || checks.headSha !== snapshot.head || !Array.isArray(checks.requiredContexts)
          || !Array.isArray(checks.rollup ?? checks.statusCheckRollup))) unknown.add('checks-evidence-regressed');
      if (!snapshotPrMerged(snapshot) && snapshot.observations?.reviews
        && previous.some(e => e.type === 'verdict_recorded' && e.revisionRef === snapshot.head)
        && !complete(snapshot, 'reviews')?.verdict) unknown.add('verdict-evidence-regressed');
    } catch { unknown.add('snapshot-translation-error'); }
    const observedPolicy = complete(snapshot, 'policy');
    const observation = shadowObserveFromStore({ subject, observedAt: snapshot.observedAt, v1Action,
      ownerSnapshot: { ...snapshot, finalRemediatorHead },
      unknownEvidence: LIVE_EVIDENCE_UNKNOWN_CAUSES.filter(cause => unknown.has(cause)).map(cause => ({ cause })),
      policy: { ...policy, autonomousExecutionDisabled: policy?.autonomousExecutionDisabled === true
        || observedPolicy?.autonomousMergeExecutionEnabled === false
        || isOperatorHeld(complete(snapshot, 'pr')?.labels) },
      ledgerStore: ledger });
    const pr = complete(snapshot, 'pr');
    const base = pr?.baseBranch ?? complete(snapshot, 'candidate')?.baseBranch ?? null;
    observation.live = { source: 'organic', lane: { repository: repo, base },
      ownerState: finalizationOwner(snapshot, snapshot.observedAt),
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
  }).immediate();
}
