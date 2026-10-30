import { readDispatchFiles } from './dispatch-files-client.mjs';

const unavailable = /(?:^|:\s*)codex-tool-host-unavailable(?=\s*:|\s*$)/u;
const timeout = /timed out negotiating with the code-mode host/u;

// Interpret harness-owned failure fields, never a worker's narrative message.
export function codexToolHostUnavailable(outcome = {}) {
  if (!outcome) return false;
  const fields = ['failureReason', 'failure_reason', 'failureClass', 'failure_class',
    'failureCode', 'failure_code', 'failureDetail', 'failure_detail'];
  return fields.some((key) => unavailable.test(String(outcome[key] || '')))
    || outcome.toolHostEvidence?.allToolsFailedBeforeExecution === true;
}

// Read the complete JSONL/stderr stream, not a tail: an earlier successful
// command must disqualify a later negotiation timeout. Prose alone is not proof.
export function codexToolHostLogEvidence(text) {
  let failures = 0;
  for (const line of String(text || '').split('\n').filter((item) => item.trim())) {
    let event;
    try { event = JSON.parse(line); } catch {
      if (/\bERROR\b.*codex_core::tools::router/u.test(line) && timeout.test(line)) {
        failures += 1;
      }
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    const item = event.item || event.payload || event;
    // Any command lifecycle event proves the host negotiated successfully,
    // even if the shell command itself failed or its completion was lost.
    if (item.type === 'command_execution' || /exec_command_(?:begin|end)/u.test(String(item.type))) return null;
    if (event.type === 'item.started') continue;
    if (['mcp_tool_call', 'function_call_output', 'custom_tool_call_output', 'tool_result'].includes(item.type)) {
      const diagnostic = item.error || (item.status === 'failed' ? item : null)
        || (['function_call_output', 'custom_tool_call_output', 'tool_result'].includes(item.type) ? item.output : null);
      if (!diagnostic || !timeout.test(typeof diagnostic === 'string' ? diagnostic : JSON.stringify(diagnostic))) return null;
      failures += 1;
    } else if (event.type === 'item.completed'
      && !['agent_message', 'reasoning', 'todo_list'].includes(item.type)) {
      // Successful searches, patches, and future tool kinds are work too.
      // An unknown completed item cannot establish that every tool failed.
      return null;
    }
  }
  return failures > 0 ? { allToolsFailedBeforeExecution: true } : null;
}

export async function readDispatchCodexToolHostEvidence(worker, { readDispatchFilesImpl = readDispatchFiles } = {}) {
  if (!worker.launchRequestId) return null;
  let streams;
  try {
    streams = await Promise.all(['stdout', 'stderr'].map((stream) => readDispatchFilesImpl({
      launch_request_id: worker.launchRequestId, stream, tail: false, offset: 0,
    }, { hqRoot: worker.hqRoot })));
  } catch { return null; }
  // A partial page/tail can hide earlier work. Both streams must be complete
  // for this launch; an unavailable stream never proves zero commands.
  if (streams.some((result) => !result?.ok || result.log?.status !== 'found'
    || result.log.complete !== true || result.log.truncated !== false
    || result.log.offset !== 0 || Buffer.byteLength(result.log.text || '') > 8 * 1024 * 1024)) return null;
  return codexToolHostLogEvidence(streams.map((result) => result.log.text).join('\n'));
}
