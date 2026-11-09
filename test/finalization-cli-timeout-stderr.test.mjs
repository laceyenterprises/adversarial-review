// The historical GSR CLI is absent on this trunk. Pin its supplied stderr
// contract with a synthetic CLI and exercise the current queue CLI as well.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const platform of ['linux', 'darwin']) {
  for (const debug of ['', '1']) {
    test(`unavailable ${platform} sampler preserves CLI stderr (debug=${debug || 'off'})`, t => {
      const dir = mkdtempSync(join(tmpdir(), 'timeout-stderr-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const configPath = join(dir, 'top.yaml');
      // Also exercise the config-fallback diagnostic without a local override.
      writeFileSync(configPath, 'adversarial: [\n');
      const helper = new URL('../src/load-aware-timeout.mjs', import.meta.url).href;
      const cli = new URL('../src/finalization-cli.mjs', import.meta.url).href;
      for (const currentCli of [false, true]) {
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
          import os from 'node:os';
          import cp from 'node:child_process';
          import assert from 'node:assert/strict';
          import { syncBuiltinESMExports } from 'node:module';
          os.platform = () => ${JSON.stringify(platform)};
          os.cpus = () => [];
          cp.execFileSync = () => { throw new Error('synthetic CPU sample unavailable'); };
          syncBuiltinESMExports();
          const { loadAwareTimeoutSeconds } = await import(${JSON.stringify(helper)});
          assert.equal(loadAwareTimeoutSeconds(10, { loadAvg1m: 3, cpuCount: 1 }), 60);
          ${currentCli ? `
            const { finalizationMain } = await import(${JSON.stringify(cli)});
            process.exitCode = finalizationMain(['queue', 'status', '--repo', 'example/review', '--base', 'main'],
              { openQueueStatus() { throw new Error('synthetic store unavailable'); } });
          ` : `
            process.stderr.write('queue GSR unavailable: maintenance token required\\n');
            process.exitCode = 1;
          `}
        `], {
          encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, AGENT_OS_CONFIG_PATH: configPath, LOAD_AWARE_TIMEOUT_DEBUG: debug },
        });
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stdout, '');
        const expected = currentCli ? 'queue store/config/receipt read failed\n'
          : 'queue GSR unavailable: maintenance token required\n';
        if (debug) {
          assert.match(result.stderr, /\[load-aware-timeout\] config unavailable/);
          assert.match(result.stderr, /\[load-aware-timeout\] CPU sample unavailable/);
          assert.ok(result.stderr.endsWith(expected), result.stderr);
        } else assert.equal(result.stderr, expected);
      }
    });
  }
}
