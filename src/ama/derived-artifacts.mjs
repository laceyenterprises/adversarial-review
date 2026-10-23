import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { constants, existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, writeFile, readFile, rm, realpath, lstat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { loadDomainConfig } from '../domain-config.mjs';

const SHA = /^[0-9a-f]{40}$/;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 10000;
const MAX_ARTIFACTS = 4;
const PREFIX = 'build:artifact:';
const blobSha = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.includes('\\')
    && !/[\x00-\x1f\x7f]/.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

// A clean environment plus an OS sandbox: npm's offline flag alone cannot deny
// networking by arbitrary build programs. Unsupported hosts fail closed.
export function artifactSandbox(root, cwd, command, platform = process.platform) {
  const nodeBin = dirname(process.execPath);
  // npm's bin entry point loads its implementation from the sibling lib tree.
  // Expose those tool directories, never the entire prefix (which may be HOME).
  const nodeTools = [nodeBin, resolve(nodeBin, '..', 'lib')];
  const env = {
    PATH: `${nodeBin}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`,
    HOME: join(root, '.home'), TMPDIR: join(root, '.tmp'),
    LANG: 'C', LC_ALL: 'C', TZ: 'UTC', SOURCE_DATE_EPOCH: '0',
    npm_config_ignore_scripts: 'true', npm_config_offline: 'true',
    npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_userconfig: join(root, '.home', 'user.npmrc'),
    npm_config_globalconfig: join(root, '.home', 'global.npmrc'),
    npm_config_cache: join(root, '.home', 'npm-cache'),
  };
  if (platform === 'darwin') {
    const literal = value => JSON.stringify(value);
    const reads = ['/usr', '/bin', '/sbin', '/System', '/Library/Apple', '/opt/homebrew', '/dev', '/private/var/db/dyld', ...nodeTools, root];
    // dyld opens /; Node resolves executable/cwd ancestors with metadata reads.
    // File contents still require an explicit allowed subtree.
    const profile = `(version 1)(deny default)(allow process-exec process-fork)(allow sysctl-read)
      (allow file-read-metadata)(allow file-read* (literal "/"))
      (allow file-read* ${reads.map(path => `(subpath ${literal(path)})`).join(' ')})
      (allow file-write* (subpath ${literal(root)}) (literal "/dev/null"))`;
    return { file: '/usr/bin/sandbox-exec', args: ['-p', profile, '/bin/sh', '-c', command], env, cwd };
  }
  if (platform === 'linux') {
    const toolMounts = nodeTools.filter(path => !['/usr', '/bin', '/lib', '/lib64']
      .some(system => path === system || path.startsWith(`${system}/`)))
      .flatMap(path => ['--ro-bind-try', path, path]);
    // No host home, sockets, credentials, Git metadata or network namespace.
    return { file: 'bwrap', args: ['--unshare-all', '--die-with-parent', '--new-session',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      ...toolMounts,
      // Permit loader/tool symlink resolution without exposing all host /etc.
      '--dir', '/etc', '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
      '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
      '--dir', dirname(root),
      '--proc', '/proc', '--dev', '/dev', '--bind', root, root,
      '--chdir', cwd, '/bin/sh', '-c', command], env, cwd };
  }
  throw new Error('derived artifact OS sandbox unavailable');
}

export async function runArtifactBuild(spec, signal) {
  signal.throwIfAborted();
  await new Promise((accept, reject) => {
    const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env,
      detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
    let expired = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    const abort = () => { expired = true; kill(); };
    const timer = setTimeout(abort, 30000);
    signal.addEventListener('abort', abort, { once: true });
    // Kill background descendants even when the declared command exits zero.
    child.once('exit', kill);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (expired || code !== 0) reject(new Error('derived artifact build failed or exceeded its time budget'));
      else accept();
    });
  });
}

// Immutable API objects materialize the final head in an isolated scratch
// worktree, without exposing a daemon checkout, Git hooks or host dependencies.
// This proof is deliberately collected after durable history-cache lookup.
export async function proveDerivedArtifacts({ repo, get, signal }, evidence, { runBuildImpl = runArtifactBuild } = {}) {
  if (evidence.hasHammerCommits !== true) return [];
  const candidates = (evidence.primaryFiles || []).filter(file => typeof file.patch !== 'string'
    && ['added', 'modified'].includes(file.status)).map(file => ({ before: file,
    after: evidence.finalFiles?.find(entry => entry.filename === file.filename) }))
    .filter(({ before, after }) => after && after.status === before.status && after.sha !== before.sha);
  if (!candidates.length || candidates.length > MAX_ARTIFACTS) return [];
  let scratch;
  const deadline = AbortSignal.timeout(120000);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const trees = new Map(), blobs = new Map();
  let totalBytes = 0, checkoutBytes = 0, count = 0;
  const read = async path => {
    bounded.throwIfAborted();
    // Readers normally have their own transport budget. Also bound injected or
    // stalled readers here; late responses never write into the scratch tree.
    return new Promise((accept, reject) => {
      const abort = () => reject(bounded.reason);
      bounded.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => get(path)).then(accept, reject)
        .finally(() => bounded.removeEventListener('abort', abort));
    });
  };
  const tree = async ref => {
    if (!trees.has(ref)) {
      const data = await read(`repos/${repo}/git/trees/${ref}`);
      if (data.truncated || !Array.isArray(data.tree)) throw new Error('incomplete artifact source tree');
      const names = new Set();
      for (const entry of data.tree) {
        if (!safePath(entry.path) || entry.path.includes('/') || !SHA.test(entry.sha)
          || names.has(entry.path)) throw new Error('unsafe artifact source tree');
        names.add(entry.path);
      }
      trees.set(ref, data.tree);
    }
    return trees.get(ref);
  };
  const blob = async sha => {
    if (!blobs.has(sha)) {
      const data = await read(`repos/${repo}/git/blobs/${sha}`);
      if (data.encoding !== 'base64' || typeof data.content !== 'string' || data.size > MAX_BYTES) throw new Error('unreadable artifact source blob');
      const bytes = Buffer.from(data.content, 'base64');
      totalBytes += bytes.length;
      if (bytes.length !== data.size || blobSha(bytes) !== sha || totalBytes > MAX_BYTES) throw new Error('invalid or oversized artifact source blob');
      blobs.set(sha, bytes);
    }
    return blobs.get(sha);
  };
  const manifest = async (head, directory) => {
    let ref = head;
    for (const part of directory ? directory.split('/') : []) {
      const entry = (await tree(ref)).find(entry => entry.path === part);
      if (entry?.type !== 'tree') return null;
      ref = entry.sha;
    }
    const entry = (await tree(ref)).find(entry => entry.path === 'package.json');
    if (entry?.type !== 'blob' || entry.mode !== '100644') return null;
    return JSON.parse((await blob(entry.sha)).toString('utf8'));
  };
  try {
    if (!SHA.test(evidence.headSha) || !SHA.test(evidence.primaryHead)) return [];
    const declared = [];
    for (const { before, after } of candidates) {
      if (!safePath(after.filename) || !SHA.test(after.sha)) continue;
      let directory = dirname(after.filename);
      while (true) {
        if (directory === '.') directory = '';
        const key = PREFIX + (directory ? after.filename.slice(directory.length + 1) : after.filename);
        const original = (await manifest(evidence.primaryHead, directory))?.scripts?.[key];
        const final = (await manifest(evidence.headSha, directory))?.scripts?.[key];
        if (typeof original === 'string' && original.trim() && original === final) {
          declared.push({ path: after.filename, primaryBlob: before.sha, blob: after.sha, directory, command: final });
          break;
        }
        if (!directory) break;
        directory = dirname(directory);
      }
    }
    if (!declared.length) return [];
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'derived-artifact-')));
    const directories = ['', '.home', '.tmp'];
    const checkout = async (ref, directory) => {
      for (const entry of await tree(ref)) {
        bounded.throwIfAborted();
        if (++count > MAX_FILES) throw new Error('artifact source file limit');
        const path = join(directory, entry.path);
        if (entry.type === 'tree' && entry.mode === '040000') {
          await mkdir(path);
          directories.push(relative(scratch, path));
          await checkout(entry.sha, path);
        } else if (entry.type === 'blob' && ['100644', '100755'].includes(entry.mode)) {
          const bytes = await blob(entry.sha);
          checkoutBytes += bytes.length;
          if (checkoutBytes > MAX_BYTES) throw new Error('artifact checkout byte limit');
          await writeFile(path, bytes, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
        } else throw new Error('unsupported symlink or submodule in artifact sources');
        await utimes(path, 0, 0);
      }
    };
    await checkout(evidence.headSha, scratch);
    const proofs = [];
    for (const declaration of declared) {
      // Each proof starts from the head's sources, never another build's output.
      const root = await realpath(await mkdtemp(join(tmpdir(), 'derived-build-')));
      try {
        await cp(scratch, root, { recursive: true, preserveTimestamps: true });
        for (const item of declared) await rm(join(root, item.path), { force: true });
        await mkdir(join(root, '.home'), { recursive: true });
        await mkdir(join(root, '.tmp'), { recursive: true });
        // Copying sources and preparing outputs/HOME/TMPDIR can touch directory
        // mtimes. Normalize every directory only after the final mutation.
        for (const directory of new Set(directories)) {
          bounded.throwIfAborted();
          await utimes(join(root, directory), 0, 0);
        }
        await runBuildImpl(artifactSandbox(root, join(root, declaration.directory), declaration.command), bounded);
        const output = join(root, declaration.path);
        const actual = await realpath(output);
        if (relative(root, actual).startsWith('..') || resolve(actual) === root) continue;
        const stat = await lstat(output);
        if (!stat.isFile() || stat.size > MAX_BYTES) continue;
        const bytes = await readFile(output, { flag: constants.O_RDONLY | constants.O_NOFOLLOW });
        if (blobSha(bytes) === declaration.blob) proofs.push({ ...declaration,
          headSha: evidence.headSha, primaryHead: evidence.primaryHead, comparison: 'git-blob-sha1' });
      } catch { /* Build failures and mismatches keep the opaque refusal. */ }
      finally { await rm(root, { recursive: true, force: true }); }
    }
    return proofs;
  } catch { return []; }
  finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
}

const exec = promisify(execFile);
const BLOCK_SHA = /^[0-9a-f]{40}$/i;
const LIMIT = 2 * 1024 * 1024;

function safeBlockPath(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path)
    && !path.split(/[\\/]/).includes('..') && !path.includes('\0');
}

// Deliberately small path glob vocabulary, available on every supported Node.
function matchesPath(path, glob) {
  let pattern = '^';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      index++;
      if (glob[index + 1] === '/') { pattern += '(?:.*/)?'; index++; }
      else pattern += '.*';
    } else if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(pattern + '$').test(path);
}

// Declarations live in the application's existing manifest, not host config.
export function declaredGeneratedBlocks(manifest) {
  const entries = manifest?.generatedArtifacts;
  if (!Array.isArray(entries) || entries.length > 32) return [];
  return entries.filter(entry => safeBlockPath(entry?.path) && safeBlockPath(entry.cwd)
    && typeof entry.start === 'string' && entry.start.trim() === entry.start && entry.start.length > 0
    && typeof entry.end === 'string' && entry.end.trim() === entry.end && entry.end.length > 0
    && entry.start !== entry.end && !/[\r\n]/.test(entry.start + entry.end)
    && Array.isArray(entry.command) && entry.command.length > 0 && entry.command.length <= 64
    && entry.command.every(arg => typeof arg === 'string' && !arg.includes('\0'))
    && entry.command[0].length > 0);
}

// Marker lines are never derived. Ambiguous/duplicate markers fail closed.
export function generatedBlock(bytes, declaration) {
  const lines = bytes.toString('utf8').split('\n');
  const starts = [], ends = [];
  lines.forEach((line, index) => {
    if (line.replace(/\r$/, '') === declaration.start) starts.push(index);
    if (line.replace(/\r$/, '') === declaration.end) ends.push(index);
  });
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) throw new Error('ambiguous generated block');
  const startOffset = lines.slice(0, starts[0] + 1).join('\n').length + 1;
  const endOffset = lines.slice(0, ends[0]).join('\n').length + 1;
  return { start: starts[0] + 2, end: ends[0] + 1,
    startOffset, endOffset, content: bytes.subarray(Buffer.byteLength(bytes.toString('utf8').slice(0, startOffset)),
      Buffer.byteLength(bytes.toString('utf8').slice(0, endOffset))) };
}

async function regularFile(root, path) {
  if (!safeBlockPath(path)) throw new Error('invalid artifact path');
  const target = join(root, path);
  const inside = relative(await realpath(root), await realpath(target));
  if (inside.startsWith('..') || isAbsolute(inside) || !(await lstat(target)).isFile()) throw new Error('artifact escaped scratch tree');
  const bytes = await readFile(target);
  if (bytes.length > LIMIT || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('unsupported artifact text');
  return bytes;
}

// Kill the whole process group on timeout/abort, including generator children.
export async function runDerivedGenerator({ scratch, cwd, command, signal, timeoutMs = 10000 }) {
  const root = await realpath(scratch);
  const work = await realpath(join(root, cwd));
  if (relative(root, work).startsWith('..')) throw new Error('generator cwd escaped scratch tree');
  const home = join(root, 'home');
  await mkdir(home, { recursive: true });
  let executable, args;
  if (process.platform === 'darwin') {
    // Read system runtimes and this scratch tree only; deny network and writes
    // outside scratch. No host HOME, auth environment or Git config is passed.
    const quote = value => JSON.stringify(value);
    const profile = `(version 1)(deny default)(allow process*)(allow sysctl-read)(allow mach-lookup)
      (allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin")
        (subpath "/Library/Frameworks") (subpath "/Library/Developer")
        (subpath "/opt") (subpath "/dev")
        (subpath ${quote(root)}))
      (allow file-write* (subpath ${quote(root)}) (literal "/dev/null"))`;
    executable = '/usr/bin/sandbox-exec';
    args = ['-p', profile, ...command];
  } else if (process.platform === 'linux') {
    executable = 'bwrap';
    args = ['--unshare-all', '--die-with-parent', '--new-session'];
    for (const path of ['/usr', '/bin', '/lib', '/lib64', '/opt']) {
      if (existsSync(path)) args.push('--ro-bind', path, path);
    }
    args.push('--proc', '/proc', '--dev', '/dev', '--bind', root, root, '--chdir', work, '--', ...command);
  } else throw new Error('network-denied generator sandbox unavailable');
  signal?.throwIfAborted();
  await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: work, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', HOME: home, TMPDIR: home,
        LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    let failure;
    const kill = error => {
      failure = error;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Child already exited. */ }
    };
    const abort = () => kill(signal.reason);
    const timer = setTimeout(() => kill(new Error('generator timed out')), timeoutMs);
    let stderr = '';
    child.stderr.on('data', bytes => {
      stderr += bytes.toString('utf8');
      if (stderr.length > 4096) kill(new Error('generator output limit exceeded'));
    });
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // Also retire descendants left behind by an otherwise successful parent.
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* No descendants. */ }
      if (failure || code !== 0) reject(failure || new Error(`generator failed: ${stderr.slice(0, 4096)}`));
      else resolvePromise();
    });
    if (signal?.aborted) abort();
  });
}

// Shared checkout seam for reproducible derived output (blocks or opaque files).
// Scratch owns all Git metadata: generators cannot mutate a host worktree/index.
export async function withDerivedCheckout({ repo, rootDir, headSha, mergeBase, signal, localRepository }, operation) {
  if (!BLOCK_SHA.test(headSha) || !BLOCK_SHA.test(mergeBase) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('invalid derived checkout identity');
  const scratch = await mkdtemp(join(tmpdir(), 'primary-derived-'));
  const git = (...args) => exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    { cwd: scratch, encoding: 'utf8', timeout: 15000, maxBuffer: LIMIT, signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  try {
    await git('init', '--bare', '-q', 'objects.git');
    let source = localRepository;
    if (!source && rootDir) {
      try { source = loadDomainConfig(rootDir, 'code-pr')?.remediationCloneReferences?.[repo]; } catch { /* Optional reference. */ }
      if (!source) {
        try {
          const origin = await exec('git', ['-C', rootDir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 5000, signal });
          if (origin.stdout.trim().replace(/\.git$/, '').endsWith(`/${repo}`)
            || origin.stdout.trim().replace(/\.git$/, '').endsWith(`:${repo}`)) source = rootDir;
        } catch { /* No local checkout for this subject. */ }
      }
    }
    const fetch = source => git('--git-dir=objects.git', 'fetch', '--no-tags', '--depth=1', source, headSha, mergeBase);
    if (source) {
      try { await fetch(source); } catch { await fetch(`https://github.com/${repo}.git`); }
    } else await fetch(`https://github.com/${repo}.git`);
    const tree = join(scratch, 'head');
    await git('--git-dir=objects.git', 'worktree', 'add', '--detach', tree, headSha);
    const show = async (ref, path) => (await git('--git-dir=objects.git', 'show', `${ref}:${path}`)).stdout;
    const reset = async () => {
      await git('-C', tree, 'reset', '--hard', headSha);
      await git('-C', tree, 'clean', '-fdx');
    };
    return await operation({ tree, scratch, show, reset });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export async function proveGeneratedBlocks(args, evidence, refusal, {
  checkoutImpl = withDerivedCheckout, runGeneratorImpl = runDerivedGenerator,
} = {}) {
  const regions = refusal.missingEvidence?.regions;
  if (!regions?.length || refusal.missingEvidence.evidence !== 'reversal-authorization') return [];
  try {
    const signal = AbortSignal.any([...(args.signal ? [args.signal] : []), AbortSignal.timeout(30000)]);
    const data = await args.get(`repos/${args.repo}/contents/package.json?ref=${evidence.mergeBase}`);
    if (data?.encoding !== 'base64' || typeof data.content !== 'string' || data.truncated) return [];
    const baseManifest = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    const declarations = declaredGeneratedBlocks(baseManifest).filter(entry => matchesPath(refusal.path, entry.path));
    if (!declarations.length) return [];
    return await checkoutImpl({ ...args, signal, headSha: evidence.headSha, mergeBase: evidence.mergeBase }, async ({ tree, scratch, show, reset }) => {
      const headDeclarations = declaredGeneratedBlocks(JSON.parse(await show(evidence.headSha, 'package.json')));
      const proofs = [];
      for (const declaration of declarations) {
        if (!headDeclarations.some(entry => JSON.stringify(entry) === JSON.stringify(declaration))) continue;
        const baseBytes = Buffer.from(await show(evidence.mergeBase, refusal.path));
        const base = generatedBlock(baseBytes, declaration);
        if (!regions.some(region => region.start >= base.start && region.end <= base.end)) continue;
        await reset();
        // Refuse renames/deletions, missing markers and output that only survives
        // because the generator leaves its input untouched. Preserve the markers.
        const before = await regularFile(tree, refusal.path);
        const block = generatedBlock(before, declaration);
        const text = before.toString('utf8');
        await writeFile(join(tree, refusal.path), text.slice(0, block.startOffset) + text.slice(block.endOffset));
        await runGeneratorImpl({ scratch, cwd: relative(scratch, join(tree, declaration.cwd)), command: declaration.command, signal });
        const after = await regularFile(tree, refusal.path);
        const regenerated = generatedBlock(after, declaration);
        if (block.content.equals(regenerated.content)) proofs.push({ path: refusal.path,
          start: base.start, end: base.end, headSha: evidence.headSha, mergeBase: evidence.mergeBase });
        // Each declaration starts from the same final-head artifact.
        await writeFile(join(tree, refusal.path), before);
      }
      return proofs;
    });
  } catch {
    args.signal?.throwIfAborted();
    // Optional proof failure must retain the independently computed refusal.
    return [];
  }
}
