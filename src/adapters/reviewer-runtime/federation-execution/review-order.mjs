import { createHash } from 'node:crypto';

export const MAX_ORDER_BYTES = 2 * 1024 * 1024;
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some((key) => !Object.hasOwn(value, key))) throw new Error('Invalid contract fields');
}

export function boundedInteger(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid contract integer');
}

export function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value)) {
    throw new Error('Invalid contract identifier');
  }
}

export function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Sign and hash the exact UTF-8 wire bytes. No second canonical JSON recipe.
// This is a narrow execution request, produced by the federation origin adapter,
// not a replacement for the federation work-order/entitlement envelope.
export function readReviewOrder(orderBytes) {
  if (typeof orderBytes !== 'string' || Buffer.byteLength(orderBytes) > MAX_ORDER_BYTES) {
    throw new Error('Review order exceeds wire budget');
  }
  const order = JSON.parse(orderBytes);
  exactKeys(order, ['version', 'orderId', 'workOrderHash', 'originInstallId', 'executorInstallId', 'hostId',
    'credential', 'repo', 'prNumber', 'headSha', 'round', 'epoch', 'runtime', 'model',
    'effectPolicy', 'prompt', 'diff', 'context', 'budget']);
  if (order.version !== 1 || order.runtime !== 'antigravity' || order.effectPolicy !== 'review-result-only') {
    throw new Error('Unsupported review execution policy');
  }
  if (typeof order.workOrderHash !== 'string' || !/^[a-f0-9]{64}$/.test(order.workOrderHash)) {
    throw new Error('Missing frozen federation work-order hash');
  }
  for (const key of ['orderId', 'originInstallId', 'executorInstallId', 'hostId', 'model']) identifier(order[key]);
  if (typeof order.repo !== 'string' || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(order.repo)
    || order.repo.length > 200 || !/^[a-f0-9]{40}$/.test(order.headSha)) throw new Error('Invalid review target');
  for (const key of ['prNumber', 'round', 'epoch']) boundedInteger(order[key], 1, Number.MAX_SAFE_INTEGER);
  exactKeys(order.credential, ['ownerInstallId', 'id', 'generation']);
  identifier(order.credential.ownerInstallId);
  identifier(order.credential.id);
  boundedInteger(order.credential.generation, 1, Number.MAX_SAFE_INTEGER);
  for (const key of ['prompt', 'diff', 'context']) {
    exactKeys(order[key], ['text', 'sha256']);
    if (typeof order[key].text !== 'string' || order[key].sha256 !== sha256(order[key].text)) {
      throw new Error(`Invalid frozen ${key}`);
    }
  }
  if (!order.prompt.text.trim()) throw new Error('Empty frozen prompt');
  exactKeys(order.budget, ['timeoutMs', 'maxTokens', 'maxCostMicrousd', 'maxOutputBytes', 'maxArtifactBytes']);
  boundedInteger(order.budget.timeoutMs, 1, 20 * 60 * 1000);
  boundedInteger(order.budget.maxTokens, 1, Number.MAX_SAFE_INTEGER);
  boundedInteger(order.budget.maxCostMicrousd, 1, Number.MAX_SAFE_INTEGER);
  boundedInteger(order.budget.maxOutputBytes, 1, 1024 * 1024);
  boundedInteger(order.budget.maxArtifactBytes, 0, 4 * 1024 * 1024);
  const binding = Object.fromEntries(['orderId', 'workOrderHash', 'originInstallId', 'executorInstallId', 'hostId',
    'repo', 'prNumber', 'headSha', 'round', 'epoch'].map((key) => [key, order[key]]));
  binding.orderHash = sha256(orderBytes);
  binding.credential = order.credential;
  return freeze({ order, binding });
}

export function sameBinding(actual, expected) {
  if (!actual || Object.keys(actual).length !== Object.keys(expected).length) return false;
  return Object.entries(expected).every(([key, value]) => key === 'credential'
    ? actual.credential && Object.keys(actual.credential).length === 3
      && Object.entries(value).every(([field, entry]) => actual.credential[field] === entry)
    : actual[key] === value);
}
