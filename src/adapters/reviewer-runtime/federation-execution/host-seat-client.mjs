import { boundedInteger, exactKeys, freeze, identifier, sameBinding } from './review-order.mjs';

// The injected transport authenticates the authority. It must durably consume a
// grant and consult shared credential pressure before returning a start permit.
// This client neither arbitrates seats nor resolves physical-parent identities.
export function createHostSeatClient(transport) {
  for (const method of ['consume', 'finish', 'defer']) {
    if (typeof transport?.[method] !== 'function') throw new TypeError(`Missing seat transport ${method}`);
  }
  return Object.freeze({
    async consume({ grantId, binding, signal }) {
      identifier(grantId);
      const permit = structuredClone(await transport.consume({ grantId, binding, signal }));
      exactKeys(permit, ['version', 'grantId', 'startId', 'binding', 'validForMs']);
      if (permit.version !== 1 || permit.grantId !== grantId || !sameBinding(permit.binding, binding)) {
        throw new Error('Seat permit binding mismatch');
      }
      identifier(permit.startId);
      boundedInteger(permit.validForMs, 1, 20 * 60 * 1000);
      return freeze(permit);
    },
    async finish({ permit, terminationProof, signal }) {
      // The service verifies this opaque supervisor proof against its durable
      // process record. A parent exit, boolean or lease expiry is not proof.
      if (typeof terminationProof !== 'string' || !terminationProof || terminationProof.length > 4096) {
        throw new Error('Missing termination proof');
      }
      const receipt = await transport.finish({ permit, terminationProof, signal });
      if (receipt?.released !== true || receipt.startId !== permit.startId) throw new Error('Seat not released');
    },
    async defer({ permit, retryAt, failureClass, signal }) {
      if (!Number.isFinite(Date.parse(retryAt))) throw new Error('Invalid pressure deadline');
      const receipt = await transport.defer({ permit, retryAt, failureClass, signal });
      if (receipt?.recorded !== true) throw new Error('Credential pressure not recorded');
    },
  });
}
