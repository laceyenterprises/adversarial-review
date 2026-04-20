import { TAG_PREFIXES } from './pr-title-tagging.mjs';

const REQUIRED_PREFIXES = Object.values(TAG_PREFIXES);
const TAG_PATTERN = new RegExp(
  `^\\[(${Object.keys(TAG_PREFIXES).join('|')})\\]`,
  'i'
);

const MALFORMED_TITLE_COMMENT_HEADER = '## Adversarial Review Trigger Failure';
const ROUTE_BY_TAG = {
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

function escapeForInlineCode(input) {
  return String(input ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\r?\n/g, ' ');
}

function routePR(prTitle) {
  const match = prTitle.match(TAG_PATTERN);
  const tag = match ? match[1].toLowerCase() : null;

  if (!tag) return null;
  const route = ROUTE_BY_TAG[tag];
  if (!route) return null;

  return {
    tag,
    reviewerModel: route.reviewerModel,
    botTokenEnv: route.botTokenEnv,
  };
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
    'Retitling later will not retrigger review for this PR because malformed titles are recorded as terminal failures.',
    'Safe recovery path: close and recreate the PR with the correct creation-time tag.',
  ].join('\n');
}

export {
  MALFORMED_TITLE_COMMENT_HEADER,
  REQUIRED_PREFIXES,
  TAG_PATTERN,
  buildMalformedTitleFailureComment,
  routePR,
};
