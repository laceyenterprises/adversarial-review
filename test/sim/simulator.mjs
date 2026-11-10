import { fold, foldFrom, foldQueue } from '../../src/finalization/ledger-fold.mjs';
import { eligible } from '../../src/finalization/eligibility.mjs';
import { createFinalizationExecutor } from '../../src/finalization/executor.mjs';
import { makeFinalizationEvent } from '../../src/finalization/ledger-events.mjs';
import { Clock, loadModel } from './clock.mjs';
import { profiles } from './recipes.mjs';
import { violations } from './oracle.mjs';

const subject = { domainId: 'code-pr', subjectExternalId: 'synthetic/project#1' };

export async function simulate(scenario, { seed = 17, load = 1, mutate } = {}) {
  if (!Object.hasOwn(profiles, scenario.profile)) throw Error(`unknown profile ${scenario.profile}`);
  const f = profiles[scenario.profile];
  const clock = new Clock(seed);
  const pressure = loadModel(load);
  const patience = 1000;
  const loadObservation = { enabled: true, maxMultiplier: 6, loadAvg1m: 1 + (load - 1) * 2 / 5, cpuCount: 1, cpuBusyPercent: 100 };
  const policy = { checksPatienceMs: patience, verdictPatienceMs: patience, attestationPatienceMs: patience, deadlineCeilingMs: 6000, autonomousExecutionDisabled: !!f.killSwitch };
  const bound = pressure.timeout(5000);
  const trace = [];
  const failed = new Set();
  const events = [];
  const merges = [];
  const launches = [];
  const pages = [];
  const causes = [];
  let salvaged = false;
  let activated = f.activation !== false;
  let deployed = f.deployed !== false;
  let repairedConflict = false;
  let lease = null;
  let serial = 0;
  let head = 'revision-A';
  let base = 'base-A';
  let checks = f.move || f.baseMove ? null : f.checks ?? 'success';
  let blocking = f.finding ? 1 : 0;
  let comments = f.comment ? 1 : 0;
  let merged = f.merged === true;
  let decision = null;
  let readFailed = false;
  let refused = false;
  let transientCharges = 0;
  let transientRefusals = 0;
  let rollbackReceipt = null;
  let headRaced = false;
  let queueState = foldQueue([]);
  if (f.rollback) queueState = foldQueue([{ type: 'acknowledged', entry: {
    entryId: 'synthetic-entry', candidate: head, base, budget: { spent: 1 }, deadline: patience,
  } }]);
  if (merged) merges.push({ revision: head, liveHead: head, blocking: 0, comments: 0, base });
  if (f.dirtyTerminal) launches.push({ id: 'terminal-holder', head, status: 'canceled', verified: false, dirty: true });
  const activeFault = () => clock.now < pressure.timeout(1500);
  function snapshot() {
    const state = fold(events);
    decision = eligible(state, policy, { observedAt: clock.iso(), load: loadObservation });
    const terminal = f.hold || f.killSwitch ? 'operator-hold' : state.terminal?.kind
      ?? (pages.length ? 'escalated' : null);
    const owners = decision?.owner ? [decision.owner] : [];
    return { now: clock.now, bound, head, terminal, owners,
      deadline: decision?.deadline ? Date.parse(decision.deadline) - Date.UTC(2030, 0, 1) : NaN,
      merges: structuredClone(merges), activation: activated && deployed,
      causes: [...causes], pages: [...pages],
      transientCharges, transientRefusals };
  }
  function inspect(label) {
    const view = snapshot();
    mutate?.(view, label);
    const errors = violations(view);
    for (const error of errors) failed.add(error);
    trace.push({ at: clock.now, label, head, terminal: view.terminal ?? null,
      decision: decision?.kind ?? null, errors, events: events.length, launches: launches.length,
      merges: merges.length });
  }
  function append(event) {
    makeFinalizationEvent(event.type, event.subjectKey, event);
    events.push(structuredClone(event));
    if (event.type === 'remediation_dispatched' && refused) transientCharges++;
    if (['halted', 'closed'].includes(event.type) && ['budget-killed', 'canceled', 'crashed'].includes(f.agentOutcome)) transientRefusals++;
    inspect(`ledger:${event.type}`);
  }
  const emit = (type, fields = {}) => append({ type, subjectKey: subject, at: clock.iso(), ...fields });
  const observe = (revisionRef = head) => {
    emit('revision_advanced', { revisionRef });
    emit('provenance_observed', { revisionRef, builderBoundary: 'synthetic:builder',
      primaryChange: f.primaryEvidence === false ? 'unknown' : 'preserved', hammerCommits: false, mergeMain: false,
      sourceRef: 'synthetic:primary', idempotencyKey: `primary:${revisionRef}` });
    if (checks) emit('checks_settled', { revisionRef, conclusion: checks, requiredChecksPresent: true, sourceRef: 'synthetic:checks' });
    emit('verdict_recorded', { revisionRef: f.staleReview ? 'obsolete-revision' : revisionRef,
      stageId: 'review', role: 'independent-reviewer', verdictKind: blocking ? 'request-changes' : comments ? 'comment-only' : 'approved',
      sourceRef: 'synthetic:review' });
  };
  const ledgerStore = {
    read() {
      if (f.readFailure && activeFault()) { readFailed = true; throw Error(`synthetic ${f.readFailure} 503`); }
      return structuredClone(events);
    }, append,
  };
  const leaseStore = {
    acquire(args) {
      if (lease && Date.parse(lease.deadline) > Date.parse(args.now)) return { acquired: false, existing: lease };
      lease = { ...args }; return { acquired: true };
    },
    release({ leaseId }) { if (lease?.leaseId === leaseId) lease = null; },
    read() { return lease; },
  };
  const remediationSurface = {
    async dispatch(args) {
      refused = false;
      if (f.admission && activeFault()) {
        refused = true;
        inspect(`admission:${f.admission}`);
        // A typed refusal is deliberately returned, not thrown: the baseline
        // must expose executors that count a requested launch as admitted work.
        return { admitted: false, reason: f.admission };
      }
      if (f.dirtyTerminal && !salvaged) { refused = true; return { admitted: false, reason: 'branch-held-by-terminal-dirty-launch' }; }
      const launch = { id: `launch-${++serial}`, head: args.revisionRef, status: 'admitted', verified: false };
      launches.push(launch);
      const startAt = clock.now + pressure.timeout(f.slowStart ? 1800 : 50);
      if (startAt < bound) clock.at(startAt, 'runtime:running', () => { launch.status = 'running'; launch.verified = true; });
      const endAt = startAt + pressure.timeout(100);
      if (endAt < bound) clock.at(endAt, 'runtime:outcome', () => {
        launch.status = f.agentOutcome ?? 'completed'; launch.verified = false;
        if (!f.agentOutcome) {
          blocking = 0; comments = 0; checks = 'success';
          emit('checks_settled', { revisionRef: args.revisionRef, conclusion: checks, requiredChecksPresent: true, sourceRef: 'synthetic:repaired-checks' });
          emit('verdict_recorded', { revisionRef: args.revisionRef, stageId: 'review', role: 'independent-reviewer', verdictKind: 'approved', sourceRef: 'synthetic:rereview' });
        }
        if (f.agentOutcome) emit('worker_killed', { operationId: args.idempotencyKey, cause: f.agentOutcome, sourceRef: `synthetic:kill:${launch.id}`, idempotencyKey: `kill:${launch.id}` });
        else emit('work_consumed', { workId: launch.id, operationId: args.idempotencyKey, outcome: 'completed', sourceRef: `synthetic:work:${launch.id}`, idempotencyKey: `work:${launch.id}` });
        emit('remediation_concluded', { revisionRef: args.revisionRef, stageId: 'review', round: args.round,
          outcome: f.agentOutcome ? 'failed' : 'completed' });
      });
      return { admitted: true, launchId: launch.id, admittedAt: clock.iso() };
    },
  };
  const mergeSurface = {
    name: 'synthetic-github',
    async merge({ revisionRef }) {
      if (revisionRef !== head) return { ok: false, reason: 'head-moved' };
      if (!repairedConflict && f.mergeability && (f.mergeability !== 'UNKNOWN' || activeFault())) return { ok: false, reason: f.mergeability };
      if (f.primaryEvidence === false || f.mergeFailure) return { ok: false, reason: 'synthetic-evidence-unavailable' };
      if (!merged) {
        merges.push({ revision: revisionRef, liveHead: head, blocking, comments, base });
        merged = true;
        inspect('github:merge-effect');
        if (f.mergeCrash) throw Error('synthetic crash after merge before ledger append');
      }
      return { ok: true, via: 'synthetic-receipt' };
    },
  };
  let routedOwner = 'v2';
  function executor(holder) {
    return createFinalizationExecutor({ ledgerStore, leaseStore, enabled: true, holder,
      generateLeaseId: () => `lease-${++serial}`, leaseTtlMs: pressure.timeout(500),
      policy,
      adjudicateSurface: mergeSurface, remediationSurface,
      liveSurface: { async read() { return { state: merged ? 'merged' : 'open', head, base,
        mergedRevision: head, principal: f.merged ? 'synthetic-human' : 'synthetic-bot', planRequired: true,
        sourceRef: 'synthetic:live-pr' }; } },
      pageSurface: { async deliver({ idempotencyKey }) {
        if (!causes.includes(idempotencyKey)) causes.push(idempotencyKey);
        if (!pages.includes(idempotencyKey)) pages.push(idempotencyKey);
        return { delivered: true, sourceRef: `synthetic:page:${idempotencyKey}` };
      } },
      deliverySurface: { async reconcile() {
        if (activeFault()) return { planRunId: 'synthetic-plan', activation: 'pending', sourceRef: 'synthetic:pma-pending' };
        activated = true; deployed = true;
        return { planRunId: 'synthetic-plan', activation: 'verified', sourceRef: 'synthetic:pma-verified' };
      } },
      recoverySurface: { async reconcile({ decision }) {
        if (decision.nextAction === 'recover-custody') {
          salvaged = true;
          emit('custody_patch_recorded', { custodySourceRef: decision.custody.sourceRef, patchRef: 'synthetic:durable-patch',
            sourceRef: 'synthetic:salvage', idempotencyKey: `salvage:${decision.custody.sourceRef}` });
          return { ok: true, sourceRef: 'synthetic:teardown', custodySourceRef: decision.custody.sourceRef,
            patchRef: 'synthetic:durable-patch', teardown: 'completed', successor: 'synthetic-successor' };
        }
        if (['conflict-rebase', 'merge-main'].includes(decision.nextAction)) {
          repairedConflict = true;
          emit('mergeability_observed', { revisionRef: head, mergeability: 'MERGEABLE', sourceRef: 'synthetic:conflict-repair', idempotencyKey: 'conflict-repair' });
        }
        if (decision.operationId) {
          const operation = fold(events).workflow.operations[decision.operationId];
          if (operation && !operation.observation) emit('operation_observed', { operationId: decision.operationId,
            outcome: 'absent', result: { sourceRef: 'synthetic:effect-readback' }, sourceRef: 'synthetic:effect-readback', idempotencyKey: `readback:${decision.operationId}` });
        }
        return { ok: false, reason: 'synthetic:recovery-pending', sourceRef: 'synthetic:recovery' };
      } },
      identitySurface: { async check() {
        if (f.hcpBounce && activeFault()) throw Error('synthetic HCP 503');
        if (f.headRace && !headRaced) {
          headRaced = true;
          head = 'revision-B';
          observe();
        }
        return { ok: true };
      } },
      laneRouting: { async run({ legacy }) {
        if (routedOwner !== holder) return { ok: false, reason: 'owner-fenced' };
        queueState = foldQueue([{ type: 'acknowledged', entry: { entryId: 'synthetic-entry', candidate: head, base } }], queueState);
        return legacy();
      } },
    });
  }
  let exec = executor('v2');
  observe();
  if (f.mergeability) emit('mergeability_observed', { revisionRef: head, mergeability: f.mergeability, sourceRef: 'synthetic:mergeability', idempotencyKey: 'mergeability' });
  if (f.dirtyTerminal) emit('launch_custody_observed', { revisionRef: head, sourceRef: 'synthetic:custody', idempotencyKey: 'custody', custody: {
    repository: 'synthetic/project', prNumber: 1, launchRequestId: 'synthetic-terminal', state: 'workspace',
    at: clock.iso(), freshnessSeconds: 180, launchLiveness: 'terminal', dirty: true } });
  if (f.exhausted) emit('budget_exhausted', { stageId: 'review' });
  if (f.hold) emit('operator_override', { overrideKind: 'halt', principal: 'synthetic-operator', reason: 'explicit operator hold' });
  if (f.rearm) emit('escalated', { reason: 'prior-episode' });
  if (f.move || f.baseMove) clock.at(pressure.timeout(400), 'github:head-or-base-move', () => {
    if (f.move) head = 'revision-B';
    if (f.baseMove) base = 'base-B';
    checks = 'success';
    observe();
  });
  if (f.rollback) clock.at(pressure.timeout(25), 'rollback:adopt-mid-decision', async () => {
    const state = fold(events);
    const pending = eligible(state, policy, { observedAt: clock.iso(), load: loadObservation });
    rollbackReceipt = { pending, events: structuredClone(events), state: foldFrom(fold(events.slice(0, 2)), events.slice(2)), queue: structuredClone(queueState) };
    routedOwner = 'v1';
    // Synthetic v1 adopter consumes the same durable budget/decision, with a
    // fence at the routing boundary. Never import or modify production v1.
    await exec.execute(pending, { subject, observedAt: clock.iso(), basis: { eventCount: state.eventCount } });
    exec = executor('v1');
  });
  // Snapshot latency scales too. Delay completion as discrete events rather
  // than sleeping. Poll scheduling and the absolute bound never slide.
  for (let at = 0; at < bound; at += pressure.timeout(250)) {
    const delay = Math.ceil((f.slowRead ? 300 : 10) * load * (1 + clock.random() / 4));
    if (at + delay >= bound) continue;
    clock.at(at + delay, 'snapshot:completed', async () => {
      let state;
      try {
        state = fold(ledgerStore.read());
      } catch (error) {
        if (!f.readFailure) throw error;
        await exec.tick(subject, { observedAt: clock.iso(), load: loadObservation });
        inspect(`retryable-read:${error.message}`);
        return;
      }
        decision = eligible(state, policy, { observedAt: clock.iso(), load: loadObservation });
        const outcomes = f.race
          ? await Promise.all([exec.tick(subject, { observedAt: clock.iso(), load: loadObservation }), executor('rival').tick(subject, { observedAt: clock.iso(), load: loadObservation })])
          : [await exec.tick(subject, { observedAt: clock.iso(), load: loadObservation })];
        for (const outcome of outcomes) inspect(`executor:${outcome.status}:${outcome.action}:${outcome.reason ?? ''}`);
    });
  }
  clock.at(bound, 'absolute-bound', () => {});
  await clock.run(inspect);
  const state = fold(events);
  const unmet = [];
  if ((f.mergeability === 'DIRTY' || f.mergeability === 'CONFLICTING') && !merged) unmet.push('conflict-repair-owner');
  if (f.dirtyTerminal && !salvaged) unmet.push('dirty-work-salvaged-and-released');
  if (f.rearm && !state.finalized) unmet.push('automatic-rearm');
  if (!activated && !pages.length) unmet.push('activation-proof');
  if (!deployed && !pages.length) unmet.push('loaded-build-proof');
  if (f.primaryEvidence === false && !pages.length) unmet.push('primary-change-proof-recovery');
  return { id: scenario.id, load, failed: [...failed].sort(), unmet, terminal: snapshot().terminal,
    trace, events, merges, launches, readFailed, transientCharges, rollbackReceipt, queueState };
}
