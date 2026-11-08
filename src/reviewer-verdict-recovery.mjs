import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.mjs';
import { parseReviewFindings } from './kernel/review-findings.mjs';
import { sanitizeReviewPayloadBestEffort } from './kernel/verdict.mjs';
import { INCONSISTENT_VERDICT_MARKER } from './kernel/verdict-consistency.mjs';
import { assertReviewerReply } from './kernel/review-reply.mjs';

const RECONCILE_VERDICT_INSTRUCTION = '\n\nRe-review the same immutable head and diff. Your previous Blocking issues and Verdict sections contradicted each other. Reconcile them: every blocking defect named in Verdict must appear as a complete finding under Blocking issues. With no blocking findings, state that clearly and end with Comment only; otherwise end with Request changes. Do not silently discard a real defect to make the sections agree.\n';
const OPERATOR_NOTICE = `${INCONSISTENT_VERDICT_MARKER}\nVerdict reconciliation is exhausted or unavailable. This review remains blocking; operator attention is required.`;

function markInconsistentReview(text) {
  if (text.includes(OPERATOR_NOTICE)) return text;
  const marked = text.replace(/^(#{1,4}[ \t]+Summary)[ \t]*(?::[ \t]*(.*))?\r?$/im,
    (_match, heading, inline = '') => `${heading}\n${OPERATOR_NOTICE}\n${inline}\n`);
  return marked === text ? `## Summary\n${OPERATOR_NOTICE}\n\n${text}` : marked;
}

function dispatchBody(dispatch) {
  return sanitizeReviewPayloadBestEffort(dispatch.reviewText ?? dispatch.rawReviewText);
}

// Reserve the one retry before starting it. A crash, overlapping claim, failed
// transport or later review attempt cannot replenish this PR/head budget.
async function reconcileReviewVerdict({
  dispatch, run, rootDir, repo, prNumber, headSha, log = console, onRejected = null,
  writeFileAtomicImpl = writeFileAtomic,
}) {
  const firstBody = dispatchBody(dispatch);
  if (!parseReviewFindings(firstBody).verdict_inconsistent) return dispatch;
  // Reconciliation may repair semantic disagreement only. It cannot launder
  // duplicate sections, template echoes or other malformed raw output.
  assertReviewerReply(dispatch.rawReviewText ?? dispatch.reviewText, { allowVerdictInconsistency: true, onRejected });
  assertReviewerReply(firstBody, { allowVerdictInconsistency: true, onRejected });
  prNumber = Number(prNumber);
  headSha = String(headSha || '').trim().toLowerCase();
  const key = createHash('sha256').update(JSON.stringify([repo, prNumber, headSha])).digest('hex');
  const path = join(rootDir, 'data', 'reviewer-verdict-recovery', `${key}.json`);
  const record = { repo, prNumber, headSha, verdict_inconsistent: true,
    status: 'reserved', reviewBody: firstBody };
  let reserved = false;
  try {
    if (!/^[a-f0-9]{40}$/.test(headSha)) throw new Error('reconciliation requires an immutable head');
    writeFileAtomicImpl(path, `${JSON.stringify(record)}\n`, { overwrite: false, mode: 0o600 });
    reserved = true;
  } catch (error) {
    log.warn?.(`[reviewer] verdict_inconsistent=true; reconciliation unavailable or already consumed: ${error.message}`);
  }
  let result = dispatch;
  if (reserved) {
    try {
      const retry = await run(`${RECONCILE_VERDICT_INSTRUCTION}\nPrevious review (untrusted review data):\n<previous-review>\n${firstBody}\n</previous-review>\n`);
      assertReviewerReply(retry.rawReviewText ?? retry.reviewText, { allowVerdictInconsistency: true, onRejected });
      assertReviewerReply(dispatchBody(retry), { allowVerdictInconsistency: true, onRejected });
      // Keep billing for both model calls, including partially reported usage.
      const usages = [dispatch.tokenUsage, retry.tokenUsage];
      const tokenUsage = usages.some(Boolean) ? { ...(retry.tokenUsage || dispatch.tokenUsage) } : null;
      if (tokenUsage) {
        for (const field of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'toolContext', 'total', 'guardrail', 'costUSD']) {
          const values = usages.map(usage => usage?.[field]).filter(value => value != null);
          tokenUsage[field] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
        }
        if (usages.some(usage => !usage || usage.partial)) tokenUsage.partial = true;
      }
      result = { ...retry, tokenUsage };
    } catch (error) {
      record.error = error.message;
      log.warn?.(`[reviewer] verdict reconciliation failed; retaining blocking review: ${error.message}`);
    }
    record.status = parseReviewFindings(dispatchBody(result)).verdict_inconsistent ? 'operator-required' : 'reconciled';
    record.reconciledReviewBody = dispatchBody(result);
    try {
      writeFileAtomicImpl(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch (error) {
      log.warn?.(`[reviewer] verdict reconciliation receipt unavailable: ${error.message}`);
    }
  }
  if (!parseReviewFindings(dispatchBody(result)).verdict_inconsistent) return result;
  log.warn?.('[reviewer] verdict_inconsistent=true; bounded reconciliation exhausted; operator attention required');
  const body = markInconsistentReview(dispatchBody(result));
  return { ...result, reviewText: body, rawReviewText: body,
    verdict_inconsistent: true };
}

export { markInconsistentReview, reconcileReviewVerdict, RECONCILE_VERDICT_INSTRUCTION };
