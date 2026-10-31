import {
  buildInbox, BUCKETS, BUCKET_ORDER, AGE_BINS, ageBin, humanAge, dailyActivity, itemAreas, DAY,
} from './logic.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// ---------- state ----------
const params = new URLSearchParams(location.search);
const saved = store.get('radar:prefs', {});
const csv = (s) => (s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const state = {
  user: (params.get('user') || saved.user || '').trim().toLowerCase(),
  areas: params.has('areas') ? csv(params.get('areas')) : saved.areas || [],
  teams: params.has('teams') ? csv(params.get('teams')) : saved.teams || [],
  bucket: 'reply',
  showDone: false,
  query: '',
  limit: 60,
};
let data = null;
let rows = [];

function savePrefs() {
  store.set('radar:prefs', { user: state.user, areas: state.areas, teams: state.teams });
  const q = new URLSearchParams();
  if (state.user) q.set('user', state.user);
  if (state.areas.length) q.set('areas', state.areas.join(','));
  if (state.teams.length) q.set('teams', state.teams.join(','));
  try { history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}`); } catch { /* sandboxed */ }
}

// "Done" = hidden until something new happens on the item.
const doneKey = () => `radar:done:${state.user}`;
const lastEventAt = (item) => item.ev.length ? item.ev[item.ev.length - 1][0] : item.updated;
function isDone(item) {
  const at = store.get(doneKey(), {})[item.n];
  return !!at && at >= lastEventAt(item);
}
function toggleDone(item) {
  const all = store.get(doneKey(), {});
  if (isDone(item)) delete all[item.n]; else all[item.n] = lastEventAt(item);
  // forget entries for items that are no longer open
  const open = new Set(data.items.map((i) => String(i.n)));
  for (const k of Object.keys(all)) if (!open.has(k)) delete all[k];
  store.set(doneKey(), all);
  render();
}

// ---------- theme ----------
$('#theme').onclick = () => {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const cur = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
  document.documentElement.dataset.theme = cur === 'dark' ? 'light' : 'dark';
  store.set('radar:theme', document.documentElement.dataset.theme);
  render();
};
{ const t = store.get('radar:theme', null); if (t) document.documentElement.dataset.theme = t; }
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

$('#share').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); $('#share').textContent = 'Copied ✓'; }
  catch { prompt('Your link:', location.href); }
  setTimeout(() => ($('#share').textContent = 'Copy my link'), 1500);
};

// ---------- settings ----------
const userInput = $('#user');
const teamsInput = $('#teams');
userInput.value = state.user;
teamsInput.value = state.teams.join(', ');
let typing;
userInput.oninput = () => { clearTimeout(typing); typing = setTimeout(() => { state.user = userInput.value.trim().replace(/^@/, '').toLowerCase(); savePrefs(); render(); }, 300); };
teamsInput.oninput = () => { clearTimeout(typing); typing = setTimeout(() => { state.teams = csv(teamsInput.value.replace(/@?[\w-]+\//g, '')); savePrefs(); render(); }, 300); };

function renderAreaChips() {
  const el = $('#areas');
  const all = state.areas.includes('all');
  const chips = [`<button class="chip all" data-a="all" aria-pressed="${all}">All areas</button>`]
    .concat(data.areas.map((a) => `<button class="chip" data-a="${esc(a)}" aria-pressed="${!all && state.areas.includes(a)}">${esc(a)}</button>`));
  el.innerHTML = chips.join('');
  el.onclick = (e) => {
    const a = e.target.closest('.chip')?.dataset.a;
    if (!a) return;
    if (a === 'all') state.areas = all ? [] : ['all'];
    else {
      const set = new Set(state.areas.filter((x) => x !== 'all'));
      set.has(a) ? set.delete(a) : set.add(a);
      state.areas = [...set];
    }
    savePrefs();
    render();
  };
}

// ---------- tooltip ----------
const tip = $('#tip');
tip.style.position = 'fixed';
function showTip(evt, title, lines) {
  tip.innerHTML = `<div class="t">${esc(title)}</div>` +
    lines.map(([color, label, v]) => `<div class="row"><i style="background:${color}"></i>${esc(label)}<b>${v}</b></div>`).join('');
  tip.style.display = 'block';
  const r = tip.getBoundingClientRect();
  let x = evt.clientX + 14, y = evt.clientY + 14;
  if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - 14;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
const hideTip = () => (tip.style.display = 'none');

// ---------- svg helpers ----------
const NS = 'http://www.w3.org/2000/svg';
// Bar with only its data-end rounded (4px). dir: 'up' | 'right'
function barPath(x, y, w, h, dir, round) {
  const r = round ? Math.min(4, w / 2, h / 2) : 0;
  if (w <= 0 || h <= 0) return '';
  if (dir === 'up') return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}
function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return v;
}
const legendHtml = (items) => `<div class="legend">${items.map(([c, l, line]) => `<span><i class="${line ? 'line' : ''}" style="background:${c}"></i>${esc(l)}</span>`).join('')}</div>`;

// Chart 1: open items waiting on you, by how long they have waited (stacked columns, 2 series).
function ageChart(el, rows, now) {
  const s1 = css('--s1'), s2 = css('--s2');
  const a = AGE_BINS.map(() => 0), b = AGE_BINS.map(() => 0);
  for (const r of rows) {
    if (r.done) continue;
    const i = ageBin(r.since, now);
    if (r.bucket === 'reply' || r.bucket === 'mine') a[i]++;
    else if (r.bucket === 'untouched' || r.bucket === 'activity') b[i]++;
  }
  const W = Math.max(260, el.clientWidth), H = 190, L = 28, R = 6, T = 14, B = 26;
  const max = niceMax(Math.max(1, ...a.map((v, i) => v + b[i])));
  const pw = W - L - R, ph = H - T - B, slot = pw / AGE_BINS.length, bw = Math.min(44, slot * 0.6);
  const y = (v) => T + ph - (v / max) * ph;
  let g = '';
  for (const t of [0, max / 2, max]) g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="${t ? css('--grid') : css('--axis')}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="${css('--muted')}">${t}</text>`;
  AGE_BINS.forEach((bin, i) => {
    const x = L + slot * i + (slot - bw) / 2;
    const ha = (a[i] / max) * ph, hb = (b[i] / max) * ph, gap = a[i] && b[i] ? 2 : 0;
    g += `<path d="${barPath(x, T + ph - ha, bw, ha, 'up', !b[i])}" fill="${s1}"/>`;
    g += `<path d="${barPath(x, T + ph - ha - hb - gap, bw, hb, 'up', true)}" fill="${s2}"/>`;
    if (a[i] + b[i]) g += `<text x="${x + bw / 2}" y="${y(a[i] + b[i]) - 5}" text-anchor="middle" font-size="11" fill="${css('--ink-2')}">${a[i] + b[i]}</text>`;
    g += `<text x="${L + slot * i + slot / 2}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${css('--muted')}">${bin.label}</text>`;
    g += `<rect class="hit" data-i="${i}" x="${L + slot * i}" y="${T}" width="${slot}" height="${ph}" fill="transparent"/>`;
  });
  el.innerHTML = legendHtml([[s1, 'Pings & your items'], [s2, 'Area items']]) + `<svg width="${W}" height="${H}" role="img" aria-label="Items waiting on you by age">${g}</svg>`;
  el.querySelectorAll('.hit').forEach((h) => {
    const i = +h.dataset.i;
    h.onmousemove = (e) => showTip(e, `Waiting ${AGE_BINS[i].long}`, [[s1, 'Pings & your items', a[i]], [s2, 'Area items', b[i]]]);
    h.onmouseleave = hideTip;
  });
}

// Chart 2: per-area breakdown (horizontal stacked bars, 3 series).
function areaChart(el, rows) {
  const series = [
    { key: 'you', label: 'Needs you', color: css('--s1'), buckets: ['reply', 'mine'] },
    { key: 'new', label: 'New / active', color: css('--s2'), buckets: ['untouched', 'activity'] },
    { key: 'wait', label: 'Waiting on others', color: css('--s3'), buckets: ['waiting'] },
  ];
  const by = new Map();
  for (const r of rows) {
    if (r.done) continue;
    const s = series.find((x) => x.buckets.includes(r.bucket));
    const areas = itemAreas(r.item);
    for (const a of areas.length ? areas : ['(no area)']) {
      if (!by.has(a)) by.set(a, { you: 0, new: 0, wait: 0 });
      by.get(a)[s.key]++;
    }
  }
  let list = [...by.entries()].map(([a, v]) => ({ a, ...v, total: v.you + v.new + v.wait }));
  list.sort((x, y) => y.you - x.you || y.total - x.total);
  const cap = 9;
  if (list.length > cap) {
    const rest = list.slice(cap - 1);
    list = list.slice(0, cap - 1).concat([{ a: `${rest.length} more areas`, you: sum(rest, 'you'), new: sum(rest, 'new'), wait: sum(rest, 'wait'), total: sum(rest, 'total') }]);
  }
  if (!list.length) { el.innerHTML = '<p class="sub">Nothing in your areas right now.</p>'; return; }
  const W = Math.max(260, el.clientWidth), rowH = 22, T = 4, L = Math.min(130, W * 0.36), R = 34;
  const H = T + list.length * rowH + 4;
  const max = Math.max(1, ...list.map((d) => d.total));
  const pw = W - L - R, bh = 14;
  let g = `<line x1="${L}" x2="${L}" y1="${T}" y2="${H - 4}" stroke="${css('--axis')}"/>`;
  list.forEach((d, i) => {
    const y = T + i * rowH + (rowH - bh) / 2;
    let x = L;
    const segs = series.filter((s) => d[s.key]);
    segs.forEach((s, j) => {
      const w = (d[s.key] / max) * pw - (j < segs.length - 1 ? 2 : 0);
      g += `<path d="${barPath(x, y, Math.max(w, 1), bh, 'right', j === segs.length - 1)}" fill="${s.color}"/>`;
      x += w + 2;
    });
    g += `<text x="${L - 8}" y="${y + bh - 3}" text-anchor="end" font-size="12" fill="${css('--ink-2')}">${esc(d.a)}</text>`;
    g += `<text x="${x + 4}" y="${y + bh - 3}" font-size="11" fill="${css('--ink-2')}">${d.total}</text>`;
    g += `<rect class="hit" data-i="${i}" x="0" y="${T + i * rowH}" width="${W}" height="${rowH}" fill="transparent"/>`;
  });
  el.innerHTML = legendHtml(series.map((s) => [s.color, s.label])) + `<svg width="${W}" height="${H}" role="img" aria-label="Open items per area">${g}</svg>`;
  el.querySelectorAll('.hit').forEach((h) => {
    const d = list[+h.dataset.i];
    h.onmousemove = (e) => showTip(e, d.a, series.map((s) => [s.color, s.label, d[s.key]]));
    h.onmouseleave = hideTip;
  });
}
const sum = (arr, k) => arr.reduce((n, d) => n + d[k], 0);

// Chart 3: activity per day — others vs you, last 30 days (two lines, one axis).
function activityChart(el, rows, now) {
  const s1 = css('--s1'), s2 = css('--s2');
  const { keys, others, mine } = dailyActivity(data, state, rows, 30, now);
  const W = Math.max(260, el.clientWidth), H = 190, L = 28, R = 10, T = 12, B = 26;
  const max = niceMax(Math.max(1, ...others, ...mine));
  const pw = W - L - R, ph = H - T - B;
  const x = (i) => L + (i / (keys.length - 1)) * pw;
  const y = (v) => T + ph - (v / max) * ph;
  let g = '';
  for (const t of [0, max / 2, max]) g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="${t ? css('--grid') : css('--axis')}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="${css('--muted')}">${t}</text>`;
  const fmt = (k) => new Date(`${k}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  for (const i of [0, 14, 29]) g += `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 29 ? 'end' : 'middle'}" font-size="11" fill="${css('--muted')}">${fmt(keys[i])}</text>`;
  const line = (vals, c) => `<polyline fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`;
  g += line(others, s2) + line(mine, s1);
  g += `<line class="xh" x1="0" x2="0" y1="${T}" y2="${T + ph}" stroke="${css('--axis')}" visibility="hidden"/>`;
  g += `<circle class="d1" r="4" fill="${s2}" stroke="${css('--surface')}" stroke-width="2" visibility="hidden"/><circle class="d2" r="4" fill="${s1}" stroke="${css('--surface')}" stroke-width="2" visibility="hidden"/>`;
  g += `<rect class="hit" x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent"/>`;
  el.innerHTML = legendHtml([[s2, 'Others', true], [s1, 'You', true]]) + `<svg width="${W}" height="${H}" role="img" aria-label="Daily activity in your scope">${g}</svg>`;
  const svg = el.querySelector('svg'), xh = svg.querySelector('.xh'), d1 = svg.querySelector('.d1'), d2 = svg.querySelector('.d2');
  const hit = svg.querySelector('.hit');
  hit.onmousemove = (e) => {
    const bx = svg.getBoundingClientRect().left;
    const i = Math.max(0, Math.min(keys.length - 1, Math.round(((e.clientX - bx - L) / pw) * (keys.length - 1))));
    xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
    d1.setAttribute('cx', x(i)); d1.setAttribute('cy', y(others[i])); d1.setAttribute('visibility', 'visible');
    d2.setAttribute('cx', x(i)); d2.setAttribute('cy', y(mine[i])); d2.setAttribute('visibility', 'visible');
    showTip(e, fmt(keys[i]), [[s2, 'Others', others[i]], [s1, 'You', mine[i]]]);
  };
  hit.onmouseleave = () => { hideTip(); [xh, d1, d2].forEach((n) => n.setAttribute('visibility', 'hidden')); };
}

// ---------- main render ----------
function render() {
  if (!data) return;
  renderAreaChips();
  const now = Date.now();
  const main = $('#main');

  if (!state.user) {
    main.innerHTML = `<div class="card empty-state"><h2>Who are you on GitHub?</h2><p>Type your login above and pick the areas you look after.<br>Your choice stays in this browser and in the page link, so you can bookmark it.</p></div>`;
    document.title = 'Backstage Radar';
    return;
  }

  rows = buildInbox(data, state).map((r) => ({ ...r, done: isDone(r.item) }));
  const active = rows.filter((r) => !r.done);
  const count = (b) => active.filter((r) => r.bucket === b).length;
  const fresh = (b) => active.filter((r) => r.bucket === b && now - Date.parse(r.since) < DAY).length;
  const replyN = count('reply');
  document.title = replyN ? `(${replyN}) Backstage Radar` : 'Backstage Radar';

  const tiles = BUCKET_ORDER.map((b) => {
    const n = count(b), f = fresh(b);
    return `<button class="tile ${b === 'reply' && n ? 'hot' : ''}" data-b="${b}" aria-pressed="${state.bucket === b}" title="${esc(BUCKETS[b].hint)}">
      <span class="k">${esc(BUCKETS[b].title)}</span><span class="v">${n}</span>
      <span class="d">${f ? `<b>${f}</b> in the last 24h` : '&nbsp;'}</span></button>`;
  }).join('');

  main.innerHTML = `
    <div class="tiles">${tiles}</div>
    <div class="charts">
      <section class="card chart"><h3>How long it has been waiting</h3><p class="sub">Open items where the next move is yours</p><div class="viz" id="c-age"></div></section>
      <section class="card chart"><h3>By area</h3><p class="sub">Everything in your scope, per area label</p><div class="viz" id="c-area"></div></section>
      <section class="card chart"><h3>Activity, last 30 days</h3><p class="sub">Comments, reviews and pushes on these items</p><div class="viz" id="c-act"></div></section>
    </div>
    <section class="card">
      <div class="list-head">
        <h2 id="list-title"></h2><span class="hint" id="list-hint"></span><span class="spacer"></span>
        <label class="toggle"><input type="checkbox" id="show-done" ${state.showDone ? 'checked' : ''}> show done</label>
        <input type="search" id="q" placeholder="Filter by title, #number, author" value="${esc(state.query)}">
      </div>
      <ul class="items" id="items"></ul>
    </section>`;

  main.querySelector('.tiles').onclick = (e) => {
    const b = e.target.closest('.tile')?.dataset.b;
    if (b) { state.bucket = b; state.limit = 60; render(); }
  };
  $('#show-done').onchange = (e) => { state.showDone = e.target.checked; renderList(now); };
  $('#q').oninput = (e) => { state.query = e.target.value; state.limit = 60; renderList(now); };

  ageChart($('#c-age'), rows, now);
  areaChart($('#c-area'), rows);
  activityChart($('#c-act'), rows, now);
  renderList(now);
}

function renderList(now) {
  const b = state.bucket;
  const q = state.query.trim().toLowerCase().replace(/^#/, '');
  let list = rows.filter((r) => r.bucket === b && (state.showDone || !r.done));
  if (q) list = list.filter((r) => r.item.title.toLowerCase().includes(q) || String(r.item.n).startsWith(q) || r.item.author.toLowerCase().includes(q));
  $('#list-title').textContent = `${BUCKETS[b].title} · ${list.length}`;
  $('#list-hint').textContent = BUCKETS[b].hint;
  const ul = $('#items');
  if (!list.length) {
    ul.innerHTML = `<li style="display:block;color:var(--ink-2);padding:20px 4px">${b === 'reply' ? 'Inbox zero. Nobody is waiting on you. 🎉' : 'Nothing here.'}</li>`;
    return;
  }
  ul.innerHTML = list.slice(0, state.limit).map((r) => {
    const it = r.item;
    const days = (now - Date.parse(r.since)) / DAY;
    const areas = itemAreas(it).map((a) => `<span class="tag">${esc(a)}</span>`).join('');
    return `<li class="${r.done ? 'done' : ''}">
      <span class="kind ${it.t}">${it.t === 'pr' ? 'PR' : 'Issue'}</span>
      <div class="title"><a href="${esc(it.url)}" target="_blank" rel="noopener"><span class="num">#${it.n}</span>${esc(it.title)}</a>
        <div class="why"><span class="badge b-${r.bucket}">${esc(r.reason)}</span>${it.draft ? '<span class="tag draft">draft</span>' : ''}${areas}<span>by @${esc(it.author)}</span></div></div>
      <span class="age ${days > 7 && (b === 'reply' || b === 'mine') ? 'old' : ''}" title="${esc(new Date(r.since).toLocaleString())}">${humanAge(r.since, now)}</span>
      <button class="done-btn" data-n="${it.n}" title="Hide until there is new activity">${r.done ? 'Undo' : 'Done'}</button>
    </li>`;
  }).join('') + (list.length > state.limit ? `<li class="more" style="display:block"><button id="more">Show ${list.length - state.limit} more</button></li>` : '');
  ul.onclick = (e) => {
    if (e.target.id === 'more') { state.limit += 100; renderList(now); return; }
    const n = e.target.closest('.done-btn')?.dataset.n;
    if (n) toggleDone(data.items.find((i) => String(i.n) === n));
  };
}

// ---------- data loading ----------
async function load() {
  try {
    const res = await fetch(`data.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    const ageMin = (Date.now() - Date.parse(data.generatedAt)) / 60000;
    const meta = $('#meta');
    meta.textContent = `${data.repo} · ${data.items.length} open items · updated ${humanAge(data.generatedAt, Date.now())} ago`;
    meta.classList.toggle('stale', ageMin > 180);
    $('#foot').innerHTML = `Data refreshes on a schedule from <a href="https://github.com/${esc(data.repo)}" target="_blank" rel="noopener">${esc(data.repo)}</a>. Reads the latest 40 comments and 20 reviews per item. Nothing you click here is sent anywhere; "Done" is stored in this browser. <a href="next.html${esc(location.search)}">Try the new layout →</a>`;
    render();
  } catch (err) {
    $('#meta').textContent = `Could not load data.json (${err.message})`;
  }
}
let resizeT;
addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(render, 150); });
load();
setInterval(load, 5 * 60 * 1000);
