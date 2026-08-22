#!/usr/bin/env node
/**
 * ARF backend entrypoint.
 *
 * Config errors and a missing `node:sqlite` fail loud at boot with an
 * actionable message — ARF should never come up half-wired and look merely
 * empty. An absent review *store*, by contrast, is a normal state (a standalone
 * install with no pipeline yet) and boots fine with `store.available: false`.
 */

import { createArfServer } from './server.mjs';
import { loadConfig } from './config.mjs';
import { describeTokenSource } from './github/token.mjs';
import { versionInfo } from './version.mjs';

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`arf: config error: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  let started;
  try {
    started = createArfServer({ config });
  } catch (err) {
    process.stderr.write(`arf: startup failed: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  const { server, store } = started;
  server.listen(config.port, config.host, async () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    const { name, version } = versionInfo();
    process.stdout.write(
      `${name} ${version} listening on http://${config.host}:${port} `
      + `(mode=${config.mode} store=${config.storePath} available=${store.describe().available})\n`,
    );
    // An unconfigured GitHub token is not fatal at boot — ARF still serves
    // /healthz, /version, and the store projections — but it must not be
    // discoverable only by noticing that every dashboard row is a placeholder.
    // Read through describeTokenSource rather than mirror.describe(), which
    // would provision the cache file for an ARF that may never use it. It
    // reports a broken token in `present`/`reason` instead of throwing, so this
    // await cannot reject the listen callback.
    const token = await describeTokenSource(config);
    process.stdout.write(token.present
      ? `arf: github mirror ready (token from ${token.kind} ${token.ref}, api ${config.github.apiBase})\n`
      : `arf: github mirror NOT ready — ${token.reason}\n`);
  });

  const shutdown = (signal) => {
    process.stdout.write(`arf: ${signal} received, closing\n`);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
