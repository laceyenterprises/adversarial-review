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

export {
  reviewerFailureClassFromStoredRow,
};
