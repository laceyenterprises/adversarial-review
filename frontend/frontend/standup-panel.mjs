/**
 * Screen C — the identity standup panel (ARF-05).
 *
 * Vanilla ES modules, no framework, no build step: the same zero-dependency
 * boundary the server keeps, carried through to the browser (SPEC §9).
 *
 * ## Why `fetch` and not `EventSource`
 *
 * A standup is parameterised — a role, an App id, secret references, a
 * verification target — and `EventSource` can only issue a bodyless GET. Putting
 * that many fields, including secret *references*, into a query string would put
 * them in every access log between here and the server. So the panel POSTs and
 * reads the SSE stream off the response body itself, parsing it with the same
 * `parseSseBuffer` the server's own tests use.
 *
 * ## What the panel is careful about
 *
 * - **A resumed step is drawn as a replay, not as a fresh proof.** The stream
 *   distinguishes them and so does this: a green tick that silently means "we
 *   trusted a file from last Tuesday" would overstate what the run verified.
 * - **`operator_input_required` is rendered as *waiting*, not as an error.** The
 *   step status vocabulary is exactly `pending | running | ok | failed`, so a
 *   step blocked on a human is reported as failed with that code — and the panel
 *   is where that gets turned back into "here is what to do next", which is what
 *   the operator actually needs to see.
 * - **A failed run says whether re-running will help.** "Resumable" and "you will
 *   hit this same wall again" are different messages and the stream tells them
 *   apart; flattening both into a red box would send an operator round a loop.
 */

import { parseSseBuffer } from './shared/sse-wire.mjs';

const RUN_ENDPOINT = '/v1/standup/identity/runs';

const GLYPHS = { pending: '○', running: '▸', ok: '✔', failed: '✖' };

const form = document.getElementById('standup-form');
const roleInput = document.getElementById('role-input');
const roleChoices = document.getElementById('role-choices');
const stepsList = document.getElementById('steps');
const outcomeBox = document.getElementById('outcome');
const liveIndicator = document.getElementById('live-indicator');
const runButton = document.getElementById('run-button');
const cancelButton = document.getElementById('cancel-button');
const brokerState = document.getElementById('broker-state');

let inFlight = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent throughout: every string here is either an operator's own input
  // or an upstream message quoted into an error, and neither is ours to trust
  // with innerHTML.
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** Turn the free-text repo field into the array the API expects. */
function splitRepos(value) {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function buildParams() {
  const data = new FormData(form);
  const params = { role: String(data.get('role') ?? '').trim() };
  const put = (key, value) => {
    const text = String(value ?? '').trim();
    if (text !== '') params[key] = text;
  };
  put('appId', data.get('appId'));
  put('org', data.get('org'));
  put('privateKeyRef', data.get('privateKeyRef'));
  put('patFallbackRef', data.get('patFallbackRef'));
  put('verifyRepo', data.get('verifyRepo'));
  put('verifyIssue', data.get('verifyIssue'));
  const repos = splitRepos(data.get('repos'));
  if (repos.length > 0) params.repos = repos;
  return params;
}

function renderSteps(steps) {
  stepsList.replaceChildren();
  for (const step of steps) stepsList.append(renderStep(step));
}

function renderStep(step) {
  const item = el('li', 'step');
  item.dataset.status = step.status;
  item.dataset.resumed = String(step.resumed === true);
  item.id = `step-${step.id}`;

  item.append(el('span', 'step-glyph', GLYPHS[step.status] ?? '·'));
  item.append(el('span', 'step-label', `${step.index + 1}. ${step.label}`));

  const status = step.resumed ? 'ok · resumed' : step.status;
  item.append(el('span', 'step-status', status));

  const detail = step.resumed && step.detail
    ? `${step.detail} — replayed from the previous run, not re-checked`
    : (step.detail ?? step.message ?? null);
  if (detail) item.append(el('span', 'step-detail', detail));
  return item;
}

function updateStep(step) {
  const existing = document.getElementById(`step-${step.id}`);
  if (existing) existing.replaceWith(renderStep(step));
  else stepsList.append(renderStep(step));
  const position = `step ${step.index + 1}/${step.total}`;
  liveIndicator.textContent = step.status === 'running' ? `live: ${position}` : position;
}

function renderNextAction(action) {
  if (!action) return null;
  const box = el('div', 'next-action');
  box.append(el('strong', null, action.summary ?? 'Next step'));
  if (action.url) {
    const link = el('p');
    const anchor = el('a', null, action.url);
    anchor.href = action.url;
    anchor.target = '_blank';
    anchor.rel = 'noreferrer noopener';
    link.append(anchor);
    box.append(link);
  }
  if (action.params && typeof action.params === 'object') {
    const list = el('dl');
    for (const [key, value] of Object.entries(action.params)) {
      list.append(el('dt', null, key));
      list.append(el('dd', null, Array.isArray(value) ? value.join(', ') : String(value)));
    }
    box.append(list);
  }
  return box;
}

function renderOutcome({ kind, title, message, code, action, url }) {
  const box = el('div', 'outcome-box');
  box.dataset.kind = kind;
  box.append(el('h3', null, title));
  if (message) box.append(el('p', null, message));
  if (url) {
    const line = el('p');
    const anchor = el('a', null, url);
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noreferrer noopener';
    line.append(anchor);
    box.append(line);
  }
  if (code) box.append(el('p', 'outcome-code', code));
  const next = renderNextAction(action);
  if (next) box.append(next);
  outcomeBox.replaceChildren(box);
}

function onComplete(data) {
  renderOutcome({
    kind: 'ok',
    title: `${data.role} is stood up and verified`,
    message: data.outputs?.attributedLogin
      ? `The verification comment was attributed to ${data.outputs.attributedLogin} — the identity `
        + 'acts as itself.'
      : 'All five steps completed.',
    url: data.outputs?.verifyCommentUrl ?? null,
  });
  liveIndicator.textContent = 'done';
}

function onFailed(data) {
  // A step waiting on a human is a failure in the status vocabulary and an
  // instruction in the UI. Keeping that distinction here is why the wizard can
  // have exactly four statuses and still show the mockup's "waiting" state.
  const waiting = data.code === 'operator_input_required';
  renderOutcome({
    kind: waiting ? 'waiting' : 'failed',
    title: waiting
      ? `Waiting on you at "${data.failedStepLabel}"`
      : `${data.role} failed at "${data.failedStepLabel}"`,
    message: data.message,
    code: data.resumable
      ? `${data.code} · re-run to resume from the last completed step`
      : `${data.code} · a re-run will stop here again until this is resolved`,
    action: data.nextAction,
  });
  liveIndicator.textContent = 'stopped';
}

async function runStandup(event) {
  event.preventDefault();
  if (inFlight) return;

  outcomeBox.replaceChildren();
  stepsList.replaceChildren();
  liveIndicator.textContent = 'connecting…';
  runButton.disabled = true;
  cancelButton.hidden = false;

  const controller = new AbortController();
  inFlight = controller;

  try {
    const response = await fetch(RUN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(buildParams()),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      // A refusal before the stream opens is a JSON error — a bad param, or a raw
      // secret where a reference belongs.
      const problem = await response.json().catch(() => ({}));
      renderOutcome({
        kind: 'failed',
        title: 'The request was refused',
        message: problem.detail ?? `HTTP ${response.status}`,
        code: problem.error ?? null,
      });
      liveIndicator.textContent = '';
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseBuffer(buffer);
      buffer = rest;
      for (const frame of events) {
        if (frame.event === 'run') renderSteps(frame.data.steps ?? []);
        else if (frame.event === 'step') updateStep(frame.data);
        else if (frame.event === 'complete') onComplete(frame.data);
        else if (frame.event === 'failed') onFailed(frame.data);
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      renderOutcome({
        kind: 'waiting',
        title: 'Run cancelled',
        message: 'Whatever completed before you cancelled is kept; re-running resumes from there.',
      });
    } else {
      renderOutcome({ kind: 'failed', title: 'The stream broke', message: String(err?.message ?? err) });
    }
    liveIndicator.textContent = '';
  } finally {
    inFlight = null;
    runButton.disabled = false;
    cancelButton.hidden = true;
    await refreshRoles();
  }
}

function selectRole(role) {
  roleInput.value = role;
  for (const chip of roleChoices.querySelectorAll('.role-chip')) {
    chip.setAttribute('aria-pressed', String(chip.dataset.role === role));
  }
}

/**
 * Load the broker's mapped roles joined with recorded runs.
 *
 * The unmapped-but-attempted roles are the ones worth surfacing: they are
 * precisely the runs that will fail at the wire step, and showing them next to
 * the mapped ones is the panel telling the operator why before they press Run.
 */
async function refreshRoles() {
  let catalog;
  try {
    const response = await fetch('/v1/standup/identity/roles', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    catalog = await response.json();
  } catch (err) {
    brokerState.dataset.ok = 'false';
    brokerState.textContent = `broker state unavailable: ${err.message}`;
    return;
  }

  const { broker, roles } = catalog;
  brokerState.dataset.ok = String(Boolean(broker.canWriteMappings));
  const summary = [
    `broker: ${broker.mode}`,
    `${roles.filter((entry) => entry.mapped).length} mapped role(s)`,
    broker.canWriteMappings
      ? `manifest: ${broker.rolesFile}`
      : 'no broker.rolesFile configured — an unmapped role will FAIL at the wire step '
        + '(ARF never falls back to an ambient identity)',
  ];
  brokerState.textContent = summary.join(' · ');

  roleChoices.replaceChildren();
  for (const entry of roles) {
    const chip = el('button', 'role-chip');
    chip.type = 'button';
    chip.dataset.role = entry.role;
    chip.setAttribute('aria-pressed', String(roleInput.value === entry.role));
    chip.append(el('span', null, entry.role));
    if (!entry.mapped) chip.append(el('span', 'unmapped', ' · unmapped'));
    if (entry.run) chip.append(el('span', 'dim', ` · ${entry.run.status}`));
    chip.addEventListener('click', () => selectRole(entry.role));
    roleChoices.append(chip);
  }
  if (roles.length === 0) {
    roleChoices.append(el('span', 'note', 'No roles are mapped and no standup has been recorded yet.'));
  }
}

/** Paint the ritual before anything runs, so the panel is never an empty box. */
async function loadStepCatalog() {
  try {
    const response = await fetch('/v1/standup/identity/steps', { headers: { accept: 'application/json' } });
    if (!response.ok) return;
    const catalog = await response.json();
    renderSteps(catalog.steps.map((step) => ({ ...step, status: 'pending', resumed: false })));
  } catch {
    // The step list is a preview; the run's own opening frame carries the
    // authoritative one, so failing to prefetch it costs nothing.
  }
}

form.addEventListener('submit', runStandup);
cancelButton.addEventListener('click', () => inFlight?.abort());

await loadStepCatalog();
await refreshRoles();
