// Model organic terminal receipts in an isolated database. These fixtures never
// establish deployment evidence; the rollout readers still enforce MLR-04.
export function seedQueuePromotionFinalizations(shadow, { lane, head, now, count = 50 }) {
  for (let i = 0; i < count; i++) {
    const sourceRef = `fixture:terminal:${i}`;
    shadow.append({
      subjectKey: { domainId: 'code-pr', subjectExternalId: `${lane.repository}#${1000 + i}` },
      revisionRef: head, observedAt: now,
      classification: { relation: 'agree', direction: 'benign', disposition: 'resolved' },
      v1Action: { kind: 'merged', sourceRef }, v2Decision: { kind: 'finalize-now' },
      live: { source: 'organic', lane, sourceRef, terminalOutcome: 'merged' },
      sawHeadMove: i === 0, sawExhaustion: i === 0,
    });
  }
}
