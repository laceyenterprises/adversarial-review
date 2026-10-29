// Snapshot-only successors also own resolution of receipt/lease references.
// Recognize older unmarked placeholders narrowly; a row/probe or retry payload
// is read evidence and must never be reclassified as a placeholder.
export function isUnresolvedLaunchReference(launches) {
  const closer = launches?.value?.closer;
  return closer?.retryChainUnreadable === true && (closer.retryChainReadState === 'unresolved'
    || (!closer.retryChainReadState && !closer.row && !closer.probe && !closer.retryChain
      && ['closer-lease', 'closer-dispatch-receipt'].includes(launches?.provenance?.sourceRef)));
}
