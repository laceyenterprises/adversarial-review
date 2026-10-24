#!/usr/bin/env node
// Private stdin/stdout bridge; deliberately no production reviewer entry point.
import { findingLineRanges } from '../src/kernel/finding-lines.mjs';
import { replayRouteAllowed, parseReplayReview } from '../src/osg-reviewer-replay.mjs';
try {
  let input = '';
  let inputBytes = 0;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    inputBytes += Buffer.byteLength(chunk);
    if (inputBytes > 131072) throw Error('input cap');
    input += chunk;
  }
  const value = JSON.parse(input);
  if (!['route', 'parse', 'ranges'].includes(value.operation)) throw Error('unknown operation');
  const result = value.operation === 'route'
    ? replayRouteAllowed(value.builder_class, value.arm, value.options)
    : value.operation === 'parse' ? parseReplayReview(value.body_md)
      : findingLineRanges(value.lines, value.file);
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write('Replay input unavailable or invalid.\n');
  process.exitCode = 1;
}
