import { TAG_PREFIXES, hasCanonicalTaggedTitle } from './pr-title-tagging.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_PREFIXES = Object.values(TAG_PREFIXES);

function buildValidationFailureMessage(prTitle) {
  const shownTitle = typeof prTitle === 'string' && prTitle.trim().length > 0 ? prTitle.trim() : '(empty title)';

  return [
    `Invalid PR title: "${shownTitle}"`,
    `Allowed adversarial-review prefixes: ${REQUIRED_PREFIXES.join(', ')}`,
    'Prefix matching is case-insensitive.',
    'Canonical format: "[tag] <title>" with exactly one known tag prefix and non-empty title text.',
    'Why this check exists: reviewer routing depends on creation-time tag correctness.',
    'To fix this check: edit the PR title to a canonical tagged form.',
  ].join('\n');
}

function validatePRTitlePrefix(prTitle) {
  if (typeof prTitle !== 'string' || prTitle.trim().length === 0) {
    return {
      valid: false,
      message: buildValidationFailureMessage(prTitle),
    };
  }

  if (!hasCanonicalTaggedTitle(prTitle)) {
    return {
      valid: false,
      message: buildValidationFailureMessage(prTitle),
    };
  }

  return {
    valid: true,
    message: `PR title prefix is valid. Allowed prefixes: ${REQUIRED_PREFIXES.join(', ')}`,
  };
}

function runCli(argv = process.argv.slice(2)) {
  const envTitle = process.env.PR_TITLE;
  const prTitle = typeof envTitle === 'string' ? envTitle : argv[0];

  if (typeof prTitle !== 'string' || argv.length > 1) {
    console.error('Usage: PR_TITLE="<PR title>" node src/pr-title-validate.mjs');
    process.exitCode = 1;
    return;
  }

  const result = validatePRTitlePrefix(prTitle);

  if (!result.valid) {
    console.error(result.message);
    process.exitCode = 1;
    return;
  }

  console.log(result.message);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli();
}

export { REQUIRED_PREFIXES, buildValidationFailureMessage, runCli, validatePRTitlePrefix };
