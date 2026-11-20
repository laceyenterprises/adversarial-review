#!/usr/bin/env node
import { withHammerPublication } from '../src/ama/hammer-publication-ownership.mjs';
import { hammerNetworkCall, hammerLocalGit } from '../src/ama/hammer-api-network.mjs';
import { hammerPublicationFailureReason, publishHammerTree } from '../src/ama/hammer-api-publish.mjs';
import { inspectHammerSource, readHammerSource } from '../src/ama/hammer-source-publication.mjs';

const [repo, pr] = process.argv.slice(2);
const git = (...args) => hammerLocalGit(['--no-replace-objects', ...args]).toString();
const network = hammerNetworkCall;
const api = async (path, input) => JSON.parse((await network('gh',
  ['api', path, ...(input ? ['--input', '-'] : [])], input ? JSON.stringify(input) : undefined)).toString());
const number = String(pr).match(/\/pull\/([1-9]\d*)/)?.[1] || pr;
let previousHead, pushedHead, localHead;
try {
  const result = await withHammerPublication({ repo, prNumber: number }, async beginMutation => {
    const source = await readHammerSource(repo, number);
    const { branch } = source;
    previousHead = source.previousHead;
    localHead = git('rev-parse', '--verify', 'HEAD^{commit}').trim();
    const kind = await inspectHammerSource({ ...source, localHead });
    if (kind === 'unchanged') return { route: 'unchanged', head: localHead };
    const fallback = { route: 'git-fallback', branch, fallbackHead: previousHead, localHead };
    if (kind === 'rewrite' || git('rev-list', '--count', `${previousHead}..${localHead}`).trim() !== '1'
      || git('rev-list', '--parents', '-n', '1', localHead).trim().split(/\s+/).length !== 2) return fallback;
    const entries = ref => new Map(git('ls-tree', '-rz', ref).split('\0').filter(Boolean).map(entry => {
      const tab = entry.indexOf('\t');
      const meta = entry.slice(0, tab), path = entry.slice(tab + 1);
      const [mode, , oid] = meta.split(' ');
      return [path, { mode, oid }];
    }));
    const before = entries(previousHead), after = entries(localHead);
    const changes = [...new Set([...before.keys(), ...after.keys()])]
      .filter(path => before.get(path)?.oid !== after.get(path)?.oid || before.get(path)?.mode !== after.get(path)?.mode)
      .map(path => ({ path, oldMode: before.get(path)?.mode, mode: after.get(path)?.mode,
        contents: after.get(path)?.mode === '100644'
          ? hammerLocalGit(['--no-replace-objects', 'cat-file', 'blob', after.get(path).oid]).toString('base64') : undefined }));
    const result = await publishHammerTree({ repo, branch, expectedHead: previousHead,
      localTree: git('rev-parse', `${localHead}^{tree}`).trim(), message: git('log', '-1', '--format=%B', localHead).trim(), changes,
      api: (path, input) => { if (input) beginMutation(); return api(path, input); } });
    return result.route === 'git-fallback' ? { ...result, ...fallback } : result;
  });
  if (result.route === 'published') {
    pushedHead = result.head;
    await network('git', ['fetch', '--no-recurse-submodules', 'origin', result.head]);
    if (git('rev-parse', `${result.head}^{tree}`).trim() !== result.tree) throw new Error('fetched tree mismatch');
    if (git('rev-parse', 'HEAD').trim() !== localHead || git('status', '--porcelain')) {
      throw new Error('scratch changed during API publication');
    }
    git('reset', '--hard', result.head);
  }
  process.stdout.write(`${JSON.stringify({ ...result, previousHead })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ route: 'refused', reason: hammerPublicationFailureReason(error),
    phaseOutcome: error.gitCredentialRefreshFailed ? 'git-credential-refresh-failed' : error.phaseOutcome ?? 'source-publication-refused',
    pushedHead, previousHead })}\n`);
}
