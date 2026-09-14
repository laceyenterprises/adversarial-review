import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { parseProtectivePredecessorDeclaration } from '../src/ama/protective-predecessor.mjs';

const SHELL_TRAILER_AWK =
  '/^[[:space:]]*```/ { in_fence = !in_fence; next } !in_fence && /^[[:space:]]*Protects-Against-Unsafe-Merge-Until-PR[[:space:]]*:/ {print $0}';
const SHELL_TRAILER_SED =
  's/^[[:space:]]*Protects-Against-Unsafe-Merge-Until-PR[[:space:]]*:[[:space:]]*#?([1-9][0-9]*)[[:space:]]*$/\\1/p';

function runWithInput(cmd, args, input) {
  const result = spawnSync(cmd, args, {
    input,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || `${cmd} failed`);
  return result.stdout;
}

function shellParseProtectivePredecessors(body) {
  const lines = runWithInput('awk', [SHELL_TRAILER_AWK], body);
  const protectors = [];
  for (const line of lines.split('\n')) {
    if (!line) continue;
    const stdout = runWithInput('sed', ['-nE', SHELL_TRAILER_SED], line);
    const parsed = Number(String(stdout || '').trim());
    if (Number.isSafeInteger(parsed) && parsed > 0 && !protectors.includes(parsed)) {
      protectors.push(parsed);
    }
  }
  return protectors;
}

test('MERGEORDER-01: JS and generated shell ignore fenced protective predecessor trailers', () => {
  const body = [
    'Body text',
    '```text',
    'Protects-Against-Unsafe-Merge-Until-PR: #1',
    '```',
    'Protects-Against-Unsafe-Merge-Until-PR: #6766',
    'Protects-Against-Unsafe-Merge-Until-PR: #6767',
  ].join('\n');

  const jsDeclaration = parseProtectivePredecessorDeclaration(body);
  const shellProtectors = shellParseProtectivePredecessors(body);

  assert.deepEqual(jsDeclaration.protectorPrNumbers, [6766, 6767]);
  assert.deepEqual(shellProtectors, jsDeclaration.protectorPrNumbers);
});

test('MERGEORDER-01: JS and generated shell both ignore only-fenced declarations', () => {
  const body = [
    '```',
    'Protects-Against-Unsafe-Merge-Until-PR: #1234',
    '```',
  ].join('\n');

  assert.equal(parseProtectivePredecessorDeclaration(body), null);
  assert.deepEqual(shellParseProtectivePredecessors(body), []);
});
