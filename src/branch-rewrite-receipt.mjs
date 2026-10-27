// HOLDERPROOF-01: interoperates with Agent OS cwp_dispatch.branch_rewrite.
// Called only after a successful exact-lease push. Receipt storage failure must
// never turn a published push into an unpublished result or trigger a re-push.
import { randomUUID } from 'node:crypto';
import { mkdirSync, statSync, chmodSync, openSync, fchmodSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveHqRoot } from './hq-root.mjs';

const sha = /^[0-9a-f]{40}$/;
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function rewriteRepositoryKey(value) {
  const url = String(value || '').replace(/^workerpush::/, '');
  const scp = /^(?:[^/@:]+@)?github\.com:([^\s]+)$/.exec(url);
  let slug = scp?.[1];
  if (!slug) {
    if (isAbsolute(url)) return pathToFileURL(url).href;
    const parsed = new URL(url);
    if (parsed.protocol === 'file:') return parsed.href;
    if (parsed.hostname === 'github.com') slug = parsed.pathname.replace(/^\//, '');
  }
  slug = slug?.replace(/\/$/, '').replace(/\.git$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug || '')) throw new Error('rewrite-repository-unverified');
  return `github.com/${slug.toLowerCase()}`;
}

export function recordPublishedRewrite({ repository, branch, oldHead, newHead,
  actor, env = process.env } = {}) {
  const evidence = { repo: repository, branch, oldHead, newHead, actor };
  if (oldHead === newHead) return {};
  try {
    if (!repository || !branch || !actor || ![oldHead, newHead].every(tip => sha.test(tip || '') && /[1-9a-f]/.test(tip))) {
      throw new Error('invalid-branch-rewrite-receipt');
    }
    const root = resolveHqRoot(env);
    const parent = join(root, 'dispatch', 'branch-rewrites');
    const repoDir = join(parent, encode(repository));
    const directory = join(repoDir, encode(branch));
    mkdirSync(join(root, 'dispatch'), { recursive: true });
    for (const dir of [parent, repoDir, directory]) {
      mkdirSync(dir, { recursive: true, mode: 0o2770 });
      if (statSync(dir).uid === process.geteuid?.()) chmodSync(dir, 0o2770);
    }
    const destination = join(directory, `${randomUUID()}.json`);
    const temporary = destination.replace(/\.json$/, '.tmp');
    const row = { event: 'worker.branch_rewritten', ...evidence,
      launchRequestId: env.HQ_LAUNCH_REQUEST_ID || null, recordedAt: new Date().toISOString() };
    try {
      const fd = openSync(temporary, 'wx', 0o660);
      try {
        fchmodSync(fd, 0o660);
        writeFileSync(fd, JSON.stringify(row) + '\n');
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(temporary, destination);
      const directoryFd = openSync(directory, 'r');
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } finally { rmSync(temporary, { force: true }); }
    return { rewriteReceipt: destination };
  } catch (error) {
    // Exact tips remain recoverable; raw filesystem/auth diagnostics stay local.
    const rewriteReceiptError = { ...evidence, code: error.code || 'rewrite-receipt-unavailable' };
    console.warn('[branch-rewrite] published rewrite receipt unavailable', JSON.stringify(rewriteReceiptError));
    return { rewriteReceiptError };
  }
}

export async function recordWorkspaceRewrite({ git, oldHead, newHead, branch, actor, env, repository }) {
  try {
    try { await git(['merge-base', '--is-ancestor', oldHead, newHead]); return {}; }
    catch (error) { if (error.code !== 1) throw error; }
    repository ||= rewriteRepositoryKey(await git(['remote', 'get-url', '--push', 'origin']));
    return recordPublishedRewrite({ repository, branch, oldHead, newHead, actor, env });
  } catch (error) {
    const rewriteReceiptError = { branch, oldHead, newHead, actor, code: error.code || 'rewrite-receipt-unavailable' };
    console.warn('[branch-rewrite] published rewrite receipt unavailable', JSON.stringify(rewriteReceiptError));
    return { rewriteReceiptError };
  }
}
