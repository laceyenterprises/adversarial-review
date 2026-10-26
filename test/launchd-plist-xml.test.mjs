import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const launchdDir = fileURLToPath(new URL('../launchd/', import.meta.url));

test('watcher and follow-up templates enable the mandatory hammer dispatch read with exactly "1"', () => {
  const files = [
    'ai.laceyenterprises.adversarial-watcher.airlock.plist',
    'ai.laceyenterprises.adversarial-follow-up.airlock.plist',
  ].map((name) => path.join(launchdDir, name));
  const parser = [
    'import json, plistlib, sys',
    'values = []',
    'for path in sys.argv[1:]:',
    '    with open(path, "rb") as stream:',
    '        values.append(plistlib.load(stream)["EnvironmentVariables"].get("ADVERSARIAL_DISPATCH_READS_ENABLED"))',
    'print(json.dumps(values))',
  ].join('\n');
  const result = spawnSync('python3', ['-c', parser, ...files], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), ['1', '1']);
});

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
