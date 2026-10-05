/** Prevent author-written merge messages from closing unrelated GitHub work. */
export function neutralizeClosingKeywords(text, { selfPrNumber, repo } = {}) {
  const rewrites = [];
  const body = String(text ?? '').replace(
    /(?<![a-z0-9])(close[sd]?|fix(?:es|ed)?|resolve[sd]?)(:?\s*)((?:[a-z0-9_.-]+\/[a-z0-9_.-]+)?#[0-9]+|GH-[0-9]+|(?:https?:\/\/)?(?:www\.)?github\.com\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/(?:issues|pull)\/[0-9]+)/gi,
    (original, keyword, gap, reference) => {
      const number = Number(reference.match(/[0-9]+$/)[0]);
      const urlRepo = reference.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+\/[^/]+)\//i);
      const referencedRepo = urlRepo ? urlRepo[1]
        : reference.includes('/') ? reference.slice(0, reference.indexOf('#')) : null;
      if (number === Number(selfPrNumber)
        && (!referencedRepo || referencedRepo.toLowerCase() === String(repo).toLowerCase())) return original;
      const replacement = `${keyword}${gap}PR ${reference}`;
      rewrites.push({ original, referencedNumber: number, referencedRepo, replacement });
      return replacement;
    },
  );
  return { text: body, rewrites };
}

/** Build the explicit body and subject, with title rewrites first in the audit. */
export function buildMergeCommitBody({ prTitle = '', prBody = '', trailers = '', selfPrNumber, repo }) {
  if (!String(prTitle ?? '').trim()) throw new Error('merge-title-missing');
  const title = neutralizeClosingKeywords(prTitle, { selfPrNumber, repo });
  const body = neutralizeClosingKeywords([prBody, trailers].filter(Boolean).join('\n\n'), { selfPrNumber, repo });
  return { text: body.text, subject: `${title.text} (#${selfPrNumber})`, rewrites: [...title.rewrites, ...body.rewrites] };
}
