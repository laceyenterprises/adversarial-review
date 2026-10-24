/** OSG-11: read-only replay policy and parsing. No runtime, store or publication imports. */
import { ROUTE_BY_BUILDER_CLASS, normalizeBuilderClass, reviewerRefusesBuilder } from './adapters/subject/github-pr/routing.mjs';
import { parseReviewFindings } from './kernel/review-findings.mjs';
import { findingLineRanges } from './kernel/finding-lines.mjs';

function modelFamily(model) {
  const value = String(model || '').toLowerCase();
  const name = value.split('/').at(-1);
  if (value.startsWith('deepseek/')) return 'deepseek';
  if (name.startsWith('gpt-')) return 'codex';
  if (name.startsWith('claude-')) return 'claude';
  if (name.startsWith('gemini-')) return 'gemini';
  if (name.startsWith('deepseek')) return 'deepseek';
  return null;
}

export function replayRouteAllowed(builderInput, arm, { diagnostic = false, builderModel = null } = {}) {
  const builder = normalizeBuilderClass(builderInput);
  if (arm?.worker_class && arm.worker_class !== (arm.harness === 'pi' ? 'pi' : `${arm.harness}-reviewer`)) return false;
  const family = modelFamily(arm?.model);
  if (!builder || !family || reviewerRefusesBuilder(builder, family)) return false;
  // A non-native harness must not conceal the model's family. Known builder
  // model evidence takes precedence over a generic third-party harness tag.
  if (builderModel && (!modelFamily(builderModel) || modelFamily(builderModel) === family)) return false;
  if (diagnostic && arm.harness === 'pi' && family === 'deepseek') {
    return !['pi', 'opencode', 'hermes'].includes(builder) || Boolean(builderModel);
  }
  return arm.harness === family && ROUTE_BY_BUILDER_CLASS[builder].reviewerModel === family;
}

export function parseReplayReview(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > 65536) throw Error('invalid replay review');
  const parsed = parseReviewFindings(body);
  if (parsed.blocking.state !== 'known') throw Error('missing review section');
  return [
    ...parsed.blocking.findings.map(f => ({ ...f, blocking: true })),
    ...parsed.nonBlocking.findings.map(f => ({ ...f, blocking: false })),
  ].map(f => ({ ...f, line_ranges: findingLineRanges(f.lines, f.file) }));
}
