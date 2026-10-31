// Antigravity CLI format reader. Never return prompt, thinking or tool content.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function objects(text) {
  return String(text || '').split(/\r?\n/u).flatMap((line) => {
    try { const value = JSON.parse(line); return value && typeof value === 'object' ? [value] : []; }
    catch { return []; }
  });
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid agy token counter');
  return value;
}

export function agyStreamEvidence(stdout) {
  const events = objects(stdout);
  const conversations = [...new Set(events.map((event) => event.conversation_id).filter(Boolean))];
  const result = events.findLast((event) => event.event === 'result')?.result;
  return {
    conversationId: conversations.length === 1 ? conversations[0] : null,
    response: typeof result?.response === 'string' ? result.response : null,
    usage: result?.usageMetadata || result?.usage || null,
  };
}

export function readAgyUsage({ stdout, model, env = process.env, storeRoot = null, requestCounts = null } = {}) {
  try {
    const evidence = agyStreamEvidence(stdout);
    const conversation = evidence.conversationId;
    if (!conversation || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u.test(conversation)) return null;
    const root = storeRoot || join(env.HOME || homedir(), '.gemini', 'antigravity-cli');
    const transcript = join(root, 'brain', conversation, '.system_generated', 'logs', 'transcript.jsonl');
    let rows = [];
    if (requestCounts) {
      rows = [{ input_tokens: requestCounts.input, output_tokens: requestCounts.output,
        cache_read_tokens: requestCounts.cacheRead }];
    } else {
      try { rows = objects(readFileSync(transcript, 'utf8')).filter((row) => row.type === 'PLANNER_RESPONSE'
        && Number.isSafeInteger(row.input_tokens) && row.input_tokens >= 0
        && Number.isSafeInteger(row.output_tokens) && row.output_tokens >= 0); } catch { /* Stream totals remain usable. */ }
    }
    const usage = evidence.usage;
    const sessionTotal = usage?.totalTokenCount ?? usage?.total_tokens ?? null;
    const figures = { input: 0, output: 0, cacheRead: 0, cacheWrite: null, reasoning: null };
    for (const row of rows) {
      figures.input += count(row.input_tokens);
      figures.output += count(row.output_tokens);
      figures.cacheRead += count(row.cache_read_tokens ?? 0);
    }
    const requestTotal = rows.length ? figures.input + figures.output : null;
    if (!rows.length) {
      if (sessionTotal == null) return null;
      figures.input = count(usage.promptTokenCount ?? usage.input_tokens);
      figures.output = count(sessionTotal) - figures.input;
      if (figures.output < 0) return null;
      figures.cacheRead = count(usage.cachedContentTokenCount ?? usage.cache_read_tokens ?? 0);
    }
    const reasoning = usage?.thoughtsTokenCount ?? usage?.thinking_tokens;
    if (reasoning != null) figures.reasoning = count(reasoning);
    return {
      ...figures, total: figures.input + figures.output, source: 'agy-measured',
      model: String(model || 'unknown').replace(/\s+\([^)]*\)$/u, '').toLowerCase().replaceAll(' ', '-'),
      agyConversationId: conversation, agySessionTotal: sessionTotal,
      agyRequestTotal: requestTotal,
      agyUsageMismatch: requestTotal != null && sessionTotal != null && requestTotal !== sessionTotal,
    };
  } catch {
    return null; // Telemetry may never prevent a review; retain today's estimate.
  }
}
