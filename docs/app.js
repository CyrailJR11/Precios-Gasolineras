import { API_BASE, API_CCAA, CCAA, PROVINCIAS, FUEL_LABELS, transform, isValidResponse } from './transform.mjs';
import { comarcaDe } from './comarcas.mjs';

const $ =(s) => document.querySelector(s);
const FUEL_ORDER = ['g95', 'gA', 'g98', 'gP', 'g95p', 'e10', 'glp', 'hvo', 'gB', 'gnc', 'adb'];
const PAGE = 50;
const ZONA_IDS = ['#zonaBtn', '#prov', '#comarca', '#muni'];

const store = {
  get(k, d) { try { const v = localStorage.getItem('gg.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gg.' + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};

// Zona elegida: provincia ('08'), comarca y municipio; '' en cada nivel = todos
function initialZona() {
  const z = store.get('zona', null);
  const ok = (v) => typeof v === 'string';
  if (z && ok(z.pr) && ok(z.co) && ok(z.mu)) return { pr: z.pr, co: z.co, mu: z.mu };
  // Versiones anteriores: 'scope' ('' / '08' / '08|Badalona') y, antes aún (solo Girona), 'muni'
  let s = store.get('scope', null);
  if (!ok(s)) { const old = store.get('muni', null); s = ok(old) ? (old ? `17|${old}` : '17') : ''; }
  const mu = s.slice(3);
  return { pr: s.slice(0, 2), co: mu ? comarcaDe(mu) || SIN_COMARCA : '', mu };
}

// Comarca de cada municipio (se calcula una vez por nombre)
const SIN_COMARCA = 'Otros municipios';
const comarcas = new Map();
function comarcaOf(m) {
  let c = comarcas.get(m);
  if (c === undefined) { c = comarcaDe(m) || SIN_COMARCA; comarcas.set(m, c); }
  return c;
}

const state = {
  data: null,
  fuel: store.get('fuel', 'g95'),
  zona: initialZona(),
  near: false,
  pos: null,
  radius: store.get('radius', 10),
  sort: store.get('sort', 'price'),
  q: '',
  // La casilla «Incluir venta restringida» está oculta: siempre se incluyen (salen con la etiqueta «Restringida»)
  restricted: true,
  shown: PAGE,
};

const fmtPrice = (v) => v.toFixed(3).replace('.', ',');
const fmtKm = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 1 : 0).replace('.', ',')} km`);
// Todas las horas se muestran en hora de Girona (España), aunque el móvil esté en otra zona horaria
const TZ = 'Europe/Madrid';
const fmtDate = (d, opts) => d.toLocaleString('es-ES', { timeZone: TZ, ...opts });
const dayKey = (d) => d.toLocaleDateString('es-ES', { timeZone: TZ });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function haversine(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ---------- Carga ----------
// 1) Se muestra al instante la copia guardada por la tarea programada (data/latest.json, toda Cataluña).
// 2) En paralelo se piden los precios en directo al Ministerio y, si llegan, sustituyen a la copia.
//    Para no descargar toda Cataluña en el móvil sin necesidad, solo se pide la provincia elegida
//    (o toda la comunidad si la zona es «Toda Cataluña»).
const LIVE_TIMEOUT = 25000;      // una provincia
const LIVE_TIMEOUT_CCAA = 45000; // toda Cataluña: respuesta bastante más grande
const ALL_PROVS = Object.keys(PROVINCIAS);

// Copia guardada y precios en directo por provincia: { '17': { at: Date, estaciones: [...] } }
const src = { snap: null, live: {} };
const inFlight = new Map();

const scopeProv = () => state.zona.pr;

async function fetchSnapshot() {
  const res = await fetch('data/latest.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const d = await res.json();
  // Copias antiguas (solo Girona) no traen la provincia de cada gasolinera
  for (const s of d.estaciones) s.pr ||= d.provincia || '17';
  return d;
}

async function fetchLive(pr) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), pr ? LIVE_TIMEOUT : LIVE_TIMEOUT_CCAA);
  try {
    const res = await fetch(pr ? API_BASE + pr : API_CCAA + CCAA, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = await res.json();
    if (!isValidResponse(raw)) throw new Error('Respuesta sin estaciones');
    return transform(raw).filter((s) => s.pr in PROVINCIAS);
  } finally {
    clearTimeout(timer);
  }
}

// Estado de la última actualización, para la barra de origen
const meta = {
  snapshotAt: null, // hora de la copia guardada en GitHub
  liveError: false, // la última consulta en directo falló
};
const isLoading = () => inFlight.size > 0;

// De dónde salen los precios de la zona elegida: en directo si todas sus provincias lo están
function source() {
  const need = scopeProv() ? [scopeProv()] : ALL_PROVS;
  const lv = need.map((p) => src.live[p]);
  if (lv.every(Boolean)) return { live: true, at: new Date(Math.min(...lv.map((x) => x.at))) };
  if (src.snap) return { live: false, at: new Date(src.snap.actualizado) };
  const any = Object.values(src.live);
  return any.length ? { live: true, at: new Date(Math.min(...any.map((x) => x.at))) } : null;
}

function refreshLive() {
  const pr = scopeProv();
  const key = pr || CCAA;
  if (inFlight.has(key)) return inFlight.get(key);
  const p = fetchLive(pr)
    .then((list) => {
      const at = new Date();
      for (const prov of pr ? [pr] : ALL_PROVS) src.live[prov] = { at, estaciones: list.filter((s) => s.pr === prov) };
      meta.liveError = false;
      return true;
    })
    .catch(() => { meta.liveError = true; return false; })
    .finally(() => { inFlight.delete(key); update(); });
  inFlight.set(key, p);
  renderSource();
  return p;
}

// "22:28" si es de hoy; "16 nov, 22:28" si no
function fmtWhen(date) {
  const hhmm = fmtDate(date, { hour: '2-digit', minute: '2-digit' });
  return dayKey(date) === dayKey(new Date()) ? hhmm : fmtDate(date, { day: 'numeric', month: 'short' }) + ', ' + hhmm;
}

function fmtAgo(date) {
  const min = Math.round((Date.now() - date) / 60000);
  if (min < 1) return 'ahora mismo';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `hace ${h} h${min % 60 && h < 6 ? ' ' + (min % 60) + ' min' : ''}`;
  return `hace ${Math.floor(h / 24)} días`;
}

// Barra bajo el título: cuándo se actualizó por última vez y de dónde salen los precios
function renderSource() {
  const el = $('#source');
  const d = source();
  const loading = isLoading();
  let kind, main, sub;
  if (!d) {
    kind = loading ? 'loading' : 'error';
    main = loading ? 'Consultando precios al Ministerio…' : 'Sin datos';
    sub = loading ? '' : 'No se ha podido conectar · Toca para reintentar';
  } else {
    const at = d.at;
    kind = d.live ? 'live' : meta.liveError ? 'error' : 'saved';
    main = `Actualizado a las ${fmtWhen(at)} (${fmtAgo(at)})`;
    const origin = d.live ? 'En directo del Ministerio' : 'Copia de GitHub';
    let extra;
    if (loading) extra = 'Consultando al Ministerio…';
    else if (meta.liveError) extra = 'El Ministerio no responde, toca para reintentar';
    else if (d.live) extra = meta.snapshotAt ? `copia ${fmtWhen(meta.snapshotAt)}` : '';
    else extra = 'toca para ver en directo';
    sub = extra ? `${origin} · ${extra}` : origin;
  }
  el.dataset.kind = kind;
  // Icono de actualizar a la derecha: deja claro que la barra se puede tocar
  el.innerHTML = `<span class="src-dot" aria-hidden="true"></span><span class="src-text"><span class="src-main">${esc(main)}</span>${sub ? `<span class="src-sub">${esc(sub)}</span>` : ''}</span>`
    + '<svg class="src-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/></svg>';
  el.setAttribute('aria-busy', String(loading));
}

// Junta la copia guardada con lo que haya en directo (el directo manda en su provincia) y repinta
function update() {
  if (!src.snap && !Object.keys(src.live).length) { renderSource(); return; }
  const liveProvs = new Set(Object.keys(src.live));
  const d = state.data = {
    fuels: src.snap?.fuels || FUEL_LABELS,
    estaciones: [
      ...(src.snap ? src.snap.estaciones.filter((s) => !liveProvs.has(s.pr)) : []),
      ...Object.values(src.live).flatMap((x) => x.estaciones),
    ],
  };

  // Combustibles disponibles en Cataluña
  const present = FUEL_ORDER.filter((k) => d.estaciones.some((s) => s.p[k] != null));
  if (!present.includes(state.fuel)) state.fuel = present[0];
  renderChips($('#fuelChips'), present.map((k) => [k, d.fuels[k]]), state.fuel, (k) => {
    state.fuel = k; store.set('fuel', k); state.shown = PAGE; render();
  });

  renderZona();

  renderSource();
  render();
}

async function load() {
  const live = refreshLive();
  try {
    src.snap = await fetchSnapshot();
    meta.snapshotAt = new Date(src.snap.actualizado);
    update();
  } catch { /* sin copia guardada: se espera al directo */ }
  const ok = await live;
  if (!ok && !state.data) {
    $('#status').textContent = 'No se han podido cargar los datos. Revisa la conexión y vuelve a intentarlo.';
  }
  renderSource();
  // Refresca el "hace X min" cada minuto
  setInterval(renderSource, 60000);
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

// ---------- Zona: Provincia → Comarca → Municipio ----------
const optSigs = new WeakMap();
function fillSelect(sel, opts, value) {
  const sig = JSON.stringify(opts);
  if (optSigs.get(sel) !== sig) {
    optSigs.set(sel, sig);
    sel.replaceChildren(...opts.map(([v, t]) => new Option(t, v)));
  }
  sel.value = value;
}

const byName = (a, b) => a.localeCompare(b, 'es');

// Cada desplegable solo ofrece lo que hay dentro del nivel anterior
function renderZona() {
  const z = state.zona, est = state.data.estaciones;
  const provs = [...new Set(est.map((s) => s.pr))].filter((p) => p in PROVINCIAS)
    .sort((a, b) => byName(PROVINCIAS[a], PROVINCIAS[b]));
  if (z.pr && !provs.includes(z.pr)) z.pr = z.co = z.mu = '';
  const inPr = z.pr ? est.filter((s) => s.pr === z.pr) : est;
  const coms = [...new Set(inPr.map((s) => comarcaOf(s.m)))]
    .sort((a, b) => (a === SIN_COMARCA) - (b === SIN_COMARCA) || byName(a, b));
  if (z.co && !coms.includes(z.co)) z.co = z.mu = '';
  const inCo = z.co ? inPr.filter((s) => comarcaOf(s.m) === z.co) : inPr;
  const munis = [...new Set(inCo.map((s) => s.m))].sort(byName);
  if (z.mu && !munis.includes(z.mu)) z.mu = '';
  fillSelect($('#prov'), [['', 'Toda Cataluña'], ...provs.map((p) => [p, PROVINCIAS[p]])], z.pr);
  fillSelect($('#comarca'), [['', 'Todas'], ...coms.map((c) => [c, c])], z.co);
  fillSelect($('#muni'), [['', 'Todos'], ...munis.map((m) => [m, m])], z.mu);
  // Resumen en el botón: lo más concreto delante y el resto en pequeño
  const parts = [z.mu, z.co, z.pr && PROVINCIAS[z.pr]].filter(Boolean);
  $('#zonaMain').textContent = parts[0] || 'Toda Cataluña';
  $('#zonaSub').textContent = parts.slice(1).join(', ');
}

let zonaScrollY = 0;
function toggleZona(open = $('#zonaPanel').hidden) {
  $('#zonaPanel').hidden = !open;
  $('#zonaBtn').setAttribute('aria-expanded', String(open));
  zonaScrollY = window.scrollY;
}

// Al bajar por la lista los desplegables se recogen solos y la cabecera vuelve a ser compacta
window.addEventListener('scroll', () => {
  if (!$('#zonaPanel').hidden && Math.abs(window.scrollY - zonaScrollY) > 40) toggleZona(false);
}, { passive: true });

function setZona(change) {
  const z = state.zona;
  Object.assign(z, change);
  const est = state.data.estaciones;
  if ('mu' in change && z.mu) {
    // Al elegir un municipio se colocan también su provincia y su comarca
    const s = est.find((x) => x.m === z.mu);
    if (s) { z.pr = s.pr; z.co = comarcaOf(s.m); }
  } else if ('co' in change && z.co && !z.pr) {
    // Una comarca que está entera en una provincia fija también la provincia
    const provs = new Set(est.filter((x) => comarcaOf(x.m) === z.co).map((x) => x.pr));
    if (provs.size === 1) z.pr = [...provs][0];
  }
  store.set('zona', { ...z });
  // Elegido un municipio ya no hace falta ver los desplegables
  if (z.mu) toggleZona(false);
  state.shown = PAGE;
  renderZona();
  render();
  // Si la provincia nueva aún no tiene precios en directo, se piden
  if (!source()?.live) refreshLive(); else renderSource();
}

// ---------- Lista ----------
function filtered() {
  const { data, fuel, near, pos, radius, q, restricted } = state;
  const { pr, co, mu } = state.zona;
  const nq = norm(q);
  let rows = data.estaciones.filter((s) => s.p[fuel] != null && (restricted || !s.r));
  if (near && pos) {
    rows = rows.map((s) => ({ ...s, dist: s.lat != null ? haversine(pos, s) : Infinity }));
    if (radius > 0) rows = rows.filter((s) => s.dist <= radius);
  } else if (pr || co || mu) {
    rows = rows.filter((s) => (!pr || s.pr === pr) && (!co || comarcaOf(s.m) === co) && (!mu || s.m === mu));
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
    : (state.zona.mu || (state.zona.co && state.zona.co !== SIN_COMARCA ? `en la comarca ${state.zona.co}`
      : scopeProv() ? `en la provincia de ${PROVINCIAS[scopeProv()]}` : 'en Cataluña'));
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
      ? `<div class="delta ${dc < 0 ? 'below' : 'above'}">${dc < 0 ? '−' : '+'}${Math.abs(dc).toFixed(1).replace('.', ',')} cts. vs. media</div>` : '';
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
  for (const id of ZONA_IDS) $(id).disabled = state.near;
  if (state.near) toggleZona(false);
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
      for (const id of ZONA_IDS) $(id).disabled = false;
      render();
      $('#status').textContent = err.code === 1
        ? 'Permiso de ubicación denegado. Actívalo en los ajustes del navegador para usar «Cerca de mí».'
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
  // Sin coordenadas (alguna estación llega sin ubicar), se busca por la dirección
  const dest = s.lat != null ? `${s.lat},${s.lon}` : encodeURIComponent(`${s.d}, ${s.cp} ${s.l || s.m}`);
  $('#dMaps').href = `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
  const fuels = FUEL_ORDER.filter((k) => s.p[k] != null);
  $('#dPrices').innerHTML = fuels.map((k) =>
    `<div class="stat" data-k="${esc(k)}"><div class="k">${esc(state.data.fuels[k])}</div><div class="v">${fmtPrice(s.p[k])} €</div></div>`).join('');
  detail.fuel = fuels.includes(state.fuel) ? state.fuel : fuels[0];
  renderChips($('#dFuelChips'), fuels.map((k) => [k, state.data.fuels[k]]), detail.fuel, (k) => { detail.fuel = k; drawChart(); });
  $('#chart').innerHTML = '<div class="empty-chart">Cargando histórico…</div>';
  $('#detail').showModal();

  try {
    const [h, a] = await Promise.all([
      fetch(`data/h/${encodeURIComponent(id)}.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})),
      avgCache || fetch('data/avg.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})).then(normAvg),
    ]);
    if (detail.st !== s) return;
    avgCache = a;
    detail.hist = h;
  } catch {
    detail.hist = {};
  }
  drawChart();
}

// avg.json guarda una media por provincia: { '17': { g95: [...] } }. El formato antiguo (solo Girona) era { g95: [...] }.
function normAvg(a) {
  return Object.keys(a).some((k) => k in FUEL_LABELS) ? { 17: a } : a;
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
  const nowTs = Math.floor(Date.now() / 1000);
  const full = (detail.hist[k] || []).slice();
  // Si el precio en directo es más nuevo que el último guardado, se añade al final
  const cur = detail.st.p[k];
  if (cur != null && (!full.length || full[full.length - 1][1] !== cur)) {
    full.push([Math.max(nowTs - 60, full.length ? full[full.length - 1][0] + 1 : 0), cur]);
  }
  const firstTs = full.length ? full[0][0] : nowTs;
  const t1 = nowTs;
  // El eje abarca siempre el periodo elegido, aunque los datos empiecen más tarde
  const t0 = detail.days ? t1 - detail.days * 86400 : firstTs;

  // Tabla (cambios de precio del periodo elegido, más reciente primero; incluye el precio con el que empieza)
  let from = 0;
  while (from + 1 < full.length && full[from + 1][0] <= t0) from++;
  table.innerHTML = '<tr><th>Fecha</th><th>Precio</th></tr>' + full.slice(from).reverse().map(([ts, v]) =>
    `<tr><td>${fmtDate(new Date(ts * 1000), { dateStyle: 'short', timeStyle: 'short' })}</td><td>${v == null ? 'No disponible' : fmtPrice(v) + ' €'}</td></tr>`).join('');

  const st = clip(full, t0, t1);
  const ref = clip((avgCache && avgCache[detail.st.pr] && avgCache[detail.st.pr][k]) || [], t0, t1);
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
  // Eje de tiempo: rayas verticales y etiquetas centradas en cada tramo, igual en todos los periodos.
  // 1 año: rayas y etiquetas por mes. 90 días: rayas por semana y etiquetas por mes.
  // 30 días: rayas y etiquetas por semana. 7 días: rayas por día y etiqueta «lun 17».
  const DAY = 86400;
  const ymd = (t) => fmtDate(new Date(t * 1000), { year: 'numeric', month: 'numeric', day: 'numeric' }).split('/').map(Number);
  // Medianoche de Madrid de un día dado (corrige el horario de verano)
  const midnight = (yy, mm, dd) => {
    let g = Date.UTC(yy, mm - 1, dd) / 1000 - 3600;
    if (+fmtDate(new Date(g * 1000), { hour: 'numeric', hourCycle: 'h23' }) !== 0) g -= 3600;
    return g;
  };
  const dayStart = (t) => { const [d, mo, yr] = ymd(t); return midnight(yr, mo, d); };
  const addDays = (t, n) => dayStart(t + n * DAY + 12 * 3600);
  const monthStarts = () => {
    const out = []; let [, mo, yr] = ymd(t0);
    for (let a = midnight(yr, mo, 1); a < t1;) {
      out.push(a);
      if (mo === 12) { mo = 1; yr++; } else mo++;
      a = midnight(yr, mo, 1);
    }
    return out;
  };
  const weekStarts = () => {
    // Semanas de lunes a domingo
    const wd = (new Date(t0 * 1000).toLocaleString('en-GB', { timeZone: TZ, weekday: 'short' }));
    const back = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd);
    const out = [];
    for (let a = addDays(dayStart(t0), -back); a < t1; a = addDays(a, 7)) out.push(a);
    return out;
  };
  const dayStarts = () => { const out = []; for (let a = dayStart(t0); a < t1; a = addDays(a, 1)) out.push(a); return out; };
  const rayas = (starts) => {
    for (const a of starts) if (a > t0) grid += `<line class="gridline" x1="${x(a)}" x2="${x(a)}" y1="${m.t}" y2="${H - m.b}"/>`;
  };
  // Cada tramo se rotula en su centro. El tramo en curso, si va por la mitad o menos, se alinea
  // al borde derecho para no pisar al anterior; un tramo muy corto no se rotula.
  const etiquetas = (starts, fullSecs, label) => {
    const fullW = (fullSecs / span) * iw;
    starts.forEach((a, i) => {
      const b = i + 1 < starts.length ? starts[i + 1] : a + fullSecs;
      const s0 = Math.max(a, t0), s1 = Math.min(b, t1);
      const w = x(s1) - x(s0), last = b >= t1;
      if (w < fullW * (last ? 0.4 : 0.5)) return;
      const atEnd = last && w < fullW * 0.75;
      grid += `<text class="axis-label month" x="${atEnd ? W - 1 : (x(s0) + x(s1)) / 2}" y="${H - 6}" text-anchor="${atEnd ? 'end' : 'middle'}">${label(a, fullW)}</text>`;
    });
  };
  const mes = (a, fullW) => {
    const l = fmtDate(new Date((a + 15 * DAY) * 1000), { month: 'short' }).replace('.', '').slice(0, 3);
    return fullW >= 19 ? l : l.charAt(0).toUpperCase();
  };
  if (span > 120 * DAY) {
    const ms = monthStarts(); rayas(ms); etiquetas(ms, 30.4 * DAY, mes);
  } else if (span > 45 * DAY) {
    rayas(weekStarts()); etiquetas(monthStarts(), 30.4 * DAY, mes);
  } else if (span > 10 * DAY) {
    const ws = weekStarts(); rayas(ws);
    etiquetas(ws, 7 * DAY, (a) => fmtDate(new Date(a * 1000), { day: 'numeric', month: 'short' }).replace('.', ''));
  } else {
    const ds = dayStarts(); rayas(ds);
    etiquetas(ds, DAY, (a, fullW) => {
      const wd = fmtDate(new Date((a + 12 * 3600) * 1000), { weekday: 'short' }).replace('.', '');
      const d = fmtDate(new Date((a + 12 * 3600) * 1000), { day: 'numeric' });
      // Si no cabe «lun 17», la inicial (X para el miércoles, como en los calendarios)
      return fullW >= 38 ? `${wd} ${d}` : `${wd === 'mié' ? 'X' : wd.charAt(0).toUpperCase()} ${d}`;
    });
  }

  const hasRef = ref.length > 0;
  const lastV = st[st.length - 1][1];
  box.innerHTML = `
    <div class="chart-head">${hasRef ? `<div class="legend"><span><i></i>Esta gasolinera</span><span><i class="ref"></i>Media provincia</span></div>` : ''}</div>
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
    // Globo en una sola línea, en la franja de encima del gráfico, para no tapar nunca las líneas
    tip.innerHTML = `${fmtDate(new Date(t * 1000), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
      · <b>${v == null ? '—' : fmtPrice(v) + ' €'}</b>${a != null ? ` · <span class="muted">Media ${fmtPrice(a)} €</span>` : ''}`;
    const sx = (x(t) / W) * r.width;
    const tw = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(r.width - tw, sx - tw / 2)) + 'px';
  };
  const leave = () => { cross.setAttribute('visibility', 'hidden'); hdot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', leave);
}

// ---------- Eventos ----------
$('#zonaBtn').addEventListener('click', () => toggleZona());
$('#prov').addEventListener('change', (e) => setZona({ pr: e.target.value, co: '', mu: '' }));
$('#comarca').addEventListener('change', (e) => setZona({ co: e.target.value, mu: '' }));
$('#muni').addEventListener('change', (e) => setZona({ mu: e.target.value }));
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
  // Al volver a la app tras más de 5 minutos, pide de nuevo los precios en directo
  const d = source();
  if (document.visibilityState === 'visible' && d && Date.now() - d.at > 5 * 60 * 1000) refreshLive();
});
$('#source').addEventListener('click', () => refreshLive());

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}

load();
