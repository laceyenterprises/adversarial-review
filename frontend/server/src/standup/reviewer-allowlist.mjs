/**
 * The reviewer allowlist — the list of logins whose posts count as reviews.
 *
 * This is the smallest file in the harness-standup surface and the reason the
 * ticket exists. A review pipeline decides "has this PR been reviewed?" by
 * matching the *author* of a posted review against a set of authoritative
 * reviewer logins. If a harness is stood up and its bot login never reaches that
 * set, everything looks like it is working: the reviewer spawns, the review is
 * posted, the comment is on the PR — and the PR still reads as unreviewed,
 * indefinitely, because nothing ever matched. Nothing errors. There is no log
 * line. The failure is only visible as an absence.
 *
 * So allowlist wiring is a first-class, explicitly verified step of standing up
 * a harness rather than a follow-up somebody remembers, and three rules here
 * follow from the way this has actually gone wrong before:
 *
 *   1. **Match over every declared form of the login, case-insensitively.**
 *      GitHub logins are case-insensitive, a fleet accumulates naming forms for
 *      the same identity (the live account vs the legacy config spelling), and
 *      an App's posts are authored by `<slug>[bot]`, never by the bare slug. The
 *      in-OS entitlement descriptors already carry a comma-separated list of
 *      login forms per identity, and the AMA reviewer-authority table lists two
 *      spellings for every model, for exactly this reason.
 *   2. **Verification re-reads.** `verifyAllowlist` is given a state that was
 *      read back from the file, not the object the wiring step just built.
 *      Verifying the in-memory value would confirm that ARF can remember what it
 *      just decided, which is not the question.
 *   3. **A missing entry is a hard failure, never a warning.** The whole point
 *      is that the absence is otherwise invisible.
 */

export class ReviewerAllowlistError extends Error {
  constructor(message, { code = 'reviewer_allowlist' } = {}) {
    super(message);
    this.name = 'ReviewerAllowlistError';
    this.code = code;
  }
}

export const REVIEWER_ALLOWLIST_VERSION = 1;

/** An empty, well-formed allowlist document. */
export function emptyReviewerAllowlist() {
  return { version: REVIEWER_ALLOWLIST_VERSION, entries: [] };
}

/**
 * Read an allowlist document defensively.
 *
 * A file that is present but shaped wrong is an error, not an empty allowlist:
 * treating it as empty would let the wizard "wire" an entry into a document it
 * is about to overwrite, silently discarding every entry an operator (or an
 * earlier ARF) had put there.
 */
export function parseReviewerAllowlist(document, { source = 'reviewer allowlist' } = {}) {
  if (document === null || document === undefined) return emptyReviewerAllowlist();
  if (typeof document !== 'object' || Array.isArray(document)) {
    throw new ReviewerAllowlistError(`${source} must contain a JSON object`);
  }
  const entries = document.entries === undefined ? [] : document.entries;
  if (!Array.isArray(entries)) {
    throw new ReviewerAllowlistError(`${source}: "entries" must be an array`);
  }
  return {
    version: Number.isInteger(document.version) ? document.version : REVIEWER_ALLOWLIST_VERSION,
    entries: entries.map((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ReviewerAllowlistError(`${source}: entries[${index}] must be a JSON object`);
      }
      const logins = Array.isArray(entry.logins) ? entry.logins.map(String) : [];
      if (typeof entry.login !== 'string' || entry.login.trim() === '') {
        throw new ReviewerAllowlistError(`${source}: entries[${index}] has no "login"`);
      }
      return { ...entry, login: entry.login.trim(), logins };
    }),
  };
}

/** Canonical comparison key for a login: case-folded, App suffix preserved. */
export function loginKey(login) {
  return String(login).trim().toLowerCase();
}

/**
 * All the keys one entry answers to.
 *
 * The bare slug of an App identity is deliberately **not** folded in. `foo` and
 * `foo[bot]` are different accounts on GitHub, and treating an allowlisted
 * `foo[bot]` as also allowlisting `foo` would let a human account's comments be
 * counted as the App's reviews.
 */
function entryKeys(entry) {
  return new Set([entry.login, ...(entry.logins ?? [])].map(loginKey));
}

/**
 * Find the entry that would match `login`, or null.
 *
 * @param {{entries: object[]}} state
 * @param {string} login
 */
export function findAllowlistEntry(state, login) {
  const key = loginKey(login);
  return state.entries.find((entry) => entryKeys(entry).has(key)) ?? null;
}

/**
 * Add (or update) the allowlist entry for a harness. Pure: returns the next
 * document plus what changed, so the caller can persist it atomically and report
 * honestly on a re-run that changed nothing.
 *
 * @param {{version: number, entries: object[]}} state
 * @param {object} options
 * @param {string} options.login       primary posting login
 * @param {string[]} options.logins    every form this identity may post under
 * @param {string} options.harnessClass
 * @param {string} options.entitlement
 * @param {string} options.kind        identity kind (github_app | github_user)
 * @param {string} options.at          ISO timestamp
 * @param {string|null} [options.note]
 */
export function addAllowlistEntry(state, {
  login, logins, harnessClass, entitlement, kind, at, note = null,
}) {
  const primary = String(login).trim();
  if (primary === '') throw new ReviewerAllowlistError('an allowlist entry needs a login');

  const forms = [...new Set([primary, ...logins].map((value) => String(value).trim()).filter(Boolean))];

  // Collision check before the upsert: two harness classes claiming the same
  // login is a configuration mistake worth refusing, because whichever review
  // arrives will be attributed to whichever class the reader happens to look at.
  const conflicting = state.entries.find((entry) => {
    if (entry.harnessClass === harnessClass) return false;
    const keys = entryKeys(entry);
    return forms.some((form) => keys.has(loginKey(form)));
  });
  if (conflicting) {
    throw new ReviewerAllowlistError(
      `login ${JSON.stringify(primary)} is already allowlisted for harness class `
      + `${JSON.stringify(conflicting.harnessClass)}; two classes cannot share one review identity`,
      { code: 'reviewer_allowlist_conflict' },
    );
  }

  const existingIndex = state.entries.findIndex((entry) => entry.harnessClass === harnessClass);
  const previous = existingIndex >= 0 ? state.entries[existingIndex] : null;
  const next = {
    login: primary,
    logins: forms,
    harnessClass,
    entitlement,
    kind,
    note,
    addedAt: previous?.addedAt ?? at,
    updatedAt: at,
    addedBy: 'arf-harness-standup',
  };

  const unchanged = previous
    && previous.login === next.login
    && previous.logins.join('\u0000') === next.logins.join('\u0000')
    && previous.entitlement === next.entitlement
    && previous.kind === next.kind;

  const entries = [...state.entries];
  if (existingIndex >= 0) entries[existingIndex] = unchanged ? previous : next;
  else entries.push(next);

  return {
    state: { version: state.version ?? REVIEWER_ALLOWLIST_VERSION, entries },
    changed: !unchanged,
    entry: existingIndex >= 0 && unchanged ? previous : next,
  };
}

/**
 * Confirm that every login this harness may post under is allowlisted, and that
 * they all resolve to *this* harness's entry.
 *
 * Give it state read fresh from the file. A partial match is a failure: an
 * identity whose primary form is allowlisted but whose alias is not will have
 * some of its reviews counted and some not, which reads as a flaky pipeline
 * rather than as a configuration gap.
 *
 * @returns {{present: boolean, entry: object|null, missing: string[], mismatched: object[]}}
 */
export function verifyAllowlist(state, { logins, harnessClass }) {
  const missing = [];
  const mismatched = [];
  let entry = null;

  for (const login of logins) {
    const found = findAllowlistEntry(state, login);
    if (!found) {
      missing.push(login);
      continue;
    }
    if (found.harnessClass !== harnessClass) {
      mismatched.push({ login, allowlistedFor: found.harnessClass });
      continue;
    }
    entry = entry ?? found;
  }

  return {
    present: missing.length === 0 && mismatched.length === 0 && entry !== null,
    entry,
    missing,
    mismatched,
  };
}

/**
 * Explain a failed verification in terms an operator can act on.
 *
 * Written out rather than left to a generic "verification failed" because the
 * two failure modes have different fixes, and because this message is the one
 * thing standing between an operator and weeks of silently uncounted reviews.
 */
export function describeVerificationFailure({ missing, mismatched }, { path }) {
  const parts = [];
  if (missing.length > 0) {
    parts.push(
      `${missing.map((login) => JSON.stringify(login)).join(', ')} `
      + `${missing.length === 1 ? 'is' : 'are'} not in the reviewer allowlist at ${path}`,
    );
  }
  for (const entry of mismatched) {
    parts.push(
      `${JSON.stringify(entry.login)} is allowlisted for harness class `
      + `${JSON.stringify(entry.allowlistedFor)}`,
    );
  }
  return `${parts.join('; ')}. Reviews posted by an un-allowlisted login are not counted as `
    + 'reviews — the PR reads as unreviewed with no error anywhere.';
}
