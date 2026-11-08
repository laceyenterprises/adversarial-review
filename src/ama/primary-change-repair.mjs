import { describePrimaryChangeRepair } from './primary-change.mjs';

// Gate units use half-open merge-base coordinates. Map them through the
// builder patch to the reviewed snapshot, without treating an entire file or
// unrelated hammer hunk as authority to restore it.
function reviewedRanges(file, regions) {
  const blocks = [];
  let oldLine, newLine, block;
  for (const line of (file?.patch || '').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]) + (hunk[2] === '0' ? 1 : 0);
      newLine = Number(hunk[3]) + (hunk[4] === '0' ? 1 : 0);
      block = null;
    } else if (line.startsWith('+') || line.startsWith('-')) {
      if (oldLine == null || newLine == null) throw new Error('missing repair hunk coordinates');
      if (!block) {
        block = { start: oldLine, end: oldLine, reviewedStart: newLine, reviewedEnd: newLine };
        blocks.push(block);
      }
      if (line.startsWith('-')) block.end = ++oldLine;
      else block.reviewedEnd = ++newLine;
    } else if (line.startsWith(' ')) {
      oldLine++; newLine++; block = null;
    }
  }
  return blocks.filter(block => regions.some(region => region.start === region.end
    ? block.start <= region.start && block.end >= region.start
    : block.start < region.end && block.end > region.start))
    .map(({ reviewedStart: start, reviewedEnd: end }) => ({ start, end }));
}

export function primaryChangeRepairEvidence(evidence, headSha, options) {
  const diagnostic = describePrimaryChangeRepair(evidence, headSha, options);
  if (!diagnostic.paths.length) throw new Error('primary-change refusal no longer present');
  return { ...diagnostic, coordinateConvention: 'half-open; equal endpoints name a deletion/insertion anchor',
    paths: diagnostic.paths.map(path => {
      const file = evidence.primaryFiles.find(file => (file.previous_filename || file.filename) === path.path);
      const ranges = reviewedRanges(file, path.regions || []);
      if (!ranges.length) throw new Error(`no exact repair line ranges for ${path.path}`);
      return { ...path, reviewedPath: file.filename, reviewedRanges: ranges };
    }) };
}
