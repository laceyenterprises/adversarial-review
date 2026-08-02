// OAuth-only emergency transport for Codex reviews.
//
// Native Codex remains the primary path. This module exists for the narrower
// failure where the CLI produces no progress because macOS Security.framework
// is wedged before its HTTP client can establish TLS. Node's fetch stack does
// not traverse that keychain path, so the same ChatGPT OAuth credential can
// still complete the review without introducing an API-key fallback.

import { readFileSync } from 'node:fs';

const DEFAULT_CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_DIRECT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_DIRECT_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

function parseJwtClaims(token) {
  const payload = String(token || '').split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function readCodexOAuthCredential(authPath, { readFileImpl = readFileSync } = {}) {
  let auth;
  try {
    auth = JSON.parse(readFileImpl(authPath, 'utf8'));
  } catch (err) {
    throw new Error(`Codex OAuth fallback could not read auth.json: ${err?.message || err}`);
  }
  const accessToken = auth?.tokens?.access_token || auth?.access_token || null;
  if (!accessToken) {
    throw new Error('Codex OAuth fallback found no access token in auth.json');
  }
  const claims = parseJwtClaims(accessToken);
  const authClaims = claims['https://api.openai.com/auth'] || {};
  return {
    accessToken,
    accountId: authClaims.chatgpt_account_id || authClaims.account_id || null,
  };
}

function codexOAuthRequestBody({ prompt, model, reasoningEffort = 'high' }) {
  return {
    model,
    instructions: 'Follow the review request exactly and return only the requested review artifact.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    stream: true,
    store: false,
    tools: [],
    parallel_tool_calls: false,
    reasoning: { effort: reasoningEffort, summary: 'auto' },
    text: { verbosity: 'low' },
    include: ['reasoning.encrypted_content'],
  };
}

function textFromCompletedResponse(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  return output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function tokenUsageFromCompletedResponse(response) {
  const usage = response?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const numberOrNull = (value) => Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : null;
  const input = numberOrNull(usage.input_tokens);
  const output = numberOrNull(usage.output_tokens);
  const total = numberOrNull(usage.total_tokens);
  const reasoning = numberOrNull(usage.output_tokens_details?.reasoning_tokens);
  const cacheRead = numberOrNull(usage.input_tokens_details?.cached_tokens);
  const guardrail = total ?? ((input || 0) + (output || 0));
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite: 0,
    total,
    source: 'codex-oauth-responses',
    usageTag: 'guardrail',
    guardrail,
  };
}

function parseSseEvent(rawEvent) {
  const data = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function consumeCodexOAuthSse(response, {
  controller,
  idleTimeoutMs = DEFAULT_DIRECT_IDLE_TIMEOUT_MS,
} = {}) {
  if (!response?.body?.getReader) {
    throw new Error('Codex OAuth fallback response body is not stream-readable');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let reviewText = '';
  let completedResponse = null;
  let idleTimer = null;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => controller.abort('Codex OAuth response made no progress'), idleTimeoutMs);
    }
  };
  armIdleTimer();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || '';
      for (const rawEvent of events) {
        const event = parseSseEvent(rawEvent);
        if (!event) continue;
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          reviewText += event.delta;
        }
        if (event.type === 'response.completed') {
          completedResponse = event.response || null;
        }
        if (event.type === 'response.failed') {
          throw new Error(`Codex OAuth response failed: ${event.response?.error?.message || 'unknown error'}`);
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parseSseEvent(buffer);
      if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        reviewText += event.delta;
      }
      if (event?.type === 'response.completed') completedResponse = event.response || null;
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
  const completedText = textFromCompletedResponse(completedResponse);
  return {
    reviewText: reviewText || completedText,
    tokenUsage: tokenUsageFromCompletedResponse(completedResponse),
  };
}

async function reviewWithCodexOAuthResponses(prompt, {
  authPath,
  model,
  reasoningEffort = 'high',
  endpoint = DEFAULT_CODEX_RESPONSES_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_DIRECT_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_DIRECT_IDLE_TIMEOUT_MS,
  readFileImpl = readFileSync,
} = {}) {
  if (!authPath) throw new Error('Codex OAuth fallback requires authPath');
  if (!model) throw new Error('Codex OAuth fallback requires an explicit model');
  if (typeof fetchImpl !== 'function') throw new Error('Codex OAuth fallback requires fetch');
  const { accessToken, accountId } = readCodexOAuthCredential(authPath, { readFileImpl });
  const controller = new AbortController();
  const wallTimer = setTimeout(() => controller.abort('Codex OAuth response timed out'), timeoutMs);
  try {
    const headers = {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      originator: 'codex_cli_rs',
      'user-agent': 'codex_cli_rs/reviewer-oauth-recovery',
    };
    if (accountId) headers['chatgpt-account-id'] = accountId;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(codexOAuthRequestBody({ prompt, model, reasoningEffort })),
      signal: controller.signal,
    });
    if (!response?.ok) {
      const detail = await response?.text?.().catch(() => '') || '';
      throw new Error(
        `Codex OAuth fallback HTTP ${response?.status ?? 'unknown'}${detail ? `: ${detail.slice(0, 300)}` : ''}`
      );
    }
    const result = await consumeCodexOAuthSse(response, { controller, idleTimeoutMs });
    if (!String(result.reviewText || '').trim()) {
      throw new Error('Codex OAuth fallback returned empty output');
    }
    return result;
  } finally {
    clearTimeout(wallTimer);
  }
}

export {
  DEFAULT_CODEX_RESPONSES_URL,
  codexOAuthRequestBody,
  consumeCodexOAuthSse,
  parseJwtClaims,
  readCodexOAuthCredential,
  reviewWithCodexOAuthResponses,
  textFromCompletedResponse,
  tokenUsageFromCompletedResponse,
};
