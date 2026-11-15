// Only gh's own stderr error records are signals. Debug request/response bodies,
// stdout, and execFile's content-echoing Error.message are never inspected.
export function ghStderrRateLimitKind(error) {
  if (!error || typeof error !== 'object'
    || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    || error.code === 'ENOBUFS') return null;
  let inDebug = false;
  for (const line of String(error.stderr || '').split(/\r?\n/)) {
    if (/^\* Request at /.test(line)) inDebug = true;
    if (/^\* Request took /.test(line)) { inDebug = false; continue; }
    if (inDebug) continue;
    const protocol = line.match(/^github-rate-limit: (primary|secondary|deferred)$/);
    if (protocol) return protocol[1] === 'deferred' ? 'secondary' : protocol[1];
    if (/^(?:gh: )?HTTP 429: Too Many Requests \(https?:\/\/[^\s()]+\)$/.test(line)) return 'secondary';
    const record = line.match(/^(?:gh: |GraphQL: )?(?:HTTP (?:403|429): )?(API rate limit exceeded(?: for (?:user ID )?[a-zA-Z0-9_.:@-]+)?\.?|You have exceeded a secondary rate limit\.?(?: Please wait a few minutes before you try again\.)?|You have exceeded a secondary rate limit and have been temporarily blocked from content creation\. Please retry your request again later\.)(?: \((?:https?:\/\/[^\s()]+|HTTP (?:403|429)|rateLimit)\))?$/);
    if (record) return 'secondary'; // No remaining header: primary balance is unknown.
  }
  return null;
}
