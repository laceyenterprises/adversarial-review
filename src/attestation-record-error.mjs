import { redactPathlikeText, redactSensitiveText } from './adapters/comms/github-pr-comments/redaction.mjs';

export function attestationRecordErrorDetails(error, env = process.env) {
  const redact = value => {
    let text = String(value || '');
    for (const [key, secret] of Object.entries(env)) {
      if (/token|secret|password|credential|private.?key|hmac|dsn/i.test(key)
        && typeof secret === 'string' && secret.length >= 8) text = text.split(secret).join('[REDACTED]');
    }
    text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/gi, '[REDACTED]@')
      .replace(/(["']?(?:[\w-]*(?:token|secret|password|hmac[_-]?key)|digest)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,}]+)/gi, '$1[REDACTED]');
    return redactPathlikeText(redactSensitiveText(text)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  };
  const tail = value => {
    const text = redact(value);
    return text.length > 2000 ? `…${text.slice(-1999)}` : text;
  };
  const exitCode = typeof error?.code === 'number' ? error.code : null;
  const code = redact(error?.code).slice(0, 80) || 'unknown';
  const signal = redact(error?.signal).slice(0, 80) || null;
  const stderrTail = tail(error?.stderr);
  const message = tail(error?.message || error);
  return { exitCode, signal, stderrTail,
    error: `${message}; exitCode=${code}${signal ? ` signal=${signal}` : ''}${stderrTail ? `; stderr=${stderrTail}` : ''}` };
}
