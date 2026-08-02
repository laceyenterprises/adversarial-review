// Claude Code remediation worker compatibility surface.
//
// ARC-26 moves remediation local launch ownership under the local
// AgentRuntime implementation. Keep this file as a stable import path for
// existing callers/tests while re-exporting the runtime-owned helpers.

export {
  prepareClaudeCodeRemediationStartupEnv,
  resolveClaudeCodeCliPath,
  spawnClaudeCodeRemediationWorker,
} from './adapters/agent-runtime/local/remediation.mjs';
