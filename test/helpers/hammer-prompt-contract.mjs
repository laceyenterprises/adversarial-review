import assert from 'node:assert/strict';

// This is deliberately a small, fail-closed reader of the prompt's shell
// examples, not a shell interpreter. Bash itself expands the extracted commands.
export function documentedExamples(markdown) {
  const commands = [];
  const json = [];
  const add = (text, offset, fenced = false) => {
    const firstLine = markdown.slice(0, offset).split('\n').length;
    const physicalLines = text.split('\n');
    for (let index = 0; index < physicalLines.length; index++) {
      const line = firstLine + index;
      let logical = physicalLines[index];
      while (logical.endsWith('\\') && index + 1 < physicalLines.length) {
        logical = logical.slice(0, -1) + ' ' + physicalLines[++index].trimStart();
      }
      if (!logical.trim() || /^\s*#/.test(logical)) continue;
      // Definitions are loaded verbatim into every execution shell below.
      if (/^\s*ham_\w+\(\)/.test(logical)) continue;
      const start = logical.search(/(?:source\s+["']?<<ROOT_DIR>>\/bin\/|(?:node|"\$HAM_NODE_BIN"|"\$\{HAM_NODE_BIN:-node\}"|\/usr\/bin\/perl)\s+|ham_(?:read|step|gh)\s+)/);
      // Bare filenames/subcommands in prose refer to helpers, rather than
      // specifying a runnable argv (for example "merge-lease.mjs acquire").
      if (start < 0) {
        assert.ok(!fenced || !/bin\/[\w-]+\.(?:mjs|sh)\b/.test(logical)
          || /\btest\s+-[fx]\b/.test(logical),
        `unhandled executable example at line ${line}: ${logical}`);
        continue;
      }
      let command = logical.slice(start);
      if (!/bin\/[\w-]+\.(?:mjs|sh)\b|^ham_(?:read|step|gh)\s/.test(command)) continue;
      // Metavariables for a generic command/alarm are not concrete invocations.
      if (command.includes('<read-only command...>') || command.includes('<seconds>')) continue;
      command = commandEnd(command);
      commands.push({ command, line });
    }
  };
  // Do not count inline backticks inside a fence a second time.
  const withoutFences = markdown.replace(/```([^\n]*)\n([\s\S]*?)```/g, (whole, language, body, offset) => {
    if (language === 'bash') add(body, offset + whole.indexOf('\n') + 1, true);
    else if (language === 'json') json.push({ value: JSON.parse(body), line: markdown.slice(0, offset).split('\n').length });
    return whole.replace(/[^\n]/g, ' ');
  });
  for (const match of withoutFences.matchAll(/`([^`]+)`/g)) add(match[1].replace(/\s*\n\s*/g, ' '), match.index);
  return { commands, json };
}

function commandEnd(text) {
  let quote = '';
  let parameterDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && quote !== "'") { i++; continue; }
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (text.startsWith('${', i)) { parameterDepth++; i++; continue; }
    if (parameterDepth) { if (c === '}') parameterDepth--; continue; }
    // Angle-bracket placeholders are rendered later, not shell redirects.
    if (c === '<') {
      const placeholder = /^(?:<<[A-Z_]+>>|<[^<>]+>)/.exec(text.slice(i));
      if (placeholder) { i += placeholder[0].length - 1; continue; }
    }
    if (/[;|>)]/.test(c)) return text.slice(0, i).trim();
  }
  return text.trim();
}

export function assertExternalCommands(command, functions) {
  // Tokenize only enough to identify argv-exec command positions. Quoted names
  // are still shell functions, and eval/bash -c is not an argv-exec escape.
  const tokens = (command.match(/(?:[^\s"'\\]+|\\.|"[^"]*"|'[^']*')+/g) || [])
    .map(token => token.replace(/["']/g, ''));
  const positions = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'ham_read') positions.push(i + 2);
    if (tokens[i] === 'ham_step') positions.push(i + 5);
    if (/\/hammer-helper-step\.mjs$/.test(tokens[i])) positions.push(i + 5);
    if (tokens[i] === '/usr/bin/perl' && tokens[i + 1] === '-e'
      && ['alarm shift; exec @ARGV', 'shift or exit 1; exec @ARGV; die $!'].includes(tokens[i + 2])) {
      positions.push(i + 4);
    }
  }
  for (const position of positions) {
    assert.ok(!functions.has(tokens[position]),
      `argv-exec wrapper cannot execute shell function ${tokens[position]}: ${command}`);
  }
}
