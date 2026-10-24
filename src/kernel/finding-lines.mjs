// Shared interpretation of reviewer file-line citations. Diff-line indices
// and trailing prose do not supply file coordinates. Validation stays with callers.
export function findingLineRanges(text, file) {
  // Refuse oversized input before regex work; truncation could authorize a
  // valid prefix while silently dropping an invalid range at the end.
  if (String(text || '').length > 512) return [];
  let fileLines = String(text || '').replace(/`/g, '').trim();
  const pathPrefix = `${String(file || '').replace(/`/g, '')}:`;
  if (fileLines.startsWith(pathPrefix)) fileLines = fileLines.slice(pathPrefix.length);
  const readList = (value) => {
    const ranges = [];
    let rest = value;
    while (true) {
      const match = /^\s*(?:lines?\s+)?~?(?:#?L)?(-?\d+)(?:\s*(?:[-–]|\.\.)\s*(?:L)?(-?\d+))?(?=$|[\s;,():])/i.exec(rest);
      if (!match) break;
      ranges.push({ start: Number(match[1]), end: Number(match[2] || match[1]) });
      rest = rest.slice(match[0].length);
      const separator = /^\s*[;,]\s*/.exec(rest);
      if (!separator) break;
      rest = rest.slice(separator[0].length);
    }
    return { ranges, rest };
  };
  // Modern citations start with a list. Everything after it is a note, even
  // when the note contains parentheses, identifiers, dates or diff indices.
  const leading = readList(fileLines);
  if (leading.ranges.length) return leading.ranges;
  // Legacy symbol-qualified citations put the entire list in parentheses.
  // Require a complete numeric list, rather than searching prose for numbers.
  return [...fileLines.matchAll(/(?:^|[;,])\s*[\w.][^();,]*\((?:post-diff\s+)?([^()]*)\)\s*(?=[;,]|$)/g)].flatMap((match) => {
    const { ranges, rest } = readList(match[1]);
    return rest.trim() ? [] : ranges;
  });
}

// LAC-2101: literal locations only. Never mine Problem/Recommended fix prose
// for authority or lend one path's coordinates to another path.
export function findingLocations(file, lines) {
  if (typeof file !== 'string' || file.length > 512 || String(lines || '').length > 512) return [];
  const clean = value => value.replace(/`/g, '').trim();
  const paths = value => {
    const raw = clean(value);
    const brace = /^([^{}]*)\{([^{}]+)\}([^{}]*)$/.exec(raw);
    const expanded = brace ? brace[2].split(',').map(part => brace[1] + part + brace[3]) : [raw];
    return expanded.length <= 16 && expanded.every(path => path && !/[\s:*?{}\\\x00-\x1f]/.test(path)
      && path.split('/').every(part => part && !['.', '..'].includes(part))) ? expanded : [];
  };
  const primary = paths(file);
  if (!primary.length) return [];
  const rawLines = clean(String(lines || ''));
  const primaryRanges = findingLineRanges(rawLines, clean(file));
  const locations = primaryRanges.length ? primary.map(path => ({ path, ranges: primaryRanges })) : [];
  // Only a complete numeric list followed by explicit path:range clauses
  // introduces secondary locations. Notes, symbols and parenthesized metadata
  // retain the existing parser's meaning and cannot resume as authority.
  const numeric = /^(?:lines?\s+)?~?(?:#?L)?-?\d+(?:\s*(?:[-–]|\.\.)\s*L?-?\d+)?(?:\s*[,;]\s*(?:lines?\s+)?~?(?:#?L)?-?\d+(?:\s*(?:[-–]|\.\.)\s*L?-?\d+)?)*$/i;
  const parts = rawLines.split(';');
  let secondary = false;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index].trim();
    const explicit = /^([^:]+):\s*(.+)$/.exec(part);
    if (!secondary && (numeric.test(part) || (index === 0 && explicit
      && primary.includes(explicit[1]) && numeric.test(explicit[2])))) continue;
    if (index === 0 || !explicit || !numeric.test(explicit[2])) break;
    const targets = paths(explicit[1]);
    if (!targets.length) return [];
    secondary = true;
    const ranges = findingLineRanges(explicit[2], explicit[1]);
    for (const path of targets) locations.push({ path, ranges });
  }
  return locations;
}
