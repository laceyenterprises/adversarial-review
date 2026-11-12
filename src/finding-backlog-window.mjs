export function findingBacklogMaxAgeMs(env = process.env) {
  const value = Number(env.ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS ?? 48 * 3600000);
  if (!Number.isSafeInteger(value) || value < 1) throw Error('invalid ADVERSARIAL_FINDINGS_BACKLOG_MAX_AGE_MS');
  return value;
}
