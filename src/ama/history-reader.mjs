import { loadAwareTimeoutMs } from '../load-aware-timeout.mjs';
import { immutableSnapshotValue, readClosureImmutable } from '../closure-evaluation-cache.mjs';
import { execHistoryFile, historyChildExecutor } from './history-child.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execGhWithRetry, GH_LOOKUP_MAX_BUFFER } from '../gh-cli.mjs';
import { HISTORY_CONTEXT_TIMEOUT_MS, HISTORY_READ_ERROR_LIMIT, historyReadErrorDetail, historyReadRetryDelayMs, historyReadStopReason, historyReadTimeoutError, withHistoryReadBudget } from './history-read-policy.mjs';
import { currentGitHubBudgetScope, withGitHubBudgetScope } from '../rate-limit-throttle.mjs';
import { discardHistoryProgress, storedHistoryRead } from './primary-change-store.mjs';

const commitFields = '{sha, commit: {message: .commit.message, author: .commit.author, committer: .commit.committer}, author, committer, parents: [.parents[] | {sha}]}';
const treeFields = 'tree: [.tree[] | {path, mode, type, sha}], truncated';
const MAX_SOURCE_CHANGES = 64;

// REST compare files are capped at 300 and cannot be paginated. Read only
// comparison metadata/commit pages, then walk immutable trees (skipping equal
// subtrees) and diff one changed blob pair at a time. Never buffer a compare's
// patches, and never treat a server cap as a complete protected file list.
export function createHistoryReader(options = {}) {
  const { execGhWithRetryImpl = execGhWithRetry, diffImpl = execHistoryFile,
    contextTimeoutMs = loadAwareTimeoutMs(HISTORY_CONTEXT_TIMEOUT_MS), nowMs = () => performance.now(),
    progress, ...ghOptions } = options;
  const executorIdentity = ghOptions.execFileImpl || execHistoryFile;
  const execFile = historyChildExecutor(executorIdentity);
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
  const invalidHistory = message => {
    const error = Object.assign(new Error(message), { code: 'HISTORY_READ_INVALID' });
    // Abort at detection, before waiting for sibling workers to settle. A
    // stalled sibling must not turn semantic rejection into a sticky timeout.
    controller.abort(error);
    cache.clear();
    if (progress) discardHistoryProgress(progress);
    return error;
  };
  // Durable object facts belong to the canonical owner/repository/host, not an
  // expiring installation token. A fresh token on the next closer must retain
  // progress. Live PR/review reads still establish access and current state;
  // the evaluation-local cache below independently partitions credentials.
  const env = ghOptions.env || process.env;
  const host = env.GH_HOST || 'github.com';
  const checkpoint = async (key, run) => {
    remainingMs();
    const value = await (progress ? storedHistoryRead(progress, [host, ...key], run, ghOptions.signal) : run?.());
    remainingMs();
    return immutableSnapshotValue(value);
  };
  // checkpointProjection may differ from jq only by optional fields whose
  // absence the reader tolerates; required fields must change the durable key.
  const json = async (path, jq = '.', checkpointProjection = jq, fields = []) => {
    let attempts = 0;
    try {
      // Only object-addressed evidence is immutable. Keep PR metadata, refs,
      // reviews and cost/label provenance live even on the same PR head.
      const immutable = /\/(?:git\/(?:trees|blobs|commits)|commits)\/[0-9a-f]{40}(?:\?|$)/i.test(path)
        || /\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}(?:\?|$)/i.test(path);
      const execute = async () => {
        const run = () => execGhWithRetryImpl({ ...ghOptions,
          execFileImpl: (...args) => { attempts++; return execFile(...args); },
          // Include response headers so failed rate-limit reads retain the
          // server's Retry-After; strip headers before parsing successful JSON.
          args: ['api', path, ...fields, '--jq', jq, '--include'], timeoutMs: loadAwareTimeoutMs(15000),
          retries: /\/(?:git\/(?:trees|blobs|commits)|commits)\//.test(path) ? 4 : 2,
          retryDelayMs: historyReadRetryDelayMs, totalTimeoutMs: remainingMs(), nowMs });
        // CLI reads must defer an exhausted shared quota instead of entering an
        // unbounded throttle sleep. Daemon callers retain their existing scope.
        const { stdout } = await bounded(() => currentGitHubBudgetScope() ? run() : withGitHubBudgetScope({}, run));
        ghOptions.signal.throwIfAborted();
        return immutableSnapshotValue(JSON.parse(stdout.replace(/^HTTP\/[\s\S]*?\r?\n\r?\n/, '')));
      };
      return await (immutable
        ? checkpoint(['json', path, checkpointProjection], () => readClosureImmutable(execGhWithRetryImpl,
          [path, jq, env.GH_TOKEN, env.GITHUB_TOKEN, env.GH_HOST, env.GH_CONFIG_DIR],
          execute, executorIdentity, ghOptions.signal))
        : execute());
    } catch (cause) {
      const limit = cause?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || cause?.code === 'ENOBUFS'
        ? ` (output limit ${GH_LOOKUP_MAX_BUFFER} bytes exceeded)` : '';
      const stopReason = historyReadStopReason(cause);
      const prefix = `${historyReadErrorDetail(`history read failed: ${stopReason} attempts=${attempts} ${path}${limit}:`, 500)} `;
      throw Object.assign(new Error(prefix + historyReadErrorDetail(cause, HISTORY_READ_ERROR_LIMIT - prefix.length), { cause }), {
        primaryChangeReadFailed: true, code: cause?.code, stopReason,
      });
    }
  };
  const cached = (path, jq, checkpointProjection) => {
    const key = `${path}:${jq}`;
    if (!cache.has(key)) {
      const pending = json(path, jq, checkpointProjection);
      cache.set(key, pending);
      pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
    }
    return cache.get(key);
  };
  const readTree = async (repo, ref) => {
    // Existing checkpoints without the optional SHA can still supply all
    // root entries and use the original ref-addressed recursive lookup.
    const data = await cached(`repos/${repo}/git/trees/${ref}`, `{sha, ${treeFields}}`, `{${treeFields}}`);
    if (data.truncated || !Array.isArray(data.tree)) throw invalidHistory(`incomplete tree ${ref}`);
    return { sha: data.sha, entries: new Map(data.tree.map(entry => [entry.path, entry])) };
  };
  const tree = async (repo, ref) => (await readTree(repo, ref)).entries;
  const blob = async (repo, entry) => {
    const data = await cached(`repos/${repo}/git/blobs/${entry.sha}`, '{encoding, content, size}');
    if (data.encoding !== 'base64' || typeof data.content !== 'string') throw invalidHistory(`unreadable blob ${entry.sha}`);
    const bytes = Buffer.from(data.content, 'base64');
    if (bytes.length !== data.size) throw invalidHistory(`incomplete blob ${entry.sha}`);
    return bytes;
  };
  const filesBetween = async (repo, base, head, includePatch = () => true, inventoryOnly = false) => {
    const changed = [];
    // A complete recursive snapshot coalesces directory reads. Inspect roots
    // first: flat histories need no extra request, and truncated recursive
    // responses must fall back to the uncapped subtree walker below.
    const snapshot = async ref => {
      if (!ref) return new Map();
      const { sha, entries: root } = await readTree(repo, ref);
      if (![...root.values()].some(entry => entry.type === 'tree')) return root;
      // Different commits can name the same tree. Each exact ref still reads
      // its own root and validates the shared response against those entries.
      const recursiveRef = /^[0-9a-f]{40}$/i.test(ref) && /^[0-9a-f]{40}$/.test(sha || '') ? sha : ref;
      let data;
      try {
        data = await cached(`repos/${repo}/git/trees/${recursiveRef}?recursive=1`,
          `{${treeFields}}`);
      } catch (error) {
        // The recursive endpoint is an optimization. A smaller subtree read
        // may still succeed after transport retries or output overflow, but
        // cancellation, the shared deadline and malformed JSON stay terminal.
        remainingMs();
        if (error.code === 'HISTORY_READ_TIMEOUT'
          || !(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.code === 'ENOBUFS'
            || error.stopReason?.startsWith('history-read-failed:transient:'))) throw error;
        console.warn(`history recursive tree ${ref}: falling back to walker: ${historyReadErrorDetail(error)}`);
        return null;
      }
      if (data.truncated === true) return null;
      if (data.truncated !== false || !Array.isArray(data.tree)) throw invalidHistory(`incomplete recursive tree ${ref}`);
      const entries = new Map();
      const children = new Map();
      let unsupportedMode = false;
      for (const entry of data.tree) {
        remainingMs();
        if (typeof entry.path !== 'string' || !entry.path || entry.path.split('/').some(part => !part || part === '.' || part === '..')
          || entries.has(entry.path) || !/^[0-9a-f]{40}$/i.test(entry.sha || '')
          || !['tree', 'blob', 'commit'].includes(entry.type)
          || typeof entry.mode !== 'string' || !/^[0-7]{6}$/.test(entry.mode)) throw invalidHistory(`invalid recursive tree ${ref}`);
        if (!({ tree: ['040000'], blob: ['100644', '100755', '120000'], commit: ['160000'] })[entry.type].includes(entry.mode)) unsupportedMode = true;
        entries.set(entry.path, entry);
      }
      for (const [path, entry] of entries) {
        remainingMs();
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
        if (parent && entries.get(parent)?.type !== 'tree') throw invalidHistory(`incomplete recursive tree ${ref}`);
        if (parent) {
          if (!children.has(parent)) children.set(parent, []);
          children.get(parent).push(entry);
        }
        if (!parent) {
          const original = root.get(path);
          if (!original || original.sha !== entry.sha || original.mode !== entry.mode || original.type !== entry.type) {
            throw invalidHistory(`inconsistent recursive tree ${ref}`);
          }
        }
      }
      for (const name of root.keys()) if (!entries.has(name)) throw invalidHistory(`incomplete recursive tree ${ref}`);
      // Legacy modes cannot be rebuilt canonically. The existing walker can
      // still skip equal directories without interpreting their stored bytes.
      if (unsupportedMode) {
        console.warn(`history recursive tree ${ref}: falling back to walker: unsupported object mode`);
        return null;
      }
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
        if (digest !== entry.sha) throw invalidHistory(`incomplete recursive tree ${ref}: ${path}`);
      }
      remainingMs();
      return new Map([...entries].filter(([, entry]) => entry.type !== 'tree'));
    };
    const [beforeSnapshot, afterSnapshot] = await Promise.all([snapshot(base), snapshot(head)]);
    if (beforeSnapshot && afterSnapshot) {
      for (const path of new Set([...beforeSnapshot.keys(), ...afterSnapshot.keys()])) {
        if (inventoryOnly) remainingMs();
        const a = beforeSnapshot.get(path), b = afterSnapshot.get(path);
        if (a?.sha !== b?.sha || a?.mode !== b?.mode) changed.push({ path, a, b });
        if (inventoryOnly && changed.length > MAX_SOURCE_CHANGES) return null;
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
      if (inventoryOnly && changed.length > MAX_SOURCE_CHANGES) return null;
      for (const result of settled) for (const child of result.value) pending.push(child);
    }
    // Completion order of concurrent requests must not affect the evidence.
    changed.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (inventoryOnly) return changed;
    const files = new Array(changed.length);
    const dir = await mkdtemp(join(tmpdir(), 'ham-history-'));
    const changedBlob = async entry => {
      // Gitlinks have no file contents; type transitions diff the blob side
      // against empty bytes without attempting to fetch a submodule commit.
      if (!entry || entry.type === 'commit') return Buffer.alloc(0);
      if (entry.type !== 'blob') throw new Error(`unsupported changed object ${entry.type}`);
      return blob(repo, entry);
    };
    try {
      let cursor = 0;
      const worker = async () => {
        while (cursor < changed.length) {
          const index = cursor++;
          const { path, a, b } = changed[index];
          const file = { filename: path, status: !a ? 'added' : !b ? 'removed' : 'modified', sha: b?.sha || a.sha };
          if (!includePatch(path)) {
            files[index] = file;
            continue;
          }
          const beforePath = `before-${index}`, afterPath = `after-${index}`;
          files[index] = await checkpoint(['file', repo, base, head, path, a || null, b || null, 'myers-v1'], async () => {
            if (a?.type === 'commit' && b?.type === 'commit') {
              file.additions = 0; file.deletions = 0; return file;
            }
            await Promise.all([
              changedBlob(a).then(bytes => { ghOptions.signal.throwIfAborted(); return writeFile(join(dir, beforePath), bytes, { signal: ghOptions.signal }); }),
              changedBlob(b).then(bytes => { ghOptions.signal.throwIfAborted(); return writeFile(join(dir, afterPath), bytes, { signal: ghOptions.signal }); }),
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
            return file;
          });
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
          const renamed = { ...added, status: 'renamed', previous_filename: removed.filename, additions: 0, deletions: 0 };
          delete renamed.patch;
          files[files.indexOf(added)] = renamed;
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
    if (!Number.isSafeInteger(result.total_commits) || result.total_commits < 0) throw invalidHistory('missing compare commit count');
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
        || batch.status !== result.status || batch.merge_base_commit?.sha !== result.merge_base_commit?.sha) throw invalidHistory('inconsistent compare pagination');
      commits.push(...batch.commits);
    }
    if (commits.length !== result.total_commits) throw invalidHistory('incomplete compare pagination');
    if (new Set(commits.map(commit => commit.sha)).size !== commits.length) throw invalidHistory('duplicate compare commit page');
    if (!/^[0-9a-f]{40}$/i.test(result.merge_base_commit?.sha || '')) throw invalidHistory('missing compare merge base');
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
      if (/^repos\/[^/]+\/[^/]+\/git\/commits\/[0-9a-f]{40}$/i.test(path)) {
        return cached(path, '{sha, tree: {sha: .tree.sha}, parents: [.parents[] | {sha}]}');
      }
      if (/^repos\/[^/]+\/[^/]+\/commits\/[0-9a-f]{40}$/i.test(path)) {
        let result;
        const files = [];
        for (let page = 1; ; page++) {
          const batch = await json(`${path}?per_page=100&page=${page}`,
            `${commitFields.slice(0, -1)}, files: [.files[] | {filename, previous_filename, status, sha, patch, additions, deletions}]}`);
          result ??= batch;
          if (!Array.isArray(batch.files)) throw invalidHistory('missing commit files');
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
  // The caller establishes exact parentage. Compare those two trees directly,
  // retaining both blob identities and modes without opening any changed blobs.
  reader.exactFileChanges = (repo, before, after) => bounded(() =>
    filesBetween(repo, before, after, undefined, true));
  reader.forcePushTimelinePage = async (repo, prNumber, cursor) => {
    const [owner, name] = repo.split('/');
    const query = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) {
        timelineItems(first: 100, after: $cursor, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
          nodes { __typename ... on HeadRefForcePushedEvent {
            createdAt actor { __typename login } beforeCommit { oid } afterCommit { oid }
          } } pageInfo { hasNextPage endCursor }
        }
      } }
    }`;
    const fields = ['-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${prNumber}`];
    if (cursor) fields.push('-f', `cursor=${cursor}`);
    const response = await json('graphql', '.', undefined, fields);
    return response.errors ? null : response.data?.repository?.pullRequest?.timelineItems;
  };
  // Completed history publication removes durable progress; retain immutable
  // metadata for the rest of this evaluation without rereading it for CI cost.
  reader.metadata = path => bounded(() => (/\/compare\/[0-9a-f]{40}\.\.\.[0-9a-f]{40}$/i.test(path) ? cached : json)(
    path, '{status, total_commits, merge_base_commit: {sha: .merge_base_commit.sha}}'));
  // A full tree inventory does not require paging commit messages. Callers
  // select the paths that need hunks; inventory-only rows never write patch
  // checkpoints. Both sides are pinned to immutable tree inputs.
  reader.compareFiles = (path, includePatch = true) => bounded(async () => {
    const match = /^repos\/([^/]+\/[^/]+)\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/i.exec(path);
    if (!match) throw new Error('file inventory requires an exact compare pair');
    const [, repo] = match;
    const requestedBase = match[2].toLowerCase(), head = match[3].toLowerCase();
    path = `repos/${repo}/compare/${requestedBase}...${head}`;
    const result = await reader.metadata(path);
    const base = result.merge_base_commit?.sha;
    if (!/^[0-9a-f]{40}$/i.test(base || '')) throw invalidHistory('missing compare merge base');
    const filter = typeof includePatch === 'function' ? includePatch : () => Boolean(includePatch);
    const inventoryRow = file => file.status === 'renamed'
      ? { filename: file.filename, status: file.status, sha: file.sha,
        previous_filename: file.previous_filename, additions: 0, deletions: 0 }
      : { filename: file.filename, status: file.status, sha: file.sha };
    const readFiles = predicate => filesBetween(repo, base.toLowerCase(), head, predicate);
    // Guard review carry-forward can need the same complete projection after
    // each hit on scoped history. Reuse the immutable result, including rename
    // links, without walking the trees or reopening every per-file checkpoint.
    let files;
    if (progress && base.toLowerCase() === requestedBase) {
      const completeKey = ['complete-file-comparison-v1', path];
      const complete = await checkpoint(completeKey);
      if (complete !== undefined) {
        files = complete.map(file => filter(file.filename) ? file : inventoryRow(file));
      } else if (includePatch === true) {
        files = await checkpoint(completeKey, () => readFiles(filter));
      } else {
        const inventoryKey = ['complete-file-inventory-v1', path];
        const inventory = await checkpoint(inventoryKey);
        // Evaluate real paths, including both rename sides. A predicate's
        // answer for a synthetic empty path cannot establish its scope.
        if (inventory !== undefined && inventory.every(file => !filter(file.filename)
          && (!file.previous_filename || !filter(file.previous_filename)))) {
          files = inventory;
        } else {
          let selected = false;
          files = await readFiles(filename => {
            const include = filter(filename);
            selected ||= Boolean(include);
            return include;
          });
          // Inventory must never populate the complete-patch checkpoint.
          if (!selected) await checkpoint(inventoryKey, async () => files);
        }
      }
    } else files = await readFiles(filter);
    return { ...result, filesComplete: true, files };
  });
  // Provenance proofs request compact web-flow verification separately; avoid
  // buffering signature payloads in every history and commit-file page.
  reader.commitVerification = path => bounded(() => json(path, '{sha, verification: .commit.verification}'));
  // Read only data blobs pinned by immutable trees. A missing entry is
  // evidence of absence only after a complete walk of its parent tree.
  reader.regularDataFile = (repo, ref, path, { optional = false, asBuffer = false } = {}) => bounded(async () => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[0-9a-f]{40}$/.test(ref)
      || !path.split('/').every(part => /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(part))) {
      throw new Error('invalid immutable data file identity');
    }
    const parts = path.split('/');
    for (const [index, part] of parts.entries()) {
      const entry = (await tree(repo, ref)).get(part);
      if (!entry && optional) return null;
      if (!/^[0-9a-f]{40}$/.test(entry?.sha || '')) break;
      if (index === parts.length - 1 && entry.type === 'blob' && entry.mode === '100644') {
        const bytes = await blob(repo, entry);
        const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (actual !== entry.sha) throw Object.assign(new Error('immutable data blob hash mismatch'),
          { primaryChangeReadFailed: true });
        return asBuffer ? bytes : bytes.toString('utf8');
      }
      if (entry.type !== 'tree' || entry.mode !== '040000') break;
      ref = entry.sha;
    }
    throw new Error('expected a regular data file in the Git tree');
  });
  // The collector owns a deadline covering proofs as well as API history.
  // Bind that cancellation to every real child, without mutating a shared reader.
  reader.withSignal = signal => createHistoryReader({ ...options,
    contextTimeoutMs: remainingMs(),
    signal: AbortSignal.any([ghOptions.signal, signal]) });
  reader.withProgress = progress => createHistoryReader({ ...options, progress,
    contextTimeoutMs: remainingMs(), signal: ghOptions.signal });
  reader.persistPrimaryChange = true;
  return reader;
}
