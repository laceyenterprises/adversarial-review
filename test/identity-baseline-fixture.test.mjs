import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createIdentityBaselineFixture } from './helpers/identity-baseline-fixture.mjs';
import { prepareWorkspaceForJob } from '../src/follow-up-remediation.mjs';

test('FIXTURELEAK-01: fixture guard stays clean when a caller root overrides a fake live root', async (t) => {
  const fixture = createIdentityBaselineFixture(t);
  await assert.rejects(prepareWorkspaceForJob({
    rootDir: fixture.rootDir, workspaceRootDir: fixture.workspaceRootDir,
    env: { HQ_ROOT: fixture.fakeLiveRoot },
    job: { jobId: 'fixture', repo: 'fixture/repo', prNumber: 1 },
    execFileImpl: async (command, args) => {
      if (command === 'gh') return { stdout: JSON.stringify({ base: { ref: 'main' }, head: { ref: 'feature' } }) };
      if (args[0] === 'clone') {
        mkdirSync(args.at(-1));
        throw new Error('fixture clone stopped');
      }
      throw new Error('unexpected Git command');
    }, log: {},
  }), /fixture clone stopped/);
});

test('FIXTURELEAK-01: fixture after-test guard fails a test that writes outside its root', () => {
  const helper = new URL('./helpers/identity-baseline-fixture.mjs', import.meta.url).href;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--input-type=module', '--test-reporter=tap'], {
    input: `
      import test from 'node:test';
      import { mkdirSync } from 'node:fs';
      import { join } from 'node:path';
      import { createIdentityBaselineFixture } from ${JSON.stringify(helper)};
      test('synthetic escaped write', t => {
        const fixture = createIdentityBaselineFixture(t);
        mkdirSync(join(fixture.liveWorkspaces, 'fixture.resume-backup-1-1'));
      });
    `,
    env, encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /hookFailed/);
  assert.match(result.stdout, /identity fixture wrote outside its temporary root/);
});
