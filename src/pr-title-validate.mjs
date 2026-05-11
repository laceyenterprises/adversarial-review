export {
  REQUIRED_PREFIXES,
  buildValidationFailureMessage,
  runCli,
  validatePRTitlePrefix,
} from './adapters/subject/github-pr/title-validate.mjs';

import { runCli } from './adapters/subject/github-pr/title-validate.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli();
}
