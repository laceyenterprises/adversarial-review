const PREFIX = '[live_pack_cross_edit] Cross-pack edit of live build pack `';

export function livePackCrossEditFindingTitle(pack) {
  // Preserve a single Markdown line and prevent the name closing the code span.
  const name = String(pack).replace(/%/g, '%25').replace(/`/g, '%60').replace(/\*/g, '%2A')
    .replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  return `${PREFIX}${name}\``;
}

export function isLivePackCrossEditFindingTitle(title) {
  return typeof title === 'string' && title.startsWith(PREFIX) && title.endsWith('`')
    && title.length > PREFIX.length + 1 && !/[`\r\n]/.test(title.slice(PREFIX.length, -1));
}
