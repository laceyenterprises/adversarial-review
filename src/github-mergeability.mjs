function normalizeGithubMergeability({ mergeable, mergeStateStatus } = {}) {
  const mergeableValue = String(mergeable || '').trim().toUpperCase();
  const mergeStateStatusValue = String(mergeStateStatus || '').trim().toUpperCase();

  if (mergeableValue === 'MERGEABLE' || mergeableValue === 'CONFLICTING') {
    return mergeableValue;
  }
  if ((!mergeableValue || mergeableValue === 'UNKNOWN') && mergeStateStatusValue === 'CLEAN') {
    return 'MERGEABLE';
  }
  return mergeableValue || mergeStateStatusValue;
}

export { normalizeGithubMergeability };
