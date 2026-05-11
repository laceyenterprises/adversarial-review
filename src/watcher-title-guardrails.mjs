import { TAG_PREFIXES } from './pr-title-tagging.mjs';
import { routePR } from './adapters/subject/github-pr/routing.mjs';

const REQUIRED_PREFIXES = Object.values(TAG_PREFIXES);

const MALFORMED_TITLE_COMMENT_HEADER = '## Adversarial Review Trigger Failure';
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
