const TAG_PATTERN = /^\[(claude-code|codex|clio-agent)\]/i;

const REQUIRED_PREFIXES = ['[codex]', '[claude-code]', '[clio-agent]'];

const MALFORMED_TITLE_COMMENT_HEADER = '## Adversarial Review Trigger Failure';

function routePR(prTitle) {
  const match = prTitle.match(TAG_PATTERN);
  const tag = match ? match[1].toLowerCase() : null;

  if (!tag) return null;

  if (tag === 'codex') {
    return {
      tag,
      reviewerModel: 'claude',
      botTokenEnv: 'GH_CLAUDE_REVIEWER_TOKEN',
    };
  }

  return {
    tag,
    reviewerModel: 'codex',
    botTokenEnv: 'GH_CODEX_REVIEWER_TOKEN',
  };
}

function buildMalformedTitleFailureComment({ prTitle }) {
  return [
    MALFORMED_TITLE_COMMENT_HEADER,
    '',
    `This PR title does not start with a required reviewer tag prefix: ${REQUIRED_PREFIXES.join(', ')}.`,
    '',
    `Current title: "${prTitle}"`,
    '',
    'Adversarial review did not trigger because the title tag must be present at PR creation time.',
    'Retitling later may not safely retrigger review in watcher-based flows.',
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
