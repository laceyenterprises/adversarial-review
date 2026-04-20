import { TAG_PREFIXES, hasKnownPrefix } from './pr-title-tagging.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_PREFIXES = Object.values(TAG_PREFIXES);

function buildValidationFailureMessage(prTitle) {
  const shownTitle = typeof prTitle === 'string' && prTitle.trim().length > 0 ? prTitle.trim() : '(empty title)';

  return [
    `Invalid PR title: "${shownTitle}"`,
    `Allowed adversarial-review prefixes: ${REQUIRED_PREFIXES.join(', ')}`,
    'Prefix matching is case-insensitive.',
    'Why this check exists: reviewer routing depends on creation-time tag correctness.',
    'Retitling later does not retrigger adversarial review for malformed-title PRs.',
    'Recovery path: close and recreate the PR with a valid prefix.',
  ].join('\n');
}

function validatePRTitlePrefix(prTitle) {
  if (typeof prTitle !== 'string' || prTitle.trim().length === 0) {
    return {
      valid: false,
      message: buildValidationFailureMessage(prTitle),
    };
  }

  if (!hasKnownPrefix(prTitle)) {
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
  if (argv.length !== 1) {
    console.error('Usage: node src/pr-title-validate.mjs "<PR title>"');
    process.exitCode = 1;
    return;
  }

  const prTitle = argv[0];
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
