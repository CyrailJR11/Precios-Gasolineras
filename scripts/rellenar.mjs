// Rellena hacia atrás el histórico de precios de toda Cataluña con el servicio histórico del
// Ministerio (un dato por día). Solo añade días anteriores al primer dato que ya tiene cada
// gasolinera o cada media, así que nunca toca lo que ha recogido la tarea de cada 30 minutos y
// se puede ejecutar varias veces sin duplicar nada.
//
// Lo lanza a mano el workflow "Rellenar histórico" (.github/workflows/rellenar-historico.yml):
//   node scripts/rellenar.mjs descargar --dias 365 --cache /tmp/hist.json   (lento: 1 petición por día)
//   node scripts/rellenar.mjs aplicar --cache /tmp/hist.json                (rápido: escribe docs/data)
// Se separa en dos pasos para poder repetir "aplicar" sobre la última versión de main si la tarea
// de precios ha subido algo mientras tanto.
//
// Sin dependencias: requiere Node 20+.

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CCAA, FUELS, PROVINCIAS, transform } from '../docs/transform.mjs';
import { fetchWithRetry, updateHistory, updateAverages } from './collect.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const API_HIST_CCAA =
  'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestresHist/FiltroCCAA/';
export const MAX_DIAS = 400; // lo mismo que se guardan las medias (AVG_KEEP_DAYS)

/** Fecha en el formato de la API histórica: dd-mm-aaaa. */
export function fechaApi(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
}

/** Instante con el que se guarda el dato de un día: las 12:00 en España (11:00 UTC). */
export function tsDia(d) {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 11) / 1000);
}

/** Quita puntos que repiten el valor anterior (el histórico solo guarda los cambios). */
export function compress(arr) {
  const out = [];
  for (const x of arr) if (!out.length || out[out.length - 1][1] !== x[1]) out.push(x);
  return out;
}

const firstTs = (obj) => {
  let t = Infinity;
  for (const a of Object.values(obj || {})) if (a && a.length) t = Math.min(t, a[0][0]);
  return t;
};

/**
 * Une los días descargados (ascendentes, [{ ts, p }]) con el histórico de una gasolinera.
 * Solo se usan los días anteriores a su primer dato. Devuelve el histórico nuevo, o null si no cambia.
 */
export function mergeStation(existing, days) {
  const T = firstTs(existing);
  const bf = {};
  for (const { ts, p } of days) if (ts < T) updateHistory(bf, p, ts);
  if (!Object.keys(bf).length) return null;
  const out = {};
  for (const k of new Set([...Object.keys(bf), ...Object.keys(existing || {})])) {
    const a = (bf[k] || []).slice();
    const cur = (existing && existing[k]) || [];
    // Si el día antes de empezar la recogida se vendía y al empezar no, se marca como retirado
    if (T !== Infinity && a.length && a[a.length - 1][1] !== null && !(cur.length && cur[0][0] === T)) a.push([T, null]);
    out[k] = compress([...a, ...cur]);
  }
  return out;
}

/** avg.json por provincia; el formato antiguo (solo Girona) se convierte. */
function normAvg(all) {
  const fuelKeys = new Set(Object.keys(FUELS));
  return Object.keys(all || {}).some((k) => fuelKeys.has(k)) ? { 17: all } : { ...(all || {}) };
}

/** Une las medias diarias de cada provincia con las existentes (solo días anteriores a su primer dato). */
export function mergeAverages(existingAll, days) {
  const all = normAvg(existingAll);
  for (const pr of Object.keys(PROVINCIAS)) {
    const cur = all[pr] || {};
    const T = firstTs(cur);
    const bf = {};
    for (const { ts, stations } of days) if (ts < T) updateAverages(bf, stations.filter((s) => s.pr === pr), ts);
    if (!Object.keys(bf).length) continue;
    const out = { ...cur };
    for (const k of Object.keys(bf)) out[k] = compress([...bf[k], ...(cur[k] || [])]);
    all[pr] = out;
  }
  return all;
}

/** Descarga los últimos `dias` días (sin hoy), del más antiguo al más reciente. Un día que falla se salta. */
export async function descargar({
  dias = 365,
  hoy = new Date(),
  urlFor = (fecha) => `${API_HIST_CCAA}${fecha}/${CCAA}`,
  fetchImpl = fetch,
  retry = {},
  pausaMs = 1000,
  log = console,
} = {}) {
  dias = Math.max(1, Math.min(MAX_DIAS, Math.floor(dias)));
  const out = [];
  const fallidos = [];
  for (let i = dias; i >= 1; i--) {
    const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() - i));
    const fecha = fechaApi(d);
    try {
      const raw = await fetchWithRetry(urlFor(fecha), { fetchImpl, log, timeoutMs: 120_000, ...retry });
      const stations = transform(raw)
        .filter((s) => s.pr in PROVINCIAS && /^\d+$/.test(String(s.id)))
        .map(({ id, pr, r, p }) => ({ id, pr, r, p }));
      out.push({ ts: tsDia(d), fecha, stations });
      log.log(`${fecha}: ${stations.length} gasolineras`);
    } catch (e) {
      fallidos.push(fecha);
      log.warn(`${fecha}: sin datos (${e.message})`);
    }
    if (pausaMs && i > 1) await new Promise((r) => setTimeout(r, pausaMs));
  }
  return { days: out, fallidos };
}

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; }
}

/** Aplica los días descargados a docs/data (histórico por gasolinera y medias). */
export async function aplicar({ days, dataDir = join(ROOT, 'docs', 'data'), log = console } = {}) {
  days = days.slice().sort((a, b) => a.ts - b.ts);
  const byId = new Map();
  for (const { ts, stations } of days) {
    for (const s of stations) {
      if (!byId.has(s.id)) byId.set(s.id, []);
      byId.get(s.id).push({ ts, p: s.p });
    }
  }
  const histDir = join(dataDir, 'h');
  let changed = 0;
  for (const [id, list] of byId) {
    if (!/^\d+$/.test(String(id))) continue; // el id se usa como nombre de fichero
    const path = join(histDir, `${id}.json`);
    const merged = mergeStation(await readJson(path, null), list);
    if (merged) { await writeFile(path, JSON.stringify(merged)); changed++; }
  }
  const avgPath = join(dataDir, 'avg.json');
  await writeFile(avgPath, JSON.stringify(mergeAverages(await readJson(avgPath, {}), days)));

  let bytes = 0;
  const files = await readdir(histDir);
  for (const f of files) bytes += (await stat(join(histDir, f))).size;
  const avgBytes = (await stat(avgPath)).size;
  log.log(`Histórico: ${changed} gasolineras ampliadas; h/ ocupa ${(bytes / 1e6).toFixed(1)} MB en ${files.length} ficheros; avg.json ${(avgBytes / 1e3).toFixed(0)} KB`);
  return { changed, files: files.length, bytes, avgBytes };
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const cmd = process.argv[2];
  const cache = arg('cache', '/tmp/historico.json');
  try {
    if (cmd === 'descargar') {
      const t0 = Date.now();
      const { days, fallidos } = await descargar({ dias: +arg('dias', 365) });
      await writeFile(cache, JSON.stringify(days));
      console.log(`Descargados ${days.length} días en ${Math.round((Date.now() - t0) / 1000)} s` +
        (fallidos.length ? `; sin datos: ${fallidos.join(', ')}` : ''));
      if (!days.length) throw new Error('El Ministerio no ha devuelto ningún día');
    } else if (cmd === 'aplicar') {
      await aplicar({ days: JSON.parse(await readFile(cache, 'utf8')) });
    } else {
      console.error('Uso: node scripts/rellenar.mjs descargar --dias 365 --cache F | aplicar --cache F');
      process.exit(2);
    }
  } catch (e) {
    console.error('ERROR:', e);
    process.exit(1);
  }
}
