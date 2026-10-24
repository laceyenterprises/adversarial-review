#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { proveRebaseResult } from '../src/ama/rebase-result.mjs';

const [oldHead, head, base] = process.argv.slice(2);
const execute = promisify(execFile);
const proof = await proveRebaseResult({ oldHead, head, base,
  git: async args => (await execute('git', args, { timeout: 15000, maxBuffer: 16 * 1024 * 1024 })).stdout,
});
console.log(JSON.stringify(proof));
if (!proof) process.exitCode = 65;
