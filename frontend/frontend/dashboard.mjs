const root = document.getElementById('dashboard-root');

async function loadDashboard() {
  root.replaceChildren(message('Loading PRs...'));
  try {
    const res = await fetch('/v1/reviews/prs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderList(data);
  } catch (err) {
    root.replaceChildren(message(`Failed to load: ${err.message}`, 'error'));
  }
}

function renderList(data) {
  if (!data.store.available) {
    root.replaceChildren(message(`Store unavailable: ${data.store.reason}`, 'error'));
    return;
  }

  const prs = data.pullRequests || [];

  const header = document.createElement('div');
  header.className = 'dashboard-header';
  const heading = document.createElement('h3');
  heading.id = 'dashboard-heading';
  heading.textContent = `PRs (${prs.length} open)`;
  header.append(heading);

  const list = document.createElement('ul');
  list.className = 'pr-list';
  list.style.listStyle = 'none';
  list.style.padding = '0';

  if (prs.length === 0) {
    list.append(message('No PRs found.', undefined, 'li'));
  }

  prs.forEach(pr => {
    const mirror = pr.mirror;

    const row = document.createElement('li');
    row.className = 'pr-row';
    row.dataset.repo = String(pr.repo ?? '');
    row.dataset.pr = String(pr.pr ?? '');
    row.style.cursor = 'pointer';
    row.style.padding = '8px';
    row.style.borderBottom = '1px solid #ccc';

    const top = document.createElement('div');
    top.style.display = 'flex';
    top.style.justifyContent = 'space-between';

    const title = document.createElement('strong');
    title.append(document.createTextNode(`#${pr.pr ?? '?'} `));
    if (mirror) {
      title.append(document.createTextNode(mirror.title ?? ''));
    } else {
      const pending = document.createElement('span');
      pending.className = 'dim';
      pending.textContent = 'mirror pending';
      title.append(pending);
    }
    top.append(title);

    const reviewer = document.createElement('span');
    reviewer.textContent = pr.reviewer || '—';
    top.append(reviewer);

    const meta = document.createElement('div');
    meta.className = 'dim';
    meta.style.fontSize = '0.9em';
    const stateInfo = mirror ? `${mirror.mergeableState || ''}` : '';
    meta.textContent = `verdict: ${pr.latestVerdict || '—'} · blocking: ${pr.blockingCount ?? '?'} · round ${pr.latestRound ?? '?'} · ${stateInfo}`;

    const drillIn = document.createElement('div');
    drillIn.className = 'drill-in';
    drillIn.style.display = 'none';
    drillIn.style.marginTop = '10px';
    drillIn.style.borderTop = '1px dashed #eee';
    drillIn.style.paddingTop = '10px';

    row.append(top, meta, drillIn);
    row.addEventListener('click', async () => {
      if (drillIn.style.display === 'block') {
        drillIn.style.display = 'none';
        return;
      }

      drillIn.style.display = 'block';
      drillIn.replaceChildren(document.createTextNode('Loading detail...'));

      const repo = row.dataset.repo;
      const prNum = row.dataset.pr;

      try {
        const res = await fetch(`/v1/reviews/prs/${encodeURIComponent(repo)}/${prNum}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const detail = await res.json();
        drillIn.replaceChildren(renderDrillIn(detail));
      } catch (err) {
        drillIn.replaceChildren(message(`Failed to load detail: ${err.message}`, 'error', 'span'));
      }
    });

    list.append(row);
  });

  root.replaceChildren(header, list);
}

function renderDrillIn(detail) {
  const { pullRequest, rounds, findings } = detail;
  if (!pullRequest) return message('PR not found', undefined, 'em');

  const container = document.createElement('div');
  container.className = 'drill-in-content';
  container.style.fontSize = '0.9em';
  container.style.background = '#fafafa';
  container.style.padding = '10px';
  container.style.borderRadius = '4px';

  container.append(heading('Timeline'));
  const timeline = list([
    `Last Attempted: ${pullRequest.lastAttemptedAt || '—'}`,
    `Reviewed At: ${pullRequest.reviewedAt || '—'}`,
    `Merged At: ${pullRequest.mergedAt || '—'}`,
    `Closed At: ${pullRequest.closedAt || '—'}`,
  ]);
  container.append(timeline);

  container.append(heading('Rounds & Passes'));
  if (!rounds || rounds.length === 0) {
    container.append(message('No rounds yet.'));
  } else {
    rounds.forEach(r => {
      const round = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = `Round ${r.round}`;
      round.append(
        label,
        document.createTextNode(` - Verdict: ${r.verdict || 'pending'} (Blocking: ${r.blockingCount ?? '?'})`),
      );
      container.append(round);

      const passList = list([]);
      const passes = Array.isArray(r.passes) ? r.passes : [];
      passes.forEach((p) => {
        passList.append(message(
          `Pass [${p.passKind}] - Status: ${p.status} - Head: ${p.headShaShort || '?'} - Comment ID: ${p.ghCommentId || 'none'}`,
          undefined,
          'li',
        ));
      });
      container.append(passList);
    });
  }

  container.append(heading('Findings'));
  if (!findings || findings.length === 0) {
    container.append(message('No findings.'));
  } else {
    const findingList = list([]);
    findings.forEach(f => {
      const item = document.createElement('li');
      if (f.blocking) {
        const type = document.createElement('strong');
        type.textContent = '[BLOCKING]';
        item.append(type);
      } else {
        item.append(document.createTextNode('[Non-blocking]'));
      }
      item.append(document.createTextNode(` ${f.category || ''}: ${f.description || f.findingId || '—'}`));
      findingList.append(item);
    });
    container.append(findingList);
  }

  return container;
}

function heading(text) {
  const el = document.createElement('h4');
  el.textContent = text;
  return el;
}

function list(items) {
  const el = document.createElement('ul');
  el.style.margin = '4px 0 10px 20px';
  for (const item of items) {
    el.append(message(item, undefined, 'li'));
  }
  return el;
}

function message(text, className, tag = 'p') {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

// Hook into tab display
document.addEventListener('DOMContentLoaded', () => {
  const dashboardTab = document.querySelector('.screen-tab[data-target="dashboard-panel"]');
  if (dashboardTab) {
    dashboardTab.addEventListener('click', () => {
      loadDashboard();
    });
  }
  if (dashboardTab && dashboardTab.getAttribute('aria-current') === 'page') {
    loadDashboard();
  }
});
