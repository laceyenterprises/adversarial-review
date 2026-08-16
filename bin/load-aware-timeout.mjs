#!/usr/bin/env node
/**
 * CLI: print a load-aware effective timeout (whole seconds) for a nominal cap.
 *
 * Usage:
 *   node bin/load-aware-timeout.mjs <nominalSeconds>
 *
 * Intended for the hammer's bounded test wrapper, e.g.:
 *   /usr/bin/perl -e 'alarm shift; exec @ARGV' \
 *     "$("$HAM_NODE_BIN" <<ROOT_DIR>>/bin/load-aware-timeout.mjs 360)" \
 *     python3 -m pytest tests/test_endpoints.py
 *
 * FAIL SAFE: on any error the CLI still prints a positive integer (the nominal,
 * or 600 if the nominal is unparseable) to stdout and a diagnostic to stderr, so
 * the caller's `alarm` is always bounded by a real number and never fires
 * immediately on an empty/0 value.
 */
import { loadAwareTimeoutSeconds } from '../src/load-aware-timeout.mjs';

const raw = process.argv[2];
try {
  process.stdout.write(String(loadAwareTimeoutSeconds(raw)));
} catch (err) {
  const n = Number(raw);
  const fallback = Number.isFinite(n) && n > 0 ? Math.ceil(n) : 600;
  process.stdout.write(String(fallback));
  process.stderr.write(
    `load-aware-timeout: ${err?.message ?? err}; falling back to ${fallback}s\n`,
  );
}
