// render-template.mjs — positive-list `${VAR}` substitution.
//
// Used by tools/adversarial-review/install.sh to render the launchd
// templates under deploy/launchd/, and imported by the corresponding
// tests under test/. Only the well-known placeholder names below are
// substituted — shell parameter expansions like `${GITHUB_TOKEN:-}`
// that happen to live in the templates are left untouched.
//
// No eval, no source. The input text is read into memory; placeholders
// are replaced with a literal indexOf/split/join walk per name.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const PLACEHOLDERS = Object.freeze([
  'REPO_ROOT',
  'OPERATOR_HOME',
  'SECRETS_ROOT',
  'LOG_ROOT',
  'REVIEWER_AUTH_ROOT',
  'WATCHER_USER_LABEL',
]);

function literalReplace(text, needle, replacement) {
  return text.split(needle).join(replacement);
}

function escapeXmlText(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderTemplate(text, bindings, options = {}) {
  if (typeof text !== 'string') {
    throw new TypeError('renderTemplate: text must be a string');
  }
  if (!bindings || typeof bindings !== 'object') {
    throw new TypeError('renderTemplate: bindings must be an object');
  }
  const format = options.format || 'plain';
  let out = text;
  for (const name of PLACEHOLDERS) {
    if (!(name in bindings)) {
      throw new Error(`renderTemplate: missing binding for \${${name}}`);
    }
    const value = bindings[name];
    if (typeof value !== 'string') {
      throw new TypeError(`renderTemplate: binding for ${name} must be a string`);
    }
    const renderedValue = format === 'xml' ? escapeXmlText(value) : value;
    out = literalReplace(out, '${' + name + '}', renderedValue);
  }
  return out;
}

// Returns the list of known placeholder names that still appear in `text`
// after rendering. Useful for asserting "no placeholder leaked through."
// Shell expansions like ${GITHUB_TOKEN:-} are not in PLACEHOLDERS and so
// are never flagged.
export function unresolvedPlaceholders(text) {
  const leftover = [];
  for (const name of PLACEHOLDERS) {
    if (text.includes('${' + name + '}')) {
      leftover.push(name);
    }
  }
  return leftover;
}

// Build the header comment that records render provenance. Different
// comment styles for shell scripts vs. plists — see install.sh for
// where this is appended just-after the first line of the rendered
// file.
export function buildHeaderComment({ format, sourceTemplate, renderedAt, bindings }) {
  const lines = [
    `Rendered by tools/adversarial-review/install.sh`,
    `Source template: ${sourceTemplate}`,
    `Rendered at:     ${renderedAt}`,
  ];

  if (format === 'shell') {
    lines.push(`Bindings:`);
    for (const name of PLACEHOLDERS) {
      lines.push(`  ${name} = ${bindings[name] ?? ''}`);
    }
    lines.push('Edit the template and re-run install.sh; do not edit this rendered file directly.');
    return lines.map((line) => '# ' + line).join('\n') + '\n';
  }
  if (format === 'xml') {
    lines.push('Bindings omitted here so XML comments stay valid for any supported input value.');
    lines.push('Edit the template and re-run install.sh; do not edit this rendered file directly.');
    return '<!--\n' + lines.map((line) => '  ' + line).join('\n') + '\n-->\n';
  }
  throw new Error(`buildHeaderComment: unknown format ${format}`);
}

// Insert the rendered header after the first line (the shebang or the
// XML declaration). If the file does not start with a recognizable
// first line, prepend the header.
export function withHeader(rendered, header) {
  const newlineIndex = rendered.indexOf('\n');
  if (newlineIndex === -1) {
    return header + rendered;
  }
  const firstLine = rendered.slice(0, newlineIndex + 1);
  const isShebang = firstLine.startsWith('#!');
  const isXmlDecl = firstLine.startsWith('<?xml');
  if (isShebang || isXmlDecl) {
    return firstLine + header + rendered.slice(newlineIndex + 1);
  }
  return header + rendered;
}

function parseCliVars(args) {
  const bindings = {};
  let input = null;
  let output = null;
  let format = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--in' || arg === '--input') {
      input = args[++i];
    } else if (arg === '--out' || arg === '--output') {
      output = args[++i];
    } else if (arg === '--format') {
      format = args[++i];
    } else if (arg.startsWith('--var=')) {
      const rest = arg.slice('--var='.length);
      const eq = rest.indexOf('=');
      if (eq === -1) {
        throw new Error(`render-template: --var expects KEY=VALUE, got ${rest}`);
      }
      bindings[rest.slice(0, eq)] = rest.slice(eq + 1);
    } else if (arg === '--var') {
      const rest = args[++i];
      if (rest === undefined) {
        throw new Error('render-template: --var requires KEY=VALUE');
      }
      const eq = rest.indexOf('=');
      if (eq === -1) {
        throw new Error(`render-template: --var expects KEY=VALUE, got ${rest}`);
      }
      bindings[rest.slice(0, eq)] = rest.slice(eq + 1);
    } else {
      throw new Error(`render-template: unknown argument ${arg}`);
    }
  }
  if (!input || !output) {
    throw new Error('render-template: --in and --out are required');
  }
  if (!format) {
    format = input.endsWith('.plist.template') ? 'xml' : 'shell';
  }
  return { input, output, format, bindings };
}

async function main() {
  const { input, output, format, bindings } = parseCliVars(process.argv.slice(2));
  const text = await readFile(input, 'utf8');
  const rendered = renderTemplate(text, bindings, { format });
  const leftover = unresolvedPlaceholders(rendered);
  if (leftover.length > 0) {
    throw new Error(`render-template: unresolved placeholders after render: ${leftover.join(', ')}`);
  }
  const header = buildHeaderComment({
    format,
    sourceTemplate: input,
    renderedAt: new Date().toISOString(),
    bindings,
  });
  const final = withHeader(rendered, header);
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, final);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(thisFile)) {
  main().catch((err) => {
    process.stderr.write(`render-template: ${err.message}\n`);
    process.exit(1);
  });
}
