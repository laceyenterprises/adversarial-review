import { classifyReviewerFailure } from './adapters/reviewer-runtime/cli-direct/classification.mjs';

function reviewerFailureClassFromStoredRow(reviewRow) {
  const rawMessage = String(reviewRow?.failure_message || '');
  const message = rawMessage.toLowerCase();
  const tagMatch = message.match(/^\[(reviewer-timeout|launchctl-bootstrap|cascade)\]/);
  if (tagMatch) return tagMatch[1];
  const legacyClass = classifyReviewerFailure(rawMessage, null);
  if (legacyClass === 'cascade' || legacyClass === 'reviewer-timeout' || legacyClass === 'launchctl-bootstrap') {
    return legacyClass;
  }
  if (message.includes('claude launchctl session bootstrap failed') || message.includes('launchctlsessionerror')) {
    return 'launchctl-bootstrap';
  }
  if (/litellm\/upstream cascade|watcher backoff engaged/.test(message)) return 'cascade';
  return null;
}

// Infrastructure-class failures that the watcher may BOUNDEDLY auto-recover
// (re-queue to 'pending') once the routing tier is healthy again. Superset of
// reviewerFailureClassFromStoredRow: it additionally includes 'oauth-broken',
// because a reviewer that failed to *spawn* (command-failed before posting any
// verdict) is mislabeled oauth-broken — that is infrastructure, not a review
// outcome. NOTE: 'forbidden-fallback' is deliberately NOT recoverable (it is a
// security-class signal that must stay terminal). A real, persistent
// oauth-broken is bounded by the watcher's auto-recover cap, so its actionable
// operator alert is preserved once the cap is exhausted.
function infraRecoverableFailureClass(reviewRow) {
  const known = reviewerFailureClassFromStoredRow(reviewRow);
  if (known) return known;
  const message = String(reviewRow?.failure_message || '').toLowerCase();
  if (message.includes('[oauth-broken]')) {
    return 'oauth-broken';
  }
  return null;
}

export {
  infraRecoverableFailureClass,
  reviewerFailureClassFromStoredRow,
};
