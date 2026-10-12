#!/usr/bin/env node
import { execGhWithRetry } from '../src/gh-cli.mjs';

const [prUrl] = process.argv.slice(2);
if (!prUrl) throw new Error('usage: hammer-base-head PR_URL');
const { stdout } = await execGhWithRetry({
  args: ['pr', 'view', prUrl, '--json', 'headRefOid', '--jq', '.headRefOid'],
  timeoutMs: 15_000,
});
const headSha = stdout.trim();
if (!/^[a-f0-9]{40}$/.test(headSha)) throw new Error('hammer starting PR head is missing or malformed');
process.stdout.write(`${headSha}\n`);
