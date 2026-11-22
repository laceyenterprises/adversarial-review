import { execFileSync } from 'node:child_process';
import { createHistoryReader } from '../../src/ama/history-reader.mjs';
import { GH_LOOKUP_MAX_BUFFER } from '../../src/gh-cli.mjs';

export function localPrimaryHistory({ source, base, head, prNumber = 1, changeResponse = (_route, data) => data }) {
  const readGit = (...argv) => execFileSync('git', ['--no-replace-objects', '-C', source, ...argv],
    { timeout: 10000, maxBuffer: GH_LOOKUP_MAX_BUFFER });
  const pinnedReads = new Map();
  function objects(refs, ...argv) {
    // The fixture owns this object store. Reuse Git bytes for full object IDs,
    // then build fresh responses so the fault hook still runs on each request.
    if (!refs.every(ref => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref))) return readGit(...argv);
    const key = JSON.stringify(argv);
    if (!pinnedReads.has(key)) pinnedReads.set(key, readGit(...argv));
    return pinnedReads.get(key);
  }
  const text = (refs, ...argv) => objects(refs, ...argv).toString('utf8').trimEnd();
  const lines = (refs, ...argv) => text(refs, ...argv).split('\n').filter(Boolean);
  function commit(sha) {
    const [parents, ...bodyParts] = text([sha], 'show', '-s', '--format=%P%x00%B', sha).split('\0');
    const message = bodyParts.join('\0');
    return { sha, commit: { message }, parents: parents.split(' ').filter(Boolean).map(sha => ({ sha })) };
  }
  return createHistoryReader({ contextTimeoutMs: 60000, execGhWithRetryImpl: async ({ args: [, route], signal }) => {
    signal.throwIfAborted();
    let data;
    if (route.endsWith(`/pulls/${prNumber}`)) data = { head: { sha: head }, base: { sha: base } };
    else if (route.includes('/compare/')) {
      const [from, to] = route.split('/compare/')[1].split('?')[0].split('...');
      const shared = text([from, to], 'merge-base', from, to);
      const shas = lines([from, to], 'rev-list', '--reverse', `${from}..${to}`);
      const page = Number(new URLSearchParams(route.split('?')[1]).get('page') || '1');
      data = { status: from === to ? 'identical' : shared === from ? 'ahead' : 'diverged',
        total_commits: shas.length, merge_base_commit: { sha: shared },
        commits: shas.slice((page - 1) * 100, page * 100).map(commit) };
    } else if (route.includes('/git/trees/')) {
      const [ref, query] = route.split('/git/trees/')[1].split('?');
      const tree = lines([ref], 'ls-tree', ...(query ? ['-r', '-t'] : []), ref).map(line => {
        const [, mode, type, sha, path] = /^(\d+) (\S+) (\S+)\t(.+)$/.exec(line);
        return { mode, type, sha, path };
      });
      data = { truncated: false, tree };
    } else if (route.includes('/git/blobs/')) {
      const ref = route.split('/git/blobs/')[1];
      const bytes = objects([ref], 'cat-file', 'blob', ref);
      data = { encoding: 'base64', size: bytes.length, content: bytes.toString('base64') };
    } else if (/\/(?:reviews|comments)\?/.test(route)) data = [];
    else throw new Error(`Unexpected offline fixture read: ${route}`);
    return { stdout: JSON.stringify(changeResponse(route, data)) };
  } });
}
