#!/usr/bin/env node
/** Private transport adapter for the public OS projection. Roots/grants are OS supplied. */
import { readFileSync } from 'node:fs';
import { readReviewObservations } from './review-observations.mjs';

try {
  const input = readFileSync(0, 'utf8');
  if (input.length > 32768) throw new Error('request too large');
  const { rootDir, selector, repositories } = JSON.parse(input);
  process.stdout.write(JSON.stringify(readReviewObservations({ rootDir, selector, repositories })));
} catch (error) {
  // Fixed diagnostics distinguish client faults without exposing database paths,
  // producer payloads or arbitrary exception text at this transport boundary.
  const publicErrors = new Set(['request too large', 'invalid review selector', 'review repository grant required']);
  const reason = publicErrors.has(error.message) ? error.message
    : error instanceof SyntaxError ? 'invalid review request JSON' : 'review evidence unavailable';
  process.stderr.write(`${reason}\n`);
  process.exitCode = 1;
}
