// PR comment poster for the remediation pipeline.
//
// Every terminal reconcile transition (completed / stopped / failed) emits a
// public PR comment so the conversation stays in GitHub instead of in
// `data/follow-up-jobs/*` JSON. Without this, an automated remediation cycle
// is invisible to anyone reading the PR — they see the original "Request
// changes" review and no evidence the system tried to address it.
//
// Identity: the comment posts under the worker's matching reviewer-bot PAT
// (claude-code worker → `GH_CLAUDE_REVIEWER_TOKEN`,
//  codex worker → `GH_CODEX_REVIEWER_TOKEN`). The body header always names
// "Remediation Worker (<class>)" so the actual role is unambiguous even
// though the GitHub identity says "...-reviewer-lacey".
//
// Failure mode: posting is best-effort. If `gh pr comment` fails, we log
// and return — the reconcile state transition still completes. A missed
// comment is recoverable; blocking the transition on a network blip would
// leave the queue stuck.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { redactBulletList, redactPathlikeText, redactPublicSafeText, redactSensitiveText } from './redaction.mjs';

const execFileAsync = promisify(execFile);

// Length caps for worker-supplied fields in the public PR comment.
// Workers are untrusted output sources — these caps bound how much
// markdown a single round can dump on the PR even after redaction.
const SUMMARY_MAX_CHARS = 2000;
const REREVIEW_REASON_MAX_CHARS = 400;
const BULLET_LIST_PER_ITEM_MAX_CHARS = 400;
const BULLET_LIST_MAX_ITEMS = 25;

// Worker class → bot-token env var. Add an entry here when a new
// remediation worker class lands; the absence of an entry causes
// `postRemediationOutcomeComment` to skip posting (with a clear log
// message) rather than crash the reconcile path.
const WORKER_CLASS_TO_BOT_TOKEN_ENV = {
  codex: 'GH_CODEX_REVIEWER_TOKEN',
  'claude-code': 'GH_CLAUDE_REVIEWER_TOKEN',
};

function resolveCommentBotTokenEnv(workerClass) {
  return WORKER_CLASS_TO_BOT_TOKEN_ENV[workerClass] || null;
}

// Wrap untrusted text in a fenced code block so any markdown inside
// (mentions, autolinks, headings, task lists, raw HTML, issue
// references like "fixes #123") is rendered as inert plaintext on
// GitHub. The fence width auto-grows to be longer than any backtick
// run inside the content — otherwise a worker dumping ```` would
// terminate our fence early and re-enable rendering of subsequent
// content.
function buildSafeFenceWidth(content) {
  const text = String(content ?? '');
  let width = 3;
  // GitHub fences support up to ~10 backticks; any reasonable run is
  // bounded by the content's longest run + 1.
  const runs = text.match(/`+/g) || [];
  for (const run of runs) {
    if (run.length >= width) {
      width = run.length + 1;
    }
  }
  return width;
}

// Wrap a single sanitized string in a code fence. We use `text` as
// the language hint — that disables syntax highlighting AND ensures
// the renderer treats the inside as literal characters (no
// `@mentions`, no autolinks, no GFM extensions).
function fenceUntrustedText(text) {
  const fence = '`'.repeat(buildSafeFenceWidth(text));
  return `${fence}text\n${text}\n${fence}`;
}

// Render a worker-supplied bullet list with redaction + caps + markdown
// neutralization. Each item lives inside its own fenced code block so
// that worker-injected `@org/team` mentions, autolinks, and raw HTML
// stay inert. Empty (after filtering) → returns the placeholder text.
function formatRedactedBulletList(items, emptyText = '_(none reported)_') {
  const safe = redactBulletList(items, {
    perItemLimit: BULLET_LIST_PER_ITEM_MAX_CHARS,
    maxItems: BULLET_LIST_MAX_ITEMS,
  });
  if (!safe.length) return emptyText;
  // Use a sub-list with each item rendered as a fenced inline-style
  // block so list structure remains visible but content is inert.
  return safe.map((s) => `- ${fenceUntrustedText(s)}`).join('\n\n');
}

// Caps on the per-entry rendered output. Files line is generous enough
// for a real fix touching ~10 files, but bounded so a runaway worker
// can't dump every file in the repo (the joined-line cap is what
// enforces the bound; the count is allowed to be high since each path
// is short and per-line truncation still kicks in). Per-entry text
// caps apply independently to finding/action/reasoning so one long
// action does not crowd out the others.
const ADDRESSED_FILES_MAX_CHARS = 600;
const PER_ENTRY_FIELD_MAX_CHARS = 800;
const PER_ENTRY_TITLE_MAX_CHARS = 120;
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const TITLE_CONTROL_CHARS_PATTERN = /[\u0000-\u001F\u007F\u2028\u2029]/g;
const TITLE_FORMAT_CHARS_PATTERN = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

// Indent every line of `text` with `prefix`. Used to align fenced code
// blocks under markdown list items so GFM renders them as part of the
// numbered item rather than breaking the list.
function indentBlock(text, prefix) {
  return String(text ?? '')
    .split('\n')
    .map((line) => (line.length ? `${prefix}${line}` : prefix.replace(/\s+$/, '')))
    .join('\n');
}

// Wrap a path in inline backticks for inline-code rendering. Backticks
// inside the path are stripped defensively so a worker-supplied path
// can't break out of the wrapper. Empty or whitespace-only input
// returns null so the caller can omit the entry entirely.
function safeInlineCode(text) {
  const stripped = String(text ?? '').replace(/`/g, '').trim();
  if (!stripped) return null;
  return `\`${stripped}\``;
}

function normalizeEntryTitleText(text) {
  return String(text ?? '')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(TITLE_FORMAT_CHARS_PATTERN, '')
    .replace(TITLE_CONTROL_CHARS_PATTERN, ' ')
    .replace(/[`*_#[\]<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeEntryTitle(entry, fallback = 'Finding') {
  const title = normalizeEntryTitleText(entry?.title);
  if (!title) return fallback;
  return normalizeEntryTitleText(redactPublicSafeText(title, PER_ENTRY_TITLE_MAX_CHARS)) || fallback;
}

// Render a fenced text block at `indentLevel` spaces of indent so the
// fenced content nests under a markdown list item. The fence width
// auto-grows to outrun any backtick run inside the content (same
// guarantee as fenceUntrustedText).
function indentedFencedText(text, indentLevel = 3) {
  const prefix = ' '.repeat(indentLevel);
  return indentBlock(fenceUntrustedText(text), prefix);
}

// Render the worker's per-finding accountability list. Each entry of
// `addressed[]` produces a numbered point-by-point block:
//
//   1. **Finding**
//
//      ```text
//      <quoted summary of the review's blocking issue>
//      ```
//
//      **Action**
//
//      ```text
//      <what the worker did to address it>
//      ```
//
//      **Files:** `a.js`, `b.js`   ← only when entry.files is non-empty
//
// The structure puts bold labels OUTSIDE fenced blocks so they render
// as markdown, while untrusted finding/action text stays INSIDE fences
// and remains inert (no @mentions / autolinks / GFM extensions reach
// the PR thread). Files are inline-coded paths with backticks stripped
// so a worker-injected ` cannot break out of the inline-code wrapper.
function formatAddressedList(items, emptyText = '_(none reported)_') {
  if (!Array.isArray(items) || items.length === 0) return emptyText;
  const entries = items
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const finding = String(entry.finding ?? '').trim();
      const action = String(entry.action ?? '').trim();
      if (!finding || !action) return null;
      const files = Array.isArray(entry.files)
        ? entry.files
            .filter((f) => typeof f === 'string' && f.trim())
            .map((f) => safeInlineCode(redactPublicSafeText(f.trim(), 200)))
            .filter(Boolean)
        : [];
      return {
        title: safeEntryTitle(entry),
        finding: redactPublicSafeText(finding, PER_ENTRY_FIELD_MAX_CHARS),
        action: redactPublicSafeText(action, PER_ENTRY_FIELD_MAX_CHARS),
        files,
      };
    })
    .filter(Boolean)
    .slice(0, BULLET_LIST_MAX_ITEMS);

  if (!entries.length) return emptyText;

  return entries
    .map((entry, index) => {
      const lines = [
        `${index + 1}. **${entry.title}**`,
        '',
        indentedFencedText(entry.finding),
        '',
        '   **Action**',
        '',
        indentedFencedText(entry.action),
      ];
      if (entry.files.length) {
        let filesLine = `   **Files:** ${entry.files.join(', ')}`;
        if (filesLine.length > ADDRESSED_FILES_MAX_CHARS) {
          filesLine = `${filesLine.slice(0, ADDRESSED_FILES_MAX_CHARS - 1)}…`;
        }
        lines.push('');
        lines.push(filesLine);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

// Render the worker's pushback list. `pushback[]` is for findings the
// worker read, deliberately decided NOT to change the code on, and
// wants to record the reasoning. Distinct from `blockers[]` (hard
// exit) and `addressed[]` (fix applied). Same numbered point-by-point
// shape as addressed entries, with **Reasoning** in place of **Action**.
function formatPushbackList(items, emptyText = '_(none reported)_') {
  if (!Array.isArray(items) || items.length === 0) return emptyText;
  const entries = items
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const finding = String(entry.finding ?? '').trim();
      const reasoning = String(entry.reasoning ?? '').trim();
      if (!finding || !reasoning) return null;
      return {
        title: safeEntryTitle(entry),
        finding: redactPublicSafeText(finding, PER_ENTRY_FIELD_MAX_CHARS),
        reasoning: redactPublicSafeText(reasoning, PER_ENTRY_FIELD_MAX_CHARS),
      };
    })
    .filter(Boolean)
    .slice(0, BULLET_LIST_MAX_ITEMS);

  if (!entries.length) return emptyText;

  return entries
    .map((entry, index) => {
      return [
        `${index + 1}. **${entry.title}**`,
        '',
        indentedFencedText(entry.finding),
        '',
        '   **Reasoning**',
        '',
        indentedFencedText(entry.reasoning),
      ].join('\n');
    })
    .join('\n\n');
}

// Render the worker's blockers list. `blockers[]` is the hard-exit
// slot — findings the worker could not resolve at all and that
// require human input to move forward. The structured form
// `{ finding, reasoning?, needsHumanInput? }` ties each blocker back
// to the originating review finding so the next human can see, for a
// multi-finding review, exactly which item is unresolved.
//
// A legacy reply that still emits string entries (predates the
// structured contract) renders as a numbered text block with the
// string treated as the finding. New replies always come through the
// validator which rejects strings, so this fallback only fires on
// imported / hand-edited terminal job records.
function formatBlockersList(items, emptyText = '_(none reported)_') {
  if (!Array.isArray(items) || items.length === 0) return emptyText;
  const entries = items
    .map((entry) => {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (!trimmed) return null;
        return {
          title: 'Finding',
          finding: redactPublicSafeText(trimmed, PER_ENTRY_FIELD_MAX_CHARS),
          reasoning: '',
          needsHumanInput: '',
        };
      }
      if (!entry || typeof entry !== 'object') return null;
      const finding = String(entry.finding ?? '').trim();
      if (!finding) return null;
      return {
        title: safeEntryTitle(entry),
        finding: redactPublicSafeText(finding, PER_ENTRY_FIELD_MAX_CHARS),
        reasoning: redactPublicSafeText(
          String(entry.reasoning ?? '').trim(),
          PER_ENTRY_FIELD_MAX_CHARS,
        ),
        needsHumanInput: redactPublicSafeText(
          String(entry.needsHumanInput ?? '').trim(),
          PER_ENTRY_FIELD_MAX_CHARS,
        ),
      };
    })
    .filter(Boolean)
    .slice(0, BULLET_LIST_MAX_ITEMS);

  if (!entries.length) return emptyText;

  return entries
    .map((entry, index) => {
      const lines = [
        `${index + 1}. **${entry.title}**`,
        '',
        indentedFencedText(entry.finding),
      ];
      if (entry.reasoning) {
        lines.push('');
        lines.push('   **Reasoning**');
        lines.push('');
        lines.push(indentedFencedText(entry.reasoning));
      }
      if (entry.needsHumanInput) {
        lines.push('');
        lines.push('   **Needs human input**');
        lines.push('');
        lines.push(indentedFencedText(entry.needsHumanInput));
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

// Sanitize a free-text field for use in a BLOCK context (the
// Summary section). Redacts sensitive substrings (tokens AND
// host-local filesystem paths — workers run inside a checked-out
// workspace and can echo `/Users/<operator>/...` from a log line into
// `summary`), caps length, then wraps in a fenced code block so any
// markdown the worker tried to inject (mentions, autolinks, headings,
// task lists, HTML) renders as plaintext. Redaction is not
// sanitization — markdown injection from an untrusted source is a
// separate concern.
function sanitizeFreeText(text, limit) {
  const redacted = redactPublicSafeText(String(text ?? '').trim(), limit);
  if (!redacted) return '';
  return fenceUntrustedText(redacted);
}

// Sanitize a free-text field for use INLINE (the rereview status
// line). Redacts tokens AND host-local paths, caps length, collapses
// whitespace to a single space (no embedded newlines that would break
// out of the inline context), wraps in single-backtick inline code,
// and escapes any backticks the content tries to use to break out.
// Backtick wrapping in GitHub's renderer is sufficient to disable
// `@mentions`, autolinks, and HTML inside it.
function sanitizeInlineText(text, limit) {
  const redacted = redactPublicSafeText(String(text ?? '').trim().replace(/\s+/g, ' '), limit);
  if (!redacted) return '';
  // GFM inline code: backticks inside need to be quoted with longer
  // backtick runs. Easiest robust path: replace any backtick with U+200B
  // (zero-width space) before wrapping, so the wrapper can stay 1-tick.
  const safe = redacted.replace(/`/g, '​`​');
  return `\`${safe}\``;
}

// Sanitize an INTERNAL failure message before publishing it in a
// PR comment. Different from worker-supplied text (which gets fenced
// code blocks because it could contain anything): failure messages
// are inline-safe text from our own code, but they routinely embed
// absolute filesystem paths from exception messages
// (`/Users/airlock/agent-os/.../foo.json`). Publishing those leaks
// host filesystem layout. Redact tokens (defense-in-depth) and mask
// paths to `<path-redacted>/<basename>`. Output is plain text, not
// fenced — the caller wraps it in inline code.
const FAILURE_MESSAGE_MAX_CHARS = 400;
function sanitizeFailureText(text) {
  const collapsed = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!collapsed) return '';
  const tokenSafe = redactSensitiveText(collapsed);
  const pathSafe = redactPathlikeText(tokenSafe);
  if (pathSafe.length <= FAILURE_MESSAGE_MAX_CHARS) return pathSafe;
  return `${pathSafe.slice(0, FAILURE_MESSAGE_MAX_CHARS - 1)}…`;
}

// Deterministic dedupe marker baked into every remediation outcome
// comment. It encodes (jobId, round, action) so the same logical
// comment always carries the same identifier across tick retries.
//
// Why we need it: `gh pr comment` can time out AFTER GitHub accepted
// the create. The local poster sees `gh-cli-timeout`, the delivery
// record stays `posted=false`, the next tick retries — and without
// this marker it would post a duplicate of the comment that already
// landed. The poster's pre-post dedup check looks for this marker
// in existing comments before re-issuing the create.
//
// Format: HTML comment so GitHub's renderer drops it. Stable string
// constants (no whitespace, no markdown) so a substring match against
// `body` survives any GitHub-side normalization (line ending changes,
// trailing newlines, etc.).
const REMEDIATION_COMMENT_MARKER_PREFIX = 'adversarial-review-remediation-marker';

function sanitizeMarkerComponent(value) {
  // The marker lives inside an HTML comment, so we need to keep
  // anything that could close the comment (`-->`) or carry whitespace
  // out of the literal. Worker-controlled values never reach this
  // function — the components are jobId / action / round which we
  // synthesize ourselves — but defense-in-depth is cheap.
  return String(value ?? 'unknown').replace(/[^A-Za-z0-9_.:-]/g, '_');
}

function buildRemediationOutcomeCommentMarker({ jobId, round, action }) {
  const safeJob = sanitizeMarkerComponent(jobId);
  const safeRound = sanitizeMarkerComponent(round);
  const safeAction = sanitizeMarkerComponent(action);
  return `${REMEDIATION_COMMENT_MARKER_PREFIX}:${safeJob}:r${safeRound}:${safeAction}`;
}

function extractRemediationCommentMarker(body) {
  if (!body) return null;
  // Match the literal HTML comment we emit in the body. Anchored on
  // the prefix so an unrelated marker (e.g. an operator-pasted block)
  // can't accidentally match.
  const match = String(body).match(
    new RegExp(`<!--\\s*(${REMEDIATION_COMMENT_MARKER_PREFIX}:[^\\s]+)\\s*-->`)
  );
  return match ? match[1] : null;
}

function buildRemediationOutcomeCommentBody({
  workerClass,
  action,
  job,
  reply = null,
  reReview = null,
  failure = null,
}) {
  const round = Number(job?.remediationPlan?.currentRound || 0) || 1;
  const maxRounds = Number(job?.remediationPlan?.maxRounds || 0) || null;
  const roundLabel = maxRounds ? `${round} of ${maxRounds}` : String(round);
  const headerClass = workerClass || 'unknown';
  const marker = buildRemediationOutcomeCommentMarker({
    jobId: job?.jobId,
    round,
    action,
  });
  const lines = [];

  // Marker first so a substring search hits the smallest possible
  // span at the top of the body. HTML comments don't render in
  // GitHub markdown so this is invisible to PR readers.
  lines.push(`<!-- ${marker} -->`);
  lines.push(`### Remediation Worker (${headerClass}) — round ${roundLabel}`);
  lines.push('');

  if (action === 'completed') {
    // The completed action is gated on rereview acceptance in
    // reconcileFollowUpJob, so by the time we render here we know the
    // rereview either was accepted (status='pending', triggered=true)
    // or was already pending (status='already-pending'). Both mean a
    // fresh adversarial pass is queued; word the comment to match.
    const rrStatus = reReview?.status;
    const queuedNote = rrStatus === 'already-pending'
      ? 're-review already pending — no reset needed'
      : 're-review queued';
    lines.push(`**Outcome:** \`${reply?.outcome || 'completed'}\` — ${queuedNote}.`);
  } else if (action === 'stopped') {
    const stopCode = job?.remediationPlan?.stop?.code || 'no-progress';
    lines.push(`**Outcome:** stopped (\`${stopCode}\`).`);
    if (stopCode === 'rereview-blocked') {
      const blockedReason = reReview?.outcomeReason || reReview?.status || 'unknown';
      lines.push('');
      lines.push(
        `> **Human intervention required.** The worker requested a re-review pass, but the watcher refused the reset (\`${blockedReason}\`). The PR's existing adversarial-review verdict will not be replaced. Inspect the review ledger and either re-open the PR / restore the review row / clear the malformed-title state, then re-arm with \`npm run retrigger-review\`.`
      );
    } else if (stopCode === 'max-rounds-reached') {
      lines.push('');
      lines.push(
        '> **Human intervention required.** The remediation loop exhausted its bounded round cap without converging. Review the changes by hand, decide whether to re-arm or close.'
      );
    } else if (stopCode === 'round-budget-exhausted') {
      // Risk-tiered budget refusal from
      // pr-merge-orchestration spec §3.1: the daemon refused to
      // spawn another remediation worker because the PR's
      // riskClass-derived budget was already exhausted PR-wide.
      // Distinct from `max-rounds-reached` (which is per-job
      // legacy capacity); this branch fires when the riskClass
      // tier itself has been exhausted across all rounds for
      // this PR. Operator next step is to either accept the PR
      // as-is or justify a higher riskClass via the linked spec.
      const riskClass = job?.riskClass || 'medium';
      const roundBudget = Number(
        job?.remediationPlan?.maxRounds
          || job?.recommendedFollowUpAction?.maxRounds
          || 1
      );
      const currentRound = Number(job?.remediationPlan?.currentRound || 0);
      lines.push('');
      lines.push(
        `> **Human intervention required.** This PR exhausted its \`${riskClass}\` risk-class remediation budget (${roundBudget} round${roundBudget === 1 ? '' : 's'}; completed: ${currentRound}). Review the prior rounds and either accept the PR as-is or reopen the linked spec to justify a higher \`riskClass\` before requesting more remediation.`
      );
    } else if (reply && reply.outcome === 'blocked') {
      lines.push('');
      lines.push(
        '> **Human intervention required.** The worker reported blockers it could not resolve in this round. See the blockers list below.'
      );
    } else {
      lines.push('');
      lines.push(
        '> The worker did not request a re-review pass; this PR will retain its current adversarial-review verdict until a human re-arms or closes the job.'
      );
    }
  } else if (action === 'failed') {
    lines.push(`**Outcome:** failed.`);
    lines.push('');
    // failure.message and failure.code originate from internal
    // exceptions and stop codes (e.g. `Failed to read remediation
    // reply artifact at /Users/airlock/agent-os/.../foo.json`).
    // They cross a trust boundary into a public PR comment, so
    // we redact tokens AND mask host-local filesystem paths
    // before publishing. R3 review #3.
    if (failure?.message) {
      const safeMessage = sanitizeFailureText(failure.message);
      lines.push(`Reason: \`${safeMessage}\``);
    } else if (failure?.code) {
      const safeCode = sanitizeFailureText(failure.code);
      lines.push(`Reason: \`${safeCode}\``);
    } else {
      lines.push('Reason: unknown — check the daemon logs.');
    }
    lines.push('');
    // Salvage path: when the failure code is invalid-remediation-reply
    // AND we recovered renderable fields from the malformed reply,
    // soften the human-intervention message so it acknowledges the
    // recovered worker response below instead of claiming the worker
    // produced nothing usable. The state machine still treated this
    // round as failed; the operator just gets the worker's
    // point-by-point response alongside the contract-violation reason.
    const hasSalvagedContent = Boolean(
      reply
        && (reply.summary
          || reply.validation?.length
          || reply.addressed?.length
          || reply.pushback?.length
          || reply.blockers?.length)
    );
    if (hasSalvagedContent && failure?.code === 'invalid-remediation-reply') {
      lines.push(
        '> **Human intervention required.** The worker\'s reply failed strict schema validation (see Reason above), but its point-by-point response was recovered below. Inspect the recovered response, decide whether to accept the work or re-arm.'
      );
    } else {
      lines.push(
        '> **Human intervention required.** The worker did not produce a usable remediation reply. Inspect `data/follow-up-jobs/failed/` for the job record and the worker logs.'
      );
    }
  }

  // Worker-supplied fields below are *untrusted*. They go through
  // src/redaction.mjs (token / Bearer / private-key / labelled-secret
  // patterns) and are length-capped before being written to the PR.
  // See review of PR #18 for the leakage path this guards against:
  // a worker echoing a token from a log line into reply.summary
  // would otherwise be republished verbatim to the public comment.
  if (reply?.summary) {
    lines.push('');
    lines.push('**Summary**');
    lines.push('');
    lines.push(sanitizeFreeText(reply.summary, SUMMARY_MAX_CHARS));
  }

  if (reply?.validation?.length) {
    lines.push('');
    lines.push('**Validation run**');
    lines.push('');
    lines.push(formatRedactedBulletList(reply.validation));
  }

  // Per-finding accountability surfaces from the new
  // addressed[] / pushback[] reply fields. Both are optional —
  // legacy worker replies (or replies that simply didn't hit any
  // of these cases) just omit the section entirely. The renderer
  // never emits an empty header to avoid a comment full of
  // "(none reported)" placeholders for non-applicable cases.
  if (reply?.addressed?.length) {
    lines.push('');
    lines.push('**Addressed findings**');
    lines.push('');
    lines.push(formatAddressedList(reply.addressed));
  }

  if (reply?.pushback?.length) {
    lines.push('');
    lines.push('**Pushback (deliberately not changed)**');
    lines.push('');
    lines.push(formatPushbackList(reply.pushback));
  }

  if (reply?.blockers?.length) {
    lines.push('');
    lines.push('**Blockers**');
    lines.push('');
    lines.push(formatBlockersList(reply.blockers));
  }

  // Surface the actual rereview outcome (not just the worker's request bit)
  // so the comment never claims "queued" when the watcher refused the reset.
  // Possible reReview shapes (see buildRereviewResult in
  // follow-up-remediation.mjs):
  //   - requested=false                                    → no rereview
  //   - requested=true, triggered=true                     → accepted
  //   - requested=true, status='already-pending'           → benign no-op (review already coming)
  //   - requested=true, triggered=false, status='blocked'  → refused
  lines.push('');
  if (!reReview?.requested) {
    if (action === 'completed' || action === 'stopped') {
      lines.push('**Re-review requested:** no');
    }
  } else if (reReview.triggered) {
    const reasonText = reReview.reason ? sanitizeInlineText(reReview.reason, REREVIEW_REASON_MAX_CHARS) : '';
    lines.push(`**Re-review status:** queued${reasonText ? ` — ${reasonText}` : ''}`);
  } else if (reReview.status === 'already-pending') {
    const reasonText = reReview.reason ? sanitizeInlineText(reReview.reason, REREVIEW_REASON_MAX_CHARS) : '';
    lines.push(`**Re-review status:** already pending${reasonText ? ` — ${reasonText}` : ''}`);
  } else {
    const blockedReason = reReview.outcomeReason || reReview.status || 'unknown';
    const reasonText = reReview.reason ? sanitizeInlineText(reReview.reason, REREVIEW_REASON_MAX_CHARS) : '';
    lines.push(`**Re-review status:** **BLOCKED** (\`${blockedReason}\`)${reasonText ? ` — worker reason: ${reasonText}` : ''}`);
  }

  lines.push('');
  lines.push(
    `_Posted automatically by the adversarial-review remediation pipeline. Job: \`${job?.jobId || 'unknown'}\`._`
  );

  return lines.join('\n');
}

// Hard timeout on the gh subprocess. Without this, a hung GitHub API
// (network blip, auth flakiness, gh CLI getting stuck on an unexpected
// prompt) can wedge the entire reconcile tick — reconciliation is
// serialized, so one stuck post blocks every later in-progress job
// behind it. 30s is generous for a single comment post; in practice
// `gh pr comment` returns sub-second.
const GH_COMMENT_TIMEOUT_MS = 30_000;

// `gh pr comment` writes the URL of the just-created comment to
// stdout on success. Shape:
//   https://github.com/<owner>/<repo>/pull/<n>#issuecomment-<id>
// Used as a dedupe token in the posted-sidecar (R4 #2 dedupe gap):
// the retry path checks commentDelivery.commentUrl before re-posting,
// so a writeTerminalRecord-after-gh-success failure can't produce a
// duplicate public comment.
function parseCommentUrlFromStdout(stdout) {
  if (!stdout) return null;
  const match = String(stdout).match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+#issuecomment-\d+/);
  return match ? match[0] : null;
}

// Hard cap on the dedup-lookup gh-api call. The lookup runs before
// every post (initial + retry) so it must stay fast; if the API
// hangs, we'd rather post a duplicate than block reconcile.
const GH_LOOKUP_TIMEOUT_MS = 15_000;

// Dedup-check failures we must NOT treat as authoritative "no
// duplicate exists". Each one means we couldn't read the existing
// comment list — fall back to posting (best-effort), since refusing
// would leave the PR silent forever.
const DEDUP_LOOKUP_FALLTHROUGH_REASONS = new Set(['lookup-timeout', 'lookup-failure']);

// List existing PR comments and return the body marker (if any) that
// matches our remediation marker prefix. Returns:
//   { found: true,  marker, commentId? } when an existing comment
//                                         already carries this round's
//                                         marker (post must be skipped)
//   { found: false }                      when no existing comment
//                                         carries it (proceed to post)
//   { found: false, lookupFailed: true,
//     reason }                            when the lookup itself
//                                         failed; caller should fall
//                                         through to posting
//
// `gh api` is used (not `gh pr view --json comments`) because the
// pagination story is simpler and the response shape is stable
// across gh versions. `--paginate` walks every page so a chatty PR
// with > 30 comments still returns the full body list.
async function findExistingRemediationComment({
  repo,
  prNumber,
  marker,
  execFileImpl,
  env,
  log,
  timeoutMs = GH_LOOKUP_TIMEOUT_MS,
}) {
  if (!marker) return { found: false };
  try {
    const { stdout } = await execFileImpl(
      'gh',
      [
        'api',
        '--paginate',
        `repos/${repo}/issues/${encodeURIComponent(prNumber)}/comments`,
        '-q',
        '.[] | {id: .id, body: .body}',
      ],
      {
        env,
        maxBuffer: 25 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
      }
    );
    // jq's compact output emits one JSON object per line.
    const lines = String(stdout).split('\n').filter(Boolean);
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const body = entry?.body || '';
      if (body.includes(marker)) {
        return { found: true, marker, commentId: entry?.id ?? null };
      }
    }
    return { found: false };
  } catch (err) {
    if (err && err.killed === true) {
      log.error?.(
        `[pr-comments] dedup lookup timed out on ${repo}#${prNumber} after ${timeoutMs}ms — falling through to post`
      );
      return { found: false, lookupFailed: true, reason: 'lookup-timeout' };
    }
    log.error?.(
      `[pr-comments] dedup lookup failed on ${repo}#${prNumber}: ${err.message} — falling through to post`
    );
    return { found: false, lookupFailed: true, reason: 'lookup-failure', error: err.message };
  }
}

async function postRemediationOutcomeComment({
  repo,
  prNumber,
  workerClass,
  body,
  execFileImpl = execFileAsync,
  env = process.env,
  log = console,
  timeoutMs = GH_COMMENT_TIMEOUT_MS,
  // Test seam: skip the dedup lookup entirely. Production callers
  // never set this — the dedup check is the whole point of the
  // idempotency contract.
  findExistingImpl = findExistingRemediationComment,
}) {
  if (!repo || !prNumber) {
    log.error?.('[pr-comments] skipping comment: missing repo or prNumber');
    return { posted: false, reason: 'missing-pr-coordinates' };
  }

  const tokenEnvName = resolveCommentBotTokenEnv(workerClass);
  if (!tokenEnvName) {
    log.error?.(
      `[pr-comments] skipping comment: no bot-token env mapping for worker class "${workerClass}"`
    );
    return { posted: false, reason: 'no-token-mapping', workerClass };
  }

  const token = env[tokenEnvName];
  if (!token) {
    log.error?.(
      `[pr-comments] skipping comment: ${tokenEnvName} not set in env (worker class "${workerClass}")`
    );
    return { posted: false, reason: 'token-env-missing', tokenEnvName, workerClass };
  }

  // Allowlist the gh subprocess env. The daemon's parent env carries
  // unrelated high-value secrets (OP_SERVICE_ACCOUNT_TOKEN, the
  // operator's GITHUB_TOKEN, both reviewer PATs, OAuth bearers).
  // gh only needs PATH (to find its helpers) plus HOME (so it can
  // resolve its own config / cache dir) plus the GH_TOKEN we want it
  // to authenticate as. Inheriting the rest broadens blast radius if
  // gh shells out to a hook, an extension, or any unexpected helper.
  const allowlistedEnv = {
    PATH: env.PATH ?? '/usr/bin:/bin',
    HOME: env.HOME ?? '',
    GH_TOKEN: token,
  };

  // Pre-post dedup: if `gh pr comment` previously timed out AFTER
  // GitHub accepted the create, the comment landed on the PR but our
  // delivery record stayed `posted=false`. The next retry would post
  // a duplicate identical comment (review #4 of PR #18). Look for
  // our deterministic marker in existing comments first; if present,
  // skip the create and return the existing comment id.
  const marker = extractRemediationCommentMarker(body);
  if (marker) {
    const existing = await findExistingImpl({
      repo,
      prNumber,
      marker,
      execFileImpl,
      env: allowlistedEnv,
      log,
    });
    if (existing.found) {
      return {
        posted: true,
        deduped: true,
        repo,
        prNumber,
        workerClass,
        tokenEnvName,
        marker: existing.marker,
        commentId: existing.commentId ?? null,
      };
    }
    if (existing.lookupFailed && !DEDUP_LOOKUP_FALLTHROUGH_REASONS.has(existing.reason)) {
      // Defensive: if findExistingImpl ever returns a lookupFailed
      // reason we don't know about, stay loud — we'd rather log + post
      // than silently swallow an unfamiliar failure mode.
      log.error?.(`[pr-comments] dedup lookup returned unknown failure reason: ${existing.reason}`);
    }
  }

  try {
    const ghResult = await execFileImpl(
      'gh',
      ['pr', 'comment', String(prNumber), '--repo', repo, '--body', body],
      {
        env: allowlistedEnv,
        maxBuffer: 5 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
      }
    );
    // gh prints the comment URL to stdout on success. Capture it so
    // the retry path can dedupe: if a later retry sees the same record
    // with a commentUrl already populated, it knows a previous attempt
    // succeeded and must not re-post (which would create a duplicate
    // public comment).
    const commentUrl = parseCommentUrlFromStdout(ghResult?.stdout);
    return { posted: true, repo, prNumber, workerClass, tokenEnvName, commentUrl };
  } catch (err) {
    // execFile with `timeout` SIGTERMs the child when the deadline
    // expires; the resulting error has .killed === true and
    // .signal === 'SIGTERM'. Distinguish it from a generic CLI
    // failure so the retry path can decide whether to attempt again.
    if (err && err.killed === true) {
      log.error?.(
        `[pr-comments] gh pr comment timed out after ${timeoutMs}ms on ${repo}#${prNumber} (worker class "${workerClass}")`
      );
      return { posted: false, reason: 'gh-cli-timeout', timeoutMs, repo, prNumber };
    }
    log.error?.(
      `[pr-comments] failed to post comment on ${repo}#${prNumber} (worker class "${workerClass}"): ${err.message}`
    );
    return { posted: false, reason: 'gh-cli-failure', error: err.message, repo, prNumber };
  }
}

export {
  WORKER_CLASS_TO_BOT_TOKEN_ENV,
  REMEDIATION_COMMENT_MARKER_PREFIX,
  buildRemediationOutcomeCommentBody,
  buildRemediationOutcomeCommentMarker,
  extractRemediationCommentMarker,
  findExistingRemediationComment,
  parseCommentUrlFromStdout,
  postRemediationOutcomeComment,
  resolveCommentBotTokenEnv,
};
