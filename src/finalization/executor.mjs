import { loadAwareTimeoutMs, hostCpuBusyPercent } from '../load-aware-timeout.mjs';
// Merge Authority v2 leased executor (ARC-17; docs/SPEC-merge-authority-v2.md §4).
// The LAST piece of MA-v2: the single finalization worker per subject that turns
// the pure `eligible(...)` decision into an action. It is leased, idempotent, and
// fail-closed, and it SHIPS GATED OFF — until an operator promotes it on shadow
// evidence, `tick()` is inert (the master `enabled` gate; see the promotion
// runbook, docs/finalization-executor-promotion-runbook.md).
//
// Four invariants, all from §4:
//
//  1. ONE executor per subject. Every mutation runs under the app-store lease
//     (`executor-lease-store.mjs`, NOT GitHub labels). A contended subject is
//     deferred, never double-acted.
//  2. RE-FOLD GUARD. Before executing, the executor re-reads the ledger and folds
//     again; if the world moved since the decision was made (the ledger grew, or
//     the subject advanced past the decided revision), it DISCARDS the stale
//     decision and re-decides on the next tick rather than acting on stale state.
//  3. IDEMPOTENT by construction. A finalize whose `finalized` mark is already in
//     the ledger is `skipped`; the merge itself is guarded by `matchHeadCommit`
//     so a stale-revision merge cannot be issued; remediation dispatch dedupes on
//     its idempotency key.
//  4. KILL-SWITCH FAIL-CLOSED. Autonomous execution disabled ⇒ every mutating
//     decision (finalize-now / remediate / close) is intercepted BEFORE any
//     adapter call and written as a fail-closed `escalated` audit event; no
//     merge, close, or dispatch proceeds. (Defense in depth: `eligible()` also
//     gates, but the executor re-checks at the mutation boundary.)
//
// Escalations retain recovery ownership and retry unacknowledged delivery.

import { randomUUID } from 'node:crypto';
import { hostname, loadavg, availableParallelism } from 'node:os';

import { fold } from './ledger-fold.mjs';
import { eligible } from './eligibility.mjs';
import { readQueueEvidence } from './queue-read.mjs';
import { createWorkflowEffects } from './workflow-effects.mjs';
import { escalated, finalized, halted, closed, remediationDispatched, resolveSubjectKey } from './ledger-events.mjs';
import {
  resolveMergeSurface,
  checkIdentityAttestation,
  createGithubAdapterMergeSurface,
} from './execution-surfaces.mjs';

// The kill switch intercepts exactly the mutating decisions (finalize-now /
// remediate / close); each of those switch branches re-checks it at the mutation
// boundary before any adapter call (§4). wait/halt/escalate never mutate.
const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000;

function isoAdd(iso, ms) {
  const base = Date.parse(iso ?? '');
  if (!Number.isFinite(base)) throw new TypeError('executor requires a valid observedAt ISO timestamp');
  return new Date(base + ms).toISOString();
}

function outcome(subjectKey, decision, { status, action, observedAt, reason, detail, killSwitch }) {
  /** @type {import('../kernel/contracts.js').FinalizationExecutionOutcome} */
  const record = { subjectKey, decision, status, action, observedAt };
  if (reason != null) record.reason = reason;
  if (detail != null) record.detail = detail;
  if (killSwitch) record.killSwitch = true;
  return record;
}

/**
 * Build the leased executor. All I/O is injected so the executor is unit-testable
 * against in-memory stores and fake surfaces. Enabled executors require a
 * callable liveSurface.read; disabled construction may omit the reader.
 * The live reader can include ownerSnapshot: the current canonical next-action
 * snapshot, with the same subject/head/observation time. No alternate owner
 * registry is consulted by the executor.
 *
 * @param {{
 *   ledgerStore: { read(subject): any[], append(event): any },
 *   leaseStore: { acquire(args): any, release(args): boolean, read(subject): any },
 *   policy?: Partial<import('../kernel/contracts.js').EligibilityPolicy>,
 *   enabled?: boolean,
 *   adjudicateSurface?: object | null,
 *   mergeFallback?: object | null,
 *   identitySurface?: object | null,
 *   remediationSurface?: { dispatch(args): Promise<any> } | null,
 *   closeSurface?: { close(args): Promise<any> } | null,
 *   liveSurface?: { read(args): Promise<any> } | null,
 *   mergeMethod?: string,
 *   holder?: string,
 *   leaseTtlMs?: number,
 *   generateLeaseId?: () => string,
 * }} config
 */
export function createFinalizationExecutor({
  ledgerStore,
  leaseStore,
  policy,
  enabled = false,
  adjudicateSurface = null,
  mergeFallback = null,
  identitySurface = null,
  remediationSurface = null,
  closeSurface = null,
  liveSurface = null,
  recoverySurface = null,
  deliverySurface = null,
  pageSurface = null,
  mergeMethod = 'squash',
  // Required for merge execution, including legacy-default cached config.
  laneRouting = null,
  holder,
  leaseTtlMs = loadAwareTimeoutMs(DEFAULT_LEASE_TTL_MS, { maxMs: 30 * 60 * 1000 }),
  generateLeaseId = randomUUID,
} = {}) {
  if (!ledgerStore || typeof ledgerStore.read !== 'function') {
    throw new TypeError('createFinalizationExecutor requires a ledgerStore with read/append');
  }
  if (!leaseStore || typeof leaseStore.acquire !== 'function') {
    throw new TypeError('createFinalizationExecutor requires a leaseStore');
  }
  if (enabled && typeof liveSurface?.read !== 'function') {
    throw new TypeError('createFinalizationExecutor requires a liveSurface with read when enabled');
  }
  const executionToken = Symbol('leased-execution');
  const holderId = holder || `finalization-executor:${process.pid}@${safeHostname()}`;
  const bounded = (fn, request, decision) => {
    const patience = loadAwareTimeoutMs(5000, { maxMs: 30000 });
    const remaining = decision?.deadline ? Date.parse(decision.deadline) - Date.parse(request.observedAt) : patience;
    return readQueueEvidence({ read: fn }, request, Math.min(patience, Math.max(1, remaining)));
  };
  const effects = createWorkflowEffects({ ledgerStore, recoverySurface, deliverySurface, pageSurface });
  // Resolve the merge seam once: ARC-20 adjudicate surface, else the injected
  // local fallback, else a default github-adapter local surface (§4).
  const mergeSurface = resolveMergeSurface({
    adjudicateSurface,
    localFallback: mergeFallback,
    githubAdapter: createGithubAdapterMergeSurface({ mergeMethod }),
  });

  const killSwitchOn = () => normalizedPolicy(policy).autonomousExecutionDisabled === true;

  // Append the fail-closed kill-switch audit row: an `escalated` event naming the
  // intercepted decision. Idempotent + no re-page: skip if already terminal-escalated.
  function recordKillSwitchEscalation(subject, decision, state, at) {
    const reason = `kill switch: ${decision.kind} intercepted (autonomous execution disabled)`;
    if (state?.workflow?.escalation?.episode !== decision.episode) {
      ledgerStore.append(escalated(subject, { at, reason, episode: decision.episode }));
    }
    return outcome(resolveSubjectKey(subject), decision, {
      status: 'skipped', action: 'escalate', observedAt: at, reason, killSwitch: true,
    });
  }

  async function applyDecision(subject, decision, state, observedAt) {
    const subjectKey = resolveSubjectKey(subject);
    const rev = decision.revisionRef || state.currentRevision || '';

    // A finalized/closed subject is terminal — nothing to do (idempotency §4).
    if (state.finalized || state.terminal?.kind === 'closed') {
      return outcome(subjectKey, decision, {
        status: 'skipped', action: 'none', observedAt,
        reason: state.finalized ? 'already finalized' : 'already closed',
      });
    }
    if (Date.parse(observedAt) >= Date.parse(decision.deadline) || decision.kind === 'escalate') {
      await effects.page(subjectKey, decision, observedAt);
    }
    if (decision.nextAction === 'settle-delivery') {
      ledgerStore.append(finalized(subject, { at: observedAt,
        revisionRef: state.workflow.merge.mergedRevision, method: 'observed',
        sourceRef: state.workflow.delivery.sourceRef }));
      return outcome(subjectKey, decision, { status: 'executed', action: 'settle-delivery', observedAt });
    }
    if (decision.nextAction === 'deliver') {
      if (killSwitchOn()) return recordKillSwitchEscalation(subject, decision, state, observedAt);
      const result = await effects.deliver(subjectKey, decision, observedAt);
      return outcome(subjectKey, decision, { status: result.ok ? 'executed' : 'deferred',
        action: 'deliver', reason: result.reason, observedAt });
    }
    const recoveryActions = ['recover-custody', 'reconcile-custody', 'recover-primary',
      'conflict-rebase', 'merge-main', 'reconcile-dispatch', 'reconcile-effects', 'recover-coverage', 'refresh-evidence'];
    if (decision.kind !== 'escalate' && recoveryActions.includes(decision.nextAction)) {
      if (killSwitchOn()) return recordKillSwitchEscalation(subject, decision, state, observedAt);
      const result = await effects.recover(subjectKey, decision, observedAt);
      return outcome(subjectKey, decision, { status: result.ok ? 'executed' : 'deferred',
        action: decision.nextAction, reason: result.reason, observedAt });
    }

    switch (decision.kind) {
      case 'finalize-now': {
        if (killSwitchOn()) return recordKillSwitchEscalation(subject, decision, state, observedAt);
        // Identity/attestation read-through (ARC-22), fail-closed.
        const idv = await checkIdentityAttestation(identitySurface && { check: ctx => bounded(
          request => identitySurface.check(request), { ...ctx, observedAt }, decision) }, { subjectKey, revisionRef: rev, decision });
        if (!idv.ok) {
          return outcome(subjectKey, decision, {
            status: 'deferred', action: 'refresh-attestation', observedAt, reason: idv.reason,
          });
        }
        if (!mergeSurface) {
          const reason = 'no merge surface available (fail-closed)';
          ledgerStore.append(escalated(subject, { at: observedAt, reason }));
          return outcome(subjectKey, decision, { status: 'failed', action: 'merge', observedAt, reason });
        }
        let result;
        try {
          const legacy = async () => {
            if (!liveSurface?.read) return { ok: false, reason: 'authoritative-pr-reader-unavailable' };
            const live = await bounded(request => liveSurface.read(request), { subjectKey, revisionRef: rev, observedAt }, decision);
            const current = fold(ledgerStore.read(subject));
            if (live?.state !== 'open' || live.head !== rev || !live.sourceRef
              || current.eventCount !== state.eventCount) return { ok: false, reason: 'world-moved-before-merge' };
            const operationId = `merge:${rev}`;
            if (killSwitchOn()) return { ok: false, reason: 'autonomous-execution-disabled' };
            effects.emit(subjectKey, observedAt, 'operation_requested', { operationId, action: 'merge', revisionRef: rev });
            return bounded(request => mergeSurface.merge(request), {
              subjectKey, subjectExternalId: subjectKey.subjectExternalId, revisionRef: rev,
              mergeMethod: decision.mergeMethod ?? mergeMethod, idempotencyKey: operationId, deadline: decision.deadline, observedAt,
            }, decision);
          };
          if (laneRouting) result = await laneRouting.run({ subject: subjectKey, revisionRef: rev, deadline: decision.deadline, legacy });
          else result = { ok: false, reason: 'lane-routing-adapter-unavailable' };
        } catch (err) {
          return outcome(subjectKey, decision, {
            status: 'failed', action: 'merge', observedAt, reason: 'merge surface threw', detail: err?.message || String(err),
          });
        }
        if (result?.queued === true) return outcome(subjectKey, decision, {
          status: 'deferred', action: 'wait', observedAt, reason: result.reason || 'queue-handoff-acknowledged',
        });
        if (!result?.ok) {
          if (result?.reason === 'adapter-unavailable') {
            const reason = 'no merge surface available (fail-closed)';
            ledgerStore.append(escalated(subject, { at: observedAt, reason }));
            return outcome(subjectKey, decision, {
              status: 'skipped', action: 'escalate', observedAt, reason, detail: result?.detail,
            });
          }
          // A failed reply does not prove the remote effect absent. Preserve
          // any issued intent for authoritative readback before another merge.
          return outcome(subjectKey, decision, {
            status: 'failed', action: 'merge', observedAt,
            reason: result?.reason || 'merge failed', detail: result?.detail,
          });
        }
        // Landing is not finalization. Authoritative live readback on the next
        // tick records the actual principal/revision and starts PMA delivery.
        return outcome(subjectKey, decision, { status: 'executed', action: 'merge', observedAt });
      }

      case 'remediate': {
        const round = Number.isInteger(decision.round) ? decision.round : 1;
        // Same idempotency-key scheme as reviews: a replayed dispatch dedupes at
        // the ledger's partial-unique index (final rounds carry `final:true`).
        const idempotencyKey = `remediate:${rev}:${round}${decision.final ? ':final' : ''}`;
        // Already dispatched this exact round? Skip (idempotent).
        const already = (state.remediation?.dispatched ?? []).some(
          (d) => d.revisionRef === rev && d.round === round,
        );
        if (already) {
          return outcome(subjectKey, decision, {
            status: 'skipped', action: 'dispatch-remediation', observedAt, reason: 'round already dispatched',
          });
        }
        if (killSwitchOn()) return recordKillSwitchEscalation(subject, decision, state, observedAt);
        if (!remediationSurface?.dispatch) return outcome(subjectKey, decision, {
          status: 'deferred', action: 'dispatch-remediation', observedAt, reason: 'remediation capability unavailable',
        });
        const previous = state.workflow.operations[idempotencyKey];
        if (previous && previous.observation?.outcome !== 'absent') {
          const recovered = await effects.recover(subjectKey, { ...decision, nextAction: 'reconcile-dispatch', operationId: idempotencyKey }, observedAt);
          return outcome(subjectKey, decision, { status: 'deferred', action: 'reconcile-dispatch', observedAt, reason: recovered.reason });
        }
        effects.emit(subjectKey, observedAt, 'operation_requested', { operationId: idempotencyKey, action: 'remediate', revisionRef: rev });
        let admission;
        if (remediationSurface && typeof remediationSurface.dispatch === 'function') {
          try {
            admission = await bounded(request => remediationSurface.dispatch(request), {
              subjectKey, revisionRef: rev, round, stageId: decision.stageId, final: decision.final === true, idempotencyKey, observedAt, deadline: decision.deadline,
            }, decision);
          } catch (err) {
            return outcome(subjectKey, decision, {
              status: 'failed', action: 'dispatch-remediation', observedAt,
              reason: 'remediation surface threw', detail: err?.message || String(err),
            });
          }
        }
        if (admission?.admitted !== true || !admission.launchId) {
          if (admission?.admitted === false) effects.emit(subjectKey, observedAt, 'operation_observed', {
            operationId: idempotencyKey, outcome: 'absent', result: admission,
          });
          return outcome(subjectKey, decision, { status: 'deferred', action: 'dispatch-remediation', observedAt,
            reason: admission?.reason ?? 'admission requires reconciliation' });
        }
        effects.emit(subjectKey, observedAt, 'operation_observed', { operationId: idempotencyKey, outcome: 'admitted', result: admission });
        ledgerStore.append(remediationDispatched(subject, {
          at: observedAt, revisionRef: rev, round, idempotencyKey,
          stageId: decision.stageId, final: decision.final === true,
          operationId: idempotencyKey, admittedAt: admission.admittedAt ?? observedAt,
        }));
        return outcome(subjectKey, decision, { status: 'executed', action: 'dispatch-remediation', observedAt });
      }

      case 'close': {
        if (killSwitchOn()) return recordKillSwitchEscalation(subject, decision, state, observedAt);
        if (!closeSurface?.close) return outcome(subjectKey, decision, {
          status: 'deferred', action: 'close', observedAt, reason: 'close surface unavailable',
        });
        const operationId = `close:${rev}:${state.operatorOverrides.at(-1)?.at}`;
        if (state.workflow.operations[operationId]) {
          const result = await effects.recover(subjectKey, { ...decision, nextAction: 'reconcile-effects', operationId }, observedAt);
          return outcome(subjectKey, decision, { status: 'deferred', action: 'reconcile-effects', observedAt, reason: result.reason });
        }
        if (closeSurface && typeof closeSurface.close === 'function') {
          effects.emit(subjectKey, observedAt, 'operation_requested', { operationId, action: 'close', revisionRef: rev });
          try {
            await bounded(request => closeSurface.close(request), { subjectKey, revisionRef: rev, reason: decision.reason, observedAt, idempotencyKey: operationId }, decision);
          } catch (err) {
            return outcome(subjectKey, decision, {
              status: 'failed', action: 'close', observedAt,
              reason: 'close surface threw', detail: err?.message || String(err),
            });
          }
        }
        // Completion is recorded only by the authoritative lifecycle read in tick().
        return outcome(subjectKey, decision, { status: 'executed', action: 'close', observedAt });
      }

      case 'wait':
        // Poll again next tick — no mutation, bounded by the decision's deadline.
        return outcome(subjectKey, decision, {
          status: 'deferred', action: 'none', observedAt, reason: decision.reason, detail: decision.deadline,
        });

      case 'halt': {
        // Persist the hold while the ordinary episode pager retries delivery.
        if (state.terminal?.kind !== 'halted') {
          ledgerStore.append(halted(subject, { at: observedAt, reason: decision.reason || 'halt',
            policyVersion: decision.policyVersion, codeVersion: decision.codeVersion }));
        }
        return outcome(subjectKey, decision, { status: 'skipped', action: 'halt', observedAt, reason: decision.reason });
      }

      case 'escalate': {
        // Record the episode once; unacknowledged pages retry on later ticks.
        if (state.workflow?.escalation?.episode !== decision.episode) {
          ledgerStore.append(escalated(subject, { at: observedAt, reason: decision.reason || 'escalate', episode: decision.episode }));
        }
        return outcome(subjectKey, decision, {
          status: 'skipped', action: 'escalate', observedAt, reason: decision.reason,
          killSwitch: /kill switch/i.test(decision.reason || ''),
        });
      }

      default:
        return outcome(subjectKey, decision, {
          status: 'skipped', action: 'none', observedAt, reason: `unknown decision kind: ${decision.kind}`,
        });
    }
  }

  /**
   * Execute a PREVIOUSLY-COMPUTED decision, applying the re-fold guard first. The
   * decision is a hint; the ledger is authority. If the world moved since the
   * decision was folded (`basis.eventCount` no longer matches, or the subject
   * advanced past `decision.revisionRef`), the stale decision is DISCARDED and
   * the caller re-decides on the next tick.
   *
   * @param {import('../kernel/contracts.js').EligibilityDecision} decision
   * @param {{ subject: object, observedAt: string, basis?: { eventCount?: number } }} ctx
   */
  async function execute(decision, { subject, observedAt, basis, foldedState = null, token = null } = {}) {
    const subjectKey = resolveSubjectKey(subject);
    const state = foldedState ?? fold(ledgerStore.read(subject));

    // Re-fold guard (§4): the world moved if the ledger grew since the decision
    // was folded, or the subject advanced past the decided revision.
    const ledgerGrew = basis && Number.isInteger(basis.eventCount) && state.eventCount !== basis.eventCount;
    const revMoved = decision.revisionRef
      && state.currentRevision
      && decision.revisionRef !== state.currentRevision;
    if (ledgerGrew || revMoved) {
      return outcome(subjectKey, decision, {
        status: 'deferred', action: 're-decide', observedAt,
        reason: revMoved
          ? `world moved: subject advanced ${decision.revisionRef} → ${state.currentRevision}; decision discarded`
          : 'world moved: ledger advanced since decision; decision discarded',
      });
    }
    if (!foldedState || token !== executionToken) return tick(subject, { observedAt });
    const activeLease = leaseStore.read(subject);
    if (!enabled || activeLease?.holder !== holderId || Date.parse(activeLease.deadline) <= Date.parse(observedAt)) {
      return outcome(subjectKey, decision, { status: 'deferred', action: 're-decide', observedAt, reason: 'executor lease unavailable' });
    }
    return applyDecision(subject, decision, state, observedAt);
  }

  /**
   * The main loop entry: fold the subject's ledger, decide, and execute — all
   * under the subject's app-store lease. Inert when the executor is gated off.
   *
   * @param {object} subject SubjectRef / SubjectKey
   * @param {{ observedAt: string, leaseId?: string }} opts
   */
  async function tick(subject, { observedAt, leaseId, load } = {}) {
    const subjectKey = resolveSubjectKey(subject);
    if (!observedAt) throw new TypeError('executor tick requires an observedAt timestamp');

    // MASTER GATE — ships gated off. Inert until an operator promotes it: no
    // lease, no ledger write, no adapter call (the one-flag rollback boundary).
    if (!enabled) {
      return outcome(subjectKey, { kind: 'wait', subjectKey, revisionRef: '', observedAt }, {
        status: 'skipped', action: 'gated-off', observedAt,
        reason: 'finalization executor gated off (promotion pending)',
      });
    }

    load ??= { loadAvg1m: loadavg()[0], cpuCount: availableParallelism(), cpuBusyPercent: hostCpuBusyPercent() };
    const myLeaseId = leaseId || generateLeaseId();
    const deadline = isoAdd(observedAt, leaseTtlMs);
    let events;
    let live;
    try {
      events = ledgerStore.read(subject);
      live = liveSurface?.read ? await bounded(request => liveSurface.read(request), { subjectKey, observedAt }) : null;
    } catch (error) {
      // The app store may be unavailable: use the existing pager's durable keyed
      // outbox rather than pretending an unreadable ledger has no owner.
      if (pageSurface?.deliver) {
        try { await bounded(request => pageSurface.deliver(request), { subject: subjectKey,
          idempotencyKey: `ledger-unavailable:${subjectKey.domainId}:${subjectKey.subjectExternalId}`, observedAt }); } catch { /* retry next pass */ }
      }
      return outcome(subjectKey, { kind: 'wait', subjectKey, revisionRef: '', observedAt,
        owner: { kind: 'workflow', id: 'finalization-evidence-recovery', head: '' }, nextAction: 'refresh-evidence' }, {
        status: 'deferred', action: 'refresh-evidence', observedAt, reason: 'authoritative evidence unavailable', detail: error.message,
      });
    }
    let state = fold(events);
    if (!state.finalized && state.terminal?.kind !== 'closed') {
      if (!live?.sourceRef || !['open', 'merged', 'closed'].includes(live.state)) {
        return outcome(subjectKey, eligible(state, policy, { observedAt, load }), {
          status: 'deferred', action: 'refresh-evidence', observedAt, reason: 'authoritative-pr-reader-unavailable',
        });
      }
      if (live.state === 'closed') {
        ledgerStore.append(closed(subject, { at: observedAt, reason: 'authoritative closed PR', sourceRef: live.sourceRef }));
        return outcome(subjectKey, eligible(fold(ledgerStore.read(subject)), policy, { observedAt, load }), {
          status: 'executed', action: 'settle-closed', observedAt,
        });
      }
      if (live.state === 'merged' && !state.workflow.merge) {
        if (!live.mergedRevision || !live.principal || typeof live.planRequired !== 'boolean') {
          return outcome(subjectKey, eligible(state, policy, { observedAt, load }), {
            status: 'deferred', action: 'refresh-evidence', observedAt, reason: 'merge-provenance-unavailable',
          });
        }
        effects.emit(subjectKey, observedAt, 'merge_observed', { mergedRevision: live.mergedRevision,
          principal: live.principal, planRequired: live.planRequired, sourceRef: live.sourceRef,
          idempotencyKey: `merge:${live.sourceRef}` });
        state = fold(ledgerStore.read(subject));
      }
      if (live.state === 'open' && live.head !== state.currentRevision) {
        return outcome(subjectKey, eligible(state, policy, { observedAt, load }), {
          status: 'deferred', action: 're-decide', observedAt, reason: 'live head requires revision observation',
        });
      }
    }
    const currentRev = state.currentRevision;
    const acq = leaseStore.acquire({
      subject, holder: holderId, leaseId: myLeaseId, revisionRef: currentRev, now: observedAt, deadline,
    });
    if (!acq.acquired) {
      // Another executor holds the subject — do NOT act (one writer per subject).
      return outcome(subjectKey, { kind: 'wait', subjectKey, revisionRef: currentRev || '', observedAt }, {
        status: 'deferred', action: 'lease-contended', observedAt,
        reason: `subject leased by ${acq.existing?.holder ?? 'another executor'}`,
      });
    }

    try {
      const leasedEvents = ledgerStore.read(subject);
      let leasedState = fold(leasedEvents);
      const ownerSnapshot = live?.ownerSnapshot;
      let decision = eligible(leasedState, policy, { observedAt, load, ownerSnapshot });
      if (!leasedState.workflow.anchors[decision.episode] && decision.anchorAt) {
        effects.emit(subjectKey, observedAt, 'decision_anchored', {
          episode: decision.episode, anchorAt: decision.anchorAt, nominalMs: decision.nominalMs,
          effectiveMs: decision.effectiveMs, ceilingMs: decision.ceilingMs, policyVersion: decision.policyVersion,
          codeVersion: decision.codeVersion, loadEvidence: decision.loadEvidence,
        });
        leasedState = fold(ledgerStore.read(subject));
        decision = eligible(leasedState, policy, { observedAt, load, ownerSnapshot });
      }
      // decide → execute back-to-back under the lease; tick passes the
      // post-acquire folded state so execute() does not perform a third fold.
      return await execute(decision, {
        subject,
        observedAt,
        basis: { eventCount: leasedState.eventCount },
        foldedState: leasedState, token: executionToken,
      });
    } catch (error) {
      return outcome(subjectKey, eligible(state, policy, { observedAt, load }), {
        status: 'deferred', action: 'refresh-evidence', observedAt, reason: 'leased evidence unavailable', detail: error.message,
      });
    } finally {
      leaseStore.release({ subject, leaseId: myLeaseId });
    }
  }

  return { tick, execute, holderId, mergeSurfaceName: mergeSurface?.name ?? null };
}

function safeHostname() {
  try {
    return hostname();
  } catch {
    return 'unknown-host';
  }
}


// Local, allocation-free policy normalization for the kill-switch read only. The
// full validation lives in `eligibility.normalizePolicy`; here we only need the
// one boolean, and we must not throw on a config that eligibility already vetted.
function normalizedPolicy(policy) {
  return { autonomousExecutionDisabled: policy?.autonomousExecutionDisabled === true };
}
