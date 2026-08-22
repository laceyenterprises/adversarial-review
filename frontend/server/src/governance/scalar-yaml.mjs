/**
 * A deliberately tiny, deliberately incomplete YAML reader (ARF-04).
 *
 * ARF has zero npm dependencies, and the governance keys it must report live in
 * the pipeline's YAML config files. Those keys are all plain scalars nested in
 * plain mappings — `roles.adversarial.merge_authority.autonomous_merge_execution_enabled: true`
 * and friends — so a full YAML implementation is not needed to read them.
 *
 * What IS needed is that a construct this reader does not understand can never
 * produce a *wrong* value for a governance key. A governance panel that reports
 * `armed` because it misparsed an indentation level is worse than one that
 * reports `unknown`, so the contract here is:
 *
 *   **every leaf is either a scalar this reader is confident about, or it is
 *   absent and its subtree is listed in `refusals`.**
 *
 * Anything outside the subset — sequences, flow collections, block scalars,
 * anchors/aliases/tags, tab indentation, multi-document streams — marks the
 * subtree it appears in as refused and drops every value under it. The caller
 * turns a refused (or simply absent) key into `unknown`, which
 * `merge-paths.mjs` is required to treat as "not proven armed AND not proven
 * disarmed".
 *
 * This is not a general-purpose parser and must not become one. If ARF ever
 * needs to read a list or a nested structure out of pipeline YAML, that is the
 * moment to reach for a real parser rather than to grow this one — a
 * half-complete YAML reader that people trust is exactly how a panel starts
 * lying.
 */

/** Keys this reader accepts unquoted. Anything else refuses its subtree. */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** `key:` or `key: value`, with the value (if any) captured raw. */
const MAPPING_LINE = /^([^\s#][^:]*?)\s*:(?:\s+(.*))?$/;

/** A block scalar header: `|`, `>`, with optional chomping/indent indicators. */
const BLOCK_SCALAR = /^[|>][+-]?\d*$/;

/** Constructs whose meaning depends on state this reader does not track. */
const UNSUPPORTED_VALUE_PREFIX = ['&', '*', '!'];

class ScalarYamlDocument {
  constructor({ values, refusals, fatal }) {
    this.values = values;
    this.refusals = refusals;
    /** Non-null when the whole document is untrustworthy (e.g. tab indentation). */
    this.fatal = fatal;
  }

  /**
   * The value at a dotted path, or `undefined` when this reader cannot vouch
   * for it. `undefined` covers three distinct cases on purpose — absent,
   * refused, and fatally-unparseable — because the caller's answer for all
   * three is the same: unknown. `refusalFor()` tells them apart for reporting.
   */
  get(dotted) {
    if (this.fatal) return undefined;
    return this.values.get(dotted);
  }

  /** Why `get(dotted)` declined, or null when it simply was not present. */
  refusalFor(dotted) {
    if (this.fatal) return this.fatal;
    for (const [prefix, reason] of this.refusals) {
      if (dotted === prefix || dotted.startsWith(`${prefix}.`)) return reason;
    }
    return null;
  }
}

/** Strip a trailing `# comment` from a plain (unquoted) scalar. */
function stripPlainComment(raw) {
  // YAML requires whitespace before an inline comment in a plain scalar, so a
  // bare `#` mid-token (`sha#1`) is part of the value, not a comment.
  const index = raw.search(/\s#/);
  return (index === -1 ? raw : raw.slice(0, index)).trim();
}

/**
 * Read a quoted scalar, returning `null` when the rest of the line is anything
 * other than whitespace or a comment (which would mean this is not the simple
 * quoted scalar it looked like).
 */
function readQuoted(raw) {
  const quote = raw[0];
  let out = '';
  for (let i = 1; i < raw.length; i += 1) {
    const char = raw[i];
    if (quote === '"' && char === '\\') {
      const next = raw[i + 1];
      if (next === undefined) return null;
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      i += 1;
      continue;
    }
    if (char === quote) {
      // A doubled single quote is an escaped quote in YAML's single-quoted form.
      if (quote === "'" && raw[i + 1] === "'") {
        out += "'";
        i += 1;
        continue;
      }
      const rest = raw.slice(i + 1).trim();
      if (rest !== '' && !rest.startsWith('#')) return null;
      return out;
    }
    out += char;
  }
  return null;
}

/**
 * Coerce a plain scalar to a JS value.
 *
 * Only YAML 1.2 core-schema spellings of the booleans are recognised — `true`
 * and `false`, case-insensitively. YAML 1.1's `yes`/`no`/`on`/`off` are left as
 * strings, because whether the pipeline's own loader would read them as
 * booleans is not something this reader can know, and inventing an answer for a
 * kill-switch key is the one thing it must not do. A caller asking for a boolean
 * gets `unknown` for such a value rather than a guess.
 */
function coerceScalar(token) {
  if (token === '' || token === '~' || token.toLowerCase() === 'null') return null;
  const lower = token.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^-?\d+$/.test(token)) {
    const num = Number(token);
    return Number.isSafeInteger(num) ? num : token;
  }
  if (/^-?\d+\.\d+$/.test(token)) return Number(token);
  return token;
}

/**
 * Parse the scalar-mapping subset of a YAML document.
 *
 * @param {string} text
 * @returns {ScalarYamlDocument}
 */
export function readScalarYaml(text) {
  const values = new Map();
  const refusals = new Map();
  let fatal = null;

  const source = String(text ?? '');
  if (/^[ ]*\t/m.test(source)) {
    // A tab in the indentation makes every indent comparison below meaningless,
    // and an indent comparison is how this reader decides which key a value
    // belongs to. Refuse the document rather than mis-nest it.
    fatal = 'tab characters in indentation — this reader cannot resolve nesting';
    return new ScalarYamlDocument({ values, refusals, fatal });
  }

  /** @type {{indent: number, key: string}[]} */
  const stack = [];
  const dottedAt = (key) => [...stack.map((entry) => entry.key), key].join('.');
  const parentDotted = () => stack.map((entry) => entry.key).join('.');
  const refuse = (dotted, reason) => {
    if (dotted === '') {
      fatal = reason;
      return;
    }
    if (!refusals.has(dotted)) refusals.set(dotted, reason);
  };

  // When a block scalar is open, every line indented past its key belongs to
  // its body and must not be read as structure.
  let blockBodyMinIndent = null;

  const lines = source.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;

    if (blockBodyMinIndent !== null) {
      if (indent >= blockBodyMinIndent) continue;
      blockBodyMinIndent = null;
    }

    const trimmed = line.trim();

    if (indent === 0 && (trimmed === '---' || trimmed === '...' || trimmed.startsWith('--- '))) {
      // A multi-document stream: which document wins is a question about the
      // consumer, not about this file, so no value here can be trusted.
      fatal = 'multi-document YAML stream — this reader cannot pick the effective document';
      return new ScalarYamlDocument({ values, refusals, fatal });
    }

    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();

    if (trimmed === '-' || trimmed.startsWith('- ')) {
      // A sequence. Its items can themselves be mappings, whose keys would
      // otherwise land in the parent's namespace, so the parent's whole subtree
      // is dropped rather than partially read.
      refuse(parentDotted(), 'sequence value — this reader reads scalars only');
      continue;
    }

    const match = MAPPING_LINE.exec(trimmed);
    if (!match) {
      refuse(parentDotted(), `unrecognised line: ${JSON.stringify(trimmed.slice(0, 60))}`);
      continue;
    }

    const rawKey = match[1].trim();
    if (!SAFE_KEY.test(rawKey)) {
      refuse(parentDotted(), `unsupported key spelling: ${JSON.stringify(rawKey.slice(0, 60))}`);
      continue;
    }

    const dotted = dottedAt(rawKey);
    const rawValue = (match[2] ?? '').trim();

    if (rawValue === '' || rawValue.startsWith('#')) {
      // A nested mapping opens here.
      stack.push({ indent, key: rawKey });
      continue;
    }

    if (BLOCK_SCALAR.test(rawValue)) {
      refuse(dotted, 'block scalar — this reader reads inline scalars only');
      blockBodyMinIndent = indent + 1;
      continue;
    }

    if (rawValue.startsWith('[') || rawValue.startsWith('{')) {
      refuse(dotted, 'flow collection — this reader reads scalars only');
      continue;
    }

    if (UNSUPPORTED_VALUE_PREFIX.some((prefix) => rawValue.startsWith(prefix))) {
      refuse(dotted, 'anchor, alias, or tag — this reader cannot resolve it');
      continue;
    }

    if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
      const quoted = readQuoted(rawValue);
      if (quoted === null) {
        refuse(dotted, 'unterminated or multi-line quoted scalar');
        continue;
      }
      values.set(dotted, quoted);
      continue;
    }

    values.set(dotted, coerceScalar(stripPlainComment(rawValue)));
  }

  // A refused subtree drops everything under it, including values read before
  // the refusing construct was reached. Partial reads of a structure this
  // reader mis-modelled are exactly the wrong answers it exists to avoid.
  for (const prefix of refusals.keys()) {
    for (const dotted of [...values.keys()]) {
      if (dotted === prefix || dotted.startsWith(`${prefix}.`)) values.delete(dotted);
    }
  }

  return new ScalarYamlDocument({ values, refusals, fatal });
}
