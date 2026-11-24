import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveRealPath } from './remediation-reply-paths.mjs';

export const REVIEW_MODULE = ['tools', 'adversarial-review'];

export function deployCheckoutFromReviewModule(root) {
  const absolute = resolve(root);
  try {
    for (const source of [absolute, realpathSync.native(absolute)]) {
      const checkout = dirname(dirname(source));
      if (source === join(checkout, ...REVIEW_MODULE)) return resolveRealPath(checkout);
    }
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
  }
  return null;
}
