// PRIMARYDEADCODE-01: the closed, single-line declaration grammar of the
// derived dead-code proof. A line outside this grammar is not a declaration,
// so its reversal keeps the ordinary finding-coverage rule.

const PYTHON_ID = '[A-Za-z_][A-Za-z0-9_]*';
const JS_ID = '[A-Za-z_$][\\w$]*';
const PYTHON_DOTTED = `${PYTHON_ID}(?:\\.${PYTHON_ID})*`;
const PYTHON_COMMENT = '\\s*(?:#.*)?$';
const JS_TAIL = '\\s*;?\\s*(?://.*)?$';
const PYTHON_LITERAL = String.raw`None|True|False|-?\d[\d_]*(?:\.\d+)?|'[^'\\\n]*'|"[^"\\\n]*"|\[\]|\{\}|\(\)`;
const JS_LITERAL = String.raw`null|undefined|true|false|-?\d[\d_]*(?:\.\d+)?|'[^'\\\n]*'|"[^"\\\n]*"|\[\]|\{\}|new (?:Map|Set|WeakMap|WeakSet)\(\)`;

const PYTHON_IMPORT = new RegExp(`^import\\s+(${PYTHON_DOTTED}(?:\\s+as\\s+${PYTHON_ID})?(?:\\s*,\\s*${PYTHON_DOTTED}(?:\\s+as\\s+${PYTHON_ID})?)*)${PYTHON_COMMENT}`);
const PYTHON_FROM = new RegExp(`^from\\s+(\\.*${PYTHON_DOTTED}|\\.+)\\s+import\\s+(${PYTHON_ID}(?:\\s+as\\s+${PYTHON_ID})?(?:\\s*,\\s*${PYTHON_ID}(?:\\s+as\\s+${PYTHON_ID})?)*)${PYTHON_COMMENT}`);
const PYTHON_BINDING = new RegExp(`^(${PYTHON_ID})\\s*=\\s*(?:${PYTHON_LITERAL})${PYTHON_COMMENT}`);
const JS_IMPORT = new RegExp(`^import\\s+(?:type\\s+)?(.+?)\\s+from\\s+(['"])[^'"\\n]+\\2${JS_TAIL}`);
const JS_BINDING = new RegExp(`^(?:const|let)\\s+(${JS_ID})\\s*=\\s*(?:${JS_LITERAL})${JS_TAIL}`);
const JS_DEFAULT = new RegExp(`^${JS_ID}$`);
const JS_NAMESPACE = new RegExp(`^\\*\\s+as\\s+(${JS_ID})$`);
const JS_SPECIFIER = new RegExp(`^(?:type\\s+)?(${JS_ID})(?:\\s+as\\s+(${JS_ID}))?$`);

// Surviving code that can name a binding without spelling it is never proven.
const HAZARDS = {
  python: /\b(?:globals|locals|vars|eval|exec|__import__|import_module)\s*\(|\b__dict__\b|\bsys\.modules\b|\b__getattr__\b/,
  js: /\beval\s*\(|\bnew\s+Function\b|\bwith\s*\(/,
};

export function deadCodeLanguage(path) {
  if (/\.pyi?$/.test(path)) return 'python';
  if (/\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(path)) return 'js';
  return null;
}

function jsImportSymbols(clause) {
  const symbols = [];
  const braces = /^(?:(.*?)\s*,\s*)?\{\s*([^{}]*?)\s*,?\s*\}$/.exec(clause);
  const head = braces ? braces[1] : clause;
  if (head) {
    const named = JS_NAMESPACE.exec(head) || (JS_DEFAULT.test(head) ? [head, head] : null);
    if (!named) return null;
    symbols.push(named[1]);
  }
  if (braces) {
    if (!braces[2]) return null;
    for (const specifier of braces[2].split(',')) {
      const match = JS_SPECIFIER.exec(specifier.trim());
      if (!match) return null;
      symbols.push(match[2] || match[1]);
    }
  }
  return symbols.length ? symbols : null;
}

// Returns null for a line outside the grammar, else the symbols it binds, or
// a fail-closed reason for a recognized form the proof cannot cover.
export function parseDeadCodeDeclaration(language, line) {
  if (language === 'python') {
    let match = PYTHON_IMPORT.exec(line);
    if (match) {
      return { kind: 'import', symbols: match[1].split(',').map(part => {
        const [, name, alias] = /^\s*(\S+)(?:\s+as\s+(\S+))?\s*$/.exec(part);
        return alias || name.split('.')[0];
      }) };
    }
    match = PYTHON_FROM.exec(line);
    if (match) {
      if (match[1] === '__future__') return { error: 'unsupported-declaration' };
      return { kind: 'import', symbols: match[2].split(',').map(part => {
        const [, name, alias] = /^\s*(\S+)(?:\s+as\s+(\S+))?\s*$/.exec(part);
        return alias || name;
      }) };
    }
    match = PYTHON_BINDING.exec(line);
    if (!match) return null;
    // Module attributes without a leading underscore are importable API.
    if (!match[1].startsWith('_') || /^__\w+__$/.test(match[1])) return { error: 'public-binding' };
    return { kind: 'binding', symbols: [match[1]] };
  }
  if (language === 'js') {
    const match = JS_IMPORT.exec(line);
    if (match) {
      const symbols = jsImportSymbols(match[1].trim());
      return symbols ? { kind: 'import', symbols } : null;
    }
    const binding = JS_BINDING.exec(line);
    return binding ? { kind: 'binding', symbols: [binding[1]] } : null;
  }
  return null;
}

function occurrencePattern(symbol) {
  return new RegExp(`(?<![\\w$])${symbol.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
}

// Every spelling counts, in code, strings and comments alike. A lexer could
// misread a string or regex; a plain word match cannot hide a reference.
export function symbolOccurrences(lines, symbol) {
  const pattern = occurrencePattern(symbol);
  const result = [];
  lines.forEach((line, index) => {
    pattern.lastIndex = 0;
    if (pattern.test(line)) result.push(index + 1);
  });
  return result;
}

// Name the specific way a surviving occurrence can still reach the symbol.
export function classifyOccurrence(line, symbol) {
  if (/\b__all__\b/.test(line)) return 'all-export';
  const pattern = occurrencePattern(symbol);
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    const before = line.slice(0, match.index);
    if ((before.match(/['"`]/g) || []).length % 2 === 1) return 'string-reference';
  }
  if (/\b(?:getattr|hasattr|setattr|delattr|globals|import_module|__import__)\b/.test(line)) return 'dynamic-reference';
  if (/^\s*export\b/.test(line)) return 're-export';
  return 'reference-outside';
}

export function dynamicHazard(language, text) {
  return HAZARDS[language]?.test(text) === true;
}
