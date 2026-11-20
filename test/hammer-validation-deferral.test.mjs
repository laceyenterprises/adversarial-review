import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const validator = new URL('../bin/hammer-validate.mjs', import.meta.url).pathname;

for (const [reason, status, deferred] of [
  ['inspection-and-import-fault', 75, true],
  ['canceled:SIGTERM', 125, false],
  ['canceled:SIGINT', 125, false],
  ['canceled:SIGHUP', 125, false],
  ['absolute-timeout', 125, true],
  ['validation-drain-unconfirmed', 125, true],
]) {
  test(`canonical validator preserves ${reason} with runner status ${status}`, t => {
    const root = mkdtempSync(join(tmpdir(), 'ham-validation-deferral-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'scripts/ci-mirror'), { recursive: true });
    mkdirSync(join(root, 'src/synthetic_package'), { recursive: true });
    writeFileSync(join(root, 'src/synthetic_package/__init__.py'), '');
    writeFileSync(join(root, 'scripts/ci-mirror/run-ci-mirror.py'), '');
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--no-verify', '--allow-empty', '-qm', 'Synthetic validation');
    const head = git('rev-parse', 'HEAD');
    const receipt = join(root, 'validation.json');
    const loader = join(root, 'loader.mjs');
    // Substitute the process boundary, retaining the CLI's real receipt, audit,
    // fallback and scratch handling. No real signals or controller are needed.
    const runner = `
      import { writeFileSync } from 'node:fs';
      export async function runBounded(_command, _args, options) {
        if (${JSON.stringify(reason)} === 'inspection-and-import-fault') {
          options.observeOutput("ModuleNotFoundError: No module named 'synthetic_package'");
          writeFileSync(process.env.HAM_CLOSE_VALIDATION_RECEIPT, JSON.stringify({
            checks: [{ name: 'telegram-responder-guard', status: 'failed',
              result: 'inconclusive', localReason: 'process-inspection-unavailable' }]
          }));
        } else options.observeStop(${JSON.stringify(reason)},
          ${reason.startsWith('canceled:') ? 143 : 125});
        return ${status};
      }`;
    writeFileSync(loader, `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        if (context.parentURL === ${JSON.stringify(new URL('../bin/hammer-validate.mjs', import.meta.url).href)}
          && specifier === '../src/ama/bounded-command.mjs') {
          return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(runner)}) };
        }
        return next(specifier, context);
      } });
    `);
    const result = spawnSync(process.execPath, ['--import', loader, validator, '--canonical', '--', 'src/example.py'], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, HAM_RUN_DIR: root, HAM_CLOSE_VALIDATION_RECEIPT: receipt,
        HAM_LOCAL_VALIDATION_CI_DEDUP: '0', HAM_HQ_ROOT: root, HAM_REPO: 'fixture/agent-os',
        HAM_PR_NUMBER: '42', HQ_LAUNCH_REQUEST_ID: 'lrq_fixture', TMPDIR: root },
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, result.stderr);
    assert.doesNotMatch(result.stderr, /local-battery-skipped-github-required-gate-authoritative/);
    assert.equal(existsSync(join(root, `validation-deferred-${head}.json`)), deferred);
    assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).status, status);
    assert.equal(result.stderr.includes('canonical-validation-deferred'), deferred);
  });
}
