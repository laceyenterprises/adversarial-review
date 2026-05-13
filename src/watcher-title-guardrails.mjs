import { TAG_PREFIXES } from './pr-title-tagging.mjs';
<<<<<<< HEAD
import { routePR as routeSubjectPR } from './adapters/subject/github-pr/routing.mjs';
=======
<<<<<<< HEAD
import { routePR as routeOperatorPR } from './adapters/operator/linear-triage/index.mjs';
=======
import { routePR as routeSubjectPR } from './adapters/subject/github-pr/routing.mjs';
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
>>>>>>> 1fc0304a213929e5aba65ec63b39fbf38a0d62aa

const REQUIRED_PREFIXES = Object.values(TAG_PREFIXES);

const MALFORMED_TITLE_COMMENT_HEADER = '## Adversarial Review Trigger Failure';

function routePR(prTitle) {
<<<<<<< HEAD
  const route = routeSubjectPR(prTitle);
=======
<<<<<<< HEAD
  const route = routeOperatorPR(prTitle);
=======
  const route = routeSubjectPR(prTitle);
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
>>>>>>> 1fc0304a213929e5aba65ec63b39fbf38a0d62aa
  if (!route) return null;
  return {
    tag: route.tag,
    reviewerModel: route.reviewerModel,
    botTokenEnv: route.botTokenEnv,
  };
}
function escapeForInlineCode(input) {
  return String(input ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\r?\n/g, ' ');
}

function buildMalformedTitleFailureComment({ prTitle }) {
  const escapedTitle = escapeForInlineCode(prTitle);
  return [
    MALFORMED_TITLE_COMMENT_HEADER,
    '',
    `This PR title does not start with a required reviewer tag prefix: ${REQUIRED_PREFIXES.join(', ')}.`,
    '',
    `Current title: \`${escapedTitle}\``,
    '',
    'Adversarial review did not trigger because the title tag must be present at PR creation time.',
    'If this PR was already recorded as malformed, retitling may not retrigger adversarial review.',
    'Safe recovery path: open a new PR with the correct creation-time tag.',
  ].join('\n');
}

export {
  MALFORMED_TITLE_COMMENT_HEADER,
  REQUIRED_PREFIXES,
  buildMalformedTitleFailureComment,
  routePR,
};
