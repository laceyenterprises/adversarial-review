// CLI entry point for the daemon tick's "retry pending PR comments"
// step. Walks data/follow-up-jobs/{completed,stopped,failed}, finds
// terminal records whose commentDelivery.posted is false, and re-posts
// each (bounded by MAX_COMMENT_DELIVERY_ATTEMPTS).
//
// See src/comment-delivery.mjs for the design rationale and the
// retryFailedCommentDeliveries implementation.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { retryFailedCommentDeliveries } from './adapters/comms/github-pr-comments/comment-delivery.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

async function main() {
  try {
    const result = await retryFailedCommentDeliveries({ rootDir: ROOT });
    console.log(
      `[follow-up-retry-comments] scanned=${result.scanned} retried=${result.retried} posted=${result.posted} failed=${result.failed} skipped=${result.skipped}`
    );
  } catch (err) {
    console.error('[follow-up-retry-comments] failed:', err.message);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export { retryFailedCommentDeliveries };
