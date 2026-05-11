/**
 * GitHub PR title tagging helpers for the code-pr subject adapter.
 *
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectState} SubjectState
 */

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

const BUILDER_CLASS_BY_TAG = {
  codex: 'codex',
  'claude-code': 'claude-code',
  'clio-agent': 'clio-agent',
};

const KNOWN_TAGS = Object.keys(TAG_PREFIXES);
const CANONICAL_PREFIXES = KNOWN_TAGS.map((tag) => TAG_PREFIXES[tag]);

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

function parseKnownPrefix(rawTitle) {
  if (typeof rawTitle !== 'string') return null;
  const title = rawTitle.trim();
  if (!title) return null;

  const lower = title.toLowerCase();
  for (let i = 0; i < KNOWN_TAGS.length; i += 1) {
    const tag = KNOWN_TAGS[i];
    const prefix = CANONICAL_PREFIXES[i];
    if (!lower.startsWith(prefix)) continue;
    return {
      tag,
      prefix,
      title,
      remainder: title.slice(prefix.length),
    };
  }

  return null;
}

function hasKnownPrefix(title) {
  return parseKnownPrefix(title) !== null;
}

function hasCanonicalTaggedTitle(rawTitle) {
  const parsed = parseKnownPrefix(rawTitle);
  if (!parsed) return false;

  const remainder = parsed.remainder.trim();
  if (!remainder) return false;
  if (hasKnownPrefix(remainder)) return false;
  return true;
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

function builderClassFromTitle(rawTitle) {
  if (!hasCanonicalTaggedTitle(rawTitle)) return null;
  const parsed = parseKnownPrefix(rawTitle);
  return BUILDER_CLASS_BY_TAG[parsed?.tag] || null;
}

function tagFromBuilderClass(builderClassInput) {
  const builderClass = String(builderClassInput || '').trim().toLowerCase();
  return KNOWN_TAGS.includes(builderClass) ? builderClass : null;
}

export {
  BUILDER_CLASS_BY_TAG,
  buildTaggedTitle,
  builderClassFromTitle,
  CANONICAL_PREFIXES,
  getPrefixForTag,
  hasCanonicalTaggedTitle,
  hasKnownPrefix,
  KNOWN_TAGS,
  parseKnownPrefix,
  normalizeTag,
  tagFromBuilderClass,
  TAG_ALIASES,
  TAG_PREFIXES,
};
