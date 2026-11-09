// Grok execution goes through the OS adapter. This service never opens a Grok
// credential or materializes a second home/refresh chain.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfigCached } from './config-loader.mjs';
import { readHostObservation } from './dispatch-files-client.mjs';
import { reviewerRefusesBuilder } from './adapters/subject/github-pr/routing.mjs';
import { createAgentOsHqReviewerRuntimeAdapter } from './adapters/reviewer-runtime/agent-os-hq/index.mjs';
import { buildPromptForReviewerModel } from './reviewer-prompt.mjs';
import { readWorkerRunTokenUsage } from './reviewer-pass-tokens.mjs';
import { resolveReviewerTimeoutMs } from './reviewer-timeout.mjs';

function configurationRefusal(message) {
  return Object.assign(new Error(`[reviewer-configuration-error] ${message}`), {
    failureClass: 'reviewer-configuration-error',
  });
}

export async function reviewWithGrok(diff, extraContext = '', {
  builderClass,
  subjectContext = {},
  promptStage = 'first',
  reviewKind = 'code-pr',
  env = process.env,
  rootDir = fileURLToPath(new URL('..', import.meta.url)),
  loaderImpl = loadConfigCached,
  registryImpl = readHostObservation,
  runtimeFactory = createAgentOsHqReviewerRuntimeAdapter,
  readUsageImpl = readWorkerRunTokenUsage,
} = {}) {
  if (reviewerRefusesBuilder(builderClass, 'grok', { env, loaderImpl })) {
    throw configurationRefusal('Grok reviewer disabled or builder family refused');
  }
  // A seed is inspectable while disabled, but cannot authorize execution.
  const observed = await registryImpl('worker_registry', { env });
  const entry = observed?.ok && observed.data?.classes?.['grok-reviewer'];
  if (observed?.data?.registrySource !== 'db'
    || !entry || entry.enabled !== true || entry.harness !== 'grok'
    || (entry.fallbackWorkerClasses || []).length) {
    // Review fallback is selected by the review service, with original builder
    // provenance checked again. An opaque nested dispatch fallback cannot.
    throw configurationRefusal('Effective grok-reviewer registry import unavailable or unsafe');
  }
  if (!env.GH_GROK_REVIEWER_TOKEN) throw configurationRefusal('Missing Grok reviewer posting authority');
  const runtime = runtimeFactory({ rootDir, env, workerClass: 'grok-reviewer', taskKind: 'review' });
  const sessionUuid = randomUUID();
  const outerTimeoutMs = resolveReviewerTimeoutMs(env);
  const innerTimeoutMs = Math.max(1,
    outerTimeoutMs - Math.min(30_000, Math.max(1, Math.floor(outerTimeoutMs / 10))));
  const cancelOnTerm = () => {
    // The outer reviewer owns shutdown and fence cleanup.
    void Promise.resolve().then(() => runtime.cancel(sessionUuid))
      .catch(() => {});
  };
  process.once('SIGTERM', cancelOnTerm);
  let response;
  try {
    response = await runtime.spawnReviewer({
      sessionUuid,
      model: 'grok',
      workerClass: 'grok-reviewer',
      timeoutMs: innerTimeoutMs,
      prompt: buildPromptForReviewerModel('grok', diff, extraContext, { promptStage, reviewKind }),
      subjectContext: { ...subjectContext, builderClass, nestedReviewerRuntime: true },
    });
  } finally {
    process.removeListener('SIGTERM', cancelOnTerm);
  }
  if (!response.ok) {
    // Preserve typed refusal/unknown outcomes; never echo CLI output or secrets.
    throw Object.assign(new Error('Managed Grok review unavailable'), {
      failureClass: response.failureClass || 'reviewer-command-failed',
    });
  }
  return {
    reviewText: response.reviewBody,
    tokenUsage: readUsageImpl({ launchRequestId: response.reattachToken, env, rootDir }),
    execution: { harness: 'grok', model: response.execution?.model || null,
      modelSource: response.execution?.model ? 'dispatch-receipt' : 'unknown',
      launchRequestId: response.reattachToken },
  };
}
