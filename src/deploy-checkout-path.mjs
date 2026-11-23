import { dirname, join, resolve } from 'node:path';
import { resolveRealPath } from './remediation-reply-paths.mjs';

export const REVIEW_MODULE = ['tools', 'adversarial-review'];

export function deployCheckoutFromReviewModule(root) {
  const absolute = resolve(root);
  for (const source of [absolute, resolveRealPath(absolute)]) {
    const checkout = dirname(dirname(source));
    if (source === join(checkout, ...REVIEW_MODULE)) return resolveRealPath(checkout);
  }
  return null;
}
