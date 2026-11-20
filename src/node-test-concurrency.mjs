import { basename } from 'node:path';
import { availableParallelism } from 'node:os';

export function localNodeTestConcurrency(env = process.env, cores = availableParallelism()) {
  if (env.CI === 'true' || env.CI === '1') return undefined;
  const raw = env.AR_TEST_CONCURRENCY;
  const override = Number(raw);
  return /^\d+$/.test(raw ?? '') && Number.isSafeInteger(override) && override > 0
    ? override : Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

export function boundedNodeTestArgs(command, args, env) {
  if (!['node', 'node.exe'].includes(basename(command)) || args[0] !== '--test') return args;
  const separator = args.indexOf('--');
  const options = separator === -1 ? args : args.slice(0, separator);
  if (options.some(arg => /^--test[-_]concurrency(?:=|$)/.test(arg))) return args;
  const concurrency = localNodeTestConcurrency(env);
  return concurrency === undefined ? args : [args[0], `--test-concurrency=${concurrency}`, ...args.slice(1)];
}
