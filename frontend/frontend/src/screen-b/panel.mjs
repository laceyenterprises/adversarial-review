/**
 * Screen B — pipeline health + governance (ARF-04).
 *
 * SPEC §1 calls the Screen B mockup the deliverable, and its defining property
 * is that it "can never misreport the true stop-state". That property is not
 * created here — it is derived in the server's `governance/merge-paths.mjs` —
 * but it is very easy to *destroy* here, so this renderer holds three rules:
 *
 *   1. **Never render a tri-state as a two-state.** `armed` / `disarmed` /
 *      `unknown` are three visibly different things, and a key ARF could not
 *      read renders as `unknown`, never as `false`. Falsy-collapsing an unknown
 *      into "off" would report a stopped pipeline that is actually merging.
 *   2. **Both paths and both keys, always drawn.** Every merge path and every
 *      kill-switch key gets a row even when it is uninteresting, so a path
 *      cannot go missing from the panel by being in an unusual state.
 *   3. **The aggregate is drawn from the aggregate.** The stop-state banner
 *      renders `payload.stopState`; it is never recomputed from the rows, which
 *      is how a renderer and its data start disagreeing.
 *
 * Both renderers below draw from the same payload and are exercised by the same
 * tests. There is deliberately no client-side re-render: the page is served
 * whole and reloads itself, so there is exactly one implementation of "what
 * does this state look like" and no second copy to drift out of agreement with
 * the server about whether the pipeline is stopped.
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** A boolean-ish governance value, with unknown kept distinct from false. */
export function valueText(key) {
  if (!key) return 'unknown';
  if (!key.known) return 'unknown';
  if (key.value === true) return 'true';
  if (key.value === false) return 'false';
  return String(key.value);
}

/** `on` / `off` / `unknown`, for keys the mockup spells that way. */
export function onOffText(key) {
  const text = valueText(key);
  return text === 'true' ? 'on' : text === 'false' ? 'off' : text;
}

const PATH_GLYPH = { armed: '▸ armed', disarmed: '▪ disarmed', unknown: '? unknown' };

const EFFECTIVE_TEXT = {
  'merging-possible': 'can merge',
  stopped: 'stopped',
  unknown: 'stop NOT proven',
};

const DAEMON_GLYPH = { up: '●', stale: '◐', down: '○', unknown: '?' };

/** A heartbeat age, in the compact form the mockup uses. */
export function ageText(daemon) {
  if (daemon.ageMs === null || daemon.ageMs === undefined) return null;
  const seconds = Math.round(daemon.ageMs / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function daemonText(daemon) {
  const age = ageText(daemon);
  return `${daemon.label} ${DAEMON_GLYPH[daemon.state] ?? '?'} ${daemon.state}${age ? ` (${age})` : ''}`;
}

/** The one-line summary of what the pipeline is currently able to do. */
export function stopStateHeadline(stopState) {
  switch (stopState?.state) {
    case 'merging-possible':
      return `MERGES POSSIBLE — armed: ${stopState.mergingPaths.join(', ') || 'none'}`;
    case 'stopped':
      return 'STOPPED — every merge path is disarmed and its executor is not beating';
    default:
      // The important one. "We could not prove a stop" must never be drawn in
      // the same shape as "stopped".
      return 'STOP NOT PROVEN — ARF cannot show that every merge path is stopped';
  }
}

// ---------------------------------------------------------------------------
// Text renderer (the SPEC §1 mockup shape)
// ---------------------------------------------------------------------------

const BOX_WIDTH = 78;

function boxLine(text, width = BOX_WIDTH) {
  return `│ ${text.padEnd(width - 2)} │`;
}

/**
 * Wrap to the box's inner width, indenting continuation lines.
 *
 * Wrapping rather than truncating is not cosmetic here: the stop-state reasons
 * are the operator's instructions ("bounce the watcher and re-check"), and a
 * reason cut off at a box edge reads as a shorter, more confident claim than
 * the one the server actually made.
 */
function boxWrapped(text, { indent = '', width = BOX_WIDTH } = {}) {
  const inner = width - 2;
  const raw = String(text);
  // A line that already fits is emitted verbatim, so column alignment built
  // with runs of spaces survives.
  if (raw.length <= inner) return [boxLine(raw, width)];
  const leading = raw.match(/^\s*/)[0];
  const lines = [];
  let current = '';
  for (const word of raw.trimStart().split(/\s+/).filter(Boolean)) {
    if (current === '') {
      current = (lines.length === 0 ? leading : indent) + word;
    } else if (current.length + 1 + word.length <= inner) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = indent + word;
    }
  }
  if (current !== '') lines.push(current);
  return lines.map((line) => boxLine(line, width));
}

/**
 * The panel as text, matching the SPEC §1 Screen B mockup.
 *
 * Kept alongside the HTML renderer because it is what a test can assert against
 * character-for-character, and because an operator on a terminal (or reading a
 * log of one) is a real consumer of this surface.
 */
export function renderScreenBText(payload) {
  const lines = [];
  lines.push(`┌ Pipeline ${'─'.repeat(BOX_WIDTH - 10)}┐`);
  lines.push(...boxWrapped(payload.daemons.map(daemonText).join('   '), { indent: ' '.repeat(13) }));

  const msm = payload.mergePaths.filter((path) => path.msm);
  const other = payload.mergePaths.filter((path) => !path.msm);
  lines.push(boxLine(`MSM paths:   ${msm.map((path) => `${path.label} ${PATH_GLYPH[path.state]}`).join('     ')}`));
  for (const path of other) {
    lines.push(boxLine(
      `also:        ${path.label} ${PATH_GLYPH[path.state]}  (${EFFECTIVE_TEXT[path.effective.state]})`,
    ));
  }

  const keys = payload.governance.keys;
  lines.push(boxLine(
    `kill-switch: ${keys.enabled.label}=${valueText(keys.enabled)}   `
    + `${keys.autonomousMergeExecutionEnabled.label}=${valueText(keys.autonomousMergeExecutionEnabled)}`,
  ));
  lines.push(boxLine(
    `strict:      strict_non_blocking_remediation=${onOffText(keys.strictNonBlockingRemediation)}   `
    + `strict_mode=${onOffText(keys.strictMode)}`,
  ));
  lines.push(boxLine(
    `cycle cap:   ${payload.reviewCycle.cap ?? 'unknown'} over `
    + `${payload.reviewCycle.windowHours ?? 'unknown'}h · ${payload.reviewCycle.total} heads · `
    + `${payload.reviewCycle.exhaustedCount} exhausted · `
    + `${payload.reviewCycle.lastRoundCount} on last round`,
  ));
  lines.push(...boxWrapped(`stop-state:  ${stopStateHeadline(payload.stopState)}`, { indent: ' '.repeat(13) }));
  for (const reason of payload.stopState.reasons) {
    lines.push(...boxWrapped(`  ↳ ${reason}`, { indent: ' '.repeat(5) }));
  }
  lines.push(`└${'─'.repeat(BOX_WIDTH)}┘`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

function keyRow(key) {
  const caveats = (key.caveats ?? []).map((caveat) => `<li>${esc(caveat)}</li>`).join('');
  return `
    <tr class="key key--${esc(valueText(key))}">
      <td class="key__name"><code>${esc(key.key)}</code>${key.killSwitch ? ' <span class="badge">kill switch</span>' : ''}</td>
      <td class="key__value" data-value="${esc(valueText(key))}">${esc(valueText(key))}</td>
      <td class="key__source">${esc(key.source ?? 'unresolved')}${key.sourcePath ? `<br><small>${esc(key.sourcePath)}</small>` : ''}</td>
      <td class="key__note"><small>${esc(key.note)}</small>${caveats ? `<ul class="caveats">${caveats}</ul>` : ''}</td>
    </tr>`;
}

function pathCard(path) {
  const requirements = path.requirements.map((req) => `
      <li class="req req--${esc(req.verdict)}">
        <code>${esc(req.key)}</code> = ${esc(req.known ? String(req.value) : 'unknown')}
        <span class="req__verdict">${esc(req.verdict)}</span>
      </li>`).join('');
  const modifiers = path.modifiers.map((mod) => `
      <li><code>${esc(mod.key)}</code> = ${esc(mod.known ? String(mod.value) : 'unknown')}</li>`).join('');
  return `
    <article class="path path--${esc(path.state)}" data-path="${esc(path.id)}" data-state="${esc(path.state)}" data-effective="${esc(path.effective.state)}">
      <header>
        <h3>${esc(path.label)}${path.msm ? ' <span class="badge">MSM</span>' : ''}</h3>
        <span class="path__state">${esc(PATH_GLYPH[path.state])}</span>
        <span class="path__effective">${esc(EFFECTIVE_TEXT[path.effective.state])}</span>
      </header>
      <p class="path__role">${esc(path.role)}</p>
      <p class="path__executor">executor: <code>${esc(path.executor.job)}</code> — ${esc(path.executor.state)}</p>
      ${requirements ? `<ul class="reqs">${requirements}</ul>`
    : `<p class="path__note">${esc(path.armReason ?? 'no config key governs this path')}</p>`}
      ${modifiers ? `<details><summary>modifiers (do not arm or disarm)</summary><ul>${modifiers}</ul></details>` : ''}
      <ul class="path__reasons">${path.effective.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    </article>`;
}

function daemonCard(daemon) {
  const age = ageText(daemon);
  return `
    <li class="daemon daemon--${esc(daemon.state)}" data-daemon="${esc(daemon.id)}" data-state="${esc(daemon.state)}">
      <span class="daemon__glyph">${esc(DAEMON_GLYPH[daemon.state] ?? '?')}</span>
      <span class="daemon__label">${esc(daemon.label)}</span>
      <span class="daemon__state">${esc(daemon.state)}${age ? ` (${esc(age)})` : ''}</span>
      ${daemon.mergeCapable ? '<span class="badge">merge-capable</span>' : ''}
      ${daemon.reason ? `<small class="daemon__reason">${esc(daemon.reason)}</small>` : ''}
    </li>`;
}

function killSwitchRow(entry) {
  return `
    <tr data-kill-switch="${esc(entry.keyId)}">
      <td><code>${esc(entry.key)}</code></td>
      <td data-value="${esc(entry.known ? String(entry.value) : 'unknown')}">${esc(entry.known ? String(entry.value) : 'unknown')}</td>
      <td>${esc(entry.governs.join(', ') || 'no path')}</td>
      <td class="warn">${esc(entry.doesNotGovern.join(', ') || 'none')}</td>
      <td>${esc(entry.disarming.join(', ') || '—')}</td>
    </tr>`;
}

function burndownRow(row) {
  return `
    <tr class="${row.exhausted === true ? 'exhausted' : ''}">
      <td>${esc(row.repo ?? '—')}</td>
      <td>${row.pr === null ? '—' : esc(`#${row.pr}`)}</td>
      <td><code>${esc(row.headShaShort ?? '—')}</code></td>
      <td>${row.used === null ? 'unknown' : esc(row.used)} / ${row.cap === null ? 'unknown' : esc(row.cap)}</td>
      <td>${row.remaining === null ? 'unknown' : esc(row.remaining)}</td>
      <td>${row.windowExpired === null ? 'unknown' : row.windowExpired ? 'window lapsed' : 'in window'}</td>
      <td>${row.exhausted === null ? 'unknown' : row.exhausted ? 'exhausted' : 'ok'}</td>
    </tr>`;
}

/** The Screen B panel as an HTML fragment. */
export function renderScreenB(payload) {
  const keys = payload.governance.keys;
  const envWarning = payload.governance.envLayer.observable ? '' : `
    <p class="warn env-warning">
      Environment layer not observable: ${esc(payload.governance.envLayer.reason)}
    </p>`;

  return `
  <section class="screen-b" data-stop-state="${esc(payload.stopState.state)}">
    <header class="banner banner--${esc(payload.stopState.state)}">
      <h1>Pipeline</h1>
      <p class="headline">${esc(stopStateHeadline(payload.stopState))}</p>
      <ul class="banner__reasons">${payload.stopState.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    </header>

    <section class="daemons">
      <h2>Daemon liveness</h2>
      <ul>${payload.daemons.map(daemonCard).join('')}</ul>
    </section>

    <section class="paths">
      <h2>Merge paths</h2>
      ${payload.mergePaths.map(pathCard).join('')}
    </section>

    <section class="kill-switches">
      <h2>Kill switches</h2>
      <table>
        <thead><tr><th>key</th><th>value</th><th>governs</th><th>does NOT govern</th><th>currently disarming</th></tr></thead>
        <tbody>${payload.killSwitches.map(killSwitchRow).join('')}</tbody>
      </table>
      <p class="note">
        A path in <em>does NOT govern</em> keeps merging when this switch is off. That column is
        the reason this panel exists.
      </p>
    </section>

    <section class="governance">
      <h2>Governance config</h2>
      ${envWarning}
      <table>
        <thead><tr><th>key</th><th>value</th><th>source</th><th>meaning</th></tr></thead>
        <tbody>${Object.values(keys).map(keyRow).join('')}</tbody>
      </table>
      <details>
        <summary>config layers read (lowest precedence first)</summary>
        <ol>${payload.governance.sources.map((source) => `
          <li><code>${esc(source.path)}</code> — ${esc(source.readable ? 'read' : source.present ? 'present, not read' : 'absent')}${source.reason ? `: ${esc(source.reason)}` : ''}</li>`).join('')}
        </ol>
      </details>
    </section>

    <section class="review-cycle">
      <h2>Review-cycle cap</h2>
      <p>
        cap <strong>${payload.reviewCycle.cap === null ? 'unknown' : esc(payload.reviewCycle.cap)}</strong>
        over <strong>${payload.reviewCycle.windowHours === null ? 'unknown' : esc(payload.reviewCycle.windowHours)}h</strong>
        · ${esc(payload.reviewCycle.total)} tracked heads
        · ${esc(payload.reviewCycle.exhaustedCount)} exhausted
        · ${esc(payload.reviewCycle.lastRoundCount)} on their last round
        · strict_non_blocking_remediation <strong>${esc(onOffText(keys.strictNonBlockingRemediation))}</strong>
      </p>
      <table>
        <thead><tr><th>repo</th><th>pr</th><th>head</th><th>used / cap</th><th>left</th><th>window</th><th>state</th></tr></thead>
        <tbody>${payload.reviewCycle.rows.map(burndownRow).join('')}</tbody>
      </table>
    </section>

    <footer class="controls">
      <button type="button" disabled title="ARF-08 owns the load-independent arm/disarm gate">Arm</button>
      <button type="button" disabled title="ARF-08 owns the load-independent arm/disarm gate">Disarm (emergency stop)</button>
      <span class="note">read-only in ARF-04 — the pipeline-honoured gate lands in ARF-08 (SPEC §5)</span>
      <span class="generated">generated ${esc(payload.generatedAt)}</span>
    </footer>
  </section>`;
}

const STYLES = `
  :root { color-scheme: light dark; }
  body { font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 1.5rem; }
  h1, h2, h3 { margin: 0 0 .4rem; }
  .banner { padding: .75rem 1rem; border-radius: .4rem; margin-bottom: 1rem; }
  .banner--merging-possible { background: #7a2c2c; color: #fff; }
  .banner--stopped { background: #1f5130; color: #fff; }
  .banner--unknown { background: #7a5a1f; color: #fff; }
  .headline { font-weight: 700; margin: .2rem 0; }
  .daemons ul { list-style: none; padding: 0; display: flex; gap: 1.5rem; flex-wrap: wrap; }
  .daemon { display: flex; gap: .4rem; align-items: baseline; flex-wrap: wrap; }
  .daemon--stale .daemon__state, .daemon--down .daemon__state { color: #b00; font-weight: 700; }
  .daemon__reason { flex-basis: 100%; opacity: .7; }
  .paths { display: flex; gap: 1rem; flex-wrap: wrap; }
  .path { border: 1px solid currentColor; border-radius: .4rem; padding: .6rem .8rem; flex: 1 1 20rem; }
  .path header { display: flex; gap: .6rem; align-items: baseline; }
  .path--armed .path__state { color: #b00; font-weight: 700; }
  .path--unknown .path__state { color: #a70; font-weight: 700; }
  .req--disarms { color: #1f5130; font-weight: 700; }
  .req--unknown { color: #a70; font-weight: 700; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; }
  th, td { border: 1px solid #8884; padding: .25rem .5rem; text-align: left; vertical-align: top; }
  td[data-value="unknown"] { color: #a70; font-weight: 700; }
  .badge { font-size: .75em; border: 1px solid currentColor; border-radius: .3rem; padding: 0 .3rem; }
  .warn { color: #a70; }
  .note, small { opacity: .75; }
  tr.exhausted { background: #a7002211; }
  .controls { display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; margin-top: 1rem; }
`;

/**
 * The panel as a complete HTML document.
 *
 * `refreshMs` drives a whole-page reload rather than a client-side re-render.
 * A second renderer in the browser would be a second implementation of "is this
 * path armed", and two implementations of that question is exactly how a panel
 * ends up disagreeing with the system it describes.
 */
export function renderScreenBPage(payload, { refreshMs = 15_000 } = {}) {
  const refresh = Number.isFinite(refreshMs) && refreshMs > 0
    ? `<meta http-equiv="refresh" content="${Math.max(1, Math.round(refreshMs / 1000))}">`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}
<title>ARF · Pipeline health &amp; governance</title>
<style>${STYLES}</style>
</head>
<body>
${renderScreenB(payload)}
</body>
</html>
`;
}
