/**
 * GitHub PR label-backed implementation of the operator controls surface.
 *
 * @typedef {import('../../../kernel/contracts.d.ts').OperatorControls} OperatorControls
 * @typedef {import('../../../kernel/contracts.d.ts').SubjectRef} SubjectRef
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { fetchLatestLabelEvent } from '../../../github-label-events.mjs';
<<<<<<< HEAD
=======
import { parseSubjectExternalId } from '../../subject/github-pr/index.mjs';
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85

const execFileAsync = promisify(execFile);

const OPERATOR_APPROVED_LABEL = 'operator-approved';
const FORCE_REREVIEW_LABEL = 'force-rereview';
const HALTED_LOOP_LABEL = 'halted-loop';
const RAISED_ROUND_CAP_LABEL = 'raised-round-cap';
const MERGE_AGENT_REQUESTED_LABEL = 'merge-agent-requested';

function isoNow() {
  return new Date().toISOString();
}

function emptyControlResult(reason = 'missing-label-event') {
  return {
    applied: false,
    observedRevisionRef: null,
    actor: null,
    eventId: null,
    observedAt: null,
    reason,
  };
}

function normalizeEventId(event) {
  return event?.id || event?.nodeId || null;
}

<<<<<<< HEAD
function parseSubjectExternalId(subjectExternalId) {
  const raw = String(subjectExternalId || '').trim();
  const match = /^([^#/]+\/[^#/]+)#(\d+)$/.exec(raw);
  if (!match) {
    throw new TypeError(`Invalid GitHub PR subjectExternalId: ${subjectExternalId}`);
  }
  return {
    repo: match[1],
    prNumber: Number(match[2]),
  };
}

=======
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
function legacyLabelEventFromControlResult(result, label) {
  if (!result?.applied) return null;
  return {
    id: result.eventId || null,
    nodeId: result.eventId || null,
    label,
    actor: result.actor || null,
    createdAt: result.observedAt || null,
    headSha: result.observedRevisionRef || null,
    codeScopedAt: result.codeScopedAt || null,
    codeScopeEventId: result.codeScopeEventId || null,
    codeScopeEventKind: result.codeScopeEventKind || null,
  };
}

function staleReason(observedRevisionRef, currentRevisionRef) {
  return `stale: label applied at ${observedRevisionRef}, current head is ${currentRevisionRef}`;
}

function applyRevisionScopedLabelEvent({
  event,
  currentRevisionRef,
  reason = undefined,
  roundCap = undefined,
}) {
  if (!event) return emptyControlResult();

  const observedRevisionRef = event.headSha || event.head_sha || null;
  const actor = event.actor || null;
  const eventId = normalizeEventId(event);
  const observedAt = event.createdAt || event.created_at || null;
  const base = {
    applied: false,
    observedRevisionRef,
    actor,
    eventId,
    observedAt,
  };

  if (!actor) {
    return { ...base, reason: 'non-attributable' };
  }

  if (!observedRevisionRef || String(observedRevisionRef) !== String(currentRevisionRef || '')) {
    return {
      ...base,
      reason: staleReason(observedRevisionRef || 'unknown', currentRevisionRef || 'unknown'),
    };
  }

  if (!eventId || !observedAt) {
    return { ...base, reason: 'missing-audit-fields' };
  }

  return {
    applied: true,
    observedRevisionRef,
    actor,
    eventId,
    observedAt,
    ...(reason ? { reason } : {}),
    ...(Number.isInteger(roundCap) ? { roundCap } : {}),
    ...(event.codeScopedAt ? { codeScopedAt: event.codeScopedAt } : {}),
    ...(event.codeScopeEventId ? { codeScopeEventId: event.codeScopeEventId } : {}),
    ...(event.codeScopeEventKind ? { codeScopeEventKind: event.codeScopeEventKind } : {}),
  };
}

function parseRoundCapFromLabel(labelName, fallback = null) {
  const raw = String(labelName || '');
  const match = /(?:^|[:=])(\d+)$/.exec(raw);
  if (!match) return fallback;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function eventFromResult(result, type, subjectRef, roundCap = undefined) {
  if (!result?.applied) return null;
  return {
    type,
    subjectRef,
    revisionRef: result.observedRevisionRef,
    eventExternalId: result.eventId,
    actorRef: result.actor,
    observedAt: result.observedAt,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(Number.isInteger(roundCap) ? { roundCap } : {}),
  };
}

function createGitHubPRLabelControlsAdapter({
  fetchLatestLabelEventImpl = fetchLatestLabelEvent,
  execFileImpl = execFileAsync,
  auditEmitter = null,
  labels = {},
} = {}) {
  const labelNames = {
    operatorApproved: labels.operatorApproved || OPERATOR_APPROVED_LABEL,
    forceRereview: labels.forceRereview || FORCE_REREVIEW_LABEL,
    haltedLoop: labels.haltedLoop || HALTED_LOOP_LABEL,
    raisedRoundCap: labels.raisedRoundCap || RAISED_ROUND_CAP_LABEL,
    mergeAgentRequested: labels.mergeAgentRequested || MERGE_AGENT_REQUESTED_LABEL,
  };

  async function observeLabelControl(subjectRef, currentRevisionRef, labelName, {
    reason = undefined,
    roundCap = undefined,
  } = {}) {
    const { repo, prNumber } = parseSubjectExternalId(subjectRef?.subjectExternalId);
    const event = await fetchLatestLabelEventImpl(repo, prNumber, labelName, { execFileImpl });
    const result = applyRevisionScopedLabelEvent({
      event,
      currentRevisionRef,
      reason,
      roundCap,
    });
    if (typeof auditEmitter === 'function') {
      await auditEmitter({
        labelName,
        subjectRef,
        currentRevisionRef,
        result,
      });
    }
    return result;
  }

  const observeOperatorApproved = (subjectRef, currentRevisionRef) => (
    observeLabelControl(subjectRef, currentRevisionRef, labelNames.operatorApproved)
  );

  const observeForceRereview = (subjectRef, currentRevisionRef) => (
    observeLabelControl(subjectRef, currentRevisionRef, labelNames.forceRereview)
  );

  const observeHaltedLoop = (subjectRef, currentRevisionRef) => (
    observeLabelControl(subjectRef, currentRevisionRef, labelNames.haltedLoop, {
      reason: 'operator-applied halted-loop label',
    })
  );

  const observeRaisedRoundCap = async (subjectRef, currentRevisionRef, {
    roundCap = null,
  } = {}) => {
    const parsedRoundCap = parseRoundCapFromLabel(labelNames.raisedRoundCap, roundCap);
    return observeLabelControl(subjectRef, currentRevisionRef, labelNames.raisedRoundCap, {
      reason: Number.isInteger(parsedRoundCap)
        ? `operator raised remediation round cap to ${parsedRoundCap}`
        : 'operator raised remediation round cap',
      roundCap: parsedRoundCap,
    });
  };

  const observeMergeAgentOverride = (subjectRef, currentRevisionRef) => (
    observeLabelControl(subjectRef, currentRevisionRef, labelNames.mergeAgentRequested)
  );

  async function observeOverrides(subjectRef, currentRevisionRef) {
    const [
      operatorApproved,
      forceRereview,
      halted,
      raisedRoundCap,
    ] = await Promise.all([
      observeOperatorApproved(subjectRef, currentRevisionRef),
      observeForceRereview(subjectRef, currentRevisionRef),
      observeHaltedLoop(subjectRef, currentRevisionRef),
      observeRaisedRoundCap(subjectRef, currentRevisionRef),
    ]);
    const events = [
      eventFromResult(forceRereview, 'force-rereview', subjectRef),
      eventFromResult(operatorApproved, 'operator-approved', subjectRef),
      eventFromResult(halted, 'halted', subjectRef),
      eventFromResult(raisedRoundCap, 'raised-round-cap', subjectRef, raisedRoundCap.roundCap),
    ].filter(Boolean);

    return {
      subjectRef,
      expectedRevisionRef: currentRevisionRef,
      observedRevisionRef: currentRevisionRef,
      forceRereview: forceRereview.applied,
      operatorApproved: operatorApproved.applied,
      halted: halted.applied,
      ...(Number.isInteger(raisedRoundCap.roundCap) ? { raisedRoundCap: raisedRoundCap.roundCap } : {}),
      events,
      observedAt: events.at(-1)?.observedAt || isoNow(),
    };
  }

  return {
    observeOverrides,
    observeLabelControl,
    observeOperatorApproved,
    observeForceRereview,
    observeHaltedLoop,
    observeRaisedRoundCap,
    observeMergeAgentOverride,
  };
}

export {
  FORCE_REREVIEW_LABEL,
  HALTED_LOOP_LABEL,
  MERGE_AGENT_REQUESTED_LABEL,
  OPERATOR_APPROVED_LABEL,
  RAISED_ROUND_CAP_LABEL,
  applyRevisionScopedLabelEvent,
  createGitHubPRLabelControlsAdapter,
  legacyLabelEventFromControlResult,
};
