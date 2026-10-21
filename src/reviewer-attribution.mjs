// Secret-free read projection. Account/holder data describes execution; it
// never selects a GitHub actor, signing subject, model family or merge power.
import { normalizeReviewerModel } from './adapters/subject/github-pr/routing.mjs';

const SUBJECTS = Object.freeze({
  claude: 'claude-reviewer-lacey', codex: 'codex-reviewer-lacey', gemini: 'gemini-reviewer-lacey',
});
const reference = value => typeof value === 'string' && value.trim() === value && /^[A-Za-z0-9._:-]{1,160}$/.test(value) ? value : null;
const generation = value => Number.isSafeInteger(value) && value >= 0 ? value : reference(value);

export function buildReviewerAttribution(context = {}) {
  const family = normalizeReviewerModel(context.reviewerModel);
  if (!SUBJECTS[family]) return null;
  const identity = `${family}-reviewer`;
  const native = context.reviewerAccountReceipt;
  const holder = context.agyHolderLease || context.agyIdentityLease;
  const receipt = family === 'gemini' ? holder : native;
  if (receipt?.identity && receipt.identity !== identity) throw new Error('reviewer attribution identity mismatch');
  const recordedProvider = context[`${family}BrokerProvider`];
  return {
    version: 1, identity, family, reviewerSubject: SUBJECTS[family],
    tokenAccountId: reference(receipt?.tokenAccountId),
    brokerProvider: family === 'gemini' ? null : reference(receipt?.brokerProvider || recordedProvider),
    holderRef: family === 'gemini' ? reference(holder?.user) : null,
    selectionReason: reference(receipt?.selectionReason || receipt?.reason),
    evidenceGeneration: generation(receipt?.evidenceGeneration),
    attemptRef: reference(family === 'gemini' ? holder?.reviewId : native?.lease?.request_id),
    leaseRef: reference(family === 'gemini' ? holder?.generation : native?.lease?.lease_id),
    leaseGeneration: generation(family === 'gemini' ? holder?.generation : native?.lease?.generation),
  };
}

// Use only the known fields; never serialize a complete runtime context or
// lease into an attestation/argv. This also validates projections read on retry.
export function validateReviewerAttribution(value, reviewerSubject = value?.reviewerSubject) {
  if (!value || value.version !== 1 || !Object.hasOwn(SUBJECTS, value.family)
    || value.identity !== `${value.family}-reviewer`
    || value.reviewerSubject !== SUBJECTS[value.family] || reviewerSubject !== value.reviewerSubject) {
    throw new Error('reviewer attribution subject mismatch');
  }
  const fields = ['tokenAccountId', 'brokerProvider', 'holderRef', 'selectionReason', 'attemptRef', 'leaseRef'];
  const keys = ['version', 'identity', 'family', 'reviewerSubject', ...fields, 'evidenceGeneration', 'leaseGeneration'];
  if (Object.keys(value).some(key => !keys.includes(key))
    || fields.some(key => value[key] !== null && reference(value[key]) !== value[key])
    || ['evidenceGeneration', 'leaseGeneration'].some(key => value[key] !== null && generation(value[key]) !== value[key])) {
    throw new Error('invalid reviewer attribution metadata');
  }
  return { ...value };
}

export function reviewerAttributionMetadata(metadata = {}, context = {}) {
  if (metadata.reviewerAttribution) return metadata; // immutable attempt binding
  const reviewerAttribution = context.reviewerAttribution
    ? validateReviewerAttribution(context.reviewerAttribution)
    : buildReviewerAttribution({ ...metadata, ...context });
  return reviewerAttribution ? { ...metadata, reviewerAttribution } : metadata;
}

export function reviewerAttributionForModel(value, model) {
  return value?.family === normalizeReviewerModel(model) ? validateReviewerAttribution(value) : null;
}

// Add a read projection only to this execution's pass. Leave original receipts,
// bodies and signatures intact. The metadata CAS cannot overwrite another writer.
export function persistReviewerAttributionForSession(db, row, context = {}) {
  if (!row.reviewer_session_uuid) return;
  const passes = db.prepare(`SELECT pass_id, metadata_json FROM reviewer_passes
    WHERE repo = ? AND pr_number = ? AND pass_kind IN ('first-pass', 'rereview')`).all(row.repo, row.pr_number);
  for (const pass of passes) {
    let metadata;
    try { metadata = JSON.parse(pass.metadata_json || '{}'); } catch { continue; }
    if (!metadata || metadata.reviewerSessionUuid !== row.reviewer_session_uuid) continue;
    const next = reviewerAttributionMetadata(metadata, context);
    if (next === metadata) continue;
    db.prepare('UPDATE reviewer_passes SET metadata_json = ? WHERE pass_id = ? AND metadata_json IS ?')
      .run(JSON.stringify(next), pass.pass_id, pass.metadata_json);
  }
}
