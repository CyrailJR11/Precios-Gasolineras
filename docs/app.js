'use strict';

const $ = (s) => document.querySelector(s);
const FUEL_ORDER = ['g95', 'gA', 'g98', 'gP', 'g95p', 'e10', 'glp', 'hvo', 'gB', 'gnc', 'adb'];
const PAGE = 50;

const store = {
  get(k, d) { try { const v = localStorage.getItem('gg.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gg.' + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

const state = {
  data: null,
  fuel: store.get('fuel', 'g95'),
  muni: store.get('muni', ''),
  near: false,
  pos: null,
  radius: store.get('radius', 10),
  sort: store.get('sort', 'price'),
  q: '',
  restricted: store.get('restricted', false),
  shown: PAGE,
};

const fmtPrice = (v) => v.toFixed(3).replace('.', ',');
const fmtKm = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 1 : 0).replace('.', ',')} km`);
const fmtDate = (d, opts) => d.toLocaleString('es-ES', opts);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function haversine(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ---------- Carga ----------
async function load() {
  try {
    const res = await fetch('data/latest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.data = await res.json();
  } catch (e) {
    $('#status').textContent = 'No se han podido cargar los datos. Revisa la conexión y vuelve a intentarlo.';
    $('#updated').textContent = '';
    return;
  }
  const d = state.data;
  const upd = new Date(d.actualizado);
  $('#updated').textContent = 'Act. ' + fmtDate(upd, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  $('#updated').title = 'Última consulta al Ministerio: ' + fmtDate(upd, { dateStyle: 'full', timeStyle: 'short' });

  // Combustibles disponibles en la provincia
  const present = FUEL_ORDER.filter((k) => d.estaciones.some((s) => s.p[k] != null));
  if (!present.includes(state.fuel)) state.fuel = present[0];
  renderChips($('#fuelChips'), present.map((k) => [k, d.fuels[k]]), state.fuel, (k) => {
    state.fuel = k; store.set('fuel', k); state.shown = PAGE; render();
  });

  // Municipios
  const munis = [...new Set(d.estaciones.map((s) => s.m))].sort((a, b) => a.localeCompare(b, 'es'));
  const sel = $('#muni');
  for (const m of munis) sel.add(new Option(m, m));
  if (!munis.includes(state.muni)) state.muni = '';
  sel.value = state.muni;

  render();
}

function renderChips(container, items, current, onPick) {
  container.innerHTML = '';
  for (const [k, label] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(k === current));
    b.dataset.k = k;
    b.textContent = label;
    b.addEventListener('click', () => {
      container.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      onPick(k);
    });
    container.appendChild(b);
  }
}

// ---------- Lista ----------
function filtered() {
  const { data, fuel, muni, near, pos, radius, q, restricted } = state;
  const nq = norm(q);
  let rows = data.estaciones.filter((s) => s.p[fuel] != null && (restricted || !s.r));
  if (near && pos) {
    rows = rows.map((s) => ({ ...s, dist: s.lat != null ? haversine(pos, s) : Infinity }));
    if (radius > 0) rows = rows.filter((s) => s.dist <= radius);
  } else if (muni) {
    rows = rows.filter((s) => s.m === muni);
  }
  if (nq) rows = rows.filter((s) => norm(`${s.n} ${s.d} ${s.l} ${s.m}`).includes(nq));
  const byPrice = (a, b) => a.p[fuel] - b.p[fuel] || (a.dist ?? 0) - (b.dist ?? 0);
  rows.sort(near && pos && state.sort === 'dist' ? (a, b) => a.dist - b.dist || a.p[fuel] - b.p[fuel] : byPrice);
  return rows;
}

function render() {
  if (!state.data) return;
  const rows = filtered();
  const fuel = state.fuel;
  const prices = rows.map((s) => s.p[fuel]);
  const min = prices.length ? Math.min(...prices) : null;
  const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;

  const scope = state.near && state.pos
    ? (state.radius > 0 ? `a menos de ${state.radius} km` : 'por distancia')
    : (state.muni || 'en la provincia');
  $('#summary').innerHTML = prices.length ? `
    <div class="stat"><div class="k">Más barata</div><div class="v">${fmtPrice(min)} €</div></div>
    <div class="stat"><div class="k">Media</div><div class="v">${fmtPrice(avg)} €</div></div>
    <div class="stat"><div class="k">Gasolineras</div><div class="v">${rows.length}</div></div>` : '';
  $('#summary').setAttribute('aria-label', `${state.data.fuels[fuel]} ${scope}`);

  $('#status').textContent = rows.length ? '' : (state.near && !state.pos
    ? 'Obteniendo tu ubicación…'
    : 'No hay gasolineras con este combustible para el filtro elegido.');

  const list = $('#list');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  rows.slice(0, state.shown).forEach((s) => {
    const v = s.p[fuel];
    const dc = (v - avg) * 100; // céntimos
    const li = document.createElement('li');
    const deltaTxt = rows.length > 1 && Math.abs(dc) >= 0.05
      ? `<div class="delta ${dc < 0 ? 'below' : 'above'}">${dc < 0 ? '−' : '+'}${Math.abs(dc).toFixed(1).replace('.', ',')} cts vs media</div>` : '';
    const badges = [
      v === min && rows.length > 1 ? '<span class="badge">Más barata</span>' : '',
      s.r ? '<span class="badge neutral">Restringida</span>' : '',
    ].join('');
    li.innerHTML = `
      <button class="card" type="button" data-id="${esc(s.id)}">
        <span class="name">${esc(s.n)} ${badges}</span>
        <span class="price"><span class="v">${fmtPrice(v)}</span> <span class="u">€/L</span>${deltaTxt}</span>
        <span class="addr">${esc(s.d)}</span>
        <span class="meta">${esc(s.l || s.m)}${s.dist != null && isFinite(s.dist) ? ' · ' + fmtKm(s.dist) : ''}${s.h ? ' · ' + esc(s.h) : ''}</span>
      </button>`;
    frag.appendChild(li);
  });
  list.appendChild(frag);
  if (rows.length > state.shown) {
    const li = document.createElement('li');
    li.innerHTML = `<button class="btn more" type="button">Ver más (${rows.length - state.shown})</button>`;
    li.querySelector('button').addEventListener('click', () => { state.shown += PAGE; render(); });
    list.appendChild(li);
  }
}

// ---------- Cerca de mí ----------
function toggleNear() {
  state.near = !state.near;
  $('#nearBtn').setAttribute('aria-pressed', String(state.near));
  $('#nearControls').hidden = !state.near;
  $('#muni').disabled = state.near;
  state.shown = PAGE;
  if (state.near && !state.pos) locate();
  render();
}

function locate() {
  if (!('geolocation' in navigator)) {
    $('#status').textContent = 'Tu navegador no permite obtener la ubicación.';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (p) => { state.pos = { lat: p.coords.latitude, lon: p.coords.longitude }; render(); },
    (err) => {
      state.near = false;
      $('#nearBtn').setAttribute('aria-pressed', 'false');
      $('#nearControls').hidden = true;
      $('#muni').disabled = false;
      render();
      $('#status').textContent = err.code === 1
        ? 'Permiso de ubicación denegado. Actívalo en los ajustes del navegador para usar "Cerca de mí".'
        : 'No se ha podido obtener tu ubicación.';
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 },
  );
}

// ---------- Ficha y gráfico ----------
let avgCache = null;
const detail = { st: null, hist: null, fuel: null, days: 30 };

async function openDetail(id) {
  const s = state.data.estaciones.find((x) => x.id === id);
  if (!s) return;
  detail.st = s;
  detail.hist = null;
  $('#dTitle').textContent = s.n;
  $('#dAddr').textContent = `${s.d} · ${s.cp} ${s.l || s.m}`;
  $('#dHours').textContent = s.h ? 'Horario: ' + s.h + (s.r ? ' · Venta restringida' : '') : '';
  $('#dMaps').href = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}`;
  const fuels = FUEL_ORDER.filter((k) => s.p[k] != null);
  $('#dPrices').innerHTML = fuels.map((k) =>
    `<div class="stat"><div class="k">${esc(state.data.fuels[k])}</div><div class="v">${fmtPrice(s.p[k])} €</div></div>`).join('');
  detail.fuel = fuels.includes(state.fuel) ? state.fuel : fuels[0];
  renderChips($('#dFuelChips'), fuels.map((k) => [k, state.data.fuels[k]]), detail.fuel, (k) => { detail.fuel = k; drawChart(); });
  $('#chart').innerHTML = '<div class="empty-chart">Cargando histórico…</div>';
  $('#detail').showModal();

  try {
    const [h, a] = await Promise.all([
      fetch(`data/h/${encodeURIComponent(id)}.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})),
      avgCache || fetch('data/avg.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})),
    ]);
    if (detail.st !== s) return;
    avgCache = a;
    detail.hist = h;
  } catch {
    detail.hist = {};
  }
  drawChart();
}

// Valor de una serie escalonada en el instante t
function stepAt(series, t) {
  let v = null;
  for (const [ts, val] of series) { if (ts <= t) v = val; else break; }
  return v;
}

// Recorta una serie escalonada a [t0, t1] y la convierte en puntos de escalón
function clip(series, t0, t1) {
  if (!series || !series.length) return [];
  const pts = [];
  const start = stepAt(series, t0);
  if (start != null) pts.push([t0, start]);
  for (const [ts, v] of series) if (ts > t0 && ts <= t1) pts.push([ts, v]);
  if (pts.length) pts.push([t1, pts[pts.length - 1][1]]);
  return pts;
}

function niceStep(range) {
  const steps = [0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.5];
  return steps.find((s) => range / s <= 5) || 1;
}

function drawChart() {
  const box = $('#chart');
  const table = $('#dTable');
  if (!detail.hist) return;
  const k = detail.fuel;
  const full = detail.hist[k] || [];
  const nowTs = Math.floor(Date.now() / 1000);
  const firstTs = full.length ? full[0][0] : nowTs;
  const t1 = nowTs;
  const t0 = detail.days ? Math.max(firstTs, t1 - detail.days * 86400) : firstTs;

  // Tabla (cambios de precio, más reciente primero)
  table.innerHTML = '<tr><th>Fecha</th><th>Precio</th></tr>' + full.slice().reverse().map(([ts, v]) =>
    `<tr><td>${fmtDate(new Date(ts * 1000), { dateStyle: 'short', timeStyle: 'short' })}</td><td>${v == null ? 'No disponible' : fmtPrice(v) + ' €'}</td></tr>`).join('');

  const st = clip(full, t0, t1);
  const ref = clip((avgCache && avgCache[k]) || [], t0, t1);
  const since = fmtDate(new Date(firstTs * 1000), { day: 'numeric', month: 'long', year: 'numeric' });

  if (!st.length) { box.innerHTML = '<div class="empty-chart">Aún no hay histórico para este combustible.</div>'; return; }

  const W = Math.max(280, box.clientWidth || 320), H = 220;
  const m = { l: 44, r: 12, t: 10, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const vals = [...st, ...ref].map((p) => p[1]).filter((v) => v != null);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 0.02) { const c = (hi + lo) / 2; lo = c - 0.01; hi = c + 0.01; }
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const span = Math.max(1, t1 - t0);
  const x = (t) => m.l + ((t - t0) / span) * iw;
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ih;

  const path = (pts) => {
    let d = '', prev = null;
    for (const [t, v] of pts) {
      if (v == null) { prev = null; continue; }
      if (prev == null) d += `M${x(t).toFixed(1)},${y(v).toFixed(1)}`;
      else d += `H${x(t).toFixed(1)}V${y(v).toFixed(1)}`;
      prev = v;
    }
    return d;
  };

  let grid = '';
  for (let v = lo; v <= hi + 1e-9; v += step) {
    grid += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    grid += `<text class="axis-label" x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v.toFixed(step < 0.01 ? 3 : 2).replace('.', ',')}</text>`;
  }
  // Etiquetas de fecha (hasta 4)
  const nTicks = Math.min(4, Math.max(2, Math.floor(iw / 80)));
  const multiDay = span > 2 * 86400;
  for (let i = 0; i < nTicks; i++) {
    const t = t0 + (span * i) / (nTicks - 1);
    const lbl = fmtDate(new Date(t * 1000), multiDay ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' });
    const anchor = i === 0 ? 'start' : i === nTicks - 1 ? 'end' : 'middle';
    grid += `<text class="axis-label" x="${x(t)}" y="${H - 6}" text-anchor="${anchor}">${lbl}</text>`;
  }

  const hasRef = ref.length > 0;
  const lastV = st[st.length - 1][1];
  box.innerHTML = `
    ${hasRef ? `<div class="legend"><span><i></i>Esta gasolinera</span><span><i class="ref"></i>Media provincia</span></div>` : ''}
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución del precio de ${esc(state.data.fuels[k])}">
      ${grid}
      ${hasRef ? `<path class="line ref" d="${path(ref)}"/>` : ''}
      <path class="line" d="${path(st)}"/>
      ${lastV != null ? `<circle class="dot" cx="${x(t1)}" cy="${y(lastV)}" r="4"/>` : ''}
      <line class="cross" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>
      <circle class="dot hover" r="5" visibility="hidden"/>
      <rect x="${m.l}" y="0" width="${iw}" height="${H}" fill="transparent"/>
    </svg>
    <div class="tip" hidden></div>
    ${full.length <= 1 ? `<p class="small muted">El histórico se acumula desde el ${since}; el gráfico irá mostrando los cambios de precio.</p>` : ''}`;

  const svg = box.querySelector('svg');
  const cross = svg.querySelector('.cross');
  const hdot = svg.querySelector('.dot.hover');
  const tip = box.querySelector('.tip');
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const t = Math.min(t1, Math.max(t0, t0 + ((px - m.l) / iw) * span));
    const v = stepAt(st, t);
    const a = hasRef ? stepAt(ref, t) : null;
    cross.setAttribute('x1', x(t)); cross.setAttribute('x2', x(t)); cross.setAttribute('visibility', 'visible');
    if (v != null) { hdot.setAttribute('cx', x(t)); hdot.setAttribute('cy', y(v)); hdot.setAttribute('visibility', 'visible'); }
    tip.hidden = false;
    tip.innerHTML = `${fmtDate(new Date(t * 1000), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}<br>
      <b>${v == null ? '—' : fmtPrice(v) + ' €'}</b>${a != null ? `<br><span class="muted">Media: ${fmtPrice(a)} €</span>` : ''}`;
    const sx = (x(t) / W) * r.width;
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(r.width - tw, Math.max(0, sx - tw / 2)) + 'px';
    tip.style.top = (hasRef ? 22 : 0) + 'px';
  };
  const leave = () => { cross.setAttribute('visibility', 'hidden'); hdot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', leave);
}

// ---------- Eventos ----------
$('#muni').addEventListener('change', (e) => { state.muni = e.target.value; store.set('muni', state.muni); state.shown = PAGE; render(); });
$('#nearBtn').addEventListener('click', toggleNear);
$('#radius').value = String(state.radius);
$('#radius').addEventListener('change', (e) => { state.radius = +e.target.value; store.set('radius', state.radius); render(); });
$('#sort').value = state.sort;
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; store.set('sort', state.sort); render(); });
let qTimer;
$('#q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.q = e.target.value; state.shown = PAGE; render(); }, 150); });
$('#showRestricted').checked = state.restricted;
$('#showRestricted').addEventListener('change', (e) => { state.restricted = e.target.checked; store.set('restricted', state.restricted); render(); });
$('#list').addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c) openDetail(c.dataset.id); });
$('#dClose').addEventListener('click', () => $('#detail').close());
$('#detail').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('#dRange').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $('#dRange').querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  detail.days = +b.dataset.days; drawChart();
});
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if ($('#detail').open) drawChart(); }, 150); });
document.addEventListener('visibilitychange', () => {
  // Al volver a la app tras un rato, recarga los datos
  if (document.visibilityState === 'visible' && state.data && Date.now() - new Date(state.data.actualizado) > 65 * 60 * 1000) location.reload();
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

load();
