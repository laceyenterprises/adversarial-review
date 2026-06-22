const UNSUPPORTED_CODES = new Set([
  'unsupported_argument',
  'unsupported_command',
  'unsupported_kind',
  'unsupported_write_kind',
  'unsupported_write_operation',
]);

function isUnsupportedOperationPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const failureClass = String(payload.failureClass || '').trim();
  const code = String(payload.code || payload.error || payload.reason || payload.type || '').trim();
  if (failureClass === 'unsupported') return true;
  if (UNSUPPORTED_CODES.has(code)) return true;

  // Legacy adapters predate failureClass:"unsupported". They reported
  // adapter-version skew as input-class argparse prose; keep this below the
  // structured branch so new adapters own the primary contract.
  const message = String(payload.message || '').trim();
  return failureClass === 'input'
    && (/invalid choice:/i.test(message) || /unrecognized arguments?:/i.test(message));
}

function isUnsupportedOperationText(text) {
  const detail = String(text || '');
  if (!detail.trim()) return false;
  try {
    return isUnsupportedOperationPayload(JSON.parse(detail.trim()));
  } catch {
    return /(^|\n)(github-adapter: )?(error: )?unsupported write kind\b/i.test(detail)
      || /(^|\n)(github-adapter: )?(error: )?unsupported write operation\b/i.test(detail)
      || /(^|\n)(github-adapter: )?(error: )?unknown write kind\b/i.test(detail)
      || (
        /(^|\n)usage: .*github-adapter\b.*\bwrite\b.*--kind\b/i.test(detail)
        && /(^|\n)(error: )?(invalid choice|unrecognized arguments?): .*--kind\b/i.test(detail)
      );
  }
}

export {
  UNSUPPORTED_CODES,
  isUnsupportedOperationPayload,
  isUnsupportedOperationText,
};
