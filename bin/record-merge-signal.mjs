#!/usr/bin/env node
import { loadAppSdkSync } from '../src/app-sdk-loader.mjs';
const [hq_root, pr, merge_commit_sha, mode] = process.argv.slice(2);
try {
  await loadAppSdkSync().recordMergeSignal({hq_root,pr_number:Number(pr),merge_commit_sha,mode});
} catch { console.error('merge completion capture unavailable'); process.exitCode = 1; }
