import { existsSync } from 'node:fs';
import { isAbsolute, join, delimiter } from 'node:path';
import { loadConfigCached } from './config-loader.mjs';

/** Reuse the deploy-root contract and HQ's explicit source-package layout. */
export function resolveAgentOsPython({ env = process.env, root = env.AGENT_OS_DEPLOY_CHECKOUT || loadConfigCached({ env }).get('roots.deploy') } = {}) {
  if (!root || !isAbsolute(root)) throw Error('error-owner-spawn');
  const runtime = join(root, 'runtime', 'python', 'bin', 'python3');
  const python = env.HQ_PYTHON3 || env.AGENT_OS_PY || (existsSync(runtime) ? runtime : 'python3');
  const pythonPath = [
    'modules/worker-pool/lib/python', 'platform/agent-os-config/src',
    'platform/session-ledger/src', 'platform/dispatch-core/src', 'platform',
  ].map(path => join(root, path)).join(delimiter);
  return { python, cwd: root, env: { ...env, PYTHONPATH: pythonPath } };
}
