import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { writeFileAtomic } from '../src/atomic-write.mjs';

test('writeFileAtomic never exposes partial JSON to concurrent readers', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'atomic-write-'));
  const targetPath = path.join(rootDir, 'job.json');
  writeFileAtomic(targetPath, `${JSON.stringify({ seq: 0, payload: 'x'.repeat(16_384) })}\n`);

  let stop = false;
  const readers = Array.from({ length: 8 }, async () => {
    while (!stop) {
      const text = readFileSync(targetPath, 'utf8');
      assert.doesNotThrow(() => JSON.parse(text));
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  for (let seq = 1; seq <= 40; seq += 1) {
    writeFileAtomic(targetPath, `${JSON.stringify({ seq, payload: 'y'.repeat(16_384) })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
  }

  stop = true;
  await Promise.all(readers);
});

test('writeFileAtomic defaults to group-readable file permissions', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'atomic-write-'));
  const targetPath = path.join(rootDir, 'job.json');

  writeFileAtomic(targetPath, '{"ok":true}\n');

  assert.equal(statSync(targetPath).mode & 0o777, 0o644);
});
