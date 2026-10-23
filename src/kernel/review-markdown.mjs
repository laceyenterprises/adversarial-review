// Share fence handling across review validation, section sanitization and findings.
// A close must use the opening character, at least its length, and no info text.
function mapUnfencedReviewLines(text, transform, fencedTransform = (line) => line) {
  let fence = null;
  return String(text ?? '').split('\n').map((line) => {
    const marker = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length
        && !line.slice(marker[0].length).trim()) fence = null;
      return fencedTransform(line);
    }
    if (marker) {
      fence = marker[1];
      return fencedTransform(line);
    }
    return transform(line);
  }).join('\n');
}

// Preserve offsets so section matches still slice the original posting body.
function maskReviewFences(text) {
  return mapUnfencedReviewLines(text, (line) => line, (line) => line.replace(/[^\r]/g, ' '));
}

export { mapUnfencedReviewLines, maskReviewFences };
