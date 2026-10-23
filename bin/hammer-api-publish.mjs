#!/usr/bin/env node
import { meteredExecFileSync } from '../src/metered-gh.mjs';
import { execFileSync } from 'node:child_process';
import { isTransientGhError } from '../src/gh-cli.mjs';
import { publishHammerTree } from '../src/ama/hammer-api-publish.mjs';
const [repo, pr] = process.argv.slice(2);
const git = (...args) => execFileSync('git', args, { timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
// Retry transport failures only, preserving the entitled token and expected-head
// CAS on every mutation attempt. An ambiguous server-side success still fails
// closed through the lease-protected git fallback if the CAS rejects a retry.
async function network(command, args, input) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return meteredExecFileSync(execFileSync, command, args, { input, ...(command === 'gh' ? { hammerToken: true } : {}), timeout: 15000,
        maxBuffer: 64 * 1024 * 1024, env: process.env });
    } catch (error) {
      const transient = isTransientGhError(error) || (command === 'git'
        && /timed out|TLS|SSL|early EOF|RPC failed|remote end hung up unexpectedly|HTTP.*5\d\d/i.test(String(error.stderr || error.message)));
      if (!transient || attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt)));
    }
  }
}
const api = async (path, input) => JSON.parse((await network('gh',
  ['api', path, ...(input ? ['--input', '-'] : [])], input ? JSON.stringify(input) : undefined)).toString());
let fallback = {};
let previousHead;
try {
  if (git('status', '--porcelain').length) throw new Error('local tree has uncommitted changes');
  const number = String(pr).match(/\/pull\/([1-9]\d*)/)?.[1] || pr;
  const live = JSON.parse(await network('gh', ['api', `repos/${repo}/pulls/${number}`]));
  const info = { headRefName: live.head?.ref, headRefOid: live.head?.sha };
  previousHead = info.headRefOid;
  fallback = { fallbackHead: info.headRefOid, branch: info.headRefName };
  await network('git', ['fetch', 'origin', info.headRefOid]);
  // createCommitOnBranch preserves trees, not local ancestry. A rebased head
  // must use the lease-protected git route so the new base remains an ancestor.
  try {
    git('merge-base', '--is-ancestor', info.headRefOid, 'HEAD');
  } catch {
    throw new Error('local HEAD does not descend from the remote head; preserve rebased history with git');
  }
  const count = git('rev-list', '--count', `${info.headRefOid}..HEAD`).toString().trim();
  if (count !== '0' && (count !== '1'
    || git('rev-list', '--parents', '-n', '1', 'HEAD').toString().trim().split(/\s+/).length !== 2)) {
    throw new Error('API publication requires exactly one single-parent local commit; preserve history and messages with git');
  }
  const entries = ref => new Map(git('ls-tree', '-rz', ref).toString().split('\0').filter(Boolean).map(entry => {
    const tab = entry.indexOf('\t');
    const meta = entry.slice(0, tab), path = entry.slice(tab + 1);
    const [mode, , oid] = meta.split(' ');
    return [path, { mode, oid }];
  }));
  const before = entries(info.headRefOid), after = entries('HEAD');
  const changes = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path)?.oid !== after.get(path)?.oid || before.get(path)?.mode !== after.get(path)?.mode)
    .map(path => ({ path, oldMode: before.get(path)?.mode, mode: after.get(path)?.mode,
      contents: after.get(path)?.mode === '100644' ? git('cat-file', 'blob', after.get(path).oid).toString('base64') : undefined }));
  const result = await publishHammerTree({ repo, branch: info.headRefName, expectedHead: info.headRefOid,
    localTree: git('rev-parse', 'HEAD^{tree}').toString().trim(), message: git('log', '-1', '--format=%B').toString().trim(), changes, api });
  fallback = { fallbackHead: result.head || result.fallbackHead || info.headRefOid, branch: info.headRefName,
    // Preserve the verified publication even if subsequent fetch/reset fails.
    ...(result.route === 'published' ? { pushedHead: result.head } : {}) };
  if (result.route === 'published') {
    await network('git', ['fetch', 'origin', result.head]);
    if (git('rev-parse', `${result.head}^{tree}`).toString().trim() !== result.tree) throw new Error('fetched tree mismatch');
    git('reset', '--hard', result.head);
  }
  process.stdout.write(`${JSON.stringify({ ...result, previousHead })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ route: 're-review', reason: error.message, ...fallback, previousHead })}\n`);
}
