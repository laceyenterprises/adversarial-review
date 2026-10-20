import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { readReviewOrder, sameBinding, sha256 } from '../../src/adapters/reviewer-runtime/federation-execution/review-order.mjs';
import { createFederationExecutionAdapter } from '../../src/adapters/reviewer-runtime/federation-execution/index.mjs';

export const reviewBody = '## Summary\nChecked frozen input.\n\n## Blocking issues\n- None.\n\n## Verdict\nApprove';
export const usage = [
  { eventId: 'estimate-1', source: 'estimate', quality: 'estimated', inputTokens: 100, outputTokens: 20, priceSource: 'fixture-v1' },
  { eventId: 'native-1', source: 'harness-native', quality: 'measured', inputTokens: 92, outputTokens: 18, cacheReadTokens: 7, revision: 2 },
];
const keys = generateKeyPairSync('ed25519');
export const signatureFor = (bytes) => sign(null, Buffer.from(bytes), keys.privateKey).toString('base64');
export const verifies = (bytes, signature) => verify(null, Buffer.from(bytes), keys.publicKey, Buffer.from(signature, 'base64'));

export function orderFixture(overrides = {}) {
  return {
    version: 1, orderId: 'order-a', workOrderHash: 'f'.repeat(64), originInstallId: 'install-a', executorInstallId: 'install-b', hostId: 'host-a',
    credential: { ownerInstallId: 'install-a', id: 'credential-a', generation: 1 },
    repo: 'example/repository', prNumber: 7, headSha: 'a'.repeat(40), round: 2, epoch: 3,
    runtime: 'antigravity', model: 'model-a', effectPolicy: 'review-result-only',
    prompt: { text: 'Review the frozen diff.', sha256: sha256('Review the frozen diff.') },
    diff: { text: '+fixture', sha256: sha256('+fixture') },
    context: { text: 'fixture context', sha256: sha256('fixture context') },
    budget: { timeoutMs: 1000, maxTokens: 2000, maxCostMicrousd: 1000, maxOutputBytes: 4096, maxArtifactBytes: 4096 }, ...overrides,
  };
}

// An injected service model, not production arbitration or a database proof.
// Its state survives adapter construction to model restart and live children.
export function fixtureService() {
  const grants = new Map();
  const active = new Map();
  const children = new Map();
  const pressure = new Map();
  const callers = [];
  let serial = 0;
  let starts = 0;
  const service = {
    grants, active, children, pressure, callers, now: Date.parse('2026-01-01T00:00:00Z'),
    get starts() { return starts; },
    forUser(user) {
      return Object.fromEntries(Object.entries(service.transport).map(([method, operation]) => [method, async (args) => {
        callers.push({ user, method });
        return operation(args);
      }]));
    },
    issue(binding) {
      const grantId = `grant-${++serial}`;
      grants.set(grantId, { binding, startId: `start-${serial}`, expiresAt: service.now + 60_000 });
      return grantId;
    },
    transport: {
      async consume({ grantId, binding }) {
        const grant = grants.get(grantId);
        if (!grant || !sameBinding(grant.binding, binding) || grant.expiresAt <= service.now || grant.finished) throw new Error('Invalid grant');
        const pressureKey = `${binding.credential.ownerInstallId}/${binding.credential.id}`;
        if ((pressure.get(pressureKey) || 0) > service.now) throw new Error('Account throttled');
        const occupant = active.get(binding.hostId);
        if (occupant && occupant !== grant.startId) throw new Error('Host occupied');
        active.set(binding.hostId, grant.startId);
        return { version: 1, grantId, startId: grant.startId, binding, validForMs: grant.expiresAt - service.now };
      },
      async finish({ permit, terminationProof }) {
        const child = children.get(permit.startId);
        if (!child || child.alive || terminationProof !== `stopped-${permit.startId}`) throw new Error('Child death unproven');
        const grant = grants.get(permit.grantId);
        if (!grant.finished) {
          if (active.get(permit.binding.hostId) !== permit.startId) throw new Error('Wrong occupant');
          active.delete(permit.binding.hostId);
          grant.finished = true;
        }
        return { released: true, startId: permit.startId };
      },
      async defer({ permit, retryAt }) {
        const credential = permit.binding.credential;
        const key = `${credential.ownerInstallId}/${credential.id}`;
        pressure.set(key, Math.max(pressure.get(key) || 0, Date.parse(retryAt)));
        return { recorded: true };
      },
    },
    supervisor({ hold = false, crash = false, report = {} } = {}) {
      return {
        async run({ order, permit, signal }) {
          if (signal.aborted) throw new Error('Cancelled');
          let child = children.get(permit.startId);
          if (!child) {
            starts += 1;
            let resolve;
            const done = new Promise((res) => { resolve = res; });
            child = { alive: true, done, resolve, report: {
              binding: permit.binding, output: reviewBody, diagnostic: '', exitCode: null,
              artifacts: [{ name: 'review.txt', content: reviewBody }], usage: structuredClone(usage),
              usageComplete: false, terminationProof: null, ...report,
            } };
            children.set(permit.startId, child);
            if (!hold && !crash) service.stop(permit.startId, report);
          }
          // Freeze checks ensure runtime cannot replace the authoritative target.
          if (!Object.isFrozen(order) || !Object.isFrozen(order.prompt)) throw new Error('Mutable order');
          if (crash) throw new Error('Supervisor connection lost after spawn');
          await child.done;
        },
        async snapshot({ permit }) { return structuredClone(children.get(permit.startId).report); },
      };
    },
    stop(startId, report = {}) {
      const child = children.get(startId);
      child.alive = false;
      Object.assign(child.report, { exitCode: 0, terminationProof: `stopped-${startId}`, usageComplete: true }, report);
      child.resolve();
    },
  };
  return service;
}

export function setup({ service = fixtureService(), order = orderFixture(), supervisor, ...dependencies } = {}) {
  const orderBytes = JSON.stringify(order);
  const { binding } = readReviewOrder(orderBytes);
  const grantId = service.issue(binding);
  const adapter = createFederationExecutionAdapter({
    seatTransport: service.transport, supervisor: supervisor || service.supervisor(), verifyOrder: verifies,
    readCurrent: async () => binding, signResult: signatureFor, now: () => service.now, ...dependencies,
  });
  const request = { orderBytes, signature: signatureFor(orderBytes), grantId };
  return { adapter, service, request, binding, async execute() {
    const response = await adapter.execute(request);
    if (!verifies(response.payloadBytes, response.signature)) throw new Error('Invalid result signature');
    return JSON.parse(response.payloadBytes);
  } };
}
