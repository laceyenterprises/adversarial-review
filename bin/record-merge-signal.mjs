#!/usr/bin/env node
import { loadAppSdkSync } from '../src/app-sdk-loader.mjs';
import { redactPublicSafeText } from '../src/adapters/comms/github-pr-comments/redaction.mjs';
const [hq_root, pr, merge_commit_sha, mode] = process.argv.slice(2);
const env = process.env;
const text = value => String(value ?? '').trim() || undefined;
try {
  await loadAppSdkSync().recordMergeSignal({
    hq_root, pr_number:Number(pr), merge_commit_sha, mode,
    launch_request_id:text(env.HQ_LAUNCH_REQUEST_ID) || text(env.AGENT_OS_WORKER_LRQ_ID) || text(env.LAUNCH_REQUEST_ID),
    ticket_ref:text(env.HQ_TICKET_REF),
    merged_by:text(env.WORKER_CLASS) || 'hammer',
  }, {hq_bin:env.HQ_BIN || 'hq', env});
} catch (error) {
  const detail = redactPublicSafeText(error?.message || 'unknown capture failure', 400).replace(/[\r\n]+/g, ' ');
  console.error('merge completion capture unavailable:', detail);
  process.exitCode = 1;
}
