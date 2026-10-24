export const handoffHead = 'b'.repeat(40);
export const reviewHead = 'a'.repeat(40);
export const handoffTime = n => new Date(Date.parse('2026-10-23T00:00:00Z') + n * 1000).toISOString();
export function queueHandoffFixture(prNumber = 101) {
  const worker = { workerId: 'builder-1', workerClass: 'builder', launchRequestId: 'build-1' };
  const closer = { workerId: 'closer-1', workerClass: 'closer', launchRequestId: 'close-1' };
  const h = { schemaVersion: 1, lane: { repository: 'example/review', base: 'main' }, prNumber,
    head: handoffHead, admissionGeneration: 1, handoffId: `handoff:${prNumber}`, worker, closer,
    sourceReview: { id: 'review-1', commitId: reviewHead }, attestations: { produced: 'produced:1', reviewed: 'reviewed:1' },
    primaryChange: { intent: 'Preserve the requested change', sourceRef: 'intent:1' },
    localValidation: { head: handoffHead, sourceRef: 'validation:1' },
    publication: { head: handoffHead, sourceRef: 'push:1' },
    dispositions: [
      { findingId: 'finding-1', reviewId: 'review-1', reviewCommitId: reviewHead, severity: 'blocking',
        resolution: 'fixed', head: handoffHead, sourceRef: 'fix:1', paths: ['src/example.mjs'],
        evidence: '```text\nnode test/example.mjs: passed\n```' },
      { findingId: 'finding-2', reviewId: 'review-1', reviewCommitId: reviewHead, severity: 'non-blocking',
        resolution: 'withdrawn', head: handoffHead, sourceRef: 'adjudication:1',
        explanation: 'The cited source already handles this input.', sourceLocations: [{ path: 'src/example.mjs', line: 12 }],
        evidence: '```js\nif (input === null) return;\n```' },
    ] };
  const currency = { reviewedHead: reviewHead, currentHead: handoffHead, current: true, proof: 'ancestry', sourceRef: 'compare:1' };
  const signed = (kind, head) => ({ schema_version: 1, repo: h.lane.repository, pr_number: prNumber, head_sha: head,
    kind, producer_identity: kind === 'produced' ? 'closer-app' : 'reviewer-app',
    payload: kind === 'produced' ? { launch_request_id: closer.launchRequestId, worker_class: closer.workerClass } : {},
    signature: { algorithm: 'hcp-hmac-sha256:v1', subject: kind === 'produced' ? 'closer-app' : 'reviewer-app', digest: 'synthetic-signature' } });
  const e = { subject: { lane: h.lane, prNumber, head: handoffHead, state: 'open', sourceRef: 'live:1' },
    review: { ...h.sourceReview, reviewerIdentity: 'reviewer-app', complete: true, sourceRef: 'reviews:1', findings: h.dispositions.map(d => ({
      findingId: d.findingId, reviewId: d.reviewId, reviewCommitId: d.reviewCommitId, severity: d.severity,
      sourceRef: d.findingId, currency,
    })) }, currency, identities: { ok: true, worker, closer, sourceRef: 'identity:1' },
    attestations: Object.fromEntries([['produced', handoffHead], ['reviewed', reviewHead]].map(([kind, head]) => [kind,
      { valid: true, ref: h.attestations[kind], sourceRef: 'verified-chain:1', record: signed(kind, head) }])),
    primaryChange: { ...h.primaryChange, head: handoffHead, ok: true },
    localValidation: { ...h.localValidation, ok: true }, publication: { ...h.publication, ok: true } };
  return { h: structuredClone(h), e: structuredClone(e) };
}
