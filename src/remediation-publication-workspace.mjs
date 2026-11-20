import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertRemediationWorkspaceCustody, readHqWorkerStatus } from './remediation-hq-dispatch.mjs';
import { resolveHqRoot } from './remediation-reply-paths.mjs';

export function hqPublicationWorker(job) {
  const round = job?.remediationPlan?.rounds?.find(entry => entry.round === job.remediationPlan.currentRound);
  const worker = job?.remediationWorker || round?.worker;
  if (worker?.dispatchMode === 'hq' || worker?.dispatchId || worker?.requiresProducedAttestation
    || job?.remediationPlan?.dispatchPath === 'hq') return worker || {};
  return null;
}

export async function resolvePublicationWorkspace({
  job, workspaceDir, execFileImpl, env = process.env, log = console, canInspect = () => true,
}) {
  const worker = hqPublicationWorker(job);
  if (!worker) return workspaceDir;
  try {
    if (!worker.launchRequestId || !worker.dispatchId || !job.jobId || !job.repo || !job.branch) return null;
    const status = await readHqWorkerStatus({ worker, execFileImpl, env, logger: log });
    if (status?.launchRequestId !== worker.launchRequestId || status.dispatchId !== worker.dispatchId
      || status.ticketRef !== (worker.ticketRef || job.jobId)
      || typeof status.workerRunId !== 'string' || !status.workerRunId.trim()) return null;

    // Owner status can expose the selected checkout in both fields, or expose
    // the worker slot in workspacePath and its selected repository in repo.
    // A slot without a selected checkout gives us no repository to inspect.
    if (typeof status.workspacePath !== 'string' || !isAbsolute(status.workspacePath)
      || typeof status.repo !== 'string' || !isAbsolute(status.repo)) return null;
    const registeredRoot = resolve(worker.hqRoot || resolveHqRoot(env), 'workers');
    const workersRoot = realpathSync(registeredRoot);
    const relativePath = [registeredRoot, workersRoot].map(root => relative(root, status.repo))
      .find(path => path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
    if (!relativePath) return null;
    const selected = realpathSync(status.repo);
    const [slotName] = relativePath.split(sep);
    if (selected !== join(workersRoot, relativePath)) return null;
    const slot = join(workersRoot, slotName);
    const observed = realpathSync(status.workspacePath);
    if (observed !== slot && observed !== selected) return null;
    const marker = lstatSync(join(selected, '.git'));
    if (!marker.isDirectory() && !marker.isFile()) return null;
    assertRemediationWorkspaceCustody(selected, worker, env);
    if (!canInspect(selected)) return null;

    const git = async args => String((await execFileImpl('git', ['--no-replace-objects', '-C', selected, ...args],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 })).stdout || '').trim();
    if (realpathSync(await git(['rev-parse', '--show-toplevel'])) !== selected) return null;
    const origin = await git(['config', '--local', '--get-all', 'remote.origin.url']);
    const match = origin.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/iu);
    return match?.[1].toLowerCase() === job.repo.toLowerCase() ? selected : null;
  } catch {
    // Missing or unreadable owner evidence retains publication debt.
    return null;
  }
}
