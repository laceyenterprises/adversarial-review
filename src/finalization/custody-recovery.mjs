import { fold } from './ledger-fold.mjs';
import { makeFinalizationEvent } from './ledger-events.mjs';

// Host composition supplies its existing holder probe, patch writer, teardown
// and successor handoff. This adapter owns ordering and durable salvage proof;
// it never invents a successful teardown or infers death from elapsed time.
export function createCustodyRecovery({ ledgerStore, probeHolder, salvagePatch, acceptPatch, teardown }) {
  return { async reconcile(request) {
    const { subject, decision, signal, observedAt } = request;
    const observation = decision.custody;
    const c = observation?.custody;
    const defer = reason => ({ ok: false, reason, sourceRef: observation?.sourceRef });
    if (!c?.worktree || !c.branch || ![probeHolder, salvagePatch, acceptPatch, teardown].every(fn => typeof fn === 'function')) {
      return defer('custody-recovery-capability-unavailable');
    }
    const assertActive = () => { if (signal?.aborted) throw new Error('custody recovery aborted; reconcile effects'); };
    const identity = { repository: c.repository, prNumber: c.prNumber, launchRequestId: c.launchRequestId,
      worktree: c.worktree, branch: c.branch };
    const matches = value => value?.sourceRef && Object.entries(identity).every(([key, expected]) => value[key] === expected);
    assertActive();
    const holder = await probeHolder({ ...request, identity });
    if (!matches(holder) || holder.launchLiveness !== 'terminal' || holder.operationsDrained !== true) {
      return defer('exact-terminal-holder-not-proven');
    }
    let patch = fold(ledgerStore.read(subject)).workflow.patches[observation.sourceRef];
    if (!patch) {
      assertActive();
      const saved = await salvagePatch({ ...request, identity, idempotencyKey: `salvage:${observation.sourceRef}` });
      if (!saved?.patchRef || !saved.sourceRef || saved.durable !== true || saved.includesUntracked !== true
        || saved.includesUnpushed !== true) return defer('complete-durable-patch-unavailable');
      // Commit salvage BEFORE teardown so an interrupted release retains WIP.
      patch = ledgerStore.append(makeFinalizationEvent('custody_patch_recorded', subject, {
        at: observedAt, sourceRef: saved.sourceRef, idempotencyKey: `salvage:${observation.sourceRef}`,
        custodySourceRef: observation.sourceRef, patchRef: saved.patchRef,
      }));
    }
    assertActive();
    const successor = await acceptPatch({ ...request, identity, patchRef: patch.patchRef,
      idempotencyKey: `handoff:${observation.sourceRef}` });
    if (!successor?.owner || !successor.sourceRef || successor.accepted !== true) return defer('patch-handoff-unacknowledged');
    assertActive();
    // Probe again after the asynchronous handoff. A resumed/replaced holder
    // cannot be released using the earlier terminal observation.
    const current = await probeHolder({ ...request, identity });
    if (!matches(current) || current.launchLiveness !== 'terminal' || current.operationsDrained !== true) {
      return defer('holder-changed-before-teardown');
    }
    assertActive();
    const released = await teardown({ ...request, identity, patchRef: patch.patchRef,
      successor: successor.owner, idempotencyKey: `teardown:${observation.sourceRef}` });
    if (!matches(released) || released.outcome !== 'completed' || released.branchReleased !== true) {
      return defer('teardown-held-or-failed');
    }
    return { ok: true, sourceRef: released.sourceRef, custodySourceRef: observation.sourceRef,
      patchRef: patch.patchRef, successor: successor.owner, teardown: 'completed' };
  } };
}
