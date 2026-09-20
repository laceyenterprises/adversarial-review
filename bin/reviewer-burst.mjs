#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import {
  readReviewerBurstLease,
  requestReviewerBurstLease,
  revokeReviewerBurstLease,
} from '../src/reviewer-burst-lease.mjs';

const TOOL_ROOT = fileURLToPath(new URL('..', import.meta.url));
const usage = 'Usage: reviewer-burst status|revoke|request [--root DIR] [--ttl-minutes N --additional-slots N --repo OWNER/REPO ... --active-pack ID --budget-slot-minutes N --reason TEXT --requested-by ID --quota-safe --posting-safe --reviewer-healthy]\n';

function parse(argv) {
  const command = argv.shift();
  const options = { rootDir: TOOL_ROOT, repos: [], safety: {} };
  while (argv.length) {
    const flag = argv.shift();
    if (flag === '--quota-safe') options.safety.quotaSafe = true;
    else if (flag === '--posting-safe') options.safety.postingSafe = true;
    else if (flag === '--reviewer-healthy') options.safety.reviewerHealthy = true;
    else if (flag === '--repo') options.repos.push(argv.shift());
    else {
      const key = { '--root': 'rootDir', '--ttl-minutes': 'ttlMinutes', '--additional-slots': 'additionalSlots', '--active-pack': 'activePack', '--budget-slot-minutes': 'budgetSlotMinutes', '--reason': 'reason', '--requested-by': 'requestedBy' }[flag];
      if (!key || argv.length === 0) throw new Error(`unknown or incomplete option: ${flag}`);
      options[key] = argv.shift();
    }
  }
  return { command, options };
}

function main(argv = process.argv.slice(2), io = process) {
  try {
    const { command, options } = parse([...argv]);
    let result;
    if (command === 'status') result = readReviewerBurstLease(options.rootDir);
    else if (command === 'revoke') result = revokeReviewerBurstLease(options.rootDir, {
      revokedBy: options.requestedBy,
      reason: options.reason,
    });
    else if (command === 'request') result = requestReviewerBurstLease({ ...options, ttlMs: Number(options.ttlMinutes) * 60_000, eligibleRepos: options.repos });
    else throw new Error('command must be status, request, or revoke');
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.state === 'denied' || result.state === 'invalid' ? 1 : 0;
  } catch (error) {
    io.stderr.write(`error: ${error.message}\n${usage}`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
export { main };
