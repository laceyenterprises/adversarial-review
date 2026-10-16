import { readBestReviewerEvidenceTokenUsage } from './reviewer-pass-tokens.mjs';

process.once('message', args => {
  let result;
  try { result = { ok: true, usage: readBestReviewerEvidenceTokenUsage(args) }; }
  catch (error) { result = { ok: false, error: error?.message || String(error), code: error?.code || null }; }
  process.send(result, () => process.disconnect());
});
