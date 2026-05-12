import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { injectEnvSecrets } from './env.mjs';

const execFileAsync = promisify(execFile);

async function readOpSecret(ref, {
  opBin = process.env.OP_CLI || 'op',
  execFileImpl = execFileAsync,
} = {}) {
  const { stdout } = await execFileImpl(opBin, ['read', ref], {
    maxBuffer: 1024 * 1024,
  });
  return String(stdout || '').trim();
}

async function injectOpSecrets({
  refs = {},
  env = process.env,
  opBin = process.env.OP_CLI || 'op',
  execFileImpl = execFileAsync,
} = {}) {
  const values = {};
  for (const [name, ref] of Object.entries(refs)) {
    if (!ref) continue;
    values[name] = await readOpSecret(ref, { opBin, execFileImpl });
  }
  return {
    ...injectEnvSecrets({ env, values }),
    source: 'op',
  };
}

async function runWithOp({
  command,
  args = [],
  env = process.env,
  opBin = process.env.OP_CLI || 'op',
  execFileImpl = execFileAsync,
} = {}) {
  if (!command) {
    throw new Error('runWithOp requires command');
  }
  const injected = injectEnvSecrets({ env });
  return execFileImpl(opBin, ['run', '--', command, ...args], {
    env: injected.env,
    maxBuffer: 10 * 1024 * 1024,
  });
}

export {
  injectOpSecrets,
  readOpSecret,
  runWithOp,
};
