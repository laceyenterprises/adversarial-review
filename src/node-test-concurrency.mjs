import { availableParallelism } from 'node:os';

export const CI_TEST_WORKERS = 8;

export function nodeTestWorkerLimit(env = process.env, cores = availableParallelism()) {
  if (env.CI === 'true' || env.CI === '1') return CI_TEST_WORKERS;
  const raw = env.AR_TEST_CONCURRENCY;
  const override = Number(raw);
  return /^\d+$/.test(raw ?? '') && Number.isSafeInteger(override) && override > 0
    ? override : Math.max(1, Math.min(4, Math.floor(cores / 2)));
}
