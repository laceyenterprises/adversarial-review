const TAG_PREFIXES = {
  codex: '[codex]',
  'claude-code': '[claude-code]',
  'clio-agent': '[clio-agent]',
};

const TAG_ALIASES = {
  codex: 'codex',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  clio: 'clio-agent',
  'clio-agent': 'clio-agent',
};

const PREFIX_PATTERN = /^\[(codex|claude-code|clio-agent)\]\s+/i;

function normalizeTag(tagInput) {
  if (typeof tagInput !== 'string') return null;
  const key = tagInput.trim().toLowerCase();
  return TAG_ALIASES[key] ?? null;
}

function getPrefixForTag(tagInput) {
  const normalizedTag = normalizeTag(tagInput);
  if (!normalizedTag) return null;
  return TAG_PREFIXES[normalizedTag];
}

function hasKnownPrefix(title) {
  return PREFIX_PATTERN.test(title.trim());
}

function buildTaggedTitle(tagInput, rawTitle) {
  const prefix = getPrefixForTag(tagInput);
  if (!prefix) {
    throw new Error(
      `Invalid or missing tag "${tagInput ?? ''}". Allowed: codex, claude-code, clio-agent.`
    );
  }

  if (typeof rawTitle !== 'string' || rawTitle.trim().length === 0) {
    throw new Error('Missing required --title value.');
  }

  const title = rawTitle.trim();
  if (hasKnownPrefix(title)) {
    throw new Error('Title must be unprefixed. Provide raw title text and let helper prepend the tag.');
  }

  return `${prefix} ${title}`;
}

export {
  buildTaggedTitle,
  getPrefixForTag,
  hasKnownPrefix,
  normalizeTag,
  TAG_ALIASES,
  TAG_PREFIXES,
};
