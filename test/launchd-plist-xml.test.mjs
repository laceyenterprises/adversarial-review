import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const launchdDir = fileURLToPath(new URL('../launchd/', import.meta.url));

test('launchd templates pass the strict plist parser used by main-catchup reload', () => {
  const files = readdirSync(launchdDir)
    .filter((name) => name.endsWith('.plist'))
    .map((name) => path.join(launchdDir, name));
  const parser = [
    'import plistlib, sys',
    'for path in sys.argv[1:]:',
    '    with open(path, "rb") as stream:',
    '        plistlib.load(stream)',
  ].join('\n');
  const result = spawnSync('python3', ['-c', parser, ...files], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
