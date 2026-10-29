// Refusal evidence, never authorization. Merge gates still verify the operator.
export function operatorLabelInputs(attempt) {
  const labels = new Set((Array.isArray(attempt?.awaitedInputs) ? attempt.awaitedInputs : [])
    .filter(input => input?.kind === 'operator-label' && typeof input.label === 'string')
    .map(input => input.label.trim()).filter(Boolean));
  const evidence = [attempt?.reason, attempt?.predicate, ...(attempt?.reasons || []),
    ...(attempt?.eligibilityTrace?.reasons || []), ...(attempt?.githubGate?.reasons || []),
    attempt?.closingStatus, attempt?.next].filter(value => typeof value === 'string').join('\n');
  for (const match of evidence.matchAll(/operator-label-required:([a-z0-9][a-z0-9._-]*)/gi)) labels.add(match[1].replace(/\.+$/, ''));
  // Legacy activation refusals name this requirement in their terminal note.
  // Do not infer a requirement from a bare mention of an approval label.
  if (evidence.split('\n').some(line => /\bactivation[- ]gate\b/i.test(line)
    && /\b(?:requires?|needs?|awaiting|missing)\s+(?:(?:the|an?)\s+)?(?:operator[- ]approval\s+)?(?:label\s+)?`?operator-approved`?\b/i.test(line))) {
    labels.add('operator-approved');
  }
  return [...labels].sort().map(label => ({ kind: 'operator-label', label }));
}

export function awaitedOperatorLabelsApplied(stop, prMetadata, headSha) {
  const inputs = operatorLabelInputs(stop?.refusal || stop);
  if (!inputs.length || stop?.headSha !== headSha || prMetadata?.headSha !== headSha
    || !(prMetadata?.isOpen === true || String(prMetadata?.state).toUpperCase() === 'OPEN')
    || prMetadata?.isOpen === false || (prMetadata?.state && String(prMetadata.state).toUpperCase() !== 'OPEN')
    || !Array.isArray(prMetadata.labels)) return false;
  const labels = new Set(prMetadata.labels.map(label => typeof label === 'string' ? label : label?.name));
  return inputs.every(input => labels.has(input.label));
}
