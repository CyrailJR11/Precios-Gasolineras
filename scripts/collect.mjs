// Recolector de precios de carburantes de Cataluña (Barcelona, Girona, Lleida y Tarragona).
// Fuente oficial: Ministerio para la Transición Ecológica (Geoportal de Gasolineras).
// Sin dependencias: requiere Node 18+ (fetch nativo).
//
// Genera:
//   docs/data/latest.json      -> estado actual de todas las gasolineras
//   docs/data/h/<IDEESS>.json  -> histórico por gasolinera (solo puntos de cambio)
//   docs/data/avg.json         -> media de cada provincia por combustible: { "17": { "g95": [...] }, ... }

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_CCAA, CCAA, FUELS, FUEL_LABELS, transform, parseFechaMinisterio, isValidResponse } from '../docs/transform.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const AVG_KEEP_DAYS = 400;
export const AVG_MIN_STATIONS = 3;

export async function fetchWithRetry(url, { tries = 4, fetchImpl = fetch, delayMs = 5000, timeoutMs = 60_000, log = console } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'precios-carburantes-cataluna/1.0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!isValidResponse(json)) throw new Error('Respuesta sin estaciones');
      return json;
    } catch (e) {
      lastErr = e;
      log.warn(`Intento ${i + 1} fallido: ${e.message}`);
      if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * Añade al histórico de una gasolinera los precios que han cambiado.
 * Formato: { "g95": [[ts, precio], ...] }. Un combustible que deja de venderse se marca con null.
 * Modifica `h` y devuelve true si ha cambiado algo.
 */
export function updateHistory(h, prices, ts) {
  let dirty = false;
  for (const [k, v] of Object.entries(prices)) {
    const arr = (h[k] ||= []);
    const last = arr[arr.length - 1];
    if (!last || last[1] !== v) {
      arr.push([ts, v]);
      dirty = true;
    }
  }
  for (const k of Object.keys(h)) {
    const arr = h[k];
    if (!(k in prices) && arr.length && arr[arr.length - 1][1] !== null) {
      arr.push([ts, null]);
      dirty = true;
    }
  }
  return dirty;
}

/**
 * Añade la media provincial de cada combustible (solo venta al público y con al menos
 * AVG_MIN_STATIONS gasolineras). Borra los puntos de más de AVG_KEEP_DAYS días. Devuelve `avg`.
 */
export function updateAverages(avg, stations, ts) {
  const cutoff = ts - AVG_KEEP_DAYS * 86400;
  for (const k of Object.keys(FUELS)) {
    const vals = stations.filter((s) => !s.r && s.p[k] != null).map((s) => s.p[k]);
    if (avg[k]) avg[k] = avg[k].filter((x) => x[0] >= cutoff);
    if (vals.length < AVG_MIN_STATIONS) continue;
    const mean = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000;
    const arr = (avg[k] ||= []);
    const last = arr[arr.length - 1];
    if (!last || last[1] !== mean) arr.push([ts, mean]);
  }
  return avg;
}

/**
 * Medias por provincia: { "17": { g95: [...] }, "08": {...} }. Un avg.json antiguo (de cuando solo había
 * Girona, { g95: [...] }) se convierte a { "17": { g95: [...] } } para no perder su histórico.
 */
export function updateProvinceAverages(all, stations, ts) {
  const fuelKeys = new Set(Object.keys(FUELS));
  if (Object.keys(all).some((k) => fuelKeys.has(k))) all = { '17': all };
  const byProv = {};
  for (const s of stations) if (s.pr) (byProv[s.pr] ||= []).push(s);
  for (const [pr, list] of Object.entries(byProv)) all[pr] = updateAverages(all[pr] || {}, list, ts);
  // Provincias que hoy no vienen en la respuesta: solo se recortan los puntos viejos
  for (const pr of Object.keys(all)) if (!byProv[pr]) updateAverages(all[pr], [], ts);
  return all;
}

/** Ejecuta una recogida completa. Todo es inyectable para poder probarlo. */
export async function run({
  ccaa = CCAA,
  apiUrl = API_CCAA + ccaa,
  dataDir = join(ROOT, 'docs', 'data'),
  now = new Date(),
  fetchImpl = fetch,
  retry = {},
  log = console,
} = {}) {
  const raw = await fetchWithRetry(apiUrl, { fetchImpl, log, ...retry });
  const stations = transform(raw);
  const ts = Math.floor(now.getTime() / 1000);
  const histDir = join(dataDir, 'h');
  await mkdir(histDir, { recursive: true });

  let changed = 0;
  for (const s of stations) {
    if (!/^\d+$/.test(String(s.id))) continue; // el id se usa como nombre de fichero
    const path = join(histDir, `${s.id}.json`);
    const h = await readJson(path, {});
    if (updateHistory(h, s.p, ts)) {
      await writeFile(path, JSON.stringify(h));
      changed++;
    }
  }

  const avgPath = join(dataDir, 'avg.json');
  await writeFile(avgPath, JSON.stringify(updateProvinceAverages(await readJson(avgPath, {}), stations, ts)));

  const latest = {
    fuente: 'Ministerio para la Transición Ecológica — Geoportal de Gasolineras',
    ccaa,
    fechaMinisterio: parseFechaMinisterio(raw.Fecha),
    actualizado: now.toISOString(),
    fuels: FUEL_LABELS,
    estaciones: stations,
  };
  await writeFile(join(dataDir, 'latest.json'), JSON.stringify(latest));

  log.log(`OK: ${stations.length} estaciones, ${changed} con cambios de precio (${now.toISOString()})`);
  return { stations: stations.length, changed };
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  run().catch((e) => {
    console.error('ERROR:', e);
    process.exit(1);
  });
}
