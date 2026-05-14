import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertClaudeOAuth, assertCodexOAuth } from '../../../src/reviewer.mjs';

const REQUIRED_REVIEWER_BOT_TOKEN_ENVS = [
  'GH_CLAUDE_REVIEWER_TOKEN',
  'GH_CODEX_REVIEWER_TOKEN',
];

function resolveRenderedCodexAuthPath({
  reviewerAuthRoot = '',
  operatorHome = process.env.HOME || '',
} = {}) {
  if (reviewerAuthRoot) return join(reviewerAuthRoot, 'codex', 'auth.json');
  return join(operatorHome, '.codex', 'auth.json');
}

function missingRequiredReviewerBotTokens(env = process.env) {
  return REQUIRED_REVIEWER_BOT_TOKEN_ENVS.filter((name) => !String(env[name] || '').trim());
}

async function probeClaudeRuntime() {
  await assertClaudeOAuth();
}

async function probeCodexRuntime(options = {}) {
  const authPath = resolveRenderedCodexAuthPath(options);
  const previous = process.env.CODEX_AUTH_PATH;
  process.env.CODEX_AUTH_PATH = authPath;
  try {
    await assertCodexOAuth();
    return authPath;
  } finally {
    if (previous === undefined) delete process.env.CODEX_AUTH_PATH;
    else process.env.CODEX_AUTH_PATH = previous;
  }
}

async function main(argv = process.argv.slice(2)) {
  const [command, operatorHome = '', reviewerAuthRoot = ''] = argv;
  switch (command) {
    case 'probe-claude':
      await probeClaudeRuntime();
      return;
    case 'probe-codex': {
      const authPath = await probeCodexRuntime({ operatorHome, reviewerAuthRoot });
      console.log(authPath);
      return;
    }
    case 'missing-bot-tokens': {
      const missing = missingRequiredReviewerBotTokens();
      if (missing.length > 0) {
        for (const name of missing) console.log(name);
        process.exitCode = 1;
      }
      return;
    }
    default:
      throw new Error(`unknown command: ${command || '<empty>'}`);
  }
}

export {
  REQUIRED_REVIEWER_BOT_TOKEN_ENVS,
  missingRequiredReviewerBotTokens,
  probeClaudeRuntime,
  probeCodexRuntime,
  resolveRenderedCodexAuthPath,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message || String(err));
    process.exit(1);
  });
}
