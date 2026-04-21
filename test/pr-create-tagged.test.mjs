import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs, validatePassthroughArgs } from '../src/pr-create-tagged.mjs';

const execFileAsync = promisify(execFile);

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(thisFile), '..');
const cliPath = path.resolve(repoRoot, 'src/pr-create-tagged.mjs');

test('parseArgs supports equals-style values', () => {
  const parsed = parseArgs(['--tag=codex', '--title=LAC-180: tighten parser', '--dry-run', '--', '--draft']);
  assert.equal(parsed.tag, 'codex');
  assert.equal(parsed.title, 'LAC-180: tighten parser');
  assert.equal(parsed.dryRun, true);
  assert.deepEqual(parsed.passthrough, ['--draft']);
});

test('parseArgs throws clear missing-value errors for tag/title', () => {
  assert.throws(() => parseArgs(['--tag']), /Missing value for --tag/);
  assert.throws(() => parseArgs(['--title']), /Missing value for --title/);
  assert.throws(() => parseArgs(['--tag', '--title', 'ok']), /Missing value for --tag/);
});

test('validatePassthroughArgs blocks short-form title overrides', () => {
  assert.throws(() => validatePassthroughArgs(['-t']), /Do not pass --title/);
  assert.throws(() => validatePassthroughArgs(['-tOverride']), /Do not pass --title/);
  assert.throws(() => validatePassthroughArgs(['-dt']), /Do not pass --title/);
  assert.throws(() => validatePassthroughArgs(['-bdt']), /Do not pass --title/);
  assert.throws(() => validatePassthroughArgs(['--title=override']), /Do not pass --title/);
  assert.doesNotThrow(() => validatePassthroughArgs(['-d']));
  assert.doesNotThrow(() => validatePassthroughArgs(['--draft', '--base', 'main']));
});

test('CLI dry-run path respects equals args and blocks passthrough title override', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [cliPath, '--tag=codex', '--title=LAC-180: parser coverage', '--dry-run', '--', '-tOverride'],
      { cwd: repoRoot }
    ),
    (err) => {
      const stderr = String(err.stderr ?? '');
      return /Do not pass --title/.test(stderr);
    }
  );
});
