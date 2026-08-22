/**
 * Harness templates the Screen C panel offers as starting points (ARF-06).
 *
 * Modelled on `modules/worker-pool/worker-classes.json` — the reference for what
 * a class declaration carries — but owned by ARF and imported from nowhere. A
 * template is a *prefill*, not a policy: every field it suggests goes through
 * `normalizeHarnessSpec` exactly like a hand-typed one, so a stale model id or a
 * default outside its allowlist is refused here just as loudly.
 *
 * Model ids are deliberately not pinned to whatever this fleet runs today. They
 * are a starting point an operator edits in the form; a template that silently
 * decided which model a reviewer runs would be a policy hiding in a dropdown.
 */

import { MODEL_AUTH_BROKER_OAUTH, MODEL_AUTH_STANDALONE_TOKEN } from './harness-manifest.mjs';

export const HARNESS_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'claude-reviewer',
    label: 'Claude reviewer',
    description: 'Anthropic-backed reviewer harness. Broker-OAuth in-OS; a token ref standalone.',
    spec: Object.freeze({
      class: 'claude-reviewer',
      kind: 'reviewer',
      entitlement: 'claude-reviewer-worker',
      allowedModels: Object.freeze(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']),
      defaultModel: 'claude-opus-5',
      botIdentity: Object.freeze({ login: 'claude-reviewer', kind: 'github_app' }),
      modelAuth: Object.freeze({ mode: MODEL_AUTH_BROKER_OAUTH, brokerRole: 'claude-reviewer' }),
      runtime: Object.freeze({ command: 'claude' }),
      tags: Object.freeze(['identity:bot', 'reviewer']),
    }),
  }),
  Object.freeze({
    id: 'codex-reviewer',
    label: 'Codex reviewer',
    description: 'OpenAI-backed reviewer harness.',
    spec: Object.freeze({
      class: 'codex-reviewer',
      kind: 'reviewer',
      entitlement: 'codex-reviewer-worker',
      allowedModels: Object.freeze(['gpt-5-codex', 'gpt-5']),
      defaultModel: 'gpt-5-codex',
      botIdentity: Object.freeze({ login: 'codex-reviewer', kind: 'github_app' }),
      modelAuth: Object.freeze({ mode: MODEL_AUTH_BROKER_OAUTH, brokerRole: 'codex-reviewer' }),
      runtime: Object.freeze({ command: 'codex' }),
      tags: Object.freeze(['identity:bot', 'reviewer']),
    }),
  }),
  Object.freeze({
    id: 'gemini-reviewer',
    label: 'Gemini reviewer',
    description:
      'Gemini reviewer harness. Its runtime moved off the retired gemini-cli OAuth tier — '
      + 'probe the runtime you actually intend to spawn, not the one the docs remember.',
    spec: Object.freeze({
      class: 'gemini-reviewer',
      kind: 'reviewer',
      entitlement: 'gemini-reviewer-worker',
      allowedModels: Object.freeze(['gemini-2.5-pro', 'gemini-2.5-flash']),
      defaultModel: 'gemini-2.5-pro',
      botIdentity: Object.freeze({ login: 'gemini-reviewer', kind: 'github_app' }),
      modelAuth: Object.freeze({ mode: MODEL_AUTH_BROKER_OAUTH, brokerRole: 'gemini-reviewer' }),
      runtime: Object.freeze({ command: 'agy' }),
      tags: Object.freeze(['identity:bot', 'reviewer']),
    }),
  }),
  Object.freeze({
    id: 'standalone-claude-reviewer',
    label: 'Claude reviewer (standalone token)',
    description:
      'The same reviewer with no broker at all: the model credential is a secret reference '
      + 'ARF resolves directly. This is the shape a deployment outside the OS uses.',
    spec: Object.freeze({
      class: 'claude-reviewer',
      kind: 'reviewer',
      entitlement: 'claude-reviewer-worker',
      allowedModels: Object.freeze(['claude-opus-5', 'claude-sonnet-5']),
      defaultModel: 'claude-opus-5',
      botIdentity: Object.freeze({ login: 'claude-reviewer', kind: 'github_app' }),
      modelAuth: Object.freeze({
        mode: MODEL_AUTH_STANDALONE_TOKEN,
        tokenRef: 'env:ANTHROPIC_API_KEY',
        provider: 'anthropic',
      }),
      runtime: Object.freeze({ command: 'claude' }),
      tags: Object.freeze(['identity:bot', 'reviewer']),
    }),
  }),
  Object.freeze({
    id: 'hammer',
    label: 'The hammer (remediator)',
    description: 'Remediation harness. Its posts are allowlisted too — a remediation comment '
      + 'that is not attributed reads as an unanswered review.',
    spec: Object.freeze({
      class: 'hammer',
      kind: 'remediator',
      entitlement: 'hammer-worker',
      allowedModels: Object.freeze(['claude-opus-5', 'gpt-5-codex']),
      defaultModel: 'claude-opus-5',
      botIdentity: Object.freeze({ login: 'the-hammer', kind: 'github_app' }),
      modelAuth: Object.freeze({ mode: MODEL_AUTH_BROKER_OAUTH, brokerRole: 'the-hammer' }),
      runtime: Object.freeze({ command: 'claude' }),
      tags: Object.freeze(['identity:bot', 'remediator']),
    }),
  }),
]);

/** The catalog as the panel consumes it. */
export function harnessCatalog() {
  return HARNESS_TEMPLATES.map((template) => ({
    id: template.id,
    label: template.label,
    description: template.description,
    spec: JSON.parse(JSON.stringify(template.spec)),
  }));
}
