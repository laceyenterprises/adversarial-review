import { availableParallelism } from 'node:os';

export function localNodeTestConcurrency(env = process.env, cores = availableParallelism()) {
  if (env.CI === 'true' || env.CI === '1') return undefined;
  const raw = env.AR_TEST_CONCURRENCY;
  const override = Number(raw);
  return /^\d+$/.test(raw ?? '') && Number.isSafeInteger(override) && override > 0
    ? override : Math.max(1, Math.min(4, Math.floor(cores / 2)));
}
