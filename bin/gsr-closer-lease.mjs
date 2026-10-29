#!/usr/bin/env node
// GSR-07 boot-time resume's closer-lease hand-off (see src/ama/gsr-closer-lease.mjs).
//   gsr-closer-lease.mjs readopt --root-dir DIR --lrq ID [--successor ID]
//   gsr-closer-lease.mjs release --root-dir DIR --lrq ID [--hq-root DIR]
// Prints one JSON object; exits 64 on a usage error.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareDispatchReadContext } from '../src/dispatch-read-client.mjs';
import {
  readoptSuspendedAmaCloserLeases,
  releaseSuspendedAmaCloserLeases,
} from '../src/ama/gsr-closer-lease.mjs';

export async function main(args = process.argv.slice(2), options = {}) {
  const [action, ...rest] = args;
  let rootDir = process.cwd();
  let launchRequestId = null;
  let successorLaunchRequestId = null;
  let hqRoot = options.hqRoot;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--root-dir' && rest[i + 1]) rootDir = resolve(rest[++i]);
    else if (rest[i] === '--lrq' && rest[i + 1]) launchRequestId = rest[++i];
    else if (rest[i] === '--successor' && rest[i + 1]) successorLaunchRequestId = rest[++i];
    else if (rest[i] === '--hq-root' && rest[i + 1]) hqRoot = resolve(rest[++i]);
    else throw Object.assign(new Error(`Unknown or incomplete argument: ${rest[i]}`), { usage: true });
  }
  if (!['readopt', 'release'].includes(action) || !launchRequestId) {
    throw Object.assign(new Error('usage: gsr-closer-lease.mjs readopt|release --root-dir DIR --lrq ID'
      + ' [--successor ID] [--hq-root DIR]'), { usage: true });
  }
  if (action === 'release') {
    const ready = await prepareDispatchReadContext({ env: options.readOptions?.env ?? process.env });
    if (!ready.ok) throw new Error(`${ready.reason}: ${ready.detail}`);
  }
  const result = action === 'readopt'
    ? readoptSuspendedAmaCloserLeases(rootDir, { launchRequestId, successorLaunchRequestId })
    : releaseSuspendedAmaCloserLeases(rootDir, { launchRequestId, hqRoot, ...options.readOptions });
  (options.print || console.log)(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (error) {
    console.error(error.message);
    process.exitCode = error.usage ? 64 : 1;
  }
}
