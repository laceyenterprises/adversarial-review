#!/usr/bin/env node
import { hammerNetworkCall, hammerLocalGit } from '../src/ama/hammer-api-network.mjs';
import { hammerPublicationFailureReason, publishHammerTree } from '../src/ama/hammer-api-publish.mjs';
const [repo, pr] = process.argv.slice(2);
const git = (...args) => hammerLocalGit(args);
const network = hammerNetworkCall;
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
  } catch (error) {
    // Exit 1 is Git's negative ancestry proof. A killed/failed probe is unknown.
    if (error.status !== 1 || error.signal || error.killed) throw error;
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
  process.stdout.write(`${JSON.stringify({ route: 're-review', reason: hammerPublicationFailureReason(error), ...fallback, previousHead })}\n`);
}
