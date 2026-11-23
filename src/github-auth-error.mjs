export function ghErrorDetail(err) {
  if (typeof err === 'string') return err;
  return [err?.stderr, err?.stdout, err?.message]
    .filter(Boolean)
    .join('\n');
}

// A rejected GitHub credential can be reminted. A 403 generally indicates
// permissions or rate limits on a valid token, so it does not qualify.
export function isGhAuthFailure(err) {
  const detail = ghErrorDetail(err).toLowerCase();
  return /\bbad credentials\b/.test(detail)
    || /\bhttp\s*401\b/.test(detail)
    || /\b401\b[^\n]*\bunauthorized\b/.test(detail)
    || /\bunauthorized\b[^\n]*\b401\b/.test(detail)
    || /\brequires authentication\b/.test(detail)
    || /\bauthentication (?:failed|required)\b/.test(detail)
    || /\btoken (?:has )?expired\b/.test(detail);
}
