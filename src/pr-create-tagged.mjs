#!/usr/bin/env node

export {
  formatCommandForLog,
  main,
  parseArgs,
  validatePassthroughArgs,
} from './adapters/subject/github-pr/pr-create-tagged.mjs';

import { main } from './adapters/subject/github-pr/pr-create-tagged.mjs';
import { pathToFileURL } from 'node:url';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
