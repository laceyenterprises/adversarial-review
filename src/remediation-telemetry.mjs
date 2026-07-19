import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { postRemediationOutcomeComment } from './adapters/comms/github-pr-comments/pr-comments.mjs';
import { resolvePRLifecycle, requestReviewRereview } from './review-state.mjs';
import { requestWatcherWake } from './watcher-wake.mjs';

// ARC-19: SSE telemetry-listener wiring extracted verbatim from
// follow-up-remediation.mjs. Resolves the health.worker.* subscription set,
// bridges the App Contract session's canonical SSE frame to the flat
// (event, topic) shape, and attaches the per-topic listeners. Leaf module: it
// must not import the orchestration monolith. The reconcile-driving handler
// (`handleRemediationTelemetryEvent`) and its monolith-internal collaborators
// (`isWorkerProcessRunning`, `auditWorkspaceForContamination`) live one layer
// up and are supplied by the composition root — the monolith passes the real
// handler as `handleTelemetryEventImpl`, and the two liveness/audit
// collaborators pass through as `isWorkerRunning` /
// `auditWorkspaceForContaminationImpl`, which the handler re-defaults to the
// identical implementations. That keeps this module free of any upward import
// back into follow-up-remediation.mjs.

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function resolveFollowUpTelemetryTopics(subscribes = []) {
  const topics = [];
  for (const topic of subscribes) {
    const normalized = String(topic || '').trim();
    if (!normalized) continue;
    if (normalized === 'health.worker.*' || normalized.startsWith('health.worker.')) {
      topics.push(normalized);
    }
  }
  return [...new Set(topics)];
}

// Bridge the app-contract session's on() delivery to the flat (event, topic)
// shape handleRemediationTelemetryEvent expects. The published SDK calls the
// handler with a single canonical frame { topic, payload, published_at }; older
// / injected sessions call it with (event, topic). Detect the frame by its exact
// shape so a plain telemetry event that merely carries a `topic` field is not
// mistaken for a frame.
function isCanonicalTopicFrame(value, maybeTopic) {
  return maybeTopic === undefined
    && value
    && typeof value === 'object'
    && typeof value.topic === 'string'
    && Object.prototype.hasOwnProperty.call(value, 'payload')
    && Object.prototype.hasOwnProperty.call(value, 'published_at');
}

function normalizeTelemetryDelivery(delivery, maybeTopic, topicPattern) {
  if (isCanonicalTopicFrame(delivery, maybeTopic)) {
    return { event: delivery.payload, topic: String(delivery.topic || topicPattern) };
  }
  return { event: delivery, topic: String(maybeTopic || topicPattern) };
}

function attachFollowUpTelemetryListeners({
  session,
  rootDir = ROOT,
  subscribes = ['health.worker.*'],
  now = () => new Date().toISOString(),
  // ARC-19: isWorkerRunning / auditWorkspaceForContaminationImpl are higher-layer
  // collaborators owned by the monolith. Left undefined here they pass through to
  // handleTelemetryEventImpl, which re-applies the identical isWorkerProcessRunning
  // / auditWorkspaceForContamination defaults — so this leaf never references them.
  isWorkerRunning,
  postCommentImpl = postRemediationOutcomeComment,
  requestReviewRereviewImpl = requestReviewRereview,
  requestWatcherWakeImpl = requestWatcherWake,
  resolvePRLifecycleImpl = resolvePRLifecycle,
  auditWorkspaceForContaminationImpl,
  execFileImpl = execFileAsync,
  // ARC-19: the reconcile-driving handler is injected by the composition root
  // (connectFollowUpTelemetryListener passes the monolith's
  // handleRemediationTelemetryEvent). No default keeps this a leaf module.
  handleTelemetryEventImpl,
  log = console,
} = {}) {
  if (!session || typeof session.on !== 'function') {
    throw new Error('follow-up telemetry listener requires an App Contract session with on()');
  }
  const topics = resolveFollowUpTelemetryTopics(subscribes);
  const unsubscribers = topics.map((topicPattern) => session.on(topicPattern, async (delivery, maybeTopic) => {
    // The published @agent-os/app-sdk delivers one canonical SSE frame
    // ({ topic, payload, published_at }) to the handler; the legacy two-arg
    // (event, topic) shape is still accepted so injected fakes keep working.
    const { event, topic } = normalizeTelemetryDelivery(delivery, maybeTopic, topicPattern);
    const deliveredTopic = topic;
    const result = await handleTelemetryEventImpl({
      rootDir,
      topic: deliveredTopic,
      event,
      now,
      isWorkerRunning,
      postCommentImpl,
      requestReviewRereviewImpl,
      requestWatcherWakeImpl,
      resolvePRLifecycleImpl,
      auditWorkspaceForContaminationImpl,
      execFileImpl,
      log,
    });
    if (!['ignored', 'skipped'].includes(result?.action)) {
      log.log?.(`[follow-up-remediation] telemetry reconcile ${deliveredTopic}: ${result?.action || 'unknown'}`);
    }
    return result;
  }));
  return {
    session,
    subscriptions: topics,
    dispose: () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  };
}

export {
  attachFollowUpTelemetryListeners,
  resolveFollowUpTelemetryTopics,
};
