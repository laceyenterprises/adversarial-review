const PROVIDER_CONTEXT_RE = /\b(?:provider|model|backend|upstream|server|service|anthropic|claude|openai|codex|gemini|api)\b/i;
const OVERLOAD_FORWARD_RE = /\b(?:provider|model|backend|upstream|server|service|anthropic|claude|openai|codex|gemini|api)\b[\s\S]{0,160}\boverloaded\b/i;
const OVERLOAD_REVERSE_RE = /\boverloaded\b[\s\S]{0,160}\b(?:provider|model|backend|upstream|server|service|anthropic|claude|openai|codex|gemini|api)\b/i;
const CAPACITY_RE = /\b(?:api|service|server|backend|provider|model)\s+(?:is\s+)?(?:at|over)\s+capacity\b/i;

export function hasProviderCapacitySignal(value, { httpStatuses = [529] } = {}) {
  const text = String(value || '');
  const statusPattern = new RegExp(`(?:\\b(?:HTTP|status|API error)\\s*[:=]?\\s*|"(?:status|code)"\\s*:\\s*"?)(?:${httpStatuses.join('|')})\\b`, 'i');
  return statusPattern.test(text)
    || (httpStatuses.includes(529) && /\b529\b/.test(text))
    || /\boverloaded[_ -]?error\b/i.test(text)
    || OVERLOAD_FORWARD_RE.test(text)
    || OVERLOAD_REVERSE_RE.test(text)
    || CAPACITY_RE.test(text)
    || (/\btemporarily\s+overloaded\b/i.test(text) && PROVIDER_CONTEXT_RE.test(text))
    || /\bover\s+capacity\b/i.test(text);
}

// Worker logs are JSONL for Codex and may be plain stderr for Claude/Gemini.
// Examine the tail only so an earlier recovered turn does not control a later exit.
export function hasTerminalProviderCapacitySignal(logText) {
  const lines = String(logText || '').slice(-64 * 1024).split(/\r?\n/).slice(-100);
  for (const line of lines.reverse()) {
    let event;
    try { event = JSON.parse(line); } catch { event = null; }
    if (event && typeof event === 'object') {
      if (event.type === 'turn.failed' || event.type === 'error' || event.error) {
        const diagnostic = JSON.stringify(event);
        return hasProviderCapacitySignal(diagnostic, { httpStatuses: [429, 503, 529] })
          || /\b(?:at capacity|overloaded)\b/i.test(diagnostic);
      }
    } else if (hasProviderCapacitySignal(line, { httpStatuses: [429, 503, 529] })) {
      return true;
    }
  }
  return false;
}
