/** Prevent author-written squash bodies from closing unrelated GitHub work. */
export function neutralizeClosingKeywords(text, { selfPrNumber, repo } = {}) {
  const rewrites = [];
  const body = String(text ?? '').replace(
    /\b(close[sd]?|fix(?:es|ed)?|resolve[sd]?)(:?\s+)((?:[a-z0-9_.-]+\/[a-z0-9_.-]+)?#([0-9]+))/gi,
    (original, keyword, gap, reference, number) => {
      const referencedRepo = reference.includes('/') ? reference.slice(0, reference.indexOf('#')) : null;
      if (Number(number) === Number(selfPrNumber)
        && (!referencedRepo || referencedRepo.toLowerCase() === String(repo).toLowerCase())) return original;
      const replacement = `${keyword}${gap}PR ${reference}`;
      rewrites.push({ original, referencedNumber: Number(number), referencedRepo, replacement });
      return replacement;
    },
  );
  return { text: body, rewrites };
}

export function buildMergeCommitBody({ prBody = '', trailers = '', selfPrNumber, repo }) {
  return neutralizeClosingKeywords([prBody, trailers].filter(Boolean).join('\n\n'), { selfPrNumber, repo });
}
