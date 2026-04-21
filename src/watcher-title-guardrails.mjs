import { TAG_PREFIXES, hasCanonicalTaggedTitle, parseKnownPrefix } from './pr-title-tagging.mjs';

const REQUIRED_PREFIXES = Object.values(TAG_PREFIXES);

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
  if (!hasCanonicalTaggedTitle(prTitle)) return null;
  const parsed = parseKnownPrefix(prTitle);
  const tag = parsed?.tag ?? null;
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
