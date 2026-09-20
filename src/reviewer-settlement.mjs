function reviewSettlementStatusForResult(result = {}) {
  if (result.ok) return 'completed';
  if (result.failureClass === 'github-review-create-transient') return 'retry';
  return 'failed';
}

export { reviewSettlementStatusForResult };
