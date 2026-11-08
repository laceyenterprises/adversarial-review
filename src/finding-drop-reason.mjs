const DROP_REASON = /^(?:stale-code-changed|already-fixed-in-[1-9]\d*|not-reproducible|out-of-scope-with-ticket|false-positive):[ \t]*\S[^\r\n]*(?:\r?\n.*)?$/s;
// Lifecycle codes written before FINDINGSBATCH-02, rewritten by its migration.
const LEGACY_DROP_REASONS = new Map([
  ['superseded-final-review', 'stale-code-changed: Final posted review superseded this finding'],
  ['pr-closed-without-merge', 'false-positive: Source PR closed without merge; reviewed changes did not land'],
]);
const LEGACY_DROP_CODES = new Map([['stale', 'stale-code-changed'], ['stale-code-changed', 'stale-code-changed'],
  ['not-reproducible', 'not-reproducible'], ['out-of-scope', 'out-of-scope-with-ticket'],
  ['out-of-scope-with-ticket', 'out-of-scope-with-ticket'], ['false-positive', 'false-positive']]);

// Results written before the strict vocabulary can still carry a known code in
// another spelling ("False positive - ...", "already fixed in #12: ...").
// Only an exact code plus a justification maps; anything else is ambiguous and
// returns null, so that finding is re-verified instead of guessed.
export function normalizeDroppedReason(reason) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (DROP_REASON.test(text)) return text;
  if (LEGACY_DROP_REASONS.has(text)) return LEGACY_DROP_REASONS.get(text);
  const legacy = /^([A-Za-z][A-Za-z0-9 _#-]{0,39}?)[ \t]*(?::|\u2014|\u2013|[ \t]-[ \t])[ \t]*(\S[\s\S]*)$/.exec(text);
  if (!legacy) return null;
  const code = legacy[1].trim().toLowerCase().replace(/[\s_]+/g, '-');
  const fixed = /^already-fixed-in-#?([1-9]\d*)$/.exec(code);
  const mapped = fixed ? `already-fixed-in-${fixed[1]}` : LEGACY_DROP_CODES.get(code);
  const normalized = mapped && `${mapped}: ${legacy[2].trim()}`;
  return normalized && DROP_REASON.test(normalized) ? normalized : null;
}

