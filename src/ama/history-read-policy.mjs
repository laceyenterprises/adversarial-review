import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';

export const HISTORY_READ_ERROR_LIMIT = 2000;
export const HISTORY_CONTEXT_TIMEOUT_MS = 90_000;

// gh normally includes stderr in message; injected executors and wrappers may
// keep it separately. Preserve it once, including the cause after a long URL.
export function historyReadErrorDetail(error) {
  let message = String(error?.message || error);
  const stderr = String(error?.stderr || '');
  if (stderr && !message.includes(stderr)) message += `\n${stderr}`;
  return message.slice(0, HISTORY_READ_ERROR_LIMIT);
}

export function historyReadFailureReason(error) {
  const detail = historyReadErrorDetail(error);
  return historyReadErrorDetail(detail.startsWith('history read failed:') ? detail : `history read failed: ${detail}`);
}

// Fail closed on API errors before matching transport words: a permanent API
// response can itself contain words such as "timeout" or "proxy".
export function historyReadRetryDelayMs(error, attempt) {
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return null;
  // Output overflow can also set killed/SIGTERM; repeating the read cannot fit it.
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error?.code === 'ENOBUFS') return null;
  const detail = [error?.stderr, error?.stdout, typeof error === 'string' ? error : error?.message].filter(Boolean).join('\n');
  const status = /\bHTTP(?:\/\d(?:\.\d)?)?\s+(\d{3})\b|"status"\s*:\s*(\d{3})/i.exec(detail);
  const code = Number(status?.[1] || status?.[2] || error?.response?.status || error?.status);
  const retryAfter = /\bretry-after\s*:\s*([^\r\n]+)/i.exec(detail)?.[1].trim();
  const retryAfterMs = retryAfter === undefined ? NaN : /^\d+(?:\.\d+)?$/.test(retryAfter)
    ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
  const rateLimit = code === 429 || code === 403 && /secondary rate limit|rate limit|too many requests/i.test(detail);
  if (code >= 400 && code < 500 && !(rateLimit && Number.isFinite(retryAfterMs))) return null;
  const transport = /^(?:EIO|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EPROTO|ERR_TLS_\w+|CERT_\w+|UNABLE_TO_\w+|DEPTH_ZERO_SELF_SIGNED_CERT)$/.test(String(error?.code || ''))
    || error?.killed === true && ['SIGTERM', 'SIGKILL'].includes(error.signal)
    || /\b(?:timeout|timed out|context deadline exceeded|TLS|SSL|x509|DNS|no such host|temporary failure in name resolution|connection (?:reset|refused|closed|aborted)|socket hang up|EOF|broken pipe|network (?:error|is unreachable|is down)|dial tcp|proxyconnect|proxy|upstream connect failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND)\b/i.test(detail)
    || /Something went wrong while executing your query|"type"\s*:\s*"INTERNAL"/i.test(detail);
  if (!(code >= 500 && code <= 599) && !rateLimit && !transport) return null;
  return Math.max(loadAwareTimeoutMs(500 * (2 ** attempt)), Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
}
