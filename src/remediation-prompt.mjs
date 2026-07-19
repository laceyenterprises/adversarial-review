import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStagePrompt, resolvePromptSet } from './kernel/prompt-stage.mjs';
import { loadDomainConfig } from './domain-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The remediator's prompt set is sourced from the domain config
// (`domains/<id>.json` → `promptSet`), never a hardcoded literal. Resolution
// fails loud with a classified `PromptSetResolutionError` — there is no silent
// fallback to code-pr. The active domain id remains fixed to `code-pr` here
// (the sole registered remediation domain); threading the domain id itself is
// a separate work item.
const REMEDIATOR_DOMAIN_ID = 'code-pr';
const REMEDIATOR_PROMPT_SET = resolvePromptSet({
  rootDir: ROOT,
  domainConfig: loadDomainConfig(ROOT, REMEDIATOR_DOMAIN_ID),
  domainId: REMEDIATOR_DOMAIN_ID,
});
const FOLLOW_UP_PROMPT_PATH = join(ROOT, 'prompts', REMEDIATOR_PROMPT_SET, 'remediator.first.md');

function followUpJobRepoPrKey(job) {
  return `${String(job?.repo || '').toLowerCase()}#${job?.prNumber || ''}`;
}

function loadFollowUpPromptTemplate(rootDir = ROOT, { stage = 'first' } = {}) {
  return loadStagePrompt({
    rootDir,
    promptSet: REMEDIATOR_PROMPT_SET,
    actor: 'remediator',
    stage,
  });
}

function buildMarkdownFence(text) {
  const content = String(text ?? '');
  let width = 3;
  while (content.includes('`'.repeat(width))) {
    width += 1;
  }
  return '`'.repeat(width);
}

function formatFencedBlock(text, language = 'text') {
  const content = String(text ?? '').trim() || '(empty)';
  const fence = buildMarkdownFence(content);
  return `${fence}${language}\n${content}\n${fence}`;
}

export {
  REMEDIATOR_PROMPT_SET,
  FOLLOW_UP_PROMPT_PATH,
  followUpJobRepoPrKey,
  loadFollowUpPromptTemplate,
  buildMarkdownFence,
  formatFencedBlock,
};
