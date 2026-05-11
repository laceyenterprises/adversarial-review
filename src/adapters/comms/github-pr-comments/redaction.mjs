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

// Mask host-local filesystem paths before writing to a public surface
// (PR comments, GitHub issue bodies). Internal exception messages
// commonly include absolute paths like
// `/Users/airlock/agent-os/tools/.../foo.json` or
// `/private/var/folders/.../tmp.X/data.json`. Publishing those leaks
// the operator's username, the repo's filesystem layout, and the
// host's homedir convention. We replace the path with a stable
// `<path-redacted>/<basename>` token that preserves enough info for
// an operator to recognize the file (the basename) without exposing
// the rest of the layout.
function redactPathlikeText(text) {
  let out = String(text ?? '');
  // Order matters: the more-specific patterns run first so a
  // `/private/var/folders/...` path doesn't get prematurely matched
  // as `/private/...`. The basename extraction relies on the path
  // ending at whitespace or a non-path character.
  const PATH_PATTERNS = [
    // /Users/<user>/...           — macOS user homedir
    /\/Users\/[^/\s]+\/(?:[^/\s]+\/)*([^/\s]+)/g,
    // /private/var/folders/.../... — macOS sandboxed temp dirs
    /\/private\/var\/folders\/(?:[^/\s]+\/)*([^/\s]+)/g,
    // /var/folders/.../...         — same path without /private prefix
    /\/var\/folders\/(?:[^/\s]+\/)*([^/\s]+)/g,
    // /tmp/<hash>/...              — generic temp dir under /tmp
    /\/tmp\/(?:[^/\s]+\/)+([^/\s]+)/g,
    // /home/<user>/...             — Linux user homedir
    /\/home\/[^/\s]+\/(?:[^/\s]+\/)*([^/\s]+)/g,
  ];
  for (const pattern of PATH_PATTERNS) {
    out = out.replace(pattern, (_match, basename) => `<path-redacted>/${basename}`);
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
//
// Token redaction AND path masking both apply here: worker-supplied
// fields can contain log-line echoes that include either kind of leak
// (e.g. `failed at /Users/airlock/.../foo.json` or `Bearer eyJ...`).
// PR #18 round 6 flagged the path-redaction gap on these fields; both
// need to run before the value is fenced/posted.
function redactAndCap(text, limit = 2000) {
  const tokenSafe = redactSensitiveText(text);
  const pathSafe = redactPathlikeText(tokenSafe);
  if (pathSafe.length <= limit) return pathSafe;
  return `${pathSafe.slice(0, limit - 1)}…`;
}

// Combined token + filesystem-path redaction for worker-supplied text
// that crosses the trust boundary into a public PR comment. A worker
// runs inside a checked-out workspace and reads logs / artifacts /
// stack traces, so its `summary`, `validation`, `blockers`, and
// `reReview.reason` fields can echo `/Users/<operator>/...`,
// `/private/var/folders/...`, or similar host-local paths verbatim.
// Republishing those leaks operator usernames, repo layout, and
// machine-local filesystem details to every PR reader.
//
// Order: tokens first, then paths. A token-shaped substring inside a
// path (rare but possible — e.g. a temp dir whose name happens to
// match `sk-...`) is masked to its label before path masking sees it.
function redactPublicSafeText(text, limit = 2000) {
  const redacted = redactPathlikeText(redactSensitiveText(text));
  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, limit - 1)}…`;
}

// Redact a worker-supplied list (validation steps, blockers). Drops
// non-string and empty entries, redacts each remaining entry, caps each
// entry's length, and caps the total list size so a malicious or
// runaway worker can't post a 50-MB markdown comment.
//
// Public-safe: applies BOTH token redaction and host-path redaction so
// validation/blockers entries posted to the PR can't leak filesystem
// layout. The `redactItem` seam is left in case a non-public caller
// needs token-only redaction; default is the public-safe path.
function redactBulletList(items, { perItemLimit = 400, maxItems = 25, redactItem = redactPublicSafeText } = {}) {
  const arr = Array.isArray(items) ? items : [];
  return arr
    .filter((s) => typeof s === 'string' && s.trim())
    .slice(0, maxItems)
    .map((s) => redactItem(String(s).trim(), perItemLimit));
}

export {
  REDACTION_PATTERNS,
  redactSensitiveText,
  redactPathlikeText,
  redactPublicSafeText,
  redactAndCap,
  redactBulletList,
};
