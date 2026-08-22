/**
 * Every ARF source file must be plain UTF-8 that Node can actually load.
 *
 * This guard exists because of a real near-miss: a NUL separator written
 * as a *literal* NUL byte rather than as an escape. The code was correct and
 * the tests passed, but the byte made git classify the file as binary — so the
 * diff was unreviewable, and any tooling that assumes text (a bundler, a
 * patch, an editor that re-saves with a different encoding) had a free hand to
 * corrupt it. A UTF-16 or BOM-prefixed `.mjs` is worse still: the ES module
 * loader rejects it at import, which for `frontend` means the server does not
 * boot at all.
 *
 * The cheapest place to catch all of that is the bytes on disk, so that is
 * what this checks — across `frontend` as a whole, not just `server/`.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// test -> server -> arf
const ARF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TEXT_EXTENSIONS = new Set([
  '.mjs', '.js', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts',
  '.json', '.css', '.html', '.md',
]);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'fixtures']);

function textFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) textFiles(path, found);
    else if (TEXT_EXTENSIONS.has(extname(entry))) found.push(path);
  }
  return found;
}

const FILES = textFiles(ARF_ROOT);

describe('frontend source encoding', () => {
  it('has files to check', () => {
    // A guard that silently scans nothing passes forever.
    assert.ok(FILES.length > 0, `no text files found under ${ARF_ROOT}`);
  });

  it('contains no NUL bytes', () => {
    // A NUL is what makes git call a source file binary. Write it as the
    // escape U+0000 instead — same string at runtime, reviewable diff.
    const violations = FILES
      .filter((file) => readFileSync(file).includes(0x00))
      .map((file) => relative(ARF_ROOT, file));
    assert.deepEqual(violations, [], `NUL bytes make these files binary:\n${violations.join('\n')}`);
  });

  it('is UTF-8 without a byte-order mark', () => {
    // A BOM or a UTF-16 encoding is a SyntaxError at import time for .mjs, so
    // a file saved that way takes the server down on boot rather than failing
    // the one feature it belongs to.
    const violations = [];
    for (const file of FILES) {
      const rel = relative(ARF_ROOT, file);
      const bytes = readFileSync(file);
      if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        violations.push(`${rel}: UTF-8 BOM`);
        continue;
      }
      if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe)
        || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
        violations.push(`${rel}: UTF-16 byte-order mark`);
        continue;
      }
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        violations.push(`${rel}: not valid UTF-8`);
      }
    }
    assert.deepEqual(violations, [], `frontend must be plain UTF-8:\n${violations.join('\n')}`);
  });
});
