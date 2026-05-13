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

<<<<<<< HEAD
=======
<<<<<<< HEAD
=======
>>>>>>> 1fc0304a213929e5aba65ec63b39fbf38a0d62aa
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

<<<<<<< HEAD
=======
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
>>>>>>> 1fc0304a213929e5aba65ec63b39fbf38a0d62aa
export {
  extractLinearTicketId,
  ROUTE_BY_BUILDER_CLASS,
  normalizeBuilderClass,
  routePR,
  routeSubject,
};
