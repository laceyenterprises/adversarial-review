import { redactPublicSafeText } from './adapters/comms/github-pr-comments/redaction.mjs';

const STARTUP_WARNING = /^(?:under-development features enabled:|code mode is enabled in configuration, but model\b)/i;
const AUTH_REJECTION = /\b(?:http|status(?: code)?|response|error)[\s:=]+(?:401|403)\b|\b(?:401 unauthorized|403 forbidden|invalid_grant|not logged in|login required|failed to refresh (?:the )?(?:oauth |access )?token)\b/i;

function terminalEventMessage(stdout) {
  let terminal;
  let itemError;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = event?.type === 'turn.failed' ? event.error?.message
      : event?.type === 'error' ? (event.error?.message || event.message)
      : event?.type === 'item.completed' && event.item?.type === 'error' ? event.item.message : null;
    if (typeof message !== 'string' || !message.trim() || STARTUP_WARNING.test(message.trim())) continue;
    if (event.type === 'item.completed') itemError = message;
    else terminal = message;
  }
  return terminal || itemError;
}

function redactDiagnostic(text, limit) {
  const stripped = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  return redactPublicSafeText(stripped
    .replace(/("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret|authorization)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[REDACTED_JWT]')
    .replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim(), limit);
}

export function summarizeCodexReviewExecFailure(err) {
  // The spawn wrapper's message embeds both streams. Use only its exit summary
  // and select diagnostics from the original streams before applying log limits.
  const command = String(err.message || 'Command failed').split('\n', 1)[0];
  const event = terminalEventMessage(err.stdout);
  const stderrLines = String(err.stderr || '').split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !STARTUP_WARNING.test(line) && !/^(?:\S+ )?(?:WARN|INFO|DEBUG|TRACE)\b/.test(line));
  const stderr = stderrLines.findLast(line => /(?:^|\s)(?:ERROR|Error:)|^dyld(?:\[|:)/.test(line))
    || (!event ? stderrLines.at(-1) : null);
  const messages = [...new Set([event, stderr].filter(Boolean))];
  return {
    authRejected: [command, ...messages].some(message => AUTH_REJECTION.test(message)),
    diagnostic: [redactDiagnostic(command, 160),
      ...messages.map(message => redactDiagnostic(message, 320))].join(' | '),
  };
}
