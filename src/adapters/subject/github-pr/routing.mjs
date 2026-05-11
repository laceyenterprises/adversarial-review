/**
 * Reviewer routing for GitHub PR subjects.
 *
 * Routing accepts the adapter-normalized builderClass from
 * {@link ../../../kernel/contracts.d.ts SubjectState}; title-prefix parsing
 * is intentionally kept in the adapter layer.
 *
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectState} SubjectState
 */

import { builderClassFromTitle, tagFromBuilderClass } from './title-tagging.mjs';

const ROUTE_BY_BUILDER_CLASS = {
  codex: {
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
  },
  'claude-code': {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
  'clio-agent': {
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  },
};

function normalizeBuilderClass(builderClassInput) {
  const builderClass = String(builderClassInput || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ROUTE_BY_BUILDER_CLASS, builderClass)
    ? builderClass
    : null;
}

function routeSubject(subject) {
  const builderClass = normalizeBuilderClass(subject?.builderClass);
  if (!builderClass) return null;
  const route = ROUTE_BY_BUILDER_CLASS[builderClass];
  return {
    builderClass,
    tag: tagFromBuilderClass(builderClass),
    reviewerModel: route.reviewerModel,
    botTokenEnv: route.botTokenEnv,
  };
}

function extractLinearTicketId(title) {
  const match = String(title || '').match(/\b(LAC-\d+)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function routePR(prTitle, subject = null) {
  const builderClass = normalizeBuilderClass(
    subject?.builderClass || builderClassFromTitle(prTitle)
  );
  if (!builderClass) return null;
  const route = routeSubject({ builderClass });
  if (!route) return null;
  return {
    builderClass,
    tag: route.tag,
    reviewerModel: route.reviewerModel,
    botTokenEnv: route.botTokenEnv,
    linearTicketId: extractLinearTicketId(prTitle),
  };
}

export {
  extractLinearTicketId,
  ROUTE_BY_BUILDER_CLASS,
  normalizeBuilderClass,
  routePR,
  routeSubject,
};
