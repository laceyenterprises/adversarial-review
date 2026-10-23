import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, mkdtemp, mkdir, writeFile, readFile, rm, realpath, lstat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

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
