import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const testDir = dirname(fileURLToPath(import.meta.url));

test('runner replaces inherited HQ roots, ignores exhausted home quota and cleans up each root', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hq-runner-fixture-'));
  try {
    const home = join(fixture, 'home');
    const inheritedRoot = join(home, 'agent-os-hq');
    const secondaryRoot = join(fixture, 'secondary-hq');
    const status = JSON.stringify({ state: 'exhausted' });
    for (const root of [inheritedRoot, secondaryRoot]) {
      mkdirSync(join(root, 'quota'), { recursive: true });
      writeFileSync(join(root, 'quota', 'google-agy.status.json'), status);
    }
    for (const { primary, fail } of [
      { primary: inheritedRoot, fail: false },
      { primary: '', fail: false },
      { primary: inheritedRoot, fail: true },
    ]) {
      const report = mkdtempSync(join(fixture, 'reports-'));
      const env = {
        ...process.env,
        HOME: home,
        HQ_ROOT: primary,
        AGENT_OS_HQ_ROOT: secondaryRoot,
        HQ_ROOT_FIXTURE_REPORT: report,
        HQ_ROOT_FIXTURE_FAIL: fail ? '1' : '0',
      };
      delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, [join(testDir, 'run-tests.mjs'), 'hq-root-runner-probe.test.mjs', 'hq-root-runner-peer.test.mjs'], {
        env, encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(child.status, fail ? 1 : 0, `${child.stdout}\n${child.stderr}`);
      if (fail) assert.match(child.stdout + child.stderr, /synthetic fixture failure/);
      const reports = readdirSync(report).map((file) => JSON.parse(readFileSync(join(report, file), 'utf8')));
      assert.equal(reports.length, 2);
      assert.equal(new Set(reports.map(({ root }) => root)).size, 2, 'each file must get a different HQ root');
      assert.equal(new Set(reports.map(({ home }) => home)).size, 2, 'each file must get a different home');
      for (const observed of reports) {
        assert.notEqual(observed.root, inheritedRoot);
        assert.notEqual(observed.root, secondaryRoot);
        assert.notEqual(observed.home, home);
        assert.equal(existsSync(observed.root), false, 'the file HQ root must be removed after exit');
        assert.equal(existsSync(observed.home), false, 'the file home must be removed after exit');
      }
    }
    for (const root of [inheritedRoot, secondaryRoot]) {
      assert.equal(readFileSync(join(root, 'quota', 'google-agy.status.json'), 'utf8'), status);
      assert.equal(existsSync(join(root, 'fixture-state.json')), false);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
