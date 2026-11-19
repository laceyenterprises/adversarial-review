import { isGitHubRateLimitError, rateLimitErrorObservation } from '../rate-limit-throttle.mjs';
import { loadAwareTimeoutMs, timerDelayMs } from '../load-aware-timeout.mjs';
import { redactPathlikeText, redactSensitiveText } from '../adapters/comms/github-pr-comments/redaction.mjs';

export const HISTORY_READ_ERROR_LIMIT = 2000;
export const HISTORY_CONTEXT_TIMEOUT_MS = 90_000;

export function historyReadTimeoutError() {
  return Object.assign(new Error('history read context budget exhausted'), {
    name: 'TimeoutError', code: 'HISTORY_READ_TIMEOUT', primaryChangeReadFailed: true,
  });
}

export function historyReadTimeoutEvidence(error) {
  for (let depth = 0; error && depth < 8; depth++, error = error.cause) {
    if (error.code === 'HISTORY_READ_TIMEOUT') return { historyReadTimedOut: true };
  }
  return {};
}

// Own the whole asynchronous operation, including time spent before a child is
// spawned (quota admission/auth/cache) and injected transports ignoring abort.
// Keep the timer referenced: a stalled promise alone does not keep Node alive.
export async function withHistoryReadBudget(operation, {
  signal: parentSignal, timeoutMs = loadAwareTimeoutMs(HISTORY_CONTEXT_TIMEOUT_MS),
} = {}) {
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  let timer, abort;
  try {
    signal.throwIfAborted();
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => controller.abort(historyReadTimeoutError()),
        timerDelayMs(timeoutMs));
    });
    return await Promise.race([interrupted, Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation(signal);
    }).then(result => {
      signal.throwIfAborted();
      return result;
    })]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

function historyHttpResponse(error) {
  const stdout = String(error?.stdout || '');
  const line = /^HTTP\/[\d.]+ [1-5]\d\d[^\r\n]*/.exec(stdout)?.[0];
  const headers = line && stdout.slice(line.length).split(/\r?\n\r?\n/, 1)[0];
  const retryAfter = /(?:^|\n)Retry-After:[ \t]*([^\r\n]+)/i.exec(headers || '')?.[1].trim();
  const status = /\bHTTP(?:\/\d+(?:\.\d+)?)?\s+(\d{3})\b|"status"\s*:\s*(\d{3})/i.exec(
    line || error?.stderr || error?.message || String(error));
  return { line, retryAfter, code: Number(error?.response?.status ?? error?.status ?? status?.[1] ?? status?.[2]) };
}

export function historyReadErrorDetail(error, limit = HISTORY_READ_ERROR_LIMIT) {
  const source = error?.failureClass === 'github-auth-outage' ? error.cause || error : error;
  const redact = text => redactPathlikeText(redactSensitiveText(text)).replace(/\bgithub_pat_\w+/g, '[REDACTED_GITHUB_TOKEN]');
  const stderr = String(source?.stderr || '').trim();
  const message = String(source?.message || source);
  const { line, retryAfter } = historyHttpResponse(source);
  const prefix = [line, retryAfter && `Retry-After: ${retryAfter}`, stderr ? message.replace(stderr, '').trim() : message]
    .filter(Boolean).map(redact).join('\n');
  if (!stderr) return prefix.slice(0, limit);
  const summary = prefix.slice(0, Math.floor(limit / 2));
  return `${summary}\n${redact(stderr).slice(-(limit - summary.length - 1))}`;
}

export function historyReadStopReason(error) {
  const source = error?.failureClass === 'github-auth-outage' ? error.cause || error : error;
  const { code } = historyHttpResponse(source);
  const transient = source?.code === 'HISTORY_READ_TIMEOUT'
    || (!(source instanceof SyntaxError) && historyReadRetryDelayMs(source, 0) !== null);
  const kind = transient ? 'transient' : 'permanent';
  const detail = Number.isInteger(code) ? `http-${code}` : transient ? 'transport' : 'unclassified';
  return `history-read-failed:${kind}:${detail}`;
}

export function historyReadFailureReason(error) {
  const detail = historyReadErrorDetail(error);
  if (error?.code === 'HISTORY_READ_TIMEOUT' && !detail.startsWith('history read failed:')) {
    return `history read failed: history-read-failed:transient:timeout ${detail}`;
  }
  return historyReadErrorDetail(detail.startsWith('history read failed:') ? detail : `history read failed: ${detail}`);
}

// Fail closed on API errors before matching transport words: a permanent API
// response can itself contain words such as "timeout" or "proxy".
export function historyReadRetryDelayMs(error, attempt) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return null;
  // Output overflow can also set killed/SIGTERM; repeating the read cannot fit it.
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error?.code === 'ENOBUFS') return null;
  const detail = [error?.stderr, error?.stdout, typeof error === 'string' ? error : error?.message].filter(Boolean).join('\n');
  const { code, retryAfter } = historyHttpResponse(error);
  const rateLimit = isGitHubRateLimitError(error) || code === 429 || (code === 403 && retryAfter != null);
  const rawRetryAfter = retryAfter ?? error?.response?.headers?.['retry-after'];
  const observation = rateLimitErrorObservation(error);
  const deadline = observation?.secondaryUntil || observation?.resetAt;
  const retryAfterMs = rawRetryAfter != null ? (/^\d+(?:\.\d+)?$/.test(String(rawRetryAfter)) ? Number(rawRetryAfter) * 1000 : Date.parse(rawRetryAfter) - Date.now())
    : deadline ? Date.parse(deadline) - Date.now() : rateLimit ? 60_000 : NaN;
  if (code >= 400 && code < 500 && !([403, 429].includes(code) && rateLimit && Number.isFinite(retryAfterMs))) return null;
  const transport = /^(?:EIO|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EPROTO|ERR_TLS_\w+|CERT_\w+|UNABLE_TO_\w+|DEPTH_ZERO_SELF_SIGNED_CERT)$/.test(String(error?.code || ''))
    || error?.killed === true && ['SIGTERM', 'SIGKILL'].includes(error.signal)
    || /\b(?:timeout|timed out|context deadline exceeded|TLS|SSL|x509|DNS|no such host|temporary failure in name resolution|connection (?:reset|refused|closed|aborted)|socket hang up|EOF|broken pipe|network (?:error|is unreachable|is down)|dial tcp|proxyconnect|proxy|upstream connect failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)\b/i.test(detail)
    || /Something went wrong while executing your query|"type"\s*:\s*"INTERNAL"/i.test(detail);
  if (!(code >= 500 && code <= 599) && !rateLimit && !transport) return null;
  return Math.max(loadAwareTimeoutMs(500 * (2 ** attempt)), Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
}
