const PROVIDER_CONTEXT_RE = /\b(?:provider|model|backend|upstream|server|service|anthropic|claude|openai|codex|gemini|api)\b/i;
const OVERLOAD_RE = /\boverloaded(?:[_ -]?error)?\b/i;
const CAPACITY_RE = /\b(?:at|over) capacity\b/i;

export function hasProviderCapacitySignal(value, { httpStatuses = [529] } = {}) {
  const text = String(value || '');
  const statusPattern = new RegExp(`(?:\\b(?:HTTP|status|API error)\\s*[:=]?\\s*|"(?:status|code)"\\s*:\\s*"?)(?:${httpStatuses.join('|')})\\b`, 'i');
  return statusPattern.test(text)
    || (httpStatuses.includes(529) && /\b529\b/.test(text))
    || /\boverloaded[_ -]?error\b/i.test(text)
    || (OVERLOAD_RE.test(text) && PROVIDER_CONTEXT_RE.test(text))
    || (CAPACITY_RE.test(text) && PROVIDER_CONTEXT_RE.test(text));
}

// Worker logs are JSONL for Codex and may be plain stderr for Claude/Gemini.
// Examine the tail only so an earlier recovered turn does not control a later exit.
export function hasTerminalProviderCapacitySignal(logText) {
  const lines = String(logText || '').slice(-64 * 1024).split(/\r?\n/).slice(-100);
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { event = null; }
    if (event && typeof event === 'object') {
      if (event.type === 'turn.failed' || event.type === 'error' || event.error) {
        const diagnostic = JSON.stringify(event);
        if (hasProviderCapacitySignal(diagnostic, { httpStatuses: [429, 503, 529] })
          || /\b(?:at capacity|overloaded)\b/i.test(diagnostic)) return true;
      }
    } else if (hasProviderCapacitySignal(line, { httpStatuses: [429, 503, 529] })) {
      return true;
    }
  }
  return false;
}
