#!/usr/bin/env node
// Private stdin/stdout bridge; deliberately no production reviewer entry point.
import { findingLineRanges } from '../src/kernel/finding-lines.mjs';
import { replayRouteAllowed, parseReplayReview } from '../src/osg-reviewer-replay.mjs';
try {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 131072) throw Error('input cap');
  }
  const value = JSON.parse(input);
  const result = value.operation === 'route'
    ? replayRouteAllowed(value.builder_class, value.arm, value.options)
    : value.operation === 'parse' ? parseReplayReview(value.body_md)
      : value.operation === 'ranges' ? findingLineRanges(value.lines, value.file) : null;
  if (result === null) throw Error('unknown operation');
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write('Replay input unavailable or invalid.\n');
  process.exitCode = 1;
}
