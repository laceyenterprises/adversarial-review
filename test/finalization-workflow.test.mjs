import assert from 'node:assert/strict';
import test from 'node:test';
import { fold, foldFrom } from '../src/finalization/ledger-fold.mjs';
import { makeFinalizationEvent } from '../src/finalization/ledger-events.mjs';
import { eligible } from '../src/finalization/eligibility.mjs';
import { projectWorkflow } from '../src/finalization/workflow-decision.mjs';
import { createWorkflowEffects } from '../src/finalization/workflow-effects.mjs';

const subject = { domainId: 'code-pr', subjectExternalId: 'example/project#5' };
const at = n => new Date(Date.UTC(2030, 0, 1) + n).toISOString();
const event = (type, fields, n = 0) => makeFinalizationEvent(type, subject, {
  at: at(n), sourceRef: `fixture:${type}:${n}`, idempotencyKey: `${type}:${n}`, ...fields,
});
const clean = () => [event('revision_advanced', { revisionRef: 'A' }),
  provenance({}),
  event('checks_settled', { revisionRef: 'A', conclusion: 'success', requiredChecksPresent: true }),
  event('verdict_recorded', { revisionRef: 'A', verdictKind: 'approved', stageId: 'review', role: 'independent' })];
const decide = (events, n = 100, policy = {}, load = {}) => eligible(fold(events), {
  checksPatienceMs: 1000, verdictPatienceMs: 1000, attestationPatienceMs: 1000,
  deadlineCeilingMs: 4000, ...policy,
}, { observedAt: at(n), load });
const provenance = fields => event('provenance_observed', { revisionRef: 'A', builderBoundary: 'builder-A',
  primaryChange: 'preserved', hammerCommits: false, mergeMain: false, ...fields });
const custody = fields => event('launch_custody_observed', { revisionRef: 'A', custody: {
  repository: 'example/project', prNumber: 5, launchRequestId: 'fixture-launch', state: 'workspace',
  at: at(0), freshnessSeconds: 180, launchLiveness: 'terminal', dirty: true, ...fields,
} });

test('terminal dirty holder selects salvage; expired or clean holder still needs release evidence', () => {
  const events = [...clean(), custody()];
  assert.equal(decide(events).nextAction, 'recover-custody');
  assert.equal(decide(events, 180001).nextAction, 'reconcile-custody');
  assert.equal(decide([...clean(), custody({ dirty: false })]).nextAction, 'reconcile-custody');
  assert.equal(decide([...clean(), custody({ launchLiveness: 'live' })]).nextAction, 'reconcile-custody');
});
test('PID or a running record without progress cannot become an agent owner', () => {
  const noProof = decide([...clean(), custody({ state: 'running', pid: 42 })]);
  assert.equal(noProof.owner.kind, 'workflow');
  const live = decide([...clean(), custody({ state: 'running', verified: true, progressRef: 'fixture:progress' })]);
  assert.equal(live.owner.kind, 'agent');
  assert.equal(decide([...clean(), custody({ state: 'running', verified: true, progressRef: 'fixture:progress' })], 180001).owner.kind, 'workflow');
});
test('dirty transfer requires recorded patch, completed teardown and a successor; held is distinct', async () => {
  const events = [...clean(), custody()];
  const ledgerStore = { read: () => events, append: e => events.push(e) };
  let complete = false;
  const custodySourceRef = events.at(-1).sourceRef;
  const effects = createWorkflowEffects({ ledgerStore, recoverySurface: { reconcile: async () => ({
    sourceRef: 'fixture:teardown', custodySourceRef,
    patchRef: 'fixture:patch', successor: 'fixture:successor', teardown: complete ? 'completed' : 'held',
  }) } });
  assert.equal((await effects.recover(subject, decide(events), at(100))).ok, false);
  assert.equal(Object.keys(fold(events).workflow.recoveries).length, 0);
  complete = true;
  assert.equal((await effects.recover(subject, decide(events), at(150))).ok, false);
  events.push(event('custody_patch_recorded', { custodySourceRef, patchRef: 'fixture:patch' }, 160));
  await effects.recover(subject, decide(events), at(200));
  assert.equal(decide(events).nextAction, 'merge');
});
test('merge-main after hammer permanently loses primary proof across heads and later claims', () => {
  const events = [...clean(), provenance({ hammerCommits: true, mergeMain: true }),
    event('revision_advanced', { revisionRef: 'B' }, 1),
    event('provenance_observed', { revisionRef: 'B', builderBoundary: 'builder-A', primaryChange: 'preserved', hammerCommits: true, mergeMain: false }, 2)];
  assert.equal(fold(events).workflow.primaryUnknown, true);
  assert.equal(decide(events).nextAction, 'recover-primary');
});
test('conflict precedes generic CI wait; head provenance chooses conflict repair and merge method', () => {
  const events = [clean()[0], provenance({}), event('mergeability_observed', { revisionRef: 'A', mergeability: 'DIRTY' })];
  assert.equal(decide(events).nextAction, 'conflict-rebase');
  assert.equal(decide([...events, provenance({ hammerCommits: true })]).nextAction, 'merge-main');
  assert.equal(decide([...clean(), provenance({ hammerCommits: true })]).mergeMethod, 'merge');
  assert.equal(decide([...clean(), provenance({})]).mergeMethod, 'squash');
});
test('load sizes once at the episode anchor, replay/polls cannot slide it', () => {
  for (const multiplier of [1, 3, 6]) {
    const events = clean();
    const decision = decide(events, 100, {}, { loadAvg1m: 1 + (multiplier - 1) * 2 / 5, cpuCount: 1, cpuBusyPercent: 100 });
    assert.equal(decision.effectiveMs, Math.min(4000, multiplier * 1000));
    events.push(event('decision_anchored', { episode: decision.episode, anchorAt: decision.anchorAt,
      nominalMs: decision.nominalMs, effectiveMs: decision.effectiveMs, ceilingMs: decision.ceilingMs, policyVersion: 1, codeVersion: decision.codeVersion, loadEvidence: decision.loadEvidence }));
    assert.equal(decide(events, 999, {}, { loadAvg1m: 99, cpuCount: 1 }).deadline, decision.deadline);
    const projection = projectWorkflow(fold(events), decide(events), at(5000));
    assert.equal(projection.overdueMs, 5000 - decision.effectiveMs);
  }
});
test('budget deduplicates useful work identities across heads, stages and kills', () => {
  const work = event('work_consumed', { workId: 'same-work', operationId: 'op-A', outcome: 'completed' });
  const events = [...clean(), work, work, event('worker_killed', { operationId: 'op-A', cause: 'budget-kill' }),
    event('revision_advanced', { revisionRef: 'B' }, 1)];
  assert.equal(Object.keys(fold(events).workflow.work).length, 1);
  assert.equal(fold(events).workflow.kills['op-A'].cause, 'budget-kill');
  assert.throws(() => event('work_consumed', { workId: 'unperformed', operationId: 'op-B', outcome: 'quota-kill' }));
});
test('one subject cap selects final remediation without resetting useful work', () => {
  const events = [...clean(), event('verdict_recorded', { revisionRef: 'A', verdictKind: 'request-changes', stageId: 'review', role: 'independent' }, 1),
    event('work_consumed', { workId: 'work-A', operationId: 'op-A', outcome: 'completed' })];
  assert.equal(decide(events, 100, { subjectRoundCap: 1 }).final, true);
  assert.equal(decide(events, 100, { subjectRoundCap: 2 }).final, undefined);
});
test('unknown future safety facts require refresh; ordinary evidence cannot erase them', () => {
  const events = [...clean(), { type: 'future-safety-fact', at: at(1), subjectKey: subject }];
  assert.equal(decide(events).nextAction, 'refresh-evidence');
  events.push(event('evidence_refreshed', { generation: 'fixture:known-schema' }, 2));
  assert.equal(decide(events).nextAction, 'merge');
});
test('operator hold survives head/code changes until authenticated release', () => {
  const events = [...clean(), event('operator_override', { overrideKind: 'halt', principal: 'fixture-human', reason: 'hold' }),
    event('revision_advanced', { revisionRef: 'B' }, 1)];
  assert.equal(decide(events, 100, { codeVersion: 'new-code' }).nextAction, 'monitor-hold');
});
test('missing provenance cannot merge; automated stops need relevant re-arm', () => {
  const events = clean();
  assert.equal(decide(events.filter(e => e.type !== 'provenance_observed')).nextAction, 'recover-primary');
  events.push(event('halted', { reason: 'repair failed', codeVersion: 'mlr06-v1', policyVersion: 1 }, 1));
  assert.equal(decide(events).nextAction, 'recover-coverage');
  assert.equal(decide(events, 100, { codeVersion: 'replacement' }).nextAction, 'merge');
  events.push(event('checks_settled', { revisionRef: 'A', conclusion: 'success', requiredChecksPresent: true }, 2));
  assert.equal(decide(events).nextAction, 'merge');
  assert.throws(() => event('remediation_concluded', { revisionRef: 'A', round: 1, outcome: 'completed', workId: '__proto__' }));
});
test('PMA receipt must match the actual merge; failed activation never finalizes', () => {
  const events = [...clean(), event('merge_observed', { mergedRevision: 'A', principal: 'fixture-human', planRequired: true })];
  events.push(event('delivery_observed', { mergeSourceRef: 'foreign', planRunId: 'fixture-plan', activation: 'verified' }, 1));
  assert.equal(decide(events).nextAction, 'deliver');
  events.push(event('delivery_observed', { mergeSourceRef: events.find(e => e.type === 'merge_observed').sourceRef, planRunId: 'fixture-plan', activation: 'failed' }, 2));
  assert.equal(decide(events).nextAction, 'deliver');
});
test('every prefix/tail split replays budgets, custody, provenance, delivery and pages exactly', () => {
  const events = [...clean(), custody(), provenance({ hammerCommits: true, mergeMain: true }),
    event('work_consumed', { workId: 'work-A', operationId: 'op-A', outcome: 'findings' }),
    event('worker_killed', { operationId: 'op-A', cause: 'quota' }),
    event('page_delivered', { episode: 'fixture-episode', receipt: 'fixture:page' }),
    event('merge_observed', { mergedRevision: 'A', principal: 'fixture-human', planRequired: true })];
  for (let split = 0; split <= events.length; split++) assert.deepEqual(foldFrom(fold(events.slice(0, split)), events.slice(split)), fold(events));
});

test('custody adapter records WIP before teardown and reuses it after a held release', async () => {
  const { createCustodyRecovery } = await import('../src/finalization/custody-recovery.mjs');
  const events = [...clean(), custody({ worktree: '/fixture/worktree', branch: 'fixture-branch' })];
  const ledgerStore = { read: () => events, append: e => { events.push(e); return e; } };
  const order = [];
  let held = true;
  const identity = { repository: 'example/project', prNumber: 5, launchRequestId: 'fixture-launch', worktree: '/fixture/worktree', branch: 'fixture-branch' };
  const adapter = createCustodyRecovery({ ledgerStore,
    probeHolder: async () => ({ ...identity, sourceRef: 'fixture:probe', launchLiveness: 'terminal', operationsDrained: true }),
    salvagePatch: async () => { order.push('salvage'); return { patchRef: 'fixture:patch', sourceRef: 'fixture:saved', durable: true, includesUntracked: true, includesUnpushed: true }; },
    acceptPatch: async () => { order.push('handoff'); return { accepted: true, owner: 'fixture-successor', sourceRef: 'fixture:handoff' }; },
    teardown: async () => {
      order.push('teardown');
      assert.equal(Object.values(fold(events).workflow.patches)[0].patchRef, 'fixture:patch');
      return { ...identity, sourceRef: 'fixture:teardown', outcome: held ? 'held' : 'completed', branchReleased: !held };
    },
  });
  const request = { subject, decision: decide(events), observedAt: at(100) };
  assert.equal((await adapter.reconcile(request)).ok, false);
  held = false;
  assert.equal((await adapter.reconcile(request)).ok, true);
  assert.deepEqual(order, ['salvage', 'handoff', 'teardown', 'handoff', 'teardown']);
});
test('existing pager acknowledgement and PMA run matching are required', async () => {
  const { createWorkflowPageSurface, createPostMergeDeliverySurface } = await import('../src/finalization/workflow-adapters.mjs');
  const sent = [];
  const pager = createWorkflowPageSurface({ deliver: async (_text, options) => { sent.push(options); return { status: 'pending', id: 'fixture-alert' }; } });
  assert.equal((await pager.deliver({ subject, decision: decide(clean()), idempotencyKey: 'fixture-episode' })).delivered, false);
  assert.equal(sent[0].event, 'finalization.queue.infrastructure');
  assert.equal(sent[0].payload.pr, 5);
  assert.equal(sent[0].payload.head, 'A');
  assert.ok(sent[0].payload.dependency);
  const delivery = createPostMergeDeliverySurface({ handoff: async () => ({ planRunId: 'fixture-plan', sourceRef: 'fixture:admitted' }),
    observe: async () => ({ planRunId: 'foreign-plan', mergeSourceRef: 'fixture:merge', sourceRef: 'fixture:receipt', activation: 'verified' }) });
  assert.equal(await delivery.reconcile({ merge: { sourceRef: 'fixture:merge' } }), null);
});
