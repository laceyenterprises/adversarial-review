#!/usr/bin/env node
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createQueueGitHub } from '../src/finalization/queue-github.mjs';
import { createProductionQueue } from '../src/finalization/queue-production.mjs';

async function readRequest(path) {
  const max = 1024 * 1024;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > max) throw new Error('queue-handoff-request-unreadable');
    const bytes = Buffer.alloc(max + 1);
    const { bytesRead } = await file.read(bytes);
    if (bytesRead !== stat.size) throw new Error('queue-handoff-request-changed');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
}

try {
  if (process.argv.length !== 3) throw new Error('one queue handoff request file required');
  const rootDir = fileURLToPath(new URL('../', import.meta.url));
  const request = await readRequest(process.argv[2]);
  if (!process.env.HQ_LAUNCH_REQUEST_ID || request?.closer?.launchRequestId !== process.env.HQ_LAUNCH_REQUEST_ID) {
    throw new Error('queue-hammer-launch-mismatch');
  }
  const github = createQueueGitHub({ readWithHammerEntitlement: true });
  const acknowledgement = await createProductionQueue({ rootDir, github }).admitHammer(request);
  process.stdout.write(`${JSON.stringify(acknowledgement)}\n`);
} catch (error) {
  // Child errors may carry raw remote output or subprocess environment data.
  const reason = /^queue-[a-z-]+$/.test(error.message) ? error.message : 'queue-handoff-evidence-unavailable';
  process.stdout.write(`${JSON.stringify({ ok: false, reason })}\n`);
}
