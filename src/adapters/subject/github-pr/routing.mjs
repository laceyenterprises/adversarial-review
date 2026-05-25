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

const DEFAULT_REVIEWER_ENV = 'ADVERSARIAL_REVIEW_DEFAULT_REVIEWER';

const REVIEWER_ROUTE_BY_MODEL = {
  claude: {
    reviewerModel: 'claude',
    botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
  },
  codex: {
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

function normalizeReviewerModel(reviewerInput) {
  const reviewer = String(reviewerInput || '').trim().toLowerCase();
  if (!reviewer) return null;
  switch (reviewer) {
    case 'claude':
    case 'claude-code':
      return 'claude';
    case 'codex':
      return 'codex';
    default:
      return null;
  }
}

function defaultReviewerRouteFromEnv(env = process.env) {
  const raw = env?.[DEFAULT_REVIEWER_ENV];
  if (raw === undefined || String(raw).trim() === '') return null;
  const reviewerModel = normalizeReviewerModel(raw);
  if (!reviewerModel) {
    throw new Error(
      `${DEFAULT_REVIEWER_ENV} must be one of: codex, claude; got ${JSON.stringify(raw)}`
    );
  }
  return REVIEWER_ROUTE_BY_MODEL[reviewerModel];
}

function routeSubject(subject, { env = process.env } = {}) {
  const builderClass = normalizeBuilderClass(subject?.builderClass);
  if (!builderClass) return null;
  const route = defaultReviewerRouteFromEnv(env) || ROUTE_BY_BUILDER_CLASS[builderClass];
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

function routePR(prTitle, subject = null, options = {}) {
  const builderClass = normalizeBuilderClass(
    subject?.builderClass || builderClassFromTitle(prTitle)
  );
  if (!builderClass) return null;
  const route = routeSubject({ builderClass }, options);
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
  DEFAULT_REVIEWER_ENV,
  extractLinearTicketId,
  REVIEWER_ROUTE_BY_MODEL,
  ROUTE_BY_BUILDER_CLASS,
  defaultReviewerRouteFromEnv,
  normalizeBuilderClass,
  normalizeReviewerModel,
  routePR,
  routeSubject,
};
