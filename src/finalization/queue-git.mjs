import { recordWorkspaceRewrite } from '../branch-rewrite-receipt.mjs';
// Git execution for the v2 finalization port. No API tree publisher, content
// repair, hook, generated-output regeneration or credential persistence.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, statSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { queueWaitMs } from './queue-wait.mjs';
import { proveQueueRebase, isQueueSha, QUEUE_REBASE_PROOF } from './queue-rebase-proof.mjs';
import { resolveLaneKey } from './ledger-events.mjs';

const config = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=true', '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false', '-c', 'rerere.enabled=false', '-c', 'submodule.recurse=false'];
const remote = repository => `git@github.com:${resolveLaneKey({ repository, base: 'main' }).repository}.git`;
const error = reason => Object.assign(new Error(reason), { reason });

// A timeout kills the complete process group and rejects only on close/drain.
// stdout/stderr are bounded and failures never expose auth/transport output.
export function runQueueGit(args, { cwd, timeoutMs, env = process.env } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1) throw error('git-deadline-expired');
  return new Promise((resolveResult, reject) => {
    const clean = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1' };
    for (const key of Object.keys(clean)) if (/^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|SHALLOW_FILE|NAMESPACE|TEMPLATE_DIR|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_PARAMETERS)$/.test(key)
      || /^(GIT_AUTHOR_|GIT_COMMITTER_|GIT_TRACE)/.test(key) || key === 'EMAIL') delete clean[key];
    const child = spawn('git', [...config, ...args], { cwd, env: clean, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = [], bytes = 0, failed = false;
    const kill = () => { failed = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* close/error settles */ } };
    const timer = setTimeout(kill, timeoutMs);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) kill(); else output.push(chunk); });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) kill(); });
    child.on('error', () => { clearTimeout(timer); reject(error('git-unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      const porcelain = Buffer.concat(output).toString('latin1');
      const statuses = porcelain.split('\n').filter(line => /^[ =*+!\-]\t/.test(line));
      if (code !== 0 || failed) reject(Object.assign(error(failed ? 'git-deadline-or-output-limit' : 'git-command-refused'),
        { code: failed ? null : code, publicationRefused: args[0] === 'push' && !failed && statuses.length === 1
          && /^!\t[^\t\n]+\t\[(?:remote rejected|rejected)\] [^\n]+$/.test(statuses[0]) }));
      // latin1 is a bijection over bytes. UTF-8 replacement would let distinct
      // invalid source bytes compare equal in an otherwise textual Git patch.
      else resolveResult(porcelain);
      output = [];
    });
  });
}

export function resolveQueueGitAdapter({ rootDir, run = runQueueGit, networkRunner, resolveRemote = remote,
  now = () => new Date().toISOString(), load, env = process.env } = {}) {
  const root = realpathSync(rootDir);
  if (statSync(root).uid !== process.getuid?.()) throw error('git-root-owner-mismatch');
  const parent = join(root, 'data', 'finalization-git');
  const wait = deadline => queueWaitMs(30_000, { ceilingMs: 60_000, deadline, now: now(), load });
  const git = (cwd, deadline, budget = Infinity) => args => run(args, { cwd, timeoutMs: Math.min(budget, wait(deadline)) });
  const transport = (repository, args, cwd, deadline, budget = Infinity, onInvoke = () => {}) => {
    const target = resolveRemote(repository);
    const local = typeof target === 'string' && target.startsWith('/');
    // Composition must supply the existing per-operation entitled credential
    // runner for network Git. Never fall back to the runtime user's SSH agent.
    if (!local && typeof networkRunner !== 'function') throw error('entitled-git-runner-unavailable');
    const command = args(target), timeoutMs = Math.min(budget, wait(deadline));
    if (!(timeoutMs > 0)) throw error('git-deadline-expired');
    onInvoke();
    return (local ? run : networkRunner)(command, { cwd, timeoutMs, deadline, repository });
  };
  const key = entry => createHash('sha256').update(JSON.stringify([entry.lane.repository, entry.prNumber, entry.head])).digest('hex');
  const workspace = (entry, id) => {
    if (typeof id !== 'string' || !new RegExp(`^${key(entry)}-[a-zA-Z0-9]+$`).test(id)) throw error('foreign-git-workspace');
    const path = realpathSync(join(parent, id));
    if (!path.startsWith(realpathSync(parent) + sep) || statSync(path).uid !== process.getuid?.()) throw error('foreign-git-workspace');
    return path;
  };
  return { name: 'isolated-git-v1', proofAdapter: QUEUE_REBASE_PROOF,
    // Read-only availability, used by the deployed probe; no mkdir/init/fetch.
    probe({ timeoutMs }) {
      const version = execFileSync('git', ['--version'], { timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (!/^git version \d+\./.test(version)) throw error('git-unavailable');
      return { name: 'isolated-git-v1', proofAdapter: QUEUE_REBASE_PROOF, version };
    },
    async prepare({ entry, oldHead, exactBase, headRepository, headRef, deadline }) {
      if (![oldHead, exactBase].every(isQueueSha)) throw error('invalid-rebase-sha');
      resolveLaneKey({ repository: headRepository, base: headRef });
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      const cwd = mkdtempSync(join(parent, key(entry) + '-'));
      let prepared = false;
      try {
        const g = git(cwd, deadline);
        await g(['init', '--quiet', '--template=']);
        // Fetch immutable objects; shallow or missing histories cannot prove.
        await transport(entry.lane.repository, target => ['fetch', '--no-tags', '--no-recurse-submodules', '--', target, exactBase], cwd, deadline);
        await transport(headRepository, target => ['fetch', '--no-tags', '--no-recurse-submodules', '--', target, oldHead], cwd, deadline);
        await g(['checkout', '--detach', '--quiet', oldHead]);
        const fork = (await g(['merge-base', '--all', oldHead, exactBase])).trim();
        if (!isQueueSha(fork)) throw error('unsupported-rebase-history');
        const sourceProof = await proveQueueRebase({ oldHead, candidate: oldHead, exactBase: fork, git: g });
        if (!sourceProof) throw error('unsupported-rebase-history');
        if (fork !== exactBase) {
          try {
            await g(['-c', 'user.name=Queue Rebase', '-c', 'user.email=queue@example.invalid', 'rebase',
              '--no-autostash', '--no-autosquash', '--no-rebase-merges', '--reapply-cherry-picks', '--keep-empty', '--empty=keep',
              '--onto', exactBase, fork, oldHead]);
          } catch (failure) {
            if (failure.reason !== 'git-command-refused') throw failure;
            // Never resolve a conflict or continue from a partially replayed tree.
            throw error('rebase-conflict-or-unsupported');
          }
        }
        const candidate = (await g(['rev-parse', 'HEAD'])).trim();
        const proof = await proveQueueRebase({ oldHead, candidate, exactBase, git: g });
        if (!proof) throw error('rebase-preservation-unproven');
        prepared = true;
        return { candidate, exactBase, expectedOldHead: oldHead, proof, workspace: cwd.slice(parent.length + 1) };
      } finally {
        // Only unreturned workspaces are disposable. Persisted candidates must
        // remain available for restart proof and unresolved-operation recovery.
        if (!prepared) rmSync(cwd, { recursive: true, force: true });
      }
    },
    async verify({ entry, deadline }) {
      const cwd = workspace(entry, entry.rebase.workspace);
      const g = git(cwd, deadline);
      if ((await g(['rev-parse', 'HEAD'])).trim() !== entry.candidate) return null;
      return proveQueueRebase({ oldHead: entry.expectedOldHead, candidate: entry.candidate, exactBase: entry.exactBase, git: g });
    },
    async push({ entry, intent }) {
      let invoked = false;
      // The pushed object is the verified SHA, never a mutable local branch.
      try {
        const cwd = workspace(entry, entry.rebase.workspace);
        await transport(entry.rebase.headRepository, target => ['push', '--porcelain',
          `--force-with-lease=refs/heads/${entry.rebase.headRef}:${intent.expectedOldHead}`,
          '--', target, `${intent.candidate}:refs/heads/${entry.rebase.headRef}`], cwd, intent.deadline, intent.timeoutMs, () => { invoked = true; });
        const receipt = await recordWorkspaceRewrite({ repository: `github.com/${entry.rebase.headRepository.toLowerCase()}`,
          branch: entry.rebase.headRef, oldHead: intent.expectedOldHead, newHead: intent.candidate,
          actor: 'review-service:finalization-queue', env, git: git(cwd, intent.deadline, intent.timeoutMs) });
        return { outcome: 'succeeded', sourceRef: `git:push:${intent.candidate}:refs/heads/${entry.rebase.headRef}`, ...receipt };
      } catch (failure) {
        // Explicit single-ref porcelain refusals prove non-application.
        // Transport/timeout failures remain ambiguous; do not expose diagnostics.
        if (!invoked) return { outcome: 'not-applied', sourceRef: 'git:push-not-spawned' };
        if (failure.reason === 'git-command-refused' && failure.publicationRefused) {
          return { outcome: 'not-applied', sourceRef: 'git:publication-refused' };
        }
        throw error('git-publication-ambiguous');
      }
    },
  };
}
