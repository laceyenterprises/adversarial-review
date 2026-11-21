import { BROKER_REVIEWER_ROLES } from './reviewer-broker-refresh.mjs';

const ROUTE_ROLES = new Map([
  ['claude', 'claude-reviewer'],
  ['claude-code', 'claude-reviewer'],
  ['codex', 'codex-reviewer'],
  ['gemini', 'gemini-reviewer'],
  ['grok', 'grok-reviewer'],
]);

export function reviewerRoleFromRoute(route) {
  return ROUTE_ROLES.get(route);
}

export function reviewerRoleFromTokenEnv(tokenEnv) {
  return BROKER_REVIEWER_ROLES.find(entry => entry.envVar === tokenEnv)?.role;
}

export function isDeclaredFollowUpReviewerRole(role) {
  return BROKER_REVIEWER_ROLES.some(entry => entry.role === role);
}

export function legacyFollowUpReviewerRole(model) {
  // LAC-2294: this exact model was persisted without a role by the recovered
  // review handoff. Future models get their role from the review producer.
  if (model === 'claude-opus-5-5') return 'claude-reviewer';
  return reviewerRoleFromRoute(model);
}
