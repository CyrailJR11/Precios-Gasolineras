// Datos de prueba deterministas para las pruebas E2E: se interceptan las peticiones de la web
// (copia horaria, histórico, medias y API en directo del Ministerio).
import { readFileSync } from 'node:fs';
import { transform, FUEL_LABELS } from '../../docs/transform.mjs';

export const RAW = JSON.parse(readFileSync(new URL('../fixtures/ministerio-girona.json', import.meta.url), 'utf8'));
export const MINISTERIO = /sedeaplicaciones\.minetur\.gob\.es\/.*FiltroProvincia\/17/;

// Centro de Girona: a menos de 10 km solo hay 1001, 1002 y 1003 (la más cercana es 1002)
export const GIRONA = { latitude: 41.9794, longitude: 2.8214 };

const HOUR = 3600;

/** Copia horaria: igual que el directo pero 1 céntimo más cara, para distinguir una de otra. */
export function snapshot({ hoursAgo = 1, bump = 0.01 } = {}) {
  const estaciones = transform(RAW).map((s) => ({
    ...s,
    p: Object.fromEntries(Object.entries(s.p).map(([k, v]) => [k, Math.round((v + bump) * 1000) / 1000])),
  }));
  return {
    fuente: 'test',
    provincia: '17',
    fechaMinisterio: '2026-11-17T21:00:00',
    actualizado: new Date(Date.now() - hoursAgo * HOUR * 1000).toISOString(),
    fuels: FUEL_LABELS,
    estaciones,
  };
}

/** Histórico de 30 días con un cambio de precio cada 3 días, terminando en el precio actual. */
export function history(id) {
  const st = transform(RAW).find((s) => s.id === id);
  const now = Math.floor(Date.now() / 1000);
  const h = {};
  for (const [k, v] of Object.entries(st?.p || {})) {
    h[k] = [];
    for (let d = 30; d >= 3; d -= 3) h[k].push([now - d * 86400, Math.round((v + 0.002 * (d % 9)) * 1000) / 1000]);
    h[k].push([now - 2 * HOUR, v]);
  }
  return h;
}

export function averages() {
  const now = Math.floor(Date.now() / 1000);
  return {
    g95: [[now - 30 * 86400, 1.52], [now - 10 * 86400, 1.5], [now - HOUR, 1.48]],
    gA: [[now - 30 * 86400, 1.68], [now - HOUR, 1.65]],
  };
}

/**
 * Prepara las rutas simuladas.
 *  live: 'ok' | 'fail' | { delay: ms } | (route) => void
 *  snap: 'ok' | 'fail' | objeto latest.json
 */
export async function mockData(page, { live = 'ok', snap = 'ok', liveBody = RAW } = {}) {
  const json = (route, body) => route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  });

  await page.route('**/data/latest.json*', (route) =>
    snap === 'fail' ? route.fulfill({ status: 500, body: 'error' }) : json(route, snap === 'ok' ? snapshot() : snap));
  await page.route('**/data/avg.json*', (route) => json(route, averages()));
  await page.route('**/data/h/*.json*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').pop().replace('.json', '');
    return json(route, history(id));
  });
  await page.route(MINISTERIO, async (route) => {
    if (typeof live === 'function') return live(route);
    if (live === 'fail') return route.abort('failed');
    if (live && live.delay) await new Promise((r) => setTimeout(r, live.delay));
    return json(route, liveBody);
  });
}

/** Espera a que termine la consulta en directo (con éxito o sin él). */
export async function waitLiveSettled(page) {
  await page.waitForFunction(() => {
    const el = document.querySelector('#source');
    return el && el.getAttribute('aria-busy') === 'false' && el.dataset.kind && el.dataset.kind !== 'loading';
  });
}

/** Precios de las tarjetas visibles, en orden. */
export async function cardPrices(page) {
  return page.locator('.card .price .v').allTextContents();
}

export async function cardNames(page) {
  return (await page.locator('.card .name').allTextContents()).map((t) => t.replace(/\s+(Más barata|Restringida)/g, '').trim());
}
