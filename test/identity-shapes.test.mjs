import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODE_PR_DOMAIN_ID,
  buildCodePrSubjectIdentity,
  buildDeliveryKey,
  buildSubjectIdentity,
} from '../src/identity-shapes.mjs';

test('buildSubjectIdentity carries no hardcoded code-pr fallback', () => {
  // domainId must be threaded in; it is never defaulted to code-pr.
  assert.deepEqual(
    buildSubjectIdentity({ domainId: 'research-finding', subjectExternalId: 'doc#1', revisionRef: 'abc' }),
    { domainId: 'research-finding', subjectExternalId: 'doc#1', revisionRef: 'abc' },
  );
  // A partial identity (no domain, or no subject) collapses domainId to null
  // rather than silently assuming a domain.
  assert.deepEqual(
    buildSubjectIdentity({ subjectExternalId: 'doc#1' }),
    { domainId: null, subjectExternalId: 'doc#1', revisionRef: null },
  );
  assert.deepEqual(
    buildSubjectIdentity({ domainId: 'x' }),
    { domainId: null, subjectExternalId: null, revisionRef: null },
  );
});

test('buildCodePrSubjectIdentity defaults to the code-pr domain but is overridable', () => {
  // Backward-compatible default preserves delivery-key stability for existing
  // code-pr call sites.
  assert.deepEqual(
    buildCodePrSubjectIdentity({ repo: 'org/repo', prNumber: 7, revisionRef: 'sha7' }),
    { domainId: CODE_PR_DOMAIN_ID, subjectExternalId: 'org/repo#7', revisionRef: 'sha7' },
  );
  // The domain is an explicit parameter, not a baked-in assumption.
  assert.equal(
    buildCodePrSubjectIdentity({ repo: 'org/repo', prNumber: 7, domainId: 'code-pr-security' }).domainId,
    'code-pr-security',
  );
  // Invalid subject → null identity, no domain leakage.
  assert.equal(buildCodePrSubjectIdentity({ repo: '', prNumber: 0 }).domainId, null);
});

test('buildDeliveryKey stays byte-identical for default code-pr callers', () => {
  const key = buildDeliveryKey({ repo: 'org/repo', prNumber: 12, revisionRef: 'sha', round: 1, kind: 'review' });
  assert.deepEqual(key, {
    domainId: CODE_PR_DOMAIN_ID,
    subjectExternalId: 'org/repo#12',
    revisionRef: 'sha',
    round: 1,
    kind: 'review',
    noticeRef: null,
  });
  // Overridable domain flows into the delivery key.
  assert.equal(
    buildDeliveryKey({ repo: 'org/repo', prNumber: 12, kind: 'review', domainId: 'code-pr-security' }).domainId,
    'code-pr-security',
  );
});
