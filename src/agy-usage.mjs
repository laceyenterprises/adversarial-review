// Antigravity CLI readers: persist counters only; decode review diagnostics separately.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
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

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

function transcriptRows(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return [];
    // One extra byte detects growth without ever making an unbounded read.
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const length = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!length) break;
      offset += length;
    }
    if (offset !== stat.size) return [];
    return objects(bytes.subarray(0, offset).toString('utf8'))
      .filter((row) => row.type === 'PLANNER_RESPONSE');
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function validCounters(counters) {
  return counters && [counters.input, counters.output, counters.cacheRead ?? 0]
    .every((value) => Number.isSafeInteger(value) && value >= 0)
    && Number.isSafeInteger(counters.input + counters.output)
    && counters.input + counters.output > 0
    && (counters.cacheRead ?? 0) <= counters.input;
}

// Decode diagnostic fields before the existing plain-text failure classifiers.
// Do not stringify arbitrary events, which can contain prompts or tool arguments.
export function agyReviewText(stdout) {
  const response = agyStreamEvidence(stdout).response;
  if (response) return response;
  function text(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n');
    if (!value || typeof value !== 'object') return '';
    return ['error', 'message', 'text', 'content'].map((key) => text(value[key])).filter(Boolean).join('\n');
  }
  return String(stdout || '').split(/\r?\n/u).map((line) => {
    try { return text(JSON.parse(line)); } catch { return line; }
  }).join('\n');
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
    const root = storeRoot || join(env.GEMINI_HOME || join(env.HOME || homedir(), '.gemini'), 'antigravity-cli');
    const transcript = join(root, 'brain', conversation, '.system_generated', 'logs', 'transcript.jsonl');
    let rows = [];
    if (validCounters(requestCounts)) {
      rows = [{ input_tokens: requestCounts.input, output_tokens: requestCounts.output,
        cache_read_tokens: requestCounts.cacheRead }];
    } else {
      const candidates = transcriptRows(transcript);
      // A malformed row invalidates reconciliation, rather than reporting a
      // plausible but incomplete request sum.
      if (candidates.length && candidates.every((row) => validCounters({
        input: row.input_tokens, output: row.output_tokens, cacheRead: row.cache_read_tokens,
      }))) rows = candidates;
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
    // Gemini prompt counters include cached input. Persist disjoint billing
    // buckets while retaining the inclusive provider total.
    const total = count(figures.input + figures.output);
    if (figures.cacheRead > figures.input) return null;
    figures.input = count(figures.input - figures.cacheRead);
    const reasoning = usage?.thoughtsTokenCount ?? usage?.thinking_tokens;
    if (reasoning != null) figures.reasoning = count(reasoning);
    return {
      ...figures, total, source: 'agy-measured',
      model: String(model || 'unknown').replace(/\s+\([^)]*\)$/u, '').toLowerCase().replaceAll(' ', '-'),
      agyConversationId: conversation, agySessionTotal: sessionTotal,
      agyRequestTotal: requestTotal,
      agyUsageMismatch: requestTotal != null && sessionTotal != null && requestTotal !== sessionTotal,
    };
  } catch {
    return null; // Telemetry may never prevent a review; retain today's estimate.
  }
}
