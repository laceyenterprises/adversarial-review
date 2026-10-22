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
