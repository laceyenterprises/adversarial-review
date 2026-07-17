// ReviewArtifact schema v2 (SPEC-adversarial-review-v2-app-architecture §4.3).
//
// The `os-dispatch` runtime dispatches a review with `--task-kind review
// --completion-shape decision-only`; the verdict comes back as a structured
// app artifact through the dispatch artifact-handoff surface. Per §2.4
// ("structured artifacts are the truth") this JSON is the canonical verdict
// source — markdown parsing is demoted to a local-mode fallback. This module
// is the runtime-boundary validator: it proves an incoming app artifact is a
// well-formed `ReviewArtifact` before the run is reported `completed`, so a
// malformed or wrong-kind handoff fails the run loudly instead of silently
// appending a junk verdict to pipeline state.
//
//   ReviewArtifact := {
//     kind: 'adversarial-review-verdict', schemaVersion: 2,
//     domainId, subjectExternalId, revisionRef,
//     stageId, reviewerRole, reviewerRunRef,
//     verdict: { kind, summary, blockingFindings[], nonBlockingFindings[] },
//     body: string
//   }

import { normalizeReviewVerdict } from '../../../kernel/verdict.mjs';

const REVIEW_ARTIFACT_KIND = 'adversarial-review-verdict';
const REVIEW_ARTIFACT_SCHEMA_VERSION = 2;
const CANONICAL_VERDICT_KINDS = new Set(['request-changes', 'comment-only', 'approved', 'unknown']);

// A v2 artifact's `verdict.kind` is normally already a canonical
// ReviewVerdictKind (`request-changes`, `comment-only`, `approved`, `unknown`).
// `normalizeReviewVerdict` only understands human phrases ("Request changes"),
// so accept the canonical hyphenated form directly and fall back to phrase
// normalization for producers that emit prose.
function canonicalizeVerdictKind(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (CANONICAL_VERDICT_KINDS.has(trimmed)) return trimmed;
  return normalizeReviewVerdict(value);
}

// A schema failure that is the reviewer run's fault (bad artifact), not a
// transport/dispatch fault. The runtime maps it to failureClass
// 'reviewer-output', mirroring the local runtime's artifact-validation path.
class ReviewArtifactSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReviewArtifactSchemaError';
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function normalizeFinding(finding) {
  if (typeof finding === 'string') return { problem: finding };
  if (!isPlainObject(finding)) {
    throw new ReviewArtifactSchemaError('verdict finding must be a string or object');
  }
  const normalized = {};
  const title = optionalString(finding.title);
  const file = optionalString(finding.file);
  const lines = optionalString(finding.lines);
  const problem = optionalString(finding.problem);
  if (title !== undefined) normalized.title = title;
  if (file !== undefined) normalized.file = file;
  if (lines !== undefined) normalized.lines = lines;
  if (problem !== undefined) normalized.problem = problem;
  return normalized;
}

function normalizeFindings(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new ReviewArtifactSchemaError(`${field} must be an array when present`);
  }
  return value.map(normalizeFinding);
}

// Validate + normalize an app artifact into a ReviewArtifact (schemaVersion 2).
// Throws ReviewArtifactSchemaError on any structural violation; returns a
// normalized copy on success (verdict.kind canonicalized, findings defaulted).
function validateReviewArtifact(artifact) {
  if (!isPlainObject(artifact)) {
    throw new ReviewArtifactSchemaError('review artifact must be a JSON object');
  }
  if (artifact.kind !== REVIEW_ARTIFACT_KIND) {
    throw new ReviewArtifactSchemaError(
      `review artifact kind must be '${REVIEW_ARTIFACT_KIND}' (got ${JSON.stringify(artifact.kind)})`,
    );
  }
  if (artifact.schemaVersion !== REVIEW_ARTIFACT_SCHEMA_VERSION) {
    throw new ReviewArtifactSchemaError(
      `review artifact schemaVersion must be ${REVIEW_ARTIFACT_SCHEMA_VERSION} (got ${JSON.stringify(artifact.schemaVersion)})`,
    );
  }

  const missing = [];
  for (const field of ['domainId', 'subjectExternalId', 'revisionRef', 'body']) {
    if (typeof artifact[field] !== 'string' || artifact[field].trim() === '') {
      missing.push(field);
    }
  }
  if (!isPlainObject(artifact.verdict)) {
    missing.push('verdict');
  }
  if (missing.length > 0) {
    throw new ReviewArtifactSchemaError(
      `review artifact missing required field(s): ${missing.join(', ')}`,
    );
  }

  const verdictKind = canonicalizeVerdictKind(artifact.verdict.kind);
  if (!verdictKind) {
    throw new ReviewArtifactSchemaError('review artifact verdict.kind is missing or unrecognized');
  }

  const normalizedVerdict = {
    kind: verdictKind,
    summary: optionalString(artifact.verdict.summary) ?? '',
    blockingFindings: normalizeFindings(artifact.verdict.blockingFindings, 'verdict.blockingFindings'),
    nonBlockingFindings: normalizeFindings(artifact.verdict.nonBlockingFindings, 'verdict.nonBlockingFindings'),
  };

  const normalized = {
    kind: REVIEW_ARTIFACT_KIND,
    schemaVersion: REVIEW_ARTIFACT_SCHEMA_VERSION,
    domainId: artifact.domainId,
    subjectExternalId: artifact.subjectExternalId,
    revisionRef: artifact.revisionRef,
    verdict: normalizedVerdict,
    body: artifact.body,
  };
  const stageId = optionalString(artifact.stageId);
  const reviewerRole = optionalString(artifact.reviewerRole);
  const reviewerRunRef = optionalString(artifact.reviewerRunRef);
  if (stageId !== undefined) normalized.stageId = stageId;
  if (reviewerRole !== undefined) normalized.reviewerRole = reviewerRole;
  if (reviewerRunRef !== undefined) normalized.reviewerRunRef = reviewerRunRef;
  return normalized;
}

export {
  REVIEW_ARTIFACT_KIND,
  REVIEW_ARTIFACT_SCHEMA_VERSION,
  ReviewArtifactSchemaError,
  validateReviewArtifact,
};
