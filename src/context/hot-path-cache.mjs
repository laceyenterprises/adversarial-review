export function invalidationReasonForGrounding(previous, next) {
  const providers = new Set([
    ...Object.keys(previous?.providers || {}),
    ...Object.keys(next?.providers || {}),
  ]);
  for (const provider of providers) {
    const before = previous?.providers?.[provider] || {};
    const after = next?.providers?.[provider] || {};
    if (Boolean(before.hardGrounded) !== Boolean(after.hardGrounded)) return 'hard-grounding';
    if (Boolean(before.softGrounded) !== Boolean(after.softGrounded)) return 'soft-grounding';
  }
  return null;
}
