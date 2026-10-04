import { isNoneFindingsSentinelOnly, parseBlockingFindingsSection, parseNonBlockingFindingsSection } from './review-findings.mjs';
/**
 * @typedef {import('./contracts.js').RemediationReply} RemediationReply
 */

const REMEDIATION_REPLY_SCHEMA_VERSION = 1;
const REMEDIATION_REPLY_KIND = 'adversarial-review-remediation-reply';
const PUBLIC_REPLY_MAX_CHARS = 1200;
const OPERATIONAL_BLOCKER_TITLES = new Set([
  'branch-contamination',
  'branch-contamination-audit-error',
  'base-branch-resolution-failed',
  'stale-pr-head',
  'push-lease-rejected',
  'fetch-failed',
  'rebase-conflict',
  'missing-auth',
  'auth-failure',
]);
// Structured operational-blocker kinds (COMMENTCLOSE-01). A reconciler may act on
// `kind`; it never infers one from the worker's free-text title or finding.
const OPERATIONAL_BLOCKER_KIND_PENDING_CI = 'pending-ci';
const OPERATIONAL_BLOCKER_KINDS = new Set([OPERATIONAL_BLOCKER_KIND_PENDING_CI]);

// prefix patterns (`/^Replace (this )?with\b/i`, `/^Optional list of
// files\b/i`) that produced false positives on legitimate review
// language — a real finding like "Replace this regex; it can backtrack
// exponentially" or a real action like "Replace with parameterized
// queries" would hard-fail validation and stop the remediation round
// as `invalid-remediation-reply`. The exact-string set below covers the
// strings the current template (`src/follow-up-remediation.mjs`)
// emits, plus historical placeholders that earlier prompt versions
// included in the contract example so a worker pulling a stale template
// still gets caught. Whitespace at either end is trimmed before
// comparison; otherwise the match is byte-exact.
const PLACEHOLDER_EXACT_STRINGS = new Set([
  // Current prompt placeholders.
  'Replace this with a short remediation summary.',
  'Replace with validation you ran.',
  // Historical per-finding placeholders from earlier prompt versions
  // (commit c74eeb6 era). Workers that reused a stale template
  // could still emit these.
  'Replace with the review finding this entry addresses.',
  'Replace with what you did to address it.',
  'Optional list of files changed for this finding.',
  'Replace with a finding you deliberately did NOT change the code on.',
  'Replace with a finding you deliberately did NOT change the code on. Remove this entry entirely if you addressed everything.',
  'Replace with one sharp sentence on why you disagreed.',
  'Replace with the reason this P' + 'R should receive another adversarial review pass.',
]);

function assertNoPlaceholderText(value, locationLabel) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (!trimmed) return;
  if (PLACEHOLDER_EXACT_STRINGS.has(trimmed)) {
    throw new Error(
      `Remediation reply ${locationLabel} contains placeholder/example text ` +
        `from the prompt template; replace it with real content before submitting`
    );
  }
}

function validateStringArrayField(items, fieldName) {
  if (!Array.isArray(items)) {
    throw new Error(`Remediation reply ${fieldName} must be an array`);
  }

  items.forEach((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`Remediation reply ${fieldName}[${index}] must be a non-empty string`);
    }
    assertNoPlaceholderText(item, `${fieldName}[${index}]`);
  });
}

function validateOptionalTitle(entry, fieldName) {
  if (entry.title === undefined) return;
  if (typeof entry.title !== 'string' || !entry.title.trim()) {
    throw new Error(`Remediation reply ${fieldName}.title must be a non-empty string when provided`);
  }
  assertNoPlaceholderText(entry.title, `${fieldName}.title`);
}

function normalizeOperationalBlockerTitle(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[\s_]+/g, '-');
}

const PUBLIC_REPLY_NOISE_SIGNALS = Object.freeze([
  { label: 'JSON-like dump at start of field', pattern: /^\s*(?:\{|\[)\s*["{\[]/ },
  { label: 'fenced code block', pattern: /^\s*```/m },
  { label: 'tool call/result markup', pattern: /<tool_(?:call|result)\b/i },
  { label: 'git diff header', pattern: /^diff --git\b/m },
  { label: 'diff hunk header', pattern: /^@@\s/m },
  { label: 'token-count transcript header', pattern: /Original token count:/ },
  { label: 'python traceback header', pattern: /^Traceback \(most recent call last\):/m },
]);
const PUBLIC_REPLY_MAX_LINES = 20;

function detectPublicReplyNoiseSignal(value) {
  const text = String(value ?? '');
  for (const signal of PUBLIC_REPLY_NOISE_SIGNALS) {
    if (signal.pattern.test(text)) return signal.label;
  }

  // A single prose line that begins with "stdout:" or "stderr:" is
  // ambiguous enough to allow; paired prefixes are a much stronger
  // signal that the worker pasted command output.
  if (/^\s*stdout\s*:/im.test(text) && /^\s*stderr\s*:/im.test(text)) {
    return 'paired stdout/stderr log prefixes';
  }

  return null;
}

function assertPublicReplyTextQuality(value, locationLabel, { publicCommentLabel = 'public reply' } = {}) {
  if (typeof value !== 'string') return;
  const text = value.trim();
  if (!text) return;
  if (text.length > PUBLIC_REPLY_MAX_CHARS) {
    throw new Error(
      `Remediation reply ${locationLabel} is too long for the ${publicCommentLabel}; ` +
        `summarize it instead of dumping raw output`
    );
  }
  const nonEmptyLineCount = text.split(/\r?\n/).filter((line) => line.trim()).length;
  if (nonEmptyLineCount > PUBLIC_REPLY_MAX_LINES) {
    throw new Error(
      `Remediation reply ${locationLabel} has too many lines for the ${publicCommentLabel}; ` +
        `summarize it instead of dumping raw output`
    );
  }
  const noiseSignal = detectPublicReplyNoiseSignal(text);
  if (noiseSignal) {
    throw new Error(
      `Remediation reply ${locationLabel} looks like raw logs, JSON, diff, or tool output ` +
        `(${noiseSignal}); ` +
        `write a human summary instead`
    );
  }
}

// addressed[] entries are { title?, finding, action, files? } where files is
// an optional array of strings (the worker can list paths it touched
// while addressing the finding). Per-entry validation rejects a
// missing or empty finding/action so the public reply never
// renders an empty bullet, but tolerates files being absent.
function validateAddressedShapeField(items, fieldName, options = {}) {
  if (!Array.isArray(items)) {
    throw new Error(`Remediation reply ${fieldName} must be an array`);
  }
  items.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Remediation reply ${fieldName}[${index}] must be an object`);
    }
    if (typeof entry.finding !== 'string' || !entry.finding.trim()) {
      throw new Error(`Remediation reply ${fieldName}[${index}].finding must be a non-empty string`);
    }
    if (typeof entry.action !== 'string' || !entry.action.trim()) {
      throw new Error(`Remediation reply ${fieldName}[${index}].action must be a non-empty string`);
    }
    validateOptionalTitle(entry, `${fieldName}[${index}]`);
    assertNoPlaceholderText(entry.finding, `${fieldName}[${index}].finding`);
    assertNoPlaceholderText(entry.action, `${fieldName}[${index}].action`);
    assertPublicReplyTextQuality(entry.finding, `${fieldName}[${index}].finding`, options);
    assertPublicReplyTextQuality(entry.action, `${fieldName}[${index}].action`, options);
    if (entry.files !== undefined) {
      if (!Array.isArray(entry.files)) {
        throw new Error(`Remediation reply ${fieldName}[${index}].files must be an array if provided`);
      }
      entry.files.forEach((f, fi) => {
        if (typeof f !== 'string' || !f.trim()) {
          throw new Error(`Remediation reply ${fieldName}[${index}].files[${fi}] must be a non-empty string`);
        }
        assertNoPlaceholderText(f, `${fieldName}[${index}].files[${fi}]`);
      });
    }
  });
}

function validateAddressedField(items, options = {}) {
  validateAddressedShapeField(items, 'addressed', options);
}

// nonBlocking[] entries share the addressed[] shape but cover
// non-blocking review findings. The blocking-coverage check ignores
// them entirely; they exist as a structured place for the worker to
// record non-blocking fixes without inflating the blocking-only arrays.
function validateNonBlockingField(items, options = {}) {
  validateAddressedShapeField(items, 'nonBlocking', options);
}

// hardening[] entries share the addressed[] shape but cover related
// defects the worker found ITSELF while remediating -- findings the
// reviewer never raised. Like nonBlocking[], the blocking-coverage check
// ignores them entirely. They are a separate array rather than a flavour
// of nonBlocking[] because provenance is the whole point: nonBlocking[]
// is work the review asked for, hardening[] is work the review never saw.
function validateHardeningField(items, options = {}) {
  validateAddressedShapeField(items, 'hardening', options);
}

// pushback[] entries are { title?, finding, reasoning }. Finding and
// reasoning are required and non-empty. This is the slot for "I read
// the finding, decided not to change the code, here's why." Distinct
// from blockers (hard exit) and addressed (fix applied).
function validatePushbackField(items, options = {}) {
  if (!Array.isArray(items)) {
    throw new Error('Remediation reply pushback must be an array');
  }
  items.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Remediation reply pushback[${index}] must be an object`);
    }
    if (typeof entry.finding !== 'string' || !entry.finding.trim()) {
      throw new Error(`Remediation reply pushback[${index}].finding must be a non-empty string`);
    }
    if (typeof entry.reasoning !== 'string' || !entry.reasoning.trim()) {
      throw new Error(`Remediation reply pushback[${index}].reasoning must be a non-empty string`);
    }
    validateOptionalTitle(entry, `pushback[${index}]`);
    assertNoPlaceholderText(entry.finding, `pushback[${index}].finding`);
    assertNoPlaceholderText(entry.reasoning, `pushback[${index}].reasoning`);
    assertPublicReplyTextQuality(entry.finding, `pushback[${index}].finding`, options);
    assertPublicReplyTextQuality(entry.reasoning, `pushback[${index}].reasoning`, options);
  });
}

// blockers[] entries are EITHER:
//   - structured object: { title?, finding, reasoning?, needsHumanInput? }
//     `finding` always required, plus at least one of `reasoning` or
//     `needsHumanInput` (both can be present). The structured form
//     ties each blocker back to the originating review finding so the
//     next human reading the public reply can identify exactly
//     which item is unresolved.
//   - legacy non-empty string: free-text blocker description.
//     Predates the structured contract. The renderer in
//     `adapters/comms/github-pr-comments/pr-comments.mjs` already handles strings; the
//     validator must also accept them under `schemaVersion: 1` so
//     previously-persisted reply artifacts (re-read during
//     reconciliation and comment recovery) do not become invalid data
//     after deploy. Keeping `schemaVersion: 1` backward-compatible
//     here is the cheaper of the two paths the reviewer flagged
//     (versus bumping to v2 + branched validation + migration tests).
function validateBlockersField(items, options = {}) {
  if (!Array.isArray(items)) {
    throw new Error('Remediation reply blockers must be an array');
  }
  items.forEach((entry, index) => {
    if (typeof entry === 'string') {
      if (!entry.trim()) {
        throw new Error(`Remediation reply blockers[${index}] must be a non-empty string`);
      }
      assertNoPlaceholderText(entry, `blockers[${index}]`);
      assertPublicReplyTextQuality(entry, `blockers[${index}]`, options);
      return;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Remediation reply blockers[${index}] must be a non-empty string or an object`);
    }
    if (typeof entry.finding !== 'string' || !entry.finding.trim()) {
      throw new Error(`Remediation reply blockers[${index}].finding must be a non-empty string`);
    }
    validateOptionalTitle(entry, `blockers[${index}]`);
    const hasReasoning = typeof entry.reasoning === 'string' && entry.reasoning.trim();
    const hasNeedsHumanInput = typeof entry.needsHumanInput === 'string' && entry.needsHumanInput.trim();
    if (!hasReasoning && !hasNeedsHumanInput) {
      throw new Error(
        `Remediation reply blockers[${index}] must include a non-empty reasoning or needsHumanInput field`
      );
    }
    if (entry.reasoning !== undefined && !hasReasoning) {
      throw new Error(`Remediation reply blockers[${index}].reasoning must be a non-empty string when provided`);
    }
    if (entry.needsHumanInput !== undefined && !hasNeedsHumanInput) {
      throw new Error(`Remediation reply blockers[${index}].needsHumanInput must be a non-empty string when provided`);
    }
    assertNoPlaceholderText(entry.finding, `blockers[${index}].finding`);
    assertPublicReplyTextQuality(entry.finding, `blockers[${index}].finding`, options);
    if (hasReasoning) {
      assertNoPlaceholderText(entry.reasoning, `blockers[${index}].reasoning`);
      assertPublicReplyTextQuality(entry.reasoning, `blockers[${index}].reasoning`, options);
    }
    if (hasNeedsHumanInput) {
      assertNoPlaceholderText(entry.needsHumanInput, `blockers[${index}].needsHumanInput`);
      assertPublicReplyTextQuality(entry.needsHumanInput, `blockers[${index}].needsHumanInput`, options);
    }
  });
}

function validateOperationalBlockersField(items, options = {}) {
  if (!Array.isArray(items)) {
    throw new Error('Remediation reply operationalBlockers must be an array');
  }
  items.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Remediation reply operationalBlockers[${index}] must be an object`);
    }
    if (typeof entry.finding !== 'string' || !entry.finding.trim()) {
      throw new Error(`Remediation reply operationalBlockers[${index}].finding must be a non-empty string`);
    }
    validateOptionalTitle(entry, `operationalBlockers[${index}]`);
    if (entry.kind !== undefined && !OPERATIONAL_BLOCKER_KINDS.has(entry.kind)) {
      throw new Error(
        `Remediation reply operationalBlockers[${index}].kind must be one of: ${[...OPERATIONAL_BLOCKER_KINDS].join(', ')}`
      );
    }
    const hasReasoning = typeof entry.reasoning === 'string' && entry.reasoning.trim();
    const hasNeedsHumanInput = typeof entry.needsHumanInput === 'string' && entry.needsHumanInput.trim();
    if (!hasReasoning && !hasNeedsHumanInput) {
      throw new Error(
        `Remediation reply operationalBlockers[${index}] must include a non-empty reasoning or needsHumanInput field`
      );
    }
    if (entry.reasoning !== undefined && !hasReasoning) {
      throw new Error(
        `Remediation reply operationalBlockers[${index}].reasoning must be a non-empty string when provided`
      );
    }
    if (entry.needsHumanInput !== undefined && !hasNeedsHumanInput) {
      throw new Error(
        `Remediation reply operationalBlockers[${index}].needsHumanInput must be a non-empty string when provided`
      );
    }
    assertNoPlaceholderText(entry.finding, `operationalBlockers[${index}].finding`);
    assertPublicReplyTextQuality(entry.finding, `operationalBlockers[${index}].finding`, options);
    if (hasReasoning) {
      assertNoPlaceholderText(entry.reasoning, `operationalBlockers[${index}].reasoning`);
      assertPublicReplyTextQuality(entry.reasoning, `operationalBlockers[${index}].reasoning`, options);
    }
    if (hasNeedsHumanInput) {
      assertNoPlaceholderText(entry.needsHumanInput, `operationalBlockers[${index}].needsHumanInput`);
      assertPublicReplyTextQuality(entry.needsHumanInput, `operationalBlockers[${index}].needsHumanInput`, options);
    }
  });
}

function isOperationalBlockerEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const title = normalizeOperationalBlockerTitle(entry.title);
  return OPERATIONAL_BLOCKER_TITLES.has(title);
}

function normalizeOperationalBlockers(reply, { expectedJob = null } = {}) {
  if (!Array.isArray(reply.blockers)) return reply;
  if (reply.operationalBlockers !== undefined && !Array.isArray(reply.operationalBlockers)) return reply;

  const expectedFindingTitleKeys = new Set(
    (parseBlockingFindingsSection(expectedJob?.reviewBody) || [])
      .map((finding) => normalizeCoverageTitle(finding?.title))
      .filter(Boolean)
  );
  const blockers = reply.blockers;
  const operational = Array.isArray(reply.operationalBlockers)
    ? [...reply.operationalBlockers]
    : [];
  const keptBlockers = [];
  let moved = false;

  for (const [index, blocker] of blockers.entries()) {
    if (isOperationalBlockerEntry(blocker)) {
      const titleKey = normalizeCoverageTitle(blocker.title);
      if (titleKey && expectedFindingTitleKeys.has(titleKey)) {
        throw new Error(
          `Remediation reply blockers[${index}].title matches both a known operational blocker title and ` +
            `a blocking review finding title. Keep it in blockers[] or move it to operationalBlockers[] ` +
            `explicitly so validation does not silently relocate it.`
        );
      }
      operational.push(blocker);
      moved = true;
    } else {
      keptBlockers.push(blocker);
    }
  }

  if (!moved) return reply;
  return {
    ...reply,
    blockers: keptBlockers,
    operationalBlockers: operational,
  };
}

function normalizeCoverageTitle(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

/**
 * Extract the normalized non-blocking finding identities (titles) from a review
 * body. Returns `null` when the body has no parseable non-blocking section
 * (fail-closed: the AMA coverage gate treats a `null` identity list as
 * "identities unknown" and refuses to waive). Returns `[]` for a present but
 * empty (`- None.`) section. Identity normalization reuses
 * `normalizeCoverageTitle` so the parsed review identities match the HAM
 * addressed-finding titles byte-for-byte under the same normalization.
 *
 * @param {string} reviewBody
 * @returns {string[]|null}
 */
function extractNonBlockingFindingIdentities(reviewBody) {
  const parsed = parseNonBlockingFindingsSection(reviewBody);
  if (parsed === null) return null;
  return parsed
    .map((finding) => normalizeCoverageTitle(finding?.title))
    .filter(Boolean);
}

function usesPerFindingReplyContract(reply) {
  if (!reply || typeof reply !== 'object') return false;
  // nonBlocking[] qualifies as a new-schema signal even when the worker
  // emitted ONLY nonBlocking[] (no addressed/pushback/blockers). That's
  // intentional: a reply that ships non-blocking polish while leaving
  // every blocking finding unaccounted-for is the exact failure shape
  // we want validateBlockingCoverage to reject loudly. Letting an empty
  // addressed[] silently fall back to the legacy contract would mask
  // that bug.
  if (
    reply.addressed !== undefined
    || reply.pushback !== undefined
    || reply.nonBlocking !== undefined
    || reply.hardening !== undefined
    || reply.operationalBlockers !== undefined
  ) {
    return true;
  }

  return Array.isArray(reply.blockers) && reply.blockers.some(
    (entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  );
}

// Enforce that the reply records the same number of accountability
// entries as there are blocking findings in the review body, summed
// across `addressed[]`, `pushback[]`, and `blockers[]`. Without this
// the reviewer prompt's per-finding contract is documentation-only — a worker
// can omit findings entirely, claim rereview readiness on a subset of
// the review, and the public reply becomes a misleading durable
// record.
//
// Limit of this check (deliberate, documented): it validates count
// only. It does NOT verify that the worker's free-form `finding`
// strings semantically correspond to the parsed review findings — a
// worker could submit N arbitrary strings and pass. Closing that gap
// requires a richer schema where the worker references findings by
// stable IDs the template provides; that is a future schema bump
// (tracked as a known follow-up). Free-form-text uniqueness was
// previously enforced here but removed because it rejected legitimate
// replies in which two distinct review findings (e.g. the same bug in
// two files) collapsed to the same paraphrase, with no benefit since
// distinct strings are not the same as correct strings.
//
// Backward-compat: enforced only when the reply opts into the new
// schema (signaled by `addressed[]`, `pushback[]`, or structured
// blocker objects) AND we can confidently parse the review body's
// blocking section. Legacy replies (string-array blockers, no
// addressed/pushback) skip the check so re-reading old persisted
// artifacts doesn't fail.
function validateBlockingCoverage(reply, expectedJob) {
  if (!expectedJob || typeof expectedJob !== 'object') return;
  const usesNewSchema = usesPerFindingReplyContract(reply);
  if (!usesNewSchema) return;

  const findings = parseBlockingFindingsSection(expectedJob.reviewBody);
  if (findings === null || findings.length === 0) return;
  const expected = findings.length;
  const nonBlockingTitleKeys = new Set(
    (parseNonBlockingFindingsSection(expectedJob.reviewBody) || [])
      .map((finding) => normalizeCoverageTitle(finding?.title))
      .filter(Boolean)
  );
  const blockingTitleKeys = new Set(
    findings
      .map((finding) => normalizeCoverageTitle(finding?.title))
      .filter(Boolean)
  );

  const addressed = Array.isArray(reply.addressed) ? reply.addressed : [];
  const pushback = Array.isArray(reply.pushback) ? reply.pushback : [];
  const blockers = Array.isArray(reply.blockers) ? reply.blockers : [];
  const operationalBlockers = Array.isArray(reply.operationalBlockers)
    ? reply.operationalBlockers
    : [];

  if (
    operationalBlockers.length > 0
    && addressed.length === 0
    && pushback.length === 0
    && blockers.length === 0
  ) {
    return;
  }
  const total = addressed.length + pushback.length + blockers.length;
  const actualEntries = [
    ...addressed.map((entry, index) => ({ field: 'addressed', index, entry })),
    ...pushback.map((entry, index) => ({ field: 'pushback', index, entry })),
    ...blockers.map((entry, index) => ({ field: 'blockers', index, entry })),
  ];
  const nonBlockingExtras = addressed
    .map((entry, index) => ({ field: 'addressed', index, entry }))
    .filter(({ entry }) => {
      const key = normalizeCoverageTitle(entry?.title);
      return key && nonBlockingTitleKeys.has(key) && !blockingTitleKeys.has(key);
    });
  const blockingEntryTotal = total - nonBlockingExtras.length;

  if (blockingEntryTotal !== expected) {
    throw new Error(
      `Remediation reply does not account for every blocking finding: ` +
        `review has ${expected} blocking issue(s), reply records ${blockingEntryTotal} ` +
        `(addressed=${addressed.length}, pushback=${pushback.length}, blockers=${blockers.length}). ` +
        `Each blocking issue must appear exactly once across addressed[], pushback[], or blockers[]. ` +
        `If you fixed non-blocking findings too, put them in nonBlocking[] (not addressed[]).`
    );
  }

  const expectedTitleEntries = findings
    .map((finding) => ({
      raw: typeof finding.title === 'string' ? finding.title.trim() : '',
      key: normalizeCoverageTitle(finding.title),
    }))
    .filter((entry) => entry.key);
  const titledExpected = expectedTitleEntries.map((entry) => entry.key);
  if (!titledExpected.length) return;

  const expectedCounts = new Map();
  const expectedDisplay = new Map();
  for (const { key, raw } of expectedTitleEntries) {
    expectedCounts.set(key, (expectedCounts.get(key) || 0) + 1);
    if (!expectedDisplay.has(key)) expectedDisplay.set(key, raw);
  }
  const actualCounts = new Map();
  const actualDisplay = new Map();
  for (const { entry } of actualEntries) {
    const raw = typeof entry?.title === 'string' ? entry.title.trim() : '';
    const key = normalizeCoverageTitle(raw);
    if (!key) continue;
    actualCounts.set(key, (actualCounts.get(key) || 0) + 1);
    if (!actualDisplay.has(key)) actualDisplay.set(key, raw);
  }

  if (titledExpected.length === findings.length) {
    const untitled = actualEntries.find(({ entry }) => (
      !entry || typeof entry !== 'object' || Array.isArray(entry) || !normalizeCoverageTitle(entry.title)
    ));
    if (untitled) {
      if (typeof untitled.entry === 'string') {
        throw new Error(
          `Remediation reply blockers[${untitled.index}] is a string; when the adversarial review ` +
            `supplies a title for every blocking finding via bold bullet titles, H3 headings, or legacy Title fields, ` +
            `blockers entries must be objects with a non-empty title`
        );
      }
      throw new Error(
        `Remediation reply ${untitled.field}[${untitled.index}].title is required because ` +
          `the adversarial review supplied titles via bold bullet titles, H3 headings, or legacy Title fields`
      );
    }
  }

  const missing = [];
  const extra = [];
  const misplacedNonBlocking = new Set();
  const allExpectedFindingsTitled = titledExpected.length === findings.length;
  for (const { field, entry } of actualEntries) {
    const key = normalizeCoverageTitle(entry?.title);
    if (!key) continue;
    if (field !== 'addressed' && nonBlockingTitleKeys.has(key) && !blockingTitleKeys.has(key)) {
      misplacedNonBlocking.add(actualDisplay.get(key) || String(entry?.title || key).trim() || key);
    }
  }
  for (const [key, count] of expectedCounts.entries()) {
    const actual = actualCounts.get(key) || 0;
    if (actual < count) missing.push(expectedDisplay.get(key) || key);
  }
  for (const [key, count] of actualCounts.entries()) {
    const expectedCount = expectedCounts.get(key) || 0;
    if (
      (expectedCount === 0 && !nonBlockingTitleKeys.has(key))
      || (allExpectedFindingsTitled && count > expectedCount && !nonBlockingTitleKeys.has(key))
    ) {
      extra.push(actualDisplay.get(key) || key);
    }
  }
  for (const title of misplacedNonBlocking) extra.push(title);
  if (missing.length || extra.length) {
    throw new Error(
      `Remediation reply titles must match the blocking review bold bullet titles, H3 headings, or legacy Title fields exactly. ` +
        `Missing: ${missing.length ? missing.join('; ') : 'none'}. ` +
        `Unexpected: ${extra.length ? extra.join('; ') : 'none'}.`
    );
  }
}

/**
 * @param {unknown} reply
 * @returns {RemediationReply}
 */
function validateRemediationReply(reply, { expectedJob = null, publicCommentLabel = 'public reply' } = {}) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
    throw new Error('Remediation reply must be a JSON object');
  }

  if (reply.kind !== REMEDIATION_REPLY_KIND) {
    throw new Error(`Remediation reply kind must be ${REMEDIATION_REPLY_KIND}`);
  }

  if (reply.schemaVersion !== REMEDIATION_REPLY_SCHEMA_VERSION) {
    throw new Error(`Unsupported remediation reply schemaVersion: ${reply.schemaVersion}`);
  }
  reply = normalizeOperationalBlockers(reply, { expectedJob });

  if (typeof reply.jobId !== 'string' || !reply.jobId.trim()) {
    throw new Error('Remediation reply jobId is required');
  }

  if (typeof reply.summary !== 'string' || !reply.summary.trim()) {
    throw new Error('Remediation reply summary is required');
  }
  assertNoPlaceholderText(reply.summary, 'summary');

  const allowedOutcomes = new Set(['completed', 'blocked', 'partial']);
  if (!allowedOutcomes.has(reply.outcome)) {
    throw new Error(`Remediation reply outcome must be one of: ${Array.from(allowedOutcomes).join(', ')}`);
  }

  validateStringArrayField(reply.validation, 'validation');
  const publicReplyOptions = { publicCommentLabel };

  validateBlockersField(reply.blockers, publicReplyOptions);
  if (reply.operationalBlockers !== undefined) {
    validateOperationalBlockersField(reply.operationalBlockers, publicReplyOptions);
  }

  // addressed[] / pushback[] / nonBlocking[] are additive — replies
  // that omit them entirely are still valid (legacy worker output, jobs
  // created before this schema landed). Only validate shape when the
  // fields are present. Workers that emit them get strict enforcement
  // so a half-formed entry never reaches the public reply renderer.
  if (reply.addressed !== undefined) {
    validateAddressedField(reply.addressed, publicReplyOptions);
  }
  if (reply.pushback !== undefined) {
    validatePushbackField(reply.pushback, publicReplyOptions);
  }
  if (reply.nonBlocking !== undefined) {
    validateNonBlockingField(reply.nonBlocking, publicReplyOptions);
  }
  if (reply.hardening !== undefined) {
    validateHardeningField(reply.hardening, publicReplyOptions);
  }

  if (!reply.reReview || typeof reply.reReview !== 'object' || Array.isArray(reply.reReview)) {
    throw new Error('Remediation reply reReview must be an object');
  }

  if (typeof reply.reReview.requested !== 'boolean') {
    throw new Error('Remediation reply reReview.requested must be a boolean');
  }

  if (reply.reReview.requested && (typeof reply.reReview.reason !== 'string' || !reply.reReview.reason.trim())) {
    throw new Error('Remediation reply reReview.reason is required when reReview.requested is true');
  }

  if (reply.reReview.requested) {
    assertNoPlaceholderText(reply.reReview.reason, 'reReview.reason');
  }

  // Cross-field semantic invariants. Without these the template's hard
  // contract ("populate blockers → set reReview.requested = false")
  // is documentation-only — a contradictory reply slips into
  // reconciliation and corrupts queue state (e.g. `outcome: blocked`
  // with `reReview.requested = true` re-arms the watcher AND posts a
  // public reply claiming both "human intervention required" and
  // "re-review queued" for the same unresolved state).
  const usesNewSchema = usesPerFindingReplyContract(reply);
  const blockersPopulated = reply.blockers.length > 0;
  const operationalBlockersPopulated = Array.isArray(reply.operationalBlockers)
    && reply.operationalBlockers.length > 0;

  if (usesNewSchema && (blockersPopulated || operationalBlockersPopulated) && reply.reReview.requested) {
    throw new Error(
      'Remediation reply contradicts itself: blockers are populated but reReview.requested is true. ' +
        'A populated blockers or operationalBlockers list is a hard exit; set reReview.requested = false.'
    );
  }

  if (usesNewSchema && reply.outcome === 'blocked') {
    if (!blockersPopulated && !operationalBlockersPopulated) {
      throw new Error(
        'Remediation reply outcome is "blocked" but blockers and operationalBlockers are empty. ' +
          'A blocked outcome must list the unresolved blockers.'
      );
    }
    if (reply.reReview.requested) {
      throw new Error(
        'Remediation reply outcome is "blocked" but reReview.requested is true. ' +
          'A blocked outcome must set reReview.requested = false.'
      );
    }
  }

  if (usesNewSchema && reply.outcome === 'completed' && (blockersPopulated || operationalBlockersPopulated)) {
    throw new Error(
      'Remediation reply outcome is "completed" but blockers or operationalBlockers is non-empty. ' +
        'Use outcome "partial" or "blocked" when unresolved blockers remain.'
    );
  }

  if (expectedJob) {
    if (reply.jobId !== expectedJob.jobId) {
      throw new Error(`Remediation reply jobId mismatch: expected ${expectedJob.jobId}, got ${reply.jobId}`);
    }

    validateBlockingCoverage(reply, expectedJob);
  }

  return reply;
}

// Called only after strict reply validation. Preserve the worker's evidence while
// removing CI scheduling state from the loop's operational-blocker decision.
function normalizeCiPendingOnlyReply(reply, { expectedJob = null } = {}) {
  const operational = reply.operationalBlockers;
  if (!Array.isArray(operational) || !operational.length || reply.blockers.length) return reply;
  const isPending = (entry) => {
    const title = String(entry.title || '').trim().toLowerCase();
    if (OPERATIONAL_BLOCKER_TITLES.has(title)) return false;
    if (/contamination|stale.{0,15}head|lease.{0,15}reject|auth.{0,15}(?:fail|missing)|(?:fetch|rebase|push).{0,15}(?:fail|reject|conflict)/i.test(entry.finding)) return false;
    return ['ci-pending', 'pending-ci', 'pr-head-ci-pending'].includes(title)
      || /\b(?:checks?|ci|repo-guards)\b[^.]*\b(?:pending|queued|in[ -]progress)\b/i.test(entry.finding)
      || /\bin[ -]progress after (?:the )?bounded CI wait\b/i.test(entry.finding);
  };
  if (!operational.every(isPending)) return reply;
  // Require an affirmative push report with a commit ID, not merely a local
  // commit or a plan to push. Existing remote-head and contamination gates
  // still run before the durable re-review request is accepted.
  const evidence = [reply.summary, ...reply.validation].join('\n');
  const pushed = evidence.match(/\bpushed (?:commit |PR head (?:is )?)?([a-f0-9]{7,40})\b/i);
  if (!pushed || [expectedJob?.revisionRef, expectedJob?.headSha]
    .some((head) => typeof head === 'string' && head.startsWith(pushed[1]))) return reply;
  return {
    ...reply,
    outcome: 'completed',
    operationalBlockers: [],
    reReview: {
      ...reply.reReview,
      requested: true,
      reason: 'Remediation fix pushed; external CI readiness remains gated before re-review.',
      normalizedFrom: 'ci-pending-only',
      originalOperationalBlockers: operational,
    },
  };
}

/**
 * @param {string} raw
 * @returns {RemediationReply}
 */
function parseRemediationReply(raw, options = {}) {
  return validateRemediationReply(JSON.parse(raw), options);
}

export {
  OPERATIONAL_BLOCKER_KIND_PENDING_CI,
  PUBLIC_REPLY_MAX_CHARS,
  REMEDIATION_REPLY_KIND,
  REMEDIATION_REPLY_SCHEMA_VERSION,
  assertNoPlaceholderText,
  detectPublicReplyNoiseSignal,
  extractNonBlockingFindingIdentities,
  isNoneFindingsSentinelOnly,
  isOperationalBlockerEntry as isDeclaredOperationalBlockerCode,
  normalizeCoverageTitle,
  normalizeCiPendingOnlyReply,
  parseBlockingFindingsSection,
  parseNonBlockingFindingsSection,
  parseRemediationReply,
  validateRemediationReply,
};
