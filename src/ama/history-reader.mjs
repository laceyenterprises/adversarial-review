import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { immutableSnapshotValue, readClosureImmutable } from '../closure-evaluation-cache.mjs';
import { execHistoryFile, historyChildExecutor } from './history-child.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execGhWithRetry, GH_LOOKUP_MAX_BUFFER } from '../gh-cli.mjs';
import { HISTORY_CONTEXT_TIMEOUT_MS, historyReadErrorDetail, historyReadRetryDelayMs, historyReadTimeoutError, withHistoryReadBudget } from './history-read-policy.mjs';
import { currentGitHubBudgetScope, withGitHubBudgetScope } from '../rate-limit-throttle.mjs';

const commitFields = '{sha, commit: {message: .commit.message, author: .commit.author, committer: .commit.committer}, author, committer, parents: [.parents[] | {sha}]}';

// REST compare files are capped at 300 and cannot be paginated. Read only
// comparison metadata/commit pages, then walk immutable trees (skipping equal
// subtrees) and diff one changed blob pair at a time. Never buffer a compare's
// patches, and never treat a server cap as a complete protected file list.
export function createHistoryReader(options = {}) {
  const { execGhWithRetryImpl = execGhWithRetry, diffImpl = execHistoryFile,
    contextTimeoutMs = HISTORY_CONTEXT_TIMEOUT_MS, nowMs = () => performance.now(), ...ghOptions } = options;
  const executorIdentity = ghOptions.execFileImpl || execHistoryFile;
  ghOptions.execFileImpl = historyChildExecutor(executorIdentity);
  const controller = new AbortController();
  ghOptions.signal = ghOptions.signal ? AbortSignal.any([ghOptions.signal, controller.signal]) : controller.signal;
  let deadline;
  const remainingMs = () => {
    ghOptions.signal?.throwIfAborted();
    deadline ??= nowMs() + contextTimeoutMs;
    const remaining = Math.floor(deadline - nowMs());
    if (remaining <= 0) throw historyReadTimeoutError();
    return remaining;
  };
  const cache = new Map();
  const json = async (path, jq = '.') => {
    try {
      // Only object-addressed evidence is immutable. Keep PR metadata, refs,
      // reviews and cost/label provenance live even on the same PR head.
      const immutable = /\/(?:git\/(?:trees|blobs)|commits)\/[0-9a-f]{40}(?:\?|$)/i.test(path)
        || /\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}(?:\?|$)/i.test(path);
      const execute = async () => {
        const run = () => execGhWithRetryImpl({ ...ghOptions,
          // Include response headers so failed rate-limit reads retain the
          // server's Retry-After; strip headers before parsing successful JSON.
          args: ['api', path, '--jq', jq, '--include'], timeoutMs: loadAwareTimeoutMs(15000),
          retries: 2, retryDelayMs: historyReadRetryDelayMs, totalTimeoutMs: remainingMs(), nowMs });
        // CLI reads must defer an exhausted shared quota instead of entering an
        // unbounded throttle sleep. Daemon callers retain their existing scope.
        const { stdout } = await bounded(() => currentGitHubBudgetScope() ? run() : withGitHubBudgetScope({}, run));
        ghOptions.signal.throwIfAborted();
        return immutableSnapshotValue(JSON.parse(stdout.replace(/^HTTP\/[\s\S]*?\r?\n\r?\n/, '')));
      };
      const env = ghOptions.env || process.env;
      return await (immutable
        ? readClosureImmutable(execGhWithRetryImpl, [path, jq, env.GH_TOKEN, env.GITHUB_TOKEN,
          env.GH_HOST, env.GH_CONFIG_DIR], execute, executorIdentity, ghOptions.signal)
        : execute());
    } catch (cause) {
      const limit = cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || cause.code === 'ENOBUFS'
        ? ` (output limit ${GH_LOOKUP_MAX_BUFFER} bytes exceeded)` : '';
      const error = new Error(historyReadErrorDetail(`history read failed: ${path}${limit}: ${historyReadErrorDetail(cause)}`), { cause });
      if (cause.code === 'HISTORY_READ_TIMEOUT') error.code = cause.code;
      error.primaryChangeReadFailed = true;
      throw error;
    }
  };
  const cached = (path, jq) => {
    const key = `${path}:${jq}`;
    if (!cache.has(key)) {
      const pending = json(path, jq);
      cache.set(key, pending);
      pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
    }
    return cache.get(key);
  };
  const tree = async (repo, ref) => {
    const data = await cached(`repos/${repo}/git/trees/${ref}`, '{tree: [.tree[] | {path, mode, type, sha}], truncated}');
    if (data.truncated || !Array.isArray(data.tree)) throw new Error(`incomplete tree ${ref}`);
    return new Map(data.tree.map(entry => [entry.path, entry]));
  };
  const filesBetween = async (repo, base, head) => {
    const changed = [];
    // A complete recursive snapshot coalesces directory reads. Inspect roots
    // first: flat histories need no extra request, and truncated recursive
    // responses must fall back to the uncapped subtree walker below.
    const snapshot = async ref => {
      if (!ref) return new Map();
      const root = await tree(repo, ref);
      if (![...root.values()].some(entry => entry.type === 'tree')) return root;
      const data = await cached(`repos/${repo}/git/trees/${ref}?recursive=1`,
        '{tree: [.tree[] | {path, mode, type, sha}], truncated}');
      if (data.truncated === true) return null;
      if (data.truncated !== false || !Array.isArray(data.tree)) throw new Error(`incomplete recursive tree ${ref}`);
      const entries = new Map();
      const children = new Map();
      for (const entry of data.tree) {
        remainingMs();
        if (typeof entry.path !== 'string' || !entry.path || entry.path.split('/').some(part => !part || part === '.' || part === '..')
          || entries.has(entry.path) || !/^[0-9a-f]{40}$/i.test(entry.sha || '')
          || !({ tree: ['040000'], blob: ['100644', '100755', '120000'], commit: ['160000'] })[entry.type]?.includes(entry.mode)) throw new Error(`invalid recursive tree ${ref}`);
        entries.set(entry.path, entry);
      }
      for (const [path, entry] of entries) {
        remainingMs();
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
        if (parent && entries.get(parent)?.type !== 'tree') throw new Error(`incomplete recursive tree ${ref}`);
        if (parent) {
          if (!children.has(parent)) children.set(parent, []);
          children.get(parent).push(entry);
        }
        if (!parent) {
          const original = root.get(path);
          if (!original || original.sha !== entry.sha || original.mode !== entry.mode || original.type !== entry.type) {
            throw new Error(`inconsistent recursive tree ${ref}`);
          }
        }
      }
      for (const name of root.keys()) if (!entries.has(name)) throw new Error(`incomplete recursive tree ${ref}`);
      // Rebuild every descendant tree object. The server's completeness marker
      // alone cannot detect an omitted child; its immutable parent SHA can.
      for (const [path, entry] of entries) if (entry.type === 'tree') {
        remainingMs();
        const rows = (children.get(path) || []).map(child => {
          const name = child.path.slice(path.length + 1);
          return { key: Buffer.from(`${name}${child.type === 'tree' ? '/' : ''}`),
            bytes: Buffer.concat([Buffer.from(`${child.mode.replace(/^0+/, '')} ${name}\0`), Buffer.from(child.sha, 'hex')]) };
        }).sort((a, b) => Buffer.compare(a.key, b.key));
        const body = Buffer.concat(rows.map(row => row.bytes));
        const digest = createHash('sha1').update(`tree ${body.length}\0`).update(body).digest('hex');
        if (digest !== entry.sha) throw new Error(`incomplete recursive tree ${ref}: ${path}`);
      }
      remainingMs();
      return new Map([...entries].filter(([, entry]) => entry.type !== 'tree'));
    };
    const [beforeSnapshot, afterSnapshot] = await Promise.all([snapshot(base), snapshot(head)]);
    if (beforeSnapshot && afterSnapshot) {
      for (const path of new Set([...beforeSnapshot.keys(), ...afterSnapshot.keys()])) {
        const a = beforeSnapshot.get(path), b = afterSnapshot.get(path);
        if (a?.sha !== b?.sha || a?.mode !== b?.mode) changed.push({ path, a, b });
      }
    }
    // Process independent directories in bounded waves. A depth-first await
    // serialized every sibling subtree before any blobs could be read.
    const pending = beforeSnapshot && afterSnapshot ? [] : [{ beforeRef: base, afterRef: head, prefix: '' }];
    while (pending.length) {
      const wave = pending.splice(0, 8);
      const settled = await Promise.allSettled(wave.map(async ({ beforeRef, afterRef, prefix }) => {
        if (beforeRef && beforeRef === afterRef) return [];
        const [before, after] = await Promise.all([
          beforeRef ? tree(repo, beforeRef) : new Map(),
          afterRef ? tree(repo, afterRef) : new Map(),
        ]);
        const children = [];
        for (const name of new Set([...before.keys(), ...after.keys()])) {
          const a = before.get(name), b = after.get(name);
          if (a?.sha === b?.sha && a?.mode === b?.mode) continue;
          const path = `${prefix}${name}`;
          if (a?.type === 'tree' || b?.type === 'tree') {
            if (a && a.type !== 'tree') changed.push({ path, a });
            if (b && b.type !== 'tree') changed.push({ path, b });
            children.push({ beforeRef: a?.type === 'tree' ? a.sha : null,
              afterRef: b?.type === 'tree' ? b.sha : null, prefix: `${path}/` });
          } else changed.push({ path, a, b });
        }
        return children;
      }));
      const failed = settled.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      for (const result of settled) for (const child of result.value) pending.push(child);
    }
    // Completion order of concurrent requests must not affect the evidence.
    changed.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const files = new Array(changed.length);
    const dir = await mkdtemp(join(tmpdir(), 'ham-history-'));
    const blob = async entry => {
      // Gitlinks have no file contents; type transitions diff the blob side
      // against empty bytes without attempting to fetch a submodule commit.
      if (!entry || entry.type === 'commit') return Buffer.alloc(0);
      if (entry.type !== 'blob') throw new Error(`unsupported changed object ${entry.type}`);
      const data = await cached(`repos/${repo}/git/blobs/${entry.sha}`, '{encoding, content, size}');
      if (data.encoding !== 'base64' || typeof data.content !== 'string') throw new Error(`unreadable blob ${entry.sha}`);
      const bytes = Buffer.from(data.content, 'base64');
      if (bytes.length !== data.size) throw new Error(`incomplete blob ${entry.sha}`);
      return bytes;
    };
    try {
      let cursor = 0;
      const worker = async () => {
        while (cursor < changed.length) {
          const index = cursor++;
          const { path, a, b } = changed[index];
          const beforePath = `before-${index}`, afterPath = `after-${index}`;
          const file = { filename: path, status: !a ? 'added' : !b ? 'removed' : 'modified', sha: b?.sha || a.sha };
          if (a?.type === 'commit' && b?.type === 'commit') {
            file.additions = 0; file.deletions = 0; files[index] = file; continue;
          }
          await Promise.all([
            blob(a).then(bytes => { ghOptions.signal.throwIfAborted(); return writeFile(join(dir, beforePath), bytes, { signal: ghOptions.signal }); }),
            blob(b).then(bytes => { ghOptions.signal.throwIfAborted(); return writeFile(join(dir, afterPath), bytes, { signal: ghOptions.signal }); }),
          ]);
          let patch;
          try {
            ({ stdout: patch } = await bounded(() => diffImpl('git', ['-c', 'core.autocrlf=false', '-c', 'core.attributesFile=/dev/null', 'diff', '--diff-algorithm=myers', '--no-indent-heuristic', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', '--', beforePath, afterPath],
              { cwd: dir, encoding: 'utf8', timeout: Math.min(loadAwareTimeoutMs(15000), remainingMs()), maxBuffer: GH_LOOKUP_MAX_BUFFER, signal: ghOptions.signal, killSignal: 'SIGKILL' })));
          } catch (error) {
            if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.code === 'ENOBUFS') {
              throw new Error(`history diff output limit ${GH_LOOKUP_MAX_BUFFER} bytes exceeded for ${path}`, { cause: error });
            }
            if (error.code !== 1 || typeof error.stdout !== 'string') throw error;
            patch = error.stdout;
          }
          if (patch.includes('\n@@')) file.patch = patch.slice(patch.indexOf('@@'));
          file.additions = (file.patch || '').split('\n').filter(line => line.startsWith('+')).length;
          file.deletions = (file.patch || '').split('\n').filter(line => line.startsWith('-')).length;
          files[index] = file;
        }
      };
      // Bound GitHub and child concurrency without serializing every blob.
      // Settle all workers before deleting their temporary files on failure.
      const settled = await Promise.allSettled(Array.from({ length: Math.min(8, changed.length) }, () => worker().catch(error => { cursor = changed.length; throw error; })));
      const failed = settled.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      // Preserve pure-rename identity; edited renames remain conservative
      // add/delete evidence, never an authorization to discard old hunks.
      for (const removed of [...files].filter(file => file.status === 'removed')) {
        const added = files.find(file => file.status === 'added' && file.sha === removed.sha);
        if (added) {
          added.status = 'renamed';
          added.previous_filename = removed.filename;
          delete added.patch;
          added.additions = 0;
          added.deletions = 0;
          files.splice(files.indexOf(removed), 1);
        }
      }
      return files;
    } finally { await rm(dir, { recursive: true, force: true }); }
  };
  const bounded = async operation => withHistoryReadBudget(async signal => {
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try { return await operation(); }
    finally { signal.removeEventListener('abort', abort); }
  }, { signal: ghOptions.signal, timeoutMs: remainingMs() });
  const commitHistory = async path => {
    const compare = /^repos\/(.+\/[^/]+)\/compare\/([^?]+)$/.exec(path);
    if (!compare) throw new Error('commit history requires a compare path');
    // Symbolic refs are live even inside one reader; memoize only SHA pairs.
    const page = /^[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/i.test(compare[2]) ? cached : json;
    const commits = [];
    let result;
    const fields = `{status, total_commits, merge_base_commit: {sha: .merge_base_commit.sha}, commits: [.commits[] | ${commitFields}]}`;
    result = await page(`${path}?per_page=100&page=1`, fields);
    if (!Number.isSafeInteger(result.total_commits) || result.total_commits < 0) throw new Error('missing compare commit count');
    const batches = [result];
    const pageCount = Math.max(1, Math.ceil(result.total_commits / 100));
    let nextPage = 2;
    let stopped = false;
    const workers = await Promise.allSettled(Array.from({ length: Math.min(4, pageCount - 1) }, async () => {
      while (!stopped && nextPage <= pageCount) {
        const number = nextPage++;
        try {
          batches[number - 1] = await page(`${path}?per_page=100&page=${number}`, fields);
        } catch (error) {
          // Let active reads settle, but stop claiming pages after a failure.
          stopped = true;
          throw error;
        }
      }
    }));
    const failed = workers.find(entry => entry.status === 'rejected');
    if (failed) throw failed.reason;
    for (const batch of batches) {
      if (batch.total_commits !== result.total_commits || !Array.isArray(batch.commits)
        || batch.status !== result.status || batch.merge_base_commit?.sha !== result.merge_base_commit?.sha) throw new Error('inconsistent compare pagination');
      commits.push(...batch.commits);
    }
    if (commits.length !== result.total_commits) throw new Error('incomplete compare pagination');
    if (new Set(commits.map(commit => commit.sha)).size !== commits.length) throw new Error('duplicate compare commit page');
    if (!/^[0-9a-f]{40}$/i.test(result.merge_base_commit?.sha || '')) throw new Error('missing compare merge base');
    return { ...result, commits };
  };
  const reader = path => bounded(async () => {
    try {
      const compare = /^repos\/(.+\/[^/]+)\/compare\/([^?]+)$/.exec(path);
      if (compare) {
        const [, repo, range] = compare;
        const head = range.split('...')[1];
        const result = await commitHistory(path);
        return { ...result, filesComplete: true, files: await filesBetween(repo, result.merge_base_commit.sha, head) };
      }
      if (/\/commits\/[0-9a-f]{40}$/i.test(path)) {
        let result;
        const files = [];
        for (let page = 1; ; page++) {
          const batch = await json(`${path}?per_page=100&page=${page}`,
            `${commitFields.slice(0, -1)}, files: [.files[] | {filename, previous_filename, status, sha, patch, additions, deletions}]}`);
          result ??= batch;
          if (!Array.isArray(batch.files)) throw new Error('missing commit files');
          files.push(...batch.files);
          if (batch.files.length < 100) break;
          // The commit API caps files at 3000. Use the same uncapped tree path.
          if (files.length >= 3000) return { ...result, filesComplete: true, files: await filesBetween(path.split('/commits/')[0].slice(6), result.parents[0]?.sha, result.sha) };
        }
        return { ...result, filesComplete: true, files };
      }
      if (/\/pulls\/\d+\/files\?/.test(path)) return json(path, '[.[] | {filename, previous_filename, status, sha}]');
      return json(path);
    } catch (error) {
      error.primaryChangeReadFailed = true;
      throw error;
    }
  });
  // Cost/ancestry consumers need metadata, not reconstructed per-file patches.
  reader.commitHistory = path => bounded(() => commitHistory(path));
  reader.metadata = path => bounded(() => json(path, '{status, total_commits, merge_base_commit: {sha: .merge_base_commit.sha}}'));
  // Provenance proofs request compact web-flow verification separately; avoid
  // buffering signature payloads in every history and commit-file page.
  reader.commitVerification = path => bounded(() => json(path, '{sha, verification: .commit.verification}'));
  // The collector owns a deadline covering proofs as well as API history.
  // Bind that cancellation to every real child, without mutating a shared reader.
  reader.withSignal = signal => createHistoryReader({ ...options,
    contextTimeoutMs: remainingMs(),
    signal: AbortSignal.any([ghOptions.signal, signal]) });
  reader.persistPrimaryChange = true;
  return reader;
}
