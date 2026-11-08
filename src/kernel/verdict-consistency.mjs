import { maskReviewFences } from './review-markdown.mjs';

const INCONSISTENT_VERDICT_MARKER = '<!-- verdict_inconsistent: true -->';
const BLOCKING_VERDICTS = new Set(['request-changes']);
const PERMISSIVE_VERDICTS = new Set(['comment-only', 'approved']);

// Only the Verdict section is evidence. In particular, examples in findings,
// the summary and the optional advisory cannot contradict the decision.
function verdictSection(body) {
  const text = maskReviewFences(body);
  const heading = /^##[ \t]+Verdict[ \t]*\r?$/im.exec(text);
  if (!heading) return '';
  const rest = text.slice(heading.index + heading[0].length);
  const next = rest.search(/^##[ \t]+/m);
  return next < 0 ? rest : rest.slice(0, next);
}

function verdictConsistency(body, blocking) {
  const section = verdictSection(body).replace(/[*_`~]/g, ' ').toLowerCase();
  const lines = section.split('\n').map(line => normalizeVerdictSectionLine(line));
  const blockingKeyword = lines.some(line => BLOCKING_VERDICTS.has(line));
  const permissiveKeyword = lines.some(line => PERMISSIVE_VERDICTS.has(line));
  const countPhrase = /\b([1-9]\d*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|multiple|several)\s+blocking\s+issues?\b/i;
  // Remove explicit zero/negative assertions before matching uncounted
  // "blocking issues remain". A negative assertion is never positive evidence.
  const positive = section.replace(/\b(?:no|zero|0)\s+blocking\s+issues?(?:\s+remain(?:s)?)?\b/g, '');
  const blockingProse = countPhrase.test(positive)
    || /(?<!non[- ])\bblocking\s+issues?\s+(?:still\s+)?remains?\b/.test(positive);
  const noBlockingProse = /\b(?:no|zero|0)\s+blocking\s+issues?\b/.test(section);
  const known = blocking.state === 'known';
  const verdict_inconsistent = maskReviewFences(body).includes(INCONSISTENT_VERDICT_MARKER)
    || (blockingKeyword && permissiveKeyword)
    || (known && blocking.count === 0 && (blockingKeyword || blockingProse))
    || (known && blocking.count > 0 && (permissiveKeyword || noBlockingProse))
    || (blockingProse && (permissiveKeyword || noBlockingProse));
  return { verdict_inconsistent };
}

function normalizeVerdictSectionLine(verdict) {
  const normalized = normalizeVerdictText(verdict);
  if (!normalized) return null;
  if (isResolvedRequestChangesProse(normalized)) return 'unknown';
  return normalizeReviewVerdict(normalized);
}

// Heuristic that neutralizes a Verdict-section line which STARTS with
// "request changes" but is actually prose ABOUT resolved history ("Request
// changes from the prior round are now resolved."), so tiebreak rule 1 in
// `extractReviewVerdict` does not score it as a live blocking verdict.
//
// Error-direction contract: a false NEGATIVE here (resolved prose kept as
// request-changes) only makes the gate stricter — the PR stays blocked until
// a cleaner review. A false POSITIVE (a real blocking line downgraded to
// 'unknown') could let a blocking review converge, so the pattern is
// deliberately conservative in three ways:
//   1. It only fires on lines that BEGIN with "request changes";
//   2. any blocking-context word (not/never/still/remains/must/needs/
//      unresolved/failing/regression/blocker/"before merge"/...) vetoes the
//      downgrade first, so negated resolutions like '...marked "now resolved"
//      are NOT fixed' stay blocking;
//   3. the resolution phrase must be a past/perfect "resolved/addressed/
//      fixed/closed" within 160 chars of the keyword.
// And the downgrade target is 'unknown' — never 'comment-only' — so the line
// merely stops competing in the tiebreak instead of asserting a permissive
// verdict. Pinned by test/kernel-parsers.test.mjs ('keeps blocking negation
// over trailing permissive prose').
function isResolvedRequestChangesProse(normalized) {
  if (!/^request changes\b/i.test(normalized)) return false;

  const stillBlocking = /\b(?:not|never|still|remain|remains|must|need|needs|required|requires|unresolved|unsafe|broken|failing|fails?|regression|blocker|blocking|before merge)\b/i
    .test(normalized);
  if (stillBlocking) return false;

  return /^request changes\b.{0,160}\b(?:(?:are|is|were|was|have been|has been|have now been|has now been|now|already)\s+(?:resolved|addressed|fixed|closed))\b/i
    .test(normalized);
}

function normalizeVerdictText(verdict) {
  return String(verdict ?? '')
    .replace(/[*_`~]/g, ' ')
    .replace(/^(?:\s*[-*]\s+)+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * @param {string | null | undefined} verdict
 * @returns {import('./contracts.js').ReviewVerdictKind | null}
 */
function normalizeReviewVerdict(verdict) {
  const text = normalizeVerdictText(verdict);
  if (!text) return null;
  if (text.startsWith('request changes')) return 'request-changes';
  if (text.startsWith('comment only')) return 'comment-only';
  if (text === 'approve' || /^approved\b/.test(text)) return 'approved';
  return 'unknown';
}

export { INCONSISTENT_VERDICT_MARKER, normalizeReviewVerdict, normalizeVerdictSectionLine, verdictConsistency, verdictSection };
