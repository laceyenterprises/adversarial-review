import { spawn } from 'node:child_process';

function spawnDetachedCli(command, args, options = {}) {
  const child = (options.spawnImpl || spawn)(command, args, {
    ...options.spawnOptions,
    cwd: options.cwd,
    detached: true,
    env: options.env,
    stdio: options.stdio,
  });

  if (!child.spawnedAt) {
    child.spawnedAt = typeof options.now === 'function'
      ? options.now()
      : new Date().toISOString();
  }

  if (options.unref !== false && typeof child.unref === 'function') {
    child.unref();
  }

  return child;
}

export { spawnDetachedCli };
