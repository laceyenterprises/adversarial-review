#!/usr/bin/env node
/** Private transport adapter for the public OS projection. Roots/grants are OS supplied. */
import { readFileSync } from 'node:fs';
import { readReviewObservations } from './review-observations.mjs';

try {
  const input = readFileSync(0, 'utf8');
  if (input.length > 32768) throw new Error('request too large');
  const { rootDir, selector, repositories } = JSON.parse(input);
  process.stdout.write(JSON.stringify(readReviewObservations({ rootDir, selector, repositories })));
} catch {
  process.stderr.write('review evidence unavailable\n');
  process.exitCode = 1;
}
