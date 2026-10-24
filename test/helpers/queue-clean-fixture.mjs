import { queueHandoffFixture } from './queue-handoff-fixture.mjs';
export function queueCleanFixture(pr = 102) {
  const { h, e } = queueHandoffFixture(pr);
  h.sourceReview.commitId = h.head;
  delete h.closer; delete h.dispositions;
  h.handoffId = `clean:${pr}`;
  e.review.commitId = h.head; e.review.findings = []; e.review.verdict = 'settled-success';
  e.currency = { reviewedHead: h.head, currentHead: h.head, current: true, proof: 'exact-head', sourceRef: 'exact:1' };
  delete e.identities.closer;
  e.attestations.produced.record.payload = { launch_request_id: h.worker.launchRequestId, worker_class: h.worker.workerClass };
  e.attestations.reviewed.record.head_sha = h.head;
  return { h, e };
}
export function queueLiveFixture(h) {
  return { subject: { lane: h.lane, prNumber: h.prNumber, head: h.head, baseSha: 'c'.repeat(40),
    state: 'open', labels: [], sourceRef: 'live:1' },
    identity: { ok: true, sourceRef: 'live-identity:1' }, permission: { canPush: true, sourceRef: 'rights:1' },
    structuralSourceRef: 'rules:1', eligibility: { mergeable: 'MERGEABLE', requiredChecks: false,
      branchProtectionRequired: false, primaryChange: { headSha: h.head, hasHammerCommits: false } },
    currentReview: { ...h.sourceReview, complete: true, sourceRef: 'final-review:1', verdict: 'settled-success', findings: [] } };
}
