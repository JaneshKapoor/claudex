/*
  Claudex dashboard client.

  No framework and no build step on purpose: this is the artifact that has to stay
  reachable through judging, so the fewer moving parts between the browser and the
  API, the better. It talks only to the Claudex API — never to a provider.
*/

const STORE_KEY = 'claudex.settings.v1';
const PROVIDER_ORDER = ['claude', 'chatgpt', 'codex'];

/** Threshold scale — identical to the Android widget's. Signal lives in the bar. */
function levelFor(pct) {
  if (pct == null) return 'neutral';
  if (pct >= 85) return 'alert';
  if (pct >= 60) return 'warn';
  return 'neutral';
}

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
  } catch {
    saved = {};
  }
  const url = new URL(location.href);
  // Deep links from the app / QR code carry the account straight in.
  const fromQuery = {
    apiUrl: url.searchParams.get('api') ?? undefined,
    accountId: url.searchParams.get('accountId') ?? undefined,
    pendingCode: url.searchParams.get('code') ?? undefined,
  };
  return {
    // Same-origin default: the API also serves this page, so a bare deploy just works.
    apiUrl: fromQuery.apiUrl ?? saved.apiUrl ?? location.origin,
    accountId: fromQuery.accountId ?? saved.accountId ?? '',
    deviceSecret: saved.deviceSecret ?? '',
    pendingCode: fromQuery.pendingCode ?? '',
  };
}

function saveSettings(s) {
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({ apiUrl: s.apiUrl, accountId: s.accountId, deviceSecret: s.deviceSecret }),
  );
}

let settings = loadSettings();

const el = {
  cards: document.getElementById('cards'),
  trends: document.getElementById('trends'),
  trendSection: document.getElementById('trend-section'),
  freshness: document.getElementById('freshness'),
  health: document.getElementById('health'),
  note: document.getElementById('settings-note'),
  panel: document.getElementById('settings'),
  apiUrl: document.getElementById('api-url'),
  accountId: document.getElementById('account-id'),
  pairCode: document.getElementById('pair-code'),
  exportCsv: document.getElementById('export-csv'),
};

function api(path) {
  return `${settings.apiUrl.replace(/\/$/, '')}${path}`;
}

/** "resets in 2h 14m" — relative, never a raw timestamp. */
function countdown(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return 'resetting now';
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rem = mins % 60;
  if (days > 0) return `resets in ${days}d ${hours}h`;
  if (hours > 0) return `resets in ${hours}h ${String(rem).padStart(2, '0')}m`;
  return `resets in ${rem}m`;
}

function relativeAge(iso) {
  if (!iso) return 'never refreshed';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'updated just now';
  if (mins < 60) return `updated ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `updated ${Math.floor(hours / 24)}d ago`;
}

function meter(label, pct, resetAt, state) {
  const known = typeof pct === 'number';
  const width = known ? Math.max(pct === 0 ? 0 : 2, Math.min(100, pct)) : 0;
  const reset = countdown(resetAt);
  return `
    <div class="meter">
      <div class="meter-head">
        <span class="meter-label">${label}</span>
        <span class="meter-value">${known ? `${Math.round(pct)}%` : state === 'loading' ? '—' : 'n/a'}</span>
      </div>
      <div class="track">
        <div class="fill" data-level="${levelFor(known ? pct : null)}" style="width:${width}%"></div>
      </div>
      ${reset ? `<div class="meter-reset">${reset}</div>` : ''}
    </div>`;
}

function card(row) {
  const isRepair = row.status === 'needs_repair';
  const isLoading = row.status === 'pending';
  const state = isRepair ? 'repair' : isLoading ? 'loading' : 'ok';
  const stateLabel = isRepair ? 'needs re-pair' : isLoading ? 'waiting…' : relativeAge(row.lastFetchedAt);

  return `
    <article class="card ${isLoading ? 'skeleton' : ''}">
      <div class="card-head">
        <h2 class="card-title">${row.displayName ?? row.provider}</h2>
        <span class="card-state">${stateLabel}</span>
      </div>
      <div class="meters">
        ${meter('Session', isRepair ? null : row.sessionPct, isRepair ? null : row.sessionResetAt, state)}
        ${meter('Weekly', isRepair ? null : row.weeklyPct, isRepair ? null : row.weeklyResetAt, state)}
      </div>
      ${row.message ? `<p class="repair">${row.message}</p>` : ''}
    </article>`;
}

function emptyState() {
  return `
    <div class="empty">
      <strong>No providers linked yet</strong>
      Pair Claude or ChatGPT in the Claudex Android app, then paste the account ID above —
      or enter the pairing code the app shows you.
    </div>`;
}

function sparkline(points, key, color) {
  const values = points.map((p) => p[key]).filter((v) => typeof v === 'number');
  if (values.length < 2) return '';
  const max = 100;
  const step = 100 / (values.length - 1);
  const d = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${(100 - (v / max) * 100).toFixed(2)}`)
    .join(' ');
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />`;
}

function renderTrends(series) {
  const entries = Object.entries(series).filter(([, points]) => points.length >= 2);
  if (entries.length === 0) {
    el.trendSection.hidden = true;
    return;
  }
  el.trendSection.hidden = false;
  const styles = getComputedStyle(document.documentElement);
  const neutral = styles.getPropertyValue('--neutral').trim();
  const alert = styles.getPropertyValue('--accent-alert').trim();

  entries.sort((a, b) => PROVIDER_ORDER.indexOf(a[0]) - PROVIDER_ORDER.indexOf(b[0]));
  el.trends.innerHTML = entries
    .map(
      ([provider, points]) => `
        <div class="trend-card">
          <h3>${provider}</h3>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="${provider} usage trend">
            ${sparkline(points, 'sessionPct', neutral)}
            ${sparkline(points, 'weeklyPct', alert)}
          </svg>
          <div class="trend-legend">
            <span><i class="legend-swatch" style="background:${neutral}"></i>Session</span>
            <span><i class="legend-swatch" style="background:${alert}"></i>Weekly</span>
          </div>
        </div>`,
    )
    .join('');
}

function renderCards(rows) {
  if (!rows || rows.length === 0) {
    el.cards.innerHTML = emptyState();
    el.trendSection.hidden = true;
    return;
  }
  const sorted = [...rows].sort(
    (a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider),
  );
  el.cards.innerHTML = sorted.map(card).join('');
  const newest = sorted
    .map((r) => r.lastFetchedAt)
    .filter(Boolean)
    .sort()
    .pop();
  el.freshness.textContent = newest ? relativeAge(newest) : '';
}

function renderLoading() {
  el.cards.innerHTML = PROVIDER_ORDER.map((p) =>
    card({ provider: p, displayName: p, status: 'pending', sessionPct: null, weeklyPct: null }),
  ).join('');
}

async function refresh() {
  if (!settings.accountId) {
    el.cards.innerHTML = emptyState();
    el.panel.hidden = false;
    return;
  }
  try {
    const res = await fetch(api(`/v1/usage?accountId=${encodeURIComponent(settings.accountId)}`));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      el.note.textContent = `Could not load usage: ${body.detail ?? res.status}`;
      el.panel.hidden = false;
      el.cards.innerHTML = emptyState();
      return;
    }
    el.note.textContent = '';
    renderCards(await res.json());
  } catch (err) {
    el.note.textContent = `Could not reach the API at ${settings.apiUrl} (${err.message})`;
    el.panel.hidden = false;
  }

  try {
    const res = await fetch(
      api(`/v1/usage/history?accountId=${encodeURIComponent(settings.accountId)}&hours=168`),
    );
    if (res.ok) renderTrends((await res.json()).series ?? {});
  } catch {
    /* the trend line is a nicety — never block the cards on it */
  }
}

async function checkHealth() {
  try {
    const res = await fetch(api('/v1/health'));
    const body = await res.json();
    const deps = body.dependencies ?? {};
    el.health.dataset.status = body.status === 'ok' ? 'ok' : 'down';
    el.health.textContent = `service ${body.status} · postgres ${deps.postgres} · redis ${deps.redis}`;
  } catch {
    el.health.dataset.status = 'down';
    el.health.textContent = 'service unreachable';
  }
}

function syncInputs() {
  el.apiUrl.value = settings.apiUrl;
  el.accountId.value = settings.accountId;
  if (settings.pendingCode) el.pairCode.value = settings.pendingCode;
  el.exportCsv.href = settings.accountId
    ? api(`/v1/usage/export.csv?accountId=${encodeURIComponent(settings.accountId)}`)
    : '#';
}

document.getElementById('settings-toggle').addEventListener('click', (e) => {
  el.panel.hidden = !el.panel.hidden;
  e.currentTarget.setAttribute('aria-expanded', String(!el.panel.hidden));
});

document.getElementById('save-settings').addEventListener('click', async () => {
  settings.apiUrl = el.apiUrl.value.trim() || location.origin;
  settings.accountId = el.accountId.value.trim();
  saveSettings(settings);
  syncInputs();
  el.note.textContent = 'Saved.';
  renderLoading();
  await Promise.all([refresh(), checkHealth()]);
});

document.getElementById('redeem-code').addEventListener('click', async () => {
  const code = el.pairCode.value.trim();
  if (!code) {
    el.note.textContent = 'Enter the pairing code shown in the app.';
    return;
  }
  settings.apiUrl = el.apiUrl.value.trim() || settings.apiUrl;
  try {
    const res = await fetch(api('/v1/pair/redeem'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, platform: 'web', label: 'dashboard' }),
    });
    const body = await res.json();
    if (!res.ok) {
      el.note.textContent = body.detail ?? 'That code did not work.';
      return;
    }
    settings.accountId = body.accountId;
    settings.deviceSecret = body.deviceSecret;
    saveSettings(settings);
    syncInputs();
    el.note.textContent = 'Paired. Loading your usage…';
    renderLoading();
    await refresh();
  } catch (err) {
    el.note.textContent = `Could not reach the API (${err.message})`;
  }
});

document.getElementById('refresh').addEventListener('click', async () => {
  renderLoading();
  // A device secret lets us force a live poll; otherwise just re-read the cache.
  if (settings.deviceSecret) {
    await fetch(api('/v1/refresh'), {
      method: 'POST',
      headers: { 'x-claudex-device': settings.deviceSecret },
    }).catch(() => undefined);
  }
  await refresh();
});

syncInputs();
renderLoading();
void refresh();
void checkHealth();

// Keep the countdowns honest without hammering the API.
setInterval(refresh, 60_000);
setInterval(checkHealth, 120_000);
