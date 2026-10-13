#!/usr/bin/env node
import { execGhWithRetry } from '../src/gh-cli.mjs';

const [prUrl] = process.argv.slice(2);
if (!prUrl) throw new Error('usage: hammer-base-head PR_URL');
const ref = new URL(prUrl).pathname.match(/^\/([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/);
if (!ref) throw new Error('usage: hammer-base-head PR_URL');
const { stdout } = await execGhWithRetry({
  args: ['api', `repos/${ref[1]}/pulls/${ref[2]}`, '--jq', '.head.sha'],
  timeoutMs: 15_000,
});
const headSha = stdout.trim();
if (!/^[a-f0-9]{40}$/.test(headSha)) throw new Error('hammer starting PR head is missing or malformed');
process.stdout.write(`${headSha}\n`);
