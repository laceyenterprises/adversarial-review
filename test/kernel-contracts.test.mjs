import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

test('kernel adapter contracts type-check', async () => {
  const { stderr } = await execFileAsync(
    'npm',
    ['run', 'typecheck:contracts', '--', '--pretty', 'false'],
    {
      cwd: ROOT,
      maxBuffer: 1024 * 1024,
    },
  );

  assert.equal(stderr.trim(), '');
});
