// Share one process-wide warning budget across status probes and dispatch IDs.
// Preserve each consumer's parser and failure behavior.
export function createHqDispatchStatusOutputParser({ nowMs = Date.now } = {}) {
  let lastWarningAt = null;
  return function parseStatusOutput(stdout, args, parse, logger = console) {
    try {
      return parse(stdout);
    } catch (err) {
      const invalidJson = err instanceof SyntaxError || /\$stdout (?:invalid JSON|empty)/.test(err?.message || '');
      const now = nowMs();
      if (invalidJson && typeof logger?.warn === 'function'
          && (lastWarningAt === null || now - lastWarningAt >= 60_000)) {
        lastWarningAt = now;
        logger.warn(`[hq-dispatch-status] non-JSON output; args=${JSON.stringify(args).slice(0, 1000)}; stdout=${JSON.stringify(String(stdout ?? '').slice(0, 200))}`);
      }
      throw err;
    }
  };
}

export const parseHqDispatchStatusOutput = createHqDispatchStatusOutputParser();
