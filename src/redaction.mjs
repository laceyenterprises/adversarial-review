// Shared redaction patterns + helpers for any text the remediation loop
// surfaces to durable / public artifacts. Worker-written content is
// untrusted: a remediation worker has access to repo contents, logs, and
// generated artifacts, so any field it produces (final-message, reply
// summary, validation entries, blockers, rereview reason) could echo a
// token, secret-bearing config line, private stack trace, or customer
// data. Apply this redaction *before* writing such text to the review
// ledger, the JSON queue, or the PR comment poster.

const REDACTION_PATTERNS = [
  // Anthropic must come BEFORE the generic sk- pattern; otherwise the
  // OpenAI rule swallows `sk-ant-…` first and we lose the more
  // specific label.
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED_ANTHROPIC_TOKEN]'],
  [/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED_OPENAI_TOKEN]'],
  [/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bBearer\s+[A-Za-z0-9._-]+\b/gi, 'Bearer [REDACTED]'],
  [/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[:=]\s*\S+/gi, (match) => {
    const [label] = match.split(/[:=]/, 1);
    return `${label}=[REDACTED]`;
  }],
  [/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
];

function redactSensitiveText(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// Redact + collapse whitespace + cap length. The whitespace-collapse is
// historical (matches the existing summarizeWorkerFinalMessage shape so
// final-message previews and PR-comment previews look the same to an
// operator) but for free-text fields like the worker's `summary` we want
// to preserve newlines so paragraphs render as paragraphs in the PR
// comment. Use `redactAndCap` for that — preserves structure, just
// redacts and caps.
function redactAndCap(text, limit = 2000) {
  const redacted = redactSensitiveText(text);
  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, limit - 1)}…`;
}

// Redact a worker-supplied list (validation steps, blockers). Drops
// non-string and empty entries, redacts each remaining entry, caps each
// entry's length, and caps the total list size so a malicious or
// runaway worker can't post a 50-MB markdown comment.
function redactBulletList(items, { perItemLimit = 400, maxItems = 25 } = {}) {
  const arr = Array.isArray(items) ? items : [];
  return arr
    .filter((s) => typeof s === 'string' && s.trim())
    .slice(0, maxItems)
    .map((s) => redactAndCap(String(s).trim(), perItemLimit));
}

export {
  REDACTION_PATTERNS,
  redactSensitiveText,
  redactAndCap,
  redactBulletList,
};
