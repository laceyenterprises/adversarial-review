// Reviewer model detection + stdout token-usage parsing.
//
// ARC-10: this is the single canonical home for the per-model detection and
// token-usage parsing that was previously duplicated between `reviewer.mjs`
// (its bespoke spawn families) and `adapters/reviewer-runtime/cli-direct`.
// Both the local reviewer harness (`reviewer-harness.mjs`) and the cli-direct
// runtime import from here so the model-shape knowledge lives in exactly one
// place. Pure functions only — no import-time side effects — so importing this
// leaf never pulls in the reviewer spawn surface.

function parseCodexJsonTokenUsage(stdout) {
  let tokenUsage = null;
  for (const line of String(stdout || '').split('\n')) {
    if (
      !line.trim() ||
      (
        !line.includes('token_count') &&
        !line.includes('turn.completed') &&
        !line.includes('reviewer.token_usage') &&
        !line.includes('usageMetadata')
      )
    ) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'reviewer.token_usage' && item.tokenUsage) {
      const hasExplicitGuardrail = Object.prototype.hasOwnProperty.call(item.tokenUsage, 'guardrail')
        && item.tokenUsage.guardrail !== undefined;
      tokenUsage = {
        ...item.tokenUsage,
        usageTag: item.tokenUsage.usageTag || 'guardrail',
        guardrail: hasExplicitGuardrail
          ? item.tokenUsage.guardrail
          : (
              item.tokenUsage.total ?? (
                Number(item.tokenUsage.input || 0) + Number(item.tokenUsage.output || 0)
              )
            ),
      };
      continue;
    }
    // Gemini (usageMetadata shape, e.g. from gemini-cli -o json). candidates are
    // the visible output; thoughts are reasoning (inclusive output = candidates
    // + thoughts); cached maps to cacheRead; toolUse to tool context.
    const gemini = item.usageMetadata ?? item.usage_metadata ?? item.payload?.usageMetadata;
    if (gemini && typeof gemini === 'object') {
      const num = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null);
      const prompt = num(gemini.promptTokenCount);
      const candidates = num(gemini.candidatesTokenCount);
      const thoughts = num(gemini.thoughtsTokenCount);
      const output = candidates === null && thoughts === null ? null : (candidates || 0) + (thoughts || 0);
      tokenUsage = {
        input: prompt,
        output,
        reasoning: thoughts,
        cacheRead: num(gemini.cachedContentTokenCount),
        cacheWrite: 0,
        toolContext: num(gemini.toolUsePromptTokenCount),
        total: num(gemini.totalTokenCount),
        source: 'gemini-json',
      };
      continue;
    }
    const total = item.type === 'turn.completed'
      ? item.usage
      : (
          item.type === 'event_msg' && item.payload?.type === 'token_count'
            ? item.payload?.info?.total_token_usage
            : null
        );
    if (!total || typeof total !== 'object') continue;
    tokenUsage = {
      input: Number.isFinite(Number(total.input_tokens)) ? Math.trunc(Number(total.input_tokens)) : null,
      output: Number.isFinite(Number(total.output_tokens)) ? Math.trunc(Number(total.output_tokens)) : null,
      // reasoning_output_tokens is part of codex's total_token_usage; capture it
      // for full-fidelity parity (previously dropped). Codex folds tool tokens
      // into output, so there is no separate tool-context dimension here.
      reasoning: Number.isFinite(Number(total.reasoning_output_tokens)) ? Math.trunc(Number(total.reasoning_output_tokens)) : null,
      cacheRead: Number.isFinite(Number(total.cached_input_tokens)) ? Math.trunc(Number(total.cached_input_tokens)) : null,
      cacheWrite: 0,
      total: Number.isFinite(Number(total.total_tokens)) ? Math.trunc(Number(total.total_tokens)) : null,
      source: 'codex-json',
      usageTag: 'guardrail',
    };
    tokenUsage.guardrail = tokenUsage.total ?? ((tokenUsage.input || 0) + (tokenUsage.output || 0));
  }
  return tokenUsage;
}

function parseCodexJsonTokenUsageFromFailureStdout(stdout) {
  try {
    const tokenUsage = parseCodexJsonTokenUsage(stdout);
    return {
      tokenUsage,
      tokenUsageNoUsageReason: tokenUsage ? null : 'unparseable-stdout',
    };
  } catch {
    return {
      tokenUsage: null,
      tokenUsageNoUsageReason: 'unparseable-stdout',
    };
  }
}

function isCodexModel(model) {
  return String(model || '').toLowerCase().includes('codex');
}

function isGeminiModel(model) {
  const text = String(model || '').toLowerCase();
  return text.includes('gemini') || text.includes('antigravity') || text.includes('agy');
}

export {
  parseCodexJsonTokenUsage,
  parseCodexJsonTokenUsageFromFailureStdout,
  isCodexModel,
  isGeminiModel,
};
