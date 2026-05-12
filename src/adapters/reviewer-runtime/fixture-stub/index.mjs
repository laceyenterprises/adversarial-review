import {
  claimReviewerRunRecord,
  updateReviewerRunRecord,
} from '../run-state.mjs';

function createFixtureStubReviewerRuntimeAdapter({
  rootDir = process.cwd(),
  reviewerBodies = [],
  remediatorBodies = [],
  now = () => new Date().toISOString(),
} = {}) {
  const reviewQueue = [...reviewerBodies];
  const remediationQueue = [...remediatorBodies];

  async function spawnReviewer(req) {
    const sessionUuid = String(req?.sessionUuid || '').trim();
    if (!sessionUuid) throw new TypeError('ReviewerRunRequest.sessionUuid is required');
    const spawnedAt = now();
    const initialRecord = {
      sessionUuid,
      domain: req.subjectContext?.domainId || 'research-finding',
      runtime: 'fixture-stub',
      state: 'spawned',
      pgid: null,
      spawnedAt,
      lastHeartbeatAt: null,
      reattachToken: `fixture:${sessionUuid}`,
      subjectContext: req.subjectContext || null,
    };
    const claim = claimReviewerRunRecord(rootDir, initialRecord);
    if (!claim.claimed && ['spawned', 'heartbeating'].includes(claim.record?.state)) {
      return {
        ok: false,
        reviewBody: null,
        failureClass: 'daemon-bounce',
        stderrTail: `fixture reviewer run ${sessionUuid} is already active`,
        stdoutTail: null,
        exitCode: null,
        signal: null,
        pgid: null,
        spawnedAt: claim.record.spawnedAt,
        reattachToken: claim.record.reattachToken,
      };
    }
    if (!claim.claimed) {
      return {
        ok: false,
        reviewBody: null,
        failureClass: 'bug',
        stderrTail: `fixture reviewer run ${sessionUuid} already reached terminal state ${claim.record?.state || 'unknown'}; mint a new session UUID before retrying`,
        stdoutTail: null,
        exitCode: null,
        signal: null,
        pgid: null,
        spawnedAt: claim.record?.spawnedAt || spawnedAt,
        reattachToken: claim.record?.reattachToken || `fixture:${sessionUuid}`,
      };
    }
    let record = updateReviewerRunRecord(rootDir, claim.record, {
      state: 'heartbeating',
      lastHeartbeatAt: now(),
    });
    const reviewBody = reviewQueue.shift() || '';
    record = updateReviewerRunRecord(rootDir, record, {
      state: 'completed',
      lastHeartbeatAt: now(),
    });
    return {
      ok: true,
      reviewBody,
      failureClass: null,
      stderrTail: null,
      stdoutTail: null,
      exitCode: 0,
      signal: null,
      pgid: record.pgid,
      spawnedAt: record.spawnedAt,
      reattachToken: record.reattachToken,
    };
  }

  async function spawnRemediator(req) {
    return {
      ok: true,
      remediationBody: remediationQueue.shift() || '',
      failureClass: null,
      stderrTail: null,
      stdoutTail: null,
      exitCode: 0,
      signal: null,
      pgid: null,
      spawnedAt: now(),
      reattachToken: req?.sessionUuid ? `fixture:${req.sessionUuid}` : null,
    };
  }

  async function cancel(sessionUuid) {
    return sessionUuid;
  }

  async function reattach(record) {
    return {
      ok: false,
      reviewBody: null,
      failureClass: 'daemon-bounce',
      stderrTail: 'fixture-stub does not reattach active reviewer runs',
      stdoutTail: null,
      exitCode: null,
      signal: null,
      pgid: Number.isInteger(record?.pgid) ? record.pgid : null,
      spawnedAt: record?.spawnedAt || now(),
      reattachToken: record?.reattachToken || null,
    };
  }

  function describe() {
    return {
      id: 'fixture-stub',
      modelFamily: 'fixture',
      capabilities: {
        processGroupIsolation: true,
        daemonBounceSafe: false,
        heartbeatPersisted: true,
        leaseManaged: false,
        oauthStripEnforced: true,
      },
    };
  }

  return {
    spawnReviewer,
    spawnRemediator,
    cancel,
    reattach,
    describe,
  };
}

export { createFixtureStubReviewerRuntimeAdapter };
